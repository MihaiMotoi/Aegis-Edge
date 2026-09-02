import './env-check.js'; // must run first — see comment in that file
import express from 'express';
import cors from 'cors';
import db from './db.js';
import { login, requireAuth, requireIngestKey } from './auth.js';

const app = express();

// CORS: default to same-origin only. Set ALLOWED_ORIGINS (comma-separated)
// to the integrator's real domain(s) before deploying. An open CORS policy
// here would let any website's script call the moderator API endpoints
// from a logged-in moderator's browser.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
app.use(cors(allowedOrigins.length ? { origin: allowedOrigins } : { origin: false }));
app.use(express.json());

// Each modality (text, audio, image) has its own independent warning
// counter and ban tier — a suspension on one never affects the others.
// Only an automated BLOCKED decision ever counts — a human-confirmed
// WARNED_BY_HUMAN from the review queue never does; that queue exists for
// moderator judgment and an append-only audit trail, not for feeding this
// ladder.
//
// WARNING PHASE (once per modality, only before it has ever been banned):
// each BLOCKED increments that modality's counter. At its threshold (3 for
// text/audio, 2 for image — image gets a shorter fuse) the counter resets
// to 0 and the modality is banned at the '1h' tier.
//
// ESCALATION (once a modality has been banned at least once, the warning
// phase never applies to it again): every further BLOCKED skips straight
// to the next tier up from wherever the ratchet currently sits — no
// counting, no warning. 'permanent' is the ceiling; it never escalates
// further.
const WARNING_THRESHOLDS = { text: 3, audio: 3, image: 2 };
const TIER_AFTER = { none: '1h', '1h': '24h', '24h': '1month', '1month': 'permanent', permanent: 'permanent' };
// '1month' is 30 days — a fixed duration, not calendar-month arithmetic.
// 'permanent' has no duration at all: bannedUntil is always null for it,
// and isBanned is unconditionally true once a modality reaches it.
const TIER_DURATION_MS = { '1h': 60 * 60 * 1000, '24h': 24 * 60 * 60 * 1000, '1month': 30 * 24 * 60 * 60 * 1000 };
const MODALITIES = ['text', 'audio', 'image'];

// ---------------------------------------------------------------------------
// Public-facing ingest endpoint: called by the SifEdge SDK after it makes
// an on-device decision. Only ever receives: decision, score, hashes, modality,
// policyId, channelContext, and an opaque userRef the integrator controls.
// It NEVER receives raw text or image bytes — that is enforced client-side by
// the SDK, and this endpoint has no field for it at all, so there is nothing
// here that could accidentally store raw content even by mistake.
// ---------------------------------------------------------------------------
const VALID_DECISIONS = new Set(['ALLOWED', 'PENDING_REVIEW', 'BLOCKED', 'WARNED_BY_HUMAN', 'ALLOWED_BY_HUMAN']);
const VALID_MODALITIES = new Set(['text', 'image', 'audio']);

