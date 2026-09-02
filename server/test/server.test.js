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

describe('warning + tier escalation flow (independent per modality)', () => {
  let token;
  before(async () => {
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@test.local', password: 'test-admin-pw-123' });
    token = login.body.token;
  });

  async function blockOnce(userRef, overrides = {}) {
    const res = await request(app)
      .post('/api/decisions')
      .set('x-api-key', 'test-ingest-key')
      .send(validDecisionPayload({ userRef, decision: 'BLOCKED', score: 0.95, ...overrides }));
    assert.equal(res.status, 201);
    return res;
  }

  async function blockNTimes(userRef, n, overrides = {}) {
    let res;
    for (let i = 0; i < n; i++) res = await blockOnce(userRef, overrides);
    return res;
  }

  function expireBan(userRef, modality) {
    db.prepare(`UPDATE user_status SET ${modality}_banned_until = datetime('now', '-1 minute') WHERE user_ref = ?`).run(userRef);
  }

  test('text: 2 BLOCKED decisions only warn, the 3rd bans for ~1 hour and resets the counter', async () => {
    const userRef = 'user-flow-text-warnings';
    const first = await blockOnce(userRef);
    assert.equal(first.body.justBanned, false);
    const second = await blockOnce(userRef);
    assert.equal(second.body.justBanned, false);

    let status = await request(app)
      .get(`/api/users/${userRef}/status`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(status.body.modalities.text.warningCount, 2);
    assert.equal(status.body.modalities.text.isBanned, false);

    const third = await blockOnce(userRef);
    assert.equal(third.body.justBanned, true);
    assert.equal(third.body.tier, '1h');

    status = await request(app)
      .get(`/api/users/${userRef}/status`)
      .set('Authorization', `Bearer ${token}`);
    const text = status.body.modalities.text;
    assert.equal(text.warningCount, 0, 'the counter resets once a ban is applied');
    assert.equal(text.maxTierReached, '1h');
    assert.equal(text.currentTier, '1h');
    assert.equal(text.isBanned, true);
    const msUntilBan = new Date(text.bannedUntil).getTime() - Date.now();
    assert.ok(msUntilBan > 55 * 60 * 1000 && msUntilBan <= 60 * 60 * 1000, `expected ~1h ban, got ${msUntilBan}ms`);

    // Banning text must never touch audio or image.
    assert.equal(status.body.modalities.audio.isBanned, false);
    assert.equal(status.body.modalities.image.isBanned, false);
  });

  test('audio follows the same 3-warning -> 1h ban as text, independently of it', async () => {
    const userRef = 'user-flow-audio';
    await blockNTimes(userRef, 3, { modality: 'audio', policyId: 'SIFEDGE-AUDIO-POL-01' });

    const status = await request(app)
      .get(`/api/users/${userRef}/status`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(status.body.modalities.audio.maxTierReached, '1h');
    assert.equal(status.body.modalities.audio.isBanned, true);
    assert.equal(status.body.modalities.text.isBanned, false, 'banning audio must not touch text');
    assert.equal(status.body.modalities.image.isBanned, false, 'banning audio must not touch image');
  });

  test('image: 1 BLOCKED decision only warns, the 2nd bans for ~1 hour (shorter threshold than text/audio)', async () => {
    const userRef = 'user-flow-image';
    const first = await blockOnce(userRef, { modality: 'image', policyId: 'SIFEDGE-IMG-POL-01' });
    assert.equal(first.body.justBanned, false);

    let status = await request(app)
      .get(`/api/users/${userRef}/status`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(status.body.modalities.image.warningCount, 1);
    assert.equal(status.body.modalities.image.isBanned, false);

    const second = await blockOnce(userRef, { modality: 'image', policyId: 'SIFEDGE-IMG-POL-01' });
    assert.equal(second.body.justBanned, true);
    assert.equal(second.body.tier, '1h');

    status = await request(app)
      .get(`/api/users/${userRef}/status`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(status.body.modalities.image.isBanned, true);
  });

  test('while a modality is banned, a new report for it is rejected (403) and not recorded', async () => {
    const userRef = 'user-flow-gate';
    await blockNTimes(userRef, 3);

    const res = await request(app)
      .post('/api/decisions')
      .set('x-api-key', 'test-ingest-key')
      .send(validDecisionPayload({ userRef, decision: 'ALLOWED', score: 0.1 }));
    assert.equal(res.status, 403);
  });

  test('once banned, the warning phase is gone for good: escalates 1h -> 24h -> 1month -> permanent, one BLOCKED at a time, no re-warning', async () => {
    const userRef = 'user-flow-escalate';
    await blockNTimes(userRef, 3);
    let status = await request(app).get(`/api/users/${userRef}/status`).set('Authorization', `Bearer ${token}`);
    assert.equal(status.body.modalities.text.maxTierReached, '1h');

    // 1h -> 24h: a single BLOCKED after the 1h ban expires jumps straight to
    // 24h, no warning counting in between.
    expireBan(userRef, 'text');
    const toDay = await blockOnce(userRef);
    assert.equal(toDay.body.justBanned, true);
    assert.equal(toDay.body.tier, '24h');
    status = await request(app).get(`/api/users/${userRef}/status`).set('Authorization', `Bearer ${token}`);
    let text = status.body.modalities.text;
    assert.equal(text.warningCount, 0, 'no warning counter is used once past the first ban');
    assert.equal(text.maxTierReached, '24h');
    let msUntilBan = new Date(text.bannedUntil).getTime() - Date.now();
    assert.ok(msUntilBan > 23.5 * 3600 * 1000 && msUntilBan <= 24 * 3600 * 1000, `expected ~24h ban, got ${msUntilBan}ms`);

    // 24h -> 1month
    expireBan(userRef, 'text');
    const toMonth = await blockOnce(userRef);
    assert.equal(toMonth.body.justBanned, true);
    assert.equal(toMonth.body.tier, '1month');
    status = await request(app).get(`/api/users/${userRef}/status`).set('Authorization', `Bearer ${token}`);
    text = status.body.modalities.text;
    assert.equal(text.maxTierReached, '1month');
    msUntilBan = new Date(text.bannedUntil).getTime() - Date.now();
    assert.ok(msUntilBan > 29.5 * 24 * 3600 * 1000 && msUntilBan <= 30 * 24 * 3600 * 1000, `expected ~1 month ban, got ${msUntilBan}ms`);

    // 1month -> permanent, no expiry date
    expireBan(userRef, 'text');
    const toPermanent = await blockOnce(userRef);
    assert.equal(toPermanent.body.justBanned, true);
    assert.equal(toPermanent.body.tier, 'permanent');
    assert.equal(toPermanent.body.bannedUntil, null);
    status = await request(app).get(`/api/users/${userRef}/status`).set('Authorization', `Bearer ${token}`);
    text = status.body.modalities.text;
    assert.equal(text.maxTierReached, 'permanent');
    assert.equal(text.currentTier, 'permanent');
    assert.equal(text.isBanned, true);
    assert.equal(text.bannedUntil, null);
  });

  test('permanent is the ceiling: it never expires and a further report is still rejected', async () => {
    const userRef = 'user-flow-permanent-ceiling';
    db.prepare(
      `INSERT INTO user_status (user_ref, text_tier, text_banned_until) VALUES (?, 'permanent', NULL)`
    ).run(userRef);

    const res = await request(app)
      .post('/api/decisions')
      .set('x-api-key', 'test-ingest-key')
      .send(validDecisionPayload({ userRef, decision: 'ALLOWED', score: 0.1 }));
    assert.equal(res.status, 403);

    const status = await request(app)
      .get(`/api/users/${userRef}/status`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(status.body.modalities.text.isBanned, true);
    assert.equal(status.body.modalities.text.bannedUntil, null);
  });

  test('the three modalities keep fully independent tier histories for the same user', async () => {
    const userRef = 'user-flow-independence';
    await blockNTimes(userRef, 3, { modality: 'text' });
    await blockNTimes(userRef, 2, { modality: 'image', policyId: 'SIFEDGE-IMG-POL-01' });
    // audio gets only one warning, never banned.
    await blockOnce(userRef, { modality: 'audio', policyId: 'SIFEDGE-AUDIO-POL-01' });

    const status = await request(app)
      .get(`/api/users/${userRef}/status`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(status.body.modalities.text.maxTierReached, '1h');
    assert.equal(status.body.modalities.image.maxTierReached, '1h');
    assert.equal(status.body.modalities.audio.maxTierReached, 'none');
    assert.equal(status.body.modalities.audio.warningCount, 1);
    assert.equal(status.body.modalities.audio.isBanned, false);
  });

  test('WARNED_BY_HUMAN reported directly to /api/decisions never counts toward warnings or bans', async () => {
    const userRef = 'user-flow-human-decision';
    for (let i = 0; i < 10; i++) {
      const res = await request(app)
        .post('/api/decisions')
        .set('x-api-key', 'test-ingest-key')
        .send(validDecisionPayload({ userRef, decision: 'WARNED_BY_HUMAN', score: 0.7 }));
      assert.equal(res.status, 201);
      assert.equal(res.body.justBanned, false);
    }
    const status = await request(app)
      .get(`/api/users/${userRef}/status`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(status.body.modalities.text.warningCount, 0);
    assert.equal(status.body.modalities.text.maxTierReached, 'none');
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

  test('a human "confirm" on a pending review is logged but never counts as a warning (fully automated escalation only)', async () => {
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
    assert.equal(resolve.body.status.modalities.text.warningCount, 0);

    const status = await request(app)
      .get(`/api/users/${userRef}/status`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(status.body.modalities.text.warningCount, 0);
    assert.equal(status.body.modalities.text.maxTierReached, 'none');
  });
});
