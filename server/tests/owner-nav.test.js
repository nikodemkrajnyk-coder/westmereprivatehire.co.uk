/**
 * THE OWNER APP'S LEFT DRAWER —
 *   node server/tests/owner-nav.test.js   (also gated by `npm test`)
 *
 * The bottom bar had grown to nine tabs across two rows and was eating the
 * screen the owner actually works in. Two tabs stay — Confirmed and Awaiting,
 * the two he lives in — and the rest move to a full-height drawer on the left.
 *
 * What this pins is mostly the part that is easy to get wrong and invisible
 * when it is: a drawer that opens is trivial, a drawer that a keyboard user can
 * get out of is not. aria-expanded must track the REAL state rather than being
 * set once; Escape must close it and put focus back where it came from; the
 * page behind must not scroll under the finger; and choosing a section must
 * dismiss it, or the page just opened is sitting behind a panel.
 *
 * Also pinned: every section still has a way in. Moving nine tabs into a drawer
 * is exactly the change that strands one of them with no control at all.
 *
 * Pure Node. Exit 1 on failure.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const OWNER = read('westmere-owner.html');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
}

/** A function body, brace-matched — never a character count (guard-hygiene). */
function fnBody(name) {
  const i = OWNER.indexOf('function ' + name + '(');
  assert.ok(i !== -1, name + ' is missing');
  let depth = 0;
  for (let k = OWNER.indexOf('{', i); k < OWNER.length; k++) {
    if (OWNER[k] === '{') depth++;
    else if (OWNER[k] === '}' && --depth === 0) return OWNER.slice(i, k + 1);
  }
  throw new Error(name + ' is unterminated');
}

console.log('\nThe bar, and what moved off it');

test('exactly TWO tabs remain on the bottom bar', () => {
  const nav = OWNER.slice(OWNER.indexOf('<div class="bottom-nav"'), OWNER.indexOf('</div><!-- /app -->'));
  const tabs = nav.match(/class="bn[ "]/g) || [];
  assert.strictEqual(tabs.length, 2, 'the bar must carry two tabs, found ' + tabs.length);
  assert.ok(/id="bn-confirmed"/.test(nav), 'Confirmed stays');
  assert.ok(/id="bn-toconfirm"/.test(nav), 'and Awaiting stays');
  const rows = nav.match(/class="bn-row"/g) || [];
  assert.strictEqual(rows.length, 1, 'one row — the second row is what was eating the screen');
});

test('"To Confirm" is now "Awaiting", as the owner asked', () => {
  const nav = OWNER.slice(OWNER.indexOf('<div class="bottom-nav"'), OWNER.indexOf('</div><!-- /app -->'));
  assert.ok(/>Awaiting</.test(nav), 'the tab must read Awaiting');
  assert.ok(!/>To Confirm</.test(nav), 'the old label must be gone from the bar');
});

test('EVERY section still has a way in — nothing was stranded', () => {
  /* The failure mode of moving nine tabs into a drawer is one of them ending up
     with no control at all: the pane exists, nothing opens it. */
  const panes = [...new Set((OWNER.match(/id="pg-([a-z-]+)"/g) || [])
    .map(m => /id="pg-([a-z-]+)"/.exec(m)[1]))];
  assert.ok(panes.length >= 8, 'expected the app to have many panes, found ' + panes.length);
  const dead = ['inbox', 'smart'];   // unreachable before this change, and still are
  for (const id of panes) {
    if (dead.indexOf(id) !== -1) continue;
    const hasTab = OWNER.indexOf('id="bn-' + id + '"') !== -1;
    const hasDrawer = OWNER.indexOf('id="sd-' + id + '"') !== -1;
    assert.ok(hasTab || hasDrawer, 'pg-' + id + ' has no tab and no drawer item — it is unreachable');
  }
});

test('the drawer carries the sections that left the bar, plus Messages', () => {
  for (const id of ['completed', 'calendar', 'customers', 'drivers', 'invoices', 'earnings', 'compose']) {
    assert.ok(OWNER.indexOf('id="sd-' + id + '"') !== -1, 'the drawer is missing ' + id);
  }
  assert.ok(/id="sd-compose"[\s\S]{0,220}Messages/.test(OWNER),
    'the compose section must be labelled Messages in the drawer');
});

console.log('\nGetting out of it again');

test('the hamburger declares what it controls, and its state', () => {
  const btn = /<button class="tb-menu"[\s\S]*?>/.exec(OWNER);
  assert.ok(btn, 'the menu button is missing');
  assert.ok(/aria-controls="side-nav"/.test(btn[0]), 'it must name what it opens');
  assert.ok(/aria-expanded="false"/.test(btn[0]), 'and start collapsed');
  assert.ok(/aria-label="Open menu"/.test(btn[0]), 'and be labelled for a screen reader');
});

test('aria-expanded tracks the REAL state, both ways', () => {
  assert.ok(/setAttribute\('aria-expanded','true'\)/.test(fnBody('openSideMenu')),
    'opening must announce itself');
  assert.ok(/setAttribute\('aria-expanded','false'\)/.test(fnBody('closeSideMenu')),
    'and closing must too — a flag set once is worse than none');
});

