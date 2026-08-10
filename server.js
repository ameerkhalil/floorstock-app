const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const Stripe = require('stripe');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'floorstock.db');
const SESSION_COOKIE = 'floorstock_sid';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Stripe billing config
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

// Digest email config (all optional — digest simply won't send without an API key)
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const DIGEST_FROM_EMAIL = process.env.DIGEST_FROM_EMAIL || 'onboarding@resend.dev';
const DIGEST_HOUR_UTC = Number.isFinite(Number(process.env.DIGEST_HOUR_UTC)) ? Number(process.env.DIGEST_HOUR_UTC) : 13; // ~8am US Eastern by default

// Make sure the database's directory exists (e.g. a Render disk mount path
// like /data) before trying to open it — otherwise better-sqlite3 throws and
// the whole server crashes on boot instead of starting.
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
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
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    subscription_status TEXT NOT NULL DEFAULT 'inactive'
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
    date_added TEXT NOT NULL
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
`);

// ---------- migrations for older deployments ----------
const itemCols = db.prepare("PRAGMA table_info(items)").all().map(c => c.name);
if (!itemCols.includes('store_id')) db.exec("ALTER TABLE items ADD COLUMN store_id TEXT");

const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!userCols.includes('email')) db.exec("ALTER TABLE users ADD COLUMN email TEXT");

const storeCols = db.prepare("PRAGMA table_info(stores)").all().map(c => c.name);
if (!storeCols.includes('stripe_customer_id')) db.exec("ALTER TABLE stores ADD COLUMN stripe_customer_id TEXT");
if (!storeCols.includes('stripe_subscription_id')) db.exec("ALTER TABLE stores ADD COLUMN stripe_subscription_id TEXT");
if (!storeCols.includes('subscription_status')) db.exec("ALTER TABLE stores ADD COLUMN subscription_status TEXT DEFAULT 'inactive'");

function applySubscriptionToStore(subscription, fallbackStoreId = null) {
  if (!subscription) return;

  const subscriptionId = subscription.id || null;
  const customerId = typeof subscription.customer === 'string'
    ? subscription.customer
    : (subscription.customer && subscription.customer.id) || null;
  const status = subscription.status || 'inactive';
  const storeId = (subscription.metadata && subscription.metadata.storeId) || fallbackStoreId || null;

  if (storeId) {
    db.prepare(`
      UPDATE stores
      SET stripe_customer_id = COALESCE(?, stripe_customer_id),
          stripe_subscription_id = COALESCE(?, stripe_subscription_id),
          subscription_status = ?
      WHERE id = ?
    `).run(customerId, subscriptionId, status, storeId);
    return;
  }

  if (subscriptionId) {
    const result = db.prepare(`
      UPDATE stores
      SET stripe_customer_id = COALESCE(?, stripe_customer_id),
          subscription_status = ?
      WHERE stripe_subscription_id = ?
    `).run(customerId, status, subscriptionId);
    if (result.changes > 0) return;
  }

  if (customerId) {
    db.prepare(`
      UPDATE stores
      SET stripe_subscription_id = COALESCE(?, stripe_subscription_id),
          subscription_status = ?
      WHERE stripe_customer_id = ?
    `).run(subscriptionId, status, customerId);
  }
}

// =====================================================================
// STRIPE WEBHOOK
// IMPORTANT: This route must stay before express.json() so Stripe receives
// the raw request body for signature verification.
// =====================================================================
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    return res.status(500).send('Stripe is not configured.');
  }

  const signature = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, signature, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const storeId = session.metadata && session.metadata.storeId;

        if (storeId && session.customer) {
          const customerId = typeof session.customer === 'string' ? session.customer : session.customer.id;
          db.prepare('UPDATE stores SET stripe_customer_id = ? WHERE id = ?').run(customerId, storeId);
        }

        if (storeId && session.subscription) {
          const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          applySubscriptionToStore(subscription, storeId);
          console.log(`Stripe checkout completed for store ${storeId} (${subscription.status})`);
        }
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        applySubscriptionToStore(event.data.object);
        break;
      }

      default:
        break;
    }

    return res.json({ received: true });
  } catch (err) {
    console.error('Stripe webhook processing error:', err);
    return res.status(500).send('Webhook processing failed.');
  }
});

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

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
// AUTH
// =====================================================================

// Register a new store + its manager account
app.post('/api/auth/register-store', (req, res) => {
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

  db.prepare('INSERT INTO stores (id, name, address, created_at) VALUES (?, ?, ?, ?)')
    .run(storeId, storeName.trim(), storeAddress.trim(), ts);
  db.prepare(`
    INSERT INTO users (id, store_id, username, password_hash, role, email, created_at)
    VALUES (?, ?, ?, ?, 'manager', ?, ?)
  `).run(userId, storeId, username.trim().toLowerCase(), passwordHash, email.trim().toLowerCase(), ts);

  logAudit(storeId, username.trim().toLowerCase(), 'store_created', `Store "${storeName.trim()}" created`);

  const session = createSession({ id: userId, store_id: storeId, role: 'manager' });
  setSessionCookie(res, session.id, session.expiresAt);
  res.status(201).json({ role: 'manager', username: username.trim().toLowerCase(), store: { id: storeId, name: storeName.trim(), address: storeAddress.trim() } });
});

// Log in (manager or worker)
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username).trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }

  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(user.store_id);
  const session = createSession(user);
  setSessionCookie(res, session.id, session.expiresAt);
  res.json({ role: user.role, username: user.username, store: { id: store.id, name: store.name, address: store.address } });
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
  res.json({ signedIn: true, role: user.role, username: user.username, store: { id: store.id, name: store.name, address: store.address } });
});

// =====================================================================
// BILLING
// =====================================================================

app.get('/api/billing/status', requireAuth, (req, res) => {
  const store = db.prepare(`
    SELECT subscription_status, stripe_customer_id, stripe_subscription_id
    FROM stores
    WHERE id = ?
  `).get(req.auth.storeId);

  if (!store) return res.status(404).json({ error: 'Store not found.' });

  res.json({
    status: store.subscription_status || 'inactive',
    active: ['active', 'trialing'].includes(store.subscription_status),
    hasCustomer: Boolean(store.stripe_customer_id),
    hasSubscription: Boolean(store.stripe_subscription_id),
  });
});

app.post('/api/billing/create-checkout-session', requireManager, async (req, res) => {
  if (!stripe || !STRIPE_PRICE_ID) {
    return res.status(500).json({ error: 'Stripe billing is not configured.' });
  }

  try {
    const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(req.auth.storeId);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.auth.userId);

    if (!store || !user) return res.status(404).json({ error: 'Store account not found.' });

    if (['active', 'trialing'].includes(store.subscription_status)) {
      return res.status(409).json({ error: 'This store already has an active subscription.' });
    }

    const sessionOptions = {
      mode: 'subscription',
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${req.protocol}://${req.get('host')}/?checkout=success`,
      cancel_url: `${req.protocol}://${req.get('host')}/?checkout=cancelled`,
      client_reference_id: store.id,
      metadata: { storeId: store.id },
      subscription_data: { metadata: { storeId: store.id } },
    };

    if (store.stripe_customer_id) {
      sessionOptions.customer = store.stripe_customer_id;
    } else if (user.email) {
      sessionOptions.customer_email = user.email;
    }

    const session = await stripe.checkout.sessions.create(sessionOptions);
    return res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout creation failed:', err);
    return res.status(500).json({ error: 'Could not start checkout.' });
  }
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
// AUDIT LOG (manager only)
// =====================================================================

