/**
 * A CUSTOMER WHO HAS NOT PAID CAN ALWAYS PAY — run with:
 *   node server/tests/payment-settled.test.js   (also gated by `npm test`)
 *
 * WHAT HAPPENED
 *   A customer whose last thirty-five journeys were all paid by card had his
 *   next one marked `payment='card'` before he had paid a penny. Every door
 *   shut at once: the confirmation email dropped its Pay buttons, the tokenised
 *   cash link said "this journey has already been paid online", the pay page
 *   said the same, and My Account said "Paid — thank you". He had no way to
 *   settle for two days and paid the driver in cash on the day.
 *
 * WHY
 *   isSettled() read `paid_at || payment === 'card'`. The WORD "card" was taken
 *   as proof the money had arrived. It is not: the method is a plan, paid_at is
 *   the fact. The Stripe webhook has always written both together; nothing else
 *   should be able to write the method alone.
 *
 * WHAT IS GUARDED
 *   1. The (payment × paid_at × status) matrix — no unpaid booking may be
 *      locked as "paid", on any surface.
 *   2. PATCH cannot SET card; the webhook still can; Mark Paid records both.
 *   3. History keeps the answer it had — the one-off backfill.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP = path.join(os.tmpdir(), 'wm-settled-' + process.pid + '.db');
try { fs.unlinkSync(TMP); } catch (_) {}
process.env.SQLITE_DB = TMP;
process.env.RESEND_API_KEY = 'test_fake';

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const { getDb } = require('../db');
const db = getDb();
let SENT = [];
global.fetch = async (u, o) => { SENT.push(JSON.parse(o.body)); return { ok: true, status: 200, json: async () => ({ id: 'x' }) }; };
const api = require('../api');
const email = require('../email');
const { paymentLock, isSettled } = require('../pay-lock');

function res() {
  return { statusCode: 200, body: null, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; },
    setHeader() { return this; } };
}
async function call(router, method, routePath, opts) {
  const l = router.stack.find((x) => x.route && x.route.path === routePath && x.route.methods[method]);
  assert.ok(l, 'route missing: ' + method.toUpperCase() + ' ' + routePath);
  const req = Object.assign({ params: {}, query: {}, body: {}, ip: '::1',
                              auth: { role: 'owner', id: 1, type: 'user' } }, opts || {});
  const r = res();
  const hs = l.route.stack.map((x) => x.handle);
  let i = 0;
  const next = async () => { if (i < hs.length) await hs[i++](req, r, next); };
  await next();
  return r;
}

// ── 1. THE MATRIX ────────────────────────────────────────────────────────
console.log('\nOnly money that has arrived counts as paid');

test('the method alone never means settled — paid_at does', () => {
  assert.strictEqual(isSettled({ payment: 'card', paid_at: null }), false,
    'a booking merely MARKED card is not paid — this is the whole fault');
  assert.strictEqual(isSettled({ payment: 'card', paid_at: '2026-09-01 10:00:00' }), true);
  assert.strictEqual(isSettled({ payment: 'pending', paid_at: '2026-09-01 10:00:00' }), true,
    'money that arrived is money that arrived, whatever the method says');
  assert.strictEqual(isSettled({ payment: 'cash', paid_at: null }), false);
});

test('no unpaid booking is ever locked as "paid"', () => {
  const bad = [];
  for (const payment of ['pending', 'card', 'cash', 'account', 'invoice']) {
    for (const paid_at of [null, '2026-09-01 10:00:00']) {
      for (const status of ['pending', 'offered', 'awaiting_payment', 'confirmed', 'completed']) {
        const lock = paymentLock({ payment, paid_at, status, fare: 96 });
        if (!paid_at && lock.reason === 'paid') {
          bad.push(payment + '/' + status + ' → locked as paid with nothing collected');
        }
        /* And the converse: money that HAS arrived must never be asked for twice. */
        if (paid_at && lock.payable) {
          bad.push(payment + '/' + status + ' → payable although paid_at is set');
        }
      }
    }
  }
  assert.deepStrictEqual(bad, []);
});

