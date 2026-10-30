/**
 * The sentences and the page arithmetic behind the API usage & cost section.
 *
 * Every expectation here is a literal — never derived by calling the code
 * under test — so a broken sentence cannot certify itself.
 */
import { describe, expect, it } from "vitest";

import type {
  ApiUsageKeyRow,
  ApiUsagePoint,
  ApiUsageSummary,
  CostAggregateRow,
  CostLedgerEntry,
} from "./apiUsage";
import {
  ADMIN_ONLY_USAGE_NOTE,
  API_USAGE_WINDOW_OPTIONS,
  apiUsageAccess,
  COST_GROUP_OPTIONS,
  costRowSpoken,
  costSeriesDollars,
  costTotalsEmptyCopy,
  costTotalsSpoken,
  keyRowMeta,
  keyRowSpoken,
  keyRowTitle,
  LEDGER_INITIAL,
  ledgerEmptyCopy,
  ledgerLine,
  ledgerReducer,
  ledgerRetry,
  ledgerSubtitle,
  METERED_COST_UNRECORDED,
  moreKeysCopy,
  parseApiUsageWindow,
  sendsSeries,
  seriesHasCost,
  seriesLabels,
  summaryStats,
  topKeys,
  usageEmptyCopy,
  usageWindowIsEmpty,
} from "./apiUsageDashboard";

function summary(over: Partial<ApiUsageSummary> = {}): ApiUsageSummary {
  return {
    windowDays: 30,
    totalSends: 12_450,
    totalCostCents: 1_245,
    activeKeys: 3,
    avgSendsPerDay: 415,
    avgCostCentsPerDay: 41.5,
    projected30dSends: 12_450,
    projected30dCostCents: 1_245,
    ...over,
  };
}

function entry(id: number, over: Partial<CostLedgerEntry> = {}): CostLedgerEntry {
  return {
    id,
    apiKeyId: "k1",
    kind: "send",
    cents: 2,
    quantity: 1,
    at: "2026-08-29T10:00:00Z",
    ...over,
  };
}

describe("window + access", () => {
  it("offers desktop's three windows and parses only those", () => {
    expect(API_USAGE_WINDOW_OPTIONS.map((o) => o.value)).toEqual(["7", "30", "90"]);
    expect(API_USAGE_WINDOW_OPTIONS.map((o) => o.label)).toEqual(["7d", "30d", "90d"]);
    expect(parseApiUsageWindow("7")).toBe(7);
    expect(parseApiUsageWindow("90")).toBe(90);
    expect(parseApiUsageWindow("365")).toBe(30);
    expect(parseApiUsageWindow("junk")).toBe(30);
  });

  it("splits the section on the manifest's two floors: usage admin, costs viewer", () => {
    expect(apiUsageAccess("admin")).toEqual({ usage: true, costs: true });
    expect(apiUsageAccess("owner")).toEqual({ usage: true, costs: true });
    expect(apiUsageAccess("editor")).toEqual({ usage: false, costs: true });
    expect(apiUsageAccess("viewer")).toEqual({ usage: false, costs: true });
    expect(apiUsageAccess(undefined)).toEqual({ usage: false, costs: false });
  });

  it("an API key session gets the viewer half only", () => {
    expect(apiUsageAccess("admin", "api_key")).toEqual({ usage: false, costs: true });
  });

  it("the viewer note names the role, not a 403", () => {
    expect(ADMIN_ONLY_USAGE_NOTE).toMatch(/workspace admins/u);
    expect(ADMIN_ONLY_USAGE_NOTE).not.toMatch(/403|denied/u);
  });
});

