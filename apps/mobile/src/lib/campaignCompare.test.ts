import { describe, expect, it } from "vitest";

import {
  COMPARE_METRICS,
  compareHeadline,
  compareLeader,
  parseCompareRows,
  type CampaignCompareRow,
} from "./campaignCompare";

const OPEN = COMPARE_METRICS[0]!;
const BOUNCE = COMPARE_METRICS[2]!;

function row(over: Partial<CampaignCompareRow>): CampaignCompareRow {
  return {
    campaignId: "x",
    totalRecipients: 100,
    openRate: null,
    clickRate: null,
    bounceRate: null,
    complaintRate: null,
    unsubRate: null,
    ...over,
  };
}

describe("parseCompareRows", () => {
  /**
   * The whole reason this module exists. Service.Compare fills an id it has
   * no events for with a zero-valued struct, which on the wire is identical
   * to "delivered to 40,000, opened by nobody".
   */
  it("treats a zero-recipient row as NO DATA, not as 0%", () => {
    const [parsed] = parseCompareRows([
      {
        campaign_id: "a",
        total_recipients: 0,
        open_rate: 0,
        click_rate: 0,
        bounce_rate: 0,
      },
    ]);
    expect(parsed?.totalRecipients).toBeNull();
    expect(parsed?.openRate).toBeNull();
    expect(parsed?.clickRate).toBeNull();
  });

  it("keeps a genuine measured zero when the campaign did reach people", () => {
    const [parsed] = parseCompareRows([
      { campaign_id: "a", total_recipients: 4000, open_rate: 0 },
    ]);
    expect(parsed?.totalRecipients).toBe(4000);
    expect(parsed?.openRate).toBe(0);
  });

  it("drops rows with no campaign id and tolerates a non-array body", () => {
    expect(parseCompareRows([{ total_recipients: 5 }])).toEqual([]);
    expect(parseCompareRows(null)).toEqual([]);
    expect(parseCompareRows({ items: [{ campaign_id: "a" }] })).toHaveLength(1);
  });
});

describe("compareLeader", () => {
  it("picks the higher number when higher is better", () => {
    const rows = [
      row({ campaignId: "a", openRate: 0.4 }),
      row({ campaignId: "b", openRate: 0.5 }),
    ];
    expect(compareLeader(rows, OPEN)).toBe("b");
  });

  it("picks the LOWER number for a bad-news metric", () => {
    const rows = [
      row({ campaignId: "a", bounceRate: 0.02 }),
      row({ campaignId: "b", bounceRate: 0.09 }),
    ];
    expect(compareLeader(rows, BOUNCE)).toBe("a");
  });

  it("declares nothing on a tie", () => {
    const rows = [
      row({ campaignId: "a", openRate: 0.4 }),
      row({ campaignId: "b", openRate: 0.4 }),
    ];
    expect(compareLeader(rows, OPEN)).toBeNull();
  });

  /** One measurement beside an em-dash is not a win. */
  it("declares nothing when only one campaign has the measurement", () => {
    const rows = [
      row({ campaignId: "a", openRate: 0.4 }),
      row({ campaignId: "b", openRate: null }),
    ];
    expect(compareLeader(rows, OPEN)).toBeNull();
  });
});

describe("compareHeadline", () => {
  const name = (id: string) => id.toUpperCase();

  it("says so plainly when nothing has been delivered", () => {
    const rows = [
      row({ campaignId: "a", totalRecipients: null }),
      row({ campaignId: "b", totalRecipients: null }),
    ];
    expect(compareHeadline(rows, name)).toContain("nothing to compare");
  });

  it("refuses to pick a winner on a mixed result", () => {
    const rows = [
      row({ campaignId: "a", openRate: 0.5, clickRate: 0.01 }),
      row({ campaignId: "b", openRate: 0.4, clickRate: 0.05 }),
    ];
    expect(compareHeadline(rows, name)).toBe(
      "A opened better; B was clicked more.",
    );
  });

  it("names one winner when it led on both", () => {
    const rows = [
      row({ campaignId: "a", openRate: 0.5, clickRate: 0.05 }),
      row({ campaignId: "b", openRate: 0.4, clickRate: 0.01 }),
    ];
    expect(compareHeadline(rows, name)).toBe(
      "A led on both open rate and click rate.",
    );
  });

  it("flags a campaign with no delivery instead of ranking it", () => {
    const rows = [
      row({ campaignId: "a", openRate: 0.5 }),
      row({ campaignId: "b", totalRecipients: null }),
    ];
    expect(compareHeadline(rows, name)).toContain("B has no recorded delivery");
  });
});
