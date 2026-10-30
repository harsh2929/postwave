import { describe, expect, it } from "vitest";

import {
  parseConnectionRuns,
  runCounts,
  runCountsLine,
  runSpoken,
  runTone,
  type ConnectionRun,
} from "./connectionRuns";
import { num } from "./format";

/** integration_writeback/types.go Run, as the handler encodes it. */
const WRITEBACK_RUN = {
  id: "r1",
  tenant_id: "t",
  target_id: "wb1",
  run_mode: "manual",
  status: "partial",
  members_seen: 12,
  matched: 10,
  tags_written: 4,
  fields_written: 2,
  rows_failed: 1,
  error_message: "Shopify rejected 1 customer: email invalid",
  metadata: { batch: 3 },
  started_at: "2026-08-30T09:00:00Z",
  completed_at: "2026-08-30T09:00:04Z",
  created_at: "2026-08-30T09:00:00Z",
};

/** analytics_integrations/types.go SyncRun. */
const ANALYTICS_RUN = {
  id: "a1",
  run_mode: "backfill",
  status: "completed",
  cursor_from: "c0",
  cursor_to: "c1",
  profiles_seen: 300,
  profiles_upserted: 298,
  events_seen: 1200,
  events_tracked: 1200,
  rows_failed: 0,
  started_at: "2026-08-30T10:00:00Z",
  created_at: "2026-08-30T10:00:00Z",
};

function run(over: Partial<ConnectionRun> = {}): ConnectionRun {
  return {
    id: "x",
    status: "completed",
    runMode: "manual",
    startedAt: "2026-08-30T09:00:00Z",
    completedAt: "",
    rowsFailed: 0,
    errorMessage: "",
    counts: [],
    ...over,
  };
}

describe("parseConnectionRuns", () => {
  it("reads the {items} envelope every family's ListRuns writes", () => {
    const out = parseConnectionRuns({ items: [WRITEBACK_RUN] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "r1",
      status: "partial",
      runMode: "manual",
      startedAt: "2026-08-30T09:00:00Z",
      completedAt: "2026-08-30T09:00:04Z",
      rowsFailed: 1,
      errorMessage: "Shopify rejected 1 customer: email invalid",
    });
  });

  it("accepts a bare array too", () => {
    expect(parseConnectionRuns([ANALYTICS_RUN])).toHaveLength(1);
  });

  it("returns nothing for null, a null items array, and non-object entries", () => {
    expect(parseConnectionRuns(null)).toEqual([]);
    expect(parseConnectionRuns(undefined)).toEqual([]);
    expect(parseConnectionRuns({ items: null })).toEqual([]);
    expect(parseConnectionRuns({ items: "nope" })).toEqual([]);
    expect(parseConnectionRuns({ items: [null, 3, "x"] })).toEqual([]);
    expect(parseConnectionRuns("items")).toEqual([]);
  });

  it("drops a run with no id rather than render a duplicate-key ghost", () => {
    expect(
      parseConnectionRuns({ items: [{ ...WRITEBACK_RUN, id: "  " }] }),
    ).toEqual([]);
  });

  it("treats Go's omitted completed_at / error_message / rows_failed as empty, never as a claim", () => {
    const [only] = parseConnectionRuns({
      items: [{ id: "r2", status: "failed", started_at: "2026-08-30T09:00:00Z" }],
    });
    expect(only?.completedAt).toBe("");
    expect(only?.errorMessage).toBe("");
    expect(only?.rowsFailed).toBe(0);
    expect(only?.runMode).toBe("");
    expect(only?.counts).toEqual([]);
  });
});

