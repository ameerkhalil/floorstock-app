const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const Stripe = require('stripe');
const rateLimit = require('express-rate-limit');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'floorstock.db');
const SESSION_COOKIE = 'floorstock_sid';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Digest email config (all optional — digest simply won't send without an API key)
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const DIGEST_FROM_EMAIL = process.env.DIGEST_FROM_EMAIL || 'onboarding@resend.dev';
const DIGEST_HOUR_UTC = Number.isFinite(Number(process.env.DIGEST_HOUR_UTC)) ? Number(process.env.DIGEST_HOUR_UTC) : 13; // ~8am US Eastern by default

// Billing config (all optional — billing/paywall simply won't activate without a Stripe key)
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PRICE_ID_MONTHLY = process.env.STRIPE_PRICE_ID_MONTHLY || process.env.STRIPE_PRICE_ID || '';
const STRIPE_PRICE_ID_ANNUAL = process.env.STRIPE_PRICE_ID_ANNUAL || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const TRIAL_DAYS = Number.isFinite(Number(process.env.TRIAL_DAYS)) ? Number(process.env.TRIAL_DAYS) : 14;
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

// UPC lookup config (free, optional — USDA's database is skipped if no key is set)
const USDA_FDC_API_KEY = process.env.USDA_FDC_API_KEY || '';

// Founder dashboard access (optional — the dashboard is simply never shown to
// anyone if this isn't set). Set this to your own manager account's email.
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();

// Make sure the database's directory exists (e.g. a Render disk mount path
// like /data) before trying to open it — otherwise better-sqlite3 throws and
// the whole server crashes on boot instead of starting.
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  try {
    fs.mkdirSync(dbDir, { recursive: true });
  } catch (e) {
    console.error(`\nCan't create or access "${dbDir}" for the database file.`);
    console.error(`If DB_PATH points at a mounted disk (e.g. /data), check in your`);
    console.error(`hosting dashboard that the disk is actually attached with that`);
    console.error(`exact mount path — this error means it currently isn't.`);
    console.error(`Underlying error: ${e.message}\n`);
    process.exit(1);
  }
}

const app = express();
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ---------- schema ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS stores (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    address TEXT NOT NULL,
    created_at TEXT NOT NULL,
    trial_ends_at TEXT,
    subscription_status TEXT NOT NULL DEFAULT 'trialing',
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    subscription_plan TEXT
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('manager','worker')),
    email TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (store_id) REFERENCES stores(id)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    store_id TEXT NOT NULL,
    role TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    upc TEXT NOT NULL,
    name TEXT NOT NULL,
    expiration_date TEXT NOT NULL,
    quantity REAL NOT NULL,
    unit TEXT NOT NULL,
    location TEXT NOT NULL,
    date_added TEXT NOT NULL,
    category_id TEXT,
    size_value REAL,
    size_unit TEXT,
    cost_price REAL,
    selling_price REAL
  );

  CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    actor_username TEXT NOT NULL,
    action TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS digest_log (
    store_id TEXT NOT NULL,
    sent_date TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (store_id, sent_date)
  );

  -- Shared across every store: once any store's scan successfully identifies a
  -- UPC, everyone benefits from that lookup forever, with no repeat external
  -- API calls. Stretches free/limited lookup quotas a lot in practice, since
  -- popular products (a Coke, a Red Bull...) get scanned by many stores.
  CREATE TABLE IF NOT EXISTS upc_cache (
    upc TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    brand TEXT,
    size_value REAL,
    size_unit TEXT,
    market_price_low REAL,
    market_price_high REAL,
    source TEXT,
    cached_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  -- One row per removed item, kept even after the item itself is deleted, so
  -- the shrink report can show historical totals.
  CREATE TABLE IF NOT EXISTS removals (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    item_name TEXT NOT NULL,
    category_id TEXT,
    quantity REAL NOT NULL,
    unit TEXT NOT NULL,
    cost_price REAL,
    selling_price REAL,
    expiration_date TEXT NOT NULL,
    reason TEXT NOT NULL,
    was_expired INTEGER NOT NULL,
    removed_by TEXT,
    removed_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS backup_log (
    store_id TEXT NOT NULL,
    sent_date TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (store_id, sent_date)
  );

  -- Partial "sold N units" events, separate from a full batch removal — this
  -- is what "quick sell" logs, and it's the beginning of real sell-through
  -- data (as opposed to only knowing when a whole batch finally runs out).
  CREATE TABLE IF NOT EXISTS sales (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    item_id TEXT,
    item_name TEXT NOT NULL,
    quantity REAL NOT NULL,
    unit TEXT NOT NULL,
    cost_price REAL,
    selling_price REAL,
    sold_by TEXT,
    sold_at TEXT NOT NULL
  );
`);

// ---------- migrations for older deployments ----------
const itemCols = db.prepare("PRAGMA table_info(items)").all().map(c => c.name);
if (!itemCols.includes('store_id')) db.exec("ALTER TABLE items ADD COLUMN store_id TEXT");
if (!itemCols.includes('category_id')) db.exec("ALTER TABLE items ADD COLUMN category_id TEXT");
if (!itemCols.includes('size_value')) db.exec("ALTER TABLE items ADD COLUMN size_value REAL");
if (!itemCols.includes('size_unit')) db.exec("ALTER TABLE items ADD COLUMN size_unit TEXT");
if (!itemCols.includes('cost_price')) db.exec("ALTER TABLE items ADD COLUMN cost_price REAL");
if (!itemCols.includes('selling_price')) db.exec("ALTER TABLE items ADD COLUMN selling_price REAL");

const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!userCols.includes('email')) db.exec("ALTER TABLE users ADD COLUMN email TEXT");

const storeCols = db.prepare("PRAGMA table_info(stores)").all().map(c => c.name);
if (!storeCols.includes('trial_ends_at')) db.exec("ALTER TABLE stores ADD COLUMN trial_ends_at TEXT");
if (!storeCols.includes('subscription_status')) db.exec("ALTER TABLE stores ADD COLUMN subscription_status TEXT NOT NULL DEFAULT 'active'");
if (!storeCols.includes('stripe_customer_id')) db.exec("ALTER TABLE stores ADD COLUMN stripe_customer_id TEXT");
if (!storeCols.includes('stripe_subscription_id')) db.exec("ALTER TABLE stores ADD COLUMN stripe_subscription_id TEXT");
if (!storeCols.includes('subscription_plan')) db.exec("ALTER TABLE stores ADD COLUMN subscription_plan TEXT");
if (!storeCols.includes('digest_frequency')) db.exec("ALTER TABLE stores ADD COLUMN digest_frequency TEXT NOT NULL DEFAULT 'daily'");

const digestLogCols = db.prepare("PRAGMA table_info(digest_log)").all().map(c => c.name);
if (!digestLogCols.includes('emailed')) db.exec("ALTER TABLE digest_log ADD COLUMN emailed INTEGER NOT NULL DEFAULT 1");
// Stores that already existed before billing was added shouldn't suddenly get locked out.
db.prepare("UPDATE stores SET subscription_status = 'active' WHERE subscription_status IS NULL OR subscription_status = ''").run();

// ---------- Stripe webhook (needs the RAW body for signature verification,
// so this is registered before express.json() touches the request) ----------
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(400).send('Webhook not configured');

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
  }

  try {
    handleStripeEvent(event);
  } catch (e) {
    console.error('Error handling Stripe webhook event:', e);
  }
  res.json({ received: true });
});

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- rate limiting (basic brute-force / abuse protection) ----------
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 15,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
});
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 8,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a while and try again.' },
});
const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 6,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a while and try again.' },
});

// ---------- helpers ----------
function nowIso() { return new Date().toISOString(); }
function newId() { return crypto.randomUUID(); }
function todayUtcDateStr() { return new Date().toISOString().slice(0, 10); }

function createSession(user) {
  const id = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare(`
    INSERT INTO sessions (id, user_id, store_id, role, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, user.id, user.store_id, user.role, nowIso(), expiresAt);
  return { id, expiresAt };
}

function destroySession(sessionId) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

function getSession(sessionId) {
  if (!sessionId) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    destroySession(sessionId);
    return null;
  }
  return row;
}

