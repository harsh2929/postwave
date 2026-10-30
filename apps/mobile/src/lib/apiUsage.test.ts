import { describe, expect, it } from "vitest";

import {
  aggregateRowLabel,
  aggregateTotals,
  fmtCentsAsDollars,
  mergeLedgerRows,
  normalizeApiUsageKeys,
  normalizeApiUsagePoints,
  normalizeApiUsageSummary,
  normalizeCostAggregates,
  normalizeCostLedger,
  sinceParam,
  type CostLedgerEntry,
} from "@/lib/apiUsage";

describe("fmtCentsAsDollars", () => {
  it("formats cents as dollars, keeping sign, never $NaN", () => {
    expect(fmtCentsAsDollars(1234)).toBe("$12.34");
    expect(fmtCentsAsDollars(-50)).toBe("-$0.50");
    expect(fmtCentsAsDollars(0)).toBe("$0.00");
    expect(fmtCentsAsDollars(Number.NaN)).toBe("$0.00");
    expect(fmtCentsAsDollars("junk")).toBe("$0.00");
  });
});

describe("sinceParam", () => {
  it("emits the <n>d suffix cost.ParseSince understands", () => {
    expect(sinceParam(30)).toBe("30d");
    expect(sinceParam(0)).toBe("1d");
    expect(sinceParam(89.6)).toBe("90d");
  });
});

describe("normalizeApiUsageSummary", () => {
  it("reads the snake_case wire shape", () => {
    const s = normalizeApiUsageSummary({
      window_days: 30,
      since: "2026-07-31T00:00:00Z",
      total_sends: 1200,
      total_cost_cents: 4550,
      active_keys: 3,
      avg_sends_per_day: 40,
      avg_cost_cents_per_day: 151.7,
      projected_30d_sends: 1200,
      projected_30d_cost_cents: 4550,
    });
    expect(s.windowDays).toBe(30);
    expect(s.totalCostCents).toBe(4550);
    expect(s.avgCostCentsPerDay).toBeCloseTo(151.7);
    expect(s.projected30dSends).toBe(1200);
  });

  it("degrades junk to zeros", () => {
    const s = normalizeApiUsageSummary(null);
    expect(s.totalSends).toBe(0);
    expect(s.activeKeys).toBe(0);
  });
});

describe("normalizeApiUsageKeys", () => {
  it("sorts cost desc, then sends desc, then label", () => {
    const rows = normalizeApiUsageKeys({
      keys: [
        { id: "a", label: "alpha", prefix: "pk_a", actor_type: "user", sends: 5, cost_cents: 10 },
        { id: "b", label: "beta", prefix: "pk_b", actor_type: "agent", sends: 9, cost_cents: 90 },
        { id: "c", label: "gamma", prefix: "pk_c", actor_type: "user", sends: 20, cost_cents: 10 },
      ],
    });
    expect(rows.map((r) => r.id)).toEqual(["b", "c", "a"]);
    expect(rows[0]?.actorType).toBe("agent");
  });

  it("drops idless rows and survives junk", () => {
    expect(normalizeApiUsageKeys(null)).toEqual([]);
    expect(normalizeApiUsageKeys({ keys: [{ label: "x" }] })).toEqual([]);
  });
});

describe("normalizeApiUsagePoints", () => {
  it("keeps server order and both metrics", () => {
    const pts = normalizeApiUsagePoints({
      points: [
        { date: "2026-08-01", sends: 3, cost_cents: 12 },
        { date: "2026-08-02", sends: 0, cost_cents: 0 },
      ],
    });
    expect(pts).toHaveLength(2);
    expect(pts[0]).toEqual({ date: "2026-08-01", sends: 3, costCents: 12 });
  });
});

describe("normalizeCostAggregates", () => {
  const wire = {
    rows: [
      { kind: "email_send", cents: 100, quantity: 50, count: 2 },
      { kind: "sms_send", cents: 900, quantity: 30, count: 1 },
      { kind: "", cents: 100, quantity: 1, count: 1 },
    ],
  };

  it("reads the camelCase wire and sorts cents desc for kind", () => {
    const rows = normalizeCostAggregates(wire, "kind");
    expect(rows[0]?.kind).toBe("sms_send");
    // Equal cents tie-break: "(unknown)" vs "email_send" alphabetical.
    expect(rows.map((r) => aggregateRowLabel(r, "kind"))).toEqual([
      "sms_send",
      "(unknown)",
      "email_send",
    ]);
  });

  it("sorts day groupings newest first", () => {
    const rows = normalizeCostAggregates(
      {
        rows: [
          { day: "2026-08-01", cents: 5, quantity: 1, count: 1 },
          { day: "2026-08-03", cents: 1, quantity: 1, count: 1 },
        ],
      },
      "day",
    );
    expect(rows.map((r) => r.day)).toEqual(["2026-08-03", "2026-08-01"]);
  });

  it("labels blank api_key_id rows as (no key)", () => {
    const row = normalizeCostAggregates(
      { rows: [{ apiKeyId: "", cents: 1, quantity: 1, count: 1 }] },
      "api_key_id",
    )[0];
    expect(row && aggregateRowLabel(row, "api_key_id")).toBe("(no key)");
  });

  it("totals sum the three columns", () => {
    expect(aggregateTotals(normalizeCostAggregates(wire, "kind"))).toEqual({
      cents: 1100,
      quantity: 81,
      count: 4,
    });
  });
});

describe("normalizeCostLedger + mergeLedgerRows", () => {
  it("reads a page and its string nextCursor", () => {
    const page = normalizeCostLedger({
      rows: [
        { id: 7, apiKeyId: "k1", kind: "email_send", cents: 2, quantity: 1, at: "2026-08-29T10:00:00Z" },
      ],
      nextCursor: "7",
    });
    expect(page.rows).toHaveLength(1);
    expect(page.nextCursor).toBe("7");
  });

  it("an absent nextCursor means end-of-list, not an error", () => {
    expect(normalizeCostLedger({ rows: [] }).nextCursor).toBeNull();
  });

  it("merging de-dupes the keyset boundary row on id", () => {
    const a: CostLedgerEntry[] = [
      { id: 1, apiKeyId: "", kind: "x", cents: 1, quantity: 1, at: "" },
      { id: 2, apiKeyId: "", kind: "x", cents: 1, quantity: 1, at: "" },
    ];
    const b: CostLedgerEntry[] = [
      { id: 2, apiKeyId: "", kind: "x", cents: 1, quantity: 1, at: "" },
      { id: 3, apiKeyId: "", kind: "x", cents: 1, quantity: 1, at: "" },
    ];
    expect(mergeLedgerRows(a, b).map((r) => r.id)).toEqual([1, 2, 3]);
  });
});
