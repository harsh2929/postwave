// Usage section helpers (full-surface wiring #54 + #55): cents must
// always render as dollars, the cost chart converts units before
// plotting, and the cursor-paged ledger merge never duplicates rows.

import { describe, expect, it } from "vitest";

import type {
  APIUsageKeyRow,
  APIUsageSummary,
  CostAggregateRow,
  CostLedgerEntry,
} from "../../lib/api-client";
import {
  COST_GROUP_BYS,
  aggregateRowLabel,
  aggregateTotals,
  costLinePoints,
  fmtCentsAsDollars,
  fmtCount,
  mergeLedgerRows,
  sendsLinePoints,
  sinceParam,
  sortAggregateRows,
  sortKeyRows,
  summaryStats,
} from "../../components/settings/usage-helpers";

describe("fmtCentsAsDollars", () => {
  it("converts cents to a $ amount with two decimals", () => {
    expect(fmtCentsAsDollars(0)).toBe("$0.00");
    expect(fmtCentsAsDollars(1)).toBe("$0.01");
    expect(fmtCentsAsDollars(1234)).toBe("$12.34");
    expect(fmtCentsAsDollars(100000)).toBe("$1000.00");
  });

  it("keeps the sign for negative adjustments", () => {
    expect(fmtCentsAsDollars(-250)).toBe("-$2.50");
  });

  it("renders a missing/NaN cents value as $0.00, never $NaN", () => {
    expect(fmtCentsAsDollars(undefined)).toBe("$0.00");
    expect(fmtCentsAsDollars(null)).toBe("$0.00");
    expect(fmtCentsAsDollars(Number.NaN)).toBe("$0.00");
  });
});

describe("summaryStats", () => {
  const summary: APIUsageSummary = {
    window_days: 30,
    since: "2026-05-12T00:00:00Z",
    total_sends: 12000,
    total_cost_cents: 4567,
    active_keys: 3,
    avg_sends_per_day: 400,
    avg_cost_cents_per_day: 152,
    projected_30d_sends: 12000,
    projected_30d_cost_cents: 4560,
  };

  it("renders cost fields as dollars, never raw cents", () => {
    const stats = summaryStats(summary);
    const cost = stats.find((s) => s.key === "cost");
    const projected = stats.find((s) => s.key === "projected_cost");
    expect(cost?.value).toBe("$45.67");
    expect(cost?.hint).toContain("$1.52/day");
    expect(projected?.value).toBe("$45.60");
    // No stat should leak the cents integer verbatim.
    for (const s of stats) {
      expect(s.value).not.toBe("4567");
    }
  });

  it("includes the window in the sends/cost labels", () => {
    const stats = summaryStats(summary);
    expect(stats.find((s) => s.key === "sends")?.label).toBe("Sends (30d)");
    expect(stats.find((s) => s.key === "active_keys")?.value).toBe("3");
  });
});

describe("timeseries mapping", () => {
  const points = [
    { date: "2026-06-01", sends: 10, cost_cents: 150 },
    { date: "2026-06-02", sends: 0, cost_cents: 0 },
  ];

  it("maps sends 1:1", () => {
    expect(sendsLinePoints(points)).toEqual([
      { date: "2026-06-01", count: 10 },
      { date: "2026-06-02", count: 0 },
    ]);
  });

  it("converts the cost series to dollars", () => {
    expect(costLinePoints(points)).toEqual([
      { date: "2026-06-01", count: 1.5 },
      { date: "2026-06-02", count: 0 },
    ]);
  });

  it("coerces missing/NaN value fields to 0 so the chart never plots NaN", () => {
    // A populated-data point can omit its value field; the chart must
    // receive a finite number, never undefined → NaN coords.
    const partial = [
      { date: "2026-06-03" } as unknown as (typeof points)[number],
      { date: "2026-06-04", sends: Number.NaN, cost_cents: Number.NaN },
    ];
    for (const pt of sendsLinePoints(partial)) {
      expect(Number.isFinite(pt.count)).toBe(true);
    }
    for (const pt of costLinePoints(partial)) {
      expect(Number.isFinite(pt.count)).toBe(true);
    }
    expect(sendsLinePoints(partial).map((p) => p.count)).toEqual([0, 0]);
    expect(costLinePoints(partial).map((p) => p.count)).toEqual([0, 0]);
  });
});

