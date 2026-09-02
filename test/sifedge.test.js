import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SifEdge } from '../src/sifedge.js';

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
  const guard = new SifEdge(opts);
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

describe('model swapping — _resolveModelSpec', () => {
  test('"default" and omitted both resolve to the built-in model + options, per slot', () => {
    const guard = createGuard();
    for (const override of [undefined, 'default']) {
      assert.deepEqual(guard._resolveModelSpec('text', override), {
        id: 'multilingual-toxicity',
        options: { quantized: true, local_files_only: true },
      });
      assert.deepEqual(guard._resolveModelSpec('image', override), {
        id: 'onnx-community/nsfw_image_detection-ONNX',
        options: {},
      });
      assert.deepEqual(guard._resolveModelSpec('audioTranscription', override), {
        id: 'Xenova/whisper-tiny.en',
        options: {},
      });
      assert.deepEqual(guard._resolveModelSpec('audioEmotion', override), {
        id: 'onnx-community/wav2vec2-base-Speech_Emotion_Recognition-ONNX',
        options: {},
      });
    }
  });

  test('a Hugging Face Hub id (with or without an org prefix) is loaded from the Hub — no local_files_only', () => {
    const guard = createGuard();
    assert.deepEqual(guard._resolveModelSpec('text', 'my-org/my-model'), {
      id: 'my-org/my-model',
      options: {},
    });
    // Single-segment ids (e.g. 'gpt2') are also valid Hub ids, not local paths.
    assert.deepEqual(guard._resolveModelSpec('text', 'my-standalone-model'), {
      id: 'my-standalone-model',
      options: {},
    });
  });

  test('a local path (./, ../, /, ~/, file:, or a Windows drive letter) is loaded with local_files_only: true', () => {
    const guard = createGuard();
    const localPaths = [
      './models/my-model',
      '../shared-models/my-model',
      '/opt/models/my-model',
      '~/models/my-model',
      'file:///opt/models/my-model',
      'C:\\models\\my-model',
    ];
    for (const p of localPaths) {
      assert.deepEqual(guard._resolveModelSpec('image', p), { id: p, options: { local_files_only: true } });
    }
  });

  test('an override applies independently per model slot, leaving the others at their defaults', () => {
    const guard = createGuard();
    const textSpec = guard._resolveModelSpec('text', 'my-org/my-model');
    const imageSpec = guard._resolveModelSpec('image', 'default');
    assert.equal(textSpec.id, 'my-org/my-model');
    assert.equal(imageSpec.id, 'onnx-community/nsfw_image_detection-ONNX');
  });
});

describe('model swapping — _loadModels end-to-end (data: URL mock of transformers.js)', () => {
  test('constructs pipeline() calls with the resolved id/options for each model slot, honoring the models config', async () => {
    // A real `import(transformersUrl)` still runs here — data: URLs are
    // valid ES module specifiers in Node — it's only the *content* being
    // imported that's a mock, so this exercises the actual _loadModels
    // code path (env setup, _resolveModelSpec wiring, Promise.all), not a
    // stand-in for it.
    const mockModuleSrc = `
      export function pipeline(task, id, options) {
        globalThis.__sifedgeMockCalls.push({ task, id, options });
        return Promise.resolve({ task, id });
      }
      export const env = {};
      export class RawImage {}
    `;
    const dataUrl = 'data:text/javascript,' + encodeURIComponent(mockModuleSrc);
    globalThis.__sifedgeMockCalls = [];

    const guard = new SifEdge({
      transformersUrl: dataUrl,
      models: {
        text: 'my-org/my-model', // Hub id -> loaded from Hub, no local_files_only
        image: 'default',
        audioTranscription: './local-models/whisper-custom', // local path -> local_files_only
        // audioEmotion omitted -> default
      },
    });

    await guard.ready();
    const calls = globalThis.__sifedgeMockCalls;
    delete globalThis.__sifedgeMockCalls;

    assert.equal(calls.length, 4);

    const textCall = calls.find(c => c.task === 'text-classification');
    assert.equal(textCall.id, 'my-org/my-model');
    assert.deepEqual(textCall.options, {});

    const imageCall = calls.find(c => c.task === 'image-classification');
    assert.equal(imageCall.id, 'onnx-community/nsfw_image_detection-ONNX');
    assert.deepEqual(imageCall.options, {});

    const transcriptionCall = calls.find(c => c.task === 'automatic-speech-recognition');
    assert.equal(transcriptionCall.id, './local-models/whisper-custom');
    assert.deepEqual(transcriptionCall.options, { local_files_only: true });

    const emotionCall = calls.find(c => c.task === 'audio-classification');
    assert.equal(emotionCall.id, 'onnx-community/wav2vec2-base-Speech_Emotion_Recognition-ONNX');
    assert.deepEqual(emotionCall.options, {});
  });

  test('with no `models` option at all, every slot loads its default id/options unchanged', async () => {
    const mockModuleSrc = `
      export function pipeline(task, id, options) {
        globalThis.__sifedgeMockCalls2.push({ task, id, options });
        return Promise.resolve({ task, id });
      }
      export const env = {};
      export class RawImage {}
    `;
    const dataUrl = 'data:text/javascript,' + encodeURIComponent(mockModuleSrc);
    globalThis.__sifedgeMockCalls2 = [];

    const guard = new SifEdge({ transformersUrl: dataUrl });
    await guard.ready();
    const calls = globalThis.__sifedgeMockCalls2;
    delete globalThis.__sifedgeMockCalls2;

    const textCall = calls.find(c => c.task === 'text-classification');
    assert.equal(textCall.id, 'multilingual-toxicity');
    assert.deepEqual(textCall.options, { quantized: true, local_files_only: true });
  });
});

