import { describe, expect, it } from "vitest";

import {
  STREAMING_EXPORT_PROVIDER,
  STREAMING_EXPORT_RUNS_MINIMUM_ROLE,
  STREAMING_ISSUE_HIDDEN,
  isStreamingExportConnection,
  normalizeStreamingExportHistory,
  normalizeStreamingExportRun,
  streamingRunOutcomeOf,
  streamingRunRowModel,
} from "@/lib/streamingExportRuns";

/**
 * The wire shape of one SANITIZED run, field for field as
 * `apps/api/internal/streaming_export/streaming_export.go:99-119` serialises
 * it after `sanitizeRun` (:475) blanked `object_uri` and `error` — so those
 * two keys are ABSENT (omitempty) and `issue_present` carries the fact.
 */
function runWire(over: Record<string, unknown> = {}) {
  return {
    id: "srun-1",
    connection_id: "conn-s1",
    status: "completed",
    format: "parquet",
    compression: "snappy",
    window_start: "2026-08-30T02:00:00Z",
    window_end: "2026-08-30T03:00:00Z",
    cursor_from: 1204,
    cursor_to: 1999,
    has_more: false,
    rows_shipped: 795,
    bytes_shipped: 2_516_582,
    issue_present: false,
    started_at: "2026-08-30T03:00:01Z",
    completed_at: "2026-08-30T03:00:09Z",
    created_at: "2026-08-30T03:00:01Z",
    ...over,
  };
}

function history(runs: unknown[], lastShippedAt: string | null = null) {
  return normalizeStreamingExportHistory({
    items: runs,
    last_shipped_at: lastShippedAt,
  });
}

describe("normalizeStreamingExportRun", () => {
  it("keeps the server's status word and derives the outcome from it", () => {
    const run = normalizeStreamingExportRun(runWire({ status: "Completed " }));
    expect(run.status).toBe("Completed");
    expect(run.outcome).toBe("completed");
    expect(run.terminal).toBe(true);
    expect(run.countersMeasured).toBe(true);
    expect(run.failed).toBe(false);
    expect(run.cursorFrom).toBe(1204);
    expect(run.cursorTo).toBe(1999);
    expect(run.rowsShipped).toBe(795);
    expect(run.bytesShipped).toBe(2_516_582);
    expect(run.durationMs).toBe(8_000);
  });

  it("maps every CHECK-constrained status and falls back to unknown", () => {
    expect(streamingRunOutcomeOf("running")).toBe("running");
    expect(streamingRunOutcomeOf("completed")).toBe("completed");
    expect(streamingRunOutcomeOf("failed")).toBe("failed");
    expect(streamingRunOutcomeOf("empty")).toBe("empty");
    // A vocabulary word this app has never seen must not become a verdict.
    expect(streamingRunOutcomeOf("retrying")).toBe("unknown");
    expect(streamingRunOutcomeOf("")).toBe("unknown");
  });

  it("treats a RUNNING run's zeros as not-yet-measured", () => {
    const run = normalizeStreamingExportRun(
      runWire({
        status: "running",
        rows_shipped: 0,
        bytes_shipped: 0,
        completed_at: undefined,
      }),
    );
    expect(run.terminal).toBe(false);
    expect(run.countersMeasured).toBe(false);
    expect(run.durationMs).toBeNull();
  });

  it("treats a FAILED run's zeros as a measurement (failRun writes them)", () => {
    const run = normalizeStreamingExportRun(
      runWire({ status: "failed", issue_present: true, rows_shipped: 0 }),
    );
    expect(run.countersMeasured).toBe(true);
    expect(run.failed).toBe(true);
  });

  it("flags a run that carries issue evidence even when its status is not failed", () => {
    const run = normalizeStreamingExportRun(runWire({ issue_present: true }));
    expect(run.outcome).toBe("completed");
    expect(run.failed).toBe(true);
  });

  it("coerces garbage to safe defaults rather than throwing", () => {
    const run = normalizeStreamingExportRun({
      id: 7,
      cursor_from: "12",
      has_more: "yes",
      issue_present: 1,
      rows_shipped: Number.NaN,
    });
    expect(run.id).toBe("");
    expect(run.cursorFrom).toBe(0);
    expect(run.hasMore).toBe(false);
    expect(run.issuePresent).toBe(false);
    expect(run.rowsShipped).toBe(0);
    expect(run.outcome).toBe("unknown");
  });
});

