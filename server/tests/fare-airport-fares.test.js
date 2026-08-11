/**
 * Airport fixed-fare guardrail — run with:  node server/tests/fare-airport-fares.test.js
 *
 * Owner-set fares (Aug 2026), method = top NORMAL private-hire competitor price
 * (excluding chauffeur/limo/executive) minus £5.
 *
 * ALL-IN towns — the airport drop-off/pick-up fee AND any toll are already baked
 * into the fare (marked in FARE_CF_ALLIN), so the engine must NOT add them again.
 * Applies both directions (drop-off + pickup):
 *   • Brighton/Hove   → Gatwick £65,  Heathrow £125
 *   • Burgess Hill    → Gatwick £56,  Heathrow £126
 *   • Haywards Heath  → Gatwick £60,  Heathrow £126
 *   • Lewes           → Gatwick £80,  Heathrow £150
 *
 * Horsham → Gatwick is ALSO all-in (£45 flat). Horsham → Heathrow is the one
 * remaining normal chart fare: base £94 + the airport fee ON TOP (£101).
 *
 * Crawley and every other town/airport are unchanged (still base + fee on top).
 *
 * Pure Node, no network (fixed CF routes resolve without geocoding). Exit 1 on
 * any failure so it gates a deploy.
 */
const assert = require('assert');
const { calculateFare } = require('../fare-engine');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

// ── All-in towns: exact fare, fee + toll both suppressed, both directions ──
const ALLIN = [
  { town: 'Brighton',       inputs: ['Brighton', 'Hove', 'Brighton, BN1 1AA', 'Hove, BN3 2AA'], ga: 65, he: 125 },
  { town: 'Burgess Hill',   inputs: ['Burgess Hill', 'Burgess Hill, RH15 8AA'],                  ga: 56, he: 126 },
  { town: 'Haywards Heath', inputs: ['Haywards Heath', 'Haywards Heath, RH16 1AA', 'RH17 5AA'],  ga: 60, he: 126 },
  { town: 'Lewes',          inputs: ['Lewes', 'Lewes, BN7 1AA'],                                 ga: 80, he: 150 },
];

for (const t of ALLIN) {
  for (const inp of t.inputs) {
    test(`${inp} → Gatwick = £${t.ga} all-in (no fee/toll on top)`, async () => {
      const r = await calculateFare(inp, 'Gatwick Airport', '10:00');
      assert.strictEqual(r.rate_type, 'fixed', 'expected a fixed fare, got: ' + r.rate_type);
      assert.strictEqual(r.fare, t.ga, `${inp}→Gatwick expected £${t.ga}, got £${r.fare}`);
      assert.strictEqual(r.airport_fee, 0, 'airport fee must be suppressed (all-in)');
      assert.strictEqual(r.toll_fee || 0, 0, 'toll must be suppressed (all-in)');
    });
    test(`${inp} → Heathrow = £${t.he} all-in (no fee/toll on top)`, async () => {
      const r = await calculateFare(inp, 'Heathrow Airport', '10:00');
      assert.strictEqual(r.rate_type, 'fixed');
      assert.strictEqual(r.fare, t.he, `${inp}→Heathrow expected £${t.he}, got £${r.fare}`);
      assert.strictEqual(r.airport_fee, 0, 'airport fee must be suppressed (all-in)');
      assert.strictEqual(r.toll_fee || 0, 0, 'toll must be suppressed (all-in)');
    });
  }
  // Return leg (airport → town pickup) is the same flat fare.
  test(`Gatwick → ${t.town} (pickup) = £${t.ga}`, async () => {
    const r = await calculateFare('Gatwick Airport', t.town, '10:00');
    assert.strictEqual(r.fare, t.ga, `Gatwick→${t.town} expected £${t.ga}, got £${r.fare}`);
    assert.strictEqual(r.airport_fee, 0);
  });
  test(`Heathrow → ${t.town} (pickup) = £${t.he}`, async () => {
    const r = await calculateFare('Heathrow Airport', t.town, '10:00');
    assert.strictEqual(r.fare, t.he, `Heathrow→${t.town} expected £${t.he}, got £${r.fare}`);
    assert.strictEqual(r.airport_fee, 0);
  });
}

