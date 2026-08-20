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

// Invoice import (optional — feature is simply unavailable without this).
// Costs a small amount per invoice processed; see README for an estimate.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

// Push notifications (optional — simply won't send without these). Uses
// OneSignal rather than talking to Apple's push service directly, since
// OneSignal's REST API is a single HTTP call with two static credentials,
// versus raw APNs which needs per-request JWT signing with a .p8 key.
// Sign up free at onesignal.com, create an iOS push app there (it'll walk
// you through uploading your Apple Push key), then set these two values.
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID || '';
const ONESIGNAL_REST_API_KEY = process.env.ONESIGNAL_REST_API_KEY || '';

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
  CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    trial_ends_at TEXT,
    subscription_status TEXT NOT NULL DEFAULT 'trialing',
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    subscription_plan TEXT,
    digest_frequency TEXT NOT NULL DEFAULT 'daily',
    critical_days INTEGER NOT NULL DEFAULT 3,
    soon_days INTEGER NOT NULL DEFAULT 60
  );

  CREATE TABLE IF NOT EXISTS stores (
    id TEXT PRIMARY KEY,
    organization_id TEXT,
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
    organization_id TEXT,
    store_id TEXT,
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
    organization_id TEXT,
    store_id TEXT,
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
    selling_price REAL,
    date_purchased TEXT,
    vendor TEXT
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

  -- Shift handoff notes — free-text notes any signed-in person (manager or
  -- worker) can leave for whoever opens the app next, optionally tagged to
  -- a location ("cooler 2 running warm"). Not scoped to a specific shift
  -- time window on purpose — a note stays visible and unresolved until
  -- someone explicitly marks it handled, since shifts don't always line up
  -- with clean time boundaries in a small store.
  CREATE TABLE IF NOT EXISTS shift_notes (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    location TEXT,
    note TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0,
    resolved_by TEXT,
    resolved_at TEXT
  );

  -- Scanned (or manually added) products that need to be reordered. Shared
  -- across the whole store, same spirit as shift notes — anyone can add or
  -- fulfill an item, not just managers.
  CREATE TABLE IF NOT EXISTS purchase_requests (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    upc TEXT,
    name TEXT,
    quantity INTEGER NOT NULL DEFAULT 1,
    requested_by TEXT,
    requested_at TEXT NOT NULL,
    fulfilled INTEGER NOT NULL DEFAULT 0,
    fulfilled_by TEXT,
    fulfilled_at TEXT
  );

  -- One row per device that has granted push permission. A person can be
  -- signed in on more than one device (phone + a shared tablet up front),
  -- so this is keyed by token, not by user.
  CREATE TABLE IF NOT EXISTS push_tokens (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    store_id TEXT NOT NULL,
    platform TEXT,
    created_at TEXT NOT NULL
  );

  -- Dedup log for scheduled (non-instant) pushes, so a hookup that runs
  -- hourly doesn't re-notify about the same overdue task or the same
  -- overnight-expired item every single hour it stays true.
  CREATE TABLE IF NOT EXISTS push_notify_log (
    dedup_key TEXT PRIMARY KEY,
    sent_at TEXT NOT NULL
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
    removed_at TEXT NOT NULL,
    vendor TEXT
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
    sold_at TEXT NOT NULL,
    vendor TEXT,
    category_id TEXT
  );

  -- Bulk scan queue: a fast scan only records the UPC (and a name/size if the
  -- lookup found one). It never becomes a real item — and never counts toward
  -- inventory totals — until someone fills in the required expiration date,
  -- quantity, and location and "completes" it.
  CREATE TABLE IF NOT EXISTS pending_items (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    upc TEXT NOT NULL,
    name TEXT,
    size_value REAL,
    size_unit TEXT,
    scanned_by TEXT,
    scanned_at TEXT NOT NULL,
    cost_price REAL,
    vendor TEXT,
    default_quantity REAL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    title TEXT NOT NULL,
    assigned_to TEXT NOT NULL,
    assigned_by TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
    created_at TEXT NOT NULL,
    completed_at TEXT
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
if (!itemCols.includes('date_purchased')) db.exec("ALTER TABLE items ADD COLUMN date_purchased TEXT");
if (!itemCols.includes('vendor')) db.exec("ALTER TABLE items ADD COLUMN vendor TEXT");

const removalCols = db.prepare("PRAGMA table_info(removals)").all().map(c => c.name);
if (!removalCols.includes('vendor')) db.exec("ALTER TABLE removals ADD COLUMN vendor TEXT");

const taskCols = db.prepare("PRAGMA table_info(tasks)").all().map(c => c.name);
if (!taskCols.includes('due_at')) db.exec("ALTER TABLE tasks ADD COLUMN due_at TEXT");

const pushTokenCols = db.prepare("PRAGMA table_info(push_tokens)").all().map(c => c.name);
if (!pushTokenCols.includes('onesignal_player_id')) db.exec("ALTER TABLE push_tokens ADD COLUMN onesignal_player_id TEXT");

// Per-user notification type preferences — default to on (1) so existing
// users keep getting everything until they explicitly turn something off.
const userNotifyCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
const notifyPrefColumns = ['notify_task_assigned', 'notify_task_overdue', 'notify_expired_items', 'notify_rescue_items', 'notify_trial_ending'];
for (const col of notifyPrefColumns) {
  if (!userNotifyCols.includes(col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 1`);
}
// Defaults OFF — most people have their own personal phone, where this
// would do nothing useful. Someone on a shared store device turns it on
// so the device stops being "claimed" by whoever logged in last.
if (!userNotifyCols.includes('clear_push_on_logout')) db.exec("ALTER TABLE users ADD COLUMN clear_push_on_logout INTEGER NOT NULL DEFAULT 0");

const salesCols = db.prepare("PRAGMA table_info(sales)").all().map(c => c.name);
if (!salesCols.includes('vendor')) db.exec("ALTER TABLE sales ADD COLUMN vendor TEXT");
if (!salesCols.includes('category_id')) db.exec("ALTER TABLE sales ADD COLUMN category_id TEXT");

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

// Multi-location support: every store now belongs to an organization, and
// billing lives on the organization, not the individual store. Backfill one
// organization per pre-existing store, carrying its billing/trial state over
// exactly as-is, so nobody's access or subscription changes because of this.
if (!storeCols.includes('organization_id')) db.exec("ALTER TABLE stores ADD COLUMN organization_id TEXT");
const userColsForOrg = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!userColsForOrg.includes('organization_id')) db.exec("ALTER TABLE users ADD COLUMN organization_id TEXT");

const storesNeedingOrg = db.prepare('SELECT * FROM stores WHERE organization_id IS NULL OR organization_id = ?').all('');
const backfillOrgTxn = db.transaction(() => {
  for (const store of storesNeedingOrg) {
    const orgId = newId();
    db.prepare(`
      INSERT INTO organizations (id, name, created_at, trial_ends_at, subscription_status, stripe_customer_id, stripe_subscription_id, subscription_plan, digest_frequency)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orgId, store.name, store.created_at, store.trial_ends_at, store.subscription_status,
      store.stripe_customer_id, store.stripe_subscription_id, store.subscription_plan, store.digest_frequency || 'daily'
    );
    db.prepare('UPDATE stores SET organization_id = ? WHERE id = ?').run(orgId, store.id);
    db.prepare('UPDATE users SET organization_id = ? WHERE store_id = ? AND (organization_id IS NULL OR organization_id = ?)')
      .run(orgId, store.id, '');
  }
});
if (storesNeedingOrg.length) {
  backfillOrgTxn();
  // Any session created before this migration has no organization_id and
  // would otherwise hit confusing billing errors until the person logs back
  // in anyway — clear them once, up front, so it's a clean re-login instead.
  db.exec('DELETE FROM sessions');
}

const sessionCols = db.prepare("PRAGMA table_info(sessions)").all().map(c => c.name);
if (!sessionCols.includes('organization_id')) db.exec("ALTER TABLE sessions ADD COLUMN organization_id TEXT");

const orgCols = db.prepare("PRAGMA table_info(organizations)").all().map(c => c.name);
if (!orgCols.includes('critical_days')) db.exec("ALTER TABLE organizations ADD COLUMN critical_days INTEGER NOT NULL DEFAULT 3");
if (!orgCols.includes('soon_days')) db.exec("ALTER TABLE organizations ADD COLUMN soon_days INTEGER NOT NULL DEFAULT 60");
if (!orgCols.includes('business_type')) db.exec("ALTER TABLE organizations ADD COLUMN business_type TEXT");

const pendingItemCols = db.prepare("PRAGMA table_info(pending_items)").all().map(c => c.name);
if (!pendingItemCols.includes('cost_price')) db.exec("ALTER TABLE pending_items ADD COLUMN cost_price REAL");
if (!pendingItemCols.includes('vendor')) db.exec("ALTER TABLE pending_items ADD COLUMN vendor TEXT");
if (!pendingItemCols.includes('default_quantity')) db.exec("ALTER TABLE pending_items ADD COLUMN default_quantity REAL");
if (!pendingItemCols.includes('suggested_expiration_date')) db.exec("ALTER TABLE pending_items ADD COLUMN suggested_expiration_date TEXT");

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

app.use(express.json({ limit: '25mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public'), {
  // index.html specifically must always be revalidated with the server
  // before use — without this, the native app's WKWebView can silently
  // keep serving a stale disk-cached copy indefinitely after a deploy,
  // surviving even a full force-quit/reopen (only a full app reinstall
  // clears it). "no-cache" still allows fast conditional (304) reloads
  // when nothing's actually changed, it just forbids using a cached copy
  // without checking first. Other static assets (icons, manifest) keep
  // normal caching since they change rarely and reloading them on every
  // request would be wasteful.
  setHeaders: (res, filePath) => {
    if (path.basename(filePath) === 'index.html') {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

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
    INSERT INTO sessions (id, user_id, organization_id, store_id, role, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, user.id, user.organization_id, user.store_id, user.role, nowIso(), expiresAt);
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
  req.auth = { userId: session.user_id, organizationId: session.organization_id, storeId: session.store_id, role: session.role, sessionId: session.id };
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

function getStoreCount(organizationId) {
  const row = db.prepare('SELECT COUNT(*) as c FROM stores WHERE organization_id = ?').get(organizationId);
  return row ? row.c : 0;
}

function billingSnapshot(org, storeCount) {
  const now = Date.now();
  const trialEndsAt = org.trial_ends_at;
  const trialActive = org.subscription_status === 'trialing' && trialEndsAt && new Date(trialEndsAt).getTime() > now;
  const paidActive = org.subscription_status === 'active';
  const daysLeft = trialEndsAt ? Math.max(0, Math.ceil((new Date(trialEndsAt).getTime() - now) / 86400000)) : 0;
  return {
    status: org.subscription_status,
    trialEndsAt: trialEndsAt || null,
    trialDaysLeft: daysLeft,
    active: paidActive || trialActive,
    billingEnabled: !!stripe,
    plansAvailable: { monthly: !!STRIPE_PRICE_ID_MONTHLY, annual: !!STRIPE_PRICE_ID_ANNUAL },
    plan: org.subscription_plan || null,
    storeCount: storeCount != null ? storeCount : getStoreCount(org.id),
  };
}

function requireActiveSubscription(req, res, next) {
  if (!stripe) return next(); // billing not configured on this deployment — never block
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.auth.organizationId);
  if (!org) return res.status(401).json({ error: 'Not signed in.' });
  const snap = billingSnapshot(org);
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
  const { storeName, storeAddress, username, password, email, businessType } = req.body || {};
  if (!storeName || !String(storeName).trim()) return res.status(400).json({ error: 'Store name is required.' });
  if (!storeAddress || !String(storeAddress).trim()) return res.status(400).json({ error: 'Store address is required.' });
  if (!username || !String(username).trim()) return res.status(400).json({ error: 'Username is required.' });
  if (!isStrongEnoughPassword(password)) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (!isValidEmail(email)) return res.status(400).json({ error: 'A valid email is required (used for expiration alerts).' });
  if (!businessType || !String(businessType).trim()) return res.status(400).json({ error: 'Please select what type of business this is.' });

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim().toLowerCase());
  if (existing) return res.status(409).json({ error: 'That username is already taken.' });

  const orgId = newId();
  const storeId = newId();
  const userId = newId();
  const passwordHash = bcrypt.hashSync(password, 10);
  const ts = nowIso();
  const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  db.prepare(`
    INSERT INTO organizations (id, name, created_at, trial_ends_at, subscription_status, business_type)
    VALUES (?, ?, ?, ?, 'trialing', ?)
  `).run(orgId, storeName.trim(), ts, trialEndsAt, businessType.trim());
  db.prepare('INSERT INTO stores (id, organization_id, name, address, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(storeId, orgId, storeName.trim(), storeAddress.trim(), ts);
  db.prepare(`
    INSERT INTO users (id, organization_id, store_id, username, password_hash, role, email, created_at)
    VALUES (?, ?, ?, ?, ?, 'manager', ?, ?)
  `).run(userId, orgId, storeId, username.trim().toLowerCase(), passwordHash, email.trim().toLowerCase(), ts);

  logAudit(storeId, username.trim().toLowerCase(), 'store_created', `Store "${storeName.trim()}" created`);

  const session = createSession({ id: userId, organization_id: orgId, store_id: storeId, role: 'manager' });
  setSessionCookie(res, session.id, session.expiresAt);
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(orgId);
  res.status(201).json({
    role: 'manager', username: username.trim().toLowerCase(),
    store: { id: storeId, name: storeName.trim(), address: storeAddress.trim() },
    billing: billingSnapshot(org, 1),
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

  // Managers can have multiple stores; fall back to any store in their org if
  // their last-active one was somehow removed. Workers always have exactly one.
  let store = user.store_id ? db.prepare('SELECT * FROM stores WHERE id = ?').get(user.store_id) : null;
  if (!store || store.organization_id !== user.organization_id) {
    store = db.prepare('SELECT * FROM stores WHERE organization_id = ? ORDER BY created_at ASC LIMIT 1').get(user.organization_id);
  }
  if (!store) return res.status(500).json({ error: 'No store found for this account.' });

  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(user.organization_id);
  const session = createSession({ id: user.id, organization_id: user.organization_id, store_id: store.id, role: user.role });
  setSessionCookie(res, session.id, session.expiresAt);
  res.json({ role: user.role, username: user.username, store: { id: store.id, name: store.name, address: store.address }, billing: billingSnapshot(org) });
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
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.auth.organizationId);
  if (!user || !store || !org) return res.json({ signedIn: false });
  res.json({ signedIn: true, role: user.role, username: user.username, store: { id: store.id, name: store.name, address: store.address }, billing: billingSnapshot(org) });
});

// List every store (location) in the signed-in manager's organization, and
// switch which one the current session is actively viewing/editing.
app.get('/api/stores', requireManager, (req, res) => {
  const stores = db.prepare('SELECT * FROM stores WHERE organization_id = ? ORDER BY created_at ASC').all(req.auth.organizationId);
  res.json(stores.map(s => ({ id: s.id, name: s.name, address: s.address, isCurrent: s.id === req.auth.storeId })));
});

app.post('/api/stores', requireManager, async (req, res) => {
  const { name, address } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Location name is required.' });
  if (!address || !String(address).trim()) return res.status(400).json({ error: 'Location address is required.' });

  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.auth.organizationId);
  const snap = billingSnapshot(org);
  if (org.subscription_status !== 'active' && !(org.subscription_status === 'trialing' && snap.active)) {
    return res.status(402).json({ error: 'Subscribe to add more than one location.', billing: snap });
  }

  const storeId = newId();
  db.prepare('INSERT INTO stores (id, organization_id, name, address, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(storeId, req.auth.organizationId, name.trim(), address.trim(), nowIso());
  logAudit(storeId, currentUsername(req), 'store_created', `Location "${name.trim()}" added`);

  // If already on a paid subscription, keep Stripe's quantity in sync so
  // billing reflects the new location automatically.
  if (stripe && org.subscription_status === 'active' && org.stripe_subscription_id) {
    try {
      const sub = await stripe.subscriptions.retrieve(org.stripe_subscription_id);
      const item = sub.items.data[0];
      if (item) {
        await stripe.subscriptionItems.update(item.id, { quantity: getStoreCount(req.auth.organizationId), proration_behavior: 'create_prorations' });
      }
    } catch (e) {
      // Store is still created either way — billing sync failure shouldn't block adding a location.
    }
  }

  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(storeId);
  res.status(201).json({ id: store.id, name: store.name, address: store.address, isCurrent: false });
});

app.post('/api/stores/switch', requireManager, (req, res) => {
  const { storeId } = req.body || {};
  const store = db.prepare('SELECT * FROM stores WHERE id = ? AND organization_id = ?').get(storeId, req.auth.organizationId);
  if (!store) return res.status(404).json({ error: 'Location not found.' });

  db.prepare('UPDATE sessions SET store_id = ? WHERE id = ?').run(store.id, req.auth.sessionId);
  db.prepare('UPDATE users SET store_id = ? WHERE id = ?').run(store.id, req.auth.userId); // remember for next login too
  res.json({ id: store.id, name: store.name, address: store.address });
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
    INSERT INTO users (id, organization_id, store_id, username, password_hash, role, created_at)
    VALUES (?, ?, ?, ?, ?, 'worker', ?)
  `).run(id, req.auth.organizationId, req.auth.storeId, uname, bcrypt.hashSync(password, 10), nowIso());

  logAudit(req.auth.storeId, currentUsername(req), 'worker_added', `Added worker login "${uname}" for this location`);
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
// MANAGERS (multiple managers per store — e.g. an assistant manager)
// =====================================================================

app.get('/api/managers', requireManager, (req, res) => {
  const rows = db.prepare("SELECT id, username, email, created_at FROM users WHERE store_id = ? AND role = 'manager' ORDER BY created_at ASC").all(req.auth.storeId);
  res.json(rows.map(r => ({ id: r.id, username: r.username, email: r.email || null, createdAt: r.created_at })));
});

app.post('/api/managers', requireManager, (req, res) => {
  const { username, password, email } = req.body || {};
  if (!username || !String(username).trim()) return res.status(400).json({ error: 'Username is required.' });
  if (!isStrongEnoughPassword(password)) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (email && !isValidEmail(email)) return res.status(400).json({ error: 'That email doesn\u2019t look right.' });

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim().toLowerCase());
  if (existing) return res.status(409).json({ error: 'That username is already taken.' });

  const id = newId();
  const uname = username.trim().toLowerCase();
  db.prepare(`
    INSERT INTO users (id, organization_id, store_id, username, password_hash, role, email, created_at)
    VALUES (?, ?, ?, ?, ?, 'manager', ?, ?)
  `).run(id, req.auth.organizationId, req.auth.storeId, uname, bcrypt.hashSync(password, 10), email ? email.trim().toLowerCase() : null, nowIso());

  logAudit(req.auth.storeId, currentUsername(req), 'manager_added', `Added manager login "${uname}" for this location`);
  res.status(201).json({ id, username: uname, email: email ? email.trim().toLowerCase() : null });
});

app.put('/api/managers/:id/password', requireManager, (req, res) => {
  const { password } = req.body || {};
  if (!isStrongEnoughPassword(password)) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  const manager = db.prepare("SELECT * FROM users WHERE id = ? AND store_id = ? AND role = 'manager'").get(req.params.id, req.auth.storeId);
  if (!manager) return res.status(404).json({ error: 'Manager not found.' });

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), req.params.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.params.id);

  logAudit(req.auth.storeId, currentUsername(req), 'manager_password_reset', `Reset password for manager "${manager.username}"`);
  res.status(204).end();
});

app.delete('/api/managers/:id', requireManager, (req, res) => {
  const manager = db.prepare("SELECT * FROM users WHERE id = ? AND store_id = ? AND role = 'manager'").get(req.params.id, req.auth.storeId);
  if (!manager) return res.status(404).json({ error: 'Manager not found.' });

  if (req.params.id === req.auth.userId) {
    return res.status(400).json({ error: 'You can\u2019t remove your own manager account while signed in as it.' });
  }
  const managerCount = db.prepare("SELECT COUNT(*) as c FROM users WHERE store_id = ? AND role = 'manager'").get(req.auth.storeId).c;
  if (managerCount <= 1) {
    return res.status(400).json({ error: 'Every store needs at least one manager \u2014 add another manager before removing this one.' });
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.params.id);
  logAudit(req.auth.storeId, currentUsername(req), 'manager_removed', `Removed manager login "${manager.username}"`);
  res.status(204).end();
});

// =====================================================================
// TASKS (manager assigns, any signed-in user at the store can see/complete)
// =====================================================================

function rowToTask(row) {
  return {
    id: row.id,
    title: row.title,
    assignedTo: row.assigned_to,
    assignedBy: row.assigned_by || null,
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at || null,
    dueAt: row.due_at || null,
  };
}

app.get('/api/tasks', requireAuth, requireActiveSubscription, (req, res) => {
  const rows = db.prepare('SELECT * FROM tasks WHERE store_id = ? ORDER BY (status = \'done\'), created_at DESC').all(req.auth.storeId);
  res.json(rows.map(rowToTask));
});

app.get('/api/tasks/mine', requireAuth, requireActiveSubscription, (req, res) => {
  const rows = db.prepare('SELECT * FROM tasks WHERE store_id = ? AND assigned_to = ? ORDER BY (status = \'done\'), created_at DESC').all(req.auth.storeId, req.auth.userId);
  res.json(rows.map(rowToTask));
});

app.post('/api/tasks', requireManager, (req, res) => {
  const { title, assignedTo, dueDate, dueTime } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'A task title is required.' });
  if (!assignedTo || !String(assignedTo).trim()) return res.status(400).json({ error: 'Pick who this is assigned to.' });

  const worker = db.prepare('SELECT username FROM users WHERE id = ? AND store_id = ?').get(assignedTo, req.auth.storeId);
  if (!worker) return res.status(400).json({ error: 'That person isn\u2019t part of this store.' });

  let dueAt = null;
  if (dueDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return res.status(400).json({ error: 'That due date doesn\u2019t look right.' });
    let time = '23:59'; // no time given — treat the due date as "by end of that day"
    if (dueTime) {
      if (!/^\d{2}:\d{2}$/.test(dueTime)) return res.status(400).json({ error: 'That due time doesn\u2019t look right.' });
      time = dueTime;
    }
    dueAt = `${dueDate}T${time}:00`;
  }

  const id = newId();
  db.prepare('INSERT INTO tasks (id, store_id, title, assigned_to, assigned_by, status, created_at, due_at) VALUES (?, ?, ?, ?, ?, \'open\', ?, ?)')
    .run(id, req.auth.storeId, title.trim(), assignedTo, currentUsername(req), nowIso(), dueAt);

  logAudit(req.auth.storeId, currentUsername(req), 'task_assigned', `Assigned "${title.trim()}" to ${worker.username}`);

  // Fire-and-forget — the task is already saved either way, so a slow or
  // failed push shouldn't delay or break the response to the manager.
  sendPushToUser(assignedTo, 'New task assigned', title.trim(), { data: { screen: 'tasks', taskId: id }, type: 'taskAssigned' }).catch(() => {});

  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  res.status(201).json(rowToTask(row));
});

app.put('/api/tasks/:id/complete', requireAuth, requireActiveSubscription, (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND store_id = ?').get(req.params.id, req.auth.storeId);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  const newStatus = task.status === 'done' ? 'open' : 'done';
  db.prepare('UPDATE tasks SET status = ?, completed_at = ? WHERE id = ?')
    .run(newStatus, newStatus === 'done' ? nowIso() : null, task.id);
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id);
  res.json(rowToTask(row));
});

app.delete('/api/tasks/:id', requireManager, (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND store_id = ?').get(req.params.id, req.auth.storeId);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
  res.status(204).end();
});

// =====================================================================
// SHIFT NOTES (handoff notes between shifts — any signed-in role)
// =====================================================================

function rowToShiftNote(row) {
  return {
    id: row.id,
    location: row.location || null,
    note: row.note,
    createdBy: row.created_by || null,
    createdAt: row.created_at,
    resolved: !!row.resolved,
    resolvedBy: row.resolved_by || null,
    resolvedAt: row.resolved_at || null,
  };
}

app.get('/api/shift-notes', requireAuth, requireActiveSubscription, (req, res) => {
  const rows = db.prepare('SELECT * FROM shift_notes WHERE store_id = ? ORDER BY resolved ASC, created_at DESC').all(req.auth.storeId);
  res.json(rows.map(rowToShiftNote));
});

app.post('/api/shift-notes', requireAuth, requireActiveSubscription, (req, res) => {
  const { note, location } = req.body || {};
  if (!note || !String(note).trim()) return res.status(400).json({ error: 'Enter a note.' });
  const id = newId();
  db.prepare(`
    INSERT INTO shift_notes (id, store_id, location, note, created_by, created_at, resolved)
    VALUES (?, ?, ?, ?, ?, ?, 0)
  `).run(id, req.auth.storeId, location ? String(location).trim() : null, String(note).trim(), currentUsername(req), nowIso());
  res.status(201).json(rowToShiftNote(db.prepare('SELECT * FROM shift_notes WHERE id = ?').get(id)));
});

app.put('/api/shift-notes/:id/resolve', requireAuth, requireActiveSubscription, (req, res) => {
  const existing = db.prepare('SELECT * FROM shift_notes WHERE id = ? AND store_id = ?').get(req.params.id, req.auth.storeId);
  if (!existing) return res.status(404).json({ error: 'Note not found.' });
  const nowResolved = existing.resolved ? 0 : 1;
  db.prepare('UPDATE shift_notes SET resolved = ?, resolved_by = ?, resolved_at = ? WHERE id = ?')
    .run(nowResolved, nowResolved ? currentUsername(req) : null, nowResolved ? nowIso() : null, req.params.id);
  res.json(rowToShiftNote(db.prepare('SELECT * FROM shift_notes WHERE id = ?').get(req.params.id)));
});

app.delete('/api/shift-notes/:id', requireAuth, requireActiveSubscription, (req, res) => {
  const existing = db.prepare('SELECT * FROM shift_notes WHERE id = ? AND store_id = ?').get(req.params.id, req.auth.storeId);
  if (!existing) return res.status(404).json({ error: 'Note not found.' });
  db.prepare('DELETE FROM shift_notes WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// =====================================================================
// PURCHASE REQUESTS ("need to purchase" list, filled by scanning)
// =====================================================================

function rowToPurchaseRequest(row) {
  return {
    id: row.id,
    upc: row.upc || null,
    name: row.name || null,
    quantity: row.quantity,
    requestedBy: row.requested_by || null,
    requestedAt: row.requested_at,
    fulfilled: !!row.fulfilled,
    fulfilledBy: row.fulfilled_by || null,
    fulfilledAt: row.fulfilled_at || null,
  };
}

app.get('/api/purchase-requests', requireAuth, requireActiveSubscription, (req, res) => {
  const rows = db.prepare('SELECT * FROM purchase_requests WHERE store_id = ? ORDER BY fulfilled ASC, requested_at DESC').all(req.auth.storeId);
  res.json(rows.map(rowToPurchaseRequest));
});

app.post('/api/purchase-requests', requireAuth, requireActiveSubscription, (req, res) => {
  const { upc, name, quantity } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'A product name is required.' });
  const qty = Number(quantity);
  const id = newId();
  db.prepare(`
    INSERT INTO purchase_requests (id, store_id, upc, name, quantity, requested_by, requested_at, fulfilled)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
  `).run(id, req.auth.storeId, upc ? String(upc).trim() : null, String(name).trim(), Number.isFinite(qty) && qty > 0 ? qty : 1, currentUsername(req), nowIso());
  res.status(201).json(rowToPurchaseRequest(db.prepare('SELECT * FROM purchase_requests WHERE id = ?').get(id)));
});

app.put('/api/purchase-requests/:id/fulfill', requireAuth, requireActiveSubscription, (req, res) => {
  const existing = db.prepare('SELECT * FROM purchase_requests WHERE id = ? AND store_id = ?').get(req.params.id, req.auth.storeId);
  if (!existing) return res.status(404).json({ error: 'Not found.' });
  const nowFulfilled = existing.fulfilled ? 0 : 1;
  db.prepare('UPDATE purchase_requests SET fulfilled = ?, fulfilled_by = ?, fulfilled_at = ? WHERE id = ?')
    .run(nowFulfilled, nowFulfilled ? currentUsername(req) : null, nowFulfilled ? nowIso() : null, req.params.id);
  res.json(rowToPurchaseRequest(db.prepare('SELECT * FROM purchase_requests WHERE id = ?').get(req.params.id)));
});

app.delete('/api/purchase-requests/:id', requireAuth, requireActiveSubscription, (req, res) => {
  const existing = db.prepare('SELECT * FROM purchase_requests WHERE id = ? AND store_id = ?').get(req.params.id, req.auth.storeId);
  if (!existing) return res.status(404).json({ error: 'Not found.' });
  db.prepare('DELETE FROM purchase_requests WHERE id = ?').run(req.params.id);
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
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.auth.organizationId);
  res.json(billingSnapshot(org));
});

function appBaseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

app.post('/api/billing/create-checkout-session', requireManager, async (req, res) => {
  const plan = req.body && req.body.plan === 'annual' ? 'annual' : 'monthly';
  const priceId = plan === 'annual' ? STRIPE_PRICE_ID_ANNUAL : STRIPE_PRICE_ID_MONTHLY;

  if (!stripe || !priceId) return res.status(400).json({ error: `The ${plan} plan isn\u2019t configured on the server yet.` });
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.auth.organizationId);
  const manager = db.prepare('SELECT * FROM users WHERE id = ?').get(req.auth.userId);
  const quantity = Math.max(1, getStoreCount(req.auth.organizationId));

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity }],
      customer: org.stripe_customer_id || undefined,
      customer_email: org.stripe_customer_id ? undefined : manager.email,
      client_reference_id: org.id,
      metadata: { organizationId: org.id, plan },
      subscription_data: { metadata: { organizationId: org.id, plan } },
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
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.auth.organizationId);
  if (!org.stripe_customer_id) return res.status(400).json({ error: 'No billing account on file yet \u2014 subscribe first.' });

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: org.stripe_customer_id,
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
    if (session.client_reference_id !== req.auth.organizationId) {
      return res.status(403).json({ error: 'This checkout session doesn\u2019t belong to your organization.' });
    }
    if (session.payment_status === 'paid' || (session.subscription && session.subscription.status === 'active')) {
      applySubscriptionToOrg(req.auth.organizationId, session.customer, session.subscription, session.metadata && session.metadata.plan);
    }
    const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.auth.organizationId);
    res.json(billingSnapshot(org));
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
  const orgs = db.prepare('SELECT * FROM organizations').all();
  const allStores = db.prepare('SELECT * FROM stores').all();
  const storeCountByOrg = new Map();
  for (const s of allStores) storeCountByOrg.set(s.organization_id, (storeCountByOrg.get(s.organization_id) || 0) + 1);
  const now = Date.now();

  const totalStores = allStores.length;
  const totalOrgs = orgs.length;
  const trialing = orgs.filter(o => o.subscription_status === 'trialing');
  const active = orgs.filter(o => o.subscription_status === 'active');
  const canceled = orgs.filter(o => o.subscription_status === 'canceled');
  const pastDue = orgs.filter(o => o.subscription_status === 'past_due');
  const activeMonthly = active.filter(o => o.subscription_plan === 'monthly');
  const activeAnnual = active.filter(o => o.subscription_plan === 'annual');
  const activeUnknownPlan = active.length - activeMonthly.length - activeAnnual.length;

  const prices = await getPriceAmounts();
  const sumStores = (list) => list.reduce((sum, o) => sum + (storeCountByOrg.get(o.id) || 1), 0);
  const mrr = (sumStores(activeMonthly) * (prices.monthly || 0)) + (sumStores(activeAnnual) * ((prices.annual || 0) / 12));

  const trialEndingSoon = trialing
    .filter(o => o.trial_ends_at && (new Date(o.trial_ends_at).getTime() - now) <= 3 * 24 * 60 * 60 * 1000)
    .map(o => ({ id: o.id, name: o.name, trialEndsAt: o.trial_ends_at }))
    .sort((a, b) => new Date(a.trialEndsAt) - new Date(b.trialEndsAt));

  const recentSignups = [...orgs]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .map(o => {
      const primaryStore = allStores.find(s => s.organization_id === o.id);
      const manager = db.prepare("SELECT username, email FROM users WHERE organization_id = ? AND role = 'manager' LIMIT 1").get(o.id);
      const orgStoreIds = allStores.filter(s => s.organization_id === o.id).map(s => s.id);
      const productCount = orgStoreIds.length
        ? db.prepare(`SELECT COUNT(*) as c FROM items WHERE store_id IN (${orgStoreIds.map(() => '?').join(',')})`).get(...orgStoreIds).c
        : 0;
      const lastSessionAt = orgStoreIds.length
        ? db.prepare('SELECT MAX(created_at) as t FROM sessions WHERE organization_id = ?').get(o.id).t
        : null;
      const lastAuditAt = orgStoreIds.length
        ? db.prepare(`SELECT MAX(created_at) as t FROM audit_log WHERE store_id IN (${orgStoreIds.map(() => '?').join(',')})`).get(...orgStoreIds).t
        : null;
      const lastActivityAt = [lastSessionAt, lastAuditAt].filter(Boolean).sort().pop() || null;
      return {
        id: o.id,
        name: o.name,
        createdAt: o.created_at,
        status: o.subscription_status,
        storeCount: storeCountByOrg.get(o.id) || 1,
        businessType: o.business_type || null,
        address: primaryStore ? primaryStore.address : null,
        managerUsername: manager ? manager.username : null,
        managerEmail: manager ? manager.email : null,
        productCount,
        lastActivityAt,
      };
    });

  res.json({
    totalStores,
    totalOrganizations: totalOrgs,
    trialingCount: trialing.length,
    activeCount: active.length,
    activeMonthly: activeMonthly.length, activeAnnual: activeAnnual.length, activeUnknownPlan,
    canceledCount: canceled.length,
    pastDueCount: pastDue.length,
    mrr: Math.round(mrr * 100) / 100,
    mrrEstimated: !(prices.monthly || prices.annual),
    trialEndingSoon,
    recentSignups,
  });
});

// Full drill-down for a single organization — every store, every user, an
// activity feed, and enough subscription detail to support them without
// digging through the database by hand.
app.get('/api/admin/organizations/:id', requireAdmin, (req, res) => {
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.params.id);
  if (!org) return res.status(404).json({ error: 'Organization not found.' });

  const stores = db.prepare('SELECT * FROM stores WHERE organization_id = ? ORDER BY created_at ASC').all(org.id);
  const storeIds = stores.map(s => s.id);

  const storesDetail = stores.map(s => {
    const itemCount = db.prepare('SELECT COUNT(*) as c FROM items WHERE store_id = ?').get(s.id).c;
    const users = db.prepare('SELECT id, username, role, email, created_at FROM users WHERE store_id = ? ORDER BY role ASC, created_at ASC').all(s.id);
    return {
      id: s.id, name: s.name, address: s.address, createdAt: s.created_at,
      itemCount,
      users: users.map(u => ({ id: u.id, username: u.username, role: u.role, email: u.email || null, createdAt: u.created_at })),
    };
  });

  const recentActivity = storeIds.length
    ? db.prepare(`
        SELECT * FROM audit_log WHERE store_id IN (${storeIds.map(() => '?').join(',')})
        ORDER BY created_at DESC LIMIT 30
      `).all(...storeIds)
    : [];

  res.json({
    id: org.id,
    name: org.name,
    businessType: org.business_type || null,
    createdAt: org.created_at,
    subscriptionStatus: org.subscription_status,
    subscriptionPlan: org.subscription_plan || null,
    trialEndsAt: org.trial_ends_at || null,
    stripeCustomerId: org.stripe_customer_id || null,
    stores: storesDetail,
    recentActivity: recentActivity.map(a => ({ actor: a.actor_username, action: a.action, summary: a.summary, createdAt: a.created_at })),
  });
});

app.post('/api/admin/organizations/:id/extend-trial', requireAdmin, (req, res) => {
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.params.id);
  if (!org) return res.status(404).json({ error: 'Organization not found.' });

  const days = Number(req.body && req.body.days);
  if (!Number.isFinite(days) || days <= 0 || days > 365) return res.status(400).json({ error: 'Enter a number of days between 1 and 365.' });

  const base = Math.max(Date.now(), org.trial_ends_at ? new Date(org.trial_ends_at).getTime() : 0);
  const newTrialEndsAt = new Date(base + days * 24 * 60 * 60 * 1000).toISOString();
  db.prepare("UPDATE organizations SET trial_ends_at = ?, subscription_status = 'trialing' WHERE id = ?").run(newTrialEndsAt, org.id);

  res.json({ trialEndsAt: newTrialEndsAt });
});

app.put('/api/admin/organizations/:id/subscription-status', requireAdmin, (req, res) => {
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.params.id);
  if (!org) return res.status(404).json({ error: 'Organization not found.' });

  const { status } = req.body || {};
  const allowed = ['trialing', 'active', 'past_due', 'canceled'];
  if (!allowed.includes(status)) return res.status(400).json({ error: `Status must be one of: ${allowed.join(', ')}` });

  db.prepare('UPDATE organizations SET subscription_status = ? WHERE id = ?').run(status, org.id);
  res.json({ subscriptionStatus: status });
});

app.post('/api/admin/organizations/:id/reset-password', requireAdmin, (req, res) => {
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.params.id);
  if (!org) return res.status(404).json({ error: 'Organization not found.' });

  const { userId, newPassword } = req.body || {};
  if (!isStrongEnoughPassword(newPassword)) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  const user = db.prepare('SELECT * FROM users WHERE id = ? AND organization_id = ?').get(userId, org.id);
  if (!user) return res.status(404).json({ error: 'That user isn\u2019t part of this organization.' });

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 10), user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);

  res.status(204).end();
});

function applySubscriptionToOrg(organizationId, stripeCustomerId, subscription, plan) {
  const status = typeof subscription === 'string' ? 'active' : (subscription && subscription.status) || 'active';
  const subscriptionId = typeof subscription === 'string' ? subscription : subscription && subscription.id;
  const inferredPlan = plan || (subscription && subscription.metadata && subscription.metadata.plan) || null;
  db.prepare(`
    UPDATE organizations SET stripe_customer_id = ?, stripe_subscription_id = ?, subscription_status = ?, subscription_plan = COALESCE(?, subscription_plan)
    WHERE id = ?
  `).run(stripeCustomerId || null, subscriptionId || null, status === 'active' || status === 'trialing' ? 'active' : status, inferredPlan, organizationId);
}

function handleStripeEvent(event) {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const organizationId = session.client_reference_id || (session.metadata && session.metadata.organizationId);
      const plan = session.metadata && session.metadata.plan;
      if (organizationId) applySubscriptionToOrg(organizationId, session.customer, session.subscription, plan);
      break;
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.created': {
      const sub = event.data.object;
      const organizationId = sub.metadata && sub.metadata.organizationId;
      const plan = sub.metadata && sub.metadata.plan;
      if (organizationId) {
        db.prepare('UPDATE organizations SET subscription_status = ?, stripe_subscription_id = ?, subscription_plan = COALESCE(?, subscription_plan) WHERE id = ?')
          .run(sub.status, sub.id, plan || null, organizationId);
      }
      break;
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      const organizationId = sub.metadata && sub.metadata.organizationId;
      if (organizationId) {
        db.prepare("UPDATE organizations SET subscription_status = 'canceled' WHERE id = ?").run(organizationId);
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

// Expands a 6, 7, or 8-digit UPC-E (the compressed barcode format common on
// gum, candy, and other small packaging) to its full 12-digit UPC-A form,
// per the GS1 General Specifications zero-suppression rules. Returns null
// if the input isn't a plausible UPC-E code.
function expandUpcE(raw) {
  const s = String(raw).replace(/\D/g, '');
  let nsc, body;
  if (s.length === 8) { nsc = s[0]; body = s.slice(1, 7); }
  else if (s.length === 7) { nsc = s[0]; body = s.slice(1, 7); }
  else if (s.length === 6) { nsc = '0'; body = s; }
  else return null;
  if (nsc !== '0' && nsc !== '1') return null;

  const [d1, d2, d3, d4, d5, d6] = body.split('').map(Number);
  let eleven;
  if (d6 <= 2) eleven = `${nsc}${d1}${d2}${d6}0000${d3}${d4}${d5}`;
  else if (d6 === 3) eleven = `${nsc}${d1}${d2}${d3}00000${d4}${d5}`;
  else if (d6 === 4) eleven = `${nsc}${d1}${d2}${d3}${d4}00000${d5}`;
  else eleven = `${nsc}${d1}${d2}${d3}${d4}${d5}0000${d6}`;
  if (eleven.length !== 11 || /[^0-9]/.test(eleven)) return null;

  const digits = eleven.split('').map(Number);
  let sum = 0;
  for (let i = 0; i < 11; i++) sum += digits[i] * ((i + 1) % 2 === 1 ? 3 : 1);
  const check = (10 - (sum % 10)) % 10;
  return eleven + check;
}

// A 12-digit UPC-A and its 13-digit EAN-13 form (leading zero) are the same
// product but different strings — try both so a format mismatch alone
// doesn't cause a false "not found." A 6/7/8-digit code gets expanded from
// UPC-E to full UPC-A too, since compressed barcodes won't match a database
// that only stores the full form.
function upcVariants(upc) {
  const variants = [upc];
  if (upc.length === 12) variants.push('0' + upc);
  if (upc.length === 13 && upc.startsWith('0')) variants.push(upc.slice(1));
  if (upc.length === 6 || upc.length === 7 || upc.length === 8) {
    const expanded = expandUpcE(upc);
    if (expanded) { variants.push(expanded); variants.push('0' + expanded); }
  }
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

async function performUpcLookup(upc) {
  const cached = getCachedUpc(upc);
  if (cached) return cached;

  const variants = upcVariants(upc);
  const sources = [lookupOpenFoodFacts, lookupUsda, lookupUpcItemDb];

  for (const source of sources) {
    for (const variant of variants) {
      const result = await source(variant);
      if (result) {
        cacheUpcResult(upc, result);
        return { found: true, ...result };
      }
    }
  }
  return { found: false };
}

app.get('/api/upc-lookup/:upc', requireAuth, requireActiveSubscription, async (req, res) => {
  const upc = String(req.params.upc || '').trim();
  if (!upc) return res.status(400).json({ error: 'UPC is required.' });
  res.json(await performUpcLookup(upc));
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
    datePurchased: row.date_purchased || null,
    categoryId: row.category_id || null,
    sizeValue: row.size_value === null || row.size_value === undefined ? null : row.size_value,
    sizeUnit: row.size_unit || null,
    costPrice: row.cost_price === null || row.cost_price === undefined ? null : row.cost_price,
    sellingPrice: row.selling_price === null || row.selling_price === undefined ? null : row.selling_price,
    vendor: row.vendor || null,
  };
}

function validatePayload(body) {
  const { upc, name, expirationDate, quantity, unit, location, categoryId, sizeValue, sizeUnit, costPrice, sellingPrice, datePurchased } = body || {};
  if (!upc || typeof upc !== 'string' || !upc.trim()) return 'UPC is required.';
  if (!name || typeof name !== 'string' || !name.trim()) return 'Product name is required.';
  if (!categoryId || typeof categoryId !== 'string' || !categoryId.trim()) return 'A category is required.';
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
  if (datePurchased !== undefined && datePurchased !== null && datePurchased !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(datePurchased)) {
    return 'Date purchased must be a valid date.';
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
  const header = ['Product Name', 'UPC', 'Category', 'Size', 'Expiration Date', 'Quantity', 'Unit', 'Location', 'Vendor', 'Cost Price', 'Selling Price', 'Margin %', 'Date Purchased', 'Date Added'];
  const lines = [header.join(',')];
  for (const r of rows) {
    const categoryName = r.category_id ? (categories.get(r.category_id) || '') : '';
    const size = r.size_value ? `${r.size_value} ${r.size_unit || ''}`.trim() : '';
    const marginPct = (r.cost_price && r.selling_price && r.selling_price > 0)
      ? (((r.selling_price - r.cost_price) / r.selling_price) * 100).toFixed(1)
      : '';
    lines.push([
      escapeCsvValue(r.name), escapeCsvValue(r.upc), escapeCsvValue(categoryName), escapeCsvValue(size), escapeCsvValue(r.expiration_date),
      escapeCsvValue(r.quantity), escapeCsvValue(r.unit), escapeCsvValue(r.location), escapeCsvValue(r.vendor || ''),
      escapeCsvValue(r.cost_price || ''), escapeCsvValue(r.selling_price || ''), escapeCsvValue(marginPct),
      escapeCsvValue(r.date_purchased || ''), escapeCsvValue(r.date_added),
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
  datePurchased: ['datepurchased', 'purchasedate', 'purchased'],
  vendor: ['vendor', 'supplier', 'vendorsupplier'],
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
    INSERT INTO items (id, store_id, upc, name, expiration_date, quantity, unit, location, date_added, category_id, size_value, size_unit, cost_price, selling_price, date_purchased, vendor)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      const datePurchased = normalizeImportDate(get('datePurchased'));
      const vendor = get('vendor');

      insertItem.run(
        newId(), req.auth.storeId, upc, name, expirationDate, quantity, get('unit') || 'each', location, dateAdded,
        categoryId, Number.isFinite(sizeValue) ? sizeValue : null, get('sizeUnit') || null,
        Number.isFinite(costPrice) ? costPrice : null, Number.isFinite(sellingPrice) ? sellingPrice : null,
        datePurchased || null, vendor || null
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

  const { upc, name, expirationDate, quantity, unit, location, categoryId, sizeValue, sizeUnit, costPrice, sellingPrice, datePurchased, vendor } = req.body;
  const id = newId();
  const dateAdded = nowIso();

  db.prepare(`
    INSERT INTO items (id, store_id, upc, name, expiration_date, quantity, unit, location, date_added, category_id, size_value, size_unit, cost_price, selling_price, date_purchased, vendor)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, req.auth.storeId, upc.trim(), name.trim(), expirationDate, quantity, unit.trim(), location.trim(), dateAdded,
    categoryId || null, (sizeValue === '' || sizeValue === undefined) ? null : sizeValue, sizeUnit || null,
    (costPrice === '' || costPrice === undefined) ? null : costPrice, (sellingPrice === '' || sellingPrice === undefined) ? null : sellingPrice,
    (datePurchased === '' || datePurchased === undefined) ? null : datePurchased,
    (vendor === '' || vendor === undefined) ? null : String(vendor).trim()
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
    INSERT INTO sales (id, store_id, item_id, item_name, quantity, unit, cost_price, selling_price, sold_by, sold_at, vendor, category_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    newId(), req.auth.storeId, existing.id, existing.name, sellQty, existing.unit,
    existing.cost_price, existing.selling_price, currentUsername(req), nowIso(),
    existing.vendor || null, existing.category_id || null
  );

  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  res.json({ item: rowToItem(row), sold: sellQty });
});

app.put('/api/items/:id', requireAuth, requireActiveSubscription, (req, res) => {
  const existing = db.prepare('SELECT * FROM items WHERE id = ? AND store_id = ?').get(req.params.id, req.auth.storeId);
  if (!existing) return res.status(404).json({ error: 'Item not found.' });

  const error = validatePayload(req.body);
  if (error) return res.status(400).json({ error });

  const { upc, name, expirationDate, quantity, unit, location, categoryId, sizeValue, sizeUnit, costPrice, sellingPrice, datePurchased, vendor } = req.body;
  db.prepare(`
    UPDATE items
    SET upc = ?, name = ?, expiration_date = ?, quantity = ?, unit = ?, location = ?, category_id = ?, size_value = ?, size_unit = ?, cost_price = ?, selling_price = ?, date_purchased = ?, vendor = ?
    WHERE id = ? AND store_id = ?
  `).run(
    upc.trim(), name.trim(), expirationDate, quantity, unit.trim(), location.trim(),
    categoryId || null, (sizeValue === '' || sizeValue === undefined) ? null : sizeValue, sizeUnit || null,
    (costPrice === '' || costPrice === undefined) ? null : costPrice, (sellingPrice === '' || sellingPrice === undefined) ? null : sellingPrice,
    (datePurchased === '' || datePurchased === undefined) ? null : datePurchased,
    (vendor === '' || vendor === undefined) ? null : String(vendor).trim(),
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
    INSERT INTO removals (id, store_id, item_name, category_id, quantity, unit, cost_price, selling_price, expiration_date, reason, was_expired, removed_by, removed_at, vendor)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    newId(), req.auth.storeId, existing.name, existing.category_id, existing.quantity, existing.unit,
    existing.cost_price, existing.selling_price, existing.expiration_date, reason, wasExpired ? 1 : 0,
    currentUsername(req), nowIso(), existing.vendor || null
  );

  logAudit(req.auth.storeId, currentUsername(req), 'item_removed', `Removed "${existing.name}" (${existing.quantity} ${existing.unit}) from ${existing.location} \u2014 ${reason}`);
  res.status(204).end();
});

// =====================================================================
// BULK SCAN QUEUE (scan fast now, fill in details later — pending items
// never count toward inventory totals until completed into a real item)
// =====================================================================

function rowToPendingItem(row) {
  return {
    id: row.id,
    upc: row.upc,
    name: row.name || null,
    sizeValue: row.size_value === null || row.size_value === undefined ? null : row.size_value,
    sizeUnit: row.size_unit || null,
    scannedBy: row.scanned_by || null,
    scannedAt: row.scanned_at,
    costPrice: row.cost_price === null || row.cost_price === undefined ? null : row.cost_price,
    vendor: row.vendor || null,
    defaultQuantity: row.default_quantity === null || row.default_quantity === undefined ? null : row.default_quantity,
    suggestedExpirationDate: row.suggested_expiration_date || null,
  };
}

app.get('/api/pending-items', requireAuth, requireActiveSubscription, (req, res) => {
  const rows = db.prepare('SELECT * FROM pending_items WHERE store_id = ? ORDER BY scanned_at DESC').all(req.auth.storeId);
  res.json(rows.map(rowToPendingItem));
});

app.post('/api/pending-items', requireAuth, requireActiveSubscription, async (req, res) => {
  const upc = String((req.body && req.body.upc) || '').trim();
  if (!upc) return res.status(400).json({ error: 'UPC is required.' });

  const lookup = await performUpcLookup(upc);
  const id = newId();
  db.prepare(`
    INSERT INTO pending_items (id, store_id, upc, name, size_value, size_unit, scanned_by, scanned_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, req.auth.storeId, upc, lookup.found ? lookup.name : null,
    lookup.found ? (lookup.sizeValue ?? null) : null, lookup.found ? (lookup.sizeUnit || null) : null,
    currentUsername(req), nowIso()
  );

  const row = db.prepare('SELECT * FROM pending_items WHERE id = ?').get(id);
  res.status(201).json(rowToPendingItem(row));
});

app.delete('/api/pending-items/:id', requireAuth, requireActiveSubscription, (req, res) => {
  const existing = db.prepare('SELECT * FROM pending_items WHERE id = ? AND store_id = ?').get(req.params.id, req.auth.storeId);
  if (!existing) return res.status(404).json({ error: 'Pending scan not found.' });
  db.prepare('DELETE FROM pending_items WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// Fill in the missing required details and turn a pending scan into a real
// item. Uses the exact same validation as a normal add.
app.post('/api/pending-items/:id/complete', requireAuth, requireActiveSubscription, (req, res) => {
  const pending = db.prepare('SELECT * FROM pending_items WHERE id = ? AND store_id = ?').get(req.params.id, req.auth.storeId);
  if (!pending) return res.status(404).json({ error: 'Pending scan not found.' });

  const error = validatePayload(req.body);
  if (error) return res.status(400).json({ error });

  const { upc, name, expirationDate, quantity, unit, location, categoryId, sizeValue, sizeUnit, costPrice, sellingPrice, datePurchased, vendor } = req.body;
  const id = newId();
  const dateAdded = nowIso();

  db.prepare(`
    INSERT INTO items (id, store_id, upc, name, expiration_date, quantity, unit, location, date_added, category_id, size_value, size_unit, cost_price, selling_price, date_purchased, vendor)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, req.auth.storeId, upc.trim(), name.trim(), expirationDate, quantity, unit.trim(), location.trim(), dateAdded,
    categoryId || null, (sizeValue === '' || sizeValue === undefined) ? null : sizeValue, sizeUnit || null,
    (costPrice === '' || costPrice === undefined) ? null : costPrice, (sellingPrice === '' || sellingPrice === undefined) ? null : sellingPrice,
    (datePurchased === '' || datePurchased === undefined) ? null : datePurchased,
    (vendor === '' || vendor === undefined) ? null : String(vendor).trim()
  );
  db.prepare('DELETE FROM pending_items WHERE id = ?').run(pending.id);

  logAudit(req.auth.storeId, currentUsername(req), 'item_added', `Added ${quantity} ${unit.trim()} of "${name.trim()}" at ${location.trim()} (from bulk scan)`);

  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  res.status(201).json(rowToItem(row));
});

// =====================================================================
// INVOICE / RECEIPT IMPORT (optional — needs ANTHROPIC_API_KEY)
// Reads a photographed or scanned vendor invoice, extracts line items, and
// queues each as a pending item for manual review — same as bulk scan.
// Never creates real inventory directly from AI-extracted data.
// =====================================================================

async function extractInvoiceLineItems(base64Data, mediaType) {
  const isPdf = mediaType === 'application/pdf';
  const contentBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Data } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } };

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 3000,
      messages: [{
        role: 'user',
        content: [
          contentBlock,
          {
            type: 'text',
              text: 'This is a vendor invoice or receipt for a convenience store. Extract every product line item. ' +
              'Respond with ONLY a JSON object, no other text, no markdown fences, in exactly this shape: ' +
              '{"vendor": "string or null", "lineItems": [{"name": "string", "quantity": number or null, "unitCost": number or null, "expirationDate": "YYYY-MM-DD or null"}]}. ' +
              'Do not include tax, subtotal, total, discount, or shipping lines as line items. ' +
              'If the vendor name isn\u2019t clearly printed, use null rather than guessing. ' +
              'Most invoices do NOT print expiration dates \u2014 leave expirationDate as null unless one is actually ' +
              'printed for that specific line (e.g. a "best by", "exp", or "sell by" date/code next to the item). ' +
              'Never calculate or estimate an expiration date yourself from a pack date, order date, or typical shelf ' +
              'life \u2014 only report a date if it is literally printed on the invoice for that item.\n\n' +
              'Many lines describe a pack or case size in the product name or a separate column (e.g. "50PK", "24CT", ' +
              '"CS/12", "box of 50", "case of 24"). When you see this, quantity and unitCost must both describe a ' +
              'single individual sellable unit, NOT the box/case/pack as a whole:\n' +
              '- quantity = the total number of individual units received (pack size \u00d7 number of packs/cases ordered).\n' +
              '- unitCost = the line\u2019s total cost \u00f7 that same total individual-unit count.\n' +
              'Example: a line reading "Snickers 50PK, Qty: 2, Total: $50.00" is 2 boxes of 50 bars = 100 bars total, ' +
              'at $50.00 \u00f7 100 = $0.50 per bar \u2014 report quantity: 100, unitCost: 0.50. Do NOT report unitCost as the ' +
              'price of an entire box or case; that would badly overstate the cost of one item. If a line has no ' +
              'visible pack/case size, treat the ordered quantity as already being individual units.',
          },
        ],
      }],
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Claude API error (${response.status}): ${body.slice(0, 200)}`);
  }
  const data = await response.json();
  const textBlock = (data.content || []).find(b => b.type === 'text');
  if (!textBlock) throw new Error('No response from Claude.');
  const cleaned = textBlock.text.replace(/```json|```/g, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error('Couldn\u2019t parse a response from Claude \u2014 try a clearer photo.');
  }
  return parsed;
}

app.get('/api/invoices/status', requireAuth, (req, res) => {
  res.json({ enabled: !!ANTHROPIC_API_KEY });
});

app.post('/api/invoices/import', requireManager, async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(400).json({ error: 'Invoice import isn\u2019t configured on the server yet (missing ANTHROPIC_API_KEY).' });
  const { image, mediaType } = req.body || {};
  if (!image || !mediaType) return res.status(400).json({ error: 'No file received.' });
  if (!/^image\/(jpeg|png|webp|gif)$|^application\/pdf$/.test(mediaType)) {
    return res.status(400).json({ error: 'Upload a JPEG, PNG, WEBP, or PDF file.' });
  }

  let extracted;
  try {
    extracted = await extractInvoiceLineItems(image, mediaType);
  } catch (e) {
    return res.status(502).json({ error: `Couldn\u2019t read that invoice: ${e.message}` });
  }

  const lineItems = Array.isArray(extracted.lineItems) ? extracted.lineItems : [];
  if (lineItems.length === 0) return res.status(400).json({ error: 'No line items were found on that invoice \u2014 try a clearer photo or a different file.' });
  if (lineItems.length > 200) return res.status(400).json({ error: 'That\u2019s a lot of line items to extract at once \u2014 try splitting the invoice into smaller uploads.' });

  const vendor = extracted.vendor ? String(extracted.vendor).trim().slice(0, 200) : null;
  const insertPending = db.prepare(`
    INSERT INTO pending_items (id, store_id, upc, name, size_value, size_unit, scanned_by, scanned_at, cost_price, vendor, default_quantity, suggested_expiration_date)
    VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)
  `);

  // Validated defensively since this comes from an AI extraction, not a
  // person: must be a real, plausible calendar date reasonably close to
  // today (an invoice line shouldn't be printing a date from 1990 or 2090)
  // before it's trusted enough to pre-fill anywhere.
  function validPrintedExpirationDate(raw) {
    if (!raw || typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
    const d = new Date(raw + 'T00:00:00Z');
    if (Number.isNaN(d.getTime())) return null;
    const now = Date.now();
    const tenYearsMs = 10 * 365 * 24 * 60 * 60 * 1000;
    if (d.getTime() < now - tenYearsMs || d.getTime() > now + tenYearsMs) return null;
    return raw;
  }

  const created = [];
  for (const li of lineItems) {
    const name = li && li.name ? String(li.name).trim().slice(0, 300) : null;
    if (!name) continue;
    const quantity = Number(li.quantity);
    const unitCost = Number(li.unitCost);
    const suggestedExpirationDate = validPrintedExpirationDate(li.expirationDate);
    const id = newId();
    const placeholderUpc = `NOUPC-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    insertPending.run(
      id, req.auth.storeId, placeholderUpc, name,
      currentUsername(req), nowIso(),
      Number.isFinite(unitCost) && unitCost >= 0 ? unitCost : null,
      vendor,
      Number.isFinite(quantity) && quantity >= 0 ? quantity : null,
      suggestedExpirationDate
    );
    created.push(rowToPendingItem(db.prepare('SELECT * FROM pending_items WHERE id = ?').get(id)));
  }

  logAudit(req.auth.storeId, currentUsername(req), 'invoice_imported', `Imported ${created.length} line item${created.length !== 1 ? 's' : ''} from an invoice${vendor ? ` (${vendor})` : ''} \u2014 pending review`);
  res.json({ imported: created.length, vendor, items: created });
});