describe("usageWindowIsEmpty", () => {
  it("is empty for null inputs and for all-zero data", () => {
    expect(usageWindowIsEmpty(null, null)).toBe(true);
    expect(usageWindowIsEmpty(undefined, [])).toBe(true);
    expect(
      usageWindowIsEmpty(
        summary({ totalSends: 0, totalCostCents: 0, activeKeys: 4 }),
        [{ date: "2026-08-30", sends: 0, costCents: 0 }],
      ),
    ).toBe(true);
  });

  it("is not empty once a send or a cent exists anywhere", () => {
    expect(usageWindowIsEmpty(summary({ totalSends: 1, totalCostCents: 0 }), [])).toBe(false);
    expect(usageWindowIsEmpty(summary({ totalSends: 0, totalCostCents: 1 }), [])).toBe(false);
    expect(
      usageWindowIsEmpty(summary({ totalSends: 0, totalCostCents: 0 }), [
        { date: "2026-08-30", sends: 3, costCents: 0 },
      ]),
    ).toBe(false);
  });

  it("names the window in the empty copy", () => {
    expect(usageEmptyCopy(7)).toBe("No API usage recorded in the last 7 days.");
  });
});

describe("summaryStats", () => {
  it("renders the five desktop tiles with cents as dollars and estimates labelled", () => {
    const stats = summaryStats(summary());
    expect(stats.map((s) => s.key)).toEqual([
      "sends",
      "cost",
      "active_keys",
      "projected_sends",
      "projected_cost",
    ]);
    expect(stats[0]).toMatchObject({ label: "Sends (30d)", value: "12,450", hint: "415/day average" });
    expect(stats[1]).toMatchObject({ label: "Metered cost (30d)", value: "$12.45", hint: "$0.42/day average" });
    expect(stats[2]).toMatchObject({ label: "Active keys", value: "3", hint: null });
    expect(stats[3]).toMatchObject({ label: "Projected sends (30d)", value: "12,450" });
    expect(stats[3]?.hint).toMatch(/estimate/u);
    expect(stats[4]).toMatchObject({ label: "Projected cost (30d)", value: "$12.45" });
    expect(stats[4]?.hint).toMatch(/estimate/u);
  });

  it("speaks one sentence per tile", () => {
    const stats = summaryStats(summary());
    expect(stats[0]?.spoken).toBe("Sends (30d): 12,450, 415/day average.");
    expect(stats[2]?.spoken).toBe("Active keys: 3.");
  });

  it("with sends but no metered cost, says no cost was RECORDED and drops the projected-cost tile", () => {
    // The unconfigured-metering case: the ledger has cents=0 for every entry.
    // "$0.00/day average" and a projected "$0.00" would both present a
    // manufactured zero bill.
    const stats = summaryStats(
      summary({ totalCostCents: 0, avgCostCentsPerDay: 0, projected30dCostCents: 0 }),
    );
    expect(stats.find((s) => s.key === "cost")).toMatchObject({
      value: "$0.00",
      hint: METERED_COST_UNRECORDED,
    });
    expect(stats.find((s) => s.key === "projected_cost")).toBeUndefined();
    // One full stop, supplied by the sentence builder — never two. The
    // constant once carried its own period and VoiceOver read "sends..".
    expect(stats.find((s) => s.key === "cost")?.spoken).toBe(
      "Metered cost (30d): $0.00, No metered cost recorded for these sends.",
    );
  });

  it("never uses the words billed or charged", () => {
    const text = [
      ...summaryStats(summary()),
      ...summaryStats(summary({ totalCostCents: 0 })),
    ]
      .flatMap((s) => [s.label, s.value, s.hint ?? "", s.spoken])
      .join(" ");
    expect(text).not.toMatch(/bill|charg/iu);
  });
});

describe("timeseries helpers", () => {
  const points: ApiUsagePoint[] = [
    { date: "2026-08-30T00:00:00Z", sends: 400, costCents: 41 },
    { date: "2026-08-31T00:00:00Z", sends: 500, costCents: 0 },
  ];

  it("survive null and empty", () => {
    expect(sendsSeries(null)).toEqual([]);
    expect(costSeriesDollars(undefined)).toEqual([]);
    expect(seriesLabels(null)).toEqual([]);
    expect(seriesHasCost(null)).toBe(false);
  });

  it("split sends and cost, cost in dollars", () => {
    expect(sendsSeries(points)).toEqual([400, 500]);
    expect(costSeriesDollars(points)).toEqual([0.41, 0]);
    expect(seriesLabels(points)).toHaveLength(2);
    expect(seriesHasCost(points)).toBe(true);
    expect(seriesHasCost([{ date: "2026-08-30", sends: 9, costCents: 0 }])).toBe(false);
  });
});

