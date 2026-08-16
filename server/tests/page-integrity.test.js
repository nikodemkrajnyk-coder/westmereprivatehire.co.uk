/**
 * PAGE INTEGRITY — run with:
 *   node server/tests/page-integrity.test.js   (also gated by `npm test`)
 *
 * WHY THIS EXISTS
 *   Four buttons shipped to production with a CSS declaration stranded in
 *   front of the tag — "…#102a43)<button …" — which renders as a line of
 *   visible garbage next to the control. They sat there for days: Connect
 *   Calendar and Pay Out to Bank in the owner app, Create Invoice and Send
 *   Estimate in admin.
 *
 *   The honest root cause is not that a guard was too narrow. It is that NO
 *   guard checked markup INTEGRITY at all. The suite had guards for what the
 *   markup should SAY (tokens, fills, typography, lifecycle) and one that the
 *   inline scripts still PARSE — but a leaked declaration is valid HTML and
 *   valid JavaScript. It broke nothing a parser would notice; it just looked
 *   broken to a human.
 *
 *   So this guard asks a different question of EVERY page, not of the file
 *   somebody happened to be editing: does anything here render as debris?
 *
 * WHAT IT PINS, across every .html at the repo root
 *   (a) no CSS declaration or attribute fragment sits in TEXT position, in the
 *       served markup or in the JS strings the apps build their markup from;
 *   (b) no id is used twice on a page — getElementById returns the first, so a
 *       duplicate silently wires half a feature to the wrong element (this is
 *       exactly how the owner's Name Board came to open blank);
 *   (c) every inline <script> still parses, on every page rather than on a
 *       remembered list of "the pages that were edited";
 *   (d) tags that must balance, balance.
 *
 * Pure static analysis of the shipped files. Exit 1 on failure.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const PAGES = fs.readdirSync(ROOT).filter(f => f.endsWith('.html')).sort();

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
}
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const lineOf = (src, i) => src.slice(0, i).split('\n').length;

// Blank a block but KEEP its newlines. Replacing them with spaces shifts every
// line number after the first <style>, which once reported a real leak 610
// lines from where it actually was.
const blank = (m) => m.replace(/[^\n]/g, ' ');

const CSS_PROP = '(?:padding|margin|border|border-radius|background|background-color|color|font-family|font-size|font-weight|line-height|letter-spacing|text-transform|text-align|display|flex|align-items|justify-content|gap|width|height|max-width|min-height|position|inset|z-index|overflow|opacity|transition|transform|cursor|white-space|box-sizing|box-shadow|backdrop-filter|resize|word-break)';

console.log('\nPage integrity — every page, not the one being edited');

// ── (a) NOTHING RENDERS AS DEBRIS ────────────────────────────────────────
test('no CSS declaration is stranded in text position on any page', () => {
  const offenders = [];
  for (const f of PAGES) {
    const src = read(f);
    const masked = src
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, blank)
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, blank);
    // Text between tags that carries a real property name and a separator.
    for (const m of masked.matchAll(/>([^<>]{6,600})</g)) {
      const t = m[1];
      if (!t.trim()) continue;
      if (!new RegExp('(?:^|[;{]\\s*|\\s)' + CSS_PROP + '\\s*:').test(t)) continue;
      if (!/[;:]/.test(t)) continue;
      offenders.push(f + ':' + lineOf(masked, m.index + 1) + '  ' + t.replace(/\s+/g, ' ').trim().slice(0, 80));
    }
  }
  assert.deepStrictEqual(offenders, [],
    'CSS is rendering as visible text:\n      ' + offenders.join('\n      '));
});

test('no declaration abuts an opening tag, in markup or in a JS string', () => {
  // The exact shape of the four that shipped: "…solid var(--westmere-navy,
  // #102a43)<button". Quote-agnostic on purpose — pairing '…' literals drifts
  // the moment an apostrophe appears in a comment, and that is how the first
  // version of this check missed one of the five.
  const RE = new RegExp(CSS_PROP + '\\s*:\\s*[^<>{}]{0,140}?<(?:button|div|span|a|input|select|p|table|td|tr|label)\\b', 'gi');
  const offenders = [];
  for (const f of PAGES) {
    const src = read(f);
    for (const m of src.matchAll(RE)) {
      const seg = m[0];
      // Legitimate when the declaration lives inside a style="…" attribute:
      // there is always a quote between it and the next tag.
      const tail = seg.slice(seg.indexOf(':'));
      if (/["']/.test(tail.slice(0, tail.lastIndexOf('<')))) continue;
      offenders.push(f + ':' + lineOf(src, m.index) + '  …' + seg.replace(/\s+/g, ' ').slice(-70));
    }
  }
  assert.deepStrictEqual(offenders, [],
    'a style fragment is stranded in front of a tag — it prints as text:\n      ' + offenders.join('\n      '));
});

test('no attribute fragment is rendering as copy', () => {
  const offenders = [];
  for (const f of PAGES) {
    const src = read(f);
    const masked = src
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, blank)
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, blank);
    for (const m of masked.matchAll(/>([^<>]{6,400})</g)) {
      if (!/\b(?:onclick|style|class|href|placeholder)\s*=\s*["']/.test(m[1])) continue;
      offenders.push(f + ':' + lineOf(masked, m.index + 1) + '  ' + m[1].replace(/\s+/g, ' ').trim().slice(0, 80));
    }
  }
  assert.deepStrictEqual(offenders, [], 'an attribute is rendering as text:\n      ' + offenders.join('\n      '));
});

// ── (b) IDS ARE UNIQUE ───────────────────────────────────────────────────
/* KNOWN PENDING — Name Board fix held at owner's request; remove this
   exception when the nb-name→nb-board-name fix is deployed.

   westmere-owner.html carries `id="nb-name"` twice: the New Booking form's
   passenger <input> and the Name Board's display <div>. getElementById returns
   the first, so showNB() sets textContent on an <input> and the Name Board
   opens BLANK — the owner holds up an empty screen at arrivals. The fix is
   written and verified but deliberately NOT deployed, on the owner's explicit
   instruction, so the duplicate is still in the shipped page.

   This is a named exception for ONE id on ONE page, not a softening of the
   rule: every other duplicate on every page still fails, and the moment the
   held fix ships this entry stops matching and must be deleted. */