// =====================================================================
// SHRINK REPORT (manager only) — what got saved vs. lost, from removal history
// =====================================================================

function calcShrinkForStore(storeId, sinceIso) {
  const removalRows = db.prepare('SELECT * FROM removals WHERE store_id = ? AND removed_at >= ?').all(storeId, sinceIso);
  const saleRows = db.prepare('SELECT * FROM sales WHERE store_id = ? AND sold_at >= ?').all(storeId, sinceIso);

  let lostCost = 0, savedRevenue = 0, savedCost = 0;
  for (const r of removalRows) {
    const qty = r.quantity || 0;
    if (r.reason === 'expired' || (r.reason === 'other' && r.was_expired)) {
      lostCost += (r.cost_price || 0) * qty;
    } else if (r.reason === 'sold') {
      savedRevenue += (r.selling_price || 0) * qty;
      savedCost += (r.cost_price || 0) * qty;
    }
  }
  for (const s of saleRows) {
    const qty = s.quantity || 0;
    savedRevenue += (s.selling_price || 0) * qty;
    savedCost += (s.cost_price || 0) * qty;
  }
  return { lostCost, savedRevenue, savedCost };
}

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

// Waste (lost-to-expiration) broken down by category, employee, vendor,
// product, and month — the "where is shrink actually coming from" view.
app.get('/api/reports/analytics', requireManager, (req, res) => {
  const days = Number(req.query.days) || 90;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const wasteRows = db.prepare(`
    SELECT * FROM removals
    WHERE store_id = ? AND removed_at >= ? AND (reason = 'expired' OR (reason = 'other' AND was_expired = 1))
  `).all(req.auth.storeId, since);

  const categories = new Map(db.prepare('SELECT id, name FROM categories WHERE store_id = ?').all(req.auth.storeId).map(c => [c.id, c.name]));

  function groupBy(rows, keyFn, labelFn) {
    const map = new Map();
    for (const r of rows) {
      const key = keyFn(r);
      const label = labelFn(r, key);
      if (!map.has(key)) map.set(key, { label, lostCost: 0, count: 0 });
      const bucket = map.get(key);
      bucket.lostCost += (r.cost_price || 0) * (r.quantity || 0);
      bucket.count += 1;
    }
    return Array.from(map.values())
      .map(b => ({ label: b.label, lostCost: Math.round(b.lostCost * 100) / 100, count: b.count }))
      .sort((a, b) => b.lostCost - a.lostCost);
  }

  const byCategory = groupBy(wasteRows, r => r.category_id || 'none', r => r.category_id ? (categories.get(r.category_id) || 'Unknown category') : 'No category');
  const byEmployee = groupBy(wasteRows, r => r.removed_by || 'unknown', r => r.removed_by || 'Unknown');
  const byVendor = groupBy(wasteRows, r => r.vendor || 'none', r => r.vendor || 'No vendor on file');
  const byProduct = groupBy(wasteRows, r => r.item_name, r => r.item_name).slice(0, 15);
  const byMonth = groupBy(wasteRows, r => r.removed_at.slice(0, 7), r => {
    const [y, m] = r.removed_at.slice(0, 7).split('-');
    return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  }).sort((a, b) => a.label.localeCompare(b.label)); // chronological, not by cost, for the month view

  const totalLostCost = wasteRows.reduce((sum, r) => sum + (r.cost_price || 0) * (r.quantity || 0), 0);

  res.json({
    days,
    totalLostCost: Math.round(totalLostCost * 100) / 100,
    totalCount: wasteRows.length,
    byCategory, byEmployee, byVendor, byProduct, byMonth,
  });
});

