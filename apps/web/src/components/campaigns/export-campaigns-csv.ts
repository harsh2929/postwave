// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { campaignRate } from "@/app/(dashboard)/app/campaigns/campaign-list-helpers";
import type { Campaign } from "@/lib/campaigns-api";
import { safeCsvCell } from "@/lib/csv-safe";
import { downloadTextFile } from "@/lib/download";

/**
 * Bulk "Export CSV" for the selected campaigns — desktop parity campaigns-12
 * (useCampaignBulkActions.ts `buildCampaignCsv` / `bulkExportCsv`).
 *
 * Built in the browser from the rows already loaded, so it is a snapshot of
 * what the list shows, not a server report. Same columns as desktop. Rates are
 * the 0..1 fractions the list endpoint sends, left blank (never 0) for a
 * campaign the server has no rate for. Every cell goes through the spreadsheet
 * formula guard: campaign names and subjects are tenant-authored text.
 */
export const CAMPAIGN_CSV_COLUMNS = [
  "name",
  "subject",
  "status",
  "sent_at",
  "open_rate",
  "click_rate",
] as const;

export function buildCampaignsCsv(campaigns: readonly Campaign[]): string {
  const rows: Array<Array<string | number | null>> = [
    [...CAMPAIGN_CSV_COLUMNS],
    ...campaigns.map((campaign) => [
      campaign.name,
      campaign.subject,
      campaign.status,
      campaign.sent_at ?? null,
      campaignRate(campaign, "open_rate"),
      campaignRate(campaign, "click_rate"),
    ]),
  ];
  return rows
    .map((row) => row.map((cell) => safeCsvCell(cell)).join(","))
    .join("\r\n");
}

export function campaignsCsvFilename(count: number): string {
  return `campaigns-export-${count}.csv`;
}

/**
 * Download the given campaigns as CSV. Returns how many rows were exported
 * (0 when there was nothing to export, in which case nothing is downloaded).
 */
export function exportCampaignsCsv(campaigns: readonly Campaign[]): number {
  if (campaigns.length === 0) return 0;
  downloadTextFile(
    campaignsCsvFilename(campaigns.length),
    buildCampaignsCsv(campaigns),
    "text/csv;charset=utf-8",
  );
  return campaigns.length;
}
