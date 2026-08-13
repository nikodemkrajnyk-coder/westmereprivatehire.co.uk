/**
 * Dead-code removal + backup guard — run with:
 *   node server/tests/cleanup-guards.test.js   (also gated by `npm test`)
 *
 * A cleanliness audit removed several things that were dead, broken or unsafe.
 * Deletions rot: a file comes back in a merge, a route gets re-mounted from
 * muscle memory, a page link is restored from an old copy. This pins them out.
 *
 * WHAT WAS REMOVED AND WHY
 *   westmere app/                 a 515 MB untouched create-next-app scaffold
 *   server/push.js, push-sw.js    a push stack nothing required or registered,
 *   + the web-push dependency     and three VAPID_* env vars never set
 *   push_files.sh                 a self-deleting one-shot that got committed
 *   westmere-job-email.html       an unlinked page carrying fabricated
 *                                 customer details
 *   westmere-track.html +         the ref+phone tracking feature, withdrawn
 *   public-tracking-routes.js     until a proper in-app tracker is built
 *   server/tesla-routes.js        never mounted, so the driver page's four
 *   + the driver page's calls     /api/tesla/* calls 404'd on every load
 *
 * THE BACKUP GUARD
 *   startAutoBackup() ran on every boot with no off switch. A local dev boot
 *   wrote an EMPTY database into the real iCloud backup set and rotated a
 *   genuine backup out to make room. A backup containing nothing is worse than
 *   no backup: restoring from it silently wipes the business.
 *
 * Pure Node, no framework. Exit 1 on failure.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
}

console.log('\nCleanup guards — deleted stays deleted, backups stay honest');

// ── 1. The files are gone ────────────────────────────────────────────────
const DELETED = [
  'westmere app',
  'server/push.js',
  'push-sw.js',
  'push_files.sh',
  'westmere-job-email.html',
  'westmere-track.html',
  'server/public-tracking-routes.js',
  'server/tesla-routes.js',
];

test('every deleted file and folder stays deleted', () => {
  const back = DELETED.filter(exists);
  assert.strictEqual(back.join(', '), '',
    'these were removed as dead and must not return: ' + back.join(', '));
});

// ── 2. Nothing references them ───────────────────────────────────────────
// Walk the shipped source rather than grepping blindly, so a mention inside
// THIS test (or in a commit message) cannot fail the build.
function shippedFiles() {
  const out = [];
  const skipDir = new Set(['node_modules', '.git', '.claude', 'data', 'assets',
    '.redesign-backup', '.redesign-incoming', 'tests']);
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || skipDir.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (/\.(js|html|json|xml|txt)$/i.test(entry.name)) out.push(full);
    }
  })(ROOT);
  return out;
}

test('no shipped file references the removed modules or pages', () => {
  const REFS = [
    { pattern: /require\((['"])\.\/push\1\)/, what: "require('./push')" },
    { pattern: /require\((['"])\.\/public-tracking-routes\1\)/, what: "require('./public-tracking-routes')" },
    { pattern: /require\((['"])\.\/tesla-routes\1\)/, what: "require('./tesla-routes')" },
    { pattern: /push-sw\.js/, what: 'push-sw.js' },
    { pattern: /westmere-track\.html/, what: 'westmere-track.html' },
    { pattern: /westmere-job-email\.html/, what: 'westmere-job-email.html' },
    { pattern: /push_files\.sh/, what: 'push_files.sh' },
    { pattern: /["']web-push["']/, what: 'the web-push package' },
    { pattern: /VAPID_(PUBLIC_KEY|PRIVATE_KEY|EMAIL)/, what: 'a VAPID_* env var' },
  ];
  const problems = [];
  for (const file of shippedFiles()) {
    const rel = path.relative(ROOT, file);
    if (rel.startsWith('server/tests/')) continue;   // the tests may name them
    const src = fs.readFileSync(file, 'utf8');
    for (const { pattern, what } of REFS) {
      if (pattern.test(src)) problems.push(rel + ' still references ' + what);
    }
  }
  assert.strictEqual(problems.join('\n      '), '', problems.join('\n      '));
});

test('the tracking route is unmounted', () => {
  const idx = read('server/index.js');
  assert.ok(!/publicTrackingRouter/.test(idx),
    'server/index.js must not mount the withdrawn public tracking router');
  // the authenticated driver-location routes are a DIFFERENT module and stay
  assert.ok(/require\('\.\/tracking-routes'\)/.test(idx),
    'tracking-routes.js (authenticated driver location push) must still be mounted');
});

test('the driver page makes no /api/tesla calls', () => {
  const drv = read('westmere-driver.html');
  assert.ok(!/fetch\((['"`])\/api\/tesla/.test(drv),
    'westmere-driver.html must not call /api/tesla/* — the router is deleted, every call 404s');
  assert.ok(!/id="tesla-card"/.test(drv), 'the Tesla panel markup must be gone');
  assert.ok(!/function loadTeslaStatus|function connectTesla/.test(drv),
    'the Tesla client functions must be gone');
});

test('no page links to the removed pages', () => {
  for (const file of shippedFiles()) {
    const rel = path.relative(ROOT, file);
    if (!/\.html$|sitemap\.xml$/.test(rel)) continue;
    if (rel.startsWith('server/tests/')) continue;
    const src = fs.readFileSync(file, 'utf8');
    for (const gone of ['westmere-track.html', 'westmere-job-email.html']) {
      assert.ok(!src.includes('href="' + gone) && !src.includes("href='" + gone),
        rel + ' still links to ' + gone);
    }
  }
});

// ── 3. The backup guard ──────────────────────────────────────────────────
test('BACKUP_DISABLED skips the backup entirely', () => {
  const src = read('server/backup-routes.js');
  assert.ok(/process\.env\.BACKUP_DISABLED/.test(src),
    'backup-routes.js must honour BACKUP_DISABLED');
  // startAutoBackup must bail BEFORE it schedules or announces anything
  const startIdx = src.indexOf('function startAutoBackup()');
  const body = src.slice(startIdx, src.indexOf('setInterval', startIdx));
  assert.ok(/BACKUP_DISABLED[\s\S]*?return;/.test(body),
    'startAutoBackup() must return early when BACKUP_DISABLED is set, before scheduling');
});

test('an empty database is never backed up', () => {
  const src = read('server/backup-routes.js');
  assert.ok(/COUNT\(\*\)[\s\S]*bookings/.test(src) && /COUNT\(\*\)[\s\S]*customers/.test(src),
    'the guard must count bookings AND customers');
  assert.ok(/bookings === 0 && customers === 0/.test(src),
    'the floor must require BOTH to be zero — a real database with no customers yet ' +
    'but real bookings must still be backed up');
  assert.ok(/runBackup[\s\S]{0,400}backupSkipReason\(\)/.test(src),
    'runBackup() must consult the guard before writing anything');
});

test('the guard is driveable and returns a reason, not just a boolean', () => {
  // Required directly: it must not need a server, a port or a live database.
  const backup = require('../backup-routes');
  assert.strictEqual(typeof backup.backupSkipReason, 'function',
    'backupSkipReason must be exported so it can be tested');
  const prev = process.env.BACKUP_DISABLED;
  process.env.BACKUP_DISABLED = '1';
  const reason = backup.backupSkipReason();
  if (prev === undefined) delete process.env.BACKUP_DISABLED; else process.env.BACKUP_DISABLED = prev;
  assert.ok(typeof reason === 'string' && /BACKUP_DISABLED/.test(reason),
    'with BACKUP_DISABLED set the guard must return a reason naming it, got: ' + reason);
});

// ── 4. Do not undo the two fixes that came before this cleanup ───────────
test('the static-exposure gate is still in place', () => {
  const idx = read('server/index.js');
  assert.ok(/isPrivatePath\(req\.path\)/.test(idx),
    'the private-path gate must remain — it is what stopped serving driver PII');
  assert.ok(exists('server/private-paths.js'), 'server/private-paths.js must remain');
});

test('the account blank-page resilience is still in place', () => {
  const rider = read('westmere-rider.html');
  assert.ok(/_ensureSomethingVisible/.test(rider), 'the blank-page net must remain');
  assert.ok(/function _safe\(/.test(rider), 'the per-step isolation helper must remain');
  const sw = read('rider-sw.js');
  assert.ok(/ignoreSearch/.test(sw) && !/\.catch\(function \(\) \{\s*return caches\.match\(e\.request\);\s*\}\)/.test(sw),
    'the service worker must never be able to respond with undefined again');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