app.post('/api/decisions', requireIngestKey, (req, res) => {
  const { userRef, channelContext, modality, decision, score, inputHash, proofHash, source, policyId, externalId } = req.body || {};

  if (channelContext === 'private') {
    return res.status(400).json({ error: 'private-channel decisions must never be sent to the backend' });
  }
  if (!userRef || !modality || !decision || score === undefined || !inputHash || !proofHash || !policyId) {
    return res.status(400).json({ error: 'missing required fields' });
  }
  // Reject anything outside the shapes the SDK actually produces. Without
  // this, a caller with a valid ingest key could still write garbage
  // decision/modality values that break downstream queue and stats logic.
  if (!VALID_DECISIONS.has(decision)) {
    return res.status(400).json({ error: `decision must be one of: ${[...VALID_DECISIONS].join(', ')}` });
  }
  if (!VALID_MODALITIES.has(modality)) {
    return res.status(400).json({ error: `modality must be one of: ${[...VALID_MODALITIES].join(', ')}` });
  }
  if (typeof score !== 'number' || score < 0 || score > 1 || Number.isNaN(score)) {
    return res.status(400).json({ error: 'score must be a number between 0 and 1' });
  }

  // Defense in depth: the SDK already gates checks locally once it knows a
  // modality is banned (see src/sifedge.js), but the server is the source of
  // truth for ban state, so it refuses to record new reports for a modality
  // that's currently banned regardless of what the client believes.
  const statusBeforeInsert = getUserStatus(userRef);
  if (statusBeforeInsert.modalities[modality].isBanned) {
    return res.status(403).json({
      error: `user is currently banned on ${modality}`,
      status: statusBeforeInsert,
    });
  }

  const info = db.prepare(`
    INSERT INTO decisions (external_id, user_ref, channel_context, modality, decision, score, input_hash, proof_hash, source, policy_id)
    VALUES (@externalId, @userRef, @channelContext, @modality, @decision, @score, @inputHash, @proofHash, @source, @policyId)
  `).run({ externalId: externalId ?? null, userRef, channelContext: channelContext ?? 'public', modality, decision, score, inputHash, proofHash, source: source ?? 'auto', policyId });

  const decisionId = info.lastInsertRowid;

  // Only an automated BLOCKED decision ever counts toward warnings/bans —
  // never a human-confirmed WARNED_BY_HUMAN (see the comment above
  // WARNING_THRESHOLDS). A moderator's "confirm" action is logged below via
  // the review-queue flow but deliberately has no effect here.
  let warnResult = null;
  if (decision === 'BLOCKED') {
    warnResult = registerWarning(userRef, modality);
  }

  if (decision === 'PENDING_REVIEW') {
    db.prepare(`INSERT INTO review_queue (decision_id, user_ref, modality, score) VALUES (?, ?, ?, ?)`)
      .run(decisionId, userRef, modality, score);
  }

  res.status(201).json({
    decisionId,
    status: getUserStatus(userRef),
    justBanned: warnResult?.justBanned ?? false,
    tier: warnResult?.tier ?? null,
    bannedUntil: warnResult?.bannedUntil ?? null,
  });
});

// ---------------------------------------------------------------------------
// Moderator auth
// ---------------------------------------------------------------------------
app.post('/api/auth/login', login);

