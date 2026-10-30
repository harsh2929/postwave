/**
 * lib/connectionLifecycle.ts — one shape for the provider families that share a
 * run/pause/resume/disconnect lifecycle.
 *
 * ── WHY A SHARED MODULE AND NOT A THIRD COPY ───────────────────────────────
 * INTEG#3 (reverse-ETL write-back targets) and INTEG#5 (Klaviyo-native marketing
 * provider rows) both had zero mobile references, and both answer the same operator
 * question — "this thing stopped working, can I retry it, hold it, or drop it?" —
 * over routes that differ only in their base path and their verb set:
 *
 *   integration-writeback/targets/{id}   run · pause · resume · DELETE
 *   marketing-integrations/{id}          sync · backfill · pause · DELETE
 *
 * The CRM family (INTEG#2) has its own module because its rules are genuinely
 * different: a hard `disconnected` guard enforced in seven handlers and in SQL,
 * and a pause/resume pair. These two have no such guard, so pretending they share
 * one policy would have been the wrong abstraction.
 *
 * ── ROLE ───────────────────────────────────────────────────────────────────
 * In both families the LIST is `apikeys.RequireScope(ScopeReadReports)` and every
 * mutation is `ScopeAdmin` (integration_writeback/handlers.go:61-68,
 * marketing_integrations/handlers.go:104-113). The generated manifest rows for both
 * are `review_status: fail_closed_default` — auto-generated and unreviewed — so the
 * HANDLER is the authority here, not the manifest. They agree, but only the handler
 * was checked.
 *
 * Import-free of react-native, so it is node-tested.
 */

export type ConnectionVerb =
  | "run"
  | "sync"
  | "backfill"
  | "pause"
  | "resume"
  | "disconnect";

export interface ConnectionRow {
  id: string;
  name: string;
  status: string;
  lastRunAt: string;
  errorMessage: string;
}

export const CONNECTION_VERB_LABELS: Readonly<Record<ConnectionVerb, string>> = {
  run: "Run now",
  sync: "Sync now",
  backfill: "Backfill",
  pause: "Pause",
  resume: "Resume",
  disconnect: "Disconnect",
};

/** Disconnect is the only irreversible one; the rest are retryable. */
export function connectionVerbIsDestructive(verb: ConnectionVerb): boolean {
  return verb === "disconnect";
}

function normalized(status: string): string {
  return status.trim().toLowerCase();
}

export function connectionIsPaused(status: string): boolean {
  return normalized(status) === "paused";
}

export function connectionIsFailing(status: string): boolean {
  const value = normalized(status);
  return value === "error" || value === "failed" || value === "failing";
}

/**
 * The verbs to offer for a row, given the family's full verb set.
 *
 * `resume` is shown only when the row is paused, and the pausing verb only when it
 * is not — never both, which would let an operator queue two contradictory
 * requests against one row. A family with no `resume` route (marketing) simply
 * keeps `pause` available, because that is what its server offers; inventing a
 * resume button there would be a control with no endpoint behind it.
 *
 * Disconnect is always last: these panels are read in a hurry.
 */
export function connectionVerbs(
  available: readonly ConnectionVerb[],
  status: string,
): ConnectionVerb[] {
  const paused = connectionIsPaused(status);
  const hasResume = available.includes("resume");
  const out = available.filter((verb) => {
    if (verb === "disconnect") return false;
    if (verb === "resume") return paused;
    if (verb === "pause") return !paused;
    // Running or syncing a row the operator deliberately paused is a surprise,
    // but only when the family can actually un-pause it. Without a resume route,
    // hiding the run verb would leave a paused row with nothing to do at all.
    if (paused && hasResume) return false;
    return true;
  });
  if (available.includes("disconnect")) out.push("disconnect");
  return out;
}

/** One line describing where the row stands. */
export function connectionSummary(row: ConnectionRow): string {
  if (connectionIsPaused(row.status)) {
    return "Paused. Nothing runs until it is resumed.";
  }
  if (connectionIsFailing(row.status)) {
    return row.errorMessage
      ? `Failing — ${row.errorMessage}`
      : "Failing. The provider rejected the last run.";
  }
  return row.lastRunAt ? `Healthy. Last run ${row.lastRunAt}.` : "Healthy.";
}

/** Parse a provider row from either family; both use the same field names. */
export function parseConnectionRows(payload: unknown): ConnectionRow[] {
  const rows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object"
      ? ((payload as Record<string, unknown>).items ??
          (payload as Record<string, unknown>).targets ??
          (payload as Record<string, unknown>).integrations)
      : null;
  if (!Array.isArray(rows)) return [];
  const out: ConnectionRow[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const text = (value: unknown) =>
      typeof value === "string" ? value.trim() : "";
    const id = text(row.id);
    // A row with no id cannot be acted on; every control would throw.
    if (!id) continue;
    out.push({
      id,
      name: text(row.name) || text(row.provider) || "Connection",
      status: text(row.status),
      lastRunAt: text(row.last_run_at) || text(row.last_sync_at),
      errorMessage: text(row.error_message) || text(row.last_error),
    });
  }
  return out;
}
