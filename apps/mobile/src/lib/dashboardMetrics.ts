/**
 * lib/dashboardMetrics.ts — rate derivation and period-over-period deltas.
 *
 * Ported from apps/desktop/src/lib/dashboard-helpers.ts so the phone and the
 * desk compute the same number from the same payload. The two rules that
 * matter, both of which mobile previously had no way to express:
 *
 *  - A RATE NEEDS A RECIPIENT DENOMINATOR. Opens divided by campaign count is
 *    not an open rate; it produces 16,600%. Unique opens over unique DELIVERED
 *    recipients is the contract, with unique SENT as the fallback for
 *    deployments that don't compute delivered. Anything else returns null and
 *    renders as an em-dash.
 *  - A RATIO ABOVE 1 IS NOT A RATE. `num > denom` means the denominator is
 *    wrong or lagging, so the pair is refused rather than clamped into a
 *    plausible-looking 100%.
 *
 * Deltas are expressed in the unit the reader expects: counts as a signed
 * count, rates as PERCENTAGE POINTS ("+2.4 pts"), never as a percentage of a
 * percentage — "open rate up 8%" is unreadable when the rate moved 30%→32.4%.
 */
import { num } from "@/lib/format";

/** A ratio in [0,1], or null when the inputs cannot produce an honest one. */
export function rateFromCounts(
  numerator: unknown,
  denominator: unknown,
): number | null {
  if (
    typeof numerator !== "number" ||
    typeof denominator !== "number" ||
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    numerator < 0 ||
    denominator <= 0 ||
    numerator > denominator
  ) {
    return null;
  }
  return numerator / denominator;
}

/**
 * Engagement rates prefer DELIVERED recipients and fall back to SENT. Bounce
 * rate must not use this — a bounce is by definition not delivered, so its
 * denominator is always sent.
 */
export function rateFromUniqueRecipients(
  numerator: unknown,
  uniqueDelivered: unknown,
  uniqueSent: unknown,
): number | null {
  return (
    rateFromCounts(numerator, uniqueDelivered) ??
    rateFromCounts(numerator, uniqueSent)
  );
}

export type DeltaDirection = "up" | "down" | "flat";

export interface MetricDelta {
  dir: DeltaDirection;
  text: string;
}

/** Movement below this many percentage points reads as noise, not a trend. */
const RATE_EPSILON_POINTS = 0.05;

/**
 * Signed change in a count. Returns null (rather than a "flat" chip) when
 * there is no comparison window at all — "no previous period" and "unchanged"
 * are different statements and the tile should not conflate them.
 */
export function countDelta(
  current: number | null | undefined,
  previous: number | null | undefined,
  suffix = "vs prev",
): MetricDelta | null {
  if (
    typeof current !== "number" ||
    typeof previous !== "number" ||
    !Number.isFinite(current) ||
    !Number.isFinite(previous)
  ) {
    return null;
  }
  const delta = current - previous;
  if (Math.abs(delta) < 0.5) return { dir: "flat", text: `no change ${suffix}` };
  const rounded = Math.round(delta);
  return {
    dir: delta > 0 ? "up" : "down",
    text: `${delta > 0 ? "+" : "−"}${num(Math.abs(rounded))} ${suffix}`,
  };
}

/** Signed change in a rate, expressed in percentage points. */
export function rateDelta(
  current: number | null | undefined,
  previous: number | null | undefined,
  suffix = "vs prev",
): MetricDelta | null {
  if (
    typeof current !== "number" ||
    typeof previous !== "number" ||
    !Number.isFinite(current) ||
    !Number.isFinite(previous)
  ) {
    return null;
  }
  const points = (current - previous) * 100;
  if (Math.abs(points) < RATE_EPSILON_POINTS) {
    return { dir: "flat", text: `no change ${suffix}` };
  }
  return {
    dir: points > 0 ? "up" : "down",
    text: `${points > 0 ? "+" : "−"}${Math.abs(points).toFixed(1)} pts ${suffix}`,
  };
}

/**
 * Strip the good/bad colouring while keeping the movement text.
 *
 * A tile's up-arrow is painted with the success colour, which encodes "up is
 * good". That is true for subscribers and open rate and FALSE for bounce rate,
 * where a rise is the bad news. Flipping the arrow instead would print a ▼ next
 * to the text "+0.4 pts", which is worse than useless. So a
 * lower-is-better metric reports its movement in neutral ink and lets the
 * number speak, rather than asserting a polarity the glyph can't carry.
 */
export function neutralDelta(delta: MetricDelta | null): MetricDelta | null {
  if (!delta) return null;
  return { dir: "flat", text: delta.text };
}
