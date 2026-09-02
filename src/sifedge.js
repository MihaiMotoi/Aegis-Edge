/**
 * SifEdge SDK — standalone, on-device content safety engine.
 *
 * STANDALONE: this file is fully self-contained. It has no external
 * dependencies beyond @xenova/transformers, and shares no code with any
 * other project.
 *
 * What this does:
 *   - Runs text + image + audio classification entirely in the browser (via
 *     @xenova/transformers, loading real Hugging Face models on first use).
 *     Audio combines two real signals: transcript-based toxicity (Whisper +
 *     the same text model) and vocal-tone aggression (a speech-emotion
 *     model) — the same two-signal approach commercial audio moderation
 *     tools use, run fully on-device here.
 *   - Enforces a hard channel-context gate: on 'private' context, the
 *     classifiers are never invoked, full stop.
 *   - Routes every decision into one of three bands: ALLOWED, PENDING_REVIEW
 *     (ambiguous confidence — never auto-actioned), or BLOCKED (high
 *     confidence).
 *   - Each modality (text, audio, image) has its own independent 3-strike
 *     warning counter and ban ladder — a BLOCKED result (auto, or a
 *     human-confirmed PENDING_REVIEW) counts as a strike for that modality
 *     only. 3 strikes bans that modality for 1 hour; if it happens again
 *     after that ban expires, the next ban is 24 hours — the ceiling, it
 *     never escalates past that. While a modality is banned, checks on it
 *     return null immediately, same as the private-channel gate, and never
 *     invoke that modality's classifier. Real, cross-session ban durations
 *     require a connected backend (see `backendUrl` below); without one,
 *     each modality falls back to a simplified in-memory version — 3
 *     strikes blocks that modality until the page reloads, no timed
 *     expiry, no escalation — since a real duration can't mean anything
 *     without somewhere to persist it.
 *   - Every BLOCKED image result also carries `shouldBlur: true`, so an
 *     integrator can blur it in the UI immediately — on the first offense,
 *     independent of the warning counter or any ban.
 *   - Produces a sha256 proof hash for every decision, in the same
 *     input-hash + decision + timestamp shape.
 *   - Never sends raw text or image bytes anywhere. The integrator's
 *     onDecision callback receives only: decision, score, proofHash,
 *     modality, timestamp. Raw content stays in the integrator's own page
 *     memory, under the integrator's own control.
 *
 * What this is NOT:
 *   - Not a moderator backend. Human-review resolution (confirm/dismiss) is
 *     exposed as functions the integrator wires to their own reviewer UI —
 *     this SDK has no accounts, no auth, no server.
 *   - Not an external-reporting integration (no NCMEC-equivalent wiring).
 *     Confirmed severe cases should trigger the integrator's own compliance
 *     process; SifEdge is the trigger, never the evidence custodian.
 *   - Not live-video capable yet (audio and image are; live/streaming video
 *     frame sampling is the one modality still undone).
 *
 * LANGUAGE COVERAGE — text/audio-content classifier: officially trained
 * and evaluated on 15 languages (en, fr, it, es, ru, uk, tt, ar, hi, ja,
 * zh, he, am, de, hin) — converted here from
 * textdetox/bert-multilingual-toxicity-classifier, which had no ONNX
 * build on the Hub, so it was exported to ONNX and quantized (711MB ->
 * 171MB) and is bundled locally in ./models/multilingual-toxicity/ rather
 * than loaded from the Hub. Romanian is NOT in the official training set,
 * but live-tested anyway for honesty: results were mixed — clear slurs and
 * direct insults ("du-te dracu de idiot" -> 0.998, "esti un nenorocit" ->
 * 0.909) were caught well, but softer insults and indirect threats scored
 * low ("taci din gura, prostule" -> 0.431, "te omor daca mai faci asta" ->
 * 0.204, "voi toti sunteti niste gunoaie" -> 0.311) — noticeably better
 * than the old English-only model on Romanian, but not reliable enough to
 * claim as supported. Treat the 15 listed languages as the supported set;
 * Romanian and any other unlisted language should be treated as
 * best-effort, not guaranteed. (Image NSFW detection and the audio
 * vocal-tone signal are language-independent and unaffected by any of
 * this.)
 *
 * Usage:
 *   <script type="module">
 *     import { SifEdge } from './sifedge.js';
 *
 *     const guard = new SifEdge({
 *       channelContext: 'public',        // 'public' | 'private' — set by YOU, never by end user
 *       lowThreshold: 0.55,
 *       highThreshold: 0.90,
 *       maxWarnings: 3,                        // strikes per modality, not shared
 *       onDecision: (result) => { ... },       // every checked item — result.shouldBlur is true on a BLOCKED image
 *       onPendingReview: (item) => { ... },     // ambiguous items needing a human call
 *       onWarningThresholdReached: (modality) => { ... }, // that modality just got banned (1h, then 24h on repeat)
 *       onImageBanNotice: () => { ... }         // image hit its 24h ban — send a text-channel notice yourself
 *     });
 *
 *     await guard.ready();                       // wait for models to load
 *     const result = await guard.checkText(text);
 *     const result = await guard.checkImage(fileOrBlob);  // result.shouldBlur === true when BLOCKED
 *     const result = await guard.checkAudio(fileOrBlob);  // short recording/clip
 *
 *     // for a pending-review item returned via onPendingReview(item):
 *     guard.resolveReview(item.id, 'confirm');   // -> counts as a warning for that item's modality
 *     guard.resolveReview(item.id, 'dismiss');   // -> treated as allowed
 *
 * MODEL SWAPPING: any of the four models can be overridden via the `models`
 * option — see `_resolveModelSpec` and `DEFAULT_MODELS` below. Each entry is
 * either 'default'/omitted (unchanged behavior), a Hugging Face Hub id
 * (loaded from the Hub), or a local path (loaded with `local_files_only`).
 * The text model is no longer assumed binary — see `_maxToxicityScore`.
 */

