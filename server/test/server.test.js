import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

// Set required env vars BEFORE importing db.js/auth.js/server.js — they
// read these at module-load time and exit the process if missing.
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.INGEST_API_KEY = 'test-ingest-key';
process.env.DB_PATH = ':memory:';
process.env.SEED_ADMIN_EMAIL = 'admin@test.local';
process.env.SEED_ADMIN_PASSWORD = 'test-admin-pw-123';

await import('../src/env-check.js');
const { default: app } = await import('../src/server.js');
const { default: db } = await import('../src/db.js');

function validDecisionPayload(overrides = {}) {
  return {
    userRef: 'user-1',
    channelContext: 'public',
    modality: 'text',
    decision: 'ALLOWED',
    score: 0.1,
    inputHash: 'a'.repeat(64),
    proofHash: 'b'.repeat(64),
    policyId: 'SIFEDGE-TEXT-POL-02',
    ...overrides,
  };
}

describe('POST /api/decisions — ingest auth', () => {
  test('rejects requests with no x-api-key', async () => {
    const res = await request(app).post('/api/decisions').send(validDecisionPayload());
    assert.equal(res.status, 401);
  });

  test('rejects requests with a wrong x-api-key', async () => {
    const res = await request(app)
      .post('/api/decisions')
      .set('x-api-key', 'not-the-real-key')
      .send(validDecisionPayload());
    assert.equal(res.status, 401);
  });

  test('accepts requests with the correct x-api-key', async () => {
    const res = await request(app)
      .post('/api/decisions')
      .set('x-api-key', 'test-ingest-key')
      .send(validDecisionPayload());
    assert.equal(res.status, 201);
    assert.ok(res.body.decisionId);
  });
});

describe('POST /api/decisions — validation', () => {
  const auth = (r) => r.set('x-api-key', 'test-ingest-key');

  test('rejects a private-channel decision outright', async () => {
    const res = await auth(request(app).post('/api/decisions'))
      .send(validDecisionPayload({ channelContext: 'private' }));
    assert.equal(res.status, 400);
  });

  test('rejects missing required fields', async () => {
    const res = await auth(request(app).post('/api/decisions')).send({ userRef: 'user-1' });
    assert.equal(res.status, 400);
  });

  test('rejects an out-of-enum decision value', async () => {
    const res = await auth(request(app).post('/api/decisions'))
      .send(validDecisionPayload({ decision: 'TOTALLY_FINE' }));
    assert.equal(res.status, 400);
  });

  test('rejects an out-of-enum modality value', async () => {
    const res = await auth(request(app).post('/api/decisions'))
      .send(validDecisionPayload({ modality: 'telepathy' }));
    assert.equal(res.status, 400);
  });

  test('rejects a score outside 0..1', async () => {
    const res = await auth(request(app).post('/api/decisions'))
      .send(validDecisionPayload({ score: 4.2 }));
    assert.equal(res.status, 400);
  });
});

describe('moderator auth', () => {
  test('rejects login with wrong password', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@test.local', password: 'wrong' });
    assert.equal(res.status, 401);
  });

  test('logs in with the seeded credentials and returns a usable token', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@test.local', password: 'test-admin-pw-123' });
    assert.equal(res.status, 200);
    assert.ok(res.body.token);
  });

  test('moderator-only routes reject requests with no token', async () => {
    const res = await request(app).get('/api/queue');
    assert.equal(res.status, 401);
  });

  test('moderator-only routes reject a garbage token', async () => {
    const res = await request(app).get('/api/queue').set('Authorization', 'Bearer not-a-real-jwt');
    assert.equal(res.status, 401);
  });

  test('moderator-only routes accept a valid token', async () => {
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@test.local', password: 'test-admin-pw-123' });
    const res = await request(app).get('/api/queue').set('Authorization', `Bearer ${login.body.token}`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.queue));
  });
});

describe('GET /api/users/:userRef/ban-status', () => {
  test('rejects requests with no valid x-api-key (moderator token is not enough)', async () => {
    const res = await request(app).get('/api/users/someone/ban-status');
    assert.equal(res.status, 401);
  });

  test('accepts the ingest key and returns per-modality status', async () => {
    const res = await request(app)
      .get('/api/users/ban-status-check/ban-status')
      .set('x-api-key', 'test-ingest-key');
    assert.equal(res.status, 200);
    for (const modality of ['text', 'audio', 'image']) {
      assert.ok(res.body.modalities[modality], `expected a ${modality} entry`);
      assert.equal(res.body.modalities[modality].isBanned, false);
    }
  });
});

