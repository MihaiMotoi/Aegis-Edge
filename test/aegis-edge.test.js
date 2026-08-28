import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AegisEdge } from '../src/aegis-edge.js';

/**
 * The constructor always kicks off _loadModels(), which dynamically imports
 * transformers.js from a CDN — something that always rejects offline/in
 * Node (no --experimental-network-imports, no network needed to see that).
 * These tests never call ready()/_loadModels' result; they inject mock
 * classifiers directly onto the instance's internal fields instead. We
 * still swallow that rejection here so it doesn't surface as an unhandled
 * promise rejection (Node terminates the process on those by default).
 *
 * The SDK has no public dependency-injection hook for classifiers today —
 * these are plain (non-#-private) fields, so reaching into them is the
 * only way to unit-test the routing/warning/hashing logic without a real
 * model. Worth revisiting with a constructor-level injection API if the
 * SDK grows more tests like this.
 */
function createGuard(opts = {}) {
  const guard = new AegisEdge(opts);
  guard._readyPromise.catch(() => {});
  return guard;
}

function mockTextClassifier(score) {
  return async () => [{ label: 'toxic', score }, { label: 'neutral', score: 1 - score }];
}

// Never actually read in the private-channel tests (the gate returns before
// any Blob/URL handling), so a plain object stands in fine.
const fakeBlob = {};

describe('private channel gate', () => {
  test('checkText/checkImage/checkAudio return null and never call a classifier', async () => {
    let calls = 0;
    const guard = createGuard({ channelContext: 'private' });
    guard._textClassifier = async () => { calls++; return [{ label: 'toxic', score: 0.99 }]; };
    guard._imgClassifier = async () => { calls++; return [{ label: 'nsfw', score: 0.99 }]; };
    guard._audioTranscriber = async () => { calls++; return { text: 'x' }; };
    guard._audioEmotionClassifier = async () => { calls++; return [{ label: 'angry', score: 0.99 }]; };

    const textResult = await guard.checkText('anything');
    const imageResult = await guard.checkImage(fakeBlob);
    const audioResult = await guard.checkAudio(fakeBlob);

    assert.equal(textResult, null);
    assert.equal(imageResult, null);
    assert.equal(audioResult, null);
    assert.equal(calls, 0, 'no classifier should ever be invoked on a private channel');
  });
});

describe('3-band routing', () => {
  test('score below lowThreshold -> ALLOWED', async () => {
    const guard = createGuard({ channelContext: 'public', lowThreshold: 0.55, highThreshold: 0.9 });
    guard._textClassifier = mockTextClassifier(0.2);
    const result = await guard.checkText('hello');
    assert.equal(result.decision, 'ALLOWED');
  });

  test('score between thresholds -> PENDING_REVIEW and onPendingReview fires', async () => {
    let reviewItem = null;
    const guard = createGuard({
      channelContext: 'public',
      lowThreshold: 0.55,
      highThreshold: 0.9,
      onPendingReview: (item) => { reviewItem = item; },
    });
    guard._textClassifier = mockTextClassifier(0.7);
    const result = await guard.checkText('hmm');
    assert.equal(result.decision, 'PENDING_REVIEW');
    assert.ok(reviewItem, 'onPendingReview should have been called');
    assert.equal(reviewItem.id, result.reviewId);
  });

  test('score at/above highThreshold -> BLOCKED', async () => {
    const guard = createGuard({ channelContext: 'public', lowThreshold: 0.55, highThreshold: 0.9 });
    guard._textClassifier = mockTextClassifier(0.95);
    const result = await guard.checkText('bad');
    assert.equal(result.decision, 'BLOCKED');
  });
});

describe('warning counter', () => {
  test('a PENDING_REVIEW case does not increment warnCount until a human resolves it', async () => {
    const guard = createGuard({ channelContext: 'public' });
    guard._textClassifier = mockTextClassifier(0.7); // falls in the default review band
    await guard.checkText('hmm');
    assert.equal(guard.warnCount, 0);
    assert.equal(guard.getStats().pendingReview, 1);
  });

  test('resolveReview("confirm") increments warnCount; "dismiss" does not', async () => {
    const guard = createGuard({ channelContext: 'public' });
    guard._textClassifier = mockTextClassifier(0.7);

    const r1 = await guard.checkText('a');
    await guard.resolveReview(r1.reviewId, 'dismiss');
    assert.equal(guard.warnCount, 0);

    const r2 = await guard.checkText('b');
    await guard.resolveReview(r2.reviewId, 'confirm');
    assert.equal(guard.warnCount, 1);
  });

  test('the 3rd confirmed warning blocks the guard; further checks become no-ops', async () => {
    let thresholdReached = false;
    const guard = createGuard({
      channelContext: 'public',
      maxWarnings: 3,
      onWarningThresholdReached: () => { thresholdReached = true; },
    });
    // BLOCKED results are auto-confirmed warnings by design (see the SDK's
    // module docstring: "auto-blocked, or human-confirmed ... count toward
    // a shared 3-strike counter"), so three BLOCKED checks exercise the
    // same _registerWarning() path as three resolveReview('confirm') calls.
    guard._textClassifier = mockTextClassifier(0.95);

    await guard.checkText('1');
    await guard.checkText('2');
    assert.equal(guard.isBlocked(), false);
    await guard.checkText('3');

    assert.equal(guard.warnCount, 3);
    assert.equal(guard.isBlocked(), true);
    assert.equal(thresholdReached, true);

    const result = await guard.checkText('4');
    assert.equal(result, null, 'checks after the warning cap must be a no-op');
  });
});

describe('proof hash', () => {
  test('is deterministic for the same content and differs when the decision differs', async () => {
    const guard = createGuard({ channelContext: 'public' });
    const proof = {
      inputHash: 'abc123',
      score: 0.7,
      timestamp: '2024-01-01T00:00:00.000Z',
      policyId: 'P',
      channelContext: 'public',
      modality: 'text',
    };

    const h1 = await guard._sha256Hex(JSON.stringify({ ...proof, decision: 'ALLOWED' }));
    const h2 = await guard._sha256Hex(JSON.stringify({ ...proof, decision: 'ALLOWED' }));
    const h3 = await guard._sha256Hex(JSON.stringify({ ...proof, decision: 'BLOCKED' }));

    assert.equal(h1, h2);
    assert.notEqual(h1, h3);
  });
});

describe('setChannelContext', () => {
  test('rejects invalid values', () => {
    const guard = createGuard({ channelContext: 'public' });
    assert.throws(() => guard.setChannelContext('invalid'), /channelContext must be/);
    assert.equal(guard.channelContext, 'public', 'an invalid value must not partially apply');
  });
});