function authMiddleware(req, res, next) {
  const sid = req.cookies[SESSION_COOKIE];
  const session = getSession(sid);
  if (!session) {
    req.auth = null;
    return next();
  }
  req.auth = { userId: session.user_id, storeId: session.store_id, role: session.role };
  next();
}
app.use(authMiddleware);

function requireAuth(req, res, next) {
  if (!req.auth) return res.status(401).json({ error: 'Not signed in.' });
  next();
}
function requireManager(req, res, next) {
  if (!req.auth) return res.status(401).json({ error: 'Not signed in.' });
  if (req.auth.role !== 'manager') return res.status(403).json({ error: 'Manager access required.' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.auth || req.auth.role !== 'manager') return res.status(403).json({ error: 'Not authorized.' });
  if (!ADMIN_EMAIL) return res.status(403).json({ error: 'Not authorized.' });
  const user = db.prepare('SELECT email FROM users WHERE id = ?').get(req.auth.userId);
  if (!user || !user.email || user.email.trim().toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: 'Not authorized.' });
  }
  next();
}

function setSessionCookie(res, sessionId, expiresAt) {
  res.cookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    expires: new Date(expiresAt),
    path: '/',
  });
}

function isStrongEnoughPassword(pw) {
  return typeof pw === 'string' && pw.length >= 6;
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function currentUsername(req) {
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(req.auth.userId);
  return user ? user.username : 'unknown';
}

function logAudit(storeId, actorUsername, action, summary) {
  try {
    db.prepare(`
      INSERT INTO audit_log (id, store_id, actor_username, action, summary, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(newId(), storeId, actorUsername, action, summary, nowIso());
  } catch (e) {
    // Audit logging should never break the primary request.
  }
}

// =====================================================================
// BILLING helpers
// =====================================================================

function billingSnapshot(store) {
  const now = Date.now();
  const trialEndsAt = store.trial_ends_at;
  const trialActive = store.subscription_status === 'trialing' && trialEndsAt && new Date(trialEndsAt).getTime() > now;
  const paidActive = store.subscription_status === 'active';
  const daysLeft = trialEndsAt ? Math.max(0, Math.ceil((new Date(trialEndsAt).getTime() - now) / 86400000)) : 0;
  return {
    status: store.subscription_status,
    trialEndsAt: trialEndsAt || null,
    trialDaysLeft: daysLeft,
    active: paidActive || trialActive,
    billingEnabled: !!stripe,
    plansAvailable: { monthly: !!STRIPE_PRICE_ID_MONTHLY, annual: !!STRIPE_PRICE_ID_ANNUAL },
    plan: store.subscription_plan || null,
  };
}

function requireActiveSubscription(req, res, next) {
  if (!stripe) return next(); // billing not configured on this deployment — never block
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(req.auth.storeId);
  if (!store) return res.status(401).json({ error: 'Not signed in.' });
  const snap = billingSnapshot(store);
  if (!snap.active) {
    return res.status(402).json({ error: 'Your free trial has ended. Ask your manager to subscribe to keep using FloorStock.', billing: snap });
  }
  next();
}

// =====================================================================
// AUTH
// =====================================================================

// Register a new store + its manager account
app.post('/api/auth/register-store', registerLimiter, (req, res) => {
  const { storeName, storeAddress, username, password, email } = req.body || {};
  if (!storeName || !String(storeName).trim()) return res.status(400).json({ error: 'Store name is required.' });
  if (!storeAddress || !String(storeAddress).trim()) return res.status(400).json({ error: 'Store address is required.' });
  if (!username || !String(username).trim()) return res.status(400).json({ error: 'Username is required.' });
  if (!isStrongEnoughPassword(password)) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (!isValidEmail(email)) return res.status(400).json({ error: 'A valid email is required (used for expiration alerts).' });

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim().toLowerCase());
  if (existing) return res.status(409).json({ error: 'That username is already taken.' });

  const storeId = newId();
  const userId = newId();
  const passwordHash = bcrypt.hashSync(password, 10);
  const ts = nowIso();
  const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  db.prepare('INSERT INTO stores (id, name, address, created_at, trial_ends_at, subscription_status) VALUES (?, ?, ?, ?, ?, ?)')
    .run(storeId, storeName.trim(), storeAddress.trim(), ts, trialEndsAt, 'trialing');
  db.prepare(`
    INSERT INTO users (id, store_id, username, password_hash, role, email, created_at)
    VALUES (?, ?, ?, ?, 'manager', ?, ?)
  `).run(userId, storeId, username.trim().toLowerCase(), passwordHash, email.trim().toLowerCase(), ts);

  logAudit(storeId, username.trim().toLowerCase(), 'store_created', `Store "${storeName.trim()}" created`);

  const session = createSession({ id: userId, store_id: storeId, role: 'manager' });
  setSessionCookie(res, session.id, session.expiresAt);
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(storeId);
  res.status(201).json({
    role: 'manager', username: username.trim().toLowerCase(),
    store: { id: storeId, name: storeName.trim(), address: storeAddress.trim() },
    billing: billingSnapshot(store),
  });
});

// Log in (manager or worker)
app.post('/api/auth/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username).trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }

  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(user.store_id);
  const session = createSession(user);
  setSessionCookie(res, session.id, session.expiresAt);
  res.json({ role: user.role, username: user.username, store: { id: store.id, name: store.name, address: store.address }, billing: billingSnapshot(store) });
});

app.post('/api/auth/logout', (req, res) => {
  const sid = req.cookies[SESSION_COOKIE];
  if (sid) destroySession(sid);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.status(204).end();
});

app.get('/api/auth/me', (req, res) => {
  if (!req.auth) return res.json({ signedIn: false });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.auth.userId);
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(req.auth.storeId);
  if (!user || !store) return res.json({ signedIn: false });
  res.json({ signedIn: true, role: user.role, username: user.username, store: { id: store.id, name: store.name, address: store.address }, billing: billingSnapshot(store) });
});

// Managers reset their own password via an emailed link (workers ask their
// manager instead — see PUT /api/workers/:id/password).
app.post('/api/auth/forgot-password', forgotPasswordLimiter, async (req, res) => {
  const { email } = req.body || {};
  // Always respond the same way whether or not the email matches an account,
  // so this endpoint can't be used to discover which emails have accounts.
  const genericResponse = { sent: true, message: 'If that email is on a manager account, a reset link is on its way.' };
  if (!email || !isValidEmail(email)) return res.json(genericResponse);
  if (!RESEND_API_KEY) return res.status(400).json({ error: 'Password reset email isn\u2019t configured on the server yet.' });

  const user = db.prepare("SELECT * FROM users WHERE email = ? AND role = 'manager'").get(String(email).trim().toLowerCase());
  if (user) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
    db.prepare('INSERT INTO password_reset_tokens (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run(token, user.id, expiresAt, nowIso());
    const resetUrl = `${appBaseUrl(req)}/?resetToken=${token}`;
    await sendEmail({
      to: user.email,
      subject: 'Reset your FloorStock password',
      html: `
        <div style="font-family:Arial,sans-serif;color:#1C2530;max-width:480px;">
          <h2>Reset your password</h2>
          <p>Click the link below to set a new password for your FloorStock manager account. This link expires in 1 hour.</p>
          <p><a href="${resetUrl}" style="background:#2D5F8A;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block;">Reset password</a></p>
          <p style="color:#8A97A3;font-size:13px;">If you didn\u2019t request this, you can safely ignore this email.</p>
        </div>
      `,
    });
  }
  res.json(genericResponse);
});

app.post('/api/auth/reset-password', forgotPasswordLimiter, (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !isStrongEnoughPassword(password)) {
    return res.status(400).json({ error: 'A valid reset link and a password of at least 6 characters are required.' });
  }
  const row = db.prepare('SELECT * FROM password_reset_tokens WHERE token = ?').get(token);
  if (!row || new Date(row.expires_at).getTime() < Date.now()) {
    return res.status(400).json({ error: 'This reset link is invalid or has expired \u2014 request a new one.' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), row.user_id);
  db.prepare('DELETE FROM password_reset_tokens WHERE token = ?').run(token);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id); // sign out everywhere for safety
  res.json({ success: true });
});

// =====================================================================
// WORKER MANAGEMENT (manager only)
// =====================================================================

app.get('/api/workers', requireManager, (req, res) => {
  const rows = db.prepare("SELECT id, username, created_at FROM users WHERE store_id = ? AND role = 'worker' ORDER BY created_at ASC").all(req.auth.storeId);
  res.json(rows.map(r => ({ id: r.id, username: r.username, createdAt: r.created_at })));
});

app.post('/api/workers', requireManager, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !String(username).trim()) return res.status(400).json({ error: 'Username is required.' });
  if (!isStrongEnoughPassword(password)) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim().toLowerCase());
  if (existing) return res.status(409).json({ error: 'That username is already taken.' });

  const id = newId();
  const uname = username.trim().toLowerCase();
  db.prepare(`
    INSERT INTO users (id, store_id, username, password_hash, role, created_at)
    VALUES (?, ?, ?, ?, 'worker', ?)
  `).run(id, req.auth.storeId, uname, bcrypt.hashSync(password, 10), nowIso());

  logAudit(req.auth.storeId, currentUsername(req), 'worker_added', `Added worker login "${uname}"`);
  res.status(201).json({ id, username: uname });
});

app.put('/api/workers/:id/password', requireManager, (req, res) => {
  const { password } = req.body || {};
  if (!isStrongEnoughPassword(password)) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  const worker = db.prepare("SELECT * FROM users WHERE id = ? AND store_id = ? AND role = 'worker'").get(req.params.id, req.auth.storeId);
  if (!worker) return res.status(404).json({ error: 'Worker not found.' });

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), req.params.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.params.id); // sign them out everywhere

  logAudit(req.auth.storeId, currentUsername(req), 'worker_password_reset', `Reset password for "${worker.username}"`);
  res.status(204).end();
});

app.delete('/api/workers/:id', requireManager, (req, res) => {
  const worker = db.prepare("SELECT * FROM users WHERE id = ? AND store_id = ? AND role = 'worker'").get(req.params.id, req.auth.storeId);
  if (!worker) return res.status(404).json({ error: 'Worker not found.' });
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.params.id);
  logAudit(req.auth.storeId, currentUsername(req), 'worker_removed', `Removed worker login "${worker.username}"`);
  res.status(204).end();
});

// =====================================================================
// CATEGORIES (custom, per-store, colored labels for products)
// =====================================================================

function rowToCategory(row) {
  return { id: row.id, name: row.name, color: row.color, createdAt: row.created_at };
}

app.get('/api/categories', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM categories WHERE store_id = ? ORDER BY name ASC').all(req.auth.storeId);
  res.json(rows.map(rowToCategory));
});

app.post('/api/categories', requireManager, (req, res) => {
  const { name, color } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Category name is required.' });
  if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) return res.status(400).json({ error: 'A valid color is required.' });

  const id = newId();
  db.prepare('INSERT INTO categories (id, store_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, req.auth.storeId, name.trim(), color, nowIso());
  logAudit(req.auth.storeId, currentUsername(req), 'category_added', `Added category "${name.trim()}"`);
  res.status(201).json(rowToCategory(db.prepare('SELECT * FROM categories WHERE id = ?').get(id)));
});

app.put('/api/categories/:id', requireManager, (req, res) => {
  const existing = db.prepare('SELECT * FROM categories WHERE id = ? AND store_id = ?').get(req.params.id, req.auth.storeId);
  if (!existing) return res.status(404).json({ error: 'Category not found.' });

  const { name, color } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Category name is required.' });
  if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) return res.status(400).json({ error: 'A valid color is required.' });

  db.prepare('UPDATE categories SET name = ?, color = ? WHERE id = ?').run(name.trim(), color, req.params.id);
  res.json(rowToCategory(db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id)));
});

app.delete('/api/categories/:id', requireManager, (req, res) => {
  const existing = db.prepare('SELECT * FROM categories WHERE id = ? AND store_id = ?').get(req.params.id, req.auth.storeId);
  if (!existing) return res.status(404).json({ error: 'Category not found.' });

  db.prepare('UPDATE items SET category_id = NULL WHERE category_id = ? AND store_id = ?').run(req.params.id, req.auth.storeId);
  db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
  logAudit(req.auth.storeId, currentUsername(req), 'category_removed', `Removed category "${existing.name}"`);
  res.status(204).end();
});

// =====================================================================
// AUDIT LOG (manager only)
// =====================================================================

app.get('/api/audit', requireManager, (req, res) => {
  const rows = db.prepare('SELECT * FROM audit_log WHERE store_id = ? ORDER BY created_at DESC LIMIT 200').all(req.auth.storeId);
  res.json(rows.map(r => ({ id: r.id, actor: r.actor_username, action: r.action, summary: r.summary, createdAt: r.created_at })));
});

// =====================================================================
// BILLING (Stripe — flat monthly price per store, 14-day free trial)
// =====================================================================

app.get('/api/billing/status', requireAuth, (req, res) => {
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(req.auth.storeId);
  res.json(billingSnapshot(store));
});

function appBaseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

app.post('/api/billing/create-checkout-session', requireManager, async (req, res) => {
  const plan = req.body && req.body.plan === 'annual' ? 'annual' : 'monthly';
  const priceId = plan === 'annual' ? STRIPE_PRICE_ID_ANNUAL : STRIPE_PRICE_ID_MONTHLY;

  if (!stripe || !priceId) return res.status(400).json({ error: `The ${plan} plan isn\u2019t configured on the server yet.` });
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(req.auth.storeId);
  const manager = db.prepare('SELECT * FROM users WHERE id = ?').get(req.auth.userId);

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      customer: store.stripe_customer_id || undefined,
      customer_email: store.stripe_customer_id ? undefined : manager.email,
      client_reference_id: store.id,
      metadata: { storeId: store.id, plan },
      subscription_data: { metadata: { storeId: store.id, plan } },
      success_url: `${appBaseUrl(req)}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appBaseUrl(req)}/?checkout=cancelled`,
    });
    res.json({ url: session.url });
  } catch (e) {
    res.status(502).json({ error: `Couldn\u2019t start checkout: ${e.message}` });
  }
});

app.post('/api/billing/create-portal-session', requireManager, async (req, res) => {
  if (!stripe) return res.status(400).json({ error: 'Billing isn\u2019t configured on the server yet.' });
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(req.auth.storeId);
  if (!store.stripe_customer_id) return res.status(400).json({ error: 'No billing account on file yet \u2014 subscribe first.' });

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: store.stripe_customer_id,
      return_url: `${appBaseUrl(req)}/`,
    });
    res.json({ url: session.url });
  } catch (e) {
    res.status(502).json({ error: `Couldn\u2019t open billing portal: ${e.message}` });
  }
});

// Called right after a successful Stripe Checkout redirect, so the UI can
// unlock immediately instead of waiting on the webhook to arrive.
app.get('/api/billing/confirm-checkout', requireManager, async (req, res) => {
  if (!stripe) return res.status(400).json({ error: 'Billing isn\u2019t configured on the server yet.' });
  const sessionId = req.query.session_id;
  if (!sessionId) return res.status(400).json({ error: 'Missing session_id.' });

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['subscription'] });
    if (session.client_reference_id !== req.auth.storeId) {
      return res.status(403).json({ error: 'This checkout session doesn\u2019t belong to your store.' });
    }
    if (session.payment_status === 'paid' || (session.subscription && session.subscription.status === 'active')) {
      applySubscriptionToStore(req.auth.storeId, session.customer, session.subscription, session.metadata && session.metadata.plan);
    }
    const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(req.auth.storeId);
    res.json(billingSnapshot(store));
  } catch (e) {
    res.status(502).json({ error: `Couldn\u2019t confirm checkout: ${e.message}` });
  }
});

// =====================================================================
// FOUNDER DASHBOARD (you only — gated by ADMIN_EMAIL, not a store concept)
// =====================================================================

let priceAmountCache = null; // { monthly: dollars|null, annual: dollars|null }, fetched once and reused

async function getPriceAmounts() {
  if (priceAmountCache) return priceAmountCache;
  const result = { monthly: null, annual: null };
  if (!stripe) { priceAmountCache = result; return result; }
  try {
    if (STRIPE_PRICE_ID_MONTHLY) {
      const p = await stripe.prices.retrieve(STRIPE_PRICE_ID_MONTHLY);
      if (p.unit_amount != null) result.monthly = p.unit_amount / 100;
    }
    if (STRIPE_PRICE_ID_ANNUAL) {
      const p = await stripe.prices.retrieve(STRIPE_PRICE_ID_ANNUAL);
      if (p.unit_amount != null) result.annual = p.unit_amount / 100;
    }
  } catch (e) {
    // if Stripe can't be reached, MRR just comes back as an estimate of 0 — never breaks the dashboard
  }
  priceAmountCache = result;
  return result;
}

app.get('/api/admin/dashboard', requireAdmin, async (req, res) => {
  const stores = db.prepare('SELECT * FROM stores').all();
  const now = Date.now();

  const totalStores = stores.length;
  const trialing = stores.filter(s => s.subscription_status === 'trialing');
  const active = stores.filter(s => s.subscription_status === 'active');
  const canceled = stores.filter(s => s.subscription_status === 'canceled');
  const pastDue = stores.filter(s => s.subscription_status === 'past_due');
  const activeMonthly = active.filter(s => s.subscription_plan === 'monthly').length;
  const activeAnnual = active.filter(s => s.subscription_plan === 'annual').length;
  const activeUnknownPlan = active.length - activeMonthly - activeAnnual;

  const prices = await getPriceAmounts();
  const mrr = (activeMonthly * (prices.monthly || 0)) + (activeAnnual * ((prices.annual || 0) / 12));

  const trialEndingSoon = trialing
    .filter(s => s.trial_ends_at && (new Date(s.trial_ends_at).getTime() - now) <= 3 * 24 * 60 * 60 * 1000)
    .map(s => ({ id: s.id, name: s.name, trialEndsAt: s.trial_ends_at }))
    .sort((a, b) => new Date(a.trialEndsAt) - new Date(b.trialEndsAt));

  const recentSignups = [...stores]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 10)
    .map(s => ({ id: s.id, name: s.name, createdAt: s.created_at, status: s.subscription_status }));

  res.json({
    totalStores,
    trialingCount: trialing.length,
    activeCount: active.length,
    activeMonthly, activeAnnual, activeUnknownPlan,
    canceledCount: canceled.length,
    pastDueCount: pastDue.length,
    mrr: Math.round(mrr * 100) / 100,
    mrrEstimated: !(prices.monthly || prices.annual),
    trialEndingSoon,
    recentSignups,
  });
});

function applySubscriptionToStore(storeId, stripeCustomerId, subscription, plan) {
  const status = typeof subscription === 'string' ? 'active' : (subscription && subscription.status) || 'active';
  const subscriptionId = typeof subscription === 'string' ? subscription : subscription && subscription.id;
  const inferredPlan = plan || (subscription && subscription.metadata && subscription.metadata.plan) || null;
  db.prepare(`
    UPDATE stores SET stripe_customer_id = ?, stripe_subscription_id = ?, subscription_status = ?, subscription_plan = COALESCE(?, subscription_plan)
    WHERE id = ?
  `).run(stripeCustomerId || null, subscriptionId || null, status === 'active' || status === 'trialing' ? 'active' : status, inferredPlan, storeId);
}

function handleStripeEvent(event) {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const storeId = session.client_reference_id || (session.metadata && session.metadata.storeId);
      const plan = session.metadata && session.metadata.plan;
      if (storeId) applySubscriptionToStore(storeId, session.customer, session.subscription, plan);
      break;
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.created': {
      const sub = event.data.object;
      const storeId = sub.metadata && sub.metadata.storeId;
      const plan = sub.metadata && sub.metadata.plan;
      if (storeId) {
        db.prepare('UPDATE stores SET subscription_status = ?, stripe_subscription_id = ?, subscription_plan = COALESCE(?, subscription_plan) WHERE id = ?')
          .run(sub.status, sub.id, plan || null, storeId);
      }
      break;
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      const storeId = sub.metadata && sub.metadata.storeId;
      if (storeId) {
        db.prepare("UPDATE stores SET subscription_status = 'canceled' WHERE id = ?").run(storeId);
      }
      break;
    }
    default:
      break; // ignore anything we don't act on
  }
}

// =====================================================================
// UPC LOOKUP (free public database, proxied server-side to avoid CORS
// and keep this swappable later without touching the frontend)
// =====================================================================

// Parses strings like "500 ml", "1.5 L", "12 fl oz", "2 Gal" into a
// normalized { value, unit } pair, or null if nothing recognizable is found.
function parseSizeFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const match = text.match(/(\d+(?:\.\d+)?)\s*(fl\.?\s?oz|fluid ounces?|ounces?|oz|milliliters?|ml|liters?|litres?|l|gallons?|gal)\b/i);
  if (!match) return null;
  const value = parseFloat(match[1]);
  if (!Number.isFinite(value)) return null;
  const rawUnit = match[2].toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
  let unit = null;
  if (rawUnit.includes('oz') || rawUnit.includes('ounce')) unit = 'oz';
  else if (rawUnit.includes('ml') || rawUnit.includes('milliliter')) unit = 'mL';
  else if (rawUnit === 'l' || rawUnit.includes('liter') || rawUnit.includes('litre')) unit = 'L';
  else if (rawUnit.includes('gal')) unit = 'gal';
  if (!unit) return null;
  return { value, unit };
}

// A 12-digit UPC-A and its 13-digit EAN-13 form (leading zero) are the same
// product but different strings — try both so a format mismatch alone
// doesn't cause a false "not found."
function upcVariants(upc) {
  const variants = [upc];
  if (upc.length === 12) variants.push('0' + upc);
  if (upc.length === 13 && upc.startsWith('0')) variants.push(upc.slice(1));
  return variants;
}

function getCachedUpc(upc) {
  const row = db.prepare('SELECT * FROM upc_cache WHERE upc = ?').get(upc);
  if (!row) return null;
  return {
    found: true, name: row.name, brand: row.brand || null,
    sizeValue: row.size_value, sizeUnit: row.size_unit,
    marketPriceLow: row.market_price_low, marketPriceHigh: row.market_price_high,
  };
}

function cacheUpcResult(upc, result) {
  try {
    db.prepare(`
      INSERT INTO upc_cache (upc, name, brand, size_value, size_unit, market_price_low, market_price_high, source, cached_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(upc) DO UPDATE SET name=excluded.name, brand=excluded.brand, size_value=excluded.size_value,
        size_unit=excluded.size_unit, market_price_low=excluded.market_price_low, market_price_high=excluded.market_price_high,
        source=excluded.source, cached_at=excluded.cached_at
    `).run(
      upc, result.name, result.brand || null, result.sizeValue ?? null, result.sizeUnit || null,
      result.marketPriceLow ?? null, result.marketPriceHigh ?? null, result.source || null, nowIso()
    );
  } catch (e) {
    // caching is a nice-to-have — never let a cache write break the response
  }
}

// Free, no key: huge global food/beverage coverage.
async function lookupOpenFoodFacts(upc) {
  try {
    const res = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(upc)}.json`,
      { headers: { 'User-Agent': 'FloorStock-InventoryApp/1.0' } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status !== 1 || !data.product) return null;
    let name = (data.product.product_name || '').trim();
    const brand = (data.product.brands || '').split(',')[0].trim();
    if (brand && !name.toLowerCase().includes(brand.toLowerCase())) {
      name = name ? `${brand} ${name}` : brand;
    }
    if (!name) return null;
    let size = null;
    if (data.product.product_quantity && data.product.product_quantity_unit) {
      const unitRaw = String(data.product.product_quantity_unit).toLowerCase();
      const normalized = unitRaw === 'ml' ? 'mL' : unitRaw === 'l' ? 'L' : unitRaw.includes('oz') ? 'oz' : unitRaw.includes('gal') ? 'gal' : null;
      if (normalized) size = { value: parseFloat(data.product.product_quantity), unit: normalized };
    }
    if (!size) size = parseSizeFromText(data.product.quantity);
    return { name, brand: brand || null, sizeValue: size ? size.value : null, sizeUnit: size ? size.unit : null, source: 'openfoodfacts' };
  } catch (e) {
    return null;
  }
}

// Free with a no-cost sign-up key: US government database, strong on branded
// US packaged food/beverage products, including many regional/store brands.
async function lookupUsda(upc) {
  if (!USDA_FDC_API_KEY) return null;
  try {
    const url = `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${encodeURIComponent(USDA_FDC_API_KEY)}&query=${encodeURIComponent(upc)}&dataType=Branded&pageSize=5`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const normalizedUpc = upc.replace(/^0+/, '');
    const match = (data.foods || []).find(f => f.gtinUpc && String(f.gtinUpc).replace(/^0+/, '') === normalizedUpc);
    if (!match) return null;
    let name = (match.description || '').trim();
    const brand = (match.brandOwner || match.brandName || '').trim();
    if (brand && name && !name.toLowerCase().includes(brand.toLowerCase())) {
      name = `${brand} ${name}`;
    }
    if (!name) return null;
    const size = match.packageWeight ? parseSizeFromText(match.packageWeight) : null;
    return { name, brand: brand || null, sizeValue: size ? size.value : null, sizeUnit: size ? size.unit : null, source: 'usda' };
  } catch (e) {
    return null;
  }
}

// Free trial tier: shared 100 requests/day across the whole deployment, so
// this is deliberately tried last, after the unlimited free sources.
async function lookupUpcItemDb(upc) {
  try {
    const res = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(upc)}`);
    if (!res.ok) return null;
    const data = await res.json();
    const item = data.items && data.items[0];
    if (!item || !item.title) return null;
    const size = parseSizeFromText(item.size || item.title);
    const priceLow = Number(item.lowest_recorded_price);
    const priceHigh = Number(item.highest_recorded_price);
    const hasMarketPrice = Number.isFinite(priceLow) && priceLow > 0 && Number.isFinite(priceHigh) && priceHigh > 0;
    return {
      name: item.title, brand: item.brand || null,
      sizeValue: size ? size.value : null, sizeUnit: size ? size.unit : null,
      marketPriceLow: hasMarketPrice ? priceLow : null, marketPriceHigh: hasMarketPrice ? priceHigh : null,
      source: 'upcitemdb',
    };
  } catch (e) {
    return null;
  }
}

app.get('/api/upc-lookup/:upc', requireAuth, requireActiveSubscription, async (req, res) => {
  const upc = String(req.params.upc || '').trim();
  if (!upc) return res.status(400).json({ error: 'UPC is required.' });

  // Cache hit — instant, free, no external calls at all.
  const cached = getCachedUpc(upc);
  if (cached) return res.json(cached);

  const variants = upcVariants(upc);
  const sources = [lookupOpenFoodFacts, lookupUsda, lookupUpcItemDb];

  for (const source of sources) {
    for (const variant of variants) {
      const result = await source(variant);
      if (result) {
        cacheUpcResult(upc, result); // cache under the originally scanned code
        return res.json({ found: true, ...result });
      }
    }
  }

  res.json({ found: false });
});

// =====================================================================
// ITEMS (scoped to the signed-in user's store)
// =====================================================================

function rowToItem(row) {
  return {
    id: row.id,
    upc: row.upc,
    name: row.name,
    expirationDate: row.expiration_date,
    quantity: row.quantity,
    unit: row.unit,
    location: row.location,
    dateAdded: row.date_added,
    categoryId: row.category_id || null,
    sizeValue: row.size_value === null || row.size_value === undefined ? null : row.size_value,
    sizeUnit: row.size_unit || null,
    costPrice: row.cost_price === null || row.cost_price === undefined ? null : row.cost_price,
    sellingPrice: row.selling_price === null || row.selling_price === undefined ? null : row.selling_price,
  };
}

function validatePayload(body) {
  const { upc, name, expirationDate, quantity, unit, location, sizeValue, sizeUnit, costPrice, sellingPrice } = body || {};
  if (!upc || typeof upc !== 'string' || !upc.trim()) return 'UPC is required.';
  if (!name || typeof name !== 'string' || !name.trim()) return 'Product name is required.';
  if (!expirationDate || typeof expirationDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(expirationDate)) {
    return 'A valid expiration date (YYYY-MM-DD) is required.';
  }
  if (quantity === undefined || quantity === null || typeof quantity !== 'number' || isNaN(quantity) || quantity < 0) {
    return 'Quantity must be a non-negative number.';
  }
  if (!unit || typeof unit !== 'string' || !unit.trim()) return 'Unit is required.';
  if (!location || typeof location !== 'string' || !location.trim()) return 'Location is required.';
  if (sizeValue !== undefined && sizeValue !== null && sizeValue !== '' && (typeof sizeValue !== 'number' || isNaN(sizeValue) || sizeValue < 0)) {
    return 'Size must be a non-negative number.';
  }
  if (sizeUnit !== undefined && sizeUnit !== null && sizeUnit !== '' && typeof sizeUnit !== 'string') {
    return 'Invalid size unit.';
  }
  if (costPrice !== undefined && costPrice !== null && costPrice !== '' && (typeof costPrice !== 'number' || isNaN(costPrice) || costPrice < 0)) {
    return 'Cost price must be a non-negative number.';
  }
  if (sellingPrice !== undefined && sellingPrice !== null && sellingPrice !== '' && (typeof sellingPrice !== 'number' || isNaN(sellingPrice) || sellingPrice < 0)) {
    return 'Selling price must be a non-negative number.';
  }
  return null;
}

app.get('/api/items', requireAuth, requireActiveSubscription, (req, res) => {
  const rows = db.prepare('SELECT * FROM items WHERE store_id = ? ORDER BY expiration_date ASC').all(req.auth.storeId);
  res.json(rows.map(rowToItem));
});

// Find existing batches with the same UPC, so the frontend can offer
// "add to this batch" instead of always creating a new tag.
app.get('/api/items/by-upc/:upc', requireAuth, requireActiveSubscription, (req, res) => {
  const upc = String(req.params.upc || '').trim();
  if (!upc) return res.json([]);
  const rows = db.prepare('SELECT * FROM items WHERE store_id = ? AND upc = ? ORDER BY expiration_date ASC').all(req.auth.storeId, upc);
  res.json(rows.map(rowToItem));
});

// CSV export of the current store's inventory
function escapeCsvValue(val) {
  const s = String(val === null || val === undefined ? '' : val);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildInventoryCsv(storeId) {
  const rows = db.prepare('SELECT * FROM items WHERE store_id = ? ORDER BY expiration_date ASC').all(storeId);
  const categories = new Map(db.prepare('SELECT id, name FROM categories WHERE store_id = ?').all(storeId).map(c => [c.id, c.name]));
  const header = ['Product Name', 'UPC', 'Category', 'Size', 'Expiration Date', 'Quantity', 'Unit', 'Location', 'Cost Price', 'Selling Price', 'Margin %', 'Date Added'];
  const lines = [header.join(',')];
  for (const r of rows) {
    const categoryName = r.category_id ? (categories.get(r.category_id) || '') : '';
    const size = r.size_value ? `${r.size_value} ${r.size_unit || ''}`.trim() : '';
    const marginPct = (r.cost_price && r.selling_price && r.selling_price > 0)
      ? (((r.selling_price - r.cost_price) / r.selling_price) * 100).toFixed(1)
      : '';
    lines.push([
      escapeCsvValue(r.name), escapeCsvValue(r.upc), escapeCsvValue(categoryName), escapeCsvValue(size), escapeCsvValue(r.expiration_date),
      escapeCsvValue(r.quantity), escapeCsvValue(r.unit), escapeCsvValue(r.location),
      escapeCsvValue(r.cost_price || ''), escapeCsvValue(r.selling_price || ''), escapeCsvValue(marginPct),
      escapeCsvValue(r.date_added),
    ].join(','));
  }
  return lines.join('\r\n');
}

app.get('/api/items/export.csv', requireAuth, requireActiveSubscription, (req, res) => {
  const csv = buildInventoryCsv(req.auth.storeId);
  const store = db.prepare('SELECT name FROM stores WHERE id = ?').get(req.auth.storeId);
  const filenameSafe = (store ? store.name : 'floorstock').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filenameSafe}-inventory-${todayUtcDateStr()}.csv"`);
  res.send(csv);
});

