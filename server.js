const express = require('express');
const path = require('path');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'floorstock.db');
const SESSION_COOKIE = 'floorstock_sid';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const app = express();
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ---------- schema ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS stores (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    address TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('manager','worker')),
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
`);

// Migration: older deployments may have an items table without store_id.
const itemCols = db.prepare("PRAGMA table_info(items)").all().map(c => c.name);
if (!itemCols.includes('store_id')) {
  db.exec("ALTER TABLE items ADD COLUMN store_id TEXT");
}

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
function nowIso() { return new Date().toISOString(); }
function newId() { return crypto.randomUUID(); }

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

// =====================================================================
// AUTH
// =====================================================================

// Register a new store + its manager account
app.post('/api/auth/register-store', (req, res) => {
  const { storeName, storeAddress, username, password } = req.body || {};
  if (!storeName || !String(storeName).trim()) return res.status(400).json({ error: 'Store name is required.' });
  if (!storeAddress || !String(storeAddress).trim()) return res.status(400).json({ error: 'Store address is required.' });
  if (!username || !String(username).trim()) return res.status(400).json({ error: 'Username is required.' });
  if (!isStrongEnoughPassword(password)) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim().toLowerCase());
  if (existing) return res.status(409).json({ error: 'That username is already taken.' });

  const storeId = newId();
  const userId = newId();
  const passwordHash = bcrypt.hashSync(password, 10);
  const ts = nowIso();

  db.prepare('INSERT INTO stores (id, name, address, created_at) VALUES (?, ?, ?, ?)')
    .run(storeId, storeName.trim(), storeAddress.trim(), ts);
  db.prepare(`
    INSERT INTO users (id, store_id, username, password_hash, role, created_at)
    VALUES (?, ?, ?, ?, 'manager', ?)
  `).run(userId, storeId, username.trim().toLowerCase(), passwordHash, ts);

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
  db.prepare(`
    INSERT INTO users (id, store_id, username, password_hash, role, created_at)
    VALUES (?, ?, ?, ?, 'worker', ?)
  `).run(id, req.auth.storeId, username.trim().toLowerCase(), bcrypt.hashSync(password, 10), nowIso());

  res.status(201).json({ id, username: username.trim().toLowerCase() });
});

app.delete('/api/workers/:id', requireManager, (req, res) => {
  const worker = db.prepare("SELECT * FROM users WHERE id = ? AND store_id = ? AND role = 'worker'").get(req.params.id, req.auth.storeId);
  if (!worker) return res.status(404).json({ error: 'Worker not found.' });
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.params.id);
  res.status(204).end();
});

// =====================================================================
// UPC LOOKUP (free public database, proxied server-side to avoid CORS
// and keep this swappable later without touching the frontend)
// =====================================================================

app.get('/api/upc-lookup/:upc', requireAuth, async (req, res) => {
  const upc = String(req.params.upc || '').trim();
  if (!upc) return res.status(400).json({ error: 'UPC is required.' });

  try {
    const response = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(upc)}`);
    if (!response.ok) {
      return res.json({ found: false });
    }
    const data = await response.json();
    const item = data.items && data.items[0];
    if (!item) return res.json({ found: false });
    res.json({
      found: true,
      name: item.title || null,
      brand: item.brand || null,
    });
  } catch (e) {
    // Lookup service being unreachable shouldn't break manual entry.
    res.json({ found: false });
  }
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

  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  res.status(201).json(rowToItem(row));
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

  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  res.json(rowToItem(row));
});

app.delete('/api/items/:id', requireAuth, (req, res) => {
  const existing = db.prepare('SELECT * FROM items WHERE id = ? AND store_id = ?').get(req.params.id, req.auth.storeId);
  if (!existing) return res.status(404).json({ error: 'Item not found.' });
  db.prepare('DELETE FROM items WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`FloorStock server running at http://localhost:${PORT}`);
  console.log(`Database file: ${DB_PATH}`);
});
