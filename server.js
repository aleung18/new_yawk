// new_yawk: tiny Express + SQLite server for our NYC trip planner.
// Run with `npm start` (or `npm run dev` to auto-restart on changes).
import express from 'express';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(dir, 'trip.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS places (
    id           INTEGER PRIMARY KEY,
    kind         TEXT NOT NULL CHECK (kind IN ('food', 'event')),
    name         TEXT NOT NULL,
    category     TEXT,   -- food: Café, Dessert, Restaurant... / event: Show, Museum...
    cuisine      TEXT,   -- food only
    neighborhood TEXT,
    address      TEXT,
    lat          REAL,
    lng          REAL,
    url          TEXT,
    notes        TEXT,
    event_date   TEXT,   -- YYYY-MM-DD, events only (optional)
    event_time   TEXT,   -- HH:MM, events only (optional)
    created_at   TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS schedule (
    id       INTEGER PRIMARY KEY,
    place_id INTEGER NOT NULL REFERENCES places(id) ON DELETE CASCADE,
    day      TEXT NOT NULL,  -- YYYY-MM-DD
    time     TEXT,           -- HH:MM
    note     TEXT
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;
const FIELDS = ['kind', 'name', 'category', 'cuisine', 'neighborhood', 'address', 'lat', 'lng',
                'url', 'notes', 'event_date', 'event_time'];

function cleanPlace(body) {
  const p = {};
  for (const f of FIELDS) {
    const v = typeof body[f] === 'string' ? body[f].trim() : body[f];
    p[f] = v === '' || v === undefined ? null : v;
  }
  for (const f of ['lat', 'lng']) p[f] = p[f] === null || Number.isNaN(Number(p[f])) ? null : Number(p[f]);
  if (p.kind !== 'event') { p.event_date = null; p.event_time = null; }
  if (p.kind !== 'food') p.cuisine = null;
  return p;
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(dir, 'public')));

// ---- Places (food + events) ----
app.get('/api/places', (req, res) => {
  res.json(db.prepare('SELECT * FROM places ORDER BY name COLLATE NOCASE').all());
});

app.post('/api/places', (req, res) => {
  const p = cleanPlace(req.body ?? {});
  if (!p.name || !['food', 'event'].includes(p.kind)) {
    return res.status(400).json({ error: 'A name and a kind (food or event) are required.' });
  }
  if ((p.event_date && !DATE.test(p.event_date)) || (p.event_time && !TIME.test(p.event_time))) {
    return res.status(400).json({ error: 'Event date/time is in the wrong format.' });
  }
  const info = db.prepare(
    `INSERT INTO places (${FIELDS.join(', ')}) VALUES (${FIELDS.map(f => '@' + f).join(', ')})`
  ).run(p);
  res.status(201).json(db.prepare('SELECT * FROM places WHERE id = ?').get(info.lastInsertRowid));
});

app.delete('/api/places/:id', (req, res) => {
  db.prepare('DELETE FROM places WHERE id = ?').run(Number(req.params.id));
  res.status(204).end();
});

// ---- Schedule ----
app.get('/api/schedule', (req, res) => {
  res.json(db.prepare(`
    SELECT s.*, p.name, p.kind, p.category, p.cuisine, p.neighborhood, p.lat, p.lng
    FROM schedule s JOIN places p ON p.id = s.place_id
    ORDER BY s.day, s.time IS NULL, s.time, s.id
  `).all());
});

app.post('/api/schedule', (req, res) => {
  const { place_id, day, time, note } = req.body ?? {};
  if (!db.prepare('SELECT 1 FROM places WHERE id = ?').get(Number(place_id))) {
    return res.status(400).json({ error: 'That place no longer exists.' });
  }
  if (!DATE.test(day ?? '') || (time && !TIME.test(time))) {
    return res.status(400).json({ error: 'Pick a day (and an optional time).' });
  }
  const info = db.prepare('INSERT INTO schedule (place_id, day, time, note) VALUES (?, ?, ?, ?)')
    .run(Number(place_id), day, time || null, note?.trim() || null);
  res.status(201).json({ id: info.lastInsertRowid });
});

app.delete('/api/schedule/:id', (req, res) => {
  db.prepare('DELETE FROM schedule WHERE id = ?').run(Number(req.params.id));
  res.status(204).end();
});

// ---- Trip dates ----
const getSetting = k => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? null;
const setSetting = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

app.get('/api/trip', (req, res) => res.json({ start: getSetting('trip_start'), end: getSetting('trip_end') }));

app.put('/api/trip', (req, res) => {
  const { start, end } = req.body ?? {};
  if ((start && !DATE.test(start)) || (end && !DATE.test(end))) {
    return res.status(400).json({ error: 'Dates must look like YYYY-MM-DD.' });
  }
  if (start && end && start > end) return res.status(400).json({ error: 'The trip has to end after it starts.' });
  setSetting.run('trip_start', start || null);
  setSetting.run('trip_end', end || null);
  res.json({ start: start || null, end: end || null });
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => console.log(`new_yawk running at http://localhost:${PORT}`));
