import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import db from './db.js';

// NOTE: hardcoded dev secret — replace with an env var (JWT_SECRET) before any real deployment.
const JWT_SECRET = process.env.JWT_SECRET || 'aegis-edge-dev-secret-change-me';

export function login(req, res) {
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
