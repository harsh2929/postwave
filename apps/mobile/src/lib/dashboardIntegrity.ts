/**
 * lib/dashboardIntegrity.ts — tell the difference between "we have no number"
 * and "the number we were given is impossible".
 *
 * `lib/dashboardMetrics` is deliberately strict: a rate whose numerator
 * exceeds its denominator is REFUSED rather than clamped into a
 * plausible-looking 100%. That is the right display behaviour and it created a
 * second, quieter problem — the refusal renders as the same em-dash a missing
 * measurement does. So the two most different things a tile can be saying,
 * "nothing was reported" and "what was reported cannot be true", became
 * indistinguishable, and the second one — a lagging or wrong delivery
 * denominator, i.e. a real data-integrity signal — vanished silently.
 *
 * This module recovers that signal. It answers one question per rate: were the
 * inputs PRESENT but IMPOSSIBLE? Pure, no React, no clock.
 */
import type { DashboardStats } from "@/lib/dashboardStatsSchema";

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * True when `numerator` and `denominator` are both real measurements and the
 * ratio between them is impossible. A zero or absent denominator is NOT
 * unverifiable — it is simply unmeasured.
 */
export function ratioIsImpossible(
  numerator: unknown,
  denominator: unknown,
): boolean {
  const n = count(numerator);
  const d = count(denominator);
  if (n === null || d === null || d <= 0) return false;
  return n > d;
}

/**
 * Mirrors `rateFromUniqueRecipients`' delivered-then-sent fallback: the rate is
 * only unverifiable when EVERY denominator it would have tried is impossible.
 * If delivered is broken but sent works, the tile shows an honest number and
 * there is nothing to disclose.
 */
function engagementImpossible(
  numerator: unknown,
  uniqueDelivered: unknown,
  uniqueSent: unknown,
): boolean {
  const candidates = [uniqueDelivered, uniqueSent].filter(
    (value) => count(value) !== null && (count(value) as number) > 0,
  );
  if (candidates.length === 0) return false;
  return candidates.every((denominator) =>
    ratioIsImpossible(numerator, denominator),
  );
}

/** Reader-facing metric names, in the order the tiles appear. */
export const UNVERIFIABLE_METRIC_LABELS = {
  open: "open rate",
  click: "click rate",
  bounce: "bounce rate",
} as const;

/**
 * Which rates on this payload were reported but cannot be true. Empty on every
 * healthy response, which is what lets the caller render nothing at all rather
 * than a permanent caveat nobody reads.
 */
export function unverifiableRates(
  stats: DashboardStats | undefined,
): string[] {
  if (!stats) return [];
  const out: string[] = [];

  if (
    engagementImpossible(
      stats.unique_opens_30d,
      stats.unique_delivered_30d,
      stats.unique_sent_30d,
    ) ||
    // Legacy deployments send a precomputed fraction; above 1 it is not a rate.
    (typeof stats.open_rate?.rate === "number" &&
      Number.isFinite(stats.open_rate.rate) &&
      stats.open_rate.rate > 1)
  ) {
    out.push(UNVERIFIABLE_METRIC_LABELS.open);
  }
  if (
    engagementImpossible(
      stats.unique_clicks_30d,
      stats.unique_delivered_30d,
      stats.unique_sent_30d,
    )
  ) {
    out.push(UNVERIFIABLE_METRIC_LABELS.click);
  }
  // A bounce is by definition undelivered, so its denominator is always sent.
  if (ratioIsImpossible(stats.unique_bounces_30d, stats.unique_sent_30d)) {
    out.push(UNVERIFIABLE_METRIC_LABELS.bounce);
  }
  return out;
}

/**
 * One sentence for the tiles that could not be computed. Names the condition
 * as OURS rather than implying the workspace's numbers moved — a reader who
 * thinks their open rate collapsed acts very differently from one who knows a
 * denominator is lagging.
 */
export function unverifiableRatesNotice(
  stats: DashboardStats | undefined,
): string | null {
  const metrics = unverifiableRates(stats);
  if (metrics.length === 0) return null;
  const list =
    metrics.length === 1
      ? metrics[0]
      : `${metrics.slice(0, -1).join(", ")} and ${metrics[metrics.length - 1]}`;
  const verb = metrics.length === 1 ? "is" : "are";
  return `${list} ${verb} shown as — because the reported activity exceeds the recipients it is measured against. That is a reporting problem on our side, not a change in your numbers.`;
}
