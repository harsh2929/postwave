/**
 * api/settingsExtras.ts — settings surfaces the mobile app never had a client
 * for, despite every endpoint already shipping.
 *
 *   - Dashboard digest (GET/PUT /api/v1/dashboard/digest). Desktop renders a
 *     DigestPrefsSection against this; mobile's NotificationPreferencesSection
 *     covers a different, coarser control, so digest cadence could not be tuned
 *     from a phone at all. Digest volume is the #1 email-fatigue lever.
 *   - Webhook alert preferences (GET/PUT /api/v1/webhooks/alert-prefs). Mobile
 *     shipped the full outbound-webhook editor but not the control that decides
 *     when you're TOLD a webhook is failing. Endpoint create/edit/delete and a
 *     canned signed test are available here; alerts are the phone-first half
 *     that pulls an operator back when a configured receiver needs attention.
 *   - Privacy requests (GET /api/v1/privacy/requests, POST
 *     /api/v1/privacy/export-requests), including the regulatory region that
 *     mobile previously hardcoded to "OTHER" on every request.
 *
 * Kept out of settings.ts so neither file grows past the source budget.
 */
import { rawRequest, type AIApiResult } from "./request";

// ---------------------------------------------------------------------------
// Dashboard digest
// ---------------------------------------------------------------------------

/**
 * The wire value is a STRING — "off" | "daily" | "weekly".
 *
 * openapi.json documents this enum as `["false","daily","weekly"]`, which is a
 * generator artefact and is WRONG: the handler decodes into
 * `struct{ Frequency string }` and rejects anything that is not exactly "off",
 * "daily" or "weekly" (apps/api/internal/analytics/anomalies.go PutDigestPrefs).
 * Sending the JSON literal `false` fails to unmarshal into a string field and
 * comes back 400 before validation is even reached, so "Off" simply could not
 * be saved. Desktop's api-client uses `"off" | "daily" | "weekly"`; this
 * matches it.
 */
export type DigestFrequency = "off" | "daily" | "weekly";

export interface DigestPrefs {
  userId: string;
  tenantId: string;
  frequency: DigestFrequency;
  lastSentAt?: string;
  updatedAt: string;
}

export const DIGEST_FREQUENCIES: readonly {
  value: DigestFrequency;
  label: string;
}[] = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "off", label: "Off" },
];

/**
 * Normalise the wire value. Anything that is not a real cadence — "off", the
 * legacy literal `false`, the string "false", a missing field, junk — is off,
 * which is also the server's own default for a user with no stored row.
 */
export function normalizeDigestFrequency(value: unknown): DigestFrequency {
  if (value === "daily" || value === "weekly") return value;
  return "off";
}

export function getDigestPrefs(): Promise<AIApiResult<DigestPrefs>> {
  return rawRequest<DigestPrefs>("GET", "/api/v1/dashboard/digest");
}

export function putDigestPrefs(
  frequency: DigestFrequency,
): Promise<AIApiResult<{ ok: true; frequency: DigestFrequency }>> {
  return rawRequest<{ ok: true; frequency: DigestFrequency }>(
    "PUT",
    "/api/v1/dashboard/digest",
    // normalizeDigestFrequency guarantees one of the three literals the
    // handler accepts; anything else is a guaranteed 400.
    { frequency: normalizeDigestFrequency(frequency) },
  );
}

// ---------------------------------------------------------------------------
// Webhook alert preferences
// ---------------------------------------------------------------------------

export interface WebhookAlertPrefs {
  notify_auto_disabled: boolean;
  notify_failure_rate: boolean;
  failure_rate_pct: number;
  notify_latency: boolean;
  latency_ms: number;
  last_alerted_at?: string | null;
  updated_at?: string;
}

/** Server bounds (openapi: 1..100 and 1..600000). Clamping client-side turns a
 *  422 into an impossible state instead of an error toast. */
