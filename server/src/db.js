import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DB_PATH lets tests point at ':memory:' or a throwaway file instead of the
// real sifedge.db, so running the test suite never touches real data.
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'sifedge.db');
const db = new Database(dbPath);

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
// The seed password is never a fixed literal: it comes from
// SEED_ADMIN_PASSWORD if set, otherwise a random one is generated and
// printed ONCE. A fixed default ("changeme123") is a real risk in this kind
// of project — plenty of instances go live with reference-server defaults
// never rotated. A random one forces a first-login step either way.
const existing = db.prepare('SELECT COUNT(*) AS c FROM moderators').get();
if (existing.c === 0) {
  const email = process.env.SEED_ADMIN_EMAIL || 'admin@sifedge.local';
  const password = process.env.SEED_ADMIN_PASSWORD || crypto.randomBytes(12).toString('base64url');
  const defaultHash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO moderators (email, password_hash, role) VALUES (?, ?, ?)')
    .run(email, defaultHash, 'admin');
  console.log('==========================================================');
  console.log(`[db] Seeded first moderator account: ${email}`);
  if (!process.env.SEED_ADMIN_PASSWORD) {
    console.log(`[db] Generated password (shown once, not stored anywhere else): ${password}`);
  }
  console.log('[db] Log in and rotate this before any real deployment.');
  console.log('==========================================================');
}

export default db;
