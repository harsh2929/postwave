/**
 * lib/savedReports.ts — the report-BUILDER's phone-shaped half.
 *
 * WHAT THIS IS NOT. Desktop's `ReportBuilderSection` is a metric picker, a
 * dimension picker, a filter grammar and a visualization chooser. Authoring a
 * metric definition on a phone is a bad idea and nothing here attempts it —
 * there is no create, no edit, no delete. `POST /api/v1/reporting/definitions`
 * is deliberately not called.
 *
 * WHAT IT IS. Running a definition somebody already authored, and getting its
 * output somewhere it can be sent on. That is the half a phone is good at.
 *
 * THE WIRE, read from Go rather than from openapi.json:
 *
 *   GET  /api/v1/reporting/definitions   ScopeReadReports  (reporting.go:126)
 *   GET  /api/v1/reporting/runs          ScopeReadReports  (:130)
 *   GET  /api/v1/reporting/runs/{id}/export.json
 *                                        ScopeReadReports  (:133)
 *   POST /api/v1/reporting/definitions/{id}/runs
 *                                        ScopeAdmin        (:129)
 *
 * `ScopeReadReports` IS in `readOnlyScopes` (apikeys/middleware.go:331-336),
 * so the three reads clear any role. `ScopeAdmin` is NOT, so on a session
 * cookie RUNNING is a hard owner|admin role check. Reading and running are
 * therefore gated separately, and the run control is absent — not disabled —
 * for anyone else.
 *
 * THE ONE THING A CALLER MUST NOT GET WRONG: the run is SYNCHRONOUS despite
 * its 202. `Repo.RunDefinition` (reporting/repo.go:234-270) executes the
 * preview inline and INSERTs the row with `status = 'completed'` and a real
 * `rows_total`; the handler then answers `202 Accepted` (reporting.go:247).
 * So the response body is a finished run, and a UI that said "queued" on the
 * strength of the status code would be describing work that is already done.
 * `runOutcome` exists so that reading is made once, here.
 *
 * BOTH LIST ROUTES PAGE WITH `pagination.Envelope`, i.e. `{items, nextCursor}`
 * — camelCase `nextCursor`, not `next_cursor` (pagination/cursor.go:175-179).
 * That inconsistency with the commerce lists is a real wire fact, not a typo.
 *
 * IMPORT-FREE except for `lib/direction`, which is itself import-free (the
 * layout direction is published into it at startup rather than read from
 * react-native) — so this module still runs under the node vitest
 * environment. The date-range label uses `transitionLabel` rather than a
 * baked-in arrow: a literal "→" points the wrong way once the layout mirrors,
 * and src/lib/direction.consistency.test.ts fails the build for it.
 */

import { transitionLabel } from "@/lib/direction";

export interface SavedReportDefinition {
  id: string;
  name: string;
  description: string;
  productArea: string;
  /** Verbatim server status ("active"/"draft"/…); "" when absent. */
  status: string;
  /** How many metrics the definition selects. */
  metricCount: number;
  /** Dimension keys, in the order the definition lists them. */
  dimensions: string[];
  /** Human window label derived from `time_range`; "" when unspecified. */
  window: string;
  updatedAt: string;
}

export interface SavedReportRun {
  id: string;
  definitionId: string;
  /** Verbatim server status: "completed" | "failed" | … */
  status: string;
  /** Server-side row count. Null when the field was absent, never 0. */
  rowsTotal: number | null;
  error: string;
  completedAt: string;
  createdAt: string;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isoOf(value: unknown): string {
  const raw = str(value);
  if (!raw) return "";
  return Number.isNaN(Date.parse(raw)) ? "" : raw;
}

function itemsOf(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const items = (payload as { items?: unknown }).items;
  return Array.isArray(items) ? items : [];
}

/**
 * A human label for the definition's window.
 *
 * `TimeRange` is a free-ish object on the wire; only the shapes the builder
 * actually writes are recognised, and anything else yields "" so the row omits
 * the line rather than printing `[object Object]`.
 */
export function windowLabel(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const range = raw as Record<string, unknown>;
  const preset = str(range.preset);
  if (preset) return preset.replace(/_/g, " ");
  const start = str(range.start) || str(range.from);
  const end = str(range.end) || str(range.to);
  if (start && end) return transitionLabel(start.slice(0, 10), end.slice(0, 10));
  const days = range.days;
  if (typeof days === "number" && Number.isFinite(days) && days > 0) {
    return `last ${Math.trunc(days)} days`;
  }
  return "";
}

export function parseDefinitions(payload: unknown): SavedReportDefinition[] {
  const out: SavedReportDefinition[] = [];
  for (const raw of itemsOf(payload)) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const id = str(row.id);
    if (!id) continue;
    out.push({
      id,
      // A definition with no name is shown by its id rather than as a blank
      // row — the id is at least something the operator can quote.
      name: str(row.name) || id,
      description: str(row.description),
      productArea: str(row.product_area),
      status: str(row.status),
      metricCount: Array.isArray(row.metrics) ? row.metrics.length : 0,
      dimensions: Array.isArray(row.dimensions)
        ? row.dimensions.map((d) => str(d)).filter(Boolean)
        : [],
      window: windowLabel(row.time_range),
      updatedAt: isoOf(row.updated_at),
    });
  }
  return out;
}

