import { describe, expect, it } from "vitest";

import {
  attributedCents,
  attributedShare,
  centsToMajor,
  excludedCurrencies,
  heuristicShare,
  isTruncated,
  mixedCurrency,
  parseRevenueAttribution,
  provenanceRows,
} from "./revenueAttribution";

const BODY = {
  items: [
    {
      campaign_id: "c1",
      campaign_name: "July launch",
      conversions: 12,
      revenue_cents: 240_000,
      emails_sent: 4_000,
      revenue_per_send_cents: 60,
    },
    {
      campaign_id: "c2",
      campaign_name: "Weekly digest",
      conversions: 3,
      revenue_cents: 30_000,
      emails_sent: 9_000,
    },
  ],
  provenance: { explicit: 9, last_touch: 6, none: 4, unclassified: 1 },
  total_revenue_cents: 400_000,
  unattributed_cents: 130_000,
  unattributed_conversions: 4,
  currency: "usd",
  currencies: [
    { currency: "usd", conversions: 15, revenue_cents: 400_000 },
    { currency: "eur", conversions: 2, revenue_cents: 51_000 },
  ],
  total_campaigns: 34,
  days: 90,
};

describe("parseRevenueAttribution", () => {
  it("reads the verified handler shape", () => {
    const report = parseRevenueAttribution(BODY);
    expect(report.items).toHaveLength(2);
    expect(report.items[0]).toEqual({
      id: "c1",
      name: "July launch",
      conversions: 12,
      revenueCents: 240_000,
      emailsSent: 4_000,
      revenuePerSendCents: 60,
    });
    // `revenue_per_send_cents` is `omitempty` on the wire: absent means "no
    // honest denominator", which must stay null rather than becoming 0.
    expect(report.items[1]?.revenuePerSendCents).toBeNull();
    expect(report.provenance.total).toBe(20);
    expect(report.currency).toBe("usd");
    expect(report.totalCampaigns).toBe(34);
  });

  it("survives a body that is not the shape we expect", () => {
    for (const raw of [null, undefined, 7, "nope", [], {}]) {
      const report = parseRevenueAttribution(raw);
      expect(report.items).toEqual([]);
      expect(report.provenance.total).toBe(0);
      expect(report.currency).toBeNull();
    }
  });

  it("drops a row with no campaign identity rather than labelling it blank", () => {
    const report = parseRevenueAttribution({
      items: [{ campaign_name: "orphan", revenue_cents: 100 }, ...BODY.items],
    });
    expect(report.items.map((row) => row.id)).toEqual(["c1", "c2"]);
  });

  it("names an id-bearing row the server sent without a name", () => {
    const report = parseRevenueAttribution({
      items: [{ campaign_id: "c9", revenue_cents: 100 }],
    });
    expect(report.items[0]?.name).toBe("Untitled campaign");
  });
});

describe("attributed vs total", () => {
  it("never prints total revenue as if email earned it", () => {
    const report = parseRevenueAttribution(BODY);
    expect(attributedCents(report)).toBe(270_000);
    expect(attributedShare(report)).toBeCloseTo(0.675, 5);
    expect(centsToMajor(attributedCents(report))).toBe(2_700);
  });

  it("floors at zero rather than reporting negative revenue", () => {
    const report = parseRevenueAttribution({
      total_revenue_cents: 100,
      unattributed_cents: 900,
    });
    expect(attributedCents(report)).toBe(0);
  });

  it("has no share to report when the window held no money", () => {
    expect(attributedShare(parseRevenueAttribution({}))).toBeNull();
  });
});

describe("provenance", () => {
  it("apportions every bucket and ranks the largest first", () => {
    const rows = provenanceRows(parseRevenueAttribution(BODY).provenance);
    expect(rows.map((row) => row.key)).toEqual([
      "explicit",
      "lastTouch",
      "none",
      "unclassified",
    ]);
    expect(rows[0]?.share).toBeCloseTo(9 / 20, 5);
    expect(rows.reduce((sum, row) => sum + row.share, 0)).toBeCloseTo(1, 5);
  });

  it("drops empty buckets instead of printing four zeroes", () => {
    const rows = provenanceRows(
      parseRevenueAttribution({ provenance: { explicit: 5 } }).provenance,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toBe("explicit");
  });

  it("sizes the caveat by how much of the window is a heuristic", () => {
    const report = parseRevenueAttribution(BODY);
    expect(heuristicShare(report.provenance)).toBeCloseTo(6 / 20, 5);
    expect(heuristicShare(parseRevenueAttribution({}).provenance)).toBeNull();
  });
});

describe("currency disclosure", () => {
  it("flags money the dominant-currency sums leave out", () => {
    const report = parseRevenueAttribution(BODY);
    expect(mixedCurrency(report)).toBe(true);
    expect(excludedCurrencies(report).map((entry) => entry.currency)).toEqual([
      "eur",
    ]);
  });

  it("is silent for a single-currency workspace", () => {
    const report = parseRevenueAttribution({
      currency: "usd",
      currencies: [{ currency: "usd", conversions: 3, revenue_cents: 900 }],
    });
    expect(mixedCurrency(report)).toBe(false);
    expect(excludedCurrencies(report)).toEqual([]);
  });
});

describe("truncation", () => {
  it("knows the list is a slice of a larger set", () => {
    expect(isTruncated(parseRevenueAttribution(BODY))).toBe(true);
    expect(
      isTruncated(
        parseRevenueAttribution({ items: BODY.items, total_campaigns: 2 }),
      ),
    ).toBe(false);
  });
});