describe('warning + ban flow (independent per modality)', () => {
  let token;
  before(async () => {
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@test.local', password: 'test-admin-pw-123' });
    token = login.body.token;
  });

  async function blockThreeTimes(userRef, overrides = {}) {
    let res;
    for (let i = 0; i < 3; i++) {
      res = await request(app)
        .post('/api/decisions')
        .set('x-api-key', 'test-ingest-key')
        .send(validDecisionPayload({ userRef, decision: 'BLOCKED', score: 0.95, ...overrides }));
      assert.equal(res.status, 201);
    }
    return res;
  }

  test('three BLOCKED decisions on text ban only text, for ~1 hour, and reset that counter to 0', async () => {
    const userRef = 'user-flow-1';
    await blockThreeTimes(userRef);

    const status = await request(app)
      .get(`/api/users/${userRef}/status`)
      .set('Authorization', `Bearer ${token}`);
    const text = status.body.modalities.text;
    assert.equal(text.warningCount, 0, 'the counter resets once a ban is applied');
    assert.equal(text.banLevel, 1);
    assert.equal(text.isBanned, true);
    const msUntilBan = new Date(text.bannedUntil).getTime() - Date.now();
    assert.ok(msUntilBan > 55 * 60 * 1000 && msUntilBan <= 60 * 60 * 1000, `expected ~1h ban, got ${msUntilBan}ms`);

    // Banning text must never touch audio or image.
    assert.equal(status.body.modalities.audio.isBanned, false);
    assert.equal(status.body.modalities.image.isBanned, false);
  });

  test('while a modality is banned, a new report for it is rejected (403) and not recorded', async () => {
    const userRef = 'user-flow-gate';
    await blockThreeTimes(userRef);

    const res = await request(app)
      .post('/api/decisions')
      .set('x-api-key', 'test-ingest-key')
      .send(validDecisionPayload({ userRef, decision: 'ALLOWED', score: 0.1 }));
    assert.equal(res.status, 403);
  });

  test('escalates to a 24h ban once a modality hits 3 warnings again after its 1h ban expired, and that level is the ceiling', async () => {
    const userRef = 'user-flow-escalate';
    await blockThreeTimes(userRef);

    // Simulate the 1h ban having already expired.
    db.prepare("UPDATE user_status SET text_banned_until = datetime('now', '-1 minute') WHERE user_ref = ?").run(userRef);

    const secondBanRes = await blockThreeTimes(userRef);
    assert.equal(secondBanRes.body.justBanned, true);
    assert.equal(secondBanRes.body.banLevel, 2);

    let status = await request(app)
      .get(`/api/users/${userRef}/status`)
      .set('Authorization', `Bearer ${token}`);
    let text = status.body.modalities.text;
    assert.equal(text.banLevel, 2);
    let msUntilBan = new Date(text.bannedUntil).getTime() - Date.now();
    assert.ok(msUntilBan > 23.5 * 3600 * 1000 && msUntilBan <= 24 * 3600 * 1000, `expected ~24h ban, got ${msUntilBan}ms`);

    // Expire the 24h ban too, then hit 3 more — must stay at level 2 (24h),
    // never escalate past the ceiling.
    db.prepare("UPDATE user_status SET text_banned_until = datetime('now', '-1 minute') WHERE user_ref = ?").run(userRef);
    const thirdBanRes = await blockThreeTimes(userRef);
    assert.equal(thirdBanRes.body.banLevel, 2, 'ban level must cap at 2 (24h) and never escalate past it');

    status = await request(app)
      .get(`/api/users/${userRef}/status`)
      .set('Authorization', `Bearer ${token}`);
    msUntilBan = new Date(status.body.modalities.text.bannedUntil).getTime() - Date.now();
    assert.ok(msUntilBan > 23.5 * 3600 * 1000 && msUntilBan <= 24 * 3600 * 1000, 'the repeat ban is still 24h, not longer');
  });

  test('audio follows the same 3 -> 1h escalation as text, independently of it', async () => {
    const userRef = 'user-flow-audio';
    await blockThreeTimes(userRef, { modality: 'audio', policyId: 'SIFEDGE-AUDIO-POL-01' });

    const status = await request(app)
      .get(`/api/users/${userRef}/status`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(status.body.modalities.audio.banLevel, 1);
    assert.equal(status.body.modalities.audio.isBanned, true);
    assert.equal(status.body.modalities.text.isBanned, false, 'banning audio must not touch text');
    assert.equal(status.body.modalities.image.isBanned, false, 'banning audio must not touch image');
  });

  test('a human "dismiss" on a pending review does not add a warning', async () => {
    const userRef = 'user-flow-2';
    const ingest = await request(app)
      .post('/api/decisions')
      .set('x-api-key', 'test-ingest-key')
      .send(validDecisionPayload({ userRef, decision: 'PENDING_REVIEW', score: 0.7 }));
    assert.equal(ingest.status, 201);

    const queue = await request(app).get('/api/queue').set('Authorization', `Bearer ${token}`);
    const item = queue.body.queue.find(q => q.user_ref === userRef);
    assert.ok(item, 'expected the pending item to be in the queue');

    const resolve = await request(app)
      .post(`/api/queue/${item.id}/resolve`)
      .set('Authorization', `Bearer ${token}`)
      .send({ action: 'dismiss' });
    assert.equal(resolve.status, 200);

    const status = await request(app)
      .get(`/api/users/${userRef}/status`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(status.body.modalities.text.warningCount, 0);
  });

  test('a human "confirm" on a pending review does add a warning', async () => {
    const userRef = 'user-flow-3';
    const ingest = await request(app)
      .post('/api/decisions')
      .set('x-api-key', 'test-ingest-key')
      .send(validDecisionPayload({ userRef, decision: 'PENDING_REVIEW', score: 0.7 }));
    assert.equal(ingest.status, 201);

    const queue = await request(app).get('/api/queue').set('Authorization', `Bearer ${token}`);
    const item = queue.body.queue.find(q => q.user_ref === userRef);

    const resolve = await request(app)
      .post(`/api/queue/${item.id}/resolve`)
      .set('Authorization', `Bearer ${token}`)
      .send({ action: 'confirm' });
    assert.equal(resolve.status, 200);

    const status = await request(app)
      .get(`/api/users/${userRef}/status`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(status.body.modalities.text.warningCount, 1);
  });
});
