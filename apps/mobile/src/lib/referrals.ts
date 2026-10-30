/**
 * Referral inspection — the one import path the referral surface uses.
 *
 * This module was a single file until the payouts, variants and per-subscriber
 * link reads landed and pushed it past the source-quality ceiling. It is now a
 * facade over three siblings, split along the lines the file already argued for
 * in prose — WHICH routes exist, WHAT the server sent, and WHAT we say about
 * it — so that each half fails for one reason and can be read on its own:
 *
 *   lib/referralsBoundary.ts  the release gate mirrored from
 *                             apps/api/internal/referrals/referrals.go, and the
 *                             two route lists referrals.boundary.test.ts holds
 *                             against that source. Depended on by the copy.
 *   lib/referralsWire.ts      the payload shapes and their parsers. ABSENCE IS
 *                             NOT ZERO lives here: an unsent field is `null`,
 *                             never 0.
 *   lib/referralsCopy.ts      every sentence the screen renders that is not a
 *                             number, plus the branchy summary lines. Several
 *                             of them are claims about the gate, which is why
 *                             the gate is upstream of them.
 *
 * The split is a re-organisation and nothing else: every name below kept its
 * meaning and its import path. Hooks, components and both test files still
 * import from `@/lib/referrals`, so the direction of the dependency arrows is
 * the only thing that changed.
 *
 * Import-free of React across all three on purpose: parsing and copy are
 * unit-tested in the node environment, and the React layer only renders what
 * comes out of here.
 */
export * from "./referralsBoundary";
export * from "./referralsCopy";
export * from "./referralsWire";
