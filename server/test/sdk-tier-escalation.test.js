import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Exercises the full tier ladder (warnings -> 1h -> 24h -> 1month ->
// permanent) through the real SDK talking to a real, live server — the
// ladder itself lives server-side (server/src/server.js), but this is the
// one place that also verifies the SDK's own responsibilities on top of it:
// firing onSuspension with the right (modality, tier, bannedUntil) at every
// tier, gating checks locally once banned, and keeping the three
// modalities' histories fully independent for the same user.
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.INGEST_API_KEY = 'test-ingest-key';
process.env.DB_PATH = ':memory:';
process.env.SEED_ADMIN_EMAIL = 'admin@test.local';
process.env.SEED_ADMIN_PASSWORD = 'test-admin-pw-123';

await import('../src/env-check.js');
const { default: app } = await import('../src/server.js');
const { default: db } = await import('../src/db.js');
const { SifEdge } = await import('../../src/sifedge.js');

// checkImage creates an object URL — a real browser API Node doesn't have,
// and Node 20+'s built-in URL.createObjectURL insists on an actual Blob
// instance, which the plain fake-file objects below aren't. Overridden for
// these tests only; checkImage never reads the URL it returns here.
globalThis.URL.createObjectURL = () => 'blob:fake';

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

/**
 * _route() fires the backend report without awaiting it (fire-and-forget —
 * see src/sifedge.js), so checkText/checkImage/checkAudio can resolve
 * before onSuspension has been called for that same decision. Wrapping
 * _reportToBackend here captures the in-flight promise synchronously (the
 * assignment happens before _route's own call returns, since JS only
 * suspends an async function at its first `await`), so tests can await
 * guard._waitForLastReport() right after a check to know onSuspension (if
 * any) has already had its chance to fire.
 */
function createGuard(opts) {
  const guard = new SifEdge(opts);
  guard._readyPromise.catch(() => {});
  const originalReport = guard._reportToBackend.bind(guard);
  let lastReport = Promise.resolve();
  guard._reportToBackend = (payload) => {
    lastReport = originalReport(payload);
    return lastReport;
  };
  guard._waitForLastReport = () => lastReport;
  return guard;
}

async function checkTextSettled(guard, text) {
  const result = await guard.checkText(text);
  await guard._waitForLastReport();
  return result;
}

async function checkImageSettled(guard, fileOrBlob) {
  const result = await guard.checkImage(fileOrBlob);
  await guard._waitForLastReport();
  return result;
}

function expireBan(userRef, modality) {
  db.prepare(`UPDATE user_status SET ${modality}_banned_until = datetime('now', '-1 minute') WHERE user_ref = ?`).run(userRef);
}

describe('full tier ladder through the SDK against a live server', () => {
  test('text: 2 BLOCKED only warn (no onSuspension), the 3rd bans for 1h and fires onSuspension(text, "1h", <date>)', async () => {
    const userRef = 'ladder-text-' + Date.now();
    const suspensions = [];
    const guard = createGuard({
      channelContext: 'public',
      backendUrl: baseUrl,
      userRef,
      ingestApiKey: 'test-ingest-key',
      onSuspension: (modality, tier, bannedUntil) => suspensions.push({ modality, tier, bannedUntil }),
    });
    guard._textClassifier = async () => [{ label: 'toxic', score: 0.95 }];

    await checkTextSettled(guard, '1');
    await checkTextSettled(guard, '2');
    assert.equal(suspensions.length, 0, 'no ban yet after 2 of 3');
    assert.equal(guard.isBlocked('text'), false);

    const third = await checkTextSettled(guard, '3');
    assert.equal(third.decision, 'BLOCKED');
    assert.equal(suspensions.length, 1);
    assert.equal(suspensions[0].modality, 'text');
    assert.equal(suspensions[0].tier, '1h');
    assert.ok(suspensions[0].bannedUntil, '1h ban must carry a concrete expiry');

    guard._banStatusFetchedAt = 0;
    assert.equal(guard.isBlocked('text'), true);
    const gated = await guard.checkText('one more');
    assert.equal(gated, null, 'the now-banned modality must reject locally');
  });

  test('image: 1 BLOCKED only warns with shouldBlur, the 2nd bans for 1h and fires onSuspension(image, "1h", <date>)', async () => {
    const userRef = 'ladder-image-' + Date.now();
    const suspensions = [];
    const guard = createGuard({
      channelContext: 'public',
      backendUrl: baseUrl,
      userRef,
      ingestApiKey: 'test-ingest-key',
      onSuspension: (modality, tier, bannedUntil) => suspensions.push({ modality, tier, bannedUntil }),
    });
    guard._imgClassifier = async () => [{ label: 'nsfw', score: 0.95 }];
    guard._RawImage = { fromURL: async () => ({}) };
    const fakeFile = { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };

    const first = await checkImageSettled(guard, fakeFile);
    assert.equal(first.decision, 'BLOCKED');
    assert.equal(first.shouldBlur, true);
    assert.equal(suspensions.length, 0, 'image gets exactly one warning before its ban');

    const second = await checkImageSettled(guard, fakeFile);
    assert.equal(second.decision, 'BLOCKED');
    assert.equal(second.shouldBlur, true, 'shouldBlur must fire on the banning offense too, not just the first');
    assert.equal(suspensions.length, 1);
    assert.deepEqual({ modality: suspensions[0].modality, tier: suspensions[0].tier }, { modality: 'image', tier: '1h' });
  });

  test('escalates 1h -> 24h -> 1month -> permanent, firing onSuspension with the right tier and bannedUntil each time, and never re-warns', async () => {
    const userRef = 'ladder-escalate-' + Date.now();
    const suspensions = [];
    const guard = createGuard({
      channelContext: 'public',
      backendUrl: baseUrl,
      userRef,
      ingestApiKey: 'test-ingest-key',
      onSuspension: (modality, tier, bannedUntil) => suspensions.push({ modality, tier, bannedUntil }),
    });
    guard._textClassifier = async () => [{ label: 'toxic', score: 0.95 }];

    // Reach the first ban (1h) the normal way: 3 BLOCKED.
    await checkTextSettled(guard, '1');
    await checkTextSettled(guard, '2');
    await checkTextSettled(guard, '3');
    assert.equal(suspensions.length, 1);
    assert.equal(suspensions[0].tier, '1h');

    // 1h -> 24h: expire the ban server-side, force the SDK to re-check, then
    // exactly ONE more BLOCKED must jump straight to 24h — no re-warning.
    expireBan(userRef, 'text');
    guard._banStatusFetchedAt = 0;
    await guard._ensureFreshBanStatus(); // isBlocked() itself doesn't refresh — force it here
    assert.equal(guard.isBlocked('text'), false, 'the expired 1h ban must no longer gate checks');
    await checkTextSettled(guard, '4');
    assert.equal(suspensions.length, 2);
    assert.equal(suspensions[1].tier, '24h');
    assert.ok(suspensions[1].bannedUntil);

    // 24h -> 1month
    expireBan(userRef, 'text');
    guard._banStatusFetchedAt = 0;
    await checkTextSettled(guard, '5');
    assert.equal(suspensions.length, 3);
    assert.equal(suspensions[2].tier, '1month');
    assert.ok(suspensions[2].bannedUntil);

    // 1month -> permanent, no expiry.
    expireBan(userRef, 'text');
    guard._banStatusFetchedAt = 0;
    await checkTextSettled(guard, '6');
    assert.equal(suspensions.length, 4);
    assert.equal(suspensions[3].tier, 'permanent');
    assert.equal(suspensions[3].bannedUntil, null);

    // Permanent must gate correctly even though bannedUntil is null — this
    // is exactly the case _isModalityBanned has to get right (no expiry to
    // compare against, but still banned).
    guard._banStatusFetchedAt = 0;
    assert.equal(guard.isBlocked('text'), true);
    const gated = await guard.checkText('7');
    assert.equal(gated, null);
  });

  test('the three modalities keep fully independent histories through the SDK for the same user', async () => {
    const userRef = 'ladder-independence-' + Date.now();
    const suspensions = [];
    const guard = createGuard({
      channelContext: 'public',
      backendUrl: baseUrl,
      userRef,
      ingestApiKey: 'test-ingest-key',
      onSuspension: (modality, tier) => suspensions.push({ modality, tier }),
    });
    guard._textClassifier = async () => [{ label: 'toxic', score: 0.95 }];
    guard._imgClassifier = async () => [{ label: 'nsfw', score: 0.95 }];
    guard._RawImage = { fromURL: async () => ({}) };
    const fakeFile = { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };

    // Ban text fully (3 strikes).
    await checkTextSettled(guard, '1');
    await checkTextSettled(guard, '2');
    await checkTextSettled(guard, '3');
    // Warn image once, don't ban it.
    await checkImageSettled(guard, fakeFile);

    guard._banStatusFetchedAt = 0;
    assert.equal(guard.isBlocked('text'), true);
    assert.equal(guard.isBlocked('image'), false);
    assert.equal(guard.isBlocked('audio'), false, 'audio was never touched');
    assert.deepEqual(suspensions, [{ modality: 'text', tier: '1h' }]);

    const stats = guard.getStats();
    assert.equal(stats.modalities.image.warningCount, 1);
    assert.equal(stats.modalities.audio.warningCount, 0);
  });
});
