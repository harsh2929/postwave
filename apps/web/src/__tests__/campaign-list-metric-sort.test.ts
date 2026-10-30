// SPDX-License-Identifier: AGPL-3.0-only
//
// Open-rate / click-rate sort and the folder filter on the campaigns list's
// shared filter+sort (desktop parity campaigns-15 / campaigns-7). The list
// endpoint sends rates as 0..1 fractions and OMITS them for a campaign with no
// delivered/sent denominator; "not measured" must not rank as 0%.

import { describe, expect, it } from "vitest";

import {
  CAMPAIGN_SORT_KEYS,
  campaignRate,
  filterAndSortCampaigns,
  nextCampaignSort,
} from "@/app/(dashboard)/app/campaigns/campaign-list-helpers";
import { UNCATEGORISED_FOLDER } from "@/lib/campaign-folders-api";
import type { Campaign } from "@/lib/campaigns-api";

function row(
  id: string,
  extra: { open_rate?: number; click_rate?: number; folder_id?: string } = {},
): Campaign {
  return {
    id,
    tenant_id: "t1",
    name: id,
    subject: `${id} subject`,
    status: "sent",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    ...extra,
  } as Campaign;
}

const ROWS = [
  row("low", { open_rate: 0.1, click_rate: 0.05 }),
  row("unrated"),
  row("high", { open_rate: 0.6, click_rate: 0.01, folder_id: "f1" }),
  row("mid", { open_rate: 0.3, click_rate: 0.2, folder_id: "f1" }),
];

function ids(
  sort: "open_rate" | "click_rate",
  order: "asc" | "desc",
  folder?: string,
): string[] {
  return filterAndSortCampaigns(ROWS, {
    status: "all",
    type: "all",
    sort,
    order,
    ...(folder !== undefined ? { folder } : {}),
  }).map((c) => c.id);
}

describe("campaign rate sort", () => {
  it("accepts open_rate and click_rate as URL sort keys", () => {
    expect(CAMPAIGN_SORT_KEYS).toContain("open_rate");
    expect(CAMPAIGN_SORT_KEYS).toContain("click_rate");
  });

  it("sorts by open rate, highest first, with unrated rows last", () => {
    expect(ids("open_rate", "desc")).toEqual(["high", "mid", "low", "unrated"]);
  });

  it("keeps unrated rows last when ascending too", () => {
    expect(ids("open_rate", "asc")).toEqual(["low", "mid", "high", "unrated"]);
  });

  it("sorts by click rate independently of open rate", () => {
    expect(ids("click_rate", "desc")).toEqual([
      "mid",
      "low",
      "high",
      "unrated",
    ]);
  });

  it("starts a newly chosen rate column descending", () => {
    expect(
      nextCampaignSort({ sort: "updated_at", order: "asc" }, "open_rate"),
    ).toEqual({ sort: "open_rate", order: "desc" });
  });

  it("reads a rate only when the server sent a finite number", () => {
    expect(campaignRate(row("x", { open_rate: 0 }), "open_rate")).toBe(0);
    expect(campaignRate(row("y"), "open_rate")).toBeNull();
    expect(
      campaignRate({ ...row("z"), open_rate: "0.5" } as Campaign, "open_rate"),
    ).toBeNull();
  });
});

describe("folder filter in the shared list filter", () => {
  it("narrows to one folder before sorting", () => {
    expect(ids("open_rate", "desc", "f1")).toEqual(["high", "mid"]);
  });

  it("narrows to uncategorised campaigns", () => {
    expect(ids("open_rate", "desc", UNCATEGORISED_FOLDER)).toEqual([
      "low",
      "unrated",
    ]);
  });

  it("leaves the list whole when no folder option is passed", () => {
    expect(ids("open_rate", "desc")).toHaveLength(4);
  });
});
