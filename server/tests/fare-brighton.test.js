/**
 * Brighton flat-fare guardrail — run with:  node server/tests/fare-brighton.test.js
 *
 * The owner set FLAT ALL-IN fares (Aug 2026) to beat the local market:
 *   • Brighton/Hove → Gatwick  = £70 exactly
 *   • Brighton/Hove → Heathrow = £125 exactly
 *
 * These are marked all-in (FARE_CF_ALLIN), so the engine must NOT add the airport
 * drop-off / pick-up fee or any toll on top — the customer quote is exactly the
 * headline figure. Without this guard the fare could silently drift back to the
 * old base+fee figure (Brighton→Gatwick used to quote ~£99 = £89 base + £10 fee).
 *
 * Pure Node, no network (fixed CF routes resolve without geocoding). Exit 1 on
 * any failure so it gates a deploy.
 */
const assert = require('assert');
const { calculateFare } = require('../fare-engine');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

// Every Brighton/Hove spelling + BN postcode must resolve to the flat fare.
const BRIGHTON_INPUTS = ['Brighton', 'Hove', 'Brighton, BN1 1AA', 'Hove, BN3 2AA'];

for (const town of BRIGHTON_INPUTS) {
  test(`${town} → Gatwick is exactly £70 (all-in, no fee on top)`, async () => {
    const r = await calculateFare(town, 'Gatwick Airport', '10:00');
    assert.strictEqual(r.rate_type, 'fixed', 'expected a fixed fare, got: ' + r.rate_type);
    assert.strictEqual(r.fare, 70, `${town}→Gatwick expected £70, got £${r.fare}`);
    assert.strictEqual(r.airport_fee, 0, 'airport fee must NOT be added to the all-in fare');
    assert.strictEqual(r.toll_fee || 0, 0, 'toll must NOT be added to the all-in fare');
  });
  test(`${town} → Heathrow is exactly £125 (all-in, no fee on top)`, async () => {
    const r = await calculateFare(town, 'Heathrow Airport', '10:00');
    assert.strictEqual(r.rate_type, 'fixed', 'expected a fixed fare, got: ' + r.rate_type);
    assert.strictEqual(r.fare, 125, `${town}→Heathrow expected £125, got £${r.fare}`);
    assert.strictEqual(r.airport_fee, 0, 'airport fee must NOT be added to the all-in fare');
    assert.strictEqual(r.toll_fee || 0, 0, 'toll must NOT be added to the all-in fare');
  });
}

// Symmetric: the return leg (airport → Brighton pickup) is the same flat fare.
test('Gatwick → Brighton (pickup) is exactly £70', async () => {
  const r = await calculateFare('Gatwick Airport', 'Brighton', '10:00');
  assert.strictEqual(r.fare, 70, `Gatwick→Brighton expected £70, got £${r.fare}`);
  assert.strictEqual(r.airport_fee, 0);
});
test('Heathrow → Brighton (pickup) is exactly £125', async () => {
  const r = await calculateFare('Heathrow Airport', 'Brighton', '10:00');
  assert.strictEqual(r.fare, 125, `Heathrow→Brighton expected £125, got £${r.fare}`);
  assert.strictEqual(r.airport_fee, 0);
});

// Scope guard: OTHER chart towns still add the airport fee on top (unchanged).
// Horsham→Gatwick = £54 base + £10 Gatwick drop-off fee = £64.
test('Horsham → Gatwick still adds the drop-off fee (£54 + £10 = £64)', async () => {
  const r = await calculateFare('Horsham', 'Gatwick Airport', '10:00');
  assert.strictEqual(r.rate_type, 'fixed');
  assert.strictEqual(r.airport_fee, 10, 'other towns must still carry the airport fee');
  assert.strictEqual(r.fare, 64, `Horsham→Gatwick expected £64, got £${r.fare}`);
});
// Brighton → other airports are NOT all-in — Stansted still adds its short-stay fee.
test('Brighton → Stansted is unaffected (still base + fee)', async () => {
  const r = await calculateFare('Brighton', 'Stansted Airport', '10:00');
  assert.strictEqual(r.airport_fee, 10, 'Brighton→Stansted must still add the drop-off fee');
  assert.strictEqual(r.fare, 198, `Brighton→Stansted expected £198 (188+10), got £${r.fare}`);
});

(async () => {
  console.log('\nBrighton flat-fare guardrail');
  for (const { name, fn } of queue) {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
