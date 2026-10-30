/**
 * fatigue — pure logic behind FatigueCard. Lives in a .ts module so
 * the node-environment vitest suite can import it without a JSX
 * transform (same pattern as grouped-series / analytics-nlq).
 *
 * Wire facts (ROADMAP-WRAPPERS R3 + deviation #8): decile rows carry
 * a `sends_bucket` LABEL (not a numeric range field) and the
 * open/unsub rates are 0..1 FRACTIONS, not percentages.
 */

import type { FatigueDecile } from "../../lib/api-client";

/** Format a 0..1 fraction as a percentage for display. */
export function fmtFraction(rate: number, digits = 1): string {
  return `${(rate * 100).toFixed(digits)}%`;
}

/**
 * Derive the honest one-line read of the deciles: does engagement
 * decay (and unsubscribes rise) as send volume per subscriber grows?
 *
 * Returns null when there are fewer than two buckets — a single
 * bucket has no gradient to read, and claiming one would be
 * fabrication.
 *
 * Thresholds: we only call out a fatigue signature when the
 * highest-volume bucket's open rate is at least 10% RELATIVELY below
 * the lowest-volume bucket's (e.g. 30% → 27%). Smaller gaps are
 * reported as "holding steady" — decile noise shouldn't read as a
 * diagnosis.
 */
export function fatigueRead(deciles: FatigueDecile[]): string | null {
  if (deciles.length < 2) return null;
  const first = deciles[0];
  const last = deciles[deciles.length - 1];
  if (!first || !last) return null;

  const openDrop =
    first.open_rate > 0
      ? (first.open_rate - last.open_rate) / first.open_rate
      : 0;
  const unsubUp = last.unsub_rate > first.unsub_rate;

  const span = `${first.sends_bucket} → ${last.sends_bucket} sends`;
  if (openDrop >= 0.1) {
    const unsubClause = unsubUp
      ? ` while unsubscribes rise from ${fmtFraction(first.unsub_rate, 2)} to ${fmtFraction(last.unsub_rate, 2)}`
      : "";
    return (
      `Fatigue signature: open rate falls from ${fmtFraction(first.open_rate)} to ` +
      `${fmtFraction(last.open_rate)} across ${span}${unsubClause}. ` +
      "Consider capping frequency for your highest-volume buckets."
    );
  }
  if (unsubUp && last.unsub_rate - first.unsub_rate >= 0.001) {
    return (
      `Open rates hold across ${span}, but unsubscribes rise from ` +
      `${fmtFraction(first.unsub_rate, 2)} to ${fmtFraction(last.unsub_rate, 2)} — ` +
      "watch the highest-volume buckets."
    );
  }
  return (
    `No fatigue signature: open rates hold from ${fmtFraction(first.open_rate)} to ` +
    `${fmtFraction(last.open_rate)} across ${span}.`
  );
}

/** Largest open rate across the deciles — scales the inline bars in
 *  the table (each bar is relative to the best-performing bucket). */
export function maxOpenRate(deciles: FatigueDecile[]): number {
  let max = 0;
  for (const d of deciles) if (d.open_rate > max) max = d.open_rate;
  return max;
}