// ---------- CSV import (bulk add for new stores with existing inventory) ----------

function parseCsvText(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* ignore, \n handles the line break */ }
      else field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(cell => cell.trim() !== ''));
}

function normalizeImportDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // M/D/YYYY or MM/DD/YYYY
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}

const IMPORT_HEADER_ALIASES = {
  name: ['productname', 'name', 'product', 'item', 'itemname'],
  upc: ['upc', 'barcode', 'upcbarcode', 'sku'],
  category: ['category'],
  expirationDate: ['expirationdate', 'expiration', 'expdate', 'expires'],
  quantity: ['quantity', 'qty'],
  unit: ['unit'],
  location: ['location', 'locationonfloor', 'shelf', 'aisle'],
  sizeValue: ['size', 'sizevalue'],
  sizeUnit: ['sizeunit'],
  costPrice: ['costprice', 'cost'],
  sellingPrice: ['sellingprice', 'price', 'sellprice', 'retailprice'],
};

function matchHeaderKey(headerCell) {
  const normalized = headerCell.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const [key, aliases] of Object.entries(IMPORT_HEADER_ALIASES)) {
    if (aliases.includes(normalized)) return key;
  }
  return null;
}

app.post('/api/items/import.csv', requireAuth, requireActiveSubscription, (req, res) => {
  const csvText = req.body && req.body.csv;
  if (!csvText || typeof csvText !== 'string') return res.status(400).json({ error: 'No CSV data received.' });

  const rows = parseCsvText(csvText);
  if (rows.length < 2) return res.status(400).json({ error: 'That file doesn\u2019t have any data rows.' });
  if (rows.length > 5001) return res.status(400).json({ error: 'That\u2019s more than 5,000 rows \u2014 split it into smaller files and import separately.' });

  const headerRow = rows[0];
  const columnMap = {}; // key -> column index
  headerRow.forEach((cell, i) => {
    const key = matchHeaderKey(cell);
    if (key && !(key in columnMap)) columnMap[key] = i;
  });

  const missing = ['name', 'upc', 'expirationDate', 'quantity', 'location'].filter(k => !(k in columnMap));
  if (missing.length) {
    return res.status(400).json({ error: `Missing required column(s): ${missing.join(', ')}. Check the CSV template for expected headers.` });
  }

  const categories = db.prepare('SELECT * FROM categories WHERE store_id = ?').all(req.auth.storeId);
  const categoryByName = new Map(categories.map(c => [c.name.trim().toLowerCase(), c]));
  const IMPORT_PALETTE = ['#2E6EFF', '#14C4B2', '#F5A623', '#C1443C', '#8A5CF6', '#3F8F5F'];
  let paletteIdx = 0;

  const insertItem = db.prepare(`
    INSERT INTO items (id, store_id, upc, name, expiration_date, quantity, unit, location, date_added, category_id, size_value, size_unit, cost_price, selling_price)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertCategory = db.prepare('INSERT INTO categories (id, store_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)');

  let imported = 0;
  const errors = [];
  const dateAdded = nowIso();

  const runImport = db.transaction(() => {
    for (let r = 1; r < rows.length; r++) {
      const cells = rows[r];
      const get = (key) => (key in columnMap ? (cells[columnMap[key]] || '').trim() : '');

      const name = get('name');
      const upc = get('upc');
      const expirationDate = normalizeImportDate(get('expirationDate'));
      const quantityRaw = get('quantity');
      const quantity = Number(quantityRaw);
      const location = get('location');

      if (!name || !upc || !expirationDate || !location || !Number.isFinite(quantity) || quantity < 0) {
        errors.push({ row: r + 1, message: 'Missing or invalid required field(s).' });
        continue;
      }

      let categoryId = null;
      const categoryName = get('category');
      if (categoryName) {
        const key = categoryName.toLowerCase();
        let cat = categoryByName.get(key);
        if (!cat) {
          const id = newId();
          const color = IMPORT_PALETTE[paletteIdx % IMPORT_PALETTE.length];
          paletteIdx++;
          insertCategory.run(id, req.auth.storeId, categoryName, color, nowIso());
          cat = { id, name: categoryName, color };
          categoryByName.set(key, cat);
        }
        categoryId = cat.id;
      }

      const sizeValueRaw = get('sizeValue');
      const sizeValue = sizeValueRaw ? Number(sizeValueRaw) : null;
      const costPriceRaw = get('costPrice');
      const costPrice = costPriceRaw ? Number(costPriceRaw.replace(/[$,]/g, '')) : null;
      const sellingPriceRaw = get('sellingPrice');
      const sellingPrice = sellingPriceRaw ? Number(sellingPriceRaw.replace(/[$,]/g, '')) : null;

      insertItem.run(
        newId(), req.auth.storeId, upc, name, expirationDate, quantity, get('unit') || 'each', location, dateAdded,
        categoryId, Number.isFinite(sizeValue) ? sizeValue : null, get('sizeUnit') || null,
        Number.isFinite(costPrice) ? costPrice : null, Number.isFinite(sellingPrice) ? sellingPrice : null
      );
      imported++;
    }
  });
  runImport();

  if (imported > 0) {
    logAudit(req.auth.storeId, currentUsername(req), 'bulk_import', `Imported ${imported} item${imported !== 1 ? 's' : ''} from CSV${errors.length ? ` (${errors.length} row${errors.length !== 1 ? 's' : ''} skipped)` : ''}`);
  }

  res.json({ imported, skipped: errors.length, errors: errors.slice(0, 20) });
});

app.post('/api/items', requireAuth, requireActiveSubscription, (req, res) => {
  const error = validatePayload(req.body);
  if (error) return res.status(400).json({ error });

  const { upc, name, expirationDate, quantity, unit, location, categoryId, sizeValue, sizeUnit, costPrice, sellingPrice } = req.body;
  const id = newId();
  const dateAdded = nowIso();

  db.prepare(`
    INSERT INTO items (id, store_id, upc, name, expiration_date, quantity, unit, location, date_added, category_id, size_value, size_unit, cost_price, selling_price)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, req.auth.storeId, upc.trim(), name.trim(), expirationDate, quantity, unit.trim(), location.trim(), dateAdded,
    categoryId || null, (sizeValue === '' || sizeValue === undefined) ? null : sizeValue, sizeUnit || null,
    (costPrice === '' || costPrice === undefined) ? null : costPrice, (sellingPrice === '' || sellingPrice === undefined) ? null : sellingPrice
  );

  logAudit(req.auth.storeId, currentUsername(req), 'item_added', `Added ${quantity} ${unit.trim()} of "${name.trim()}" at ${location.trim()}`);

  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  res.status(201).json(rowToItem(row));
});

