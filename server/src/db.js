import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, '..', 'aegis_edge.db'));

db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT,
  user_ref TEXT NOT NULL,
  channel_context TEXT NOT NULL,
  modality TEXT NOT NULL,
  decision TEXT NOT NULL,
  score REAL NOT NULL,
  input_hash TEXT NOT NULL,
  proof_hash TEXT NOT NULL,
  source TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS review_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id INTEGER NOT NULL REFERENCES decisions(id),
  user_ref TEXT NOT NULL,
  modality TEXT NOT NULL,
  score REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  resolved_by INTEGER REFERENCES moderators(id),
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS moderators (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'moderator',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_status (
  user_ref TEXT PRIMARY KEY,
  warning_count INTEGER NOT NULL DEFAULT 0,
  is_suspended INTEGER NOT NULL DEFAULT 0,
  suspended_until TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Seed a default admin moderator on first run, if none exists.
// NOTE: local dev convenience only — rotate/remove before any real deployment.
const existing = db.prepare('SELECT COUNT(*) AS c FROM moderators').get();
if (existing.c === 0) {
  const defaultHash = bcrypt.hashSync('changeme123', 10);
  db.prepare('INSERT INTO moderators (email, password_hash, role) VALUES (?, ?, ?)')
    .run('admin@aegis-edge.local', defaultHash, 'admin');
  console.log('[db] Seeded default moderator: admin@aegis-edge.local / changeme123 — CHANGE THIS before real use.');
}

export default db;
