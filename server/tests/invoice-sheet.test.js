/**
 * THE LINE-ITEM SHEET — run with:
 *   node server/tests/invoice-sheet.test.js   (also gated by `npm test`)
 *
 * The owner photographed the invoice editor and called it messy, and it was:
 * a journey asked for Date, From and To on one line, then a Card tick, Fare,
 * Com., Toll and a × on another, every input a different width. Seven trips
 * came out as fourteen ragged half-rows and nothing lined up down the page.
 *
 * WHAT HE ASKED FOR, in two parts:
 *   1. EVERYTHING IN LINE. One trip, one row, on columns that line up with
 *      their heading — a small tidy spreadsheet.
 *   2. POP-OUT DATA ENTRY. The form stays small; tapping a cell enlarges it
 *      into a window for that one field — the booking address picker for the
 *      places — and OK collapses it back into the row.
 *
 * THE TWO ARE THE SAME FIX. A column has no room for an address, and cramming
 * one in is what made the row wrap; moving the address into a pop-out is what
 * lets the row be a row. So this file holds both halves together: one grid,
 * declared once and shared by the heading and by both apps, and cells that
 * open the shared editor and write a resolved address back.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { stripComments: strip, fnBlock } = require('./_source');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const OWNER = read('westmere-owner.html');
const ADMIN = read('westmere-admin.html');
const THEME = read('westmere-theme.css');
const ASK = read('wm-ask.js');
const SHEET = THEME.slice(THEME.indexOf('§29  THE LINE-ITEM SHEET'));

const BUILDERS = [['owner', OWNER, 'invAddItem'], ['admin', ADMIN, 'addBespokeItem']];

// ── 1. ONE TRIP, ONE ROW ─────────────────────────────────────────────────
console.log('\nOne trip is one row, on columns that line up');

test('the grid is declared ONCE, and the heading shares it', () => {
  assert.ok(/\.wm-sheet-row\{[\s\S]*?grid-template-columns:/.test(SHEET),
    'the row must be a grid, not a flex line that wraps');
  /* The heading is the same row class, so a column cannot drift away from its
     own label — which is what "nothing lines up" was. */
  for (const [who, src] of [['owner', OWNER], ['admin', ADMIN]]) {
    assert.ok(/class="wm-sheet-row wm-sheet-head"/.test(src), who + ' has no heading row');
    const head = /class="wm-sheet-row wm-sheet-head"[\s\S]*?<\/div>/.exec(src)[0];
    for (const col of ['Date', 'From', 'To', 'Fare', 'Com.', 'Toll', 'Card']) {
      assert.ok(head.indexOf('>' + col + '<') !== -1, who + ' heading has no ' + col);
    }
  }
});

test('every row is built on that grid, in both apps', () => {
  for (const [who, src, fn] of BUILDERS) {
    const row = fnBlock(strip(src), fn);
    assert.ok(/className='ni-item wm-sheet-row'|className="ni-item wm-sheet-row"/.test(row.replace(/\s+/g, ' ')),
      who + ' does not build its row on the shared grid');
    /* IN THE SAME ORDER AS THE HEADING. A row whose cells are in a different
       order than its labels is worse than no labels. */
    const order = ['ni-date', 'ni-from', 'ni-to', 'ni-amt', 'ni-com', 'ni-fee', 'ni-collected'];
    let at = -1;
    for (const cls of order) {
      const i = row.indexOf(cls);
      assert.ok(i > at, who + ': ' + cls + ' is out of order against the heading');
      at = i;
    }
  }
});

test('nothing in the row can wrap it onto a second line', () => {
  /* The old editor was two flex rows; it folded because the content decided
     the width. A grid of fixed tracks cannot. */
  for (const [who, src, fn] of BUILDERS) {
    const row = fnBlock(strip(src), fn);
    assert.ok(!/<br/.test(row), who + ' puts a line break in a row');
    assert.ok(!/margin-bottom:\.3rem|margin-bottom:\.35rem/.test(row),
      who + ' still has the gap between two stacked half-rows');
    assert.ok(!/} else {/.test(row),
      who + ' has two row builders again — the different widths are what did not line up');
  }
  assert.ok(/white-space: nowrap/.test(SHEET), 'the address cell must truncate, never wrap');
  assert.ok(/text-overflow: ellipsis/.test(SHEET));
});

test('the controls are one height and one width, not ragged', () => {
  assert.ok(/\.wm-sheet input\[type="date"\], \.wm-sheet input\[type="number"\], \.wm-sheet \.wm-cell\{/.test(SHEET),
    'every control in the sheet must take the same sizing rule');
  const block = SHEET.slice(SHEET.indexOf('.wm-sheet input[type="date"]'));
  assert.ok(/width: 100%/.test(block) && /min-height: 30px/.test(block),
    'they must fill their column and share a height');
  /* …and no builder may type its own width over the top. */
  for (const [who, src, fn] of BUILDERS) {
    const row = fnBlock(strip(src), fn);
    assert.ok(!/style="[^"]*width:\s*\d/.test(row), who + ' types a width into a cell');
    assert.ok(!/grid-template-columns/.test(row), who + ' declares its own columns');
  }
});