// ── Horsham → Gatwick: now FLAT ALL-IN £45 (fee + toll suppressed), both ways ──
test('Horsham → Gatwick = £45 all-in (no fee/toll on top)', async () => {
  const r = await calculateFare('Horsham', 'Gatwick Airport', '10:00');
  assert.strictEqual(r.rate_type, 'fixed');
  assert.strictEqual(r.fare, 45, `Horsham→Gatwick expected £45, got £${r.fare}`);
  assert.strictEqual(r.airport_fee, 0, 'Horsham→Gatwick fee must be suppressed (all-in)');
  assert.strictEqual(r.toll_fee || 0, 0, 'Horsham→Gatwick toll must be suppressed (all-in)');
});
test('RH12 (Horsham) → Gatwick resolves and is £45 all-in', async () => {
  const r = await calculateFare('Horsham, RH12 1AA', 'Gatwick Airport', '10:00');
  assert.strictEqual(r.fare, 45, `RH12→Gatwick expected £45, got £${r.fare}`);
  assert.strictEqual(r.airport_fee, 0);
});
test('Gatwick → Horsham (pickup) = £45 all-in', async () => {
  const r = await calculateFare('Gatwick Airport', 'Horsham', '10:00');
  assert.strictEqual(r.fare, 45, `Gatwick→Horsham expected £45, got £${r.fare}`);
  assert.strictEqual(r.airport_fee, 0);
});
// Horsham → Heathrow must be UNCHANGED: base £94 + £7 Heathrow fee = £101.
test('Horsham → Heathrow unchanged = £94 base + £7 fee = £101', async () => {
  const r = await calculateFare('Horsham', 'Heathrow Airport', '10:00');
  assert.strictEqual(r.base_fare, 94, `Horsham→Heathrow base expected £94, got £${r.base_fare}`);
  assert.strictEqual(r.airport_fee, 7);
  assert.strictEqual(r.fare, 101, `Horsham→Heathrow expected £101, got £${r.fare}`);
});

// ── Scope guards: unchanged towns/airports still add the fee on top ──
test('Crawley → Gatwick UNCHANGED = £45 base + £10 fee = £55', async () => {
  const r = await calculateFare('Crawley', 'Gatwick Airport', '10:00');
  assert.strictEqual(r.base_fare, 45);
  assert.strictEqual(r.airport_fee, 10, 'Crawley must be untouched (fee on top)');
  assert.strictEqual(r.fare, 55, `Crawley→Gatwick expected £55, got £${r.fare}`);
});
test('Crawley → Heathrow UNCHANGED = £82 base + £7 fee = £89', async () => {
  const r = await calculateFare('Crawley', 'Heathrow Airport', '10:00');
  assert.strictEqual(r.fare, 89, `Crawley→Heathrow expected £89, got £${r.fare}`);
  assert.strictEqual(r.airport_fee, 7);
});
test('Worthing → Gatwick UNCHANGED = £85 base + £10 fee = £95', async () => {
  const r = await calculateFare('Worthing', 'Gatwick Airport', '10:00');
  assert.strictEqual(r.airport_fee, 10);
  assert.strictEqual(r.fare, 95, `Worthing→Gatwick expected £95, got £${r.fare}`);
});
// All-in flag is scoped to Gatwick/Heathrow only — Lewes → Stansted still adds fee.
test('Lewes → Stansted unaffected = £193 base + £10 fee = £203', async () => {
  const r = await calculateFare('Lewes', 'Stansted Airport', '10:00');
  assert.strictEqual(r.airport_fee, 10, 'Lewes→Stansted must still add the drop-off fee');
  assert.strictEqual(r.fare, 203, `Lewes→Stansted expected £203, got £${r.fare}`);
});
test('Burgess Hill → Luton unaffected = £159 base + £7 fee = £166', async () => {
  const r = await calculateFare('Burgess Hill', 'Luton Airport', '10:00');
  assert.strictEqual(r.airport_fee, 7, 'Burgess→Luton must still add the drop-off fee');
  assert.strictEqual(r.fare, 166, `Burgess→Luton expected £166, got £${r.fare}`);
});

(async () => {
  console.log('\nAirport fixed-fare guardrail');
  for (const { name, fn } of queue) {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