export function parseRuns(payload: unknown): SavedReportRun[] {
  const out: SavedReportRun[] = [];
  for (const raw of itemsOf(payload)) {
    const run = parseRun(raw);
    if (run) out.push(run);
  }
  return out;
}

export function parseRun(raw: unknown): SavedReportRun | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = str(row.id);
  if (!id) return null;
  return {
    id,
    definitionId: str(row.definition_id),
    status: str(row.status),
    rowsTotal:
      typeof row.rows_total === "number" && Number.isFinite(row.rows_total)
        ? Math.trunc(row.rows_total)
        : null,
    error: str(row.error),
    completedAt: isoOf(row.completed_at),
    createdAt: isoOf(row.created_at),
  };
}

/**
 * The most recent run for one definition.
 *
 * `GET /reporting/runs` is tenant-wide and ordered newest-first by the repo,
 * but the client must not RELY on that ordering for correctness: it picks the
 * newest by timestamp explicitly. Runs with no usable timestamp lose to any
 * run that has one, and win only if nothing else is available — an undated run
 * is not evidence that it is the latest.
 */
export function latestRunFor(
  runs: readonly SavedReportRun[],
  definitionId: string,
): SavedReportRun | null {
  let best: SavedReportRun | null = null;
  let bestAt = -Infinity;
  // for-of on a truthy non-array throws "is not iterable", and `runs` is wire
  // data reaching here through `runs.data ?? []` at the call site.
  for (const run of Array.isArray(runs) ? runs : []) {
    if (run.definitionId !== definitionId) continue;
    const stamp = run.completedAt || run.createdAt;
    const at = stamp ? Date.parse(stamp) : NaN;
    const score = Number.isNaN(at) ? -Infinity : at;
    if (best === null || score > bestAt) {
      best = run;
      bestAt = score;
    }
  }
  return best;
}

/** The one-line "what does this report select" summary. */
export function definitionSummary(def: SavedReportDefinition): string {
  const metrics = `${def.metricCount} ${def.metricCount === 1 ? "metric" : "metrics"}`;
  const parts = [metrics];
  if (def.dimensions.length > 0) {
    parts.push(`by ${def.dimensions.join(", ")}`);
  }
  if (def.window) parts.push(def.window);
  return parts.join(" · ");
}

/**
 * What the last run of a definition actually says.
 *
 * Never invents a zero: a definition that has never run says so, and a run
 * whose `rows_total` was absent says "row count not reported" rather than
 * claiming an empty result. A FAILED run leads with its error, because a
 * failed run that reports "0 rows" reads as a true empty answer.
 */
export function runOutcome(run: SavedReportRun | null): string {
  if (!run) return "Never run from here.";
  if (run.status && run.status !== "completed") {
    return run.error
      ? `Last run ${run.status}: ${run.error}`
      : `Last run ${run.status}.`;
  }
  if (run.rowsTotal === null) return "Last run completed; row count not reported.";
  return `Last run returned ${run.rowsTotal} ${run.rowsTotal === 1 ? "row" : "rows"}.`;
}

/**
 * The sentence shown after pressing Run.
 *
 * `RunDefinition` answers 202 with an ALREADY-COMPLETED run, so this must not
 * say "queued". A run that came back failed is reported as a failure even
 * though the transport succeeded — the handler returns the run row, not an
 * error status, precisely so the UI can do this.
 */
export function runToast(run: SavedReportRun | null): {
  kind: "success" | "error";
  message: string;
} {
  if (!run) {
    return {
      kind: "error",
      message: "The server accepted the run but returned no run record.",
    };
  }
  if (run.status && run.status !== "completed") {
    return {
      kind: "error",
      message: run.error
        ? `Run ${run.status}: ${run.error}`
        : `Run ${run.status}.`,
    };
  }
  if (run.rowsTotal === null) {
    return { kind: "success", message: "Run completed." };
  }
  return {
    kind: "success",
    message: `Run completed — ${run.rowsTotal} ${
      run.rowsTotal === 1 ? "row" : "rows"
    }.`,
  };
}

/**
 * Order for a phone: something that FAILED first, then most recently run,
 * then everything that has never run, then by name.
 *
 * The server orders definitions by authoring date, which is never the reason
 * somebody opens this on a phone.
 */
export function sortDefinitions(
  defs: readonly SavedReportDefinition[],
  runs: readonly SavedReportRun[],
): SavedReportDefinition[] {
  const rank = (def: SavedReportDefinition): number => {
    const run = latestRunFor(runs, def.id);
    if (run && run.status && run.status !== "completed") return 0;
    if (run) return 1;
    return 2;
  };
  const at = (def: SavedReportDefinition): number => {
    const run = latestRunFor(runs, def.id);
    const stamp = run?.completedAt || run?.createdAt || "";
    const parsed = stamp ? Date.parse(stamp) : NaN;
    return Number.isNaN(parsed) ? -Infinity : parsed;
  };
  // Array.isArray, not a nullish guard: a TRUTHY non-array payload passes
  // `?? []` at the call site and then throws here. Matches
  // sortIdempotencyKeys, which already guarded this way; api-keys shipped the
  // unguarded version as "Invalid attempt to spread non-iterable instance".
  const list: readonly SavedReportDefinition[] = Array.isArray(defs) ? defs : [];
  return [...list].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    const byRecency = at(b) - at(a);
    if (byRecency !== 0 && Number.isFinite(byRecency)) return byRecency;
    return a.name.localeCompare(b.name);
  });
}
