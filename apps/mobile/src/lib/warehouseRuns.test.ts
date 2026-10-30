import { describe, expect, it } from "vitest";

import {
  filterWarehouseRuns,
  normalizeWarehouseConnectionHealth,
  normalizeWarehouseConnections,
  normalizeWarehouseRun,
  normalizeWarehouseRuns,
  runConnectionLabel,
  runOutcomeOf,
  warehouseRunFilterCounts,
  type WarehouseConnection,
} from "@/lib/warehouseRuns";

/**
 * The wire shape of a completed export run, field for field as
 * `apps/api/internal/warehouse/warehouse.go:61-85` serialises it.
 */
function runWire(over: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    tenant_id: "tenant-1",
    connection_id: "conn-1",
    direction: "export",
    run_mode: "scheduled",
    status: "completed",
    object_selection: ["profiles", "events"],
    input_uri: "",
    output_uri: "s3://bucket/warehouse/run-1.jsonl",
    cursor_from: "",
    cursor_to: "",
    rows_scanned: 12_000,
    rows_exported: 11_940,
    rows_imported: 0,
    rows_failed: 60,
    schema_errors: 2,
    retry_count: 0,
    metrics: { dry_run: false },
    error: "",
    started_at: "2026-07-25T03:00:00Z",
    completed_at: "2026-07-25T03:04:30Z",
    created_at: "2026-07-25T03:00:00Z",
    updated_at: "2026-07-25T03:04:30Z",
    ...over,
  };
}

describe("runOutcomeOf", () => {
  it("maps every value the CHECK constraint allows", () => {
    // migration 0207 line 60.
    expect(runOutcomeOf("queued")).toBe("queued");
    expect(runOutcomeOf("running")).toBe("running");
    expect(runOutcomeOf("completed")).toBe("completed");
    expect(runOutcomeOf("failed")).toBe("failed");
    expect(runOutcomeOf("cancelled")).toBe("cancelled");
  });

  it("never guesses at a status it does not recognise", () => {
    // The constraint can gain a value before this app ships again. Calling an
    // unknown state "failed" would be a verdict nobody issued.
    expect(runOutcomeOf("quarantined")).toBe("unknown");
    expect(runOutcomeOf("")).toBe("unknown");
  });
});

describe("normalizeWarehouseRun — counters are a measurement, or they are not", () => {
  /**
   * THE LOAD-BEARING ASSERTION OF THIS SURFACE.
   *
   * `completeRunTx` (repo.go:1023-1036) is the only statement in the package
   * that writes rows_scanned/exported/imported/failed/schema_errors, and it
   * sets `status='completed'` in the same UPDATE. `failRun` (repo.go:1058)
   * writes only status/error/completed_at. So on any non-completed run the
   * counters are still the migration's DEFAULT 0 (lines 66-70) — "never
   * measured", not "zero rows".
   */
  it("marks counters measured ONLY for a completed run", () => {
    expect(normalizeWarehouseRun(runWire()).countersMeasured).toBe(true);
    for (const status of ["queued", "running", "failed", "cancelled"]) {
      const run = normalizeWarehouseRun(runWire({ status }));
      expect(run.countersMeasured).toBe(false);
      // The zeroes are still carried verbatim — the flag is what stops the UI
      // rendering them as a count.
      expect(run.rowsFailed).toBe(60);
    }
  });

  it("computes a duration only when the server recorded both ends", () => {
    expect(normalizeWarehouseRun(runWire()).durationMs).toBe(270_000);
    expect(
      normalizeWarehouseRun(runWire({ completed_at: undefined })).durationMs,
    ).toBeNull();
    expect(
      normalizeWarehouseRun(runWire({ started_at: undefined })).durationMs,
    ).toBeNull();
  });

  it("refuses a negative duration rather than rendering one", () => {
    // Clock skew between the app server that set started_at and the database
    // now() that set completed_at can invert them; "-4m" is not a duration.
    expect(
      normalizeWarehouseRun(
        runWire({ completed_at: "2026-07-25T02:59:00Z" }),
      ).durationMs,
    ).toBeNull();
  });

  it("keeps the orphaned run's empty connection id rather than inventing one", () => {
    // warehouse_sync_runs.connection_id is ON DELETE SET NULL (migration :55)
    // and the SELECT COALESCEs it to '' (repo.go:696).
    const run = normalizeWarehouseRun(runWire({ connection_id: "" }));
    expect(run.connectionId).toBe("");
  });

  it("flags a dry run, which completes without delivering anything", () => {
    expect(normalizeWarehouseRun(runWire({ run_mode: "dry_run" })).dryRun).toBe(
      true,
    );
    expect(normalizeWarehouseRun(runWire()).dryRun).toBe(false);
  });

  it("treats a null-ish payload as an empty run, not a crash", () => {
    const run = normalizeWarehouseRun(null);
    expect(run.id).toBe("");
    expect(run.outcome).toBe("unknown");
    expect(run.countersMeasured).toBe(false);
    expect(run.objectSelection).toEqual([]);
  });
});

