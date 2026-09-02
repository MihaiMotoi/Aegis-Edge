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
// counter and ban ladder — a suspension on one never affects the others.
// 3 confirmed violations (an auto BLOCKED, or a human-confirmed
// WARNED_BY_HUMAN from the review queue) bans that modality for 1 hour the
// first time, then 24 hours on every escalation after that (ban_level caps
// at 2, so the duration caps at 24h too — it never grows past that).
const MODALITY_MAX_WARNINGS = 3;
const BAN_DURATION_MS_BY_LEVEL = { 1: 60 * 60 * 1000, 2: 24 * 60 * 60 * 1000 };
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

  // Both an auto BLOCKED and a human-confirmed WARNED_BY_HUMAN count as a
  // confirmed violation toward that modality's warning counter — matches
  // how the review queue has always treated a moderator's "confirm" action
  // as equivalent to an automatic block.
  let warnResult = null;
  if (decision === 'BLOCKED' || decision === 'WARNED_BY_HUMAN') {
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
    banLevel: warnResult?.banLevel ?? null,
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

  const decisionLabel = action === 'confirm' ? 'WARNED_BY_HUMAN' : 'ALLOWED_BY_HUMAN';
  db.prepare(`
    INSERT INTO decisions (external_id, user_ref, channel_context, modality, decision, score, input_hash, proof_hash, source, policy_id)
    SELECT NULL, user_ref, 'public', modality, ?, score, input_hash, proof_hash || '-human-' || ?, 'human', policy_id
    FROM decisions WHERE id = ?
  `).run(decisionLabel, item.id, item.decision_id);

  if (action === 'confirm') registerWarning(item.user_ref, item.modality);

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
    const bannedUntil = row[`${modality}_banned_until`];
    const isBanned = !!bannedUntil && new Date(bannedUntil).getTime() > Date.now();
    modalities[modality] = {
      warningCount: row[`${modality}_warning_count`],
      maxWarnings: MODALITY_MAX_WARNINGS,
      banLevel: row[`${modality}_ban_level`],
      isBanned,
      // Once a ban expires it's still on the row (for the escalation-level
      // check next time), but it's no longer "the" active ban — don't
      // report a stale timestamp as if it were current.
      bannedUntil: isBanned ? bannedUntil : null,
    };
  }
  return { userRef: row.user_ref, modalities };
}

// Registers one confirmed violation (auto BLOCKED or human-confirmed
// WARNED_BY_HUMAN) against a single modality. At 3 warnings the counter
// resets to 0 and a ban is applied: 1 hour the first time (ban_level 0->1),
// 24 hours every time after that (ban_level caps at 2, so does the
// duration — see BAN_DURATION_MS_BY_LEVEL). Returns whether this call just
// triggered a new ban, and at what level, so callers can react (e.g. fire
// the SDK's onImageBanNotice at the 24h level).
function registerWarning(userRef, modality) {
  const row = ensureUserStatusRow(userRef);
  const countCol = `${modality}_warning_count`;
  const levelCol = `${modality}_ban_level`;
  const untilCol = `${modality}_banned_until`;

  const newCount = row[countCol] + 1;
  if (newCount < MODALITY_MAX_WARNINGS) {
    db.prepare(`UPDATE user_status SET ${countCol} = ?, updated_at = datetime('now') WHERE user_ref = ?`)
      .run(newCount, userRef);
    return { justBanned: false };
  }

  const newLevel = Math.min(row[levelCol] + 1, 2);
  const bannedUntil = new Date(Date.now() + BAN_DURATION_MS_BY_LEVEL[newLevel]).toISOString();
  db.prepare(`
    UPDATE user_status
    SET ${countCol} = 0, ${levelCol} = ?, ${untilCol} = ?, updated_at = datetime('now')
    WHERE user_ref = ?
  `).run(newLevel, bannedUntil, userRef);
  return { justBanned: true, banLevel: newLevel, bannedUntil };
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
