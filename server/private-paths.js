// ── WHICH PATHS MUST NEVER BE SERVED FROM DISK ──────────────────────────
// server/index.js serves the WHOLE REPO ROOT with express.static, because the
// public pages, /assets and the shared js/css all live at the top level. That
// also published everything else, including:
//
//   /data/WestmereData/Drivers/drivers.csv  → driver names, emails, phones,
//                                             registrations, licence expiry
//   /server/db.js, /server/api.js, …        → the entire backend source
//   /package.json, /CLAUDE.md, /push_files.sh, /server/tests/*
//
// The drivers file is personal data, so that was a live data-protection
// breach rather than untidiness. This module is the single rule for what is
// private; index.js applies it BEFORE express.static, and
// server/tests/static-exposure.test.js runs this exact function.
//
// It answers with 404 upstream, never 403: a 403 confirms the file exists.
//
// Blocklist rather than allowlist on purpose — adding a new public page must
// not require a change here. The guardrail test makes that safe by walking the
// repo root and failing if a new top-level entry is neither clearly public nor
// covered below.
//
// /.well-known is the one dotted path that must still serve: Apple Pay
// verifies domain ownership by fetching the association file.

const PRIVATE_PREFIXES = [
  '/data',          // database, backups, filed customer + driver records
  '/server',        // all backend source, including tests
  '/node_modules',
  '/westmere app',  // legacy working folder committed at the root
];

const PRIVATE_FILES = new Set([
  '/package.json',
  '/package-lock.json',
  '/nixpacks.toml',
]);

// Never public: databases, spreadsheets of people, shell scripts, notes,
// dumps, logs, and anything that smells like a credential.
const PRIVATE_EXT = /\.(db|db-shm|db-wal|sqlite3?|csv|tsv|sh|bash|zsh|md|sql|log|env|bak|pem|key|p12|pfx|crt)$/i;
const TEST_FILE = /\.test\.js$/i;

const APPLE_PAY = '/.well-known/apple-developer-merchantid-domain-association';

function isPrivatePath(rawPath) {
  let p;
  try { p = decodeURIComponent(rawPath || '/'); }
  catch (e) { return true; }                 // undecodable → refuse
  p = p.replace(/\\/g, '/');                 // windows-style separators
  if (p.indexOf('\0') !== -1) return true;   // null byte → refuse
  const lower = p.toLowerCase();

  if (lower === APPLE_PAY) return false;

  const segments = p.split('/');
  // any dot-prefixed segment: /.git, /.claude, /.env, /.redesign-backup, …
  if (segments.some(seg => seg.startsWith('.') && seg !== '.well-known')) return true;
  // never allow traversal out of the root
  if (segments.includes('..')) return true;

  if (PRIVATE_FILES.has(lower)) return true;
  if (PRIVATE_EXT.test(lower)) return true;
  if (TEST_FILE.test(lower)) return true;

  for (const prefix of PRIVATE_PREFIXES) {
    if (lower === prefix || lower.startsWith(prefix + '/')) return true;
  }
  return false;
}

module.exports = { isPrivatePath, PRIVATE_PREFIXES, PRIVATE_FILES, PRIVATE_EXT, APPLE_PAY };