describe("normalizeWarehouseRuns", () => {
  it("reads the { items } envelope the handler writes", () => {
    // warehouse.go:407 — writeJSON(w, 200, map[string]any{"items": out}).
    const runs = normalizeWarehouseRuns({ items: [runWire(), runWire({ id: "run-2" })] });
    expect(runs.map((run) => run.id)).toEqual(["run-1", "run-2"]);
  });

  it("also accepts a bare array, and drops rows with no id", () => {
    expect(normalizeWarehouseRuns([runWire(), { status: "failed" }])).toHaveLength(
      1,
    );
  });

  it("is an empty list for a payload that is not a list at all", () => {
    expect(normalizeWarehouseRuns({ items: "nope" })).toEqual([]);
    expect(normalizeWarehouseRuns(undefined)).toEqual([]);
  });
});

describe("normalizeWarehouseConnections", () => {
  it("carries the vocabulary the CHECK constraints fix", () => {
    const rows = normalizeWarehouseConnections({
      items: [
        {
          id: "conn-1",
          name: "Nightly Redshift",
          provider: "redshift",
          direction: "export",
          status: "active",
          cadence: "daily",
          backfill_days: 90,
          last_cursor: "2026-07-25",
          error: "",
        },
      ],
    });
    expect(rows).toEqual([
      {
        id: "conn-1",
        name: "Nightly Redshift",
        provider: "redshift",
        direction: "export",
        status: "active",
        cadence: "daily",
        error: "",
        lastCursor: "2026-07-25",
      },
    ]);
  });
});

describe("normalizeWarehouseConnectionHealth", () => {
  it("reads the fields healthForConnection actually sets", () => {
    // warehouse.go:872-928.
    const health = normalizeWarehouseConnectionHealth({
      connection_id: "conn-1",
      provider: "snowflake",
      status: "active",
      health: "error",
      last_run_status: "failed",
      last_run_at: "2026-07-25T03:00:00Z",
      error: "403 from Snowflake",
      missing_required_settings: ["account", "warehouse"],
      warnings: ["backfill_days is unusually large"],
      provider_runtime_status: "partial",
      provider_driver_attachment: "manifest_worker",
    });
    expect(health.health).toBe("error");
    expect(health.missingRequiredSettings).toEqual(["account", "warehouse"]);
    expect(health.warnings).toHaveLength(1);
  });

  it("omits the optional strings as empty rather than as undefined", () => {
    // Every one of those fields is `omitempty`, so a healthy connection sends
    // none of them; the screen must render an absence, not `undefined`.
    const health = normalizeWarehouseConnectionHealth({
      connection_id: "conn-1",
      provider: "s3",
      status: "active",
      health: "healthy",
    });
    expect(health.lastRunStatus).toBe("");
    expect(health.error).toBe("");
    expect(health.missingRequiredSettings).toEqual([]);
  });
});

describe("filterWarehouseRuns", () => {
  const runs = [
    normalizeWarehouseRun(runWire({ id: "a", status: "completed" })),
    normalizeWarehouseRun(runWire({ id: "b", status: "failed" })),
    normalizeWarehouseRun(runWire({ id: "c", status: "cancelled" })),
    normalizeWarehouseRun(runWire({ id: "d", status: "running" })),
    normalizeWarehouseRun(runWire({ id: "e", status: "queued" })),
    normalizeWarehouseRun(runWire({ id: "f", status: "quarantined" })),
  ];

  it("groups everything that did not land under 'failed'", () => {
    // Cancelled and unrecognised runs did not land either; leaving them out of
    // the one filter an operator reaches for is how a stuck scheduler hides.
    expect(filterWarehouseRuns(runs, "failed").map((run) => run.id)).toEqual([
      "b",
      "c",
      "f",
    ]);
  });

  it("groups queued with running — both are 'not finished'", () => {
    expect(filterWarehouseRuns(runs, "running").map((run) => run.id)).toEqual([
      "d",
      "e",
    ]);
  });

  it("returns a copy for 'all', never the caller's array", () => {
    const all = filterWarehouseRuns(runs, "all");
    expect(all).toEqual(runs);
    expect(all).not.toBe(runs);
  });

  it("counts each filter over the same window", () => {
    expect(warehouseRunFilterCounts(runs)).toEqual({
      all: 6,
      failed: 3,
      running: 2,
    });
  });
});

describe("runConnectionLabel", () => {
  const connections: WarehouseConnection[] = [
    {
      id: "conn-1",
      name: "Nightly Redshift",
      provider: "redshift",
      direction: "export",
      status: "active",
      cadence: "daily",
      error: "",
      lastCursor: "",
    },
    {
      id: "conn-2",
      name: "",
      provider: "s3",
      direction: "import",
      status: "active",
      cadence: "hourly",
      error: "",
      lastCursor: "",
    },
  ];

  it("prefers the operator's own name", () => {
    expect(
      runConnectionLabel(normalizeWarehouseRun(runWire()), connections),
    ).toBe("Nightly Redshift");
  });

  it("falls back to the provider when the connection was never named", () => {
    expect(
      runConnectionLabel(
        normalizeWarehouseRun(runWire({ connection_id: "conn-2" })),
        connections,
      ),
    ).toBe("s3");
  });

  it("says a deleted connection is deleted rather than leaving a blank", () => {
    expect(
      runConnectionLabel(
        normalizeWarehouseRun(runWire({ connection_id: "" })),
        connections,
      ),
    ).toBe("Deleted connection");
  });

  it("shows an id stub when the connection is outside the fetched list", () => {
    expect(
      runConnectionLabel(
        normalizeWarehouseRun(runWire({ connection_id: "9f2c4b10-dead" })),
        connections,
      ),
    ).toBe("Connection 9f2c4b10");
  });
});
