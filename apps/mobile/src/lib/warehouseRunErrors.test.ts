import { describe, expect, it } from "vitest";

import {
  ROW_ERROR_LIMIT,
  emptyRowErrorsMessage,
  groupWarehouseRowErrors,
  normalizeWarehouseRowErrors,
  rowReasonCoverage,
  runEvidence,
  type WarehouseRowError,
} from "@/lib/warehouseRunErrors";
import { normalizeWarehouseRun, type WarehouseRun } from "@/lib/warehouseRuns";

function run(over: Record<string, unknown> = {}): WarehouseRun {
  return normalizeWarehouseRun({
    id: "run-1",
    connection_id: "conn-1",
    direction: "import",
    run_mode: "scheduled",
    status: "completed",
    object_selection: [],
    rows_scanned: 100,
    rows_exported: 0,
    rows_imported: 60,
    rows_failed: 40,
    schema_errors: 0,
    retry_count: 0,
    error: "",
    started_at: "2026-07-25T03:00:00Z",
    completed_at: "2026-07-25T03:01:00Z",
    created_at: "2026-07-25T03:00:00Z",
    ...over,
  });
}

function rowError(over: Partial<WarehouseRowError> = {}): WarehouseRowError {
  return {
    id: "1",
    runId: "run-1",
    sourceObject: "orders.jsonl",
    rowNumber: 4,
    code: "subscriber_not_found",
    message: "subscriber_id or known email is required",
    createdAt: "2026-07-25T03:00:30Z",
    ...over,
  };
}

describe("normalizeWarehouseRowErrors", () => {
  it("stringifies the bigserial id, which arrives as a NUMBER", () => {
    // warehouse_row_errors.id is `bigserial` (migration 0207:142) and the
    // Go struct types it int64 — the only non-uuid identifier in the package.
    const [first] = normalizeWarehouseRowErrors({
      items: [
        {
          id: 918_273,
          run_id: "run-1",
          source_object: "orders.jsonl",
          row_number: 12,
          error_code: "parse_failed",
          error_message: "orders/2026-07-25.jsonl: unexpected end of JSON",
          raw_row: { _polled_object_key: "orders/2026-07-25.jsonl" },
          created_at: "2026-07-25T03:00:12Z",
        },
      ],
    });
    expect(first?.id).toBe("918273");
    expect(first?.rowNumber).toBe(12);
    expect(first?.code).toBe("parse_failed");
  });

  it("is an empty list, never a throw, for a shapeless payload", () => {
    expect(normalizeWarehouseRowErrors(null)).toEqual([]);
    expect(normalizeWarehouseRowErrors({ items: { nope: true } })).toEqual([]);
  });
});

describe("groupWarehouseRowErrors", () => {
  it("groups by error_code, largest first, with a stable tiebreak", () => {
    const groups = groupWarehouseRowErrors([
      rowError({ id: "1", code: "subscriber_not_found", rowNumber: 9 }),
      rowError({ id: "2", code: "subscriber_not_found", rowNumber: 4 }),
      rowError({ id: "3", code: "missing_event_name", rowNumber: 7 }),
      rowError({ id: "4", code: "insert_failed", rowNumber: 8 }),
    ]);
    expect(groups.map((group) => [group.code, group.count])).toEqual([
      ["subscriber_not_found", 2],
      // Ties break alphabetically so a refetch does not reshuffle the list
      // under a reader.
      ["insert_failed", 1],
      ["missing_event_name", 1],
    ]);
    expect(groups[0]?.firstRowNumber).toBe(4);
  });

  it("collects distinct source objects without repeating them", () => {
    const [group] = groupWarehouseRowErrors([
      rowError({ id: "1", sourceObject: "orders.jsonl" }),
      rowError({ id: "2", sourceObject: "orders.jsonl" }),
      rowError({ id: "3", sourceObject: "carts.jsonl" }),
    ]);
    expect(group?.sourceObjects).toEqual(["orders.jsonl", "carts.jsonl"]);
  });

  it("labels a blank error_code rather than rendering an empty heading", () => {
    const [group] = groupWarehouseRowErrors([rowError({ code: "" })]);
    expect(group?.code).toBe("unspecified");
  });

  it("reports no row number when the server stored the default 0", () => {
    // row_number defaults to 0 (migration 0207:146); "row 0" is not a row.
    const [group] = groupWarehouseRowErrors([rowError({ rowNumber: 0 })]);
    expect(group?.firstRowNumber).toBeNull();
  });
});

describe("rowReasonCoverage — the denominator is never dropped", () => {
  it("discloses the server's 500-row cap as a sample", () => {
    expect(rowReasonCoverage(12_000, ROW_ERROR_LIMIT)).toBe(
      "Showing the first 500 recorded reasons of 12000 failed rows — the server caps the ledger there.",
    );
  });

  it("says how many of the failures carry a reason when they disagree", () => {
    expect(rowReasonCoverage(40, 12)).toBe(
      "12 of those 40 rows recorded a reason.",
    );
  });

  it("says every failure is explained when they agree", () => {
    expect(rowReasonCoverage(40, 40)).toBe(
      "Every one of those 40 rows recorded a reason.",
    );
  });

  it("says nothing at all while the ledger has not loaded", () => {
    // null is "we have not read it yet" — different from "it is empty".
    expect(rowReasonCoverage(40, null)).toBe("");
  });
});

