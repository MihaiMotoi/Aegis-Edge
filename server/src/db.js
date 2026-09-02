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
  text_warning_count INTEGER NOT NULL DEFAULT 0,
  text_ban_level INTEGER NOT NULL DEFAULT 0,
  text_banned_until TEXT,
  audio_warning_count INTEGER NOT NULL DEFAULT 0,
  audio_ban_level INTEGER NOT NULL DEFAULT 0,
  audio_banned_until TEXT,
  image_warning_count INTEGER NOT NULL DEFAULT 0,
  image_ban_level INTEGER NOT NULL DEFAULT 0,
  image_banned_until TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Migration: databases created before per-modality warnings/bans have a
// user_status table with only the old global columns (warning_count,
// is_suspended, suspended_until). Add the new per-modality columns without
// touching those legacy columns or any existing row — CREATE TABLE IF NOT
// EXISTS above is a no-op against them, so this has to run unconditionally
// and be idempotent itself.
const MODALITY_STATUS_COLUMNS = ['text', 'audio', 'image'].flatMap((modality) => [
  [`${modality}_warning_count`, 'INTEGER NOT NULL DEFAULT 0'],
  [`${modality}_ban_level`, 'INTEGER NOT NULL DEFAULT 0'],
  [`${modality}_banned_until`, 'TEXT'],
]);
const existingUserStatusColumns = new Set(
  db.prepare('PRAGMA table_info(user_status)').all().map((c) => c.name)
);
for (const [columnName, columnDef] of MODALITY_STATUS_COLUMNS) {
  if (!existingUserStatusColumns.has(columnName)) {
    db.exec(`ALTER TABLE user_status ADD COLUMN ${columnName} ${columnDef}`);
  }
}

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
