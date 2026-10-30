import { describe, expect, it } from "vitest";

import type { Campaign } from "../../lib/api-client";
import {
  campaignRowId,
  campaignStatusTone,
  escapeCampaignCsvCell,
  formatCampaignPercent,
  isCampaignAbTest,
} from "../../pages/campaigns/campaigns-page-utils";
import { buildCampaignCsv } from "../../pages/campaigns/useCampaignBulkActions";
import { unwrapCampaignRows } from "../../pages/campaigns/campaign-list-reconciliation";
import {
  buildCampaignStatCells,
  calculateCampaignStats,
  filterCampaignRows,
  sortCampaignRows,
} from "../../pages/campaigns/useCampaignsViewModel";

function campaign(input: Partial<Campaign>): Campaign {
  return input as Campaign;
}

describe("campaigns controller boundaries", () => {
  it("normalizes bare and legacy-enveloped list responses", () => {
    const rows = [campaign({ id: "one" })];
    expect(unwrapCampaignRows(rows)).toBe(rows);
    expect(unwrapCampaignRows({ items: rows })).toBe(rows);
    expect(unwrapCampaignRows({ results: rows })).toBe(rows);
    expect(unwrapCampaignRows({ data: rows })).toBe(rows);
    expect(unwrapCampaignRows(null)).toEqual([]);
  });

  it("exports selected rows with stable columns and RFC-compatible escaping", () => {
    expect(escapeCampaignCsvCell('Launch, "VIP"')).toBe('"Launch, ""VIP"""');
    expect(
      buildCampaignCsv([
        campaign({
          name: 'Launch, "VIP"',
          subject: "Hello\nthere",
          status: "sent",
          sent_at: "2026-07-10T12:00:00Z",
          open_rate: 0.42,
          click_rate: 0.08,
        }),
      ]),
    ).toBe(
      'name,subject,status,sent_at,open_rate,click_rate\n"Launch, ""VIP""","Hello\nthere",sent,2026-07-10T12:00:00Z,0.42,0.08',
    );
  });

  it("neutralizes spreadsheet formulas without converting numeric metrics", () => {
    expect(escapeCampaignCsvCell("=SUM(A1:A2)")).toBe("'=SUM(A1:A2)");
    expect(escapeCampaignCsvCell("  +cmd|' /C calc'!A0")).toBe(
      "'  +cmd|' /C calc'!A0",
    );
    expect(escapeCampaignCsvCell("\t@SUM(A1:A2)")).toBe('"\'\t@SUM(A1:A2)"');
    expect(escapeCampaignCsvCell("\r-2+3")).toBe('"\'\r-2+3"');
    expect(escapeCampaignCsvCell("\u200B=1+1")).toBe("'\u200B=1+1");
    expect(escapeCampaignCsvCell(-42.5)).toBe("-42.5");
  });
});

describe("campaigns view model", () => {
  const rows = [
    campaign({
      id: "one",
      name: "July Launch",
      subject: "VIP",
      status: "running",
      folder_id: "launches",
      sent_at: "2026-07-10T12:00:00Z",
      open_rate: 0.5,
      click_rate: 0.1,
    }),
    campaign({
      id: "two",
      name: "Draft note",
      subject: "July follow-up",
      status: "draft",
      open_rate: 0.25,
      click_rate: 0.05,
    }),
    campaign({
      id: "three",
      name: "Old send",
      status: "sent",
      sent_at: "2026-06-30T12:00:00Z",
    }),
  ];

  it("combines sent/running status, folder, and text filters", () => {
    expect(
      filterCampaignRows(rows, {
        filter: "sent",
        folderFilter: "launches",
        query: "july",
      }).map(campaignRowId),
    ).toEqual(["one"]);
    expect(
      filterCampaignRows(rows, {
        filter: "all",
        folderFilter: "__uncategorised",
        query: "follow-UP",
      }).map(campaignRowId),
    ).toEqual(["two"]);
  });

  it("sorts a copy using the reviewed column semantics", () => {
    const sorted = sortCampaignRows(rows, "open", "desc");
    expect(sorted.map(campaignRowId)).toEqual(["one", "two", "three"]);
    expect(sorted).not.toBe(rows);
    expect(sortCampaignRows(rows, null, "asc")).toBe(rows);
  });

  it("calculates range-honest campaign summary cells", () => {
    const stats = calculateCampaignStats(rows, new Date(2026, 6, 16, 12));
    expect(stats).toMatchObject({
      total: 3,
      sentThisMonth: 1,
      avgOpen: 0.375,
    });
    expect(stats.avgClick).toBeCloseTo(0.075);
    expect(
      buildCampaignStatCells({ ...stats, total: 100 }, false, true)[0],
    ).toMatchObject({
      value: "100",
      hint: "All campaigns in the complete verified workspace snapshot.",
    });
    expect(
      buildCampaignStatCells(stats, true, false).map((cell) => cell.value),
    ).toEqual(["—", "—", "—", "—"]);
  });

  it("keeps status, A/B, and rate presentation rules explicit", () => {
    expect(formatCampaignPercent(0.421)).toBe("42.1%");
    expect(formatCampaignPercent(42.1)).toBe("42.1%");
    expect(formatCampaignPercent(undefined)).toBe("—");
    expect(campaignStatusTone("running")).toBe("var(--pw-accent)");
    expect(campaignStatusTone("failed")).toBe("var(--pw-danger)");
    expect(
      isCampaignAbTest(
        campaign({
          delivery_settings: { ab_test: { is_parent: true } },
        } as unknown as Partial<Campaign>),
      ),
    ).toBe(true);
  });
});