describe("runEvidence", () => {
  /**
   * THE CENTRAL FACT OF THIS SURFACE. `insertRowError` (imports.go:249) writes
   * into the WORK transaction, and `failRun` (repo.go:1052-1055) rolls that
   * transaction back before recording the failure in a fresh one. A failed
   * run therefore has an EMPTY row-error ledger by construction, and its
   * `error` string is the entire record.
   */
  it("points a failed run at its own error message, not at an empty ledger", () => {
    const evidence = runEvidence(
      run({ status: "failed", error: "redshift: dial tcp: i/o timeout" }),
      0,
    );
    expect(evidence.kind).toBe("run_error");
    expect(evidence.headline).toBe("redshift: dial tcp: i/o timeout");
    expect(evidence.expectsRowErrors).toBe(false);
    expect(evidence.detail).toContain("rolled back");
  });

  it("says so out loud when a failure was recorded with no message", () => {
    const evidence = runEvidence(run({ status: "failed", error: "" }), 0);
    expect(evidence.kind).toBe("run_error_missing");
    expect(evidence.headline).toBe(
      "The server recorded a failure with no message.",
    );
  });

  it("never totals rows for a run that is still in flight", () => {
    for (const status of ["queued", "running"]) {
      const evidence = runEvidence(run({ status }), null);
      expect(evidence.kind).toBe("in_flight");
      expect(evidence.detail).toContain("only written when a run completes");
    }
  });

  it("treats cancelled as its own state, not as a failure", () => {
    expect(runEvidence(run({ status: "cancelled" }), 0).kind).toBe("cancelled");
  });

  it("refuses to interpret a status this build does not know", () => {
    const evidence = runEvidence(run({ status: "quarantined" }), 0);
    expect(evidence.kind).toBe("unknown");
    expect(evidence.headline).toContain("quarantined");
  });

  it("states a clean completion positively", () => {
    const evidence = runEvidence(run({ rows_failed: 0 }), 0);
    expect(evidence.kind).toBe("clean");
    expect(evidence.headline).toBe("Completed with no failed rows.");
  });

  it("says a dry run delivered nothing, rather than calling it a success", () => {
    const evidence = runEvidence(
      run({ rows_failed: 0, run_mode: "dry_run" }),
      0,
    );
    expect(evidence.headline).toBe(
      "Dry run completed — nothing was written or delivered.",
    );
  });

  it("flags failed rows that carry no recorded reason", () => {
    // Only the import path calls insertRowError; an export counts failures
    // without ever writing a per-row reason.
    const evidence = runEvidence(run({ rows_failed: 40 }), 0);
    expect(evidence.kind).toBe("rows_failed_unexplained");
    expect(evidence.headline).toBe(
      "40 rows failed, and no per-row reason was recorded.",
    );
    expect(evidence.expectsRowErrors).toBe(false);
  });

  it("carries the coverage sentence when reasons exist", () => {
    const evidence = runEvidence(run({ rows_failed: 40 }), 12);
    expect(evidence.kind).toBe("row_reasons");
    expect(evidence.headline).toBe("40 rows failed.");
    expect(evidence.detail).toBe("12 of those 40 rows recorded a reason.");
    expect(evidence.expectsRowErrors).toBe(true);
  });

  it("does not decide the ledger is empty before it has loaded", () => {
    // errorCount null must NOT fall into "no per-row reason was recorded".
    const evidence = runEvidence(run({ rows_failed: 40 }), null);
    expect(evidence.kind).toBe("row_reasons");
    expect(evidence.detail).toBe("");
  });
});

describe("emptyRowErrorsMessage", () => {
  it("never says a failed run had no errors", () => {
    const message = emptyRowErrorsMessage(
      runEvidence(run({ status: "failed", error: "boom" }), 0),
    );
    expect(message).toBe(
      "This run failed outright, so no per-row reasons survived. What the server recorded about the failure is above.",
    );
    expect(message).not.toContain("no errors");
  });

  it("does not repeat the sentence the detail card already carries", () => {
    // The detail card shows evidence.detail; the empty state showing the same
    // words leaves a reader hunting for the difference between them.
    const evidence = runEvidence(run({ status: "failed", error: "boom" }), 0);
    expect(emptyRowErrorsMessage(evidence)).not.toBe(evidence.detail);
  });

  it("distinguishes clean, in-flight and cancelled from a failure", () => {
    expect(emptyRowErrorsMessage(runEvidence(run({ rows_failed: 0 }), 0))).toBe(
      "Nothing failed in this run, so there is nothing to explain.",
    );
    expect(
      emptyRowErrorsMessage(runEvidence(run({ status: "running" }), null)),
    ).toContain("has not finished");
    expect(
      emptyRowErrorsMessage(runEvidence(run({ status: "cancelled" }), 0)),
    ).toContain("cancelled");
  });

  it("explains that an export never writes per-row reasons", () => {
    expect(
      emptyRowErrorsMessage(runEvidence(run({ rows_failed: 7 }), 0)),
    ).toBe(
      "Only the import path records a reason per row; an export counts its failures without one.",
    );
  });
});
