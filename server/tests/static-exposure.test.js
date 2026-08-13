/**
 * Static exposure guardrail — run with:
 *   node server/tests/static-exposure.test.js   (also gated by `npm test`)
 *
 * WHY THIS EXISTS — a live data-protection breach, found by a cleanliness audit:
 * server/index.js serves the whole repo root with express.static, so these were
 * publicly downloadable from the live site with no authentication at all:
 *
 *   GET /data/WestmereData/Drivers/drivers.csv  → 200  driver names, emails,
 *                                                      phones, registrations,
 *                                                      licence expiry dates
 *   GET /server/db.js                           → 200  (39 KB of backend source)
 *   GET /server/api.js                          → 200  (124 KB)
 *   GET /package.json, /CLAUDE.md, /push_files.sh, /server/tests/*  → 200
 *
 * The fix is a single rule (server/private-paths.js) applied BEFORE
 * express.static. This test drives that rule three ways:
 *   1. the function itself, path by path;
 *   2. a REAL express stack — the same gate in front of the same static mount,
 *      answering real HTTP requests against the real repo — so it cannot pass
 *      on a rule that is never actually reached;
 *   3. a sweep of the repo root, so a NEW top-level file or folder has to be
 *      consciously classified as public or private instead of silently shipping.
 *
 * Pure Node + express (already a dependency). Exit 1 on failure.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');
const express = require('express');

const ROOT = path.join(__dirname, '..', '..');
const { isPrivatePath } = require('../private-paths');

let passed = 0, failed = 0;
const pending = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(
        () => { console.log('  ✓ ' + name); passed++; },
        (e) => { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
      ));
      return;
    }
    console.log('  ✓ ' + name); passed++;
  } catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
}

console.log('\nStatic exposure guardrail — the repo root is not a public directory');

// ── 1. The rule, path by path ────────────────────────────────────────────
const MUST_BE_PRIVATE = [
  '/data/WestmereData/Drivers/drivers.csv',   // the breach
  '/data/westmere.db',
  '/data/backups/westmere-2026-01-01.db',
  '/data/invoices/INV-1.pdf',
  '/data',
  '/server/db.js',
  '/server/api.js',
  '/server/private-paths.js',
  '/server/tests/payment-flow.test.js',
  '/package.json',
  '/package-lock.json',
  '/CLAUDE.md',
  '/push_files.sh',
  '/.git/config',
  '/.env',
  '/.claude/settings.json',
  '/node_modules/express/package.json',
  '/westmere app/notes.txt',
  '/nixpacks.toml',
];

const MUST_BE_PUBLIC = [
  '/', '/index.html', '/book.html', '/contact.html', '/about.html', '/services.html',
  '/airport-transfers.html',
  '/westmere-rider.html', '/westmere-owner.html', '/westmere-admin.html', '/westmere-driver.html',
  '/westmere-pay.html', '/westmere-track.html',
  '/assets/sussex-coast.webp', '/assets/westmere-email-hero.jpg', '/assets/ic-cash.png',
  '/styles.css', '/booking-app.js', '/frontend.js', '/reviews.js',
  '/address-normalize.js', '/wm-lifecycle.js', '/wm-picker.js', '/wm-realtime.js',
  '/sitemap.xml', '/robots.txt', '/CNAME',
  '/rider-manifest.json', '/manifest-rider.webmanifest', '/manifest-owner.webmanifest',
  '/rider-icon-192.svg', '/rider-icon-512.svg',
  '/sw.js', '/rider-sw.js', '/push-sw.js',
  '/.well-known/apple-developer-merchantid-domain-association',
];

test('every sensitive path is classified private', () => {
  const leaks = MUST_BE_PRIVATE.filter(p => !isPrivatePath(p));
  assert.strictEqual(leaks.join(', '), '', 'these would still be served publicly: ' + leaks.join(', '));
});

test('every public page and asset is still allowed', () => {
  const blocked = MUST_BE_PUBLIC.filter(p => isPrivatePath(p));
  assert.strictEqual(blocked.join(', '), '', 'these must stay public but are now blocked: ' + blocked.join(', '));
});

test('encoded, traversed and null-byte paths cannot slip through', () => {
  for (const sneaky of [
    '/data%2FWestmereData%2FDrivers%2Fdrivers.csv',
    '/%64ata/WestmereData/Drivers/drivers.csv',
    '/server%2Fdb.js',
    '/public/../server/db.js',
    '/DATA/WestmereData/Drivers/DRIVERS.CSV',
    '/Server/DB.js',
    '/data\\WestmereData\\Drivers\\drivers.csv',
  ]) {
    assert.ok(isPrivatePath(sneaky), sneaky + ' must be refused');
  }
});

// ── 2. A real express stack, real HTTP, real files ───────────────────────
function startApp() {
  const app = express();
  // EXACTLY the order server/index.js uses: gate first, static second.
  app.use((req, res, next) => {
    if (!isPrivatePath(req.path)) return next();
    res.status(404).type('text/plain').send('Not found');
  });
  app.use(express.static(ROOT, { index: 'index.html', extensions: ['html'] }));
  app.use((req, res) => res.status(404).send('not found'));
  return new Promise(resolve => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

test('over real HTTP: the driver spreadsheet and backend source are unreachable', () => {
  return startApp().then(({ server, port }) => {
    const checks = [
      ['/data/WestmereData/Drivers/drivers.csv', 404],
      ['/server/db.js', 404],
      ['/server/api.js', 404],
      ['/server/private-paths.js', 404],
      ['/package.json', 404],
      ['/package-lock.json', 404],
      ['/CLAUDE.md', 404],
      ['/push_files.sh', 404],
    ];
    return Promise.all(checks.map(([p, want]) =>
      get(port, p).then(r => {
        assert.strictEqual(r.status, want, p + ' returned ' + r.status + ', expected ' + want);
        // and the body must not be the file
        assert.ok(!/full_name|password|CREATE TABLE|require\(/.test(r.body),
          p + ' returned file contents in the body');
      })
    )).then(() => server.close(), e => { server.close(); throw e; });
  });
});

test('over real HTTP: the public site still serves', () => {
  return startApp().then(({ server, port }) => {
    const wanted = [
      '/', '/index.html', '/book.html', '/westmere-rider.html', '/westmere-owner.html',
      '/styles.css', '/robots.txt', '/sitemap.xml',
      '/rider-sw.js', '/sw.js', '/rider-manifest.json',
      '/address-normalize.js', '/wm-lifecycle.js',
      '/assets/sussex-coast.webp',
    ].filter(p => p === '/' || fs.existsSync(path.join(ROOT, p)));
    return Promise.all(wanted.map(p =>
      get(port, p).then(r => {
        assert.strictEqual(r.status, 200, p + ' returned ' + r.status + ' — a public asset must still serve');
        assert.ok(r.body.length > 0, p + ' served an empty body');
      })
    )).then(() => server.close(), e => { server.close(); throw e; });
  });
});

// ── 3. The gate must actually be wired in, before static ─────────────────
test('server/index.js applies the gate BEFORE express.static', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  // Match the CALLS, not the prose: both names appear in comments above them.
  const gate = src.indexOf('isPrivatePath(req.path)');
  const stat = src.indexOf('app.use(express.static(');
  assert.ok(gate !== -1, 'server/index.js must apply isPrivatePath(req.path) as middleware');
  assert.ok(stat !== -1, 'server/index.js no longer serves static files?');
  assert.ok(gate < stat,
    'the private-path gate must be registered BEFORE express.static, or the files are served first');
  assert.ok(/res\.status\(404\)/.test(src.slice(gate, stat)),
    'the gate must answer 404 — a 403 confirms the file exists');
  // and it must be a real middleware, not a dead helper
  assert.ok(/app\.use\(\(req, res, next\) => \{\s*if \(!isPrivatePath\(req\.path\)\) return next\(\);/.test(src),
    'isPrivatePath must gate every request via app.use, not merely be imported');
});

test('Apple Pay domain verification is still served', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  const apple = src.indexOf("'/.well-known/apple-developer-merchantid-domain-association'");
  const gate = src.indexOf('isPrivatePath');
  assert.ok(apple !== -1, 'the Apple Pay association route must still exist');
  assert.ok(apple < gate, 'the Apple Pay route must be registered before the gate');
  assert.ok(!isPrivatePath('/.well-known/apple-developer-merchantid-domain-association'),
    'the association file must remain reachable or Apple Pay stops working on iPhones');
});

// ── 4. Nothing new may appear at the root unclassified ───────────────────
test('every top-level entry is deliberately public or deliberately private', () => {
  // Anything public-looking is fine; anything else must be caught by the rule.
  const PUBLIC_LOOKING = /\.(html|css|js|json|webmanifest|svg|png|jpe?g|webp|gif|ico|txt|xml)$/i;
  const KNOWN_PUBLIC = new Set(['assets', 'CNAME', 'apple-developer-merchantid-domain-association']);
  const unclassified = [];
  for (const entry of fs.readdirSync(ROOT)) {
    const p = '/' + entry;
    if (isPrivatePath(p)) continue;               // deliberately private
    if (KNOWN_PUBLIC.has(entry)) continue;        // deliberately public
    if (PUBLIC_LOOKING.test(entry)) continue;     // an ordinary web asset
    unclassified.push(entry);
  }
  assert.strictEqual(unclassified.join(', '), '',
    'new top-level entr(ies) are neither clearly public nor covered by ' +
    'server/private-paths.js — classify them before they ship: ' + unclassified.join(', '));
});

// package.json must not be readable, but the test script must still list this file
test('this guardrail is wired into npm test', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(/static-exposure\.test\.js/.test(pkg.scripts.test),
    'static-exposure.test.js must run in npm test, or the exposure can come back unnoticed');
});

Promise.all(pending).then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
