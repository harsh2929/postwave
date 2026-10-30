/**
 * lib/aiRegressionRuns.ts — the regression EVIDENCE workspace.
 *
 *   GET /api/v1/ai-regression/runs              → {"items": RegressionRun[]}
 *   GET /api/v1/ai-regression/runs/{id}         → RegressionRun (bare object)
 *   GET /api/v1/ai-regression/runs/{id}/results → {"items": RegressionResult[]}
 *
 * All three are `read:reports` (viewer), so browsing history is not an admin
 * privilege — only changing it is.
 *
 * THE THREE SHAPES DIFFER and getting one wrong empties a screen silently: the
 * list and the results are `{items}` envelopes, the single run is the bare
 * object (handlers.go ListRuns / GetRun / GetRunResults). This module is the
 * only place that difference is encoded.
 *
 * A RESULT IS NOT A SCORE. severity is one of ok | warn | critical | error
 * (migration 0404's CHECK). `error` means the replay never produced an output
 * — fidelity_score is NULL — so it must never render as a zero, which would
 * read as "the model scored 0 on this example" rather than "this example was
 * not scored". The same distinction the run-level verdict makes in
 * lib/aiRegression, one level down.
 *
 * No react-native / expo import: vitest runs this in node.
 */
import type { RegressionRunWire } from "@/lib/aiRegression";

export interface SurfaceResultWire {
  total?: number;
  scored?: number;
  errors?: number;
  passed?: number;
  mean_score?: number | null;
  gate_result?: string;
}

export interface RegressionRunDetailWire extends RegressionRunWire {
  scored_examples?: number;
  error_examples?: number;
  hard_gate_enabled?: boolean;
  hard_gate_threshold?: number | null;
  min_examples_for_gate?: number;
  by_surface?: Record<string, SurfaceResultWire>;
  runtime_provider?: string;
}

export interface RegressionResultWire {
  id?: string;
  example_id?: string;
  surface_kind?: string;
  brief?: string;
  approved_output?: string;
  replayed_output?: string;
  fidelity_score?: number | null;
  severity?: string;
  error_code?: string;
  error_message?: string;
  scored_at?: string;
  attempt_count?: number;
}

function items(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    const list = (payload as { items?: unknown }).items;
    if (Array.isArray(list)) return list;
  }
  return [];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** `{items}` → runs. A row with no id cannot be opened, so it is dropped. */
export function parseRegressionRuns(
  payload: unknown,
): RegressionRunDetailWire[] {
  const out: RegressionRunDetailWire[] = [];
  for (const row of items(payload)) {
    const rec = record(row);
    if (!rec) continue;
    if (typeof rec.id !== "string" || !rec.id.trim()) continue;
    out.push(rec as RegressionRunDetailWire);
  }
  return out;
}

/** GetRun answers the BARE run object, not an envelope. */
export function parseRegressionRunDetail(
  payload: unknown,
): RegressionRunDetailWire | null {
  const rec = record(payload);
  if (!rec) return null;
  if (typeof rec.id !== "string" || !rec.id.trim()) return null;
  return rec as RegressionRunDetailWire;
}

/** `{items}` → per-example results. */
export function parseRegressionResults(
  payload: unknown,
): RegressionResultWire[] {
  const out: RegressionResultWire[] = [];
  for (const row of items(payload)) {
    const rec = record(row);
    if (!rec) continue;
    out.push(rec as RegressionResultWire);
  }
  return out;
}

export type ResultTone = "success" | "warning" | "danger" | "neutral";

export interface ResultPresentation {
  /** Stable key for a list — falls back to the example id, then the ordinal. */
  key: string;
  surface: string;
  label: string;
  tone: ResultTone;
  /** "84 / 100", or null when this example produced no score. */
  score: string | null;
  /** The reason line: the server's error message, or the brief. */
  detail: string;
  /** True when the replay never produced an output at all. */
  errored: boolean;
}

/**
 * severity drives the reading, not the score: an `error` row has a NULL
 * fidelity_score and must say "not scored" rather than showing a 0.
 */
