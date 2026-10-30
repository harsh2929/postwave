import { describe, expect, it } from "vitest";

import {
  normalizeStreamingExportHistory,
  type StreamingExportHistory,
} from "@/lib/streamingExportRuns";
import {
  streamingConnectionEntries,
  streamingConnectionVerdict,
  streamingDockSummary,
  streamingHistoryErrorMessage,
} from "@/lib/streamingExportVerdict";

/** Same sanitized wire row as `streamingExportRuns.test.ts` builds. */
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

describe("streamingConnectionVerdict", () => {
  it("reads 'never shipped' off an empty history", () => {
    const v = streamingConnectionVerdict(history([]));
    expect(v.kind).toBe("never_shipped");
    expect(v.failedWindows).toBe(0);
  });

  it("headlines the newest failed window and counts the others", () => {
    const v = streamingConnectionVerdict(
      history([
        runWire({ id: "n", status: "failed", issue_present: true }),
        runWire({ id: "o", status: "failed", issue_present: true }),
        runWire({ id: "p" }),
      ]),
    );
    expect(v.kind).toBe("failed_window");
    expect(v.failedWindows).toBe(2);
    expect(v.headline).toBe(
      "The newest window did not land — 2 windows in this response did not.",
    );
  });

  it("reads a recovered connection as recovered, with the failure on record", () => {
    const v = streamingConnectionVerdict(
      history([
        runWire({ id: "n" }),
        runWire({ id: "o", status: "failed", issue_present: true }),
      ]),
    );
    expect(v.kind).toBe("caught_up");
    expect(v.failedWindows).toBe(1);
    expect(v.headline).toBe(
      "Caught up — the newest window landed. 1 earlier window in this response did not land.",
    );
  });

  it("distinguishes in-flight from behind from caught up", () => {
    expect(
      streamingConnectionVerdict(history([runWire({ status: "running" })])).kind,
    ).toBe("in_flight");
    expect(
      streamingConnectionVerdict(history([runWire({ has_more: true })])).kind,
    ).toBe("behind");
    expect(
      streamingConnectionVerdict(history([runWire({ status: "empty" })])).kind,
    ).toBe("caught_up");
  });
});

describe("streamingHistoryErrorMessage", () => {
  it("names the 404 the way the desktop does, plus the deleted-connection cause", () => {
    expect(streamingHistoryErrorMessage(404)).toMatch(
      /^Streaming export isn't enabled on this Moosewave server/,
    );
    expect(streamingHistoryErrorMessage(403)).toMatch(/owner or admin/);
    expect(streamingHistoryErrorMessage(0)).toMatch(/Couldn't reach/);
    expect(streamingHistoryErrorMessage(500)).toMatch(/couldn't return/);
  });
});

describe("streamingDockSummary", () => {
  const ok: StreamingExportHistory = history(
    [runWire()],
    "2026-08-30T03:00:00Z",
  );
  const bad: StreamingExportHistory = history([
    runWire({ status: "failed", issue_present: true }),
  ]);
  const entry = (
    id: string,
    h: StreamingExportHistory | null,
    errorStatus: number | null = null,
  ) => ({ connectionId: id, name: id, history: h, errorStatus });

  it("says it is still reading until the query has resolved", () => {
    const s = streamingDockSummary([entry("a", null)], false);
    expect(s.tone).toBe("neutral");
    expect(s.headline).toBe("1 connection · reading shipped windows…");
  });

  it("says 'reconnect' rather than 'reading' when the gate is closed", () => {
    const s = streamingDockSummary([entry("a", null)], false, true);
    expect(s.headline).toBe("1 connection · reconnect to read shipped windows");
    // Cached data that DID load is still reported normally while offline.
    expect(streamingDockSummary([entry("a", ok)], true, true).tone).toBe(
      "success",
    );
  });

  it("leads with failures and names the denominator", () => {
    const s = streamingDockSummary([entry("a", bad), entry("b", ok)], true);
    expect(s.tone).toBe("danger");
    expect(s.failing).toBe(1);
    expect(s.headline).toBe(
      "1 of 2 connections did not land the newest window",
    );
    expect(s.lastShippedAt).toBe("2026-08-30T03:00:00Z");
  });

  it("never folds an unreadable history into 'caught up'", () => {
    const s = streamingDockSummary(
      [entry("a", ok), entry("b", null, 404)],
      true,
    );
    expect(s.tone).toBe("success");
    expect(s.unreadable).toBe(1);
    expect(s.headline).toBe(
      "1 connection landed the newest window · 1 unreadable",
    );
  });

  it("says so when nothing could be read at all", () => {
    const s = streamingDockSummary([entry("a", null, 0)], true);
    expect(s.tone).toBe("warning");
    expect(s.headline).toBe(
      "Shipment history couldn't be read for this connection",
    );
  });

  it("states 'nothing has shipped yet' when every readable history is empty", () => {
    const s = streamingDockSummary([entry("a", history([]))], true);
    expect(s.tone).toBe("neutral");
    expect(s.headline).toBe("1 connection · nothing has shipped yet");
  });
});

describe("streamingConnectionEntries", () => {
  it("keeps every roster connection even when its read is missing", () => {
    const entries = streamingConnectionEntries(
      [
        { id: "a", name: "Currents to S3", provider: "streaming_export" },
        { id: "b", name: "", provider: "streaming_export" },
        { id: "c0ffee00-dead-beef", name: "", provider: "" },
      ],
      [{ connectionId: "a", history: history([]), errorStatus: null }],
    );
    expect(entries.map((e) => e.name)).toEqual([
      "Currents to S3",
      "streaming_export",
      "Connection c0ffee00",
    ]);
    expect(entries[0]?.history).not.toBeNull();
    expect(entries[1]?.history).toBeNull();
    expect(entries[1]?.errorStatus).toBeNull();
  });

  it("carries the read's error status", () => {
    const entries = streamingConnectionEntries(
      [{ id: "a", name: "A", provider: "streaming_export" }],
      [{ connectionId: "a", history: null, errorStatus: 404 }],
    );
    expect(entries[0]?.errorStatus).toBe(404);
  });
});
