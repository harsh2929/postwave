import type {
  DashboardRange,
  DashboardStatsResponse,
} from "../../lib/api-client";
import {
  dashboardSnapshotMarkdown,
  formatDelta,
  rangeLabel,
  rateFromCounts,
  rateFromUniqueRecipients,
} from "../../lib/dashboard-helpers";

function formatRate(rate: number | null): string {
  return rate === null ? "—" : `${(rate * 100).toFixed(1)}%`;
}

function nonnegativeSafeCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/** A shared snapshot is enabled only for a complete recipient-count contract.
 * The formatter still preserves partial or inconsistent rates as “—” for
 * defensive callers, but the Dashboard never substitutes gross totals. */
export function canBuildDashboardSnapshot(
  stats: DashboardStatsResponse | null,
): stats is DashboardStatsResponse {
  if (!stats) return false;
  const subscribers = nonnegativeSafeCount(stats.subscribers_total);
  const subscribersAdded = nonnegativeSafeCount(stats.subscribers_added_30d);
  const uniqueOpens = nonnegativeSafeCount(stats.unique_opens_30d);
  const uniqueClicks = nonnegativeSafeCount(stats.unique_clicks_30d);
  const uniqueBounces = nonnegativeSafeCount(stats.unique_bounces_30d);
  const uniqueDelivered = nonnegativeSafeCount(stats.unique_delivered_30d);
  const uniqueSent = nonnegativeSafeCount(stats.unique_sent_30d);
  if (
    subscribers === null ||
    subscribersAdded === null ||
    uniqueOpens === null ||
    uniqueClicks === null ||
    uniqueBounces === null ||
    uniqueDelivered === null ||
    uniqueSent === null
  ) {
    return false;
  }
  return true;
}

/** Build the share payload only from a real loaded dashboard response. */
export function buildDashboardSnapshot(
  stats: DashboardStatsResponse,
  range: DashboardRange,
): string {
  const previous = stats.previous ?? {};
  const subscribers = nonnegativeSafeCount(stats.subscribers_total);
  const subscribersAdded = nonnegativeSafeCount(stats.subscribers_added_30d);
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
  const previousOpenRate = rateFromUniqueRecipients(
    previous.unique_opens,
    previous.unique_delivered,
    previous.unique_sent,
  );
  const previousClickRate = rateFromUniqueRecipients(
    previous.unique_clicks,
    previous.unique_delivered,
    previous.unique_sent,
  );
  const previousBounceRate = rateFromCounts(
    previous.unique_bounces,
    previous.unique_sent,
  );

  return dashboardSnapshotMarkdown({
    rangeLabel: rangeLabel(range),
    methodology:
      "Rates use unique campaign-recipient evidence; opens/clicks prefer delivered with sent fallback, bounces use sent.",
    rows: [
      {
        label: "Subscribers",
        value: subscribers === null ? "—" : subscribers.toLocaleString(),
        delta:
          subscribersAdded === null
            ? undefined
            : formatDelta(
                subscribersAdded,
                previous.subscribers_added ?? null,
                "count",
              ),
      },
      {
        label: "Open rate",
        value: formatRate(openRate),
        delta:
          openRate === null
            ? undefined
            : formatDelta(openRate, previousOpenRate, "percent-points"),
      },
      {
        label: "Click rate",
        value: formatRate(clickRate),
        delta:
          clickRate === null
            ? undefined
            : formatDelta(clickRate, previousClickRate, "percent-points"),
      },
      {
        label: "Bounce rate",
        value: formatRate(bounceRate),
        delta:
          bounceRate === null
            ? undefined
            : formatDelta(bounceRate, previousBounceRate, "percent-points"),
      },
    ],
  });
}
