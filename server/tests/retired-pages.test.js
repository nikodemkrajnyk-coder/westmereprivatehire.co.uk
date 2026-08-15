/**
 * A retired page stays retired — run with:
 *   node server/tests/retired-pages.test.js   (also gated by `npm test`)
 *
 * The Premium Fleet spec sheet was deleted: the last page still wearing the
 * pre-redesign dark navy, and Google had indexed it well enough to show it as a
 * SITELINK — so it was being offered to people searching for the business.
 *
 * Deleting a file is the easy half. The half that rots is everything else:
 *   · a link left behind in one page's burger menu, which nobody opens on
 *     desktop and so nobody notices is broken;
 *   · the 301, without which every stale link in the search index, in a
 *     bookmark, or in a message sent months ago becomes a 404.
 *
 * So this pins all of it, and is written generally enough that the next page
 * to be retired can be added to RETIRED in one line.
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

// file → where its old URL should send people.
const RETIRED = { 'westmere-fleet.html': '/' };

const HTML = fs.readdirSync(ROOT).filter(f => f.endsWith('.html'));
const SERVER = read('server/index.js');

console.log('\nRetired pages stay retired');

test('the retired file is actually gone', () => {
  for (const f of Object.keys(RETIRED)) {
    assert.ok(!exists(f), f + ' is still in the repo — it would still be served');
  }
});

test('no page links to it — desktop nav, burger menu or footer', () => {
  const offenders = [];
  for (const f of HTML) {
    const src = read(f);
    for (const gone of Object.keys(RETIRED)) {
      for (const m of src.matchAll(new RegExp('<a[^>]*href="[^"]*' + gone.replace('.', '\\.') + '"[^>]*>([^<]*)</a>', 'g'))) {
        offenders.push(f + '  →  ' + m[1].trim());
      }
    }
  }
  assert.deepStrictEqual(offenders, [],
    'these still link to a page that no longer exists:\n      ' + offenders.join('\n      '));
});

test('nothing else references it either — scripts, styles, data', () => {
  const offenders = [];
  const files = HTML.concat(
    fs.readdirSync(ROOT).filter(f => /\.(js|css|xml|txt|json)$/.test(f)),
    fs.readdirSync(path.join(ROOT, 'server')).filter(f => f.endsWith('.js')).map(f => 'server/' + f)
  );
  for (const f of files) {
    let src; try { src = read(f); } catch (e) { continue; }
    for (const gone of Object.keys(RETIRED)) {
      if (!src.includes(gone)) continue;
      // The redirect route and its comment are the ONE place the name survives.
      if (f === 'server/index.js') continue;
      offenders.push(f);
    }
  }
  assert.deepStrictEqual([...new Set(offenders)], [],
    'these still mention the retired page:\n      ' + [...new Set(offenders)].join('\n      '));
});

test('the old URL 301s, and to somewhere that exists', () => {
  for (const [gone, target] of Object.entries(RETIRED)) {
    const re = new RegExp("app\\.get\\('/" + gone.replace('.', '\\.') + "'[\\s\\S]{0,200}?redirect\\(301,\\s*'([^']+)'");
    const m = re.exec(SERVER);
    assert.ok(m, 'there is no 301 for /' + gone + ' — every indexed link to it would 404');
    assert.strictEqual(m[1], target, '/' + gone + ' redirects to ' + m[1] + ', expected ' + target);
    // 301, not 302: a temporary redirect leaves the dead page in the index.
    assert.ok(!/redirect\(302/.test(m[0]), 'the redirect must be permanent, or Google keeps the old URL');
    const dest = m[1] === '/' ? 'index.html' : m[1].replace(/^\//, '');
    assert.ok(exists(dest), 'the redirect points at ' + m[1] + ', which does not exist');
  }
});

test('it is not in the sitemap, and robots does not name it', () => {
  for (const gone of Object.keys(RETIRED)) {
    assert.ok(!read('sitemap.xml').includes(gone), 'sitemap.xml still offers ' + gone + ' to crawlers');
    assert.ok(!read('robots.txt').includes(gone),
      'robots.txt names ' + gone + ' — a Disallow would BLOCK the crawl that has to see the 301');
  }
});

test('every sitemap URL still resolves to a real page', () => {
  // The retired page was never in the sitemap, but removing pages is exactly
  // when a sitemap goes stale, so check the whole thing while we are here.
  const missing = [];
  for (const m of read('sitemap.xml').matchAll(/<loc>https:\/\/westmereprivatehire\.co\.uk\/([^<]*)<\/loc>/g)) {
    const f = m[1] === '' ? 'index.html' : m[1];
    if (!exists(f)) missing.push(m[1] || '/');
  }
  assert.deepStrictEqual(missing, [], 'the sitemap lists pages that do not exist: ' + missing.join(', '));
});

test('no page links to any other missing local page', () => {
  // A page deletion is the moment neighbouring links break. Check them all.
  //
  // A link is fine if the FILE exists OR the server redirects that path —
  // westmere-account.html has no file and never will, because it 301s to the
  // rider app. Treating a redirect as a broken link would have made this test
  // fail on a page that works perfectly.
  const redirected = new Set(
    [...SERVER.matchAll(/app\.get\('\/([^']+\.html)'/g)].map(m => m[1])
  );
  const broken = [];
  for (const f of HTML) {
    const src = read(f);
    for (const m of src.matchAll(/href="(?!https?:|mailto:|tel:|#|\/api\/)([^"#?]+\.html)[^"]*"/g)) {
      const target = m[1].replace(/^\//, '');
      if (!exists(target) && !redirected.has(target)) broken.push(f + '  →  ' + m[1]);
    }
  }
  assert.deepStrictEqual([...new Set(broken)], [],
    'broken internal links:\n      ' + [...new Set(broken)].join('\n      '));
});

test('this guardrail is wired into npm test', () => {
  assert.ok(/retired-pages\.test\.js/.test(read('package.json')), 'retired-pages.test.js is not in the npm test chain');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