// Add units to an existing batch (used by the "add to existing batch" flow)
app.post('/api/items/:id/add-quantity', requireAuth, requireActiveSubscription, (req, res) => {
  const existing = db.prepare('SELECT * FROM items WHERE id = ? AND store_id = ?').get(req.params.id, req.auth.storeId);
  if (!existing) return res.status(404).json({ error: 'Item not found.' });

  const addQty = Number(req.body && req.body.addQuantity);
  if (!Number.isFinite(addQty) || addQty <= 0) return res.status(400).json({ error: 'Enter a valid quantity to add.' });

  const newQty = existing.quantity + addQty;
  db.prepare('UPDATE items SET quantity = ? WHERE id = ?').run(newQty, req.params.id);

  logAudit(req.auth.storeId, currentUsername(req), 'item_restocked', `Added ${addQty} ${existing.unit} to existing "${existing.name}" batch at ${existing.location} (now ${newQty})`);

  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  res.json(rowToItem(row));
});

// "Quick sell" — log a real, timestamped partial sale without removing the
// whole batch. This is the actual sell-through signal the shrink report and
// any future reorder-suggestion feature would be built on.
app.post('/api/items/:id/sell', requireAuth, requireActiveSubscription, (req, res) => {
  const existing = db.prepare('SELECT * FROM items WHERE id = ? AND store_id = ?').get(req.params.id, req.auth.storeId);
  if (!existing) return res.status(404).json({ error: 'Item not found.' });

  const sellQty = Number(req.body && req.body.quantity);
  if (!Number.isFinite(sellQty) || sellQty <= 0) return res.status(400).json({ error: 'Enter a valid quantity sold.' });
  if (sellQty > existing.quantity) return res.status(400).json({ error: `Only ${existing.quantity} ${existing.unit} left \u2014 can\u2019t sell more than that.` });

  const newQty = existing.quantity - sellQty;
  db.prepare('UPDATE items SET quantity = ? WHERE id = ?').run(newQty, req.params.id);

  db.prepare(`
    INSERT INTO sales (id, store_id, item_id, item_name, quantity, unit, cost_price, selling_price, sold_by, sold_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    newId(), req.auth.storeId, existing.id, existing.name, sellQty, existing.unit,
    existing.cost_price, existing.selling_price, currentUsername(req), nowIso()
  );

  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  res.json({ item: rowToItem(row), sold: sellQty });
});

app.put('/api/items/:id', requireAuth, requireActiveSubscription, (req, res) => {
  const existing = db.prepare('SELECT * FROM items WHERE id = ? AND store_id = ?').get(req.params.id, req.auth.storeId);
  if (!existing) return res.status(404).json({ error: 'Item not found.' });

  const error = validatePayload(req.body);
  if (error) return res.status(400).json({ error });

  const { upc, name, expirationDate, quantity, unit, location, categoryId, sizeValue, sizeUnit, costPrice, sellingPrice } = req.body;
  db.prepare(`
    UPDATE items
    SET upc = ?, name = ?, expiration_date = ?, quantity = ?, unit = ?, location = ?, category_id = ?, size_value = ?, size_unit = ?, cost_price = ?, selling_price = ?
    WHERE id = ? AND store_id = ?
  `).run(
    upc.trim(), name.trim(), expirationDate, quantity, unit.trim(), location.trim(),
    categoryId || null, (sizeValue === '' || sizeValue === undefined) ? null : sizeValue, sizeUnit || null,
    (costPrice === '' || costPrice === undefined) ? null : costPrice, (sellingPrice === '' || sellingPrice === undefined) ? null : sellingPrice,
    req.params.id, req.auth.storeId
  );

  logAudit(req.auth.storeId, currentUsername(req), 'item_updated', `Updated "${name.trim()}" at ${location.trim()} (${quantity} ${unit.trim()})`);

  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  res.json(rowToItem(row));
});

app.delete('/api/items/:id', requireAuth, requireActiveSubscription, (req, res) => {
  const existing = db.prepare('SELECT * FROM items WHERE id = ? AND store_id = ?').get(req.params.id, req.auth.storeId);
  if (!existing) return res.status(404).json({ error: 'Item not found.' });

  const rawReason = (req.body && req.body.reason) || 'other';
  const reason = ['sold', 'expired', 'other'].includes(rawReason) ? rawReason : 'other';
  const wasExpired = urgencyOf(existing.expiration_date) === 'expired';

  db.prepare('DELETE FROM items WHERE id = ?').run(req.params.id);
  db.prepare(`
    INSERT INTO removals (id, store_id, item_name, category_id, quantity, unit, cost_price, selling_price, expiration_date, reason, was_expired, removed_by, removed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    newId(), req.auth.storeId, existing.name, existing.category_id, existing.quantity, existing.unit,
    existing.cost_price, existing.selling_price, existing.expiration_date, reason, wasExpired ? 1 : 0,
    currentUsername(req), nowIso()
  );

  logAudit(req.auth.storeId, currentUsername(req), 'item_removed', `Removed "${existing.name}" (${existing.quantity} ${existing.unit}) from ${existing.location} \u2014 ${reason}`);
  res.status(204).end();
});

// =====================================================================
// SHRINK REPORT (manager only) — what got saved vs. lost, from removal history
// =====================================================================

app.get('/api/reports/shrink', requireManager, (req, res) => {
  const days = Number(req.query.days) || 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const removalRows = db.prepare('SELECT * FROM removals WHERE store_id = ? AND removed_at >= ? ORDER BY removed_at DESC').all(req.auth.storeId, since);
  const saleRows = db.prepare('SELECT * FROM sales WHERE store_id = ? AND sold_at >= ? ORDER BY sold_at DESC').all(req.auth.storeId, since);

  let lostCost = 0, lostCount = 0;
  let savedRevenue = 0, savedCost = 0, savedCount = 0;

  for (const r of removalRows) {
    const qty = r.quantity || 0;
    if (r.reason === 'expired' || (r.reason === 'other' && r.was_expired)) {
      lostCost += (r.cost_price || 0) * qty;
      lostCount += 1;
    } else if (r.reason === 'sold') {
      savedRevenue += (r.selling_price || 0) * qty;
      savedCost += (r.cost_price || 0) * qty;
      savedCount += 1;
    }
  }
  for (const s of saleRows) {
    const qty = s.quantity || 0;
    savedRevenue += (s.selling_price || 0) * qty;
    savedCost += (s.cost_price || 0) * qty;
    savedCount += 1;
  }

  res.json({
    days,
    lostCost: Math.round(lostCost * 100) / 100,
    lostCount,
    savedRevenue: Math.round(savedRevenue * 100) / 100,
    savedCost: Math.round(savedCost * 100) / 100,
    savedCount,
    totalRemovals: removalRows.length + saleRows.length,
  });
});

// =====================================================================
// DAILY EXPIRATION DIGEST EMAIL
// =====================================================================

function daysUntil(dateStr) {
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const target = new Date(dateStr + 'T00:00:00Z');
  return Math.round((target - today) / 86400000);
}
function urgencyOf(dateStr) {
  const d = daysUntil(dateStr);
  if (d < 0) return 'expired';
  if (d <= 3) return 'critical';
  if (d <= 14) return 'soon';
  return 'ok';
}

function getAlertItemsForStore(storeId) {
  const rows = db.prepare('SELECT * FROM items WHERE store_id = ? ORDER BY expiration_date ASC').all(storeId);
  return rows.filter(r => ['expired', 'critical', 'soon'].includes(urgencyOf(r.expiration_date)));
}

function buildDigestHtml(store, alertItems) {
  const rowsHtml = alertItems.map(it => {
    const u = urgencyOf(it.expiration_date);
    const color = u === 'expired' ? '#C1443C' : u === 'critical' ? '#D9822B' : '#C9A227';
    const label = u === 'expired' ? 'EXPIRED' : u === 'critical' ? 'CRITICAL' : 'SOON';
    return `<tr>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;">${escapeHtml(it.name)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;">${escapeHtml(it.location)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;">${escapeHtml(it.expiration_date)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;color:${color};font-weight:600;">${label}</td>
    </tr>`;
  }).join('');
  return `
    <div style="font-family:Arial,sans-serif;color:#1C2530;max-width:600px;">
      <h2 style="margin-bottom:4px;">FloorStock — ${escapeHtml(store.name)}</h2>
      <p style="color:#666;margin-top:0;">${alertItems.length} tag${alertItems.length !== 1 ? 's' : ''} need attention today.</p>
      <table style="border-collapse:collapse;width:100%;font-size:14px;">
        <thead>
          <tr style="text-align:left;background:#F3F5F6;">
            <th style="padding:8px 10px;">Product</th>
            <th style="padding:8px 10px;">Location</th>
            <th style="padding:8px 10px;">Expires</th>
            <th style="padding:8px 10px;">Status</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `;
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Generic email sender via Resend — used for the digest, password resets, and backups.
async function sendEmail({ to, subject, html, attachments }) {
  if (!RESEND_API_KEY || !to) return { sent: false, reason: 'not configured' };
  try {
    const payload = { from: DIGEST_FROM_EMAIL, to: [to], subject, html };
    if (attachments && attachments.length) payload.attachments = attachments;
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { sent: false, reason: `email API error: ${response.status} ${body}` };
    }
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}

async function sendDigestEmail(store, toEmail, alertItems) {
  return sendEmail({
    to: toEmail,
    subject: `FloorStock: ${alertItems.length} item${alertItems.length !== 1 ? 's' : ''} need attention at ${store.name}`,
    html: buildDigestHtml(store, alertItems),
  });
}

// Manager can send a test digest immediately, regardless of schedule.
app.post('/api/digest/send-test', requireManager, async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.auth.userId);
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(req.auth.storeId);
  if (!user.email) return res.status(400).json({ error: 'No email on file for your manager account.' });
  if (!RESEND_API_KEY) return res.status(400).json({ error: 'Email sending isn\u2019t configured on the server yet (missing RESEND_API_KEY).' });

  const alertItems = getAlertItemsForStore(req.auth.storeId);
  const result = await sendDigestEmail(store, user.email, alertItems);
  if (!result.sent) return res.status(502).json({ error: `Couldn\u2019t send: ${result.reason}` });
  res.json({ sent: true, itemCount: alertItems.length, to: user.email });
});