app.get('/api/audit', requireManager, (req, res) => {
  const rows = db.prepare('SELECT * FROM audit_log WHERE store_id = ? ORDER BY created_at DESC LIMIT 200').all(req.auth.storeId);
  res.json(rows.map(r => ({ id: r.id, actor: r.actor_username, action: r.action, summary: r.summary, createdAt: r.created_at })));
});

// =====================================================================
// UPC LOOKUP (free public database, proxied server-side to avoid CORS
// and keep this swappable later without touching the frontend)
// =====================================================================

app.get('/api/upc-lookup/:upc', requireAuth, async (req, res) => {
  const upc = String(req.params.upc || '').trim();
  if (!upc) return res.status(400).json({ error: 'UPC is required.' });

  // Primary: Open Food Facts — free, no key, reliable, huge food/beverage coverage.
  try {
    const offResponse = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(upc)}.json`,
      { headers: { 'User-Agent': 'FloorStock-InventoryApp/1.0' } }
    );
    if (offResponse.ok) {
      const offData = await offResponse.json();
      if (offData.status === 1 && offData.product) {
        let name = (offData.product.product_name || '').trim();
        const brand = (offData.product.brands || '').split(',')[0].trim();
        if (brand && !name.toLowerCase().includes(brand.toLowerCase())) {
          name = name ? `${brand} ${name}` : brand;
        }
        if (name) {
          return res.json({ found: true, name, brand: brand || null });
        }
      }
    }
  } catch (e) {
    // fall through to the secondary source
  }

  // Fallback: UPCitemdb trial — covers more non-food items, best effort only.
  try {
    const response = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(upc)}`);
    if (response.ok) {
      const data = await response.json();
      const item = data.items && data.items[0];
      if (item && item.title) {
        return res.json({ found: true, name: item.title, brand: item.brand || null });
      }
    }
  } catch (e) {
    // both sources failed — fall through to not-found
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
  };
}

