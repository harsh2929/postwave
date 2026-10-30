// SPDX-License-Identifier: AGPL-3.0-only

import type { CampaignReport } from "@/lib/campaign-analytics-api";

export interface TemplateOutcomeSummary {
  campaigns: number;
  delivered: number;
  uniqueOpens: number;
  uniqueClicks: number;
  openRate: number | null;
  clickRate: number | null;
}

/** Aggregate observed campaign totals, never a causal estimate of template quality. */
export function summarizeTemplateOutcomes(reports: readonly CampaignReport[]): TemplateOutcomeSummary {
  const delivered = reports.reduce((sum, report) => sum + Math.max(0, report.delivered), 0);
  const uniqueOpens = reports.reduce((sum, report) => sum + Math.max(0, report.unique_opens), 0);
  const uniqueClicks = reports.reduce((sum, report) => sum + Math.max(0, report.unique_clicks), 0);
  return {
    campaigns: reports.length,
    delivered,
    uniqueOpens,
    uniqueClicks,
    openRate: delivered > 0 ? (uniqueOpens / delivered) * 100 : null,
    clickRate: delivered > 0 ? (uniqueClicks / delivered) * 100 : null,
  };
}
