/**
 * lib/integrationHealth.ts — parsing GET /api/v1/integrations/{slug}/health.
 *
 * WHY THIS EXISTS. The integrations list answers "is anything broken"; it
 * cannot answer the next question, which is the one an operator actually has
 * at 3am: *why*, *when did it last try*, and *is it going to try again on its
 * own*. All three are already on the wire and mobile was throwing the whole
 * response away because it never asked for it.
 *
 * WHAT IS AND IS NOT ACTIONABLE HERE. `GET /{slug}/health` is a READ mounted
 * under the same `read:reports` scope the list already uses
 * (apps/api/internal/integrations/handlers.go:189). The four WRITE routes on
 * the same resource — sync / backfill / pause / disconnect — all funnel into
 * `h.action(...)`, whose handler sets `resp.DelegatedTo` to a *different*
 * endpoint on a different service (handlers.go:660-712) rather than performing
 * the action. That is why this module exposes a health READ and no "retry
 * sync" button: the button would post successfully and do nothing, which is
 * worse than not offering it.
 *
 * The Go structs this mirrors are `HealthReport` (handlers.go:159-170),
 * `HealthCheck` (:122-127), `RetryPolicy` (:129-135) and `SyncHistoryEntry`
 * (:137-144). Every field is optional on the wire (`omitempty` on several) and
 * `sync_history` is absent entirely when the tenant has no runtime rows, so
 * nothing here trusts a shape.
 *
 * DELIBERATELY IMPORT-FREE, like `approvalPolicy` / `chartScale` / `typeScale`:
 * the vitest run is a NODE environment, so a module that transitively reaches
 * react-native cannot be tested. The wire call lives in `api/integrations.ts`
 * and the React wiring in `hooks/useIntegrations.ts`.
 */

/** Server-side severity, narrowed. Unknown values degrade to "warning". */
export type HealthSeverity = "ok" | "warning" | "error" | "info";

export interface IntegrationHealthCheck {
  key: string;
  label: string;
  /** "ok" | "warning" | "error" | "info", already narrowed. */
  state: HealthSeverity;
  message: string;
}

export interface IntegrationSyncAttempt {
  /** ISO timestamp, or empty when the server sent none. */
  at: string;
  action: string;
  status: string;
  attempts: number;
  message: string;
  error: string;
}

export interface IntegrationRetryPolicy {
  mode: string;
  maxAttempts: number;
  backoff: string;
  deadLetter: string;
  idempotency: string;
}

export interface IntegrationHealth {
  state: string;
  severity: HealthSeverity;
  message: string;
  monitoringSurface: string;
  /** Only ever an absolute https URL, or null. */
  docsUrl: string | null;
  checks: IntegrationHealthCheck[];
  retryPolicy: IntegrationRetryPolicy | null;
  syncHistory: IntegrationSyncAttempt[];
}

/**
 * How many attempts to render. The endpoint is uncapped; a phone card showing
 * fifty rows is a scroll trap, and the useful signal (did the most recent
 * attempts fail, and how many times did it retry) is in the first few.
 */
export const SYNC_HISTORY_CAP = 5;

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

/**
 * Narrow a server severity. An UNKNOWN value must never resolve to "ok" — a
 * new server state reading as an all-clear is the one failure mode of this
 * mapping that costs someone an outage, so anything unrecognised is a warning.
 */
export function narrowSeverity(value: unknown): HealthSeverity {
  const s = str(value).toLowerCase();
  if (s === "ok") return "ok";
  if (s === "error") return "error";
  if (s === "info") return "info";
  return "warning";
}

/**
 * Docs links are provider documentation on third-party hosts, so unlike
 * `manage_path` they are legitimately cross-origin. They still must be an
 * absolute `https:` URL before they can reach `Linking.openURL` — an
 * attacker-controlled `javascript:` or a custom scheme is not a doc.
 */
export function safeDocsUrl(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  return parsed.toString();
}

