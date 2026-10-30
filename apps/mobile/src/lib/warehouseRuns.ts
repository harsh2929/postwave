/**
 * lib/warehouseRuns.ts — parsing the warehouse sync-run ledger.
 *
 * WHAT THIS SURFACE ANSWERS. `apps/desktop/src/pages/DataPlatform.tsx` is a
 * schema-authoring console: connection forms, a pre-save validator, import
 * mappings, custom object types, a CDP transform playground. All of that is
 * keyboard work and stays on a desk. The one part that is not is the nightly
 * question — *did last night's sync land, and if it did not, what broke* — and
 * a warehouse export that dies at 03:00 is silently not delivering until
 * somebody opens a laptop.
 *
 * THE SHAPES, READ OFF THE GO SOURCE AND THE MIGRATION (not from a doc):
 *   - `SyncRun`          apps/api/internal/warehouse/warehouse.go:61-85
 *   - `Connection`       warehouse.go:43-59
 *   - `ConnectionHealth` warehouse.go:137-149
 *   - the CHECK constraints that fix the vocabularies:
 *     infra/migrations/0207_klaviyo_warehouse_sync_foundation.sql:56-60
 *     (`status IN ('queued','running','completed','failed','cancelled')`,
 *      `run_mode IN ('manual','scheduled','backfill','retry','dry_run')`)
 *     and :17 for the connection's own
 *     `status IN ('draft','active','paused','error')`.
 *
 * THE ONE SERVER FACT THAT DECIDES HOW THIS SCREEN READS NUMBERS.
 * `rows_scanned / rows_exported / rows_imported / rows_failed / schema_errors`
 * are written in exactly ONE statement in the whole package — `completeRunTx`
 * (repo.go:1023-1036) — and that statement also sets `status = 'completed'`.
 * `failRun` (repo.go:1045-1075) writes only `status`, `error` and
 * `completed_at`. So for a run that is queued, running, failed or cancelled,
 * every counter is still the column DEFAULT 0 from the migration (:66-70) —
 * which means "never measured", NOT "zero rows". Printing "0 rows imported"
 * under a failed run would be the app reporting a measurement the server never
 * took. `countersMeasured` is that distinction, and the UI renders an em-dash
 * whenever it is false.
 *
 * DELIBERATELY IMPORT-FREE so it runs under the node vitest environment.
 */

/** Terminal + in-flight states, collapsed from the CHECK constraint. */
export type WarehouseRunOutcome =
  | "completed"
  | "failed"
  | "cancelled"
  | "running"
  | "queued"
  | "unknown";

export interface WarehouseRun {
  id: string;
  /**
   * "" when the connection row was deleted: the FK is
   * `ON DELETE SET NULL` (migration :55) and the SELECT COALESCEs it to the
   * empty string (repo.go:696). An orphan run is a real thing to see, so it
   * gets its own sentence rather than a blank line.
   */
  connectionId: string;
  /** "export" | "import" — CHECK-constrained, kept verbatim. */
  direction: string;
  /** manual | scheduled | backfill | retry | dry_run. */
  runMode: string;
  /** The server's own word, never re-spelled. */
  status: string;
  outcome: WarehouseRunOutcome;
  objectSelection: readonly string[];
  rowsScanned: number;
  rowsExported: number;
  rowsImported: number;
  rowsFailed: number;
  schemaErrors: number;
  retryCount: number;
  /** Top-level failure text written by `failRun`. "" when there was none. */
  error: string;
  startedAt: string;
  completedAt: string;
  createdAt: string;
  inputUri: string;
  outputUri: string;
  cursorFrom: string;
  cursorTo: string;
  /** ms between started_at and completed_at, or null when either is absent. */
  durationMs: number | null;
  /** The run has reached a state it will not leave. */
  terminal: boolean;
  /**
   * The five row counters carry a measurement. False for every non-completed
   * run — see the module note. Never treat a 0 as a count when this is false.
   */
  countersMeasured: boolean;
  /** run_mode === "dry_run": it completed, and it delivered nothing. */
  dryRun: boolean;
}

export interface WarehouseConnection {
  id: string;
  name: string;
  /** s3 | redshift | bigquery | azure_blob | snowflake. */
  provider: string;
  direction: string;
  /** draft | active | paused | error. */
  status: string;
  /** manual | hourly | daily | weekly. */
  cadence: string;
  error: string;
  lastCursor: string;
}

export interface WarehouseConnectionHealth {
  connectionId: string;
  provider: string;
  status: string;
  /** healthy | paused | error | needs_attention — `healthForConnection`. */
  health: string;
  lastRunStatus: string;
  lastRunAt: string;
  error: string;
  missingRequiredSettings: readonly string[];
  warnings: readonly string[];
  providerRuntimeStatus: string;
  providerDriverAttachment: string;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : 0;
}

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(str).filter((entry) => entry !== "");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** `{ items: [...] }` is the envelope every warehouse list route writes. */
function itemsOf(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  const items = record(raw).items;
  return Array.isArray(items) ? items : [];
}

/**
 * Collapse the server's status string into the five states the UI branches on.
 *
 * An UNRECOGNISED status maps to "unknown" and the raw word is still carried
 * on `status`, because the CHECK constraint can gain a value before this app
 * ships again and silently re-labelling it "failed" would be a fabricated
 * verdict.
 */
