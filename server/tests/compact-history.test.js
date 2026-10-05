/**
 * THE COMPACT LIST, AND THE PAGE BEHIND THE ROW — run with:
 *   node server/tests/compact-history.test.js    (also gated by `npm test`)
 *
 * THE OWNER'S RULE, in his words: "less information on each page, then click
 * to expand."
 *
 * A history list is a SPREADSHEET: a few short columns, one line per row,
 * nothing that wraps. Everything else — the full addresses, the passenger's
 * phone, the fare, what was actually paid and by what method, a driver's
 * commission and whether he has been paid for the job — lives on the DETAIL
 * PAGE the row opens.
 *
 * WHY IT NEEDS A GUARD
 *   Both of these lists had already grown the other way. Trip History was a
 *   stack of full job cards; a driver's work history carried a route, a running
 *   balance, the working, three buttons and a rate box on every row. Each
 *   addition was reasonable on its own, and the result was a list you could not
 *   scan. The columns are DATA in /wm-compact.js — one definition for both
 *   staff apps — so this file can hold them to the five the owner named and
 *   fail the moment a sixth thing moves onto a row.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { fnBlock } = require('./_source');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const { stripComments: strip } = require('./_source');

/* The apps load /address-normalize.js before /wm-compact.js, and the short
   place labels come from it. Mirror that here, or this file would be guarding
   the fallback path rather than the one that ships. */
global.WMAddr = require('../../address-normalize');
const C = require('../../wm-compact');
const LC = require('../../wm-lifecycle');
const OWNER = strip(read('westmere-owner.html'));
const ADMIN = strip(read('westmere-admin.html'));
const THEME = read('westmere-theme.css');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

// ── 1. THE COLUMNS THE OWNER NAMED ───────────────────────────────────────
console.log('\nThe columns are the ones he asked for, and no more');

test('trip history is reference, date, passenger, pickup, drop-off — in that order', () => {
  assert.deepStrictEqual(C.HISTORY_COLUMNS.map((c) => c.key),
    ['ref', 'date', 'name', 'pickup', 'dropoff'],
    'the trip-history columns changed — that is the owner\'s own list');
  assert.deepStrictEqual(C.HISTORY_COLUMNS.map((c) => c.label),
    ['Ref', 'Date', 'Passenger', 'Pickup', 'Drop-off']);
});

test("the Paid column is the LEDGER's answer, not a raw column read", () => {
  /* It read the booking's `driver_settled` and printed "No" against every job
     on the screen — including the two the balance directly above it had just
     counted as settled. The ledger row's own `paid` is the one authority
     (driver-ledger's isSettled), and this column must read it. */
  assert.strictEqual(C.driverTripCells({ id: 1, paid: true }).paid, 'Yes');
  assert.strictEqual(C.driverTripCells({ id: 1, paid: false }).paid, 'No');
  // …and a row that predates the field still answers from the booking column.
  assert.strictEqual(C.driverTripCells({ id: 1, driver_settled: 1 }).paid, 'Yes');
  assert.strictEqual(C.driverTripCells({ id: 1 }).paid, 'No');
});

test("a driver's trips are reference, date, passenger, fare, paid", () => {
  assert.deepStrictEqual(C.DRIVER_TRIP_COLUMNS.map((c) => c.key),
    ['ref', 'date', 'name', 'fare', 'paid']);
  assert.ok(C.DRIVER_TRIP_COLUMNS.find((c) => c.key === 'fare').num,
    'money lines up down the column or it cannot be scanned');
});

test('the cells are SHORT — a label, not an address', () => {
  const v = C.historyCells({
    id: 1, ref: 'WPH-1234', date: '2026-10-04', customer_name: 'Mrs Hall',
    pickup: '14 Queens Road, Haywards Heath, West Sussex, RH16 1EA',
    destination: 'Gatwick Airport North Terminal, Crawley, England'
  });
  assert.strictEqual(v.ref, 'WPH-1234');
  assert.strictEqual(v.date, '4 Oct');
  assert.strictEqual(v.name, 'Mrs Hall');
  for (const k of ['pickup', 'dropoff']) {
    assert.ok(v[k].length <= 19, k + ' must fit a column: got "' + v[k] + '"');
    assert.ok(!v[k].includes('West Sussex'), k + ' must not carry the county: "' + v[k] + '"');
  }
});