test('a customer invoice shows no Com. and no Card', () => {
  /* They belong to a settlement with another firm. The columns collapse and
     the grid closes up, rather than two empty cells sitting on a bill. */
  assert.ok(/\.wm-sheet:not\(\.wm-sheet-op\) \.wm-sheet-row\{[\s\S]*?grid-template-columns:/.test(SHEET),
    'the customer shape needs its own column set');
  assert.ok(/nth-child\(5\),[\s\S]{0,120}nth-child\(7\)\{ display: none/.test(SHEET),
    'and the two columns must collapse');
  for (const [who, src] of [['owner', OWNER], ['admin', ADMIN]]) {
    assert.ok(/classList\.toggle\('wm-sheet-op'/.test(src), who + ' never tells the sheet which shape it is');
  }
});

// ── 2. THE POP-OUT ───────────────────────────────────────────────────────
console.log('\nTap a cell, it enlarges, fill it, it goes back');

test('an address cell is a button that opens the editor', () => {
  for (const [who, src, fn] of BUILDERS) {
    const row = fnBlock(strip(src), fn);
    for (const cls of ['ni-from', 'ni-to']) {
      assert.ok(new RegExp('class="wm-cell ' + cls).test(row),
        who + ': ' + cls + ' must be a cell, not an input that forces the row to wrap');
    }
    assert.ok(/CellEdit\(this,\\?'From\\?'\)/.test(row) && /CellEdit\(this,\\?'To\\?'\)/.test(row),
      who + ' cells do not open the pop-out');
    assert.ok(!/class="fi ni-from"|class="fi ni-to"/.test(row),
      who + ' still has the old address inputs in the row');
  }
});

test('the pop-out carries the booking address picker, and gives back the resolved address', () => {
  assert.ok(/o\.lookup && window\.WMLookup/.test(ASK) && /WMLookup\.attach\(input\)/.test(ASK),
    'WMAsk must attach the lookup when asked');
  assert.ok(/WMLookup\.full\(el\)/.test(ASK),
    'and return what the picker resolved, not what was half-typed');
  for (const [who, src] of [['owner', OWNER], ['admin', ADMIN]]) {
    const fn = /async function (inv|adm)CellEdit\([\s\S]*?\n\}/.exec(strip(src));
    assert.ok(fn, who + ' has no pop-out editor');
    const flat = fn[0].replace(/\s+/g, '');
    assert.ok(/lookup:true/.test(flat), who + ' opens the pop-out without the picker');
    assert.ok(/ok:'OK'/.test(flat), who + ' — the owner asked for an OK');
  }
});

test('OK writes back; Cancel leaves the cell alone', () => {
  for (const [who, src] of [['owner', OWNER], ['admin', ADMIN]]) {
    const fn = /async function (inv|adm)CellEdit\([\s\S]*?\n\}/.exec(strip(src))[0];
    assert.ok(/if \(v === null\) return;|if\(v===null\)return;/.test(fn.replace(/\s+/g, (m) => m.includes('\n') ? '\n' : ' ')),
      who + ' does not treat Cancel as "leave it"');
    assert.ok(/CellSet\(btn, ?v\)|CellSet\(btn,v\)/.test(fn), who + ' does not write the answer back');
    assert.ok(/CalcTotal\(\)|updateBespokeTotal\(\)/.test(fn), who + ' does not redraw the totals');
  }
});

test('the cell holds the FULL address and shows the SHORT one', () => {
  /* The same split the invoice itself keeps: the bill prints a place, the row
     remembers the address. server/tests/invoice-lines.test.js */
  for (const [who, src] of [['owner', OWNER], ['admin', ADMIN]]) {
    const fn = /function (inv|adm)CellSet\([\s\S]*?\n\}/.exec(strip(src))[0];
    assert.ok(/btn\.dataset\.full = f|btn\.dataset\.full=f/.test(fn), who + ' does not keep the full address');
    assert.ok(/shortDisplay|_invShort/.test(fn), who + ' does not show the short one');
    assert.ok(/btn\.title = f|btn\.title=f/.test(fn),
      who + ' — the whole address should still be readable on hover');
  }
  /* …and the readers take it from there rather than from a lookup that is no
     longer attached to anything. */
  assert.ok(/fromEl&&fromEl\.dataset\.full/.test(strip(OWNER).replace(/\s/g, '')),
    'the owner app must read the cell');
  assert.ok(/fromEl&&fromEl\.dataset\.full/.test(strip(ADMIN).replace(/\s/g, '')),
    'and so must admin');
});

// ── 3. IT IS STILL THE HOUSE ─────────────────────────────────────────────
test('the sheet is blue, gold and white, and refuses the phone repaint', () => {
  assert.ok(/color-scheme: only light/.test(SHEET),
    'a form inside an overlay must refuse Auto Dark — that is the black-box class');
  assert.ok(/--westmere-gold-ink/.test(SHEET), 'the headings are the house gold ink');
  assert.ok(/--westmere-gold\)/.test(SHEET), 'and the rule under them is the gold');
  assert.ok(!/#C9A227|#8A6A12/.test(SHEET), 'from the token layer, not typed in');
  assert.ok(/@media \(max-width: 560px\)/.test(SHEET), 'and it must survive a phone');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/invoice-sheet\.test\.js/.test(read('package.json')),
    'add it to npm test or it will not run again');
});

(async () => {
  for (const t of queue) {
    try { await t.fn(); console.log('  ✓ ' + t.name); passed++; }
    catch (e) { console.error('  ✗ ' + t.name + '\n      ' + e.message); failed++; }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