function validatePayload(body) {
  const { upc, name, expirationDate, quantity, unit, location } = body || {};
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
  return null;
}

app.get('/api/items', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM items WHERE store_id = ? ORDER BY expiration_date ASC').all(req.auth.storeId);
  res.json(rows.map(rowToItem));
});

// Find existing batches with the same UPC, so the frontend can offer
// "add to this batch" instead of always creating a new tag.
app.get('/api/items/by-upc/:upc', requireAuth, (req, res) => {
  const upc = String(req.params.upc || '').trim();
  if (!upc) return res.json([]);
  const rows = db.prepare('SELECT * FROM items WHERE store_id = ? AND upc = ? ORDER BY expiration_date ASC').all(req.auth.storeId, upc);
  res.json(rows.map(rowToItem));
});

// CSV export of the current store's inventory
app.get('/api/items/export.csv', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM items WHERE store_id = ? ORDER BY expiration_date ASC').all(req.auth.storeId);
  const escapeCsv = (val) => {
    const s = String(val === null || val === undefined ? '' : val);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['Product Name', 'UPC', 'Expiration Date', 'Quantity', 'Unit', 'Location', 'Date Added'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      escapeCsv(r.name), escapeCsv(r.upc), escapeCsv(r.expiration_date),
      escapeCsv(r.quantity), escapeCsv(r.unit), escapeCsv(r.location), escapeCsv(r.date_added),
    ].join(','));
  }
  const csv = lines.join('\r\n');
  const store = db.prepare('SELECT name FROM stores WHERE id = ?').get(req.auth.storeId);
  const filenameSafe = (store ? store.name : 'floorstock').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filenameSafe}-inventory-${todayUtcDateStr()}.csv"`);
  res.send(csv);
});

