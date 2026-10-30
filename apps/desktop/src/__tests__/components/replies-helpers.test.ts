/**
 * replies-helpers — pure logic behind RepliesOverviewCard (#16).
 *
 * High-stakes invariants:
 *   1. Honest-empty: summaryIsEmpty is true ONLY for a successfully
 *      loaded summary with total === 0 — `null` (unloaded / failed)
 *      must never read as "no replies tracked yet".
 *   2. reply_rate from /replies/by-campaign is a FRACTION 0..1
 *      (distinct_replyers / unique_recipients) — formatting must ×100.
 *   3. Campaign-id → name resolution never invents names: unknown ids
 *      fall back to a shortened id, not a placeholder string that
 *      looks like data.
 */

import { describe, expect, it } from "vitest";

import type { Campaign, RepliesSummary } from "../../lib/api-client";
import {
  buildTopCampaignRows,
  campaignDisplayName,
  fmtReplyRate,
  shortId,
  sparkValues,
  summaryIsEmpty,
  timeseriesToLinePoints,
} from "../../components/replies/replies-helpers";

const CAMPAIGNS: Campaign[] = [
  { id: "11111111-aaaa-bbbb-cccc-000000000001", name: "Spring launch" },
  { id: 42, subject: "Numeric-id campaign" },
  { id: "33333333-aaaa-bbbb-cccc-000000000003" },
];

function summary(over: Partial<RepliesSummary> = {}): RepliesSummary {
  return {
    window_days: 30,
    total: 10,
    matched: 8,
    unmatched: 2,
    top_campaigns: [],
    ...over,
  };
}

describe("timeseriesToLinePoints / sparkValues", () => {
  it("maps {date, replies} onto LineChart's {date, count}", () => {
    const pts = [
      { date: "2026-06-01", replies: 3 },
      { date: "2026-06-02", replies: 0 },
    ];
    expect(timeseriesToLinePoints(pts)).toEqual([
      { date: "2026-06-01", count: 3 },
      { date: "2026-06-02", count: 0 },
    ]);
    expect(sparkValues(pts)).toEqual([3, 0]);
  });

  it("tolerates null/undefined input", () => {
    expect(timeseriesToLinePoints(null)).toEqual([]);
    expect(timeseriesToLinePoints(undefined)).toEqual([]);
    expect(sparkValues(null)).toEqual([]);
  });
});

describe("summaryIsEmpty (honest-empty rule)", () => {
  it("is true only for a loaded summary with zero total", () => {
    expect(summaryIsEmpty(summary({ total: 0 }))).toBe(true);
  });

  it("is false for non-zero totals", () => {
    expect(summaryIsEmpty(summary({ total: 1 }))).toBe(false);
  });

  it("is false when the summary never loaded — errors are not empties", () => {
    expect(summaryIsEmpty(null)).toBe(false);
  });
});

describe("campaignDisplayName / shortId", () => {
  it("resolves names from the loaded campaign rows", () => {
    expect(
      campaignDisplayName(CAMPAIGNS, "11111111-aaaa-bbbb-cccc-000000000001"),
    ).toBe("Spring launch");
  });

  it("matches numeric ids via string comparison", () => {
    expect(campaignDisplayName(CAMPAIGNS, "42")).toBe("Numeric-id campaign");
  });

  it("falls back to subject, then shortened id — never a fake name", () => {
    expect(
      campaignDisplayName(CAMPAIGNS, "33333333-aaaa-bbbb-cccc-000000000003"),
    ).toBe("33333333…");
    expect(
      campaignDisplayName(CAMPAIGNS, "99999999-dddd-eeee-ffff-000000000009"),
    ).toBe("99999999…");
    expect(campaignDisplayName(null, "abc")).toBe("abc");
  });

  it("shortId passes short ids through and ellipsizes long ones", () => {
    expect(shortId("abc")).toBe("abc");
    expect(shortId("12345678")).toBe("12345678");
    expect(shortId("123456789")).toBe("12345678…");
  });
});

describe("fmtReplyRate", () => {
  it("renders the 0..1 fraction as a one-decimal percent", () => {
    expect(fmtReplyRate(0.125)).toBe("12.5%");
    expect(fmtReplyRate(0)).toBe("0.0%");
    expect(fmtReplyRate(1)).toBe("100.0%");
  });

  it("dashes out missing / non-finite values", () => {
    expect(fmtReplyRate(null)).toBe("—");
    expect(fmtReplyRate(undefined)).toBe("—");
    expect(fmtReplyRate(Number.NaN)).toBe("—");
  });
});

describe("buildTopCampaignRows", () => {
  it("sorts by replies desc, resolves names, computes share of total", () => {
    const rows = buildTopCampaignRows(
      summary({
        total: 10,
        top_campaigns: [
          { campaign_id: "42", replies: 3 },
          {
            campaign_id: "11111111-aaaa-bbbb-cccc-000000000001",
            replies: 7,
          },
        ],
      }),
      CAMPAIGNS,
    );
    expect(rows.map((r) => r.name)).toEqual([
      "Spring launch",
      "Numeric-id campaign",
    ]);
    expect(rows[0]).toMatchObject({ replies: 7, share: 0.7 });
    expect(rows[1]).toMatchObject({ replies: 3, share: 0.3 });
  });

  it("returns [] for a missing summary and guards zero totals", () => {
    expect(buildTopCampaignRows(null, CAMPAIGNS)).toEqual([]);
    const rows = buildTopCampaignRows(
      summary({ total: 0, top_campaigns: [{ campaign_id: "42", replies: 0 }] }),
      CAMPAIGNS,
    );
    expect(rows[0]!.share).toBe(0);
  });

  it("does not mutate the summary's top_campaigns order", () => {
    const tc = [
      { campaign_id: "a", replies: 1 },
      { campaign_id: "b", replies: 9 },
    ];
    buildTopCampaignRows(summary({ top_campaigns: tc }), []);
    expect(tc.map((t) => t.campaign_id)).toEqual(["a", "b"]);
  });
});