const KNOWN_DUPLICATE_IDS = [
  { file: 'westmere-owner.html', id: 'nb-name' }
];

test('no id is used twice on a page', () => {
  // getElementById returns the FIRST match, so a duplicate does not error — it
  // quietly points half a feature at the wrong element.
  const offenders = [];
  for (const f of PAGES) {
    const src = read(f);
    const seen = {};
    for (const m of src.matchAll(/\sid="([^"]+)"/g)) {
      (seen[m[1]] = seen[m[1]] || []).push(lineOf(src, m.index));
    }
    for (const id of Object.keys(seen)) {
      if (seen[id].length < 2) continue;
      if (KNOWN_DUPLICATE_IDS.some(k => k.file === f && k.id === id)) continue;
      offenders.push(f + '  id="' + id + '" on lines ' + seen[id].join(', '));
    }
  }
  assert.deepStrictEqual(offenders, [],
    'a duplicate id will silently wire a feature to the wrong element:\n      ' + offenders.join('\n      '));
});

test('the allow-list is still needed, and still only covers what it claims', () => {
  // An exception that outlives its cause is how a suite quietly stops
  // guarding. If the held fix has shipped, this fails and tells you to delete
  // the entry rather than leaving a permanent hole in the rule.
  for (const k of KNOWN_DUPLICATE_IDS) {
    const src = read(k.file);
    const count = (src.match(new RegExp('\\sid="' + k.id + '"', 'g')) || []).length;
    assert.ok(count > 1,
      k.file + ' no longer duplicates id="' + k.id + '" — the held fix has shipped, so delete this ' +
      'entry from KNOWN_DUPLICATE_IDS in page-integrity.test.js');
  }
  assert.strictEqual(KNOWN_DUPLICATE_IDS.length, 1,
    'the duplicate-id allow-list has grown; it exists for ONE held fix, not as a place to park defects');
});

// ── (c) THE SCRIPTS STILL PARSE — ON EVERY PAGE ──────────────────────────
test('every inline script on every page still parses', () => {
  const offenders = [];
  for (const f of PAGES) {
    const src = read(f);
    let i = 0;
    for (const m of src.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)) {
      i++;
      const type = (m[1].match(/type="([^"]+)"/) || [])[1] || '';
      const body = m[2];
      if (body.trim().length < 40) continue;
      if (/json/i.test(type)) {
        // JSON-LD is data, not code — check it as JSON or the check is a lie.
        try { JSON.parse(body); } catch (e) { offenders.push(f + ' block ' + i + ' (' + type + '): ' + e.message.slice(0, 60)); }
      } else {
        try { new Function(body); } catch (e) { offenders.push(f + ' block ' + i + ': ' + e.message.slice(0, 60)); }
      }
    }
  }
  assert.deepStrictEqual(offenders, [], 'a script no longer parses:\n      ' + offenders.join('\n      '));
});

// ── (d) TAGS BALANCE ─────────────────────────────────────────────────────
test('the containers that must balance, balance', () => {
  const offenders = [];
  for (const f of PAGES) {
    // Only the SERVED markup: the JS strings deliberately build half-tags.
    const src = read(f).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, blank);
    for (const tag of ['button', 'table', 'form', 'select', 'textarea']) {
      const open = (src.match(new RegExp('<' + tag + '\\b', 'gi')) || []).length;
      const close = (src.match(new RegExp('</' + tag + '\\s*>', 'gi')) || []).length;
      if (open !== close) offenders.push(f + '  <' + tag + '> ' + open + ' open vs ' + close + ' close');
    }
  }
  assert.deepStrictEqual(offenders, [], 'unbalanced tags in the served markup:\n      ' + offenders.join('\n      '));
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/page-integrity\.test\.js/.test(read('package.json')),
    'page-integrity.test.js must run in npm test, or it guards nothing');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
console.log('  pages scanned: ' + PAGES.length);
process.exit(failed ? 1 : 0);