export const FAILURE_RATE_BOUNDS = { min: 1, max: 100 } as const;
export const LATENCY_BOUNDS = { min: 1, max: 600_000 } as const;

export function clampFailureRate(pct: number): number {
  if (!Number.isFinite(pct)) return FAILURE_RATE_BOUNDS.min;
  return Math.min(
    FAILURE_RATE_BOUNDS.max,
    Math.max(FAILURE_RATE_BOUNDS.min, Math.round(pct)),
  );
}

export function clampLatencyMs(ms: number): number {
  if (!Number.isFinite(ms)) return LATENCY_BOUNDS.min;
  return Math.min(
    LATENCY_BOUNDS.max,
    Math.max(LATENCY_BOUNDS.min, Math.round(ms)),
  );
}

export function getWebhookAlertPrefs(): Promise<
  AIApiResult<WebhookAlertPrefs>
> {
  return rawRequest<WebhookAlertPrefs>("GET", "/api/v1/webhooks/alert-prefs");
}

/**
 * PUT is a FULL replace — every threshold field is required by the schema — so
 * callers must send the merged object, never a partial patch.
 */
export function putWebhookAlertPrefs(
  prefs: WebhookAlertPrefs,
): Promise<AIApiResult<{ ok: true }>> {
  return rawRequest<{ ok: true }>("PUT", "/api/v1/webhooks/alert-prefs", {
    notify_auto_disabled: prefs.notify_auto_disabled,
    notify_failure_rate: prefs.notify_failure_rate,
    failure_rate_pct: clampFailureRate(prefs.failure_rate_pct),
    notify_latency: prefs.notify_latency,
    latency_ms: clampLatencyMs(prefs.latency_ms),
  });
}

// ---------------------------------------------------------------------------
// Privacy requests
// ---------------------------------------------------------------------------

/** Mirrors desktop's PrivacyRegion union. Region drives the regulatory clock
 *  the backend applies, so filing everything as OTHER gave every GDPR-subject
 *  request from a phone the wrong regime and the wrong due date. */
export type PrivacyRegion = "GDPR" | "CCPA" | "OTHER";

export const PRIVACY_REGIONS: readonly {
  value: PrivacyRegion;
  label: string;
  hint: string;
}[] = [
  { value: "GDPR", label: "GDPR", hint: "EU / UK data subject" },
  { value: "CCPA", label: "CCPA", hint: "California resident" },
  { value: "OTHER", label: "Other", hint: "No specific regime" },
];

/**
 * The FULL wire row. `privacyRequestRow` (apps/api/internal/privacy/handlers.go:53)
 * has always sent legal_hold, subject_email, requested_at and completed_at;
 * mobile's type declared five of the thirteen fields, so the queue could not
 * tell a request under legal hold from one that was simply late.
 */
export interface PrivacyRequestRecord {
  request_id: string;
  type: string;
  status: string;
  region: string;
  due_at: string;
  legal_hold?: boolean;
  subject_type?: string;
  subject_email?: string;
  requester_email?: string;
  requested_at?: string;
  completed_at?: string;
  notes?: string;
}

export interface PrivacyExportResponse {
  request_id?: string;
  status?: string;
  estimated_ready_at?: string;
}

/**
 * Guess the right regime from the workspace timezone so the default is usually
 * correct instead of always "OTHER". A guess the user can see and change beats
 * a silent hardcode; it never overrides an explicit choice.
 */
export function regionForTimezone(timezone: string | undefined): PrivacyRegion {
  const tz = (timezone ?? "").trim();
  if (!tz) return "OTHER";
  if (tz.startsWith("Europe/")) return "GDPR";
  if (tz === "America/Los_Angeles" || tz === "US/Pacific") return "CCPA";
  return "OTHER";
}

/**
 * The handler pages on (requested_at, id) and returns `nextCursor` when there
 * is more (handlers.go:216). Mobile ignored both and rendered the first four
 * rows of whatever came back, so a workspace with 100+ requests could not see
 * — or act on — anything past row four from a phone.
 */