describe("sortKeyRows", () => {
  const row = (
    id: string,
    cost: number,
    sends: number,
    label = id,
  ): APIUsageKeyRow => ({
    id,
    label,
    prefix: "pw_x",
    actor_type: "api_key",
    sends,
    cost_cents: cost,
  });

  it("orders by cost desc, then sends desc, then label", () => {
    const sorted = sortKeyRows([
      row("a", 100, 5, "zz-key"),
      row("b", 300, 1),
      row("c", 100, 9),
      row("d", 100, 5, "aa-key"),
    ]);
    expect(sorted.map((r) => r.id)).toEqual(["b", "c", "d", "a"]);
  });

  it("does not mutate the input", () => {
    const input = [row("a", 1, 1), row("b", 2, 2)];
    sortKeyRows(input);
    expect(input.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("sorts rows with missing label/cost/sends without crashing", () => {
    // A populated-data row can omit `label` (and even the numeric
    // fields) — the sort must not blow up on
    // `undefined.localeCompare` / NaN comparisons.
    const partial = [
      { id: "x", prefix: "pw_x", actor_type: "api_key" },
      { id: "y", label: "alpha", prefix: "pw_y", actor_type: "api_key", cost_cents: 10, sends: 1 },
      { id: "z", label: "beta", prefix: "pw_z", actor_type: "api_key", cost_cents: 10, sends: 1 },
    ] as unknown as APIUsageKeyRow[];
    expect(() => sortKeyRows(partial)).not.toThrow();
    // Highest cost (y/z) first; the label-less row falls last.
    expect(sortKeyRows(partial).map((r) => r.id)).toEqual(["y", "z", "x"]);
  });
});

describe("mergeLedgerRows", () => {
  const entry = (id: number): CostLedgerEntry => ({
    id,
    tenantId: "t1",
    kind: "send",
    cents: 1,
    quantity: 1,
    at: "2026-06-01T00:00:00Z",
    metadata: {},
  });

  it("appends new pages and dedupes the keyset boundary row", () => {
    const merged = mergeLedgerRows(
      [entry(1), entry(2)],
      [entry(2), entry(3)],
    );
    expect(merged.map((e) => e.id)).toEqual([1, 2, 3]);
  });

  it("handles the empty first page", () => {
    expect(mergeLedgerRows([], [entry(9)]).map((e) => e.id)).toEqual([9]);
  });
});

describe("sinceParam", () => {
  it("emits the <n>d form cost.ParseSince accepts", () => {
    expect(sinceParam(30)).toBe("30d");
    expect(sinceParam(7)).toBe("7d");
  });

  it("clamps nonsense to at least one day", () => {
    expect(sinceParam(0)).toBe("1d");
    expect(sinceParam(-5)).toBe("1d");
  });
});

describe("fmtCount", () => {
  it("groups thousands", () => {
    expect(fmtCount(12000)).toBe("12,000");
  });

  it("renders a missing/NaN count as 0, never NaN", () => {
    expect(fmtCount(undefined)).toBe("0");
    expect(fmtCount(null)).toBe("0");
    expect(fmtCount(Number.NaN)).toBe("0");
  });
});

/* ---------- #55 cost aggregate view (GET /costs?by=) ---------- */

describe("aggregateRowLabel", () => {
  const row = (partial: Partial<CostAggregateRow>): CostAggregateRow => ({
    cents: 100,
    quantity: 1,
    count: 1,
    ...partial,
  });

  it("reads the grouped camelCase field per dimension", () => {
    expect(aggregateRowLabel(row({ apiKeyId: "key_1" }), "api_key_id")).toBe(
      "key_1",
    );
    expect(aggregateRowLabel(row({ kind: "email_send" }), "kind")).toBe(
      "email_send",
    );
    expect(aggregateRowLabel(row({ day: "2026-06-10" }), "day")).toBe(
      "2026-06-10",
    );
  });

  it("labels null buckets honestly instead of blanking", () => {
    expect(aggregateRowLabel(row({ apiKeyId: null }), "api_key_id")).toBe(
      "(no key)",
    );
    expect(aggregateRowLabel(row({}), "kind")).toBe("(unknown)");
    expect(aggregateRowLabel(row({}), "day")).toBe("(unknown)");
  });
});

describe("sortAggregateRows", () => {
  const row = (partial: Partial<CostAggregateRow>): CostAggregateRow => ({
    cents: 0,
    quantity: 0,
    count: 0,
    ...partial,
  });

  it("orders cost-desc then label for non-day dimensions", () => {
    const rows = [
      row({ kind: "sms_send", cents: 50 }),
      row({ kind: "email_send", cents: 200 }),
      row({ kind: "ai_tokens", cents: 50 }),
    ];
    expect(sortAggregateRows(rows, "kind").map((r) => r.kind)).toEqual([
      "email_send",
      "ai_tokens",
      "sms_send",
    ]);
  });

  it("orders day buckets newest-first regardless of cost", () => {
    const rows = [
      row({ day: "2026-06-08", cents: 999 }),
      row({ day: "2026-06-10", cents: 1 }),
      row({ day: "2026-06-09", cents: 5 }),
    ];
    expect(sortAggregateRows(rows, "day").map((r) => r.day)).toEqual([
      "2026-06-10",
      "2026-06-09",
      "2026-06-08",
    ]);
  });

  it("does not mutate the input", () => {
    const rows = [row({ kind: "b", cents: 1 }), row({ kind: "a", cents: 2 })];
    sortAggregateRows(rows, "kind");
    expect(rows[0]!.kind).toBe("b");
  });
});

describe("aggregateTotals", () => {
  it("sums cents/quantity/count across buckets", () => {
    const totals = aggregateTotals([
      { cents: 150, quantity: 3, count: 2 },
      { cents: 50, quantity: 1, count: 1 },
    ]);
    expect(totals).toEqual({ cents: 200, quantity: 4, count: 3 });
  });

  it("zeroes on an empty window", () => {
    expect(aggregateTotals([])).toEqual({ cents: 0, quantity: 0, count: 0 });
  });

  it("treats missing numeric fields as 0 instead of summing to NaN", () => {
    const totals = aggregateTotals([
      { cents: 100 } as unknown as CostAggregateRow,
      { quantity: 2, count: 1 } as unknown as CostAggregateRow,
    ]);
    expect(totals).toEqual({ cents: 100, quantity: 2, count: 1 });
  });
});

describe("COST_GROUP_BYS", () => {
  it("offers exactly the dimensions the endpoint accepts", () => {
    expect(COST_GROUP_BYS.map((g) => g.key).sort()).toEqual([
      "api_key_id",
      "day",
      "kind",
    ]);
  });
});
