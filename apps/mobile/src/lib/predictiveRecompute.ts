/**
 * lib/predictiveRecompute.ts — reading what `POST /api/v1/predictive/recompute`
 * did (predictive.go:223, ADMIN / `admin` scope in routeauth/manifest.json).
 *
 * THE COVERAGE CARD ABOVE THIS ACTION IS A SNAPSHOT, AND SNAPSHOTS GO STALE.
 * `GET /api/v1/predictive/data-sufficiency` reads a rollup table that is only
 * written by a recompute (repo.go:457 `refreshSufficiencyRollup`), so an admin
 * looking at "we can only believe 4% of this model" on a phone had no way to
 * ask for a fresher answer. Desktop has had the button since
 * PredictiveAnalyticsSection.tsx:10.
 *
 * THE RUN IS SYNCHRONOUS AND ITS RESULT IS THE POINT. The handler returns the
 * `RunResult` (predictive.go:106) — the model run row plus the two write
 * counts — and every sentence this module produces is assembled from THOSE
 * fields. Nothing is derived, estimated or rounded into existence: the numbers
 * a user reads after pressing the button are the numbers the server wrote.
 *
 * `status` and `error` are the server's own strings and are rendered verbatim.
 * A run can complete with `status: "completed"` and still have scored nothing,
 * which is a real and important outcome — "0 profiles scored" is the honest
 * report, and a client that suppressed it would leave the reader believing a
 * recompute fixed a coverage number it could not have moved.
 *
 * Pure and free of react-native imports (house rule 6).
 */
import { num, plural } from "@/lib/format";

export interface PredictiveRun {
  /** Server status string, rendered verbatim: `completed`, `failed`, … */
  status: string;
  modelVersion: string;
  /** Days of history the run read. Null when unreported. */
  windowDays: number | null;
  scoredProfiles: number | null;
  insufficientProfiles: number | null;
  completedAt: string | null;
  /** The server's own error string; empty when the run carried none. */
  error: string;
}

export interface PredictiveRunResult {
  run: PredictiveRun;
  /** Prediction rows written. Null when unreported. */
  predictions: number | null;
  /** RFM score rows written. Null when unreported. */
  rfmScores: number | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function wholeCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.trunc(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Total parser: never throws, and never invents a count it was not given. */
export function parseRunResult(raw: unknown): PredictiveRunResult {
  const envelope = record(raw);
  const run = record(envelope?.run);
  return {
    run: {
      status: text(run?.status),
      modelVersion: text(run?.model_version),
      windowDays: wholeCount(run?.input_window_days),
      scoredProfiles: wholeCount(run?.scored_profiles),
      insufficientProfiles: wholeCount(run?.insufficient_profiles),
      completedAt: text(run?.completed_at) || null,
      error: text(run?.error),
    },
    predictions: wholeCount(envelope?.predictions),
    rfmScores: wholeCount(envelope?.rfm_scores),
  };
}

/**
 * What the run DID, in the server's numbers.
 *
 * A recompute that scored nothing still gets a sentence with its zero in it:
 * "the model was recomputed" without a count is the sentence that lets an
 * admin believe coverage improved when the run had no data to work with.
 * Unreported fields are omitted rather than printed as zero — the two are
 * different claims, and only one of them is the server's.
 */
export function runResultSummary(result: PredictiveRunResult): string {
  const parts: string[] = [];
  if (result.run.scoredProfiles !== null) {
    parts.push(`${plural(result.run.scoredProfiles, "profile")} scored`);
  }
  if (result.run.insufficientProfiles !== null) {
    parts.push(`${num(result.run.insufficientProfiles)} with too little data`);
  }
  if (result.predictions !== null) {
    parts.push(`${plural(result.predictions, "prediction")} written`);
  }
  if (result.rfmScores !== null) {
    parts.push(`${plural(result.rfmScores, "RFM score")} written`);
  }
  const status = result.run.status || "finished";
  if (parts.length === 0) {
    return `The run reported ${status} and returned no counts.`;
  }
  return `Run ${status}: ${parts.join(" · ")}.`;
}

/**
 * The window the run read, when it reported one. Separate from the summary
 * because it is the fact that explains a disappointing count — a 365-day
 * window cannot score a customer whose only order is older than that.
 */
export function runWindowNote(result: PredictiveRunResult): string | null {
  if (result.run.windowDays === null) return null;
  const version = result.run.modelVersion
    ? ` · model ${result.run.modelVersion}`
    : "";
  return `Read ${plural(result.run.windowDays, "day")} of history${version}.`;
}

/** The server's own failure string, when a completed run carried one. */
export function runErrorText(result: PredictiveRunResult): string | null {
  return result.run.error ? result.run.error : null;
}

/** The confirmation, which must state the cost and the scope of the write. */
export const RECOMPUTE_CONFIRM = {
  title: "Recompute the model?",
  body: "This rescores every customer profile in this workspace from the last year of orders, then rewrites the coverage rollup and the RFM bands on this card. It runs while you wait and can take a while on a large list.",
  confirmLabel: "Recompute",
} as const;

/** What a viewer is told instead of being shown a control they cannot use. */
export const RECOMPUTE_ROLE_NOTE =
  "Recomputing the model needs an admin role in this workspace.";

/**
 * The sentence for a failed request. A 403 is a PERMISSION RULE and must never
 * read as a fault: the route is admin-only in the manifest, and a session that
 * lost the role between render and press gets the same words the role gate
 * would have given it.
 */
export function recomputeFailureCopy(err: unknown): string {
  const status =
    typeof (err as { status?: unknown })?.status === "number"
      ? (err as { status: number }).status
      : 0;
  if (status === 403) return RECOMPUTE_ROLE_NOTE;
  if (status === 401) {
    return "Your session expired before the run started. Sign in and try again.";
  }
  const message =
    err instanceof Error && err.message ? err.message : "";
  return message || "Couldn't recompute the model.";
}