export function listPrivacyRequests(
  cursor?: string | null,
  limit = 100,
): Promise<
  AIApiResult<{ requests: PrivacyRequestRecord[]; nextCursor?: string }>
> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  return rawRequest<{
    requests: PrivacyRequestRecord[];
    nextCursor?: string;
  }>("GET", `/api/v1/privacy/requests?${params.toString()}`);
}

/**
 * GET /api/v1/privacy/portal — the tenant-wide privacy posture.
 *
 * ScopeAdmin (apps/api/internal/privacy_portal/handlers.go:66-67), so a
 * non-admin gets a 403 and every caller must treat "no posture" as normal
 * rather than as an error: this is a supplementary, authoritative count that
 * refines a number the screen can already derive.
 */
export function loadPrivacyPortalSummary(): Promise<AIApiResult<unknown>> {
  return rawRequest<unknown>("GET", "/api/v1/privacy/portal");
}

export function requestPrivacyExport(
  region: PrivacyRegion,
): Promise<AIApiResult<PrivacyExportResponse>> {
  return rawRequest<PrivacyExportResponse>(
    "POST",
    "/api/v1/privacy/export-requests",
    { region, notes: "Requested from Moosewave mobile app." },
  );
}

/* ------------------------------------------------- DSAR lifecycle actions ---
 * All four are mounted admin-only at internal/server/tenant_governance.go:104-109
 * and all four are ABSENT from openapi.json, so they go through rawRequest
 * rather than the generated SDK. Each mirrors the handler's own status guard —
 * see src/lib/privacyQueue.ts `allowedActions`.
 * -------------------------------------------------------------------------- */

function requestPath(requestId: string, suffix: string): string {
  return `/api/v1/privacy/requests/${encodeURIComponent(requestId)}${suffix}`;
}

export interface PrivacyVerificationResponse {
  request_id: string;
  /** Plaintext single-use token; the server stores only its hash. */
  token: string;
  expires_at: string;
  status: string;
}

/** POST …/verify — mints a verification token and moves the row to `verifying`. */
export function issuePrivacyVerification(
  requestId: string,
  sentTo: string,
): Promise<AIApiResult<PrivacyVerificationResponse>> {
  return rawRequest<PrivacyVerificationResponse>(
    "POST",
    requestPath(requestId, "/verify"),
    { sent_to: sentTo, method: "email" },
  );
}

/** POST …/deny — `reason` is mandatory; the handler 400s on an empty one. */
export function denyPrivacyRequest(
  requestId: string,
  reason: string,
): Promise<AIApiResult<{ request_id: string; status: string }>> {
  return rawRequest<{ request_id: string; status: string }>(
    "POST",
    requestPath(requestId, "/deny"),
    { reason },
  );
}

/** POST …/hold — pauses the statutory clock. Reason mandatory. */
export function setPrivacyLegalHold(
  requestId: string,
  reason: string,
): Promise<AIApiResult<{ request_id: string; legal_hold: boolean }>> {
  return rawRequest<{ request_id: string; legal_hold: boolean }>(
    "POST",
    requestPath(requestId, "/hold"),
    { reason },
  );
}

/** DELETE …/hold — resumes the clock. */
export function clearPrivacyLegalHold(
  requestId: string,
): Promise<AIApiResult<{ request_id: string; legal_hold: boolean }>> {
  return rawRequest<{ request_id: string; legal_hold: boolean }>(
    "DELETE",
    requestPath(requestId, "/hold"),
  );
}

/** POST …/appeal — only legal on a REJECTED parent; creates a linked child row. */
export function appealPrivacyRequest(
  requestId: string,
  reason: string,
  region: PrivacyRegion,
): Promise<
  AIApiResult<{ appeal_request_id: string; status: string; due_at: string }>
> {
  return rawRequest<{
    appeal_request_id: string;
    status: string;
    due_at: string;
  }>("POST", requestPath(requestId, "/appeal"), { reason, region });
}