export class SifEdge {
  static DEFAULT_MODELS = {
    text: { id: 'multilingual-toxicity', options: { quantized: true, local_files_only: true } },
    image: { id: 'onnx-community/nsfw_image_detection-ONNX', options: {} },
    audioTranscription: { id: 'Xenova/whisper-tiny.en', options: {} },
    audioEmotion: { id: 'onnx-community/wav2vec2-base-Speech_Emotion_Recognition-ONNX', options: {} },
  };

  // Labels that must never be read as a toxicity score, whatever else the
  // model reports alongside them (e.g. a multi-label model with a 'clean'
  // catch-all bucket next to its abuse labels).
  static NEUTRAL_LABELS = new Set(['neutral', 'clean', 'non-toxic', 'nontoxic', 'not-toxic', 'not_toxic']);

  static MODALITIES = ['text', 'audio', 'image'];

  // How long a hydrated ban-status cache is trusted before a gate check
  // forces a fresh fetch. Bounds how long a ban applied by something other
  // than this SDK instance's own traffic can go unnoticed while the page
  // stays open — the tradeoff is this many seconds of possible staleness
  // against one extra request per modality gate check when it's stale.
  static BAN_STATUS_CACHE_MS = 30_000;

  constructor(opts = {}) {
    this.channelContext = opts.channelContext ?? 'public';
    this.lowThreshold = opts.lowThreshold ?? 0.55;
    this.highThreshold = opts.highThreshold ?? 0.90;
    this.maxWarnings = opts.maxWarnings ?? 3;
    this.onDecision = opts.onDecision ?? (() => {});
    this.onPendingReview = opts.onPendingReview ?? (() => {});
    // Fires once per new ban, named with the modality that just got banned
    // (1h the first time for that modality, 24h on every repeat after).
    this.onWarningThresholdReached = opts.onWarningThresholdReached ?? (() => {});
    // Fires only when the IMAGE modality specifically reaches its 24h ban —
    // the SDK never sends anything itself, this is just the signal to go
    // notify the user through whatever text channel the integrator has.
    this.onImageBanNotice = opts.onImageBanNotice ?? (() => {});

    // Optional: report every decision to a real SifEdge backend (see /backend).
    // Only decision + score + hashes + modality + userRef are ever sent — never
    // raw text or image bytes, which never leave this SDK instance.
    this.backendUrl = opts.backendUrl ?? null;
    this.userRef = opts.userRef ?? null;
    // Required alongside backendUrl: the server rejects unauthenticated
    // /api/decisions calls (see server/src/auth.js). This key identifies
    // your integration, not an end user — never derive it from user input.
    this.ingestApiKey = opts.ingestApiKey ?? null;

    this.checkedCount = 0;
    this.blockedCount = 0;
    this._pending = new Map(); // id -> { baseProof, score, modality }
    this._nextId = 1;

    // Per-modality state. In backend mode this is a read-only cache of what
    // the server last told us; the server is the source of truth for ban
    // timing. It's refreshed (a) once at construction, (b) after every
    // decision report's response, and (c) again before any gate check once
    // it's older than BAN_STATUS_CACHE_MS — see _ensureFreshBanStatus. That
    // third path is what catches a ban this instance didn't cause itself
    // (a moderator action, another tab/device for the same userRef) while
    // the page stays open; without it, only a fresh construction would ever
    // see it. Without a backend there's nowhere to persist a real duration,
    // so it's a simplified local counter instead: 3 strikes blocks that
    // modality until the page reloads, no timed expiry, no escalation
    // levels, and no re-check needed since nothing external can change it.
    this._modalityBanStatus = { text: null, audio: null, image: null };
    this._banStatusFetchedAt = 0; // epoch ms of the last successful hydration; 0 = never fetched
    this._banStatusInFlight = null; // in-flight hydration promise, shared by concurrent callers
    this._localWarnCount = { text: 0, audio: 0, image: 0 };
    this._localBlocked = { text: false, audio: false, image: false };

    this._textClassifier = null;
    this._imgClassifier = null;
    this._audioTranscriber = null;
    this._audioEmotionClassifier = null;
    this._readyPromise = this._loadModels(opts.transformersUrl, opts.models);
    // Independent of model loading: warms _modalityBanStatus from the server
    // (if backend-connected) so checkText/checkAudio/checkImage can gate
    // correctly on the very first call. checkText/checkAudio/checkImage each
    // call _ensureFreshBanStatus() themselves too (which no-ops if this is
    // still fresh), so a ban is never missed by more than the cache window.
    this._banStatusPromise = this._ensureFreshBanStatus();
  }

