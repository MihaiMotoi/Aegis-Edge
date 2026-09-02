// Validates required secrets before any other module runs its own startup
// code (e.g. db.js seeding a moderator account). Must have zero dependencies
// on db.js/auth.js and must be the first import in server.js — otherwise a
// missing-secret exit can still happen after side effects (like a DB seed)
// have already run.
const required = ['JWT_SECRET', 'INGEST_API_KEY'];
const missing = required.filter(name => !process.env[name]);

if (missing.length > 0) {
  console.error(`[env-check] FATAL: missing required env var(s): ${missing.join(', ')}`);
  console.error('[env-check] Copy server/.env.example to server/.env and fill these in. Generate values with:');
  console.error("  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
  process.exit(1);
}
