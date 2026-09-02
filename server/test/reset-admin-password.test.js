import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import request from 'supertest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.join(__dirname, '..');

// Uses a real on-disk file (not ':memory:') because the script under test
// runs as a separate process and must see the same database as this test.
const dbPath = path.join(os.tmpdir(), `aegis-edge-reset-admin-test-${process.pid}-${Date.now()}.db`);

process.env.JWT_SECRET = 'test-jwt-secret';
process.env.INGEST_API_KEY = 'test-ingest-key';
process.env.DB_PATH = dbPath;
process.env.SEED_ADMIN_EMAIL = 'admin@test.local';
process.env.SEED_ADMIN_PASSWORD = 'original-admin-pw-123';

await import('../src/env-check.js');
const { default: app } = await import('../src/server.js');
const { default: db } = await import('../src/db.js');

after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* already gone */ }
  }
});

function runScript(email) {
  return execFileSync('node', ['scripts/reset-admin-password.js', email], {
    cwd: serverRoot,
    env: process.env,
    encoding: 'utf8',
  });
}

describe('reset-admin-password script', () => {
  test('exits non-zero with a clear error when the email does not exist', () => {
    let caught = null;
    try {
      execFileSync('node', ['scripts/reset-admin-password.js', 'nobody@test.local'], {
        cwd: serverRoot,
        env: process.env,
        encoding: 'utf8',
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'expected the script to exit non-zero for an unknown email');
    assert.equal(caught.status, 1);
    assert.match(caught.stderr, /no moderator account found/i);
    assert.match(caught.stderr, /nobody@test\.local/);
  });

  test('rewrites password_hash in the database for the given account', () => {
    const before = db.prepare('SELECT password_hash FROM moderators WHERE email = ?').get('admin@test.local');
    assert.ok(before, 'expected the seeded admin account to exist');

    runScript('admin@test.local');

    const afterReset = db.prepare('SELECT password_hash FROM moderators WHERE email = ?').get('admin@test.local');
    assert.notEqual(afterReset.password_hash, before.password_hash);
  });

  test('the new generated password actually works against /api/auth/login', async () => {
    const output = runScript('admin@test.local');

    const match = output.match(/New password \(shown once, not stored anywhere else\): (\S+)/);
    assert.ok(match, 'expected the script output to contain the new password');
    const newPassword = match[1];

    const oldLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@test.local', password: 'original-admin-pw-123' });
    assert.equal(oldLogin.status, 401);

    const newLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@test.local', password: newPassword });
    assert.equal(newLogin.status, 200);
    assert.ok(newLogin.body.token);
  });
});