const DIGEST_FREQUENCIES = ['daily', 'every_other_day', 'weekly', 'biweekly', 'monthly'];
const DIGEST_FREQUENCY_DAYS = { daily: 1, every_other_day: 2, weekly: 7, biweekly: 14, monthly: 30 };

app.get('/api/store/digest-frequency', requireManager, (req, res) => {
  const store = db.prepare('SELECT digest_frequency FROM stores WHERE id = ?').get(req.auth.storeId);
  res.json({ frequency: (store && store.digest_frequency) || 'daily' });
});

app.put('/api/store/digest-frequency', requireManager, (req, res) => {
  const { frequency } = req.body || {};
  if (!DIGEST_FREQUENCIES.includes(frequency)) return res.status(400).json({ error: 'Invalid frequency.' });
  db.prepare('UPDATE stores SET digest_frequency = ? WHERE id = ?').run(frequency, req.auth.storeId);
  res.json({ frequency });
});

function daysSinceLastDigest(storeId) {
  const row = db.prepare('SELECT MAX(sent_date) as d FROM digest_log WHERE store_id = ? AND emailed = 1').get(storeId);
  if (!row || !row.d) return Infinity;
  return (Date.now() - new Date(row.d + 'T00:00:00Z').getTime()) / 86400000;
}

