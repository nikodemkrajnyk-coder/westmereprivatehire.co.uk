/**
 * Dead-miles (collection) fee — single source of truth.
 *
 * Dead miles are the empty miles the driver covers from the Horsham home base
 * out to the pickup. The first few are absorbed; beyond that we charge a TIERED
 * rate so long collections don't punish the customer with a runaway linear fee:
 *
 *   • First 5 miles            — free
 *   • Next 20 chargeable miles — £1.50/mile
 *   • Everything beyond that   — £1.00/mile
 *
 * Example — 51 dead miles (e.g. Horsham → Acton):
 *   5 free, then 20 mi @ £1.50 = £30, then 26 mi @ £1.00 = £26 → £56.00
 *
 * The fee is rounded UP to the nearest 50p.
 */

const FREE_MI       = 5;     // miles absorbed before any charge
const TIER1_MI      = 20;    // chargeable miles billed at the higher rate
const TIER1_RATE    = 1.50;  // £/mile for the first TIER1_MI chargeable miles
const TIER2_RATE    = 1.00;  // £/mile for chargeable miles beyond that

function deadMilesFee(deadMi) {
  const miles = Math.max(0, Number(deadMi) || 0);
  const chargeableMi = Math.max(0, miles - FREE_MI);

  const tier1Mi = Math.min(chargeableMi, TIER1_MI);
  const tier2Mi = Math.max(0, chargeableMi - TIER1_MI);

  const rawFee = tier1Mi * TIER1_RATE + tier2Mi * TIER2_RATE;
  const fee = Math.ceil(rawFee * 2) / 2; // round up to nearest 50p

  // Human-readable breakdown of the chargeable portion.
  let breakdown;
  if (chargeableMi <= 0) {
    breakdown = 'no charge';
  } else if (tier2Mi <= 0) {
    breakdown = `${tier1Mi.toFixed(1)} mi @ £${TIER1_RATE.toFixed(2)}/mi`;
  } else {
    breakdown = `${tier1Mi.toFixed(1)} mi @ £${TIER1_RATE.toFixed(2)}/mi + ${tier2Mi.toFixed(1)} mi @ £${TIER2_RATE.toFixed(2)}/mi`;
  }

  return {
    deadMi: miles,
    freeMi: FREE_MI,
    chargeableMi,
    tier1Mi,
    tier2Mi,
    fee,
    breakdown,
  };
}

module.exports = { deadMilesFee, FREE_MI, TIER1_MI, TIER1_RATE, TIER2_RATE };
