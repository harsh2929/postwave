// SPDX-License-Identifier: AGPL-3.0-only
import type { DashboardStats } from "./analytics-api";
import { rangeDays } from "./analytics-format";

/** The compatibility builder returns copy suggestions, not an analytics summary. */
function counted(value: number, label: string): string {
  return `${value.toLocaleString()} ${label}${value === 1 ? "" : "s"}`;
}

export function analyticsNarrativeText(
  stats: DashboardStats,
  range: string,
  result: { provider_mode?: string; text?: string },
): string {
  if (result.provider_mode !== "deterministic_with_provider_slot") {
    return result.text?.trim() || "No summary was returned.";
  }
  const previous = stats.previous;
  const change =
    previous &&
    typeof previous.opens_total === "number" &&
    typeof previous.clicks_total === "number"
      ? ` The previous period recorded ${previous.opens_total.toLocaleString()} opens and ${previous.clicks_total.toLocaleString()} clicks.`
      : " Prior-period engagement counts are unavailable.";
  return `In the last ${rangeDays(range)} days, ${counted(stats.campaigns_sent_30d, "campaign")} recorded ${counted(stats.opens_total_30d, "open")}, ${counted(stats.clicks_total_30d, "click")} and ${counted(stats.bounces_total_30d, "bounce")}.${change} Calculated from report counts; repeat interactions are included.`;
}