// Background scheduler: checks hourly, but each store only ever gets emailed
// at most once per day, and no more often than its chosen frequency.
function runDigestCheckIfDue() {
  if (!RESEND_API_KEY) return;
  const nowUtc = new Date();
  if (nowUtc.getUTCHours() !== DIGEST_HOUR_UTC) return;

  const today = todayUtcDateStr();
  const stores = db.prepare('SELECT * FROM stores').all();
  for (const store of stores) {
    const already = db.prepare('SELECT 1 FROM digest_log WHERE store_id = ? AND sent_date = ?').get(store.id, today);
    if (already) continue;

    const requiredDays = DIGEST_FREQUENCY_DAYS[store.digest_frequency] || 1;
    if (daysSinceLastDigest(store.id) < requiredDays) {
      db.prepare('INSERT OR IGNORE INTO digest_log (store_id, sent_date, created_at, emailed) VALUES (?, ?, ?, 0)').run(store.id, today, nowIso());
      continue;
    }

    const manager = db.prepare("SELECT * FROM users WHERE store_id = ? AND role = 'manager' LIMIT 1").get(store.id);
    const alertItems = getAlertItemsForStore(store.id);
    const willSend = !!(manager && manager.email && alertItems.length > 0);
    db.prepare('INSERT OR IGNORE INTO digest_log (store_id, sent_date, created_at, emailed) VALUES (?, ?, ?, ?)').run(store.id, today, nowIso(), willSend ? 1 : 0);
    if (willSend) sendDigestEmail(store, manager.email, alertItems).catch(() => {});
  }
}
setInterval(runDigestCheckIfDue, 60 * 60 * 1000); // hourly check