test('a place label is a place, not a postcode', () => {
  // "Steyning BN44 3GG" is the normaliser doing its job on an address whose
  // locality and postcode share a comma-part — and in a column this narrow the
  // postcode costs the half of the label that can be read.
  assert.strictEqual(C.shortPlace('Steyning High Street, Steyning BN44 3GG'), 'Steyning');
  assert.strictEqual(C.shortPlace('Henfield, High Street BN5 9HP'), 'Henfield');
  // …but a postcode on its own is better than nothing at all.
  assert.strictEqual(C.shortPlace('BN44 3GG'), 'BN44 3GG');
  assert.strictEqual(C.shortPlace(''), '');
});

test('…and it still produces a label with the normaliser missing', () => {
  /* The same defensive line every other address surface in this app takes: a
     script that failed to load must not put a 60-character address into a
     column 7rem wide. */
  const saved = global.WMAddr;
  global.WMAddr = undefined;
  try {
    const v = C.shortPlace('14 Queens Road, Haywards Heath, West Sussex, RH16 1EA');
    assert.ok(v.length <= 18, 'the fallback must still clip: "' + v + '"');
    assert.ok(!v.includes('West Sussex'), 'the fallback must still drop the tail');
  } finally { global.WMAddr = saved; }
});

test('a blank passenger reads "Guest", never empty', () => {
  assert.strictEqual(C.historyCells({ id: 1 }).name, 'Guest');
});

// ── 2. DATES ARE WALL-CLOCK ──────────────────────────────────────────────
// The timezone invariant (CLAUDE.md): a booking date is a literal YYYY-MM-DD,
// never an instant. `new Date('2026-08-16')` is UTC midnight read back in local
// time, which renders Saturday 15th on any host west of UTC — and this column
// is the one the owner reads a trip off.
console.log('\nThe date column is wall-clock, like every other date here');

