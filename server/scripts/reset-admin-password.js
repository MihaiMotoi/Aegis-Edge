import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const email = process.argv[2];
if (!email) {
  console.error('Usage: node scripts/reset-admin-password.js <email>');
  process.exit(1);
}

// Same DB_PATH resolution as db.js, so this always points at the live server
// database unless DB_PATH is overridden (e.g. by tests).
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'sifedge.db');
const db = new Database(dbPath);

const moderator = db.prepare('SELECT id, email FROM moderators WHERE email = ?').get(email);
if (!moderator) {
  console.error(`[reset-admin-password] No moderator account found for email: ${email}`);
  process.exit(1);
}

// Same random-password method as the first-run seed in db.js.
const password = crypto.randomBytes(12).toString('base64url');
const passwordHash = bcrypt.hashSync(password, 10);

db.prepare('UPDATE moderators SET password_hash = ? WHERE id = ?').run(passwordHash, moderator.id);

console.log('==========================================================');
console.log(`[reset-admin-password] Password reset for: ${moderator.email}`);
console.log(`[reset-admin-password] New password (shown once, not stored anywhere else): ${password}`);
console.log('[reset-admin-password] Log in and rotate this again if needed.');
console.log('==========================================================');
