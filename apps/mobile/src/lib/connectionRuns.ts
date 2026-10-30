/**
 * lib/connectionRuns.ts — one shape for a provider family's run history.
 *
 * ── THE GAP (P2.40, and the run half of P2.39) ───────────────────────────
 * The phone could re-run a write-back target and could not see whether the
 * last run failed or why; the five non-CRM provider families were not read at
 * all. Every family in CONNECTION_FAMILIES exposes GET {base}/{id}/runs at the
 * LIST's floor (ScopeReadReports — integration_writeback/handlers.go:69,
 * analytics_integrations/handlers.go:199, lead :140, review :258, loyalty :217,
 * subscription :103, marketing :113), so a viewer who can see a row is failing
 * can also see the run that failed it. The handlers are byte-for-byte alike:
 * `Repo.ListRuns(..., queryInt(r, "limit", 25))` → `{items: [...]}`.
 *
 * ── WHY THE COUNTERS ARE READ GENERICALLY ────────────────────────────────
 * The ROW differs per family (each package's types.go `SyncRun` / `Run`):
 *   write-back    members_seen · matched · tags_written · fields_written
 *   analytics     profiles_seen · profiles_upserted · events_seen · events_tracked
 *   lead          submissions_seen · subscribers_upserted · events_tracked
 *   review        reviews_seen · reviews_imported · profiles_upserted · events_tracked
 *   loyalty       members_seen · members_upserted · events_seen · events_tracked
 *   subscription  subscriptions_seen · subscriptions_upserted · shipments_seen · …
 * Six hand-written parsers would be six places to drift. Instead every
 * top-level integer whose name carries a counting suffix becomes a labelled
 * figure, in the server's own order and the server's own words ("tags
 * written"). Nothing is renamed, summed or inferred: the phone renders exactly
 * the numbers the run recorded, and a family added later gets its counters
 * for free.
 *
 * `rows_failed` is pulled out on its own because it changes the row's meaning
 * — a run that "completed" with 40 failed rows is not an all-clear — and
 * `error_message` is kept verbatim: it is the reason to open this at all.
 *
 * Import-free of react-native, so it is node-tested.
 */
import { num } from "./format";

export interface RunCount {
  /** The server's field name, e.g. `tags_written`. */
  key: string;
  /** That name as words, e.g. `tags written`. Never invented. */
  label: string;
  value: number;
}

export interface ConnectionRun {
  id: string;
  /** The runners write `completed`, `partial` or `failed`. */
  status: string;
  runMode: string;
  startedAt: string;
  completedAt: string;
  rowsFailed: number;
  errorMessage: string;
  counts: RunCount[];
}

/**
 * The counting suffixes the families' run rows use, plus write-back's bare
 * `matched`. `rows_failed` is excluded by name before this is consulted.
 */
const COUNT_KEY =
  /(^matched$|_(seen|upserted|written|tracked|imported|synced|matched)$)/;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/** The labelled counters of one raw run row, in the payload's own order. */
export function runCounts(raw: Record<string, unknown>): RunCount[] {
  const out: RunCount[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (key === "rows_failed" || !COUNT_KEY.test(key)) continue;
    const n = integer(value);
    if (n === null) continue;
    out.push({ key, label: key.replace(/_/g, " "), value: n });
  }
  return out;
}

/** Parse `{items: [...]}` (what every family's ListRuns writes) or a bare array. */
export function parseConnectionRuns(payload: unknown): ConnectionRun[] {
  const rows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object"
      ? ((payload as Record<string, unknown>).items ??
        (payload as Record<string, unknown>).runs)
      : null;
  if (!Array.isArray(rows)) return [];
  const out: ConnectionRun[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const id = text(row.id);
    // A run with no id cannot be keyed; dropping it beats a duplicate-key ghost.
    if (!id) continue;
    out.push({
      id,
      status: text(row.status),
      runMode: text(row.run_mode),
      startedAt: text(row.started_at),
      completedAt: text(row.completed_at),
      rowsFailed: integer(row.rows_failed) ?? 0,
      errorMessage: text(row.error_message),
      counts: runCounts(row),
    });
  }
  return out;
}

/**
 * Pill tone for ONE run. `partial` is a WARNING, not a success: some rows were
 * rejected. Anything unrecognised also warns — an unknown status is not
 * evidence of success, the same rule syncJobTone applies to destination jobs.
 */
export function runTone(
  status: string,
): "success" | "warning" | "danger" | "neutral" {
  switch (status.trim().toLowerCase()) {
    case "completed":
      return "success";
    case "partial":
      return "warning";
    case "failed":
      return "danger";
    case "running":
    case "queued":
    case "pending":
      return "neutral";
    default:
      return "warning";
  }
}

/**
 * The counters line: `12 members seen · 10 matched · 4 tags written · 2 failed`.
 * Empty when the row carried no counters at all (a malformed payload) — the
 * caller decides what an absence says; this never invents a "0".
 */
export function runCountsLine(run: ConnectionRun): string {
  const parts = run.counts.map((c) => `${num(c.value)} ${c.label}`);
  if (run.rowsFailed > 0) parts.push(`${num(run.rowsFailed)} failed`);
  return parts.join(" · ");
}

/**
 * The spoken form of one run, for VoiceOver: status and mode, when it started
 * (absolute — the caller formats it), the counters, and the server's error
 * sentence verbatim.
 */
export function runSpoken(run: ConnectionRun, startedAt: string): string {
  const parts = [
    `${run.status || "unknown"} run, ${run.runMode || "unknown mode"}, started ${startedAt}.`,
  ];
  const counts = runCountsLine(run);
  if (counts) parts.push(`${counts}.`);
  if (run.errorMessage) parts.push(run.errorMessage);
  return parts.join(" ");
}