test('shortDate reads the components literally, with no Date parsing', () => {
  assert.strictEqual(C.shortDate('2026-08-16'), '16 Aug');
  assert.strictEqual(C.shortDate('2026-01-01'), '1 Jan');
  assert.strictEqual(C.shortDate('2026-12-31'), '31 Dec');
  assert.strictEqual(C.shortDate(''), '', 'a missing date renders empty, not "Invalid Date"');
  assert.strictEqual(C.shortDate('ASAP'), '');
  assert.strictEqual(C.shortDate('2026-08-16T21:00'), '16 Aug', 'a stamp still reads as its day');
  const src = fnBlock(strip(read('wm-compact.js')), 'shortDate');
  assert.ok(!/new Date\(\s*(ymd|String)/.test(src),
    'shortDate must never build a Date out of the date string — that is the invariant');
});

test('a past year is marked, so a two-year list cannot be misread', () => {
  assert.strictEqual(C.shortDate('2024-01-09', 2026), '9 Jan 24');
  assert.strictEqual(C.shortDate('2026-01-09', 2026), '9 Jan');
});

// ── 3. MONEY AND METHOD ──────────────────────────────────────────────────
console.log('\nWhat was paid, and how');

test('the method is never silently defaulted to cash', () => {
  // CLAUDE.md payment invariant #1: `pending` means NO CHOICE YET and is the
  // only default. A detail page that reads a blank as "Cash" is the "Mr Ben"
  // incident wearing different clothes.
  for (const j of [{}, { payment: '' }, { payment: 'nonsense' }, { payment: null }]) {
    assert.strictEqual(C.payMethod(j), 'pending', JSON.stringify(j) + ' must read as pending');
    assert.ok(!/cash/i.test(C.payMethodLabel(j)), 'an unknown method must never say cash');
  }
  assert.strictEqual(C.payMethod({ payment: 'CARD' }), 'card', 'the method is case-insensitive');
  assert.deepStrictEqual(Object.keys(C.PAY_LABELS).sort(),
    ['account', 'card', 'cash', 'invoice', 'pending'],
    'the methods must mirror server/payment-methods.js');
});

test('a card says card or debit — a debit card is not a different method here', () => {
  assert.ok(/debit/i.test(C.PAY_LABELS.card),
    'the owner asked for card/debit to be named: it is one Stripe charge either way');
});

test('the paid line says whether the money arrived, not only what was asked', () => {
  assert.ok(/paid/.test(C.paidLine({ fare: 120, paid_at: '2026-09-01', payment: 'cash' })));
  assert.ok(/not paid/i.test(C.paidLine({ fare: 120, payment: 'invoice' })),
    'an unpaid fare must say so — the gap is what the owner is looking for');
  assert.ok(/Cash to the driver/.test(C.paidLine({ fare: 120, paid_at: 'x', payment: 'cash' })),
    'the method travels with the fact');
});

test('the paid line and the payment badge cannot disagree', () => {
  /* A booking only ever reads `card` because a Stripe payment succeeded
     (CLAUDE.md payment invariant #1), and the shared badge says "Prepaid ✓" on
     that alone. Reading `paid_at` by itself put "not paid yet" directly
     underneath that badge on the same screen. One test, both places. */
  const card = { fare: 85, payment: 'card', paid_at: null };
  assert.strictEqual(LC.payStatus(card).key, 'prepaid');
  assert.strictEqual(C.isPaid(card), true, 'a card booking is paid, badge and sentence alike');
  assert.ok(/paid ·/.test(C.paidLine(card)) && !/not paid/.test(C.paidLine(card)));
  // …and nothing else is paid without the stamp.
  for (const p of ['cash', 'account', 'invoice', 'pending']) {
    assert.strictEqual(C.isPaid({ fare: 85, payment: p }), false, p + ' must not read as paid');
    assert.strictEqual(C.isPaid({ fare: 85, payment: p, paid_at: '2026-09-01' }), true,
      p + ' with a stamp IS paid');
  }
});

// ── 4. THE ROW OPENS A PAGE ───────────────────────────────────────────────
console.log('\nEvery row opens the page behind it');

test('each row carries the open call, keyboard access and a chevron', () => {
  const html = C.historyTable([{ id: 7, ref: 'WPH-7', date: '2026-10-04', name: 'Mrs Hall',
                                 pickup: 'Steyning', destination: 'Gatwick' }], 'openTripPage');
  assert.ok(/onclick="openTripPage\(&quot;7&quot;\)"|onclick="openTripPage\("7"\)/.test(html),
    'the row must open the detail page: ' + html.slice(0, 400));
  assert.ok(/tabindex="0"/.test(html) && /role="button"/.test(html),
    'a spreadsheet you can only reach with a thumb is not navigable');
  assert.ok(/onkeydown=/.test(html) && /Enter/.test(html), 'Enter must open the row too');
  assert.ok(/aria-label="[^"]*open the full details/.test(html),
    'a screen reader must be told the row opens something');
  assert.ok(/wm-ctab-chev/.test(html), 'the row must show that it opens something');
  // One <th> per column, plus the chevron's.
  assert.strictEqual((html.match(/<th /g) || []).length, C.HISTORY_COLUMNS.length + 1);
});

test('an id with a quote in it cannot break out of the handler', () => {
  /* The id lands inside onclick="…" — an HTML attribute whose contents are
     JavaScript — so it needs BOTH escapes. With only the JSON one, the raw `"`
     closes the attribute and everything after it becomes markup. */
  const html = C.historyTable([{ id: '7") ; alert(1' }], 'openTripPage');
  const attr = /onclick="([^"]*)"/.exec(html);
  assert.ok(attr, 'the handler attribute must still be well formed: ' + html.slice(0, 300));
  assert.ok(attr[1].startsWith('openTripPage(&quot;'),
    'the id must be HTML-escaped into the attribute, not left raw: ' + attr[1]);
  // And decoded back, it is one JavaScript string argument — nothing escaped.
  const decoded = attr[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  assert.ok(/^openTripPage\("(?:[^"\\]|\\.)*"\)$/.test(decoded),
    'the handler must be a single quoted argument: ' + decoded);
});

test('the table escapes what it renders', () => {
  const html = C.historyTable([{ id: 1, name: '<script>x</script>', ref: 'a&b' }], 'openX');
  assert.ok(!/<script>x/.test(html), 'a passenger name is not markup');
  assert.ok(/a&amp;b/.test(html));
});

