/**
 * On-page SEO guardrail — run with:  node server/tests/seo.test.js
 *
 * Locks in the search-visibility basics so they can't silently regress:
 *   • every public page has a UNIQUE, non-generic <title> + meta description;
 *   • canonical + viewport present, and NO stray noindex;
 *   • the LocalBusiness/TaxiService JSON-LD on the homepage & contact page is
 *     VALID JSON with the right name + phone (hand-authored → parse-checked);
 *   • sitemap.xml lists every public page and robots.txt points to it + allows /.
 *
 * Pure Node, no network. Exit 1 on any failure.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const PAGES = ['index.html', 'airport-transfers.html', 'book.html', 'about.html', 'contact.html', 'services.html'];
const grab = (html, re) => { const m = html.match(re); return m ? m[1] : null; };

// ── Unique titles + descriptions, canonical/viewport, no noindex ────────────
const titles = {}, descs = {};
for (const p of PAGES) {
  test(`${p}: unique keyword-rich title + description, canonical, viewport, indexable`, () => {
    const html = read(p);
    const title = grab(html, /<title>([^<]*)<\/title>/);
    const desc  = grab(html, /<meta name="description" content="([^"]*)"/);
    assert.ok(title && title.length > 15, `${p} has no real <title>`);
    assert.ok(desc && desc.length > 40, `${p} description too short/missing`);
    // Old placeholder copy must be gone.
    assert.notStrictEqual(desc, 'Premium private hire across Sussex.', `${p} still uses the generic description`);
    // Uniqueness across the site.
    assert.ok(!titles[title], `${p} duplicate <title>: "${title}"`);
    assert.ok(!descs[desc], `${p} duplicate meta description`);
    titles[title] = p; descs[desc] = p;
    // Canonical + viewport present; no stray noindex.
    assert.ok(/<link rel="canonical" href="https:\/\/westmereprivatehire\.co\.uk\//.test(html), `${p} missing canonical`);
    assert.ok(/<meta name="viewport"/.test(html), `${p} missing viewport (mobile)`);
    assert.ok(!/noindex/i.test(html), `${p} contains a noindex directive`);
    // Open Graph basics for shareability.
    assert.ok(/property="og:title"/.test(html) && /property="og:description"/.test(html), `${p} missing Open Graph tags`);
  });
}

// ── Google Search Console verification meta (domain ownership) ──────────────
test('every public page carries the Google Search Console verification tag', () => {
  const TOKEN = '2lhUFnx99GtVU9ZpfAOBa3AyQltn3JsWkiraLlaDhXs';
  for (const p of PAGES) {
    const html = read(p);
    const content = grab(html, /<meta name="google-site-verification" content="([^"]*)"/);
    assert.strictEqual(content, TOKEN, `${p} missing/incorrect google-site-verification tag`);
  }
});

// ── Titles/descriptions should carry local keywords (towns + airports) ──────
test('key pages mention core towns + airports in title or description', () => {
  for (const p of ['index.html', 'airport-transfers.html']) {
    const html = read(p).toLowerCase();
    for (const kw of ['gatwick', 'heathrow', 'sussex']) {
      assert.ok(html.includes(kw), `${p} head should mention "${kw}"`);
    }
  }
});

// ── JSON-LD is valid + describes the business ───────────────────────────────
function ldBlocks(html) {
  const out = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m; while ((m = re.exec(html))) out.push(m[1]);
  return out;
}
for (const p of ['index.html', 'contact.html']) {
  test(`${p}: LocalBusiness JSON-LD is valid and correct`, () => {
    const blocks = ldBlocks(read(p));
    assert.ok(blocks.length >= 1, `${p} has no JSON-LD`);
    const data = JSON.parse(blocks[0]); // throws on malformed JSON
    const types = [].concat(data['@type']);
    assert.ok(types.includes('LocalBusiness'), `${p} JSON-LD is not a LocalBusiness`);
    assert.strictEqual(data.name, 'Westmere Private Hire');
    assert.strictEqual(data.telephone, '+447930342593');
    assert.ok(data.address && data.address.postalCode === 'BN7 1XG', `${p} JSON-LD missing correct address`);
    assert.ok(Array.isArray(data.areaServed) && data.areaServed.length >= 5, `${p} JSON-LD areaServed too small`);
    assert.ok(Array.isArray(data.openingHoursSpecification), `${p} JSON-LD missing opening hours`);
    // Real aggregateRating from the 5 genuine 5-star Google reviews shown on-site.
    const ar = data.aggregateRating;
    assert.ok(ar && ar['@type'] === 'AggregateRating', `${p} JSON-LD missing AggregateRating`);
    assert.strictEqual(String(ar.ratingValue), '5.0', `${p} ratingValue must be the real 5.0`);
    assert.strictEqual(Number(ar.reviewCount), 5, `${p} reviewCount must match the real 5 reviews`);
    assert.strictEqual(Number(ar.bestRating), 5, `${p} bestRating must be 5`);
    assert.ok(Number(ar.ratingValue) <= Number(ar.bestRating), `${p} ratingValue cannot exceed bestRating`);
  });
}
test('airport-transfers.html JSON-LD is valid', () => {
  const blocks = ldBlocks(read('airport-transfers.html'));
  assert.ok(blocks.length >= 1, 'airport-transfers.html has no JSON-LD');
  const data = JSON.parse(blocks[0]);
  assert.ok(data['@type'] === 'Service' || [].concat(data['@type']).includes('Service'), 'expected a Service schema');
});

// ── sitemap.xml + robots.txt ────────────────────────────────────────────────
test('sitemap.xml exists and lists every public page', () => {
  const xml = read('sitemap.xml');
  assert.ok(/<urlset/.test(xml), 'sitemap.xml is not a urlset');
  assert.ok(/<loc>https:\/\/westmereprivatehire\.co\.uk\/<\/loc>/.test(xml), 'sitemap missing the homepage');
  for (const p of PAGES.filter(x => x !== 'index.html')) {
    assert.ok(xml.includes(`https://westmereprivatehire.co.uk/${p}`), `sitemap missing ${p}`);
  }
});
test('robots.txt allows crawling and points to the sitemap', () => {
  const txt = read('robots.txt');
  assert.ok(/Sitemap:\s*https:\/\/westmereprivatehire\.co\.uk\/sitemap\.xml/.test(txt), 'robots.txt missing Sitemap line');
  assert.ok(/Allow:\s*\//.test(txt), 'robots.txt must allow /');
  assert.ok(!/Disallow:\s*\/\s*$/m.test(txt), 'robots.txt must not blanket-disallow the site');
});

(async () => {
  console.log('\nOn-page SEO guardrail');
  for (const { name, fn } of queue) {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
