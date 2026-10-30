// SPDX-License-Identifier: AGPL-3.0-only
//
// Share-as-snapshot for the home dashboard (parity with desktop
// pages/dashboard/dashboard-snapshot.ts + lib/dashboard-helpers.ts).
//
// The operator copies a plain-text summary of the numbers already on screen
// and pastes it into Slack / Notion / email. Two rules keep it honest:
//
//  1. It is built ONLY from a loaded /api/v1/dashboard/stats payload whose
//     distinct-recipient counters are all present. A partial payload (older
//     API build, degraded read) cannot produce a snapshot, because the rates
//     would silently fall back to gross event totals — a different number
//     wearing the same label.
//  2. A rate the evidence cannot support is "—", never 0% and never >100%.
//
// Pure: no clipboard, no Date.now() unless the caller omits `generatedAt`.

import type { DashboardStats } from "@/lib/analytics-api";

function safeCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/**
 * Bounded rate from nonnegative safe-integer counts. Null when either value is
 * invalid, the denominator is zero, or the numerator exceeds the denominator
 * (out-of-order provider events must not surface a rate above 100%).
 */
export function rateFromCounts(num: unknown, denom: unknown): number | null {
  const n = safeCount(num);
  const d = safeCount(denom);
  if (n === null || d === null || d === 0 || n > d) return null;
  return n / d;
}

/** Open/click rate: prefer unique delivered, fall back to unique sent. */
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

export type SnapshotDeltaMode = "count" | "percent-points";

/** "+148", "-1.2pt", or "—" when there is no comparable baseline. */
export function formatSnapshotDelta(
  current: number | null,
  previous: number | null | undefined,
  mode: SnapshotDeltaMode,
): string {
  if (
    current === null ||
    typeof previous !== "number" ||
    !Number.isFinite(previous) ||
    !Number.isFinite(current)
  ) {
    return "—";
  }
  if (mode === "count") {
    const delta = current - previous;
    if (Math.abs(delta) < 0.5) return "—";
    return `${delta > 0 ? "+" : ""}${Math.round(delta).toLocaleString("en-US")}`;
  }
  const points = (current - previous) * 100;
  if (Math.abs(points) < 0.05) return "—";
  return `${points > 0 ? "+" : ""}${points.toFixed(1)}pt`;
}

function formatRate(rate: number | null): string {
  return rate === null ? "—" : `${(rate * 100).toFixed(1)}%`;
}

/**
 * True only for a complete distinct-recipient contract. The share control is
 * withheld (with its reason) until this holds.
 */
export function canBuildDashboardSnapshot(
  stats: DashboardStats | null | undefined,
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
  ].every((value) => safeCount(value) !== null);
}

export interface DashboardSnapshotOptions {
  /** Human window label, e.g. "Last 30 days". */
  rangeLabel?: string;
  /** Stamp for the footer; defaults to now. */
  generatedAt?: Date;
}

/** Plain-text summary of the loaded dashboard, one metric per line. */
export function buildDashboardSnapshot(
  stats: DashboardStats,
  options: DashboardSnapshotOptions = {},
): string {
  const rangeLabel = options.rangeLabel ?? "Last 30 days";
  const generatedAt = options.generatedAt ?? new Date();
  const previous = stats.previous ?? {};

  const subscribers = safeCount(stats.subscribers_total);
  const subscribersAdded = safeCount(stats.subscribers_added_30d);
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

  const rows: Array<[label: string, value: string, delta: string]> = [
    [
      "Subscribers",
      subscribers === null ? "—" : subscribers.toLocaleString("en-US"),
      formatSnapshotDelta(
        subscribersAdded,
        previous.subscribers_added ?? null,
        "count",
      ),
    ],
    [
      "Open rate",
      formatRate(openRate),
      formatSnapshotDelta(openRate, previousOpenRate, "percent-points"),
    ],
    [
      "Click rate",
      formatRate(clickRate),
      formatSnapshotDelta(clickRate, previousClickRate, "percent-points"),
    ],
    [
      "Bounce rate",
      formatRate(bounceRate),
      formatSnapshotDelta(bounceRate, previousBounceRate, "percent-points"),
    ],
  ];

  const lines = [`Moosewave — ${rangeLabel}`];
  for (const [label, value, delta] of rows) {
    lines.push(`${`${label}:`.padEnd(13)}${value.padEnd(8)}${delta}`);
  }
  lines.push("");
  lines.push(
    "_Rates use unique campaign-recipient evidence; opens/clicks prefer delivered with sent fallback, bounces use sent._",
  );
  lines.push("");
  lines.push(`_Generated ${generatedAt.toLocaleString()}_`);
  return lines.join("\n");
}
