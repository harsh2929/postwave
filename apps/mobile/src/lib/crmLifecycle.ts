/**
 * lib/crmLifecycle.ts — which CRM connection verbs are legal right now.
 *
 * ── THE GAP ────────────────────────────────────────────────────────────────
 * INTEG#2: mobile had no CRM lifecycle client at all — zero hits for "api/v1/crm"
 * anywhere under apps/mobile. So when a CRM sync started failing, the phone could
 * see the integration was unhealthy (the connections feed reports health) and could
 * not retry it, pause it, resume it or disconnect it, nor read why it failed. That
 * is the 2am case the whole audit is about.
 *
 * ── THE SERVER'S ACTUAL RULES ──────────────────────────────────────────────
 * Every mutating route is `admin` and `review_status: reviewed`
 * (crm_integrations/handlers.go:113-118), so the floor is unambiguous for once.
 *
 * `disconnected` is the ONE hard guard, and it is enforced twice: the handlers
 * short-circuit with 409 `integration_disconnected` at seven call sites via
 * crmIntegrationDisconnected (handlers.go:94-96), and the pause/resume UPDATE itself
 * carries `AND status <> 'disconnected'` (repo.go:1053). Everything else — active,
 * connected, paused, error — accepts the verbs.
 *
 * So the client rule is small and exact: a disconnected row gets no verbs, and the
 * pause/resume pair is chosen by current state rather than offered as both. The
 * point is the same as everywhere else in this app — never render a control whose
 * only possible outcome is a 409.
 *
 * Import-free of react-native, so it is node-tested.
 */

/** Statuses the server writes (repo.go:1019, :347, :1091). */
export type CrmStatus =
  | "active"
  | "connected"
  | "paused"
  | "error"
  | "disconnected";

export type CrmVerb = "sync" | "backfill" | "pause" | "resume" | "disconnect";

export interface CrmIntegrationRow {
  id: string;
  provider: string;
  name: string;
  status: string;
  lastSyncAt: string;
  errorMessage: string;
}

function normalized(status: string): string {
  return status.trim().toLowerCase();
}

/** True when the server would refuse every lifecycle verb. */
export function crmIsDisconnected(status: string): boolean {
  return normalized(status) === "disconnected";
}

/** True when the row is in the paused state, so Resume is the useful verb. */
export function crmIsPaused(status: string): boolean {
  return normalized(status) === "paused";
}

/**
 * The verbs to offer, in the order they should read.
 *
 * Disconnect is last and always present for a live row: it is the destructive one,
 * and putting it first invites a mis-tap in exactly the hurried situation this
 * screen exists for.
 */
export function crmVerbsFor(status: string): CrmVerb[] {
  if (crmIsDisconnected(status)) return [];
  const resumeOrPause: CrmVerb = crmIsPaused(status) ? "resume" : "pause";
  // A paused row should not offer Sync: the server would accept it (the guard is
  // only `disconnected`), but running a one-off sync against a connection the
  // operator has deliberately halted is a surprise, not a feature.
  if (crmIsPaused(status)) return [resumeOrPause, "disconnect"];
  return ["sync", "backfill", resumeOrPause, "disconnect"];
}

export const CRM_VERB_LABELS: Readonly<Record<CrmVerb, string>> = {
  sync: "Sync now",
  backfill: "Backfill",
  pause: "Pause",
  resume: "Resume",
  disconnect: "Disconnect",
};

/** Verbs that need a confirmation before they run. */
export function crmVerbIsDestructive(verb: CrmVerb): boolean {
  return verb === "disconnect";
}

/** What a row's state means, in one line. */
export function crmStatusSummary(row: CrmIntegrationRow): string {
  if (crmIsDisconnected(row.status)) {
    return "Disconnected. Reconnect it from the web admin before it can sync again.";
  }
  if (crmIsPaused(row.status)) {
    return "Paused. Nothing syncs until it is resumed.";
  }
  if (normalized(row.status) === "error") {
    return row.errorMessage
      ? `Failing — ${row.errorMessage}`
      : "Failing. The provider rejected the last sync.";
  }
  return row.lastSyncAt ? `Active. Last synced ${row.lastSyncAt}.` : "Active.";
}

/** The operator-facing sentence for a failed lifecycle call. */
export function crmVerbErrorMessage(code: string, fallback: string): string {
  switch (code) {
    case "integration_disconnected":
      return "This connection was disconnected. Reconnect it from the web admin first.";
    case "not_found":
      return "This connection no longer exists — it may have been removed elsewhere.";
    default:
      return fallback;
  }
}
