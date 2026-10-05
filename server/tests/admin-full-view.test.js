/**
 * THE DESK IS THE POINT — run with:
 *   node server/tests/admin-full-view.test.js   (also gated by `npm test`)
 *
 * The admin app is the owner's DESKTOP system, and its driver editor was a
 * 640px column down the middle of it: the man's details, his car, his
 * licences, his login, his week's earnings and his running balance queued one
 * under another in a narrow strip, with the rest of the screen greyed out
 * behind. His words — he wants the full window, not a cramped close-up.
 *
 * So the pages he WORKS in take the window, and at desktop width the body
 * becomes two columns: what he is editing on the left, the money beside it
 * rather than a screen below it.
 *
 * NOT EVERYTHING. A small confirmation is not improved by being blown up to
 * 27 inches — "offer this booking to a driver" is one question — so this file
 * pins which surfaces take the window AND which must not.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { stripComments: strip } = require('./_source');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const ADMIN = read('westmere-admin.html');

const overlayOf = (id) => {
  const re = new RegExp('<div class="overlay([^"]*)" id="' + id + '"');
  const m = re.exec(ADMIN);
  assert.ok(m, 'there is no overlay called ' + id);
  return m[1];
};

// ── 1. THE WORKING SURFACES TAKE THE WINDOW ───────────────────────────────
console.log('\nThe pages he works in use the whole desk');

test('the driver editor, the journey, the customer and the booking form', () => {
  for (const id of ['modal-add-driver', 'modal-cust-detail', 'modal-book']) {
    assert.ok(/\bov-full\b/.test(overlayOf(id)), id + ' is still a column down the middle');
  }
  /* The journey page is built in JS rather than written in the markup. */
  assert.ok(/m\.className='overlay ov-full'/.test(strip(ADMIN)),
    'the journey page is still an 860px modal');
  assert.ok(!/modal" style="max-width:860px/.test(ADMIN), 'the 860px cap is still on it');
});

test('and none of them keeps a width cap that would undo it', () => {
  for (const id of ['modal-add-driver', 'modal-cust-detail']) {
    /* Bounded by the thing that ends it — the modal's own opening tag — not by
       a count of characters, which would stop covering this the day a longer
       onclick goes on the overlay. */
    const i = ADMIN.indexOf('id="' + id + '"');
    assert.ok(i !== -1, id + ' is gone');
    const k = ADMIN.indexOf('<div class="modal', i);
    const end = ADMIN.indexOf('>', k);
    assert.ok(k !== -1 && end !== -1, id + ' has no modal inside its overlay');
    const tag = ADMIN.slice(k, end + 1);
    assert.ok(!/max-width:\s*\d/.test(tag),
      id + ' is full-screen with a max-width still on its modal — the cap wins: ' + tag);
  }
});

test('a question stays a question', () => {
  /* Blowing a two-line confirmation up to the whole screen makes it harder to
     answer, not easier. These are deliberately left alone. */
  for (const id of ['modal-reassign', 'modal-inbox-compose']) {
    assert.ok(!/\bov-full\b/.test(overlayOf(id)),
      id + ' has been made full-screen — it asks one question');
  }
});

// ── 2. WHAT FULL-WIDTH ACTUALLY DOES ──────────────────────────────────────
console.log('\nWhat the extra width is used for');

test('the full-view rules fill the window rather than just widening the box', () => {
  const css = ADMIN;
  assert.ok(/\.overlay\.ov-full\{padding:0;align-items:stretch\}/.test(css),
    'the overlay still holds the page off the edges');
  assert.ok(/\.overlay\.ov-full \.modal\{max-width:none;width:100%;min-height:100vh/.test(css),
    'the page does not reach the full window');
});

test('at desktop width the body is two columns, and one again below 1080px', () => {
  const css = ADMIN;
  const m = /@media\(min-width:1080px\)\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(m, 'there is no desktop breakpoint for the full-view body');
  assert.ok(/\.mf-cols\{display:grid/.test(m[1]), 'the body is not split into columns');
  assert.ok(/\.mf-side\{position:sticky/.test(m[1]),
    'the money panel scrolls away from the form it belongs beside');
  /* Below the breakpoint there must be no grid at all — the same page in a
     narrower window, not a two-column layout squeezed into one. */
  assert.ok(!/^\.mf-cols\{display:grid/m.test(css),
    'the two-column grid is unconditional — it would crush the form on a laptop');
});

test('the driver editor is actually split, with the money on the side', () => {
  /* Bounded by the markup that ENDS it, not by a character count: the next
     modal's comment. Starting at the overlay's own <div so the tags balance. */
  const i = ADMIN.indexOf('<div class="overlay ov-full" id="modal-add-driver">');
  const j = ADMIN.indexOf('<!-- \u2550\u2550\u2550 MODAL: REASSIGN BOOKING', i);
  assert.ok(i !== -1 && j > i, 'the driver editor could not be bounded');
  const modal = ADMIN.slice(i, j);
  assert.ok(/<div class="mf-cols">/.test(modal), 'the editor body is not split');
  assert.ok(/<div class="mf-main">/.test(modal) && /<div class="mf-side">/.test(modal),
    'the two halves are not marked');
  /* The form on the left; his earnings, his balance and the week's transfer on
     the right, where they can be read while the form is being filled in. */
  const side = modal.slice(modal.indexOf('<div class="mf-side">'));
  for (const id of ['dm-earnings', 'dm-ledger']) {
    assert.ok(side.indexOf('id="' + id + '"') !== -1, id + ' is not in the side column');
  }
  const main = modal.slice(modal.indexOf('<div class="mf-main">'), modal.indexOf('<div class="mf-side">'));
  for (const id of ['dm-fname', 'dm-vehicle', 'dm-commission', 'dm-has-login']) {
    assert.ok(main.indexOf('id="' + id + '"') !== -1, id + ' is not in the form column');
  }
  const opens = (modal.match(/<div\b/g) || []).length;
  const closes = (modal.match(/<\/div>/g) || []).length;
  assert.strictEqual(opens, closes, 'the editor markup does not balance: ' + opens + ' open, ' + closes + ' close');
});

test('every field the save reads is still on the page', () => {
  /* Splitting the body moved markup. A field that fell outside both columns
     would read as empty and SAVE as empty — quietly wiping a driver's licence
     number the first time he edits a phone number. */
  const src = strip(ADMIN);
  const i = src.indexOf('function saveDriver');
  assert.ok(i !== -1, 'saveDriver is gone');
  const fn = src.slice(i, src.indexOf('\n}', src.indexOf('fetch(', i)) + 2);
  const ids = [...fn.matchAll(/getElementById\('(dm-[\w-]+)'\)/g)].map((m) => m[1]);
  assert.ok(ids.length >= 8, 'only ' + ids.length + ' fields read by saveDriver — is it still the saver?');
  for (const id of [...new Set(ids)]) {
    assert.ok(ADMIN.indexOf('id="' + id + '"') !== -1,
      'saveDriver reads #' + id + ', which is not on the page any more');
  }
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/admin-full-view\.test\.js/.test(read('package.json')),
    'a guard nobody runs is a guard that does not exist');
});

(async () => {
  for (const t of queue) {
    try { await t.fn(); console.log('  ✓ ' + t.name); passed++; }
    catch (e) { console.log('  ✗ ' + t.name + '\n      ' + e.message); failed++; }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