export function resultPresentation(
  row: RegressionResultWire,
  index: number,
  surfaceLabel: (value: unknown) => string,
): ResultPresentation {
  const severity = (row.severity ?? "").trim().toLowerCase();
  const rawScore = row.fidelity_score;
  const hasScore = typeof rawScore === "number" && Number.isFinite(rawScore);
  const errored = severity === "error" || !hasScore;

  let label = "Not scored";
  let tone: ResultTone = "neutral";
  if (severity === "ok") {
    label = "OK";
    tone = "success";
  } else if (severity === "warn") {
    label = "Warn";
    tone = "warning";
  } else if (severity === "critical") {
    label = "Critical";
    tone = "danger";
  } else if (severity === "error") {
    label = "Replay failed";
    tone = "danger";
  }

  const detail =
    row.error_message?.trim() ||
    (severity === "error"
      ? "The replay produced no output, so this example has no score."
      : row.brief?.trim() || "No brief recorded for this example.");

  const key =
    (typeof row.id === "string" && row.id.trim()) ||
    (typeof row.example_id === "string" && row.example_id.trim()) ||
    `result-${index}`;

  return {
    key,
    surface: surfaceLabel(row.surface_kind),
    label,
    tone,
    score: hasScore ? `${Math.round(rawScore)} / 100` : null,
    detail,
    errored,
  };
}

export interface SurfaceLine {
  surface: string;
  /** "4 of 5 passed · 1 not scored" — the denominator is never inflated. */
  summary: string;
  score: string | null;
}

/**
 * by_surface is the run's own aggregation. `errors` are counted separately
 * from `passed`/`scored` because an unscored example is not a failure of the
 * model — it is missing evidence, and the run-level gate treats it that way.
 */
export function runSurfaceLines(
  run: RegressionRunDetailWire | null,
  surfaceLabel: (value: unknown) => string,
): SurfaceLine[] {
  const map = run?.by_surface;
  if (!map || typeof map !== "object" || Array.isArray(map)) return [];
  const out: SurfaceLine[] = [];
  for (const key of Object.keys(map)) {
    const rec = record(map[key]);
    if (!rec) continue;
    const total = typeof rec.total === "number" ? rec.total : 0;
    const passed = typeof rec.passed === "number" ? rec.passed : 0;
    const errors = typeof rec.errors === "number" ? rec.errors : 0;
    const mean = rec.mean_score;
    const parts = [`${passed} of ${total} passed`];
    if (errors > 0) parts.push(`${errors} not scored`);
    out.push({
      surface: surfaceLabel(key),
      summary: parts.join(" · "),
      score:
        typeof mean === "number" && Number.isFinite(mean)
          ? `${Math.round(mean)} / 100`
          : null,
    });
  }
  return out.sort((a, b) => a.surface.localeCompare(b.surface));
}

/**
 * The one-line identity of a run in the history list. The model version tag is
 * the OPERATOR's label and the only thing that distinguishes two runs of the
 * same model, so it leads.
 */
export function runHistoryTitle(run: RegressionRunDetailWire): string {
  const tag =
    typeof run.model_version_tag === "string" ? run.model_version_tag.trim() : "";
  if (tag) return tag;
  const model = typeof run.model_id === "string" ? run.model_id.trim() : "";
  return model || "Untitled run";
}

/** "12 examples · 3 not scored", built only from counts the run reports. */
export function runHistoryCounts(run: RegressionRunDetailWire): string | null {
  const total = typeof run.total_examples === "number" ? run.total_examples : 0;
  if (total <= 0) return null;
  const errors =
    typeof run.error_examples === "number" ? run.error_examples : 0;
  const parts = [total === 1 ? "1 example" : `${total} examples`];
  if (errors > 0) parts.push(`${errors} not scored`);
  return parts.join(" · ");
}

/** Reads are `read:reports`. */
export function regressionRunsErrorMessage(
  status: number,
  fallback?: string | undefined,
): string {
  if (status === 403) {
    return "Regression history needs reporting access. Ask an admin.";
  }
  if (status === 404) {
    return "That regression run no longer exists.";
  }
  if (status === 405 || status === 501) {
    return "This deployment doesn't run the AI regression harness.";
  }
  return fallback?.trim() || "Couldn't load the regression history.";
}