describe("runCounts", () => {
  it("keeps write-back's counters in the server's order with the server's words", () => {
    expect(runCounts(WRITEBACK_RUN)).toEqual([
      { key: "members_seen", label: "members seen", value: 12 },
      { key: "matched", label: "matched", value: 10 },
      { key: "tags_written", label: "tags written", value: 4 },
      { key: "fields_written", label: "fields written", value: 2 },
    ]);
  });

  it("finds the analytics family's counters without a family-specific parser", () => {
    expect(runCounts(ANALYTICS_RUN).map((c) => c.key)).toEqual([
      "profiles_seen",
      "profiles_upserted",
      "events_seen",
      "events_tracked",
    ]);
  });

  it("finds lead / review / loyalty / subscription counters by suffix", () => {
    expect(
      runCounts({ submissions_seen: 1, subscribers_upserted: 1, events_tracked: 1 }).map((c) => c.key),
    ).toEqual(["submissions_seen", "subscribers_upserted", "events_tracked"]);
    expect(
      runCounts({ reviews_seen: 5, reviews_imported: 4, profiles_upserted: 3 }).map((c) => c.key),
    ).toEqual(["reviews_seen", "reviews_imported", "profiles_upserted"]);
    expect(runCounts({ members_seen: 2, members_upserted: 2 }).map((c) => c.key)).toEqual([
      "members_seen",
      "members_upserted",
    ]);
    expect(
      runCounts({ subscriptions_seen: 2, shipments_upserted: 1 }).map((c) => c.key),
    ).toEqual(["subscriptions_seen", "shipments_upserted"]);
  });

  it("never counts rows_failed, ids, cursors, timestamps, metadata or non-integers", () => {
    const keys = runCounts({
      ...WRITEBACK_RUN,
      rows_failed: 9,
      profiles_seen: 1.5,
      events_seen: "12",
      something_seen: null,
    }).map((c) => c.key);
    expect(keys).not.toContain("rows_failed");
    expect(keys).not.toContain("tenant_id");
    expect(keys).not.toContain("started_at");
    expect(keys).not.toContain("metadata");
    expect(keys).not.toContain("profiles_seen");
    expect(keys).not.toContain("events_seen");
    expect(keys).not.toContain("something_seen");
  });
});

describe("runTone", () => {
  it("maps the three statuses the runners write", () => {
    expect(runTone("completed")).toBe("success");
    expect(runTone("partial")).toBe("warning");
    expect(runTone("failed")).toBe("danger");
    expect(runTone(" FAILED ")).toBe("danger");
  });

  it("treats an in-flight run as neutral and anything unknown as a warning", () => {
    expect(runTone("running")).toBe("neutral");
    expect(runTone("queued")).toBe("neutral");
    // Unknown is not evidence of success.
    expect(runTone("")).toBe("warning");
    expect(runTone("banana")).toBe("warning");
  });
});

describe("runCountsLine", () => {
  it("joins the counters and appends the failed count only when it is non-zero", () => {
    const [wb] = parseConnectionRuns({ items: [WRITEBACK_RUN] });
    expect(runCountsLine(wb!)).toBe(
      "12 members seen · 10 matched · 4 tags written · 2 fields written · 1 failed",
    );
    const [an] = parseConnectionRuns({ items: [ANALYTICS_RUN] });
    expect(runCountsLine(an!)).not.toMatch(/failed/);
    expect(runCountsLine(an!)).toMatch(/^300 profiles seen · 298 profiles upserted/);
  });

  it("formats large counters the way the rest of the app does", () => {
    const line = runCountsLine(
      run({ counts: [{ key: "events_seen", label: "events seen", value: 12000 }] }),
    );
    expect(line).toBe(`${num(12000)} events seen`);
  });

  it("is empty — not '0' — when the row carried no counters", () => {
    expect(runCountsLine(run())).toBe("");
  });
});

describe("runSpoken", () => {
  it("speaks status, mode, the absolute start, the counters and the server's error verbatim", () => {
    const [wb] = parseConnectionRuns({ items: [WRITEBACK_RUN] });
    expect(runSpoken(wb!, "Aug 30, 2026, 9:00 AM")).toBe(
      "partial run, manual, started Aug 30, 2026, 9:00 AM. 12 members seen · 10 matched · 4 tags written · 2 fields written · 1 failed. Shopify rejected 1 customer: email invalid",
    );
  });

  it("names the unknowns instead of speaking blanks", () => {
    expect(runSpoken(run({ status: "", runMode: "" }), "—")).toBe(
      "unknown run, unknown mode, started —.",
    );
  });
});