app.post('/api/items', requireAuth, (req, res) => {
  const error = validatePayload(req.body);
  if (error) return res.status(400).json({ error });

  const { upc, name, expirationDate, quantity, unit, location } = req.body;
  const id = newId();
  const dateAdded = nowIso();

  db.prepare(`
    INSERT INTO items (id, store_id, upc, name, expiration_date, quantity, unit, location, date_added)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.auth.storeId, upc.trim(), name.trim(), expirationDate, quantity, unit.trim(), location.trim(), dateAdded);

  logAudit(req.auth.storeId, currentUsername(req), 'item_added', `Added ${quantity} ${unit.trim()} of "${name.trim()}" at ${location.trim()}`);

  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  res.status(201).json(rowToItem(row));
});

// Add units to an existing batch (used by the "add to existing batch" flow)
app.post('/api/items/:id/add-quantity', requireAuth, (req, res) => {
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

app.put('/api/items/:id', requireAuth, (req, res) => {
  const existing = db.prepare('SELECT * FROM items WHERE id = ? AND store_id = ?').get(req.params.id, req.auth.storeId);
  if (!existing) return res.status(404).json({ error: 'Item not found.' });

  const error = validatePayload(req.body);
  if (error) return res.status(400).json({ error });

  const { upc, name, expirationDate, quantity, unit, location } = req.body;
  db.prepare(`
    UPDATE items
    SET upc = ?, name = ?, expiration_date = ?, quantity = ?, unit = ?, location = ?
    WHERE id = ? AND store_id = ?
  `).run(upc.trim(), name.trim(), expirationDate, quantity, unit.trim(), location.trim(), req.params.id, req.auth.storeId);

  logAudit(req.auth.storeId, currentUsername(req), 'item_updated', `Updated "${name.trim()}" at ${location.trim()} (${quantity} ${unit.trim()})`);

  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  res.json(rowToItem(row));
});

app.delete('/api/items/:id', requireAuth, (req, res) => {
  const existing = db.prepare('SELECT * FROM items WHERE id = ? AND store_id = ?').get(req.params.id, req.auth.storeId);
  if (!existing) return res.status(404).json({ error: 'Item not found.' });
  db.prepare('DELETE FROM items WHERE id = ?').run(req.params.id);
  logAudit(req.auth.storeId, currentUsername(req), 'item_removed', `Removed "${existing.name}" (${existing.quantity} ${existing.unit}) from ${existing.location}`);
  res.status(204).end();
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

async function sendDigestEmail(store, toEmail, alertItems) {
  if (!RESEND_API_KEY || !toEmail) return { sent: false, reason: 'not configured' };
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: DIGEST_FROM_EMAIL,
        to: [toEmail],
        subject: `FloorStock: ${alertItems.length} item${alertItems.length !== 1 ? 's' : ''} need attention at ${store.name}`,
        html: buildDigestHtml(store, alertItems),
      }),
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

// Background scheduler: checks hourly, sends once per store per UTC day.
function runDigestCheckIfDue() {
  if (!RESEND_API_KEY) return;
  const nowUtc = new Date();
  if (nowUtc.getUTCHours() !== DIGEST_HOUR_UTC) return;

  const today = todayUtcDateStr();
  const stores = db.prepare('SELECT * FROM stores').all();
  for (const store of stores) {
    const already = db.prepare('SELECT 1 FROM digest_log WHERE store_id = ? AND sent_date = ?').get(store.id, today);
    if (already) continue;

    const manager = db.prepare("SELECT * FROM users WHERE store_id = ? AND role = 'manager' LIMIT 1").get(store.id);
    db.prepare('INSERT OR IGNORE INTO digest_log (store_id, sent_date, created_at) VALUES (?, ?, ?)').run(store.id, today, nowIso());

    if (!manager || !manager.email) continue;
    const alertItems = getAlertItemsForStore(store.id);
    if (alertItems.length === 0) continue; // nothing worth emailing about today

    sendDigestEmail(store, manager.email, alertItems).catch(() => {});
  }
}
setInterval(runDigestCheckIfDue, 60 * 60 * 1000); // hourly check

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`FloorStock server running at http://localhost:${PORT}`);
  console.log(`Database file: ${DB_PATH}`);
  console.log(RESEND_API_KEY ? `Digest email enabled (daily at ${DIGEST_HOUR_UTC}:00 UTC)` : 'Digest email disabled (no RESEND_API_KEY set)');
  console.log(stripe && STRIPE_PRICE_ID ? 'Stripe billing enabled' : 'Stripe billing disabled (missing STRIPE_SECRET_KEY or STRIPE_PRICE_ID)');
});
