import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import db from './db.js';

// Presence is already enforced by env-check.js (imported first in
// server.js), so these reads are safe without a repeated check here.
const JWT_SECRET = process.env.JWT_SECRET;
const INGEST_API_KEY = process.env.INGEST_API_KEY;

export function requireIngestKey(req, res, next) {
  const provided = req.headers['x-api-key'] || '';
  const expected = Buffer.from(INGEST_API_KEY);
  const given = Buffer.from(String(provided));
  // Constant-time comparison — a naive === leaks timing information an
  // attacker can use to guess the key byte by byte.
  const ok = given.length === expected.length && crypto.timingSafeEqual(given, expected);
  if (!ok) return res.status(401).json({ error: 'missing or invalid x-api-key header' });
  next();
}

// Minimal in-memory brute-force guard for /api/auth/login. Not a substitute
// for a real rate limiter (e.g. behind a reverse proxy) in production, but
// closes the "unlimited password guesses" gap in the reference server.
const loginAttempts = new Map(); // ip -> { count, resetAt }
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

function isRateLimited(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > LOGIN_MAX_ATTEMPTS;
}

export function login(req, res) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'too many login attempts, try again later' });
  }

  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  const mod = db.prepare('SELECT * FROM moderators WHERE email = ?').get(email);
  if (!mod || !bcrypt.compareSync(password, mod.password_hash)) {
    return res.status(401).json({ error: 'invalid credentials' });
  }

  const token = jwt.sign({ sub: mod.id, email: mod.email, role: mod.role }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, moderator: { id: mod.id, email: mod.email, role: mod.role } });
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing bearer token' });
  try {
    req.moderator = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'invalid or expired token' });
  }
}