// Vendor performance: unlike the "By vendor" waste breakdown above (which
// only shows raw dollars lost), this computes an actual waste RATE per
// vendor — wasted units divided by total units moved (sold + wasted) — so a
// high-volume vendor doesn't look artificially worse than a low-volume one
// just because they supply more product. This is the number that actually
// informs "should I keep ordering from this vendor."
app.get('/api/reports/vendor-performance', requireManager, (req, res) => {
  const days = Number(req.query.days) || 90;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const wasteRows = db.prepare(`
    SELECT * FROM removals
    WHERE store_id = ? AND removed_at >= ? AND (reason = 'expired' OR (reason = 'other' AND was_expired = 1))
  `).all(req.auth.storeId, since);
  const soldRemovalRows = db.prepare(`
    SELECT * FROM removals WHERE store_id = ? AND removed_at >= ? AND reason = 'sold'
  `).all(req.auth.storeId, since);
  const salesRows = db.prepare('SELECT * FROM sales WHERE store_id = ? AND sold_at >= ?').all(req.auth.storeId, since);

  const vendorMap = new Map();
  function bucket(vendor) {
    const key = vendor && String(vendor).trim() ? String(vendor).trim() : 'No vendor on file';
    if (!vendorMap.has(key)) vendorMap.set(key, { vendor: key, soldUnits: 0, soldValue: 0, wastedUnits: 0, wastedValue: 0 });
    return vendorMap.get(key);
  }

  for (const r of soldRemovalRows) {
    const b = bucket(r.vendor);
    b.soldUnits += r.quantity || 0;
    b.soldValue += (r.selling_price || 0) * (r.quantity || 0);
  }
  for (const s of salesRows) {
    const b = bucket(s.vendor);
    b.soldUnits += s.quantity || 0;
    b.soldValue += (s.selling_price || 0) * (s.quantity || 0);
  }
  for (const r of wasteRows) {
    const b = bucket(r.vendor);
    b.wastedUnits += r.quantity || 0;
    b.wastedValue += (r.cost_price || 0) * (r.quantity || 0);
  }

  const vendors = Array.from(vendorMap.values())
    .map(v => {
      const totalUnits = v.soldUnits + v.wastedUnits;
      return {
        vendor: v.vendor,
        soldUnits: Math.round(v.soldUnits * 100) / 100,
        soldValue: Math.round(v.soldValue * 100) / 100,
        wastedUnits: Math.round(v.wastedUnits * 100) / 100,
        wastedValue: Math.round(v.wastedValue * 100) / 100,
        totalUnits: Math.round(totalUnits * 100) / 100,
        wasteRatePct: totalUnits > 0 ? Math.round((v.wastedUnits / totalUnits) * 1000) / 10 : 0,
      };
    })
    .filter(v => v.totalUnits > 0)
    .sort((a, b) => b.wasteRatePct - a.wasteRatePct);

  res.json({ days, vendors });
});

