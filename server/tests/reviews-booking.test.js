/**
 * Reviews-on-booking-page guardrail — run with:  node server/tests/reviews-booking.test.js
 *
 * Task B (funnel review): the booking page had no social proof. This locks in:
 *   1) the reviews widget lives in a shared, self-booting reviews.js (real
 *      Google reviews via /api/public/reviews — never invented testimonials);
 *   2) book.html shows a [data-reviews] mount AND loads reviews.js, so a
 *      first-timer sees trust signals right by the form;
 *   3) book.html does NOT load frontend.js (whose initForms would double-bind
 *      the submit handler and double-post the booking);
 *   4) the widget is not duplicated — frontend.js no longer defines/calls it;
 *   5) the existing marketing pages still load reviews.js (reviews didn't break).
 *
 * Pure static checks over the source files. Exit 1 on any failure.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

// ── 1. Shared, self-booting reviews.js ─────────────────────────────────────
test('reviews.js exists, self-boots, and uses the real reviews API', () => {
  const src = read('reviews.js');
  assert.ok(/function initReviews\(\)/.test(src), 'reviews.js must define initReviews');
  assert.ok(/\/api\/public\/reviews/.test(src), 'reviews.js must fetch the real Google reviews proxy');
  assert.ok(/data-reviews/.test(src), 'reviews.js must hydrate [data-reviews] mounts');
  assert.ok(/DOMContentLoaded|readyState/.test(src), 'reviews.js must boot itself');
  assert.ok(/__wmReviewsBooted/.test(src), 'reviews.js must guard against double-init');
});

// ── 2. book.html shows reviews near the form ───────────────────────────────
test('book.html has a reviews mount and loads reviews.js', () => {
  const src = read('book.html');
  assert.ok(/data-reviews=/.test(src), 'book.html missing a [data-reviews] mount');
  assert.ok(/<script src="reviews\.js"><\/script>/.test(src), 'book.html must load reviews.js');
});

// ── 3. No double-submit: book.html must not pull in frontend.js ─────────────
test('book.html does NOT load frontend.js (avoids double booking submit)', () => {
  const src = read('book.html');
  assert.ok(!/src="frontend\.js"/.test(src), 'book.html must not load frontend.js');
  assert.ok(/src="booking-app\.js"/.test(src), 'book.html should still use booking-app.js for the form');
});

// ── 4. No duplication: frontend.js no longer owns the reviews widget ────────
test('frontend.js no longer defines or calls initReviews (single source)', () => {
  const src = read('frontend.js');
  assert.ok(!/function initReviews/.test(src), 'reviews widget must live only in reviews.js');
  assert.ok(!/initReviews\(\)/.test(src), 'frontend.js must not call initReviews (moved to reviews.js)');
});

// ── 5. Existing marketing pages still get reviews (via reviews.js) ─────────
for (const page of ['index.html', 'about.html', 'airport-transfers.html', 'contact.html', 'services.html']) {
  test(page + ' still loads reviews.js and keeps its reviews mount', () => {
    const src = read(page);
    assert.ok(/data-reviews=/.test(src), page + ' lost its [data-reviews] mount');
    assert.ok(/<script src="reviews\.js"><\/script>/.test(src), page + ' must load reviews.js');
  });
}

(async () => {
  console.log('\nReviews on the booking page');
  for (const { name, fn } of queue) {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