// =====================================================================
// AUTOMATED WEEKLY BACKUP EMAIL (per store — a portable copy of your data,
// not a substitute for real infrastructure-level backups of the whole
// database; see README for that distinction)
// =====================================================================

async function sendBackupEmail(store, toEmail) {
  const csv = buildInventoryCsv(store.id);
  const csvBase64 = Buffer.from(csv, 'utf8').toString('base64');
  const dateStr = todayUtcDateStr();
  return sendEmail({
    to: toEmail,
    subject: `FloorStock backup \u2014 ${store.name} \u2014 ${dateStr}`,
    html: `
      <div style="font-family:Arial,sans-serif;color:#1C2530;max-width:480px;">
        <h2 style="margin-bottom:4px;">Your FloorStock backup</h2>
        <p style="color:#666;">Attached is a CSV snapshot of ${escapeHtml(store.name)}'s current inventory, generated ${escapeHtml(dateStr)}. Keep it somewhere safe as a portable copy of your data.</p>
      </div>
    `,
    attachments: [{ filename: `${store.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-backup-${dateStr}.csv`, content: csvBase64 }],
  });
}

app.post('/api/backup/send-test', requireManager, async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.auth.userId);
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(req.auth.storeId);
  if (!user.email) return res.status(400).json({ error: 'No email on file for your manager account.' });
  if (!RESEND_API_KEY) return res.status(400).json({ error: 'Email sending isn\u2019t configured on the server yet (missing RESEND_API_KEY).' });

  const result = await sendBackupEmail(store, user.email);
  if (!result.sent) return res.status(502).json({ error: `Couldn\u2019t send: ${result.reason}` });
  res.json({ sent: true, to: user.email });
});