  /**
   * True if `id` looks like a local filesystem path rather than a Hugging
   * Face Hub id: leading './', '../', '/', '~/', a 'file:' URL, or a
   * Windows drive letter (e.g. 'C:\'). A bare 'org/model' or single-segment
   * name (both valid Hub ids) is never treated as local.
   */
  _isLocalPath(id) {
    return /^(\.{1,2}\/|\/|~\/|file:)/.test(id) || /^[a-zA-Z]:[\\/]/.test(id);
  }

  /**
   * Resolves one of the four model slots ('text' | 'image' |
   * 'audioTranscription' | 'audioEmotion') against an optional override
   * from the `models` constructor option. 'default'/undefined/null keeps
   * the built-in model and its options unchanged; any other string is
   * treated as either a Hub id or a local path (see `_isLocalPath`) and
   * loaded with no assumptions beyond that — any transformers.js-compatible
   * model works.
   */
  _resolveModelSpec(kind, override) {
    const def = SifEdge.DEFAULT_MODELS[kind];
    if (override === undefined || override === null || override === 'default') {
      return { id: def.id, options: { ...def.options } };
    }
    return {
      id: override,
      options: this._isLocalPath(override) ? { local_files_only: true } : {},
    };
  }

  async _loadModels(transformersUrl = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2', modelsConfig = {}) {
    const { pipeline, env, RawImage } = await import(transformersUrl);
    env.allowLocalModels = true;
    // The multilingual toxicity model is built locally by
    // scripts/setup-models.sh (no ONNX build exists on the Hub, so it's
    // exported + quantized at setup rather than fetched at runtime).
    // Resolved relative to this file: src/ -> ../models/
    env.localModelPath = new URL('../models/', import.meta.url).href;
    this._RawImage = RawImage;

    const textSpec = this._resolveModelSpec('text', modelsConfig.text);
    const imageSpec = this._resolveModelSpec('image', modelsConfig.image);
    const transcriptionSpec = this._resolveModelSpec('audioTranscription', modelsConfig.audioTranscription);
    const emotionSpec = this._resolveModelSpec('audioEmotion', modelsConfig.audioEmotion);

    const [text, img, transcriber, emotion] = await Promise.all([
      pipeline('text-classification', textSpec.id, textSpec.options),
      pipeline('image-classification', imageSpec.id, imageSpec.options),
      pipeline('automatic-speech-recognition', transcriptionSpec.id, transcriptionSpec.options),
      pipeline('audio-classification', emotionSpec.id, emotionSpec.options),
    ]);
    this._textClassifier = text;
    this._imgClassifier = img;
    this._audioTranscriber = transcriber;
    this._audioEmotionClassifier = emotion;
  }

