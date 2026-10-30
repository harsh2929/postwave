import { describe, expect, it } from "vitest";

import {
  definitionSummary,
  latestRunFor,
  parseDefinitions,
  parseRun,
  parseRuns,
  runOutcome,
  runToast,
  sortDefinitions,
  windowLabel,
} from "./savedReports";

const DEFS_ENVELOPE = {
  items: [
    {
      id: "def-1",
      name: "Weekly revenue",
      description: "Revenue by day",
      product_area: "commerce",
      status: "active",
      metrics: [{ key: "revenue" }, { key: "orders" }],
      dimensions: ["day"],
      time_range: { days: 7 },
      updated_at: "2026-07-20T00:00:00Z",
    },
    { id: "def-2", metrics: [], dimensions: [] },
  ],
  nextCursor: "abc",
};

describe("parseDefinitions", () => {
  it("reads the pagination Envelope's `items`", () => {
    const defs = parseDefinitions(DEFS_ENVELOPE);
    expect(defs.map((d) => d.id)).toEqual(["def-1", "def-2"]);
    expect(defs[0]?.metricCount).toBe(2);
    expect(defs[0]?.dimensions).toEqual(["day"]);
    expect(defs[0]?.window).toBe("last 7 days");
  });

  it("falls back to the id when a definition has no name", () => {
    expect(parseDefinitions(DEFS_ENVELOPE)[1]?.name).toBe("def-2");
  });

  it("drops rows without an id and survives a non-object payload", () => {
    expect(parseDefinitions({ items: [{ name: "x" }, null] })).toEqual([]);
    expect(parseDefinitions(null)).toEqual([]);
    expect(parseDefinitions("nope")).toEqual([]);
  });

  it("accepts a bare array as well as an envelope", () => {
    expect(parseDefinitions([{ id: "d", metrics: [] }])).toHaveLength(1);
  });
});

describe("windowLabel", () => {
  it("recognises the three shapes the builder writes, and only those", () => {
    expect(windowLabel({ preset: "last_30_days" })).toBe("last 30 days");
    expect(
      windowLabel({ start: "2026-01-01T00:00:00Z", end: "2026-02-01T00:00:00Z" }),
    ).toBe("2026-01-01 → 2026-02-01");
    expect(windowLabel({ days: 14 })).toBe("last 14 days");
  });

  it("returns empty rather than stringifying an unknown shape", () => {
    expect(windowLabel({ weird: true })).toBe("");
    expect(windowLabel(null)).toBe("");
    expect(windowLabel({ days: 0 })).toBe("");
  });
});

describe("parseRun / parseRuns", () => {
  it("keeps rows_total null when absent — never a fabricated zero", () => {
    expect(parseRun({ id: "r1", status: "completed" })?.rowsTotal).toBeNull();
    expect(
      parseRun({ id: "r1", status: "completed", rows_total: 0 })?.rowsTotal,
    ).toBe(0);
  });

  it("returns null for a row without an id", () => {
    expect(parseRun({ status: "completed" })).toBeNull();
    expect(parseRuns({ items: [{ status: "completed" }] })).toEqual([]);
  });
});

describe("latestRunFor", () => {
  const runs = parseRuns({
    items: [
      {
        id: "r1",
        definition_id: "def-1",
        status: "completed",
        completed_at: "2026-07-01T00:00:00Z",
      },
      {
        id: "r2",
        definition_id: "def-1",
        status: "completed",
        completed_at: "2026-07-09T00:00:00Z",
      },
      {
        id: "r3",
        definition_id: "def-2",
        status: "failed",
        completed_at: "2026-07-10T00:00:00Z",
      },
    ],
  });

  it("picks by timestamp, not by array position", () => {
    expect(latestRunFor(runs, "def-1")?.id).toBe("r2");
  });

  it("never returns another definition's run", () => {
    expect(latestRunFor(runs, "def-3")).toBeNull();
  });

  it("prefers a dated run over an undated one", () => {
    const mixed = parseRuns({
      items: [
        { id: "undated", definition_id: "d", status: "completed" },
        {
          id: "dated",
          definition_id: "d",
          status: "completed",
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
    });
    expect(latestRunFor(mixed, "d")?.id).toBe("dated");
  });
});

describe("runOutcome", () => {
  it("says 'never run' rather than showing zero rows", () => {
    expect(runOutcome(null)).toBe("Never run from here.");
  });

  it("leads with the error on a failed run", () => {
    const run = parseRun({
      id: "r",
      status: "failed",
      rows_total: 0,
      error: "metric blocked",
    });
    // No trailing period is appended to server text: the message may already
    // carry its own punctuation and "blocked.." reads as a rendering bug.
    expect(runOutcome(run)).toBe("Last run failed: metric blocked");
  });

  it("admits an unreported row count instead of claiming an empty result", () => {
    const run = parseRun({ id: "r", status: "completed" });
    expect(runOutcome(run)).toBe(
      "Last run completed; row count not reported.",
    );
  });

  it("singularises one row", () => {
    const run = parseRun({ id: "r", status: "completed", rows_total: 1 });
    expect(runOutcome(run)).toBe("Last run returned 1 row.");
  });
});

describe("runToast", () => {
  /**
   * The handler answers 202 with an ALREADY-COMPLETED run
   * (reporting/repo.go:266 inserts status='completed'; reporting.go:247
   * writes 202). Saying "queued" would describe work that is already done.
   */
  it("reports a completed run as completed, never as queued", () => {
    const run = parseRun({ id: "r", status: "completed", rows_total: 12 });
    expect(runToast(run)).toEqual({
      kind: "success",
      message: "Run completed — 12 rows.",
    });
  });

  it("reports a run that came back FAILED as an error, despite the 202", () => {
    const run = parseRun({
      id: "r",
      status: "failed",
      error: "product blocked",
    });
    expect(runToast(run)).toEqual({
      kind: "error",
      message: "Run failed: product blocked",
    });
  });

  it("treats a missing run record as a failure, not a silent success", () => {
    expect(runToast(null).kind).toBe("error");
  });
});

describe("definitionSummary + sortDefinitions", () => {
  it("summarises metrics, dimensions and window without inventing any", () => {
    const [withAll, bare] = parseDefinitions(DEFS_ENVELOPE);
    expect(definitionSummary(withAll!)).toBe("2 metrics · by day · last 7 days");
    expect(definitionSummary(bare!)).toBe("0 metrics");
  });

  it("puts a FAILED report first, then most-recently-run, then never-run", () => {
    const defs = parseDefinitions({
      items: [
        { id: "never", name: "Never", metrics: [] },
        { id: "recent", name: "Recent", metrics: [] },
        { id: "broken", name: "Broken", metrics: [] },
      ],
    });
    const runs = parseRuns({
      items: [
        {
          id: "r1",
          definition_id: "recent",
          status: "completed",
          completed_at: "2026-07-20T00:00:00Z",
        },
        {
          id: "r2",
          definition_id: "broken",
          status: "failed",
          completed_at: "2026-01-01T00:00:00Z",
        },
      ],
    });
    expect(sortDefinitions(defs, runs).map((d) => d.id)).toEqual([
      "broken",
      "recent",
      "never",
    ]);
  });
});
