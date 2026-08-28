<div align="center">

# Aegis Edge

**On-device content safety for chat, images, and voice.**

Text, image, and audio moderation that runs entirely in the browser.
No content ever leaves the user's device — only a decision and a hash do.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![CI](https://github.com/MihaiMotoi/Aegis-Edge/actions/workflows/test.yml/badge.svg)](https://github.com/MihaiMotoi/Aegis-Edge/actions/workflows/test.yml)

</div>

---

## What it does

Aegis Edge checks user-generated content for abuse and returns a decision your
platform can act on:

| Input | What's checked | Model |
|---|---|---|
| **Text** | toxicity, insults, threats, hate speech — **15 languages** | multilingual BERT classifier (converted to ONNX, see setup) |
| **Images** | explicit / NSFW content | `onnx-community/nsfw_image_detection-ONNX` |
| **Audio** | *what was said* (transcript → toxicity) **and** *how it was said* (vocal aggression) | `Xenova/whisper-tiny.en` + `wav2vec2` speech-emotion |

Every check returns one of three outcomes:

- **`ALLOWED`** — below the concern threshold, passes through.
- **`PENDING_REVIEW`** — ambiguous confidence. **Never auto-actioned.** Routed
  to a human reviewer instead.
- **`BLOCKED`** — high confidence, actioned automatically.

Confirmed violations (auto-blocked, or human-confirmed from the review queue)
count toward a shared 3-strike counter, after which the user is suspended.

## Why it's different

**Nothing leaves the device.** Text, images and audio are classified in the
browser via [transformers.js](https://github.com/xenova/transformers.js). Your
server receives only: a decision, a score, a SHA-256 hash of the input, and an
opaque user reference. It has no field that could accidentally store raw
content — because raw content is never sent.

**Every decision is provable.** Each decision produces a SHA-256 proof hash
over `{inputHash, decision, score, timestamp, policyId, context}`. Auto and
human decisions are hashed and logged identically, so you can demonstrate
*what* was decided, *when*, and *by whom* — useful when a moderation call is
challenged after the fact.

**Private channels are architecturally off-limits.** Set
`channelContext: 'private'` (1:1 DMs, private calls) and the classifiers are
never invoked — no scoring, no hashing, no logging. This is a hard gate in
code, not a configuration flag, because monitoring private two-party
communication without both parties' consent is unlawful in most
jurisdictions regardless of intent.

**Human in the loop by default.** Mid-confidence detections don't produce
automated warnings. They wait for a reviewer. Only high-confidence, clear-cut
cases are actioned without a human.

## Quick start

```bash
git clone https://github.com/MihaiMotoi/Aegis-Edge.git
cd Aegis-Edge

# Downloads + converts + quantizes the multilingual text model (~5 min, one time)
./scripts/setup-models.sh

# Serve over HTTP (ES modules won't load from file://)
npx serve .
# then open http://localhost:3000/examples/demo.html
```

## Usage

```js
import { AegisEdge } from './src/aegis-edge.js';

const guard = new AegisEdge({
  channelContext: 'public',        // 'public' | 'private' — YOU set this, never the end user
  lowThreshold: 0.55,              // below -> allowed
  highThreshold: 0.90,             // above -> blocked; in between -> human review
  maxWarnings: 3,

  onDecision: (r) => {
    // r = { decision, score, modality, proofHash, timestamp, source, triggerLabel }
  },
  onPendingReview: (item) => {
    // route to your reviewer UI; resolve with guard.resolveReview(item.id, 'confirm'|'dismiss')
  },
  onWarningThresholdReached: () => {
    // 3 confirmed warnings — apply your suspension policy
  },
});

await guard.ready();

await guard.checkText('some message');
await guard.checkImage(fileOrBlob);
await guard.checkAudio(clipBlob);
```

Optionally report decisions to a server (see [`server/`](server/)):

```js
const guard = new AegisEdge({
  channelContext: 'public',
  backendUrl: 'http://localhost:8787',
  userRef: 'user-abc123',   // opaque id you control — no PII required
  // ...
});
```

## Examples

| File | What it shows |
|---|---|
| `examples/demo.html` | Full UI: context gate, text + image tabs, review queue, proof log |
| `examples/audio-demo.html` | Record or upload a clip — live transcript, content score, tone score |
| `examples/minimal-integration.html` | Smallest possible wiring, ~40 lines |

## Optional server

`server/` is a reference implementation of the pieces a real deployment needs
beyond the SDK: persistent review queue, moderator authentication, per-user
warning and suspension state, and an append-only decision log.

```bash
cd server
npm install
node src/server.js     # http://localhost:8787
# open server/public/dashboard.html
```

Default seeded moderator is `admin@aegis-edge.local` / `changeme123` — **change
this before any real use**, along with the JWT secret (both are flagged in the
source).

## Language coverage

The text classifier is officially trained and evaluated on 15 languages:
English, French, Italian, Spanish, Russian, Ukrainian, Tatar, Arabic, Hindi,
Japanese, Chinese, Hebrew, Amharic, German, Hinglish. Reported F1 varies
considerably by language (en 0.90, ru 0.92, uk 0.95, fr 0.91 at the top;
ar 0.51, de 0.52 at the bottom) — check the
[base model card](https://huggingface.co/textdetox/bert-multilingual-toxicity-classifier)
before relying on a specific one.

Languages outside that list are **best-effort, not supported**. Romanian, for
instance, was tested despite being untrained: direct slurs scored well (0.99),
but softer insults and indirect threats were frequently missed (0.20–0.43).
Don't assume coverage you haven't measured.

Image NSFW detection and the audio vocal-tone signal are language-independent.

## Not built yet

- **Live/streaming video** — frame sampling of an ongoing call.
- **External reporting integration** — for confirmed severe cases (e.g.
  CSAM), your compliance process should be the recipient. Aegis Edge is
  designed to be the *trigger*, never the custodian of such evidence.
- **Production secrets management** in the reference server.

## Running tests

The SDK's decision logic (routing, thresholds, warning counter, private-channel
gate, proof hashing) is covered by unit tests that inject mock classifiers —
no model download required, runs in under a second.

```bash
npm test
```

## Contributing

Issues and pull requests welcome. Areas that would help most: additional
language coverage, a live-video sampling module, and reviewer-side tooling.

## License

Apache 2.0 — see [LICENSE](LICENSE). The SDK and reference server in this
repository are free to use, including commercially.
