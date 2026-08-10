const express = require('express');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'floorstock.db');

const app = express();
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    upc TEXT NOT NULL,
    name TEXT NOT NULL,
    expiration_date TEXT NOT NULL,
    quantity REAL NOT NULL,
    unit TEXT NOT NULL,
    location TEXT NOT NULL,
    date_added TEXT NOT NULL
  )
`);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

// List all items
app.get('/api/items', (req, res) => {
  const rows = db.prepare('SELECT * FROM items ORDER BY expiration_date ASC').all();
  res.json(rows.map(rowToItem));
});

// Get a single item
app.get('/api/items/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Item not found.' });
  res.json(rowToItem(row));
});

// Create an item
app.post('/api/items', (req, res) => {
  const error = validatePayload(req.body);
  if (error) return res.status(400).json({ error });

  const { upc, name, expirationDate, quantity, unit, location } = req.body;
  const id = crypto.randomUUID();
  const dateAdded = new Date().toISOString();

  db.prepare(`
    INSERT INTO items (id, upc, name, expiration_date, quantity, unit, location, date_added)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, upc.trim(), name.trim(), expirationDate, quantity, unit.trim(), location.trim(), dateAdded);

  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  res.status(201).json(rowToItem(row));
});

// Update an item
app.put('/api/items/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Item not found.' });

  const error = validatePayload(req.body);
  if (error) return res.status(400).json({ error });

  const { upc, name, expirationDate, quantity, unit, location } = req.body;
  db.prepare(`
    UPDATE items
    SET upc = ?, name = ?, expiration_date = ?, quantity = ?, unit = ?, location = ?
    WHERE id = ?
  `).run(upc.trim(), name.trim(), expirationDate, quantity, unit.trim(), location.trim(), req.params.id);

  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  res.json(rowToItem(row));
});

// Delete an item
app.delete('/api/items/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Item not found.' });
  db.prepare('DELETE FROM items WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// Simple health check
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`FloorStock server running at http://localhost:${PORT}`);
  console.log(`Database file: ${DB_PATH}`);
});
