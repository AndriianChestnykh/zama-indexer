// All amounts are in cUSD/mUSD base units (6 decimals). 1_000_000n == 1.000000 token.
// The wrapper is 1:1 (rate == 1, decimals == 6), so a shield of N base units mints N
// confidential base units.
//
// The transaction mix required by implementation-plan.md §1.3:
//   user1 (alice): 2 shields, 5 spends -> bob, 7 spends -> holder, 1 unshield
//   user2 (bob):   1 shield,  5 spends -> holder, 10 spends -> alice, 2 unshields
//   user3 (holder): receives only
//
// Shields are deliberately over-provisioned so that *cumulative outflow <= shielded
// principal at every step*, which makes solvency independent of mid-run inflows and of
// the exact interleaving.

export const ONE = 1_000_000n; // 1 token in base units

export const SPEND = 5n * ONE; // 5 cUSD per confidential transfer
export const UNSHIELD = 10n * ONE; // 10 cUSD per unshield

export const ALICE_SHIELD = 50n * ONE; // alice shields this twice  -> 100 cUSD
export const BOB_SHIELD = 120n * ONE; //  bob shields this once     -> 120 cUSD

export const counts = {
  aliceShields: 2,
  aliceSpendsToBob: 5,
  aliceSpendsToHolder: 7,
  aliceUnshields: 1,
  bobShields: 1,
  bobSpendsToHolder: 5,
  bobSpendsToAlice: 10,
  bobUnshields: 2,
} as const;

/** Underlying mUSD each signer must hold before shielding. */
export const funding = {
  alice: ALICE_SHIELD * BigInt(counts.aliceShields), // 100 cUSD
  bob: BOB_SHIELD * BigInt(counts.bobShields), //        120 cUSD
} as const;

/**
 * Compile-time-ish guard: throws if the planned shields can't cover the planned
 * outflows. Run once at startup so a bad edit fails loudly instead of mid-run with a
 * revert.
 */
export function assertSolvent(): void {
  const aliceIn = ALICE_SHIELD * BigInt(counts.aliceShields);
  const aliceOut =
    SPEND * BigInt(counts.aliceSpendsToBob) +
    SPEND * BigInt(counts.aliceSpendsToHolder) +
    UNSHIELD * BigInt(counts.aliceUnshields);

  const bobIn = BOB_SHIELD * BigInt(counts.bobShields);
  const bobOut =
    SPEND * BigInt(counts.bobSpendsToHolder) +
    SPEND * BigInt(counts.bobSpendsToAlice) +
    UNSHIELD * BigInt(counts.bobUnshields);

  if (aliceOut > aliceIn) {
    throw new Error(`alice insolvent: out ${aliceOut} > shielded ${aliceIn}`);
  }
  if (bobOut > bobIn) {
    throw new Error(`bob insolvent: out ${bobOut} > shielded ${bobIn}`);
  }
}

/** Pretty-print base units as a decimal token string for logs. */
export function fmt(baseUnits: bigint): string {
  const neg = baseUnits < 0n;
  const v = neg ? -baseUnits : baseUnits;
  const whole = v / ONE;
  const frac = (v % ONE).toString().padStart(6, "0").replace(/0+$/, "") || "0";
  return `${neg ? "-" : ""}${whole}.${frac}`;
}