// ---------------------------------------------------------------------------
// Review queue — moderator-only
// ---------------------------------------------------------------------------
app.get('/api/queue', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT rq.id, rq.decision_id, rq.user_ref, rq.modality, rq.score, rq.status, rq.created_at,
           d.input_hash, d.proof_hash, d.policy_id
    FROM review_queue rq JOIN decisions d ON d.id = rq.decision_id
    WHERE rq.status = 'pending'
    ORDER BY rq.created_at ASC
  `).all();
  res.json({ queue: rows });
});

app.post('/api/queue/:id/resolve', requireAuth, (req, res) => {
  const { action } = req.body || {}; // 'confirm' | 'dismiss'
  if (!['confirm', 'dismiss'].includes(action)) {
    return res.status(400).json({ error: "action must be 'confirm' or 'dismiss'" });
  }

  const item = db.prepare('SELECT * FROM review_queue WHERE id = ? AND status = ?').get(req.params.id, 'pending');
  if (!item) return res.status(404).json({ error: 'no pending review item with that id' });

  const status = action === 'confirm' ? 'confirmed' : 'dismissed';
  db.prepare('UPDATE review_queue SET status = ?, resolved_by = ?, resolved_at = datetime(\'now\') WHERE id = ?')
    .run(status, req.moderator.sub, item.id);

  // Logged to the decisions table either way, for the audit trail — but
  // deliberately never calls registerWarning: a human "confirm" here is a
  // moderator's judgment call, not an automated BLOCKED, and per design
  // only automated BLOCKED decisions count toward warnings or bans.
  const decisionLabel = action === 'confirm' ? 'WARNED_BY_HUMAN' : 'ALLOWED_BY_HUMAN';
  db.prepare(`
    INSERT INTO decisions (external_id, user_ref, channel_context, modality, decision, score, input_hash, proof_hash, source, policy_id)
    SELECT NULL, user_ref, 'public', modality, ?, score, input_hash, proof_hash || '-human-' || ?, 'human', policy_id
    FROM decisions WHERE id = ?
  `).run(decisionLabel, item.id, item.decision_id);

  res.json({ resolved: true, action, status: getUserStatus(item.user_ref) });
});

// ---------------------------------------------------------------------------
// Per-user status (warnings / suspension) — a moderator dashboard shows it
// for context. Moderator-only: carries the full per-modality warning counts.
// ---------------------------------------------------------------------------
app.get('/api/users/:userRef/status', requireAuth, (req, res) => {
  res.json(getUserStatus(req.params.userRef));
});

// ---------------------------------------------------------------------------
// Ban status — called by the SDK itself (via ingestApiKey, not a moderator
// token) so it can learn about an existing ban as soon as it's constructed,
// before running a single check. Without this, a ban applied in an earlier
// session would only be discovered reactively, after the SDK already ran
// the classifier and the server rejected the report — this endpoint is what
// lets checkText/checkAudio/checkImage gate *before* that ever happens.
// ---------------------------------------------------------------------------
app.get('/api/users/:userRef/ban-status', requireIngestKey, (req, res) => {
  res.json(getUserStatus(req.params.userRef));
});

// ---------------------------------------------------------------------------
// Proof log — read-only audit trail, moderator-only for now
// ---------------------------------------------------------------------------
app.get('/api/decisions', requireAuth, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const rows = db.prepare('SELECT * FROM decisions ORDER BY id DESC LIMIT ?').all(limit);
  res.json({ decisions: rows });
});

function ensureUserStatusRow(userRef) {
  let row = db.prepare('SELECT * FROM user_status WHERE user_ref = ?').get(userRef);
  if (!row) {
    db.prepare('INSERT INTO user_status (user_ref) VALUES (?)').run(userRef);
    row = db.prepare('SELECT * FROM user_status WHERE user_ref = ?').get(userRef);
  }
  return row;
}

function getUserStatus(userRef) {
  const row = ensureUserStatusRow(userRef);
  const modalities = {};
  for (const modality of MODALITIES) {
    const tier = row[`${modality}_tier`];
    const bannedUntilRaw = row[`${modality}_banned_until`];
    // 'permanent' never has a bannedUntil to compare against — it's banned
    // unconditionally, forever, until someone changes the row by hand.
    const isBanned = tier === 'permanent'
      ? true
      : !!bannedUntilRaw && new Date(bannedUntilRaw).getTime() > Date.now();
    modalities[modality] = {
      warningCount: row[`${modality}_warning_count`],
      maxWarnings: WARNING_THRESHOLDS[modality],
      // maxTierReached is the ratchet driving escalation — it persists even
      // after the current suspension expires, so the next violation still
      // jumps from the right place. currentTier is null once the active
      // suspension has lapsed, even though maxTierReached still shows where
      // the ratchet sits.
      maxTierReached: tier,
      currentTier: isBanned ? tier : null,
      isBanned,
      bannedUntil: isBanned && tier !== 'permanent' ? bannedUntilRaw : null,
    };
  }
  return { userRef: row.user_ref, modalities };
}

// Registers one confirmed AUTOMATED violation (decision === 'BLOCKED' —
// see the comment above WARNING_THRESHOLDS for why WARNED_BY_HUMAN never
// reaches this function) against a single modality.
//
//   - Never banned before (tier === 'none'): increments the warning
//     counter. At that modality's threshold, the counter resets to 0 and
//     the modality is banned at the '1h' tier.
//   - Banned before at least once (tier !== 'none'): the warning phase
//     never applies again — this one violation jumps straight from the
//     current tier to TIER_AFTER[tier], no counting.
//
// Returns whether this call just applied a fresh ban and at which tier, so
// callers can react (the SDK's onSuspension fires from this).
function registerWarning(userRef, modality) {
  const row = ensureUserStatusRow(userRef);
  const countCol = `${modality}_warning_count`;
  const tierCol = `${modality}_tier`;
  const untilCol = `${modality}_banned_until`;
  const currentTier = row[tierCol];

  if (currentTier === 'none') {
    const newCount = row[countCol] + 1;
    if (newCount < WARNING_THRESHOLDS[modality]) {
      db.prepare(`UPDATE user_status SET ${countCol} = ?, updated_at = datetime('now') WHERE user_ref = ?`)
        .run(newCount, userRef);
      return { justBanned: false };
    }
  }

  const nextTier = TIER_AFTER[currentTier];
  const bannedUntil = nextTier === 'permanent' ? null : new Date(Date.now() + TIER_DURATION_MS[nextTier]).toISOString();
  db.prepare(`
    UPDATE user_status
    SET ${countCol} = 0, ${tierCol} = ?, ${untilCol} = ?, updated_at = datetime('now')
    WHERE user_ref = ?
  `).run(nextTier, bannedUntil, userRef);
  return { justBanned: true, tier: nextTier, bannedUntil };
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Exported so tests can drive the app directly (supertest) without binding a
// real port. Only listens when run directly (`node src/server.js`), not
// when imported.
export default app;

if (import.meta.url === `file://${process.argv[1]}`) {
  const PORT = process.env.PORT || 8787;
  app.listen(PORT, () => console.log(`[sifedge-backend] listening on http://localhost:${PORT}`));
}