// Cross-location view: totals across every store in the manager's
// organization, plus a per-location breakdown, so a multi-store manager
// doesn't have to switch locations one at a time just to see the big picture.
app.get('/api/org/dashboard', requireManager, (req, res) => {
  const stores = db.prepare('SELECT * FROM stores WHERE organization_id = ? ORDER BY created_at ASC').all(req.auth.organizationId);
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  let totalItems = 0, totalExpired = 0, totalCritical = 0, totalSoon = 0, totalValue = 0;
  let totalLostCost = 0, totalSavedRevenue = 0, totalSavedCost = 0;
  const org = db.prepare('SELECT critical_days, soon_days FROM organizations WHERE id = ?').get(req.auth.organizationId);
  const criticalDays = org ? org.critical_days : 3;
  const soonDays = org ? org.soon_days : 60;

  const locations = stores.map(store => {
    const items = db.prepare('SELECT * FROM items WHERE store_id = ?').all(store.id);
    let expired = 0, critical = 0, soon = 0, value = 0;
    for (const it of items) {
      const u = urgencyOf(it.expiration_date, criticalDays, soonDays);
      if (u === 'expired') expired++;
      else if (u === 'critical') critical++;
      else if (u === 'soon') soon++;
      if (it.cost_price) value += it.cost_price * it.quantity;
    }
    const shrink = calcShrinkForStore(store.id, since);
    totalItems += items.length;
    totalExpired += expired; totalCritical += critical; totalSoon += soon; totalValue += value;
    totalLostCost += shrink.lostCost; totalSavedRevenue += shrink.savedRevenue; totalSavedCost += shrink.savedCost;
    return {
      id: store.id, name: store.name,
      itemCount: items.length, expired, critical, soon,
      value: Math.round(value * 100) / 100,
    };
  });

  res.json({
    locationCount: stores.length,
    totalItems, totalExpired, totalCritical, totalSoon,
    totalValue: Math.round(totalValue * 100) / 100,
    shrink30d: {
      lostCost: Math.round(totalLostCost * 100) / 100,
      savedRevenue: Math.round(totalSavedRevenue * 100) / 100,
      savedProfit: Math.round((totalSavedRevenue - totalSavedCost) * 100) / 100,
    },
    locations,
  });
});