describe("per-key rows", () => {
  const rows: ApiUsageKeyRow[] = Array.from({ length: 7 }, (_, i) => ({
    id: `k${i}`,
    label: i === 1 ? "" : `Key ${i}`,
    prefix: i === 2 ? "" : `pw_${i}`,
    actorType: i === 3 ? "" : "agent",
    sends: 100 - i,
    costCents: 10 - i,
  }));

  it("shows the top five and says how many were left out", () => {
    expect(topKeys(rows).map((r) => r.id)).toEqual(["k0", "k1", "k2", "k3", "k4"]);
    expect(topKeys(null)).toEqual([]);
    expect(moreKeysCopy(7, 5)).toBe("Showing the top 5 of 7 keys by metered cost.");
    expect(moreKeysCopy(5, 5)).toBeNull();
  });

  it("names an unlabeled key and drops blank meta parts", () => {
    expect(keyRowTitle(rows[1]!)).toBe("(unlabeled)");
    expect(keyRowMeta(rows[0]!)).toBe("pw_0… · agent");
    expect(keyRowMeta(rows[2]!)).toBe("agent");
    expect(keyRowMeta(rows[3]!)).toBe("pw_3…");
  });

  it("speaks the whole row as one sentence", () => {
    expect(keyRowSpoken(rows[0]!)).toBe(
      "Key 0 (pw_0…), agent: 100 sends, $0.10 metered cost.",
    );
    expect(keyRowSpoken(rows[3]!)).toBe(
      "Key 3 (pw_3…), unknown actor: 97 sends, $0.07 metered cost.",
    );
  });
});

describe("cost totals", () => {
  const row: CostAggregateRow = {
    apiKeyId: "",
    actorType: "",
    kind: "send",
    day: "",
    cents: 1_200,
    quantity: 12_000,
    count: 12,
  };

  it("offers desktop's three group-bys", () => {
    expect(COST_GROUP_OPTIONS.map((o) => o.value)).toEqual(["kind", "api_key_id", "day"]);
  });

  it("speaks a row and the footer with cents as dollars", () => {
    expect(costRowSpoken(row, "kind")).toBe("send: 12 entries, quantity 12,000, $12.00.");
    expect(costRowSpoken(row, "api_key_id")).toBe(
      "(no key): 12 entries, quantity 12,000, $12.00.",
    );
    expect(costTotalsSpoken([row, { ...row, cents: 45, quantity: 3, count: 3 }])).toBe(
      "Total: 15 entries, quantity 12,003, $12.45.",
    );
    expect(costTotalsSpoken([])).toBe("Total: 0 entries, quantity 0, $0.00.");
  });

  it("names the window in the empty copy", () => {
    expect(costTotalsEmptyCopy(90)).toBe("No metered cost in the last 90 days.");
  });
});

describe("ledger lines", () => {
  it("formats a row and speaks it", () => {
    const line = ledgerLine(entry(7, { cents: 250, quantity: 3 }));
    expect(line.id).toBe(7);
    expect(line.kind).toBe("send");
    expect(line.key).toBe("k1");
    expect(line.quantity).toBe("3");
    expect(line.cost).toBe("$2.50");
    expect(line.when).not.toBe("—");
    expect(line.spoken).toMatch(/^send on .+, key k1: quantity 3, \$2\.50\.$/u);
  });

  it("uses em-dashes for blanks, never empty strings", () => {
    const line = ledgerLine(entry(1, { apiKeyId: "", kind: "", at: "" }));
    expect(line.when).toBe("—");
    expect(line.kind).toBe("—");
    expect(line.key).toBe("—");
    expect(line.spoken).toBe("— on —: quantity 1, $0.02.");
  });

  it("names the window in the empty copy and the subtitle", () => {
    expect(ledgerEmptyCopy(7)).toBe("No ledger entries in the last 7 days.");
    expect(ledgerSubtitle(30)).toBe(
      "Itemized metering entries, last 30 days. Cost figures come from the metering ledger.",
    );
  });
});

