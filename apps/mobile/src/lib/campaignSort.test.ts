import { describe, expect, it } from "vitest";

import {
  CAMPAIGN_SORTS,
  campaignSortCaveat,
  campaignSortTime,
  isCampaignSort,
  sortCampaignRows,
  type CampaignSortRow,
} from "./campaignSort";

const ROWS: CampaignSortRow[] = [
  {
    id: "a",
    name: "Beta blast",
    status: "sent",
    sent_at: "2026-07-01T00:00:00Z",
    created_at: "2026-06-01T00:00:00Z",
    open_rate: 0.42,
    click_rate: 0.02,
  },
  {
    id: "b",
    name: "Alpha launch",
    status: "sent",
    sent_at: "2026-07-20T00:00:00Z",
    created_at: "2026-05-01T00:00:00Z",
    open_rate: 0.18,
    click_rate: 0.09,
  },
  {
    id: "c",
    name: "Draft idea",
    status: "draft",
    created_at: "2026-07-25T00:00:00Z",
  },
];

describe("campaignSortTime", () => {
  it("uses the date the ROW displays, not created_at", () => {
    // A scheduled row shows "Sends …"; ordering it by created_at would put it
    // somewhere the visible date does not explain.
    expect(
      campaignSortTime({
        id: "x",
        status: "scheduled",
        scheduled_at: "2026-08-01T00:00:00Z",
        created_at: "2026-01-01T00:00:00Z",
      }),
    ).toBe(Date.parse("2026-08-01T00:00:00Z"));
  });

  it("falls back through sent_at then created_at", () => {
    expect(
      campaignSortTime({ id: "x", sent_at: "2026-07-01T00:00:00Z" }),
    ).toBe(Date.parse("2026-07-01T00:00:00Z"));
    expect(
      campaignSortTime({ id: "x", created_at: "2026-07-01T00:00:00Z" }),
    ).toBe(Date.parse("2026-07-01T00:00:00Z"));
  });

  it("sinks a row with no usable date instead of parsing NaN", () => {
    expect(campaignSortTime({ id: "x" })).toBe(Number.NEGATIVE_INFINITY);
    expect(campaignSortTime({ id: "x", created_at: "not a date" })).toBe(
      Number.NEGATIVE_INFINITY,
    );
  });
});

describe("sortCampaignRows", () => {
  it("never mutates the cached page array", () => {
    const input = [...ROWS];
    sortCampaignRows(input, "name");
    expect(input.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("orders recent newest-first by the displayed date", () => {
    expect(sortCampaignRows(ROWS, "recent").map((r) => r.id)).toEqual([
      "c",
      "b",
      "a",
    ]);
  });

  it("orders by open rate, highest first", () => {
    expect(sortCampaignRows(ROWS, "open_rate").map((r) => r.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("orders by click rate independently of open rate", () => {
    expect(sortCampaignRows(ROWS, "click_rate").map((r) => r.id)).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  it("sinks unmeasured rows rather than ranking them as a genuine 0%", () => {
    const measuredZero: CampaignSortRow = {
      id: "z",
      name: "Zero",
      status: "sent",
      sent_at: "2026-07-02T00:00:00Z",
      open_rate: 0,
    };
    const order = sortCampaignRows([...ROWS, measuredZero], "open_rate").map(
      (r) => r.id,
    );
    // "c" has no open_rate at all; it must rank below a real measured 0%.
    expect(order.indexOf("z")).toBeLessThan(order.indexOf("c"));
  });

  it("orders by name using the subject when there is no name", () => {
    const rows: CampaignSortRow[] = [
      { id: "1", subject: "Zebra" },
      { id: "2", name: "Apple" },
    ];
    expect(sortCampaignRows(rows, "name").map((r) => r.id)).toEqual(["2", "1"]);
  });

  it("is a TOTAL order, so equal keys cannot reshuffle between renders", () => {
    const tied: CampaignSortRow[] = [
      { id: "b2", name: "Same", open_rate: 0.5 },
      { id: "a1", name: "Same", open_rate: 0.5 },
    ];
    expect(sortCampaignRows(tied, "open_rate").map((r) => r.id)).toEqual([
      "a1",
      "b2",
    ]);
    expect(sortCampaignRows(tied, "name").map((r) => r.id)).toEqual([
      "a1",
      "b2",
    ]);
  });

  it("accepts only the sorts the control offers", () => {
    for (const sort of CAMPAIGN_SORTS) {
      expect(isCampaignSort(sort.value)).toBe(true);
    }
    expect(isCampaignSort("status")).toBe(false);
  });
});

describe("campaignSortCaveat", () => {
  it("admits that a rate sort only covers the loaded window", () => {
    expect(campaignSortCaveat("open_rate", true, 100)).toContain(
      "100 campaigns loaded so far",
    );
  });

  it("stays quiet when everything is loaded, or when order is server order", () => {
    expect(campaignSortCaveat("open_rate", false, 100)).toBeNull();
    expect(campaignSortCaveat("recent", true, 100)).toBeNull();
  });
});
