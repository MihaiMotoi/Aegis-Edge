import express from 'express';
import cors from 'cors';
import db from './db.js';
import { login, requireAuth } from './auth.js';

const app = express();
app.use(cors());
app.use(express.json());

const MAX_WARNINGS = 3;

// ---------------------------------------------------------------------------
// Public-facing ingest endpoint: called by the Aegis Edge SDK after it makes
// an on-device decision. Only ever receives: decision, score, hashes, modality,
// policyId, channelContext, and an opaque userRef the integrator controls.
// It NEVER receives raw text or image bytes — that is enforced client-side by
// the SDK, and this endpoint has no field for it at all, so there is nothing
// here that could accidentally store raw content even by mistake.
// ---------------------------------------------------------------------------
app.post('/api/decisions', (req, res) => {
  const { userRef, channelContext, modality, decision, score, inputHash, proofHash, source, policyId, externalId } = req.body || {};

  if (channelContext === 'private') {
    return res.status(400).json({ error: 'private-channel decisions must never be sent to the backend' });
  }
  if (!userRef || !modality || !decision || score === undefined || !inputHash || !proofHash || !policyId) {
    return res.status(400).json({ error: 'missing required fields' });
  }

  const info = db.prepare(`
    INSERT INTO decisions (external_id, user_ref, channel_context, modality, decision, score, input_hash, proof_hash, source, policy_id)
    VALUES (@externalId, @userRef, @channelContext, @modality, @decision, @score, @inputHash, @proofHash, @source, @policyId)
  `).run({ externalId: externalId ?? null, userRef, channelContext: channelContext ?? 'public', modality, decision, score, inputHash, proofHash, source: source ?? 'auto', policyId });

  const decisionId = info.lastInsertRowid;

  if (decision === 'BLOCKED') {
    registerWarning(userRef);
  }

  if (decision === 'PENDING_REVIEW') {
    db.prepare(`INSERT INTO review_queue (decision_id, user_ref, modality, score) VALUES (?, ?, ?, ?)`)
      .run(decisionId, userRef, modality, score);
  }

  res.status(201).json({ decisionId, status: getUserStatus(userRef) });
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

  if (action === 'confirm') registerWarning(item.user_ref);

  res.json({ resolved: true, action, status: getUserStatus(item.user_ref) });
});

// ---------------------------------------------------------------------------
// Per-user status (warnings / suspension) — an integrator checks this before
// letting a user post, or a moderator dashboard shows it for context.
// ---------------------------------------------------------------------------
app.get('/api/users/:userRef/status', requireAuth, (req, res) => {
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

function getUserStatus(userRef) {
  let row = db.prepare('SELECT * FROM user_status WHERE user_ref = ?').get(userRef);
  if (!row) {
    db.prepare('INSERT INTO user_status (user_ref) VALUES (?)').run(userRef);
    row = db.prepare('SELECT * FROM user_status WHERE user_ref = ?').get(userRef);
  }
  return {
    userRef: row.user_ref,
    warningCount: row.warning_count,
    maxWarnings: MAX_WARNINGS,
    isSuspended: !!row.is_suspended,
    suspendedUntil: row.suspended_until,
  };
}

function registerWarning(userRef) {
  getUserStatus(userRef); // ensure row exists
  const row = db.prepare('SELECT * FROM user_status WHERE user_ref = ?').get(userRef);
  const newCount = Math.min(row.warning_count + 1, MAX_WARNINGS);
  const suspend = newCount >= MAX_WARNINGS;
  const suspendedUntil = suspend ? new Date(Date.now() + 24 * 3600 * 1000).toISOString() : row.suspended_until;
  db.prepare('UPDATE user_status SET warning_count = ?, is_suspended = ?, suspended_until = ?, updated_at = datetime(\'now\') WHERE user_ref = ?')
    .run(newCount, suspend ? 1 : 0, suspendedUntil, userRef);
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`[aegis-edge-backend] listening on http://localhost:${PORT}`));
