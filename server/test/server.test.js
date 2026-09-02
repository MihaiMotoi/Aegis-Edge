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

describe('warning + suspension flow', () => {
  let token;
  before(async () => {
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@test.local', password: 'test-admin-pw-123' });
    token = login.body.token;
  });

  test('three BLOCKED decisions suspend the user', async () => {
    const userRef = 'user-flow-1';
    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post('/api/decisions')
        .set('x-api-key', 'test-ingest-key')
        .send(validDecisionPayload({ userRef, decision: 'BLOCKED', score: 0.95 }));
      assert.equal(res.status, 201);
    }
    const status = await request(app)
      .get(`/api/users/${userRef}/status`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(status.body.warningCount, 3);
    assert.equal(status.body.isSuspended, true);
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
    assert.equal(status.body.warningCount, 0);
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
    assert.equal(status.body.warningCount, 1);
  });
});