  /** Resolves once both models are loaded and ready to classify. */
  ready() {
    return this._readyPromise;
  }

  /** Set the channel context at any time — e.g. when a user switches from a group chat into a DM. */
  setChannelContext(context) {
    if (context !== 'public' && context !== 'private') {
      throw new Error("channelContext must be 'public' or 'private'");
    }
    this.channelContext = context;
  }

  /** True if the given modality ('text' | 'audio' | 'image') is currently banned. */
  isBlocked(modality) {
    return this._isModalityBanned(modality);
  }

  _isModalityBanned(modality) {
    if (this.backendUrl) {
      const status = this._modalityBanStatus[modality];
      return !!status && status.isBanned && new Date(status.bannedUntil).getTime() > Date.now();
    }
    return this._localBlocked[modality];
  }

  /**
   * Ensures _modalityBanStatus is no older than BAN_STATUS_CACHE_MS before a
   * gate check runs, re-fetching from the server if it's gone stale. No-op
   * without a fully configured backend. Concurrent callers while a fetch is
   * already in flight (e.g. checkText and checkImage racing right after
   * construction) share that one fetch rather than each firing their own.
   */
  async _ensureFreshBanStatus() {
    if (!this.backendUrl || !this.userRef || !this.ingestApiKey) return;
    if (this._banStatusFetchedAt && Date.now() - this._banStatusFetchedAt < SifEdge.BAN_STATUS_CACHE_MS) return;
    if (!this._banStatusInFlight) {
      this._banStatusInFlight = this._hydrateBanStatus().finally(() => { this._banStatusInFlight = null; });
    }
    return this._banStatusInFlight;
  }

  /**
   * Fetches the current per-modality ban state from the backend (via the
   * ingest key, not a moderator token — see server/src/server.js). Always
   * hits the network — callers wanting the cache/staleness check should go
   * through _ensureFreshBanStatus instead.
   */
  async _hydrateBanStatus() {
    if (!this.backendUrl || !this.userRef || !this.ingestApiKey) return;
    try {
      const res = await fetch(`${this.backendUrl}/api/users/${encodeURIComponent(this.userRef)}/ban-status`, {
        headers: { 'x-api-key': this.ingestApiKey },
      });
      if (res.ok) {
        this._applyServerStatus(await res.json());
        this._banStatusFetchedAt = Date.now();
      }
    } catch (e) {
      console.warn('[SifEdge] could not fetch ban status (continuing without it):', e.message);
    }
  }

  /** Absorbs a `{ userRef, modalities: { text, audio, image } }` status payload from the server into the local cache. */
  _applyServerStatus(status) {
    if (!status || !status.modalities) return;
    for (const modality of SifEdge.MODALITIES) {
      const m = status.modalities[modality];
      if (!m) continue;
      this._modalityBanStatus[modality] = {
        warningCount: m.warningCount,
        banLevel: m.banLevel,
        isBanned: m.isBanned,
        bannedUntil: m.bannedUntil,
      };
    }
  }

