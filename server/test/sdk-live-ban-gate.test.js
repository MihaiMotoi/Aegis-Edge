import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

// This suite starts the real server on a real (ephemeral) port and drives a
// real SifEdge instance against it over actual fetch() calls — unlike
// server.test.js (supertest against the app object directly) and
// test/sifedge.test.js (SDK-only, no backend, mocked classifiers), this is
// the one place that exercises both together, which is exactly what the
// scenario under test needs: the SDK re-checking ban status against a live
// server mid-session, not just at construction.
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.INGEST_API_KEY = 'test-ingest-key';
process.env.DB_PATH = ':memory:';
process.env.SEED_ADMIN_EMAIL = 'admin@test.local';
process.env.SEED_ADMIN_PASSWORD = 'test-admin-pw-123';

await import('../src/env-check.js');
const { default: app } = await import('../src/server.js');
const { SifEdge } = await import('../../src/sifedge.js');

let httpServer;
let baseUrl;

before(async () => {
  httpServer = app.listen(0);
  await new Promise((resolve) => httpServer.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

after(() => {
  httpServer.close();
});

// _loadModels() always dynamically imports transformers.js from a CDN,
// which rejects offline — swallowed here for the same reason
// test/sifedge.test.js swallows it: these tests inject a mock
// _textClassifier directly instead of ever calling ready().
function createGuard(opts) {
  const guard = new SifEdge(opts);
  guard._readyPromise.catch(() => {});
  return guard;
}

async function postRawDecision(userRef, overrides = {}) {
  return fetch(`${baseUrl}/api/decisions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': 'test-ingest-key' },
    body: JSON.stringify({
      userRef,
      channelContext: 'public',
      modality: 'text',
      decision: 'BLOCKED',
      score: 0.95,
      inputHash: 'a'.repeat(64),
      proofHash: 'b'.repeat(64),
      policyId: 'SIFEDGE-TEXT-POL-02',
      ...overrides,
    }),
  });
}

describe('SDK re-checks ban status against a live server mid-session', () => {
  test('a ban applied by activity outside this SDK instance is caught on the next check, with zero classifier calls', async () => {
    const userRef = 'live-ban-user-1';
    const guard = createGuard({
      channelContext: 'public',
      backendUrl: baseUrl,
      userRef,
      ingestApiKey: 'test-ingest-key',
    });

    let calls = 0;
    guard._textClassifier = async () => { calls++; return [{ label: 'toxic', score: 0.1 }]; };

    // Not banned yet: the classifier runs normally.
    const before1 = await guard.checkText('hello');
    assert.equal(before1.decision, 'ALLOWED');
    assert.equal(calls, 1);
    assert.equal(guard.isBlocked('text'), false);

    // Ban this userRef on 'text' via three raw reports sent directly to the
    // server with fetch — deliberately NOT through `guard`, so nothing about
    // this specific SDK instance's own report flow is what surfaces the ban.
    // This is the scenario the bug report described: a moderator action, or
    // another tab/device for the same userRef, banning the user while this
    // page stays open and this SDK instance never sends a report itself.
    for (let i = 0; i < 3; i++) {
      const res = await postRawDecision(userRef, { proofHash: 'b'.repeat(63) + i });
      assert.equal(res.status, 201);
    }

    // Confirm the server really does consider this user banned now,
    // independent of the SDK under test.
    const banStatusRes = await fetch(`${baseUrl}/api/users/${userRef}/ban-status`, {
      headers: { 'x-api-key': 'test-ingest-key' },
    });
    const banStatus = await banStatusRes.json();
    assert.equal(banStatus.modalities.text.isBanned, true);

    // Force the SDK's cache to be treated as stale, simulating the cache
    // window elapsing, instead of a real 30s sleep in a unit test.
    guard._banStatusFetchedAt = 0;

    const after1 = await guard.checkText('one more try');
    assert.equal(after1, null, 'the now-banned modality must reject locally');
    assert.equal(calls, 1, 'the classifier must not run once banned, even mid-session, with no reconstruction');
    assert.equal(guard.isBlocked('text'), true);
  });
});