export function runOutcomeOf(status: string): WarehouseRunOutcome {
  switch (status.trim().toLowerCase()) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "running":
      return "running";
    case "queued":
      return "queued";
    default:
      return "unknown";
  }
}

function durationBetween(startedAt: string, completedAt: string): number | null {
  if (!startedAt || !completedAt) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const delta = end - start;
  return delta >= 0 ? delta : null;
}

export function normalizeWarehouseRun(raw: unknown): WarehouseRun {
  const row = record(raw);
  const status = str(row.status);
  const outcome = runOutcomeOf(status);
  const startedAt = str(row.started_at);
  const completedAt = str(row.completed_at);
  return {
    id: str(row.id),
    connectionId: str(row.connection_id),
    direction: str(row.direction),
    runMode: str(row.run_mode),
    status,
    outcome,
    objectSelection: strList(row.object_selection),
    rowsScanned: int(row.rows_scanned),
    rowsExported: int(row.rows_exported),
    rowsImported: int(row.rows_imported),
    rowsFailed: int(row.rows_failed),
    schemaErrors: int(row.schema_errors),
    retryCount: int(row.retry_count),
    error: str(row.error),
    startedAt,
    completedAt,
    createdAt: str(row.created_at),
    inputUri: str(row.input_uri),
    outputUri: str(row.output_uri),
    cursorFrom: str(row.cursor_from),
    cursorTo: str(row.cursor_to),
    durationMs: durationBetween(startedAt, completedAt),
    terminal:
      outcome === "completed" || outcome === "failed" || outcome === "cancelled",
    // The single most important line in this file — see the module note.
    countersMeasured: outcome === "completed",
    dryRun: str(row.run_mode).toLowerCase() === "dry_run",
  };
}

/** Newest first, exactly as `ORDER BY created_at DESC` already returned. */
export function normalizeWarehouseRuns(raw: unknown): WarehouseRun[] {
  return itemsOf(raw)
    .map(normalizeWarehouseRun)
    .filter((run) => run.id !== "");
}

export function normalizeWarehouseConnections(
  raw: unknown,
): WarehouseConnection[] {
  return itemsOf(raw)
    .map((entry) => {
      const row = record(entry);
      return {
        id: str(row.id),
        name: str(row.name),
        provider: str(row.provider),
        direction: str(row.direction),
        status: str(row.status),
        cadence: str(row.cadence),
        error: str(row.error),
        lastCursor: str(row.last_cursor),
      };
    })
    .filter((connection) => connection.id !== "");
}

export function normalizeWarehouseConnectionHealth(
  raw: unknown,
): WarehouseConnectionHealth {
  const row = record(raw);
  return {
    connectionId: str(row.connection_id),
    provider: str(row.provider),
    status: str(row.status),
    health: str(row.health),
    lastRunStatus: str(row.last_run_status),
    lastRunAt: str(row.last_run_at),
    error: str(row.error),
    missingRequiredSettings: strList(row.missing_required_settings),
    warnings: strList(row.warnings),
    providerRuntimeStatus: str(row.provider_runtime_status),
    providerDriverAttachment: str(row.provider_driver_attachment),
  };
}

/** The three questions a phone asks of a run feed. */
export type WarehouseRunFilter = "all" | "failed" | "running";

/**
 * `failed` deliberately includes `cancelled` and `unknown`.
 *
 * The filter answers "show me what did not land", and a run that was cancelled
 * did not land either. Leaving cancelled out of the only filter an operator
 * reaches for is how a stuck scheduler hides in plain sight — while calling it
 * "failed" in the row's own pill would be a wrong verdict, which is why the
 * PILL still says `cancelled` and only the FILTER groups them.
 */
export function filterWarehouseRuns(
  runs: readonly WarehouseRun[],
  filter: WarehouseRunFilter,
): WarehouseRun[] {
  if (filter === "failed") {
    return runs.filter(
      (run) =>
        run.outcome === "failed" ||
        run.outcome === "cancelled" ||
        run.outcome === "unknown",
    );
  }
  if (filter === "running") {
    return runs.filter(
      (run) => run.outcome === "running" || run.outcome === "queued",
    );
  }
  return [...runs];
}

export interface WarehouseRunFilterCounts {
  all: number;
  failed: number;
  running: number;
}

export function warehouseRunFilterCounts(
  runs: readonly WarehouseRun[],
): WarehouseRunFilterCounts {
  return {
    all: runs.length,
    failed: filterWarehouseRuns(runs, "failed").length,
    running: filterWarehouseRuns(runs, "running").length,
  };
}

/**
 * A run's label, given the connection index.
 *
 * Falls back to the connection UUID's head rather than to a blank, and says
 * "deleted connection" out loud for the `ON DELETE SET NULL` orphan — a run
 * with no connection is not a run with an unknown name, it is a run whose
 * connection no longer exists.
 */
export function runConnectionLabel(
  run: WarehouseRun,
  connections: readonly WarehouseConnection[],
): string {
  if (!run.connectionId) return "Deleted connection";
  const match = connections.find(
    (connection) => connection.id === run.connectionId,
  );
  if (match?.name) return match.name;
  if (match?.provider) return match.provider;
  return `Connection ${run.connectionId.slice(0, 8)}`;
}