test('focus moves into the drawer, and Escape brings it back', () => {
  assert.ok(/\.focus\(/.test(fnBody('openSideMenu')),
    'a keyboard user must land inside the thing that just opened');
  const esc = OWNER.slice(OWNER.indexOf("e.key==='Escape'&&sideMenuOpen()"));
  assert.ok(/closeSideMenu\(\)/.test(esc.slice(0, 200)), 'Escape must close it');
  assert.ok(/getElementById\('tb-menu'\)[\s\S]{0,40}focus\(\)/.test(esc.slice(0, 260)),
    'and focus must return to the button it came from, not to the top of the page');
});

test('the page behind cannot scroll while it is open', () => {
  assert.ok(/body\.style\.overflow='hidden'/.test(fnBody('openSideMenu')), 'locked on open');
  assert.ok(/body\.style\.overflow=''/.test(fnBody('closeSideMenu')), 'and released on close');
});

test('a scrim closes it, and sits under the drawer', () => {
  assert.ok(/id="side-scrim"[^>]*onclick="closeSideMenu\(\)"/.test(OWNER),
    'tapping beside the drawer must close it');
  const scrim = /\.side-scrim\{[^}]*\}/.exec(OWNER);
  const panel = /\.side\{[\s\S]*?\}/.exec(OWNER);
  const z = (r) => parseInt((/z-index:(\d+)/.exec(r) || [])[1], 10);
  assert.ok(z(panel[0]) > z(scrim[0]), 'the drawer must sit above its own scrim');
});

test('choosing a section dismisses the drawer', () => {
  const go = fnBody('goPage');
  assert.ok(/closeSideMenu\(\)/.test(go),
    'otherwise the page just opened is behind a full-height panel');
});

test('the highlight follows the PAGE, not the button that was clicked', () => {
  const go = fnBody('goPage');
  assert.ok(/getElementById\('sd-'\+id\)/.test(go) && /getElementById\('bn-'\+id\)/.test(go),
    'opening a page from a customer card or a deep link must still mark its control');
  assert.ok(/querySelectorAll\('\.side-item'\)[\s\S]{0,80}remove\('on'\)/.test(go),
    'and the previous drawer selection must be cleared');
});

console.log('\nThe look the owner picked');

test('it is the compact variant: full height, narrow, footer pinned', () => {
  const panel = /\.side\{[\s\S]*?\n\}/.exec(OWNER);
  assert.ok(panel, '.side rule is missing');
  assert.ok(/height:100dvh/.test(panel[0]), 'full height — no blank third at the bottom');
  assert.ok(/width:min\(78vw,\s*250px\)/.test(panel[0]), 'narrow, as chosen');
  const foot = /\.side-foot\{[\s\S]*?\}/.exec(OWNER);
  assert.ok(foot && /margin-top:auto/.test(foot[0]), 'Sign Out pinned to the bottom');
  /* The list was three groups spread apart with space-between; the owner asked
     for ONE continuous run instead, because the spreading is what opened the
     blank gaps. So what is pinned now is the absence of grouping, not the
     spreading. */
  const list = /\.side-list\{[^}]*\}/.exec(OWNER);
  assert.ok(list && !/justify-content:space-between/.test(list[0]),
    'the items must sit in one continuous run, not be pushed apart');
  assert.ok(!/class="side-group"/.test(OWNER), 'no groups');
  assert.ok(!/class="side-sep"/.test(OWNER), 'and no dividers between items');
});

test('the crest is gone from the top-left; the wordmark carries it', () => {
  const bar = OWNER.slice(OWNER.indexOf('<div class="topbar">'), OWNER.indexOf('<div class="topbar">') + 900);
  assert.ok(!/class="tb-crest"/.test(bar), 'the crest box must be out of the header');
  assert.ok(/tb-mode-label/.test(bar), 'the Westmere wordmark stays');
});

test('Sign Out asks before it acts', () => {
  const out = fnBody('ownerSignOut');
  assert.ok(/confirm\(/.test(out),
    'this is a drawer he opens all day — a mis-tap must not end his shift');
  assert.ok(/auth\/logout/.test(out), 'and it must actually sign out');
});

test('Completed is labelled Trip History, but its id is untouched', () => {
  /* A label change that renamed the id would have quietly detached the pane
     from goPage, the SSE rebuild and every guard that names it. */
  assert.ok(/id="sd-completed"[\s\S]{0,220}Trip History/.test(OWNER), 'the drawer item must read Trip History');
  assert.ok(/id="pg-completed"/.test(OWNER), 'the pane id must stay `completed`');
  assert.ok(/Trip <em>History<\/em>/.test(OWNER), 'and the heading must read Trip History');
  assert.ok(/goPage\('completed'\)/.test(OWNER), 'the wiring must still use the old id');
});

test('Trip History is grouped by month, newest first, and collapses', () => {
  assert.ok(/WMLifecycle\.groupByMonth\(jobs\)/.test(OWNER), 'grouped by the shared month function');
  assert.ok(/function tripMonthToggle\(key\)/.test(OWNER), 'months must collapse');
  assert.ok(/aria-expanded/.test(OWNER) && /aria-controls="tm-/.test(OWNER),
    'a collapsing section must say whether it is open, and what it controls');
  const build = /function buildCompleted\(\)\{[\s\S]*?\n\}/.exec(OWNER);
  assert.ok(build && /TRIP_MONTHS_OPEN\[g\.key\]===undefined/.test(build[0]),
    'the newest month opens by default');
  assert.ok(/^var TRIP_MONTHS_OPEN=\{\};/m.test(OWNER),
    'the open/closed state must live outside the builder, or an SSE rebuild closes what he just opened');
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/owner-nav\.test\.js/.test(read('package.json')));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
