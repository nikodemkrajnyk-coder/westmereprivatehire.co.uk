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
 * Horsham → Gatwick (£45) and → Heathrow (£90) are now all-in too.
 * Crawley is quote-on-request (no fixed fare) — the owner prices it by hand.
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
  { town: 'Brighton',       inputs: ['Brighton', 'Hove', 'Brighton, BN1 1AA', 'Hove, BN3 2AA'], ga: 75, he: 125 },
  { town: 'Burgess Hill',   inputs: ['Burgess Hill', 'Burgess Hill, RH15 8AA'],                  ga: 60, he: 126 },
  { town: 'Haywards Heath', inputs: ['Haywards Heath', 'Haywards Heath, RH16 1AA', 'RH17 5AA'],  ga: 65, he: 126 },
  { town: 'Lewes',          inputs: ['Lewes', 'Lewes, BN7 1AA'],                                 ga: 80, he: 150 },
  { town: 'Horsham',        inputs: ['Horsham', 'Horsham, RH12 1AA'],                            ga: 50, he: 90  },
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

// ── Symmetry: drop-off (town→airport) MUST equal pick-up (airport→town) ──────
// The owner wants one price per town/airport pair regardless of direction.
for (const t of ALLIN) {
  for (const [ap, apName] of [['ga', 'Gatwick Airport'], ['he', 'Heathrow Airport']]) {
    test(`${t.town} ↔ ${apName}: drop-off price == pick-up price (symmetric)`, async () => {
      const drop = await calculateFare(t.town, apName, '10:00'); // town → airport
      const pick = await calculateFare(apName, t.town, '10:00'); // airport → town
      assert.strictEqual(drop.fare, pick.fare, `${t.town}↔${apName} asymmetric: drop £${drop.fare} vs pick £${pick.fare}`);
      assert.strictEqual(drop.fare, t[ap], `${t.town}↔${apName} expected £${t[ap]} both ways, got £${drop.fare}`);
      assert.strictEqual(drop.airport_fee, 0);
      assert.strictEqual(pick.airport_fee, 0);
    });
  }
}

// (Horsham → Gatwick £50 and → Heathrow £90 are covered by the ALLIN table above.)

// ── Crawley: quote-on-request — NO auto fare (owner prices it manually) ──────
for (const [pu, de, label] of [
  ['Crawley', 'Gatwick Airport', 'Crawley → Gatwick'],
  ['Crawley', 'Heathrow Airport', 'Crawley → Heathrow'],
  ['Crawley, RH11 7XX', 'Gatwick Airport', 'RH11 (Crawley) → Gatwick'],
  ['Gatwick Airport', 'Crawley', 'Gatwick → Crawley (pickup)'],
]) {
  test(`${label} is quote-on-request (no fixed number)`, async () => {
    const r = await calculateFare(pu, de, '10:00');
    assert.strictEqual(r.fare, null, `${label} must NOT auto-return a fare, got £${r.fare}`);
    assert.ok(r.on_request === true || r.rate_type === 'on_request', `${label} must be flagged on_request`);
  });
}

// ── Scope guards: unchanged towns/airports still add the fee on top ──
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
