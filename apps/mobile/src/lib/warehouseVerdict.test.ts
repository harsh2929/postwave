import { describe, expect, it } from "vitest";

import {
  newestRunByConnection,
  scheduledConnections,
  verdictHeadline,
  verdictQualifier,
  warehouseSyncVerdict,
} from "@/lib/warehouseVerdict";
import {
  normalizeWarehouseRun,
  type WarehouseConnection,
  type WarehouseRun,
} from "@/lib/warehouseRuns";

function connection(over: Partial<WarehouseConnection> = {}): WarehouseConnection {
  return {
    id: "conn-1",
    name: "Nightly Redshift",
    provider: "redshift",
    direction: "export",
    status: "active",
    cadence: "daily",
    error: "",
    lastCursor: "",
    ...over,
  };
}

function run(over: Record<string, unknown> = {}): WarehouseRun {
  return normalizeWarehouseRun({
    id: "run-1",
    connection_id: "conn-1",
    direction: "export",
    run_mode: "scheduled",
    status: "completed",
    object_selection: [],
    rows_scanned: 0,
    rows_exported: 0,
    rows_imported: 0,
    rows_failed: 0,
    schema_errors: 0,
    retry_count: 0,
    error: "",
    created_at: "2026-07-25T03:00:00Z",
    ...over,
  });
}

describe("scheduledConnections", () => {
  it("counts only connections the server would run on its own", () => {
    // status='active' AND cadence<>'manual' — migration 0207 lines 17, 22-23.
    const rows = scheduledConnections([
      connection({ id: "a", cadence: "daily", status: "active" }),
      connection({ id: "b", cadence: "manual", status: "active" }),
      connection({ id: "c", cadence: "hourly", status: "paused" }),
      connection({ id: "d", cadence: "weekly", status: "draft" }),
      connection({ id: "e", cadence: "hourly", status: "active" }),
    ]);
    expect(rows.map((row) => row.id)).toEqual(["a", "e"]);
  });

  it("does not treat an unset cadence as a schedule", () => {
    expect(scheduledConnections([connection({ cadence: "" })])).toEqual([]);
  });
});

describe("newestRunByConnection", () => {
  it("takes the FIRST run per connection, trusting the server's ordering", () => {
    // repo.go:704 already sorts created_at DESC, so first == newest and no
    // client-side timestamp comparison is needed.
    const newest = newestRunByConnection([
      run({ id: "newest", created_at: "2026-07-25T03:00:00Z" }),
      run({ id: "older", created_at: "2026-07-24T03:00:00Z" }),
      run({ id: "other", connection_id: "conn-2" }),
    ]);
    expect(newest.get("conn-1")?.id).toBe("newest");
    expect(newest.get("conn-2")?.id).toBe("other");
  });

  it("skips runs whose connection was deleted", () => {
    // connection_id is COALESCEd to '' for an ON DELETE SET NULL orphan; it is
    // not a connection and must not become a map key.
    expect(newestRunByConnection([run({ connection_id: "" })]).size).toBe(0);
  });
});

describe("warehouseSyncVerdict", () => {
  const connections = [
    connection({ id: "conn-1", name: "Nightly Redshift" }),
    connection({ id: "conn-2", name: "Hourly S3", cadence: "hourly" }),
    connection({ id: "conn-3", name: "Manual export", cadence: "manual" }),
  ];

  it("classifies each scheduled connection by its newest run", () => {
    const verdict = warehouseSyncVerdict(
      [
        run({ id: "r1", connection_id: "conn-1", status: "failed" }),
        run({ id: "r2", connection_id: "conn-2", status: "completed" }),
      ],
      connections,
      50,
    );
    expect(verdict.expected).toBe(2); // the manual one is not expected to run
    expect(verdict.failed).toBe(1);
    expect(verdict.landed).toBe(1);
    expect(verdict.unseen).toBe(0);
    expect(verdict.rows.map((row) => row.state)).toEqual(["failed", "landed"]);
  });

  it("calls a connection with no run in the page UNSEEN, never 'never ran'", () => {
    const verdict = warehouseSyncVerdict(
      [run({ connection_id: "conn-1" })],
      connections,
      50,
    );
    expect(verdict.unseen).toBe(1);
    expect(verdict.rows[1]?.state).toBe("no_run_in_window");
    expect(verdict.rows[1]?.newestRunAt).toBe("");
  });

  it("knows when the window was full, so a gap may be truncation", () => {
    const runs = Array.from({ length: 2 }, (_unused, index) =>
      run({ id: `r${index}`, connection_id: "conn-1" }),
    );
    expect(warehouseSyncVerdict(runs, connections, 2).windowFull).toBe(true);
    expect(warehouseSyncVerdict(runs, connections, 50).windowFull).toBe(false);
  });

  it("folds queued and running into one in-flight state", () => {
    const verdict = warehouseSyncVerdict(
      [
        run({ connection_id: "conn-1", status: "running" }),
        run({ id: "r2", connection_id: "conn-2", status: "queued" }),
      ],
      connections,
      50,
    );
    expect(verdict.inFlight).toBe(2);
  });
});

describe("verdictHeadline", () => {
  const base = {
    rows: [],
    failed: 0,
    landed: 0,
    inFlight: 0,
    unseen: 0,
    expected: 0,
    sampled: 0,
    windowFull: false,
  };

  it("says nothing is scheduled rather than reporting a zero", () => {
    expect(verdictHeadline(base)).toBe(
      "No connection is on a schedule, so nothing is expected to run on its own.",
    );
  });

  it("leads with failure and always names the denominator", () => {
    expect(
      verdictHeadline({ ...base, expected: 5, failed: 2, landed: 3 }),
    ).toBe("The newest run failed for 2 of 5 scheduled connections.");
  });

  it("states the healthy case positively, not as '0 failed'", () => {
    expect(verdictHeadline({ ...base, expected: 4, landed: 4 })).toBe(
      "Every one of the 4 scheduled connections landed its newest run.",
    );
  });

  it("separates 'landed' from 'not seen' when only some ran", () => {
    expect(
      verdictHeadline({ ...base, expected: 5, landed: 3, unseen: 2 }),
    ).toBe(
      "3 of 5 scheduled connections landed their newest run; 2 had no run in this window.",
    );
  });

  it("does not claim a landing when every connection is silent", () => {
    expect(verdictHeadline({ ...base, expected: 3, unseen: 3 })).toBe(
      "No run at all for 3 scheduled connections in this window.",
    );
  });

  it("reports an all-in-flight window as running, not as landed", () => {
    expect(verdictHeadline({ ...base, expected: 2, inFlight: 2 })).toBe(
      "Every one of the 2 scheduled connections are still running.",
    );
  });
});

describe("verdictQualifier", () => {
  const base = {
    rows: [],
    failed: 0,
    landed: 0,
    inFlight: 0,
    unseen: 0,
    expected: 3,
    sampled: 50,
    windowFull: false,
  };

  it("always says what the verdict was computed over", () => {
    expect(verdictQualifier(base)).toBe(
      "Read from the newest 50 runs across every connection.",
    );
  });

  it("warns that a full window can hide a run, not prove its absence", () => {
    expect(
      verdictQualifier({ ...base, windowFull: true, unseen: 1 }),
    ).toContain("pushed off the end rather than skipped");
  });

  it("stays quiet about truncation when nothing is missing", () => {
    expect(
      verdictQualifier({ ...base, windowFull: true, unseen: 0 }),
    ).toBe("Read from the newest 50 runs across every connection.");
  });
});