  async _sha256Hex(bufferOrString) {
    const data = typeof bufferOrString === 'string'
      ? new TextEncoder().encode(bufferOrString)
      : bufferOrString;
    const buf = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Check a text string. Returns null immediately (no model call, no hash,
   * nothing logged) if channelContext is 'private' or the text modality is
   * currently banned.
   */
  async checkText(text) {
    if (this.channelContext === 'private') return null; // hard gate — classifier never invoked
    await this._ensureFreshBanStatus();
    if (this._isModalityBanned('text')) return null; // hard gate — classifier never invoked while banned
    if (!this._textClassifier) await this.ready();

    const result = await this._textClassifier(text, { topk: null });
    const score = this._maxToxicityScore(result);
    const inputHash = await this._sha256Hex(text);
    return this._route(score, inputHash, 'text', 'SIFEDGE-TEXT-POL-02', this._lastToxicLabel);
  }

  /**
   * Check an image (File or Blob). Same hard gate as checkText: returns
   * null on 'private' context, or while the image modality is banned,
   * without ever running the classifier.
   */
  async checkImage(fileOrBlob) {
    if (this.channelContext === 'private') return null;
    await this._ensureFreshBanStatus();
    if (this._isModalityBanned('image')) return null;
    if (!this._imgClassifier) await this.ready();

    const blobUrl = URL.createObjectURL(fileOrBlob);
    let img;
    try {
      img = await this._RawImage.fromURL(blobUrl);
    } finally {
      // caller may still want blobUrl for display; only revoke if they don't
    }
    const result = await this._imgClassifier(img);
    const score = result.find(r => /nsfw|porn/i.test(r.label))?.score ?? result[0]?.score ?? 0;
    const inputHash = await this._sha256Hex(await fileOrBlob.arrayBuffer());
    const decision = await this._route(score, inputHash, 'image', 'SIFEDGE-IMG-POL-01');
    decision.blobUrl = blobUrl; // convenience for integrators that want to render a thumbnail
    return decision;
  }

  /**
   * Check an audio clip (File or Blob, e.g. a short recording). Combines two
   * real signals, same approach used by commercial audio moderation:
   *   1. transcribes the audio locally (Whisper), then runs the same
   *      toxic-bert text classifier on the transcript — catches harmful
   *      WORDS.
   *   2. runs a speech-emotion model on the raw audio for vocal TONE —
   *      catches aggression/anger even when the words alone look mild.
   * The two scores are combined (max) into one decision, same 3-band
   * routing and hard private-channel gate as checkText/checkImage.
   */
  async checkAudio(fileOrBlob) {
    if (this.channelContext === 'private') return null;
    await this._ensureFreshBanStatus();
    if (this._isModalityBanned('audio')) return null;
    if (!this._audioTranscriber) await this.ready();

    const blobUrl = URL.createObjectURL(fileOrBlob);
    const audioData = await this._decodeAudio(fileOrBlob);

    const [transcriptionResult, emotionResult] = await Promise.all([
      this._audioTranscriber(audioData),
      this._audioEmotionClassifier(audioData),
    ]);

    const transcript = transcriptionResult?.text?.trim() ?? '';
    let contentScore = 0;
    let contentLabel = null;
    if (transcript) {
      const textResult = await this._textClassifier(transcript, { topk: null });
      contentScore = this._maxToxicityScore(textResult);
      contentLabel = this._lastToxicLabel; // e.g. 'insult', 'threat', 'identity_hate'
    }

    const angerEntry = emotionResult.find(r => /angry|disgust/i.test(r.label));
    const toneScore = angerEntry?.score ?? 0;
    const toneLabel = angerEntry?.label ?? null;

    // Blend: whichever signal is more concerning drives the decision, but we
    // keep both scores visible to the integrator/reviewer, not just the max.
    const score = Math.max(contentScore, toneScore);
    const triggerLabel = contentScore >= toneScore
      ? (contentLabel ? `content:${contentLabel}` : null)
      : (toneLabel ? `tone:${toneLabel}` : null);

    const inputHash = await this._sha256Hex(await fileOrBlob.arrayBuffer());
    const decision = await this._route(score, inputHash, 'audio', 'SIFEDGE-AUDIO-POL-01', triggerLabel);
    decision.blobUrl = blobUrl;
    decision.transcript = transcript;
    decision.contentScore = contentScore;
    decision.toneScore = toneScore;
    return decision;
  }

  /** Decodes an audio File/Blob into the Float32Array @xenova/transformers expects. */
  async _decodeAudio(fileOrBlob) {
    const arrayBuffer = await fileOrBlob.arrayBuffer();
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    const decoded = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
    // Downmix to mono if needed
    if (decoded.numberOfChannels > 1) {
      const mono = new Float32Array(decoded.length);
      for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
        const chData = decoded.getChannelData(ch);
        for (let i = 0; i < chData.length; i++) mono[i] += chData[i] / decoded.numberOfChannels;
      }
      return mono;
    }
    return decoded.getChannelData(0);
  }