describe('_maxToxicityScore — binary model (bundled default shape)', () => {
  test('reads the explicit "toxic" label directly, ignoring "neutral"', () => {
    const guard = createGuard();
    const score = guard._maxToxicityScore([{ label: 'toxic', score: 0.82 }, { label: 'neutral', score: 0.18 }]);
    assert.equal(score, 0.82);
    assert.equal(guard._lastToxicLabel, 'toxic');
  });

  test('"toxicity" (not just "toxic") is also recognized as the explicit label', () => {
    const guard = createGuard();
    const score = guard._maxToxicityScore([{ label: 'toxicity', score: 0.6 }, { label: 'clean', score: 0.4 }]);
    assert.equal(score, 0.6);
    assert.equal(guard._lastToxicLabel, 'toxicity');
  });
});

describe('_maxToxicityScore — multi-label model (e.g. 6-label toxic-bert style)', () => {
  test('with no explicit toxic/toxicity label, takes the max across abuse labels and reports which triggered', () => {
    const guard = createGuard();
    const score = guard._maxToxicityScore([
      { label: 'insult', score: 0.31 },
      { label: 'threat', score: 0.87 },
      { label: 'obscene', score: 0.12 },
      { label: 'identity_hate', score: 0.05 },
    ]);
    assert.equal(score, 0.87);
    assert.equal(guard._lastToxicLabel, 'threat');
  });

  test('a neutral/clean label is never picked as the toxicity score, even if it has the highest raw score', () => {
    const guard = createGuard();
    const score = guard._maxToxicityScore([
      { label: 'insult', score: 0.2 },
      { label: 'threat', score: 0.1 },
      { label: 'neutral', score: 0.95 },
    ]);
    assert.equal(score, 0.2);
    assert.equal(guard._lastToxicLabel, 'insult');
  });

  test('an explicit "toxic" label present alongside specific abuse labels wins over the max (matches binary-model semantics)', () => {
    const guard = createGuard();
    const score = guard._maxToxicityScore([
      { label: 'toxic', score: 0.5 },
      { label: 'severe_toxic', score: 0.05 },
      { label: 'obscene', score: 0.9 }, // higher, but 'toxic' takes priority
      { label: 'threat', score: 0.1 },
      { label: 'insult', score: 0.2 },
      { label: 'identity_hate', score: 0.05 },
    ]);
    assert.equal(score, 0.5);
    assert.equal(guard._lastToxicLabel, 'toxic');
  });

  test('all-neutral results score 0 rather than picking a neutral label as toxicity', () => {
    const guard = createGuard();
    const score = guard._maxToxicityScore([{ label: 'clean', score: 0.99 }, { label: 'non-toxic', score: 0.01 }]);
    assert.equal(score, 0);
  });
});

describe('model swapping — end to end with a mock multi-label classifier', () => {
  test('checkText routes on the max abuse label and surfaces it as triggerLabel', async () => {
    const guard = createGuard({ channelContext: 'public', lowThreshold: 0.55, highThreshold: 0.9 });
    guard._textClassifier = async () => [
      { label: 'insult', score: 0.3 },
      { label: 'threat', score: 0.95 },
      { label: 'obscene', score: 0.1 },
      { label: 'identity_hate', score: 0.05 },
    ];
    const result = await guard.checkText('some text');
    assert.equal(result.decision, 'BLOCKED');
    assert.equal(result.triggerLabel, 'threat');
  });
});