test('an unpaid CARD booking is payable on every surface', async () => {
  const b = { ref: 'WM-UNPAID', name: 'Lap Shing Chan', email: 'b@e.com',
              pickup: 'Morden', destination: 'Bolney', date: '2026-09-20', time: '07:00',
              passengers: 1, fare: 96, payment: 'card', paid_at: null,
              status: 'confirmed', pay_token: 'tok9' };

  /* the server */
  const lock = paymentLock(b);
  assert.strictEqual(lock.payable, true, 'the server must still take his money');

  /* the confirmation email */
  SENT = [];
  await email.sendCustomerConfirmed(b);
  const html = (SENT[0] || {}).html || '';
  assert.ok(/Pay Now|Pay £/.test(html), 'the confirmation email has no Pay Now button');
  assert.ok(/Pay Your Driver On The Day/.test(html), 'and no way to choose cash either');

  /* the tokenised cash link — it said "already paid online" and refused */
  const pub = require('../public-api');
  db.prepare(`INSERT INTO bookings (ref,pickup,destination,date,time,passengers,fare,payment,status,pay_token)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run('WM-UNPAID', 'Morden', 'Bolney', '2026-09-20', '07:00', 1, 96, 'card', 'confirmed', 'tok9');
  const r = await call(pub, 'get', '/pay/:ref/cash', { params: { ref: 'WM-UNPAID' }, query: { t: 'tok9' } });
  assert.ok(!/already been paid/i.test(String(r.body || '')),
    'the cash link still tells him the journey is paid: ' + String(r.body || '').slice(0, 120));
});

test('a PAID booking is still closed on every surface', async () => {
  const b = { ref: 'WM-PAID', name: 'Ben', email: 'b@e.com', pickup: 'A', destination: 'B',
              date: '2026-09-20', time: '07:00', passengers: 1, fare: 96,
              payment: 'card', paid_at: '2026-09-01 10:00:00', status: 'confirmed', pay_token: 't' };
  assert.strictEqual(paymentLock(b).payable, false, 'a paid trip must not be payable');
  SENT = [];
  await email.sendCustomerConfirmed(Object.assign({}, b, { paid: true }));
  const html = (SENT[0] || {}).html || '';
  assert.ok(!/Pay Now/.test(html), 'a receipt must not ask for money again');
});

// ── 2. THE METHOD CANNOT BE TYPED ────────────────────────────────────────
console.log('\n"Card" is what a payment does, not a field you fill in');

let BID = null;
test('PATCH cannot set payment=card', async () => {
  db.prepare(`INSERT INTO bookings (ref,pickup,destination,date,time,passengers,fare,payment,status,pay_token)
              VALUES ('WM-PATCH','A','B','2026-09-20','07:00',1,96,'pending','confirmed','tok')`).run();
  BID = db.prepare("SELECT id FROM bookings WHERE ref='WM-PATCH'").get().id;
  const r = await call(api, 'patch', '/bookings/:id',
    { params: { id: String(BID) }, body: { payment: 'card' } });
  assert.strictEqual(r.statusCode, 400, 'card was accepted as an ordinary field edit');
  assert.ok(/Mark Paid/i.test(r.body.error), 'and it must say where to record a real one');
  const row = db.prepare('SELECT payment, paid_at FROM bookings WHERE id = ?').get(BID);
  assert.strictEqual(row.payment, 'pending', 'the booking must be untouched');
  assert.strictEqual(row.paid_at, null);
});

test('the other methods are still editable', async () => {
  for (const m of ['cash', 'account', 'invoice', 'pending']) {
    const r = await call(api, 'patch', '/bookings/:id',
      { params: { id: String(BID) }, body: { payment: m } });
    assert.strictEqual(r.statusCode, 200, m + ' should still be settable: ' + JSON.stringify(r.body));
  }
  db.prepare("UPDATE bookings SET payment='pending' WHERE id = ?").run(BID);
});

test('Mark Paid records the fact AND the method, together', async () => {
  const r = await call(api, 'post', '/bookings/:id/mark-paid',
    { params: { id: String(BID) }, body: { method: 'card' } });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  const row = db.prepare('SELECT payment, paid_at, paid_amount FROM bookings WHERE id = ?').get(BID);
  assert.strictEqual(row.payment, 'card', 'the method was not recorded');
  assert.ok(row.paid_at, 'the fact was not recorded');
  assert.strictEqual(row.paid_amount, 96, 'and what was taken');
  /* Which closes it everywhere — the point of writing both. */
  assert.strictEqual(paymentLock(row).payable, false);
});

test('Mark Paid without a method leaves the method alone', async () => {
  db.prepare(`INSERT INTO bookings (ref,pickup,destination,date,time,passengers,fare,payment,status)
              VALUES ('WM-NOM','A','B','2026-09-21','07:00',1,50,'pending','confirmed')`).run();
  const id = db.prepare("SELECT id FROM bookings WHERE ref='WM-NOM'").get().id;
  await call(api, 'post', '/bookings/:id/mark-paid', { params: { id: String(id) }, body: {} });
  const row = db.prepare('SELECT payment, paid_at FROM bookings WHERE id = ?').get(id);
  assert.ok(row.paid_at, 'it must still settle');
  assert.strictEqual(row.payment, 'pending', 'but must not invent a method');
});

test('a nonsense method is ignored, not written', async () => {
  db.prepare(`INSERT INTO bookings (ref,pickup,destination,date,time,passengers,fare,payment,status)
              VALUES ('WM-JUNK','A','B','2026-09-21','07:00',1,50,'pending','confirmed')`).run();
  const id = db.prepare("SELECT id FROM bookings WHERE ref='WM-JUNK'").get().id;
  await call(api, 'post', '/bookings/:id/mark-paid',
    { params: { id: String(id) }, body: { method: 'bitcoin' } });
  assert.strictEqual(db.prepare('SELECT payment FROM bookings WHERE id = ?').get(id).payment, 'pending');
});

test('the assistant cannot create a card booking either', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'assistant-routes.js'), 'utf8');
  const m = /const payment = \[([^\]]*)\]/.exec(src);
  assert.ok(m, 'the assistant no longer whitelists payment methods');
  assert.ok(!/'card'/.test(m[1]),
    'the assistant can still create a booking as card: [' + m[1] + ']');
});

test('and the Stripe webhook still can — it writes both', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public-api.js'), 'utf8');
  const i = src.indexOf("SET payment = 'card'");
  assert.ok(i !== -1, 'the webhook no longer records a card payment at all');
  /* Bounded by the end of the statement, not by a character count — see
     server/tests/_source.js on why a window measured in characters stops
     covering its subject the day somebody adds a line above it. */
  const stmt = src.slice(i, src.indexOf('WHERE ref = ?', i));
  assert.ok(/paid_at = COALESCE\(paid_at, datetime\('now'\)\)/.test(stmt),
    'the webhook must stamp paid_at with the method, or it recreates the bug');
});

// ── 3. HISTORY KEEPS ITS ANSWER ──────────────────────────────────────────
console.log('\nJourneys already travelled stay settled');

test('the backfill stamps past card bookings and leaves the future alone', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');
  const i = src.indexOf('HISTORY KEEPS THE ANSWER IT HAD');
  assert.ok(i !== -1, 'the one-off backfill is gone — every old card trip reopens as unpaid');
  /* Bounded by the END OF THE STATEMENT, not by a character count. The first
     version used slice(i, i+1400) and the comment above the SQL pushed the SQL
     itself outside the window — the guard reported a missing clause that was
     there all along. */
  const block = src.slice(i, src.indexOf('card paid_at backfill failed', i));
  assert.ok(/payment = 'card'/.test(block) && /paid_at IS NULL/.test(block),
    'it must touch only card bookings with no stamp');
  assert.ok(/status = 'completed' OR date < \?/.test(block),
    'and only ones already travelled — a future trip must stay payable');
  assert.ok(/toLocaleDateString\('sv-SE', \{ timeZone: 'Europe\/London' \}\)/.test(block),
    '"today" must be the UK wall-clock date (CLAUDE.md timezone invariant)');
});

test('it is idempotent — the second boot changes nothing', () => {
  db.prepare(`INSERT INTO bookings (ref,pickup,destination,date,time,passengers,fare,payment,status)
              VALUES ('WM-OLD','A','B','2020-01-01','07:00',1,50,'card','completed')`).run();
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/London' });
  /* THE SHIPPED STATEMENT, EXECUTED — not a copy of it typed out here, and not
     the source read for the right-looking words. Neutering it to `WHERE 0 AND
     payment = 'card' …` left every one of those words in place and walked past
     a guard that only looked. This lifts the real UPDATE out of db.js and runs
     it, so a backfill that stamps nothing fails. */
  const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');
  const from = dbSrc.indexOf('HISTORY KEEPS THE ANSWER IT HAD');
  const sqlStart = dbSrc.indexOf('UPDATE bookings', from);
  const sqlEnd = dbSrc.indexOf('`', sqlStart);
  assert.ok(from !== -1 && sqlStart !== -1 && sqlEnd > sqlStart, 'the backfill statement is gone');
  const SQL = dbSrc.slice(sqlStart, sqlEnd);
  const run = () => db.prepare(SQL).run(today);
  assert.strictEqual(run().changes, 1, 'the first pass stamps the old trip');
  assert.strictEqual(run().changes, 0, 'the second pass must match nothing');
  /* A FUTURE card booking is deliberately left unstamped — it is the one that
     must stay payable. */
  db.prepare(`INSERT INTO bookings (ref,pickup,destination,date,time,passengers,fare,payment,status)
              VALUES ('WM-FUT','A','B','2099-01-01','07:00',1,50,'card','confirmed')`).run();
  assert.strictEqual(run().changes, 0, 'a future card booking must not be stamped as paid');
  const fut = db.prepare("SELECT * FROM bookings WHERE ref='WM-FUT'").get();
  assert.strictEqual(paymentLock(fut).payable, true, 'and it must remain payable');
});

// ── 4. THE APP ASKS THE SERVER ───────────────────────────────────────────
console.log('\nOne authority for what a customer may pay');

test('GET /bookings carries the server\'s payState', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8');
  const i = src.indexOf("THE SERVER'S OWN ANSWER, CARRIED ON THE ROW");
  assert.ok(i !== -1, 'the booking list no longer carries the lock state');
  const block = src.slice(i, src.indexOf('payState decoration failed', i));
  assert.ok(/paymentLock\(r\)/.test(block), 'and it must come from paymentLock, not a copy');
  assert.ok(/r\.payState =/.test(block));
});