  /**
   * Works with both shapes a text-classification model may return:
   *   - BINARY (e.g. the bundled multilingual model): 'neutral' vs 'toxic',
   *     softmax over the two. The 'toxic'/'toxicity' label's score is used
   *     directly.
   *   - MULTI-LABEL (e.g. the classic 6-label toxic-bert: toxic,
   *     severe_toxic, obscene, threat, insult, identity_hate): if no
   *     single 'toxic'/'toxicity' label is present, the max score across
   *     all abuse-type labels is used instead, and `_lastToxicLabel`
   *     records which one triggered it (surfaced as `triggerLabel`).
   * An explicit neutral/clean label (see `NEUTRAL_LABELS`) is never itself
   * read as a toxicity score, in either shape.
   */
  _maxToxicityScore(labelResults) {
    const candidates = labelResults.filter(r => !SifEdge.NEUTRAL_LABELS.has(r.label.toLowerCase()));

    const explicitToxic = candidates.find(r => /^toxic(ity)?$/i.test(r.label));
    if (explicitToxic) {
      this._lastToxicLabel = explicitToxic.label.toLowerCase();
      return explicitToxic.score;
    }

    if (candidates.length === 0) {
      this._lastToxicLabel = labelResults[0]?.label ?? 'unknown';
      return 0;
    }

    const top = candidates.reduce((max, r) => (r.score > max.score ? r : max), candidates[0]);
    this._lastToxicLabel = top.label.toLowerCase();
    return top.score;
  }

  async _route(score, inputHash, modality, policyId, triggerLabel = null) {
    this.checkedCount++;
    const baseProof = {
      inputHash,
      score: Number(score.toFixed(4)),
      timestamp: new Date().toISOString(),
      policyId,
      channelContext: this.channelContext,
      modality,
      ...(triggerLabel ? { triggerLabel } : {}),
    };

    let decision, needsReview = false;
    if (score < this.lowThreshold) {
      decision = 'ALLOWED';
    } else if (score < this.highThreshold) {
      decision = 'PENDING_REVIEW';
      needsReview = true;
    } else {
      decision = 'BLOCKED';
    }

    const proofHash = await this._sha256Hex(JSON.stringify({ ...baseProof, decision }));
    const result = { decision, score, modality, proofHash, timestamp: baseProof.timestamp, source: 'auto', triggerLabel };

    if (decision === 'BLOCKED') {
      this.blockedCount++;
      // Instant, independent of the warning counter or any ban — an
      // integrator can blur a BLOCKED image on the very first offense.
      if (modality === 'image') result.shouldBlur = true;
      this._registerWarning(modality);
    }

    if (needsReview) {
      const id = this._nextId++;
      this._pending.set(id, { baseProof, score, modality });
      result.reviewId = id;
      this.onPendingReview({ id, score, modality, ...result });
    }

    this._reportToBackend({ ...baseProof, decision, proofHash, source: 'auto' });
    this.onDecision(result);
    return result;
  }