describe("ledgerReducer", () => {
  const page1 = { rows: [entry(1), entry(2), entry(3)], nextCursor: "3" };
  const page2 = { rows: [entry(3), entry(4)], nextCursor: null };

  it("starts empty and not yet asked", () => {
    expect(LEDGER_INITIAL).toEqual({
      rows: [],
      cursor: null,
      hasMore: false,
      loading: false,
      loadedOnce: false,
      error: null,
    });
  });

  it("load clears the previous error and marks loading", () => {
    const failed = ledgerReducer(LEDGER_INITIAL, {
      type: "failed",
      error: { message: "boom", retryable: true },
    });
    expect(failed.error).toEqual({ message: "boom", retryable: true });
    expect(failed.loading).toBe(false);
    const loading = ledgerReducer(failed, { type: "load" });
    expect(loading.loading).toBe(true);
    expect(loading.error).toBeNull();
  });

  it("a first page replaces, exposes its cursor, and reports more", () => {
    const s = ledgerReducer(ledgerReducer(LEDGER_INITIAL, { type: "load" }), {
      type: "loaded",
      page: page1,
      append: false,
    });
    expect(s.rows.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(s.cursor).toBe("3");
    expect(s.hasMore).toBe(true);
    expect(s.loading).toBe(false);
    expect(s.loadedOnce).toBe(true);
  });

  it("an appended page de-dupes the keyset boundary row and ends the list", () => {
    const first = ledgerReducer(LEDGER_INITIAL, { type: "loaded", page: page1, append: false });
    const s = ledgerReducer(first, { type: "loaded", page: page2, append: true });
    expect(s.rows.map((r) => r.id)).toEqual([1, 2, 3, 4]);
    expect(s.cursor).toBeNull();
    expect(s.hasMore).toBe(false);
  });

  it("a failed load-more keeps the rows already on screen", () => {
    const first = ledgerReducer(LEDGER_INITIAL, { type: "loaded", page: page1, append: false });
    const s = ledgerReducer(ledgerReducer(first, { type: "load" }), {
      type: "failed",
      error: { message: "boom", retryable: true },
    });
    expect(s.rows).toHaveLength(3);
    expect(s.error?.message).toBe("boom");
    expect(s.hasMore).toBe(true);
  });

  it("an empty first page is loadedOnce with no rows — the honest empty state", () => {
    const s = ledgerReducer(LEDGER_INITIAL, {
      type: "loaded",
      page: { rows: [], nextCursor: null },
      append: false,
    });
    expect(s.rows).toEqual([]);
    expect(s.loadedOnce).toBe(true);
    expect(s.hasMore).toBe(false);
  });

  it("reset returns to the initial state", () => {
    const first = ledgerReducer(LEDGER_INITIAL, { type: "loaded", page: page1, append: false });
    expect(ledgerReducer(first, { type: "reset" })).toBe(LEDGER_INITIAL);
  });
});

describe("ledgerRetry", () => {
  it("retries page one when nothing loaded", () => {
    expect(ledgerRetry(LEDGER_INITIAL)).toEqual({ cursor: null, append: false });
  });

  it("retries the FAILED page — from the last good cursor, appending — when rows exist", () => {
    const first = ledgerReducer(LEDGER_INITIAL, {
      type: "loaded",
      page: { rows: [entry(1)], nextCursor: "1" },
      append: false,
    });
    const failed = ledgerReducer(first, {
      type: "failed",
      error: { message: "boom", retryable: true },
    });
    expect(ledgerRetry(failed)).toEqual({ cursor: "1", append: true });
  });
});
