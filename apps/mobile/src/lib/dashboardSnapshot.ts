/**
 * lib/dashboardSnapshot.ts — "here's where we are this week", pasteable.
 *
 * Ported from apps/desktop/src/pages/dashboard/dashboard-snapshot.ts. Sharing a
 * status update is more natural on a phone than on a desk, and the app already
 * uses `Share.share` at a dozen call sites — the only thing missing was the
 * text.
 *
 * Two honesty rules carried over verbatim from the desktop, because a number
 * pasted into Slack outlives the screen it came from:
 *
 *  - THE SNAPSHOT IS GATED ON A COMPLETE RECIPIENT CONTRACT. If the counts
 *    needed to compute rates honestly are missing, the share affordance does
 *    not appear at all. A snapshot full of em-dashes is worse than no snapshot.
 *  - THE METHODOLOGY TRAVELS WITH THE NUMBERS. The last line states the
 *    denominators, so a reader three apps away cannot mistake "34% opened" for
 *    a different definition of opened.
 */
import { rateFromCounts, rateFromUniqueRecipients } from "@/lib/dashboardMetrics";
import type { DashboardStats } from "@/lib/dashboardStatsSchema";
import { EMDASH, num, percent } from "@/lib/format";

function nonNegativeCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * True when every count the snapshot needs is present. The formatter below
 * still degrades to an em-dash for defensive callers, but the dashboard never
 * offers the share action unless this passes.
 */
export function canBuildDashboardSnapshot(
  stats: DashboardStats | undefined,
): stats is DashboardStats {
  if (!stats) return false;
  return [
    stats.subscribers_total,
    stats.subscribers_added_30d,
    stats.unique_opens_30d,
    stats.unique_clicks_30d,
    stats.unique_bounces_30d,
    stats.unique_delivered_30d,
    stats.unique_sent_30d,
  ].every((value) => nonNegativeCount(value) !== null);
}

function rateLine(label: string, rate: number | null): string {
  return `${label}: ${rate === null ? EMDASH : percent(rate)}`;
}

export interface SnapshotOptions {
  workspace?: string | undefined;
  rangeLabel: string;
}

/** Build the share body. Plain text: it has to survive every paste target. */
export function buildDashboardSnapshot(
  stats: DashboardStats,
  { workspace, rangeLabel }: SnapshotOptions,
): string {
  const openRate = rateFromUniqueRecipients(
    stats.unique_opens_30d,
    stats.unique_delivered_30d,
    stats.unique_sent_30d,
  );
  const clickRate = rateFromUniqueRecipients(
    stats.unique_clicks_30d,
    stats.unique_delivered_30d,
    stats.unique_sent_30d,
  );
  const bounceRate = rateFromCounts(
    stats.unique_bounces_30d,
    stats.unique_sent_30d,
  );
  const added = nonNegativeCount(stats.subscribers_added_30d);
  const unsubbed = nonNegativeCount(stats.subscribers_unsubbed_30d);
  const net = added === null || unsubbed === null ? added : added - unsubbed;

  return [
    `${workspace?.trim() || "Moosewave"} — ${rangeLabel}`,
    "",
    `Subscribers: ${num(stats.subscribers_total)}${
      net === null ? "" : ` (${net >= 0 ? "+" : "−"}${num(Math.abs(net))})`
    }`,
    `Campaigns sent: ${num(stats.campaigns_sent_30d)}`,
    rateLine("Open rate", openRate),
    rateLine("Click rate", clickRate),
    rateLine("Bounce rate", bounceRate),
    "",
    "Rates use unique campaign recipients: opens and clicks over delivered (sent as fallback), bounces over sent.",
  ].join("\n");
}