// Store-to-store transfer suggestions: an item expiring soon at one
// location, where a sibling location in the same org has little or none of
// that same product on hand, is worth physically moving rather than losing
// entirely at one store while the other reorders more of it. This only
// matches on UPC (exact product identity) — matching by name would risk
// false matches between similarly-named but different products.
//
// This is informational only, not an executed transfer: it doesn't move
// any inventory records between stores. Actually relocating stock still
// happens outside the app (a phone call, a driver) — this just tells you
// where it's worth doing that.
app.get('/api/org/transfer-suggestions', requireManager, (req, res) => {
  const stores = db.prepare('SELECT * FROM stores WHERE organization_id = ? ORDER BY created_at ASC').all(req.auth.organizationId);
  if (stores.length < 2) return res.json({ suggestions: [] }); // nothing to transfer between with a single location

  const org = db.prepare('SELECT critical_days, soon_days FROM organizations WHERE id = ?').get(req.auth.organizationId);
  const criticalDays = org ? org.critical_days : 3;
  const soonDays = org ? org.soon_days : 60;

  // storeId -> upc -> { totalQuantity, name, soonestExpiration, costPrice }
  const byStoreUpc = new Map();
  for (const store of stores) {
    const items = db.prepare("SELECT * FROM items WHERE store_id = ? AND upc IS NOT NULL AND upc != ''").all(store.id);
    const upcMap = new Map();
    for (const it of items) {
      if (!upcMap.has(it.upc)) {
        upcMap.set(it.upc, { totalQuantity: 0, name: it.name, soonestExpiration: it.expiration_date, costPrice: it.cost_price });
      }
      const bucket = upcMap.get(it.upc);
      bucket.totalQuantity += it.quantity || 0;
      if (it.expiration_date < bucket.soonestExpiration) bucket.soonestExpiration = it.expiration_date;
    }
    byStoreUpc.set(store.id, upcMap);
  }

  const LOW_STOCK_THRESHOLD = 2; // a sibling store at or below this many units is worth topping up
  const suggestions = [];
  for (const fromStore of stores) {
    const fromMap = byStoreUpc.get(fromStore.id);
    for (const [upc, info] of fromMap.entries()) {
      const urgency = urgencyOf(info.soonestExpiration, criticalDays, soonDays);
      if (urgency !== 'critical' && urgency !== 'soon') continue;
      if (info.totalQuantity <= 0) continue;

      // Find the sibling store that needs this product most (lowest stock).
      let bestTo = null;
      for (const toStore of stores) {
        if (toStore.id === fromStore.id) continue;
        const toInfo = byStoreUpc.get(toStore.id).get(upc);
        const toQuantity = toInfo ? toInfo.totalQuantity : 0;
        if (!bestTo || toQuantity < bestTo.toQuantity) bestTo = { store: toStore, toQuantity };
      }
      if (!bestTo || bestTo.toQuantity > LOW_STOCK_THRESHOLD) continue;

      suggestions.push({
        upc,
        productName: info.name,
        fromStore: { id: fromStore.id, name: fromStore.name },
        toStore: { id: bestTo.store.id, name: bestTo.store.name },
        fromQuantity: info.totalQuantity,
        toQuantity: bestTo.toQuantity,
        expirationDate: info.soonestExpiration,
        urgency,
        value: Math.round((info.costPrice || 0) * info.totalQuantity * 100) / 100,
      });
    }
  }

  suggestions.sort((a, b) => a.expirationDate.localeCompare(b.expirationDate));
  res.json({ suggestions: suggestions.slice(0, 20) });
});