test('the app reads it instead of re-deriving it', () => {
  const rider = fs.readFileSync(path.join(__dirname, '..', '..', 'westmere-rider.html'), 'utf8');
  const i = rider.indexOf('function _payState(b){');
  const fn = rider.slice(i, rider.indexOf('\n}', i));
  assert.ok(/if\(b\.payState\) return b\.payState;/.test(fn),
    'the app still decides for itself whether a trip is payable');
  /* THE FALLBACK MUST BE PERMISSIVE. The old copy returned "none" for a
     confirmed booking, which is how a customer ended up with no way to pay. */
  assert.ok(!/st==='pending'\|\|st==='offered'\|\|st==='awaiting_payment'/.test(fn.replace(/\s/g, '')),
    'the fallback still hides the buttons on a confirmed booking');
  assert.ok(/payState:b\.payState/.test(rider), 'and the field must survive the mapping');
});

// ── 5. NO CUSTOMER PAGE GOES BLACK ───────────────────────────────────────
console.log('\nNo customer-facing page is left for the phone to recolour');

test('every customer-facing page opts OUT of forced dark, not merely INTO light', () => {
  const ROOT = path.join(__dirname, '..', '..');

  /* WHY `only` AND NOT `light`.
     `color-scheme: light` says "I can be rendered light". That is exactly the
     page Android Chrome's Auto Dark Theme exists to repaint — it targets sites
     that only know how to be light and recolours them itself. The opt-out is
     the `only` keyword, which forbids the user agent overriding the scheme at
     all (Chrome's Auto Dark Theme docs; CSS Color Adjust §2.1 `only`).

     The first fix for the black screen shipped the plain form and therefore did
     not close it. This guard refuses the plain form on every surface a customer
     can land on, so the next tidy-up cannot quietly reopen it.

     Both orderings parse — `only light` and `light only` — so both are accepted;
     what is not accepted is the keyword being absent. */
  const OPTS_OUT = /(?:only\s+light|light\s+only)/i;
  const PAGES = ['westmere-pay.html', 'westmere-rider.html', 'book.html'];

  // 1. Every color-scheme META on every customer page, read out of the markup
  //    rather than matched against a fixed string — a page may carry more than
  //    one, and every one of them has to opt out.
  for (const f of PAGES) {
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const metas = html.match(/<meta[^>]+name="(?:supported-)?color-schemes?"[^>]*>/gi) || [];
    /* THE BROWSER-FACING ONE SPECIFICALLY. `supported-color-schemes` is a mail
       client convention and does nothing in Chrome, so counting metas is not
       enough: deleting the real one and leaving that behind passed an earlier
       draft of this guard. */
    assert.ok(/<meta[^>]+name="color-scheme"[^>]*>/i.test(html),
      f + ' has no name="color-scheme" meta — a phone forcing dark mode will '
      + 'recolour it, which is what turned Ben\'s screen black');
    assert.ok(metas.length, f + ' declares no colour scheme at all');
    metas.forEach((m) => {
      const content = (/content="([^"]*)"/i.exec(m) || [])[1] || '';
      assert.ok(OPTS_OUT.test(content), f + ' declares color-scheme "' + content
        + '" — that INVITES Android\'s auto-dark rather than refusing it. Needs the `only` keyword.');
    });
  }

  // 2. The server-rendered pages: the cash confirmation and the cancel/note
  //    screens, which is where the customer ends up after choosing.
  const pub = fs.readFileSync(path.join(__dirname, '..', 'public-api.js'), 'utf8');
  const pubMetas = pub.match(/<meta[^>]+name="(?:supported-)?color-schemes?"[^>]*>/gi) || [];
  assert.ok(pubMetas.length >= 4,
    'expected a colour-scheme pair on both server-rendered pages, found ' + pubMetas.length);
  assert.strictEqual((pub.match(/<meta[^>]+name="color-scheme"[^>]*>/gi) || []).length, 2,
    'both server-rendered pages need their own name="color-scheme" meta — the '
    + 'supported-color-schemes one beside it is a mail-client convention Chrome ignores');
  pubMetas.forEach((m, i) => {
    const content = (/content="([^"]*)"/i.exec(m) || [])[1] || '';
    assert.ok(OPTS_OUT.test(content),
      'server-rendered page meta ' + (i + 1) + ' declares "' + content + '" — needs `only`');
  });

  /* 3+4. Every DOCUMENT-level rule, wherever it lives.
     Element-level declarations (.fi, .cal-drop, inputs) are a different job —
     they keep native controls readable — and are deliberately not covered.

     Selectors are read by splitting real rule blocks rather than by matching a
     hand-written string, because the one that actually decides the outcome sits
     in the token layer behind a comment banner, where an anchored regex missed
     it on the first attempt. */
  const docLevel = (src) => {
    const out = [];
    const rule = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = rule.exec(src))) {
      const selectors = m[1].replace(/\/\*[\s\S]*?\*\//g, '').split(',').map((x) => x.trim());
      if (!selectors.some((sel) => sel === 'html' || sel === ':root')) continue;
      const d = /color-scheme\s*:\s*([^;!}]+)/.exec(m[2]);
      if (d) out.push({ sel: selectors.join(','), decl: d[1].trim(), important: /color-scheme[^;]*!important/.test(m[2]) });
    }
    return out;
  };

  for (const f of PAGES.concat(['server/public-api.js'])) {
    docLevel(fs.readFileSync(path.join(ROOT, f), 'utf8')).forEach((r) => {
      assert.ok(OPTS_OUT.test(r.decl),
        f + ' has a document-level `' + r.sel + ' { color-scheme: ' + r.decl + ' }` — needs `only`');
    });
  }

  /* THE ONE THAT ACTUALLY DECIDES IT.
     The token layer sets `html { color-scheme: … !important }`, and every
     customer page loads it. Because it carries !important it BEATS the page's
     own :root rule — measured in a real browser: with this line on plain
     `light`, a pay page declaring `only light` still computed to `light`, and
     stayed exposed to auto-dark. Fixing the pages and leaving this behind
     fixes nothing, which is why the assertion is separate and says so. */
  const themeRules = docLevel(fs.readFileSync(path.join(ROOT, 'westmere-theme.css'), 'utf8'));
  assert.ok(themeRules.length,
    'westmere-theme.css no longer sets a document-level colour scheme — the pages were relying on it');
  assert.ok(themeRules.some((r) => r.important),
    'the token layer\'s !important colour scheme is gone — check what now wins the cascade');
  themeRules.forEach((r) => {
    assert.ok(OPTS_OUT.test(r.decl),
      'westmere-theme.css sets `' + r.sel + ' { color-scheme: ' + r.decl
      + (r.important ? ' !important' : '') + ' }` — that overrides every page\'s own opt-out, '
      + 'so the whole site is still exposed to Android auto-dark. It needs `only`.');
  });
});

// ── run ──────────────────────────────────────────────────────────────────
(async () => {
  for (const t of queue) {
    try { await t.fn(); console.log('  ✓ ' + t.name); passed++; }
    catch (e) { console.error('  ✗ ' + t.name + '\n      ' + e.message); failed++; }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  try { fs.unlinkSync(TMP); } catch (_) {}
  process.exit(failed ? 1 : 0);
})();