function runBackupCheckIfDue() {
  if (!RESEND_API_KEY) return;
  const nowUtc = new Date();
  if (nowUtc.getUTCHours() !== DIGEST_HOUR_UTC) return; // piggyback on the same hour as the digest

  const today = todayUtcDateStr();
  const stores = db.prepare('SELECT * FROM stores').all();
  for (const store of stores) {
    const row = db.prepare('SELECT MAX(sent_date) as d FROM backup_log WHERE store_id = ?').get(store.id);
    const daysSince = (!row || !row.d) ? Infinity : (Date.now() - new Date(row.d + 'T00:00:00Z').getTime()) / 86400000;
    if (daysSince < 7) continue; // weekly cadence, fixed

    const manager = db.prepare("SELECT * FROM users WHERE store_id = ? AND role = 'manager' LIMIT 1").get(store.id);
    db.prepare('INSERT OR IGNORE INTO backup_log (store_id, sent_date, created_at) VALUES (?, ?, ?)').run(store.id, today, nowIso());
    if (manager && manager.email) sendBackupEmail(store, manager.email).catch(() => {});
  }
}
setInterval(runBackupCheckIfDue, 60 * 60 * 1000); // hourly check

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`FloorStock server running at http://localhost:${PORT}`);
  console.log(`Database file: ${DB_PATH}`);
  console.log(RESEND_API_KEY ? `Digest email enabled (checks hourly, sends at ${DIGEST_HOUR_UTC}:00 UTC per store's chosen frequency)` : 'Digest email disabled (no RESEND_API_KEY set)');
  console.log(RESEND_API_KEY ? 'Weekly per-store backup email enabled' : 'Weekly per-store backup email disabled (no RESEND_API_KEY set)');
  console.log(USDA_FDC_API_KEY ? 'USDA FoodData Central UPC source enabled' : 'USDA FoodData Central UPC source disabled (no USDA_FDC_API_KEY set)');
  console.log(ADMIN_EMAIL ? `Founder dashboard enabled for ${ADMIN_EMAIL}` : 'Founder dashboard disabled (no ADMIN_EMAIL set)');
});
