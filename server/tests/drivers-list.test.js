/**
 * THE DRIVERS LIST LOADS — run with:
 *   node server/tests/drivers-list.test.js   (also gated by `npm test`)
 *
 * WHAT WAS WRONG
 *   GET /api/drivers answered 500 to every authenticated call on production.
 *   The route decorates each driver with a compliance summary:
 *
 *       const comp = require('./compliance');
 *
 *   server/compliance.js belongs to a batch that was deliberately held back and
 *   never committed. The route that uses it shipped anyway, so on production the
 *   require threw MODULE_NOT_FOUND and took the whole response with it. The
 *   owner's Drivers section was dead, and every feature reading that endpoint
 *   with it.
 *
 * WHAT IS GUARDED
 *   1. The list answers 200 with the drivers when the module is ABSENT — which
 *      is the state production is actually in.
 *   2. It still decorates when the module IS present, so shipping that batch
 *      changes what the list says and not whether it loads.
 *   3. One bad row does not take the list with it.
 *   4. A driver with every optional field null comes back intact.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP = path.join(os.tmpdir(), 'wm-drv-' + process.pid + '.db');
try { fs.unlinkSync(TMP); } catch (_) {}
process.env.SQLITE_DB = TMP;
process.env.RESEND_API_KEY = 'test_fake';

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: 'x' }) });

const { getDb } = require('../db');
const db = getDb();
const api = require('../api');

const COMPLIANCE = path.join(__dirname, '..', 'compliance.js');

function res() {
  return { statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; } };
}
/* The route is synchronous; any throw inside it is what Express turns into the
   500 the owner saw, so it is allowed to escape here and fail the test loudly. */
function listDrivers() {
  const l = api.stack.find((x) => x.route && x.route.path === '/drivers' && x.route.methods.get);
  assert.ok(l, 'GET /drivers is missing');
  const req = { params: {}, query: {}, body: {}, ip: '::1', auth: { role: 'owner', id: 1, type: 'user' } };
  const r = res();
  for (const h of l.route.stack.map((x) => x.handle)) h(req, r, () => {});
  return r;
}

let seq = 0;
function seedDriver(over) {
  const o = Object.assign({ full_name: 'Marek Nowak', email: null, phone: null,
                            vehicle: null, reg: null }, over || {});
  const u = 'drv' + (++seq);
  db.prepare(`INSERT INTO users (username, password, role, full_name, email, phone, vehicle, reg, active)
              VALUES (?, '', 'driver', ?, ?, ?, ?, ?, 1)`)
    .run(u, o.full_name, o.email, o.phone, o.vehicle, o.reg);
  return db.prepare('SELECT * FROM users WHERE username = ?').get(u);
}

// ── 1. THE STATE PRODUCTION IS IN ────────────────────────────────────────
console.log('\nThe list loads when the compliance module is not there');

test('server/compliance.js is genuinely absent here, as on production', () => {
  assert.ok(!fs.existsSync(COMPLIANCE),
    'this guard is only meaningful while the held compliance batch is unshipped — '
    + 'if it has since shipped, keep the test and let it cover the present case instead');
});

test('GET /drivers answers 200 with the drivers', () => {
  seedDriver({ full_name: 'Marek Nowak', email: 'marek@example.com' });
  const r = listDrivers();
  assert.strictEqual(r.statusCode, 200,
    'the drivers list is answering ' + r.statusCode + ' — the owner\'s Drivers section is dead');
  assert.ok(r.body && r.body.ok, 'no ok flag: ' + JSON.stringify(r.body));
  assert.ok(Array.isArray(r.body.drivers), 'no drivers array');
  assert.ok(r.body.drivers.some((d) => d.full_name === 'Marek Nowak'), 'the driver is missing from the list');
});

test('a driver with every optional field empty comes back intact', () => {
  const d = seedDriver({ full_name: 'Bare Row' });
  const r = listDrivers();
  assert.strictEqual(r.statusCode, 200, 'a row with null optional fields threw');
  const row = r.body.drivers.find((x) => x.id === d.id);
  assert.ok(row, 'the bare row is missing from the list');
  assert.strictEqual(row.full_name, 'Bare Row');
});

test('the route does not hard-require the held module', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8');
  const i = src.indexOf("router.get('/drivers'");
  const block = src.slice(i, src.indexOf("router.get('/drivers/:id'", i));
  assert.ok(!/^\s*const comp = require\('\.\/compliance'\);\s*$/m.test(block),
    'the compliance module is required without a guard — if that batch is ever '
    + 'unshipped again, the whole drivers list 500s');
  assert.ok(/try\s*\{\s*comp = require\('\.\/compliance'\)/.test(block),
    'the require must be attempted, not dropped — the decoration is wanted when it exists');
});

// ── 2. AND WHEN THE MODULE IS THERE ──────────────────────────────────────
console.log('\nAnd is still written to decorate the list when the module exists');

/* WHY THIS HALF IS READ RATHER THAN RUN.
   The obvious test — inject a stub through require.cache and call the route —
   does not work: Node resolves './compliance' by filename BEFORE consulting the
   cache, so with the file absent the resolution throws and the stub is never
   reached. A first draft did exactly that; one case failed outright and the
   other PASSED WITHOUT TESTING ANYTHING, because with no module there is no
   decoration to check and the assertion was true for the wrong reason.

   The alternative — writing a real server/compliance.js for the duration — is
   worse: that filename is the held compliance batch, present in the owner's own
   checkout. A test that writes it would overwrite work that has not shipped.

   So the absent case above is exercised for real, and the present case is read
   off the source: the decoration is applied when the module is there, and each
   row is guarded on its own so one unreadable driver cannot take the list. */
function driversBlock() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8');
  const i = src.indexOf("router.get('/drivers'");
  assert.ok(i > -1, 'GET /drivers is gone');
  return src.slice(i, src.indexOf("router.get('/drivers/:id'", i));
}

test('the summary is attached when the module is present', () => {
  const block = driversBlock();
  assert.ok(/comp\.forDriver\(r\)/.test(block),
    'nothing calls forDriver — holding the batch would now change what the list SAYS, '
    + 'but shipping it must change that back');
  assert.ok(/if \(!comp \|\| typeof comp\.forDriver !== 'function'\) return r;/.test(block),
    'the module is used without checking it actually exports forDriver — a half-written '
    + 'module would 500 the list the same way a missing one did');
});

test('one bad row cannot take the list with it', () => {
  const block = driversBlock();
  const mapBody = block.slice(block.indexOf('drivers: rows.map'));
  assert.ok(/try \{[\s\S]{0,200}comp\.forDriver\(r\)[\s\S]{0,200}catch/.test(mapBody),
    'forDriver is called outside a try — one driver whose record it cannot read would '
    + 'throw inside the map and 500 the whole list');
  assert.ok(/return r;/.test(mapBody),
    'a row that throws must still be returned, undecorated, rather than dropped');
});

test('this guardrail is wired into npm test', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  assert.ok(pkg.scripts.test.includes('drivers-list.test.js'),
    'add it to npm test or it will not run again');
});

(async () => {
  for (const t of queue) {
    try { await t.fn(); console.log('  ✓ ' + t.name); passed++; }
    catch (e) { console.error('  ✗ ' + t.name + '\n      ' + e.message); failed++; }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  try { fs.unlinkSync(TMP); } catch (_) {}
  process.exit(failed ? 1 : 0);
})();