// =====================================================================
// DAILY EXPIRATION DIGEST EMAIL
// =====================================================================

function daysUntil(dateStr) {
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const target = new Date(dateStr + 'T00:00:00Z');
  return Math.round((target - today) / 86400000);
}
function urgencyOf(dateStr, criticalDays, soonDays) {
  const critical = Number.isFinite(criticalDays) ? criticalDays : 3;
  const soon = Number.isFinite(soonDays) ? soonDays : 60;
  const d = daysUntil(dateStr);
  if (d < 0) return 'expired';
  if (d <= critical) return 'critical';
  if (d <= soon) return 'soon';
  return 'ok';
}

function getAlertItemsForStore(storeId) {
  const rows = db.prepare('SELECT * FROM items WHERE store_id = ? ORDER BY expiration_date ASC').all(storeId);
  const store = db.prepare('SELECT organization_id FROM stores WHERE id = ?').get(storeId);
  const org = store ? db.prepare('SELECT critical_days, soon_days FROM organizations WHERE id = ?').get(store.organization_id) : null;
  const criticalDays = org ? org.critical_days : 3;
  const soonDays = org ? org.soon_days : 60;
  return rows.filter(r => ['expired', 'critical', 'soon'].includes(urgencyOf(r.expiration_date, criticalDays, soonDays)));
}