function normalizeChecks(value: unknown): IntegrationHealthCheck[] {
  if (!Array.isArray(value)) return [];
  const out: IntegrationHealthCheck[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const row = (value[i] ?? {}) as Record<string, unknown>;
    const label = str(row.label);
    const message = str(row.message);
    // A check with neither a label nor a message says nothing; dropping it
    // keeps the panel from rendering blank rows for padding entries.
    if (!label && !message) continue;
    out.push({
      key: str(row.key) || `check-${i}`,
      label: label || str(row.key) || "Check",
      state: narrowSeverity(row.state),
      message,
    });
  }
  return out;
}

function normalizeHistory(value: unknown): IntegrationSyncAttempt[] {
  if (!Array.isArray(value)) return [];
  const out: IntegrationSyncAttempt[] = [];
  for (const entry of value) {
    const row = (entry ?? {}) as Record<string, unknown>;
    const action = str(row.action);
    const status = str(row.status);
    const message = str(row.message);
    const error = str(row.error);
    if (!action && !status && !message && !error) continue;
    out.push({
      at: str(row.at),
      action: action || "sync",
      status: status || "unknown",
      attempts: int(row.attempts),
      message,
      error,
    });
  }
  return out;
}

function normalizeRetryPolicy(value: unknown): IntegrationRetryPolicy | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const policy: IntegrationRetryPolicy = {
    mode: str(row.mode),
    maxAttempts: int(row.max_attempts),
    backoff: str(row.backoff),
    deadLetter: str(row.dead_letter),
    idempotency: str(row.idempotency),
  };
  // The Go struct is a value, not a pointer, so it is ALWAYS present in the
  // JSON — as an object of empty strings and zeroes for surfaces that have no
  // retry story. Rendering that is a card that says nothing five times.
  const empty =
    !policy.mode &&
    !policy.backoff &&
    !policy.deadLetter &&
    !policy.idempotency &&
    policy.maxAttempts === 0;
  return empty ? null : policy;
}

/** Project the health payload onto what the card renders. Never throws. */
export function normalizeIntegrationHealth(payload: unknown): IntegrationHealth {
  const row = (payload && typeof payload === "object" ? payload : {}) as Record<
    string,
    unknown
  >;
  return {
    state: str(row.state),
    severity: narrowSeverity(row.severity),
    message: str(row.message),
    monitoringSurface: str(row.monitoring_surface),
    docsUrl: safeDocsUrl(row.docs_url),
    checks: normalizeChecks(row.checks),
    retryPolicy: normalizeRetryPolicy(row.retry_policy),
    syncHistory: normalizeHistory(row.sync_history).slice(0, SYNC_HISTORY_CAP),
  };
}

/**
 * True when a health report carries nothing worth a panel. Distinguishing this
 * from "not loaded" is what keeps the card from rendering an empty box under
 * an integration whose surface simply has no checks.
 */
export function isEmptyHealth(health: IntegrationHealth): boolean {
  return (
    health.checks.length === 0 &&
    health.syncHistory.length === 0 &&
    health.retryPolicy === null &&
    !health.message
  );
}

/**
 * One-line summary of the retry story, for the panel and for VoiceOver.
 * Returns "" when there is nothing to say, so the caller can skip the row.
 */
export function retryPolicySummary(
  policy: IntegrationRetryPolicy | null,
): string {
  if (!policy) return "";
  const parts: string[] = [];
  if (policy.mode) parts.push(policy.mode);
  if (policy.maxAttempts > 0) {
    parts.push(
      `${policy.maxAttempts} attempt${policy.maxAttempts === 1 ? "" : "s"}`,
    );
  }
  if (policy.backoff) parts.push(`${policy.backoff} backoff`);
  return parts.join(" · ");
}

/**
 * Spoken sentence for one attempt row. Assistive tech gets the whole fact in
 * one utterance rather than four orphaned fragments, and the attempt count is
 * expanded ("3 attempts", not a bare "3" beside an unrelated word).
 */
export function syncAttemptSpoken(
  attempt: IntegrationSyncAttempt,
  when: string,
): string {
  const parts = [`${attempt.action}, ${attempt.status}`];
  if (when) parts.push(when);
  if (attempt.attempts > 1) parts.push(`${attempt.attempts} attempts`);
  if (attempt.error) parts.push(attempt.error);
  else if (attempt.message) parts.push(attempt.message);
  return `${parts.join(". ")}.`;
}