// ── 5. BOTH APPS USE IT ───────────────────────────────────────────────────
console.log('\nBoth staff apps read the same module');

test('both apps load wm-compact.js', () => {
  for (const [f, src] of [['owner', OWNER], ['admin', ADMIN]]) {
    assert.ok(/<script src="\/wm-compact\.js(\?v=[^"]*)?">/.test(src), f + ' does not load the shared module');
  }
});

test('trip history is a compact table in BOTH apps, not a stack of cards', () => {
  const o = fnBlock(OWNER, 'buildCompleted');
  assert.ok(/WMCompact\.historyTable\(/.test(o), 'the owner trip history must render the compact table');
  assert.ok(!/jobCardHtml/.test(o), 'the owner trip history must not stack full job cards any more');
  assert.ok(/openTripPage/.test(o), 'the owner rows must open the trip page');

  /* ADMIN IS A DESK AND HAS THE WIDTH FOR MORE COLUMNS — it renders
     journeyTable rather than historyTable. Same module, same cells, same
     escaping and the same row-opens-the-page behaviour; what differs is how
     many of the columns the window has room for. The thing this test exists to
     prevent is a stack of cards, or a hand-written table in one app that can
     drift from the other's. Both still come from wm-compact.js. */
  const a = fnBlock(ADMIN, 'buildAdmHistory');
  assert.ok(/WMCompact\.journeyTable\(/.test(a), 'the admin journeys list must render a shared table');
  assert.ok(!/admJobRow/.test(a), 'the admin trip history must not stack full job rows any more');
  assert.ok(/admOpenTrip/.test(a), 'the admin rows must open the trip page');
});

test("a driver's trips are a compact table in BOTH apps", () => {
  const o = fnBlock(OWNER, 'owDriverLoad');
  assert.ok(/WMCompact\.driverTripTable\(/.test(o), 'the owner driver page must render the compact table');
  assert.ok(/owDrvTripOpen/.test(o), 'the owner trips rows must open the trip page');

  const a = ADMIN.slice(ADMIN.indexOf('async function dmLoadLedger'));
  assert.ok(/WMCompact\.driverTripTable\(/.test(a), 'the admin driver ledger must render the compact table');
  assert.ok(/admDrvTripOpen/.test(a), 'the admin trips rows must open the trip page');
});

// ── 6. THE DETAIL PAGE CARRIES EVERYTHING ────────────────────────────────
console.log('\nThe detail page carries what the list left out');

test('a job detail page shows the FULL addresses, the phone and the money', () => {
  const o = fnBlock(OWNER, 'jobCardHtml');
  assert.ok(/From<\/td><td>'\+escH\(j\.pickup/.test(o), 'the owner detail needs the whole pickup');
  assert.ok(/Phone/.test(o) && /tel:/.test(o), 'the owner detail needs a dialable phone number');
  assert.ok(/WMCompact\.paidLine\(j\)/.test(o), 'the owner detail must say what was actually paid');

  const d = fnBlock(ADMIN, 'bookingDetailHtml');
  assert.ok(/_jdField\('Pickup',escTo\(b\.pickup\)\)/.test(d), 'the admin detail needs the whole pickup');
  assert.ok(/_jdField\('Phone'/.test(d), 'the admin detail needs the phone number');
  const trip = fnBlock(ADMIN, 'admTripRender');
  assert.ok(/WMCompact\.paidLine\(b\)/.test(trip) && /WMCompact\.payMethodLabel\(b\)/.test(trip),
    'the admin trip page must say what was paid and by what method');
});

test('a detail modal uses the house head, so the close button is where it belongs', () => {
  /* The stylesheet defines `.modal-hd`. `modal-head` matches nothing at all,
     so the head lost its flex row and the × dropped underneath the title —
     over the list behind it. Three modals had copied the wrong name, the
     operator page among them, and its own comment said it was fixing exactly
     this. */
  assert.ok(!/class="modal-head"/.test(ADMIN), 'modal-head is not a class this stylesheet defines');
  assert.ok(/\.modal-hd\{display:flex/.test(ADMIN), 'the house modal head must stay a flex row');
  for (const id of ['modal-trip', 'modal-drvtrip']) {
    const blk = ADMIN.slice(ADMIN.indexOf("m.id='" + id + "'"), ADMIN.indexOf("m.id='" + id + "'") + 700);
    assert.ok(/class="modal-hd"/.test(blk), id + ' must use the house modal head');
    assert.ok(/class="modal-x"/.test(blk), id + ' must have a close button');
  }
});

test("a driver trip page shows the commission, the method and the paid tick", () => {
  for (const [who, fn] of [['owner', fnBlock(OWNER, 'owDrvTripHtml')],
                           ['admin', fnBlock(ADMIN, 'admDrvTripHtml')]]) {
    assert.ok(/commission_pct/.test(fn), who + ' trip page must say the rate it is on');
    assert.ok(/cover job/i.test(fn), who + ' trip page must offer the no-commission case');
    assert.ok(/payMethodLabel/.test(fn), who + ' trip page must name the payment method');
    assert.ok(/Mark paid/.test(fn), who + ' trip page must carry the paid tick');
    assert.ok(/it\.pickup/.test(fn) && /it\.destination/.test(fn),
      who + ' trip page must carry the whole route, not the short label');
  }
});

test('the ledger row carries the passenger and the method the page needs', () => {
  const ledger = require('../driver-ledger');
  const row = fnBlock(strip(read('server/driver-ledger.js')), 'historyRow');
  assert.ok(/name: b\.customer_name/.test(row), 'a trips list is read by passenger');
  assert.ok(/payment: b\.payment \|\| 'pending'/.test(row),
    "the stored method must travel with the row — and never default to cash");
  assert.ok(!/payment: b\.payment \|\| 'cash'/.test(row), 'NEVER default a payment method to cash');
  assert.ok(typeof ledger.driverHistory === 'function');
});

// ── 7. THE LIST STAYS A LIST ──────────────────────────────────────────────
console.log('\nThe list stays a list');

test('the compact table does not wrap, and scrolls rather than squashing', () => {
  const sec = THEME.slice(THEME.indexOf('§28  THE COMPACT LIST'));
  assert.ok(/white-space:\s*nowrap/.test(sec), 'a row that wraps is two rows and the column is lost');
  assert.ok(/overflow-x:\s*auto/.test(sec), 'a wide table must scroll inside itself');
  assert.ok(/color-scheme:\s*only light/.test(sec),
    'these tables render inside overlays — Auto Dark would repaint them black on black');
  assert.ok(/@media \(max-width: 480px\)/.test(sec), 'the table must answer to a 390px phone');
  /* On a phone the REFERENCE gives up its column. Five columns of prose do not
     fit in 390px, and of the five the ref is the one he reads off an email
     rather than off this list — the drop-off is half the journey and was the
     half falling off the right-hand edge. */
  const phone = sec.slice(sec.indexOf('@media (max-width: 480px)'));
  assert.ok(/\.wm-ctab col:first-child\{ width: 0 !important; \}/.test(phone),
    'the phone layout must drop the reference column, not clip the drop-off');
  /* COLLAPSED, NOT REMOVED. `display:none` takes the cell out of the row and
     every later cell inherits the width of the column before it — the date
     column vanished and the passenger came out as "M…". */
  assert.ok(/text-indent:\s*-999px/.test(phone),
    'the reference cell must be collapsed to nothing, not display:none-d out of the row');
  assert.ok(!/\.wm-ctab-c:first-child\{\s*display:\s*none/.test(phone),
    'display:none on a column of a fixed-layout table shifts every later cell');
  // And the four that remain are given stated widths, per kind of table.
  for (const kind of ['history', 'trips']) {
    assert.strictEqual((phone.match(new RegExp('\\.wm-ctab-' + kind + ' col:nth-child', 'g')) || []).length, 4,
      'the ' + kind + ' table must state all four remaining phone widths');
  }
  assert.ok(!/#C9A227|#8A6A12/.test(sec), 'gold comes from the token layer, even as a fallback');
});

test('"Completed" is not a page in either app any more', () => {
  // A finished job is HISTORY and lives in exactly one place. The owner asked
  // for the concept gone, not renamed in one app and kept in the other.
  assert.ok(!/id="view-completed"/.test(ADMIN), 'the admin Completed view must be gone');
  assert.ok(!/nav\('completed'/.test(ADMIN), 'no admin sidebar entry may open a Completed page');
  /* The owner's phone calls it Trip History; admin's one list holds every
     journey, finished or not, so it is called Journeys. What matters here is
     that NEITHER calls anything "Completed" — a finished job is not a category
     of its own, which is the thing the owner asked to be rid of. */
  assert.ok(/Trip <em>History<\/em>/.test(OWNER), 'the owner app must call it Trip History');
  assert.ok(/<em>Journeys<\/em>/.test(ADMIN), 'the admin app must call its one list Journeys');
  assert.ok(!/>Completed</.test(ADMIN.replace(/Mark Completed/g, '')),
    'admin has a page or tab called Completed again');
});

// ── 8. ONE LIST, BOTH OUTCOMES ───────────────────────────────────────────
// The owner's final call on the tabs: no Completed tab AND no Cancelled tab.
// One Trip History holding everything finished, with the cancelled trips
// marked inside it. His question of an old booking is "what happened to it",
// and the answer used to depend on guessing which of two tabs to open.
console.log('\nOne Trip History, holding both outcomes');

test('neither app has a Cancelled view left', () => {
  assert.ok(!/id="view-cancelled"/.test(ADMIN), 'the admin Cancelled view must be gone');
  assert.ok(!/nav\('cancelled'/.test(ADMIN), 'no admin sidebar entry may open a Cancelled page');
  assert.ok(!/function buildAdmCancelled\b/.test(ADMIN), 'its builder must be gone with it');
  assert.ok(!/id="cancelled-section"/.test(OWNER), 'the owner Cancelled section must be gone');
  assert.ok(!/function buildCancelled\b/.test(OWNER), 'its builder must be gone with it');
  // Exactly one history pane survives in each app.
  assert.strictEqual((ADMIN.match(/id="adm-history-list"/g) || []).length, 1);
  assert.strictEqual((OWNER.match(/id="completed-list"/g) || []).length, 1);
});

test('the ONE list is built from completed AND cancelled, in both apps', () => {
  const o = fnBlock(OWNER, 'buildCompleted');
  assert.ok(/COMPLETED_JOBS\|\|\[\]\)\.concat\(CANCELLED_JOBS/.test(o),
    'the owner Trip History must hold both outcomes');
  /* Admin's list now holds MORE than both outcomes — it holds every journey,
     because a list he has to leave to find a booking that has not happened yet
     is a list he has to leave. So the test is that it filters NOTHING out:
     cancelled journeys cannot be hidden in a page of their own again. */
  const a = fnBlock(ADMIN, 'buildAdmHistory');
  assert.ok(/ALL_BOOKINGS\|\|\[\]\)\.slice\(\)/.test(a),
    'the admin journeys list has started filtering, which is how a second page gets born');
  assert.ok(!/\.filter\(/.test(a), 'the admin journeys list drops some journeys: ' + a.slice(0, 200));
});

test('a cancelled row is LABELLED, and reads as cancelled', () => {
  const done = { id: 1, ref: 'W1', date: '2026-10-02', customer_name: 'Mrs Hall',
                 pickup: 'Steyning', destination: 'Gatwick', status: 'completed' };
  const gone = { id: 2, ref: 'W2', date: '2026-10-03', customer_name: 'Mr Vane',
                 pickup: 'Hove', destination: 'Heathrow', status: 'cancelled' };
  const html = C.historyTable([done, gone], 'openTripPage');
  assert.ok(/>Cancelled</.test(html), 'the row must carry the word, not a colour alone');
  assert.ok(/class="wm-ctab-r is-cancelled"/.test(html), 'the row must be marked for the stylesheet');
  assert.ok(/aria-label="[^"]*cancelled[^"]*"/.test(html), 'a screen reader must be told too');
  // The completed row beside it is NOT marked.
  const rows = html.split('<tr class="wm-ctab-r');
  assert.strictEqual(rows.filter((r) => r.startsWith(' is-cancelled')).length, 1,
    'exactly one of the two rows is the cancelled one');
  // The Status column appears only when there is something to say.
  assert.strictEqual(C.historyColumnsFor([done]).length, 5, 'no empty Status column on a clean month');
  assert.strictEqual(C.historyColumnsFor([done, gone]).length, 6, 'a cancelled trip earns the column');
  assert.ok(!/Status/.test(C.historyTable([done], 'openTripPage')));
});

test('the owner app\'s own job shape is read correctly', () => {
  /* In the owner app the server\'s status lives on `apiStatus` and `status` is
     the driver-facing stage ("done", "enroute"). Reading the wrong one marks
     nothing, or marks everything. */
  assert.strictEqual(C.isCancelled({ apiStatus: 'cancelled', status: 'done' }), true);
  assert.strictEqual(C.isCancelled({ apiStatus: 'completed', status: 'done' }), false);
  assert.strictEqual(C.isCancelled({ status: 'cancelled' }), true);
  assert.strictEqual(C.isCancelled({}), false);
  assert.strictEqual(C.isCancelled(null), false);
});

test('a cancelled trip earns NOTHING towards the month', () => {
  /* The month header sums the fares in its group. Once the cancelled trips
     joined the list, the fare of a journey that never ran would have gone
     straight into the takings at the top of the month. */
  const g = LC.groupByMonth([
    { date: '2026-09-02', fare: 100, status: 'completed' },
    { date: '2026-09-05', fare: 80, status: 'cancelled' },
    { date: '2026-09-09', fare: 60, status: 'completed' }
  ])[0];
  assert.strictEqual(g.takings, 160, 'a cancelled fare must not be in the takings');
  assert.strictEqual(g.jobs, 2, 'a cancelled trip is not a job that was done');
  assert.strictEqual(g.cancelled, 1);
  assert.strictEqual(g.items.length, 3, 'but it is still IN the list');
  // Both apps print those three figures rather than re-deriving them.
  for (const [who, fn] of [['owner', fnBlock(OWNER, 'buildCompleted')],
                           ['admin', fnBlock(ADMIN, 'buildAdmHistory')]]) {
    assert.ok(/g\.jobs/.test(fn), who + ' must count the jobs that ran, not the rows');
    assert.ok(/g\.cancelled/.test(fn), who + ' must say how many were cancelled');
    assert.ok(!/g\.items\.length\+?\(?.{0,12}' job'/.test(fn),
      who + ' must not count cancelled rows as jobs done');
  }
});

test('the detail page says it was cancelled, in a sentence', () => {
  for (const [who, src] of [['owner', OWNER], ['admin', ADMIN]]) {
    assert.ok(/WMCompact\.isCancelled\((?:j|b)\)\?/.test(src),
      who + ' detail page must branch on whether the trip was cancelled');
    assert.ok(/This journey was cancelled/.test(src),
      who + ' detail page must say so in words, not a chip alone');
    assert.ok(/counts nothing towards (?:your |the )income/.test(src),
      who + ' must say what that means for the money');
  }
});

test('a cancelled row still opens its page — it is not in the live job list', () => {
  /* OFFERED_JOBS deliberately excludes cancelled bookings so they never reach
     the schedule. The trip page looked there and only there, so every cancelled
     row in the new list would have opened nothing at all. */
  const fn = fnBlock(OWNER, 'tripById');
  assert.ok(/OFFERED_JOBS/.test(fn) && /CANCELLED_JOBS/.test(fn),
    'the trip page must look in both lists');
  assert.ok(/var j=tripById\(id\)/.test(fnBlock(OWNER, 'openTripPage')),
    'openTripPage must use it');
  assert.ok(/var still=tripById\(_tripPageId\)/.test(fnBlock(OWNER, 'refreshTripPage')),
    'and so must the refresh, or an open page drops its own trip');
  // Admin reads one list of every booking, so it needs no second lookup.
  assert.ok(/ALL_BOOKINGS\|\|\[\]\)\.find/.test(fnBlock(ADMIN, 'admOpenTrip')),
    'the admin trip page reads the full bookings list');
});

(async () => {
  for (const t of queue) {
    try { await t.fn(); console.log('  ✓ ' + t.name); passed++; }
    catch (e) { console.error('  ✗ ' + t.name + '\n      ' + e.message); failed++; }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