function buildDigestHtml(store, alertItems, criticalDays, soonDays) {
  const rowsHtml = alertItems.map(it => {
    const u = urgencyOf(it.expiration_date, criticalDays, soonDays);
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

// ---------- push notifications ----------
// Sends to every device the given user has registered. badge (optional) sets
// the app icon's number badge on iOS — pass the person's open-task count (or
// omit it to leave the badge untouched). data (optional) is delivered to the
// app for deep-linking (e.g. { screen: 'task', taskId }). `type` maps to
// one of the notify_* preference columns on users — pass null/omit for a
// notification that should never be gated by preference (e.g. the manual
// "send me a test" button).
const NOTIFY_TYPE_COLUMN = {
  taskAssigned: 'notify_task_assigned',
  taskOverdue: 'notify_task_overdue',
  expiredItems: 'notify_expired_items',
  rescueItems: 'notify_rescue_items',
  trialEnding: 'notify_trial_ending',
};

async function sendPushToUser(userId, title, body, { badge, data, type } = {}) {
  // TEMPORARY logging — visible in Render's Logs tab — to trace exactly
  // what happens on every push attempt, since this function is called
  // fire-and-forget everywhere (.catch(() => {})), meaning failures here
  // were previously completely invisible with no trace anywhere. Safe to
  // remove once scheduled pushes are confirmed reaching devices reliably.
  const logPrefix = `[push] user=${userId} title="${title}"`;

  if (!ONESIGNAL_APP_ID || !ONESIGNAL_REST_API_KEY) {
    console.log(`${logPrefix} NOT SENT: OneSignal not configured`);
    return { sent: false, reason: 'not configured' };
  }

  if (type) {
    const col = NOTIFY_TYPE_COLUMN[type];
    if (col) {
      const user = db.prepare(`SELECT ${col} as pref FROM users WHERE id = ?`).get(userId);
      if (user && user.pref === 0) {
        console.log(`${logPrefix} NOT SENT: person has "${type}" notifications turned off`);
        return { sent: false, reason: `person has "${type}" notifications turned off` };
      }
    }
  }

  const playerIds = db.prepare('SELECT onesignal_player_id FROM push_tokens WHERE user_id = ? AND onesignal_player_id IS NOT NULL')
    .all(userId).map(r => r.onesignal_player_id);
  if (playerIds.length === 0) {
    console.log(`${logPrefix} NOT SENT: no registered devices for this user`);
    return { sent: false, reason: 'no registered devices' };
  }

  try {
    const payload = {
      app_id: ONESIGNAL_APP_ID,
      include_player_ids: playerIds,
      headings: { en: title },
      contents: { en: body },
    };
    if (Number.isFinite(badge)) { payload.ios_badgeType = 'SetTo'; payload.ios_badgeCount = badge; }
    if (data) payload.data = data;

    const response = await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${ONESIGNAL_REST_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      console.log(`${logPrefix} NOT SENT: push API error ${response.status} ${errBody}`);
      return { sent: false, reason: `push API error: ${response.status} ${errBody}` };
    }
    const resultBody = await response.json().catch(() => null);
    console.log(`${logPrefix} raw OneSignal response: ${JSON.stringify(resultBody)}`); // TEMPORARY — remove once delivery is confirmed reliable
    // A 2xx from OneSignal only means the REQUEST was well-formed — it does
    // NOT mean the push actually reached a device. The reliable signal
    // turns out to be a genuine `id` with no `errors` array — OneSignal
    // doesn't always include a `recipients` count in this immediate
    // response when targeting specific player ids directly (as opposed to
    // a broader segment/filter), even on a fully successful send, so
    // requiring recipients > 0 here was rejecting real successes.
    if (resultBody && Array.isArray(resultBody.errors) && resultBody.errors.length > 0) {
      console.log(`${logPrefix} NOT SENT: OneSignal returned errors: ${JSON.stringify(resultBody.errors)}`);
      return { sent: false, reason: `OneSignal error: ${JSON.stringify(resultBody.errors)}` };
    }
    if (!resultBody || !resultBody.id) {
      console.log(`${logPrefix} NOT SENT: no notification id in response (body=${JSON.stringify(resultBody)})`);
      return { sent: false, reason: `OneSignal accepted the request but returned no notification id (body=${JSON.stringify(resultBody)})` };
    }
    console.log(`${logPrefix} SENT \u2014 id=${resultBody.id} recipients=${resultBody.recipients}`);
    return { sent: true, recipients: resultBody.recipients };
  } catch (e) {
    console.log(`${logPrefix} NOT SENT: exception ${e.message}`);
    return { sent: false, reason: e.message };
  }
}

// For scheduled (non-instant) pushes only — an instant push like "task
// assigned to you" should always fire, but a hookup that re-checks every
// hour (overdue tasks, overnight-expired items) needs to dedupe so the
// person isn't renotified every single hour the condition stays true.
//
// Split into a pure read-check and a separate mark-as-sent, called only
// after confirming sendPushToUser() actually succeeded. Previously this
// was a single function that locked in "sent today" the moment a send was
// merely attempted — so a failure early in the day (e.g. the device
// wasn't registered yet) would permanently block every retry for the rest
// of that day, even after the underlying problem got fixed an hour later.
function wasPushSentToday(dedupKey) {
  const today = todayUtcDateStr();
  return !!db.prepare('SELECT 1 FROM push_notify_log WHERE dedup_key = ?').get(`${dedupKey}:${today}`);
}
function markPushSentToday(dedupKey) {
  const today = todayUtcDateStr();
  db.prepare('INSERT OR IGNORE INTO push_notify_log (dedup_key, sent_at) VALUES (?, ?)').run(`${dedupKey}:${today}`, nowIso());
}

// Registers this device's raw APNs token with OneSignal server-side (via
// their REST "Add a Device" endpoint) and returns the OneSignal-assigned
// player ID that pushes actually get sent to. Doing this server-side means
// the app never needs OneSignal's own client SDK installed — only
// Capacitor's push-notifications plugin, which is what actually talks to
// Apple and gets the raw token in the first place.
async function registerDeviceWithOneSignal(rawToken) {
  if (!ONESIGNAL_APP_ID || !ONESIGNAL_REST_API_KEY) {
    console.log('[push] registerDeviceWithOneSignal: OneSignal not configured');
    return null;
  }
  try {
    const response = await fetch('https://onesignal.com/api/v1/players', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${ONESIGNAL_REST_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: ONESIGNAL_APP_ID,
        device_type: 0, // 0 = iOS (APNs)
        identifier: rawToken,
      }),
    });
    const bodyText = await response.text();
    if (!response.ok) {
      console.log(`[push] registerDeviceWithOneSignal FAILED: ${response.status} ${bodyText}`);
      return null;
    }
    let body;
    try { body = JSON.parse(bodyText); } catch (e) {
      console.log(`[push] registerDeviceWithOneSignal: response wasn't valid JSON: ${bodyText}`);
      return null;
    }
    if (!body || !body.id) {
      console.log(`[push] registerDeviceWithOneSignal: OneSignal accepted the request but returned no player id: ${bodyText}`);
      return null;
    }
    console.log(`[push] registerDeviceWithOneSignal succeeded, playerId=${body.id}`);
    return body.id;
  } catch (e) {
    console.log(`[push] registerDeviceWithOneSignal EXCEPTION: ${e.message}`);
    return null;
  }
}

app.post('/api/push/register', requireAuth, async (req, res) => {
  const { token, platform } = req.body || {};
  if (!token || !String(token).trim()) return res.status(400).json({ error: 'A device token is required.' });

  const onesignalPlayerId = await registerDeviceWithOneSignal(token.trim());
  console.log(`[push] /api/push/register user=${req.auth.userId} onesignalPlayerId=${onesignalPlayerId || 'NULL \u2014 device will NOT receive pushes'}`);

  db.prepare(`
    INSERT INTO push_tokens (token, user_id, store_id, platform, created_at, onesignal_player_id) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, store_id = excluded.store_id, platform = excluded.platform, onesignal_player_id = excluded.onesignal_player_id
  `).run(token.trim(), req.auth.userId, req.auth.storeId, platform || null, nowIso(), onesignalPlayerId);

  // A fresh reinstall typically produces a brand-new raw APNs token, which
  // otherwise just accumulates as a SEPARATE row here alongside old ones
  // from previous installs — meaning a send later hands OneSignal a mixed
  // list of the current valid token plus every dead one from past installs
  // in the same request. Clean out anything else for this person, keeping
  // only the token that was just confirmed.
  const staleRemoved = db.prepare('DELETE FROM push_tokens WHERE user_id = ? AND token != ?').run(req.auth.userId, token.trim());
  if (staleRemoved.changes > 0) console.log(`[push] removed ${staleRemoved.changes} stale token(s) for user=${req.auth.userId}`);

  res.status(201).json({ registered: true, oneSignalConnected: !!onesignalPlayerId });
});

app.post('/api/push/unregister', requireAuth, (req, res) => {
  const { token } = req.body || {};
  if (token) db.prepare('DELETE FROM push_tokens WHERE token = ? AND user_id = ?').run(token, req.auth.userId);
  res.status(204).end();
});

app.get('/api/notification-preferences', requireAuth, (req, res) => {
  const user = db.prepare(`
    SELECT notify_task_assigned, notify_task_overdue, notify_expired_items, notify_rescue_items, notify_trial_ending, clear_push_on_logout
    FROM users WHERE id = ?
  `).get(req.auth.userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json({
    taskAssigned: !!user.notify_task_assigned,
    taskOverdue: !!user.notify_task_overdue,
    expiredItems: !!user.notify_expired_items,
    rescueItems: !!user.notify_rescue_items,
    trialEnding: !!user.notify_trial_ending,
    clearPushOnLogout: !!user.clear_push_on_logout,
  });
});

app.put('/api/notification-preferences', requireAuth, (req, res) => {
  const body = req.body || {};
  const updates = [];
  const values = [];
  for (const [key, col] of Object.entries(NOTIFY_TYPE_COLUMN)) {
    if (key in body) {
      updates.push(`${col} = ?`);
      values.push(body[key] ? 1 : 0);
    }
  }
  if ('clearPushOnLogout' in body) {
    updates.push('clear_push_on_logout = ?');
    values.push(body.clearPushOnLogout ? 1 : 0);
  }
  if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update.' });
  values.push(req.auth.userId);
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  res.status(204).end();
});

async function sendDigestEmail(store, toEmail, alertItems) {
  const org = db.prepare('SELECT critical_days, soon_days FROM organizations WHERE id = ?').get(store.organization_id);
  return sendEmail({
    to: toEmail,
    subject: `FloorStock: ${alertItems.length} item${alertItems.length !== 1 ? 's' : ''} need attention at ${store.name}`,
    html: buildDigestHtml(store, alertItems, org && org.critical_days, org && org.soon_days),
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

// Urgency labels (Critical / Soon / Fresh) are subjective per business, so the
// day thresholds are configurable per organization instead of hardcoded.
app.get('/api/org/urgency-thresholds', requireAuth, (req, res) => {
  const org = db.prepare('SELECT critical_days, soon_days FROM organizations WHERE id = ?').get(req.auth.organizationId);
  res.json({ criticalDays: (org && org.critical_days) || 3, soonDays: (org && org.soon_days) || 60 });
});

app.put('/api/org/urgency-thresholds', requireManager, (req, res) => {
  const criticalDays = Number(req.body && req.body.criticalDays);
  const soonDays = Number(req.body && req.body.soonDays);
  if (!Number.isFinite(criticalDays) || criticalDays < 0 || criticalDays > 365) {
    return res.status(400).json({ error: 'Critical threshold must be between 0 and 365 days.' });
  }
  if (!Number.isFinite(soonDays) || soonDays <= criticalDays || soonDays > 730) {
    return res.status(400).json({ error: 'Soon threshold must be greater than the critical threshold, up to 730 days.' });
  }
  db.prepare('UPDATE organizations SET critical_days = ?, soon_days = ? WHERE id = ?').run(criticalDays, soonDays, req.auth.organizationId);
  res.json({ criticalDays, soonDays });
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

    const manager = db.prepare("SELECT * FROM users WHERE organization_id = ? AND role = 'manager' LIMIT 1").get(store.organization_id);
    const alertItems = getAlertItemsForStore(store.id);
    const willSend = !!(manager && manager.email && alertItems.length > 0);
    db.prepare('INSERT OR IGNORE INTO digest_log (store_id, sent_date, created_at, emailed) VALUES (?, ?, ?, ?)').run(store.id, today, nowIso(), willSend ? 1 : 0);
    if (willSend) sendDigestEmail(store, manager.email, alertItems).catch(() => {});
  }
}
// Called once immediately at startup (not just on the interval) — Render
// restarts the server process on every deploy, which was resetting this
// hourly timer back to a full hour away each time. On an actively-developed
// app deployed many times a day, that could mean these checks effectively
// never got a chance to run. All four have their own internal gating
// (specific-hour checks and/or per-store, date-scoped dedup), so calling
// them immediately is safe and won't cause duplicate sends.
runDigestCheckIfDue();
setInterval(runDigestCheckIfDue, 60 * 60 * 1000); // hourly check

// ---------- scheduled push notifications ----------

// Overdue tasks: checked hourly (unlike the once-a-day digest) so a task
// due at 2pm gets flagged that afternoon, not the next morning. Dedup is
// still day-scoped, so a task stuck overdue for a week only pings once per
// day, not every hour.
function runOverdueTaskPushCheck() {
  if (!ONESIGNAL_APP_ID || !ONESIGNAL_REST_API_KEY) return;
  const nowIsoStr = new Date().toISOString();
  const overdue = db.prepare(`
    SELECT * FROM tasks WHERE status = 'open' AND due_at IS NOT NULL AND due_at < ?
  `).all(nowIsoStr.slice(0, 19));
  console.log(`[push] runOverdueTaskPushCheck found ${overdue.length} overdue task(s)`);
  for (const task of overdue) {
    const dedupKey = `overdue-task:${task.id}`;
    const alreadySent = wasPushSentToday(dedupKey);
    console.log(`[push] task=${task.id} "${task.title}" assignedTo=${task.assigned_to} alreadySentToday=${alreadySent}`);
    if (alreadySent) continue;
    sendPushToUser(task.assigned_to, 'Task overdue', task.title, { type: 'taskOverdue' })
      .then(result => { if (result.sent) markPushSentToday(dedupKey); })
      .catch(() => {});
  }
}
runOverdueTaskPushCheck();
setInterval(runOverdueTaskPushCheck, 60 * 60 * 1000); // hourly check

// Everything else (newly-expired items, inventory rescue candidates, trial
// ending) only makes sense to check once a day — reuses the same hour as
// the digest email so managers get one predictable daily check-in.
function runDailyOpsPushCheck() {
  if (!ONESIGNAL_APP_ID || !ONESIGNAL_REST_API_KEY) return;
  // No longer gated to one specific UTC hour — that gate was redundant
  // (each alert type below already has its own same-day dedup keyed per
  // store) and it was silently preventing this whole function from doing
  // anything unless a deploy or the hourly interval happened to land
  // during that exact hour. Running it every hour and letting the
  // per-store dedup do its job is both simpler and actually reliable.
  console.log('[push] runDailyOpsPushCheck starting');

  const today = todayUtcDateStr();
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  const stores = db.prepare('SELECT * FROM stores').all();
  console.log(`[push] runDailyOpsPushCheck checking ${stores.length} store(s)`);
  for (const store of stores) {
    const manager = db.prepare("SELECT * FROM users WHERE organization_id = ? AND role = 'manager' LIMIT 1").get(store.organization_id);
    if (!manager) { console.log(`[push] store=${store.id} has no manager \u2014 skipping`); continue; }

    const org = db.prepare('SELECT critical_days, soon_days, trial_ends_at, subscription_status FROM organizations WHERE id = ?').get(store.organization_id);
    const criticalDays = org ? org.critical_days : 3;
    const soonDays = org ? org.soon_days : 60;
    const allItems = db.prepare('SELECT * FROM items WHERE store_id = ?').all(store.id);

    // Newly expired: items whose expiration date was exactly yesterday, i.e.
    // they crossed into "expired" overnight rather than having been expired
    // for a while already (which would otherwise re-notify every single day).
    const newlyExpired = allItems.filter(it => it.expiration_date === yesterday);
    const expiredKey = `expired:${store.id}`;
    const expiredAlreadySent = wasPushSentToday(expiredKey);
    console.log(`[push] store=${store.id} newlyExpired=${newlyExpired.length} alreadySentToday=${expiredAlreadySent}`);
    if (newlyExpired.length > 0 && !expiredAlreadySent) {
      sendPushToUser(manager.id, `${newlyExpired.length} item${newlyExpired.length !== 1 ? 's' : ''} expired overnight`,
        newlyExpired.slice(0, 3).map(it => it.name).join(', ') + (newlyExpired.length > 3 ? ', \u2026' : ''),
        { data: { screen: 'home' }, type: 'expiredItems' })
        .then(result => { if (result.sent) markPushSentToday(expiredKey); })
        .catch(() => {});
    }

    // Inventory rescue: items still worth marking down rather than writing
    // off, same definition used by the in-app Inventory Rescue section.
    const rescueCandidates = allItems.filter(it => {
      if (!it.selling_price || it.quantity <= 0) return false;
      const u = urgencyOf(it.expiration_date, criticalDays, soonDays);
      return u === 'critical' || u === 'soon';
    });
    const rescueKey = `rescue:${store.id}`;
    const rescueAlreadySent = wasPushSentToday(rescueKey);
    console.log(`[push] store=${store.id} rescueCandidates=${rescueCandidates.length} alreadySentToday=${rescueAlreadySent}`);
    if (rescueCandidates.length > 0 && !rescueAlreadySent) {
      sendPushToUser(manager.id, `${rescueCandidates.length} item${rescueCandidates.length !== 1 ? 's' : ''} worth marking down`,
        'Still sellable if discounted soon \u2014 check Inventory Rescue.',
        { data: { screen: 'home' }, type: 'rescueItems' })
        .then(result => { if (result.sent) markPushSentToday(rescueKey); })
        .catch(() => {});
    }

    // Trial ending soon.
    if (org && org.trial_ends_at && org.subscription_status === 'trialing') {
      const daysLeft = Math.ceil((new Date(org.trial_ends_at).getTime() - Date.now()) / 86400000);
      const inWindow = daysLeft >= 0 && daysLeft <= 3;
      const trialKey = `trial:${store.organization_id}`;
      // Only check (and thus only log/lock) when actually in the 0\u20133
      // day window \u2014 checking outside the window is meaningless.
      const trialAlreadySent = inWindow ? wasPushSentToday(trialKey) : null;
      console.log(`[push] store=${store.id} trial daysLeft=${daysLeft} status=${org.subscription_status} inWindow=${inWindow} alreadySentToday=${trialAlreadySent}`);
      if (inWindow && !trialAlreadySent) {
        sendPushToUser(manager.id, daysLeft === 0 ? 'Trial ends today' : `Trial ends in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}`,
          'Add billing to keep FloorStock running without interruption.',
          { data: { screen: 'billing' }, type: 'trialEnding' })
          .then(result => { if (result.sent) markPushSentToday(trialKey); })
          .catch(() => {});
      }
    } else if (org) {
      console.log(`[push] store=${store.id} trial check skipped: trial_ends_at=${org.trial_ends_at} status=${org.subscription_status}`);
    }
  }
}
runDailyOpsPushCheck();
setInterval(runDailyOpsPushCheck, 60 * 60 * 1000); // hourly check (gates internally to once/day)

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

    const manager = db.prepare("SELECT * FROM users WHERE organization_id = ? AND role = 'manager' LIMIT 1").get(store.organization_id);
    db.prepare('INSERT OR IGNORE INTO backup_log (store_id, sent_date, created_at) VALUES (?, ?, ?)').run(store.id, today, nowIso());
    if (manager && manager.email) sendBackupEmail(store, manager.email).catch(() => {});
  }
}
runBackupCheckIfDue();
setInterval(runBackupCheckIfDue, 60 * 60 * 1000); // hourly check

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`FloorStock server running at http://localhost:${PORT}`);
  console.log(`Database file: ${DB_PATH}`);
  console.log(RESEND_API_KEY ? `Digest email enabled (checks hourly, sends at ${DIGEST_HOUR_UTC}:00 UTC per store's chosen frequency)` : 'Digest email disabled (no RESEND_API_KEY set)');
  console.log(RESEND_API_KEY ? 'Weekly per-store backup email enabled' : 'Weekly per-store backup email disabled (no RESEND_API_KEY set)');
  console.log(USDA_FDC_API_KEY ? 'USDA FoodData Central UPC source enabled' : 'USDA FoodData Central UPC source disabled (no USDA_FDC_API_KEY set)');
  console.log(ADMIN_EMAIL ? `Founder dashboard enabled for ${ADMIN_EMAIL}` : 'Founder dashboard disabled (no ADMIN_EMAIL set)');
  console.log(ANTHROPIC_API_KEY ? 'Invoice import enabled' : 'Invoice import disabled (no ANTHROPIC_API_KEY set)');
});
