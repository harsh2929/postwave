/**
 * analytics-nlq — pure logic behind AnalyticsNlqBar. Lives in a .ts
 * module (not the .tsx component) so the node-environment vitest
 * suite can import it without a JSX transform (same pattern as
 * grouped-series).
 *
 * The NLQ endpoint translates an English question into ONE of a fixed
 * set of saved query templates server-side — it never free-forms SQL.
 * The bar therefore always shows the resolved template + params back
 * to the operator ("interpreted as …") so there's no hidden LLM black
 * box between the question and the numbers (same honesty rule as the
 * audit NLQ bar).
 */

import type { AnalyticsNlqResponse, ApiErr } from "../../lib/api-client";

/* ---------- progress copy -------------------------------------------- */

/**
 * Staged progress copy for the in-flight state. The call is
 * LLM-backed with a 60 s budget (LLM_REQUEST_OPTS), so a static
 * "Loading…" reads like a hang after a few seconds — the copy
 * advances to set expectations honestly instead.
 */
export const NLQ_PROGRESS_STAGES: ReadonlyArray<{
  afterMs: number;
  copy: string;
}> = [
  { afterMs: 0, copy: "Asking Claude…" },
  {
    afterMs: 4_000,
    copy: "Translating your question into a saved analytics query…",
  },
  {
    afterMs: 15_000,
    copy: "Still running — wide windows can take up to a minute…",
  },
];

/** Latest stage whose threshold has elapsed. */
export function nlqProgressCopy(elapsedMs: number): string {
  let copy = NLQ_PROGRESS_STAGES[0]?.copy ?? "Asking Claude…";
  for (const stage of NLQ_PROGRESS_STAGES) {
    if (elapsedMs >= stage.afterMs) copy = stage.copy;
  }
  return copy;
}

/* ---------- error mapping --------------------------------------------- */

/**
 * Map the typed NLQ error envelope to honest operator-facing copy.
 *
 * - 422 invalid_template: the LLM couldn't land on a known template —
 *   the fix is a rephrase, not a retry, so say exactly that.
 * - 429 cost_cap_exceeded: per-tenant daily token budget spent;
 *   resets at UTC midnight (server behaviour, mirrored from the
 *   audit NLQ surface).
 * - 503 nlq_unavailable: the API runs without an ANTHROPIC_API_KEY —
 *   permanent until an operator configures it, not transient.
 */
export function nlqErrorMessage(e: ApiErr["error"]): string {
  if (e.code === "invalid_template") {
    return (
      "Couldn't map that question to a known analytics query — try " +
      'rephrasing (e.g. "top campaigns by revenue in the last 30 days").'
    );
  }
  if (e.code === "cost_cap_exceeded") {
    return "Daily AI budget for this workspace is spent — resets at UTC midnight.";
  }
  if (e.code === "nlq_unavailable") {
    return "AI answers aren't configured on this server — the API is running without an Anthropic key.";
  }
  if (e.kind === "timeout") {
    return "The question timed out — try again, or ask about a narrower window.";
  }
  return e.message || "The AI query failed.";
}

/** True when the server says NLQ can never work on this deployment —
 *  the bar collapses to a one-line explainer instead of re-offering a
 *  permanently broken input. */
export function isNlqUnavailable(e: ApiErr["error"]): boolean {
  return e.code === "nlq_unavailable";
}

/* ---------- "interpreted as" line -------------------------------------- */

/**
 * The honest line under every answer: which saved template the
 * question resolved to and with which params — i.e. what was ACTUALLY
 * queried, which may be narrower than what was asked.
 */
export function interpretedAsLine(
  r: Pick<AnalyticsNlqResponse, "template" | "params">,
): string {
  return `Interpreted as: ${r.template} · last ${r.params.window_days} days · limit ${r.params.limit}`;
}

/* ---------- table cell formatting -------------------------------------- */

/**
 * Render one table cell from the loosely-typed NLQ rows
 * (`Record<string, unknown>` keyed by the response's `columns`).
 * Missing/null → an explicit "—" rather than an empty cell.
 */
export function nlqCellText(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "number") {
    return Number.isInteger(v)
      ? v.toLocaleString()
      : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Humanise a snake_case column name for the table header. */
export function nlqColumnLabel(col: string): string {
  return col.replace(/_/g, " ");
}
