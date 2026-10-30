/**
 * lib/connectionRowState.ts — what one provider-family row IS right now, and
 * what a family adds up to.
 *
 * ── WHY THIS EXISTS BESIDE connectionLifecycle ────────────────────────────
 * connectionLifecycle knows paused and failing. It does not know DISCONNECTED,
 * because the marketing list it was written against filters those rows out in
 * SQL (marketing_integrations/repo.go:46 `AND status <> 'disconnected'`). The
 * write-back list and all five families P2.39 adds do NOT filter
 * (integration_writeback/repo.go:47, analytics_integrations/repo.go:39, lead
 * :43, review :43, loyalty :45, subscription :43 — `WHERE tenant_id = $1`
 * only). So a disconnected analytics destination would have reached the
 * panel, been painted green, summarised as "Healthy.", and offered Sync — whose
 * only possible answer is 409 integration_disconnected (analytics
 * handlers.go:537-539, with the same guard in every sibling). Desktop hides
 * every verb on such a row (WritebackTargetsSection.tsx: "hide
 * Run/Pause/Disconnect so the row doesn't offer"); so does the CRM panel here.
 *
 * ── SERVER SENTENCES ─────────────────────────────────────────────────────
 * The families answer row-level refusals with a sentence worth reading — 422
 * payload_required "…no provider puller is wired for this provider", 409
 * integration_disconnected "…reconnect it before syncing" — and
 * errorPresentation collapses every 4xx it does not classify into "Something
 * went wrong". connectionVerbErrorMessage keeps the server's words for
 * exactly those verdicts and defers to the classified copy (401 / 403 / 404 /
 * 429 / 5xx / offline) everywhere else.
 *
 * Import-free of react-native, so it is node-tested.
 */
import {
  connectionIsFailing,
  connectionIsPaused,
  connectionSummary,
  connectionVerbs,
  type ConnectionRow,
  type ConnectionVerb,
} from "./connectionLifecycle";

export function connectionIsDisconnected(status: string): boolean {
  return status.trim().toLowerCase() === "disconnected";
}

export type ConnectionRowTone = "warning" | "success" | "neutral";

/** Pill tone. A disconnected row must never read as healthy. */
export function connectionRowTone(status: string): ConnectionRowTone {
  if (connectionIsFailing(status)) return "warning";
  if (connectionIsPaused(status) || connectionIsDisconnected(status)) {
    return "neutral";
  }
  return "success";
}

/** One line describing where the row stands, disconnected included. */
export function connectionRowSummary(row: ConnectionRow): string {
  if (connectionIsDisconnected(row.status)) {
    return "Disconnected. Reconnect it from the web admin before it can run again.";
  }
  return connectionSummary(row);
}

/** The family's verbs for this row — none at all once it is disconnected. */
export function connectionRowVerbs(
  available: readonly ConnectionVerb[],
  status: string,
): ConnectionVerb[] {
  if (connectionIsDisconnected(status)) return [];
  return connectionVerbs(available, status);
}

/**
 * Statuses errorPresentation already words well. Every other 4xx is a verdict
 * about THIS row or THIS request, and the server's sentence beats a generic one.
 */
const CLASSIFIED_STATUSES: ReadonlySet<number> = new Set([401, 403, 404, 429]);

/** The operator-facing sentence for a failed lifecycle verb. */
export function connectionVerbErrorMessage(
  error: unknown,
  fallback: string,
): string {
  if (!error || typeof error !== "object") return fallback;
  const { status, message } = error as { status?: unknown; message?: unknown };
  const code = typeof status === "number" ? status : 0;
  const text = typeof message === "string" ? message.trim() : "";
  if (code >= 400 && code < 500 && !CLASSIFIED_STATUSES.has(code) && text) {
    return text;
  }
  return fallback;
}

export interface ConnectionRollup {
  total: number;
  failing: number;
  paused: number;
  disconnected: number;
}

/**
 * Tally a family's rows. Tolerant of anything that is not an array, and of
 * rows whose provider or status the phone has never heard of — those count
 * toward the total and nothing else, because an unknown status is not a
 * failure and not a success.
 */
export function connectionRollup(rows: unknown): ConnectionRollup {
  const out: ConnectionRollup = { total: 0, failing: 0, paused: 0, disconnected: 0 };
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const raw = (row as { status?: unknown }).status;
    const status = typeof raw === "string" ? raw : "";
    out.total += 1;
    if (connectionIsFailing(status)) out.failing += 1;
    else if (connectionIsPaused(status)) out.paused += 1;
    else if (connectionIsDisconnected(status)) out.disconnected += 1;
  }
  return out;
}

/**
 * `3 destinations · 1 failing · 1 paused`. Zero clauses are omitted rather
 * than spoken — "0 failing" reads as an all-clear, and the roll-up only ever
 * summarises rows the list actually returned. Empty when there are none.
 */
export function rollupSentence(rollup: ConnectionRollup, noun: string): string {
  if (rollup.total <= 0) return "";
  const parts = [`${rollup.total} ${noun}${rollup.total === 1 ? "" : "s"}`];
  if (rollup.failing > 0) parts.push(`${rollup.failing} failing`);
  if (rollup.paused > 0) parts.push(`${rollup.paused} paused`);
  if (rollup.disconnected > 0) parts.push(`${rollup.disconnected} disconnected`);
  return parts.join(" · ");
}
