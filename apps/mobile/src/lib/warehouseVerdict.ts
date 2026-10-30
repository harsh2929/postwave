/**
 * lib/warehouseVerdict.ts — "did last night's sync land?", answered without
 * overstating what a single page of runs can prove.
 *
 * THE TRAP THIS MODULE EXISTS TO AVOID. `GET /api/v1/warehouse/runs` returns
 * the newest N runs ACROSS ALL CONNECTIONS (repo.go:697-705 — one
 * `ORDER BY created_at DESC LIMIT $3` over the whole tenant, because the
 * collection route passes an empty connection id). Deriving "connection X has
 * not run" from that page is wrong the moment one chatty connection fills it:
 * a daily export whose last run was two days ago simply falls off the end. The
 * honest answer for a connection with no run inside the window is "no run in
 * the newest N", never "never ran" and never a silent omission — which is why
 * `windowFull` is carried all the way to the sentence.
 *
 * WHICH CONNECTIONS ARE EXPECTED TO RUN. Only ones the server would actually
 * schedule: `status = 'active'` and `cadence <> 'manual'` (both CHECK-
 * constrained, migration 0207 lines 17 and 22-23). A manual connection that
 * has not run is not an incident, and counting it as one is how a health
 * summary trains people to ignore it.
 *
 * DELIBERATELY IMPORT-FREE apart from the types it reasons over.
 */
import type { WarehouseConnection, WarehouseRun } from "@/lib/warehouseRuns";

export type ConnectionRunState =
  | "landed"
  | "failed"
  | "in_flight"
  | "cancelled"
  | "unknown"
  | "no_run_in_window";

export interface ConnectionVerdict {
  connectionId: string;
  name: string;
  cadence: string;
  state: ConnectionRunState;
  /** created_at of the newest run seen for it, or "". */
  newestRunAt: string;
  newestRunId: string;
}

export interface WarehouseSyncVerdict {
  rows: readonly ConnectionVerdict[];
  failed: number;
  landed: number;
  inFlight: number;
  unseen: number;
  /** How many connections the verdict was computed over. */
  expected: number;
  /** How many runs were in the window it was computed from. */
  sampled: number;
  /** The window came back full, so `unseen` may be truncation, not silence. */
  windowFull: boolean;
}

/** `status = 'active' AND cadence <> 'manual'` — the scheduled set. */
export function scheduledConnections(
  connections: readonly WarehouseConnection[],
): WarehouseConnection[] {
  return connections.filter(
    (connection) =>
      connection.status.toLowerCase() === "active" &&
      connection.cadence.toLowerCase() !== "manual" &&
      connection.cadence !== "",
  );
}

function stateOf(run: WarehouseRun): ConnectionRunState {
  switch (run.outcome) {
    case "completed":
      return "landed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "running":
    case "queued":
      return "in_flight";
    default:
      return "unknown";
  }
}

/**
 * The newest run per connection inside the window.
 *
 * The server already sorted by `created_at DESC`, so the FIRST run seen for a
 * connection is its newest — no comparison needed, and no dependence on
 * timestamps the client would have to re-parse.
 */
export function newestRunByConnection(
  runs: readonly WarehouseRun[],
): Map<string, WarehouseRun> {
  const newest = new Map<string, WarehouseRun>();
  for (const run of runs) {
    if (!run.connectionId) continue;
    if (!newest.has(run.connectionId)) newest.set(run.connectionId, run);
  }
  return newest;
}

export function warehouseSyncVerdict(
  runs: readonly WarehouseRun[],
  connections: readonly WarehouseConnection[],
  requestedLimit: number,
): WarehouseSyncVerdict {
  const newest = newestRunByConnection(runs);
  const rows = scheduledConnections(connections).map<ConnectionVerdict>(
    (connection) => {
      const run = newest.get(connection.id);
      if (!run) {
        return {
          connectionId: connection.id,
          name: connection.name || connection.provider,
          cadence: connection.cadence,
          state: "no_run_in_window",
          newestRunAt: "",
          newestRunId: "",
        };
      }
      return {
        connectionId: connection.id,
        name: connection.name || connection.provider,
        cadence: connection.cadence,
        state: stateOf(run),
        newestRunAt: run.createdAt,
        newestRunId: run.id,
      };
    },
  );
  return {
    rows,
    failed: rows.filter((row) => row.state === "failed").length,
    landed: rows.filter((row) => row.state === "landed").length,
    inFlight: rows.filter((row) => row.state === "in_flight").length,
    unseen: rows.filter((row) => row.state === "no_run_in_window").length,
    expected: rows.length,
    sampled: runs.length,
    windowFull: requestedLimit > 0 && runs.length >= requestedLimit,
  };
}

/**
 * The headline sentence.
 *
 * Every branch names its denominator. The zero case is stated positively
 * ("every scheduled connection landed") rather than as a "0 failed" figure,
 * because a zero next to the word "failed" reads as a measurement of failure
 * and this one is a measurement of success.
 */
export function verdictHeadline(verdict: WarehouseSyncVerdict): string {
  if (verdict.expected === 0) {
    return "No connection is on a schedule, so nothing is expected to run on its own.";
  }
  const of = `of ${verdict.expected} scheduled connection${verdict.expected === 1 ? "" : "s"}`;
  if (verdict.failed > 0) {
    return `The newest run failed for ${verdict.failed} ${of}.`;
  }
  if (verdict.unseen === verdict.expected) {
    return `No run at all for ${verdict.expected} scheduled connection${verdict.expected === 1 ? "" : "s"} in this window.`;
  }
  if (verdict.unseen > 0) {
    return `${verdict.expected - verdict.unseen} ${of} landed their newest run; ${verdict.unseen} had no run in this window.`;
  }
  if (verdict.inFlight > 0 && verdict.landed === 0) {
    return `Every one of the ${verdict.expected} scheduled connection${verdict.expected === 1 ? " is" : "s are"} still running.`;
  }
  return `Every one of the ${verdict.expected} scheduled connection${verdict.expected === 1 ? "" : "s"} landed its newest run.`;
}

/**
 * The qualifier under the headline: what the verdict was computed over, and
 * whether a missing run might just be the end of the page.
 */
export function verdictQualifier(verdict: WarehouseSyncVerdict): string {
  const base = `Read from the newest ${verdict.sampled} run${verdict.sampled === 1 ? "" : "s"} across every connection.`;
  if (verdict.windowFull && verdict.unseen > 0) {
    return `${base} That window is full, so a connection with no run here may simply have been pushed off the end rather than skipped.`;
  }
  return base;
}