describe("normalizeStreamingExportHistory", () => {
  it("reads the {items, last_shipped_at} envelope", () => {
    const h = history([runWire()], "2026-08-30T03:00:00Z");
    expect(h.runs).toHaveLength(1);
    expect(h.lastShippedAt).toBe("2026-08-30T03:00:00Z");
  });

  it("survives a null items array and a null last_shipped_at", () => {
    const h = normalizeStreamingExportHistory({
      items: null,
      last_shipped_at: null,
    });
    expect(h.runs).toEqual([]);
    expect(h.lastShippedAt).toBe("");
  });

  it("survives a body that is not an object at all", () => {
    expect(normalizeStreamingExportHistory(null).runs).toEqual([]);
    expect(normalizeStreamingExportHistory("nope").runs).toEqual([]);
    expect(normalizeStreamingExportHistory([runWire()]).runs).toEqual([]);
  });

  it("drops rows without an id and keeps server order", () => {
    const h = history([
      runWire({ id: "b" }),
      { status: "completed" },
      runWire({ id: "a" }),
    ]);
    expect(h.runs.map((run) => run.id)).toEqual(["b", "a"]);
  });
});

describe("isStreamingExportConnection", () => {
  it("matches only the streaming provider", () => {
    expect(
      isStreamingExportConnection({ provider: STREAMING_EXPORT_PROVIDER }),
    ).toBe(true);
    expect(isStreamingExportConnection({ provider: " Streaming_Export " })).toBe(
      true,
    );
    expect(isStreamingExportConnection({ provider: "s3" })).toBe(false);
    expect(isStreamingExportConnection({ provider: "" })).toBe(false);
  });

  it("gates at the host screen's role, which is documented as stricter than the manifest", () => {
    expect(STREAMING_EXPORT_RUNS_MINIMUM_ROLE).toBe("admin");
  });
});

describe("streamingRunRowModel — the run → row mapping", () => {
  it("renders a completed window as its cursor range and shipped figures", () => {
    const row = streamingRunRowModel(normalizeStreamingExportRun(runWire()));
    expect(row.tone).toBe("success");
    expect(row.status).toBe("completed");
    expect(row.detail).toMatch(/^cursor 1,204 . 1,999 · caught up$/);
    expect(row.shipped).toBe("795 rows · 2.4 MB");
    expect(row.issueFlag).toBe(false);
    expect(row.windowEnd).toBe("2026-08-30T03:00:00Z");
    expect(row.durationMs).toBe(8_000);
  });

  it("says 'more due' when the batch cap was hit inside the window", () => {
    const row = streamingRunRowModel(
      normalizeStreamingExportRun(runWire({ has_more: true })),
    );
    expect(row.detail).toMatch(/· more due$/);
  });

  it("hides the cursor behind the issue sentence for a failed window", () => {
    const row = streamingRunRowModel(
      normalizeStreamingExportRun(
        runWire({ status: "failed", issue_present: true, rows_shipped: 0 }),
      ),
    );
    expect(row.tone).toBe("danger");
    expect(row.detail).toBe(STREAMING_ISSUE_HIDDEN);
    // failRun wrote the 0, so it is a measurement — but "0 rows" would read
    // as a count of something, and what happened is that nothing shipped.
    expect(row.shipped).toBe("nothing shipped");
    expect(row.issueFlag).toBe(false);
  });

  it("flags issue evidence on a run whose status is not failed", () => {
    const row = streamingRunRowModel(
      normalizeStreamingExportRun(runWire({ issue_present: true })),
    );
    expect(row.issueFlag).toBe(true);
    expect(row.detail).toBe(STREAMING_ISSUE_HIDDEN);
  });

  it("never prints a figure for a running window", () => {
    const row = streamingRunRowModel(
      normalizeStreamingExportRun(
        runWire({ status: "running", rows_shipped: 0, bytes_shipped: 0 }),
      ),
    );
    expect(row.tone).toBe("info");
    expect(row.shipped).toBe("— not yet measured");
    expect(row.shipped).not.toMatch(/0 rows/);
  });

  it("names an empty window as 'no due events', not '0 rows'", () => {
    const row = streamingRunRowModel(
      normalizeStreamingExportRun(
        runWire({ status: "empty", rows_shipped: 0, bytes_shipped: 0 }),
      ),
    );
    expect(row.tone).toBe("neutral");
    expect(row.shipped).toBe("no due events");
  });

  it("carries an unknown status as a warning with the raw word", () => {
    const row = streamingRunRowModel(
      normalizeStreamingExportRun(runWire({ status: "retrying" })),
    );
    expect(row.tone).toBe("warning");
    expect(row.status).toBe("retrying");
  });
});