  /** POSTs a decision to the configured backend, if any. Never includes raw content — there is none in scope here. */
  async _reportToBackend(payload) {
    if (!this.backendUrl || !this.userRef) return;
    if (!this.ingestApiKey) {
      console.warn('[SifEdge] backendUrl is set but ingestApiKey is missing — the server will reject this report. Continuing locally.');
      return;
    }
    try {
      const res = await fetch(`${this.backendUrl}/api/decisions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': this.ingestApiKey },
        body: JSON.stringify({
          userRef: this.userRef,
          channelContext: payload.channelContext,
          modality: payload.modality,
          decision: payload.decision,
          score: payload.score,
          inputHash: payload.inputHash,
          proofHash: payload.proofHash,
          source: payload.source,
          policyId: payload.policyId,
        }),
      });
      if (res.ok) this._handleBackendDecisionResult(payload.modality, await res.json());
    } catch (e) {
      console.warn('[SifEdge] backend report failed (continuing locally):', e.message);
    }
  }

  /**
   * Absorbs a `{ status, justBanned, banLevel }` response from POST
   * /api/decisions: refreshes the local ban-status cache (this snapshot is
   * exactly as fresh as one from _hydrateBanStatus, so it also resets the
   * cache-staleness clock — one less _ensureFreshBanStatus round-trip
   * needed on the next check), and — only on the turn a ban was *just*
   * newly applied — fires onWarningThresholdReached for that modality, plus
   * onImageBanNotice specifically when it's the image modality reaching its
   * 24h ceiling (banLevel 2).
   */
  _handleBackendDecisionResult(modality, data) {
    this._applyServerStatus(data.status);
    this._banStatusFetchedAt = Date.now();
    if (data.justBanned) {
      this.onWarningThresholdReached(modality);
      if (modality === 'image' && data.banLevel === 2) this.onImageBanNotice();
    }
  }

  /**
   * Resolve a PENDING_REVIEW item. action: 'confirm' (counts as a warning
   * for that item's modality, same as an auto-BLOCKED result) or 'dismiss'
   * (treated as allowed). Produces its own proof hash tagged source: 'human'.
   */
  async resolveReview(id, action) {
    const entry = this._pending.get(id);
    if (!entry) return null;
    this._pending.delete(id);

    const decision = action === 'confirm' ? 'WARNED_BY_HUMAN' : 'ALLOWED_BY_HUMAN';
    const proofHash = await this._sha256Hex(JSON.stringify({
      ...entry.baseProof, decision, reviewedAt: new Date().toISOString(),
    }));
    const result = {
      decision, score: entry.score, modality: entry.modality, proofHash,
      timestamp: new Date().toISOString(), source: 'human',
    };

    if (action === 'confirm') {
      this._registerWarning(entry.modality);
      // Same warning as an auto-BLOCKED report, so it has to reach the same
      // backend counter — otherwise a human-confirmed review would never
      // count toward that modality's ban in backend mode.
      this._reportHumanConfirmToBackend(entry, proofHash);
    }
    this.onDecision(result);
    return result;
  }

  /** Reports a human-confirmed ('confirm') review outcome to the backend, same as an auto-BLOCKED report would. */
  async _reportHumanConfirmToBackend(entry, proofHash) {
    if (!this.backendUrl || !this.userRef || !this.ingestApiKey) return;
    try {
      const res = await fetch(`${this.backendUrl}/api/decisions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': this.ingestApiKey },
        body: JSON.stringify({
          userRef: this.userRef,
          channelContext: entry.baseProof.channelContext,
          modality: entry.modality,
          decision: 'WARNED_BY_HUMAN',
          score: entry.score,
          inputHash: entry.baseProof.inputHash,
          proofHash,
          source: 'human',
          policyId: entry.baseProof.policyId,
        }),
      });
      if (res.ok) this._handleBackendDecisionResult(entry.modality, await res.json());
    } catch (e) {
      console.warn('[SifEdge] backend report failed (continuing locally):', e.message);
    }
  }

  /**
   * Local-only fallback counter, used only without a connected backend (see
   * the class docstring). No timed expiry, no escalation levels — a real
   * duration needs somewhere to persist it, so 3 strikes just blocks that
   * modality until the page reloads. In backend mode this is a no-op: the
   * server is authoritative, and _handleBackendDecisionResult is what
   * reacts once it confirms a ban.
   */
  _registerWarning(modality) {
    if (this.backendUrl) return;
    this._localWarnCount[modality] = Math.min(this._localWarnCount[modality] + 1, this.maxWarnings);
    if (this._localWarnCount[modality] >= this.maxWarnings) {
      this._localBlocked[modality] = true;
      this.onWarningThresholdReached(modality);
      if (modality === 'image') this.onImageBanNotice();
    }
  }

  /** Snapshot of current counters, useful for a status panel. */
  getStats() {
    const modalities = {};
    for (const modality of SifEdge.MODALITIES) {
      modalities[modality] = this.backendUrl
        ? {
            warningCount: this._modalityBanStatus[modality]?.warningCount ?? 0,
            maxWarnings: this.maxWarnings,
            banLevel: this._modalityBanStatus[modality]?.banLevel ?? 0,
            isBanned: this._isModalityBanned(modality),
            bannedUntil: this._modalityBanStatus[modality]?.bannedUntil ?? null,
          }
        : {
            warningCount: this._localWarnCount[modality],
            maxWarnings: this.maxWarnings,
            isBanned: this._localBlocked[modality],
          };
    }
    return {
      checked: this.checkedCount,
      blocked: this.blockedCount,
      pendingReview: this._pending.size,
      modalities,
    };
  }
}
