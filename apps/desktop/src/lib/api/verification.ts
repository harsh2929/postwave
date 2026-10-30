// Typed client for the email-verification connector
// (apps/api/internal/verification), mounted at /api/v1/verification/*.
//
// The backend is a two-tier verifier: a FREE local tier (syntax, DNS/MX,
// advisory built-in disposable signals, terminal tenant disposable overrides,
// abuse-mailbox checks, advisory role flags, typo correction) that can only
// ever DISPROVE an address, and an optional metered vendor tier
// (ZeroBounce / Kickbox) that probes the mailbox and is the only thing that
// can return "valid".
//
// Two shapes here exist because the distinction matters in the UI and is
// easy to get wrong:
//
//   credits_saved / savings_ratio  — MEASURED, what actually happened.
//   needs_mailbox_probe            — HYPOTHETICAL, what full mode WOULD cost.
//
// Never render the hypothetical as a bill. Shapes verified against
// verification.go, handlers.go, policy.go and projection.go.
import type { ApiResult } from "./result";

interface NativeFacadeRequestOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  requireOnline?: boolean;
  signal?: AbortSignal;
}

type VerificationRequester = <T>(
  path: string,
  init?: RequestInit,
  options?: NativeFacadeRequestOptions,
) => Promise<ApiResult<T>>;

/**
 * Saving a provider makes the SERVER probe the vendor's credit balance
 * inline, so the response waits on a third-party round trip. The default
 * request timeout is far too short for that. Forty-five seconds covers the
 * provider's 30-second single-address/balance window plus bounded local,
 * persistence, and response overhead without enabling an automatic retry.
 */
const VENDOR_ROUND_TRIP_TIMEOUT_MS = 45_000;

/**
 * Paid synchronous verification is one bounded provider-latency wave. Larger
 * work must use createJob(), whose durable receipt survives client timeouts.
 * Health-only batches retain their separate 1,000-address ceiling.
 */
export const MAX_SYNCHRONOUS_VERIFICATION_BATCH = 8;

/** Canonical verdicts. Mirrors verification.Status exactly. */
export type VerificationStatus =
  | "valid"
  | "invalid"
  | "catch_all"
  | "spamtrap"
  | "abuse"
  | "do_not_mail"
  | "unknown";

/** Enforcement modes. Mirrors verification.Mode* constants. */
export type VerificationMode = "off" | "local" | "full";

export type VerificationProvider = "zerobounce" | "kickbox";

/** Derived recipient-health grades. U means there is not decisive evidence. */
export type EmailHealthGrade = "A" | "B" | "C" | "D" | "F" | "U";

export type EmailHealthRecommendation =
  | "send"
  | "caution"
  | "do_not_send"
  | "blocked";

export type EmailHealthEvidenceKind =
  | "hard_bounce"
  | "complaint"
  | "soft_bounce"
  | "ambiguous_negative"
  | "vendor_activity"
  | "reply"
  | "click"
  | "delivered"
  | "open"
  | "hard_stop";

export interface EmailHealthEvidence {
  kind: EmailHealthEvidenceKind;
  at: string;
  source: string;
  reason_code: string;
}

/**
 * Tenant-scoped, derived health for one recipient. A grade is advisory;
 * hard_stop/send_eligible remain the authoritative sending-safety fields.
 */
export interface EmailHealth {
  email: string;
  grade: EmailHealthGrade;
  recommendation: EmailHealthRecommendation;
  hard_stop: boolean;
  send_eligible: boolean;
  /** False means consent/suppression evidence could not be loaded; fail closed. */
  evidence_complete: boolean;
  reason_codes: string[];
  evidence: EmailHealthEvidence[];
  evidence_at?: string;
  status?: VerificationStatus;
  score?: number;
  provider?: string;
  checked_at?: string;
  model_version: string;
  computed_at: string;
}

export interface EmailHealthBatchResponse {
  results: EmailHealth[];
  summary: Record<EmailHealthGrade, number>;
  total: number;
  duplicates: number;
  model_version: string;
}

export interface VerificationResult {
  email: string;
  status: VerificationStatus;
  sub_status?: string;
  /** 0-10 vendor quality score; absent when the provider supplied none. */
  score?: number;
  domain?: string;
  free_email: boolean;
  role_account: boolean;
  disposable: boolean;
  mx_found: boolean;
  mx_record?: string;
  /** A corrected address when the domain looks like a typo. */
  did_you_mean?: string;
  first_name?: string;
  last_name?: string;
  gender?: string;
  country?: string;
  city?: string;
  provider: string;
  /** Whether producing this verdict consumed a paid credit. */
  billable: boolean;
  /** Whether it was served from the tenant's cache rather than re-verified. */
  cached: boolean;
  checked_at: string;
  /** Added by health-aware servers; absent on older deployments/cached rows. */
  health?: EmailHealth;
}

/** Measured accounting for one batch. Every number is observed, not estimated. */
export interface VerificationUsage {
  total: number;
  cache_hits: number;
  local_filtered: number;
  vendor_verified: number;
  credits_spent: number;
  duplicates: number;
  credits_saved: number;
  savings_ratio: number;
}

export interface VerifyBatchResponse {
  results: VerificationResult[];
  summary: Partial<Record<VerificationStatus, number>>;
  usage: VerificationUsage;
}

export interface ProviderSettings {
  ip_address?: string;
  degrade_on_failure?: boolean;
  cache_ttl_days?: number;
}

/**
 * One configured vendor. Note there is deliberately NO api key field —
 * `credential_ref` is an opaque tenant-local credential id. The server derives
 * its tenant/provider vault path; a live billable credential never reaches the
 * browser.
 */
export interface VerificationProviderConfig {
  id?: string;
  provider: VerificationProvider;
  credential_ref: string;
  enabled: boolean;
  settings: ProviderSettings;
  last_balance?: number;
  last_balance_at?: string;
  last_error?: string;
  last_error_at?: string;
  created_at?: string;
  updated_at?: string;
}

export interface ProvidersEnvelope {
  providers: VerificationProviderConfig[];
  available: VerificationProvider[];
}

export interface VerificationPolicy {
  forms_mode: VerificationMode;
  forms_reject_statuses: VerificationStatus[];
  forms_suggest_typos?: boolean;
  import_mode: VerificationMode;
  updated_at?: string;
}

export interface PolicyEnvelope {
  policy: VerificationPolicy;
  modes: VerificationMode[];
  rejectable_statuses: VerificationStatus[];
  /** Present when full mode is selected with no provider configured. */
  warning?: string;
}

export type JobStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "canceled";

export type JobSource = "inline" | "upload" | "tag" | "all_subscribers";

export interface VerificationJob {
  id: string;
  status: JobStatus;
  source: JobSource;
  source_ref?: string;
  provider?: string;
  total: number;
  processed: number;
  cache_hits: number;
  local_filtered: number;
  vendor_verified: number;
  credits_spent: number;
  duplicates: number;
  /** Provider calls whose outcome cannot be retried without double billing. */
  ambiguous?: number;
  failure_code?: string;
  error?: string;
  created_at: string;
  started_at?: string;
  completed_at?: string;
}

export interface JobDetail {
  job: VerificationJob;
  summary: Partial<Record<VerificationStatus, number>>;
  credits_saved: number;
  credits_spent: number;
  is_terminal: boolean;
}

export interface JobItem {
  email: string;
  processed: boolean;
  status: VerificationStatus;
  sub_status?: string;
  score?: number;
  provider?: string;
  billable: boolean;
  cached: boolean;
  did_you_mean?: string;
  checked_at?: string;
  attempt_state?: "pending" | "leased" | "succeeded" | "ambiguous";
  /** Added by health-aware servers; absent on older in-flight records. */
  health?: EmailHealth;
}

export interface CreateVerificationJobInput {
  source: JobSource;
  source_ref?: string;
  emails?: string[];
}

export interface CreditsSummary {
  usage: {
    day: string;
    provider: string;
    verified: number;
    credits_spent: number;
    local_filtered: number;
    cache_hits: number;
  }[];
  totals: {
    verified: number;
    credits_spent: number;
    local_filtered: number;
    cache_hits: number;
    credits_saved: number;
  };
  provider: string | null;
  balance: number | null;
  balance_checked_at?: string;
  last_error?: string;
  /** Explains the unconfigured case rather than erroring. */
  note?: string;
}

export interface CacheSummary {
  total: number;
  by_status: Partial<Record<VerificationStatus, number>>;
  oldest_checked_at?: string;
  newest_checked_at?: string;
  expiring_within_7d: number;
}

/**
 * Raw verification statuses that do not disprove deliverability. This helper
 * is deliberately narrower than a final send decision: EmailHealth.hard_stop
 * and send_eligible (plus the canonical suppression gate) always take
 * precedence over this mailbox verdict.
 *
 * catch_all and unknown ARE sendable: excluding every catch-all domain
 * would drop most B2B lists wholesale.
 */
export const SENDABLE_STATUSES: readonly VerificationStatus[] = [
  "valid",
  "catch_all",
  "unknown",
];

export function isSendable(status: VerificationStatus): boolean {
  return SENDABLE_STATUSES.includes(status);
}

// createVerificationApi wires the mounted verification routes.
export function createVerificationApi(request: VerificationRequester) {
  return {
    // POST /api/v1/verification/verify — one address.
    verify(
      email: string,
      idempotencyKey: string,
    ): Promise<ApiResult<VerificationResult>> {
      return request<VerificationResult>(
        "/api/v1/verification/verify",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({ email }),
        },
        { timeoutMs: VENDOR_ROUND_TRIP_TIMEOUT_MS, maxAttempts: 1 },
      );
    },

    // POST /api/v1/verification/verify-batch — synchronous, <= 8.
    verifyBatch(
      emails: string[],
      idempotencyKey: string,
    ): Promise<ApiResult<VerifyBatchResponse>> {
      if (emails.length > MAX_SYNCHRONOUS_VERIFICATION_BATCH) {
        return Promise.resolve({
          error: {
            kind: "http",
            status: 400,
            code: "batch_too_large",
            message: `Synchronous verification accepts at most ${MAX_SYNCHRONOUS_VERIFICATION_BATCH} addresses. Create a durable verification job for larger work.`,
          },
          retryability: "not-retryable",
          preservedDraft: { emails },
        });
      }
      return request<VerifyBatchResponse>(
        "/api/v1/verification/verify-batch",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({ emails }),
        },
        // The bounded batch still crosses a paid provider boundary. Keep
        // retries explicit; the caller-owned key makes an intentional exact
        // retry replay-safe.
        { timeoutMs: 120_000, maxAttempts: 1, requireOnline: true },
      );
    },

    // GET /api/v1/verification/health?email=... — canonical derived grade.
    health(
      email: string,
      signal?: AbortSignal,
    ): Promise<ApiResult<EmailHealth>> {
      return request<EmailHealth>(
        `/api/v1/verification/health?email=${encodeURIComponent(email)}`,
        { cache: "no-store" },
        { signal },
      );
    },

    // POST /api/v1/verification/health/batch — canonical grades, <= 1000.
    healthBatch(
      emails: string[],
    ): Promise<ApiResult<EmailHealthBatchResponse>> {
      return request<EmailHealthBatchResponse>(
        "/api/v1/verification/health/batch",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ emails }),
          cache: "no-store",
        },
        { maxAttempts: 1, requireOnline: true },
      );
    },

    // POST /api/v1/verification/jobs — durable, asynchronous verification.
    // The caller owns the key so an uncertain response can be retried with
    // the exact same request without creating a second billable run.
    createJob(
      input: CreateVerificationJobInput,
      idempotencyKey: string,
    ): Promise<ApiResult<VerificationJob>> {
      return request<VerificationJob>(
        "/api/v1/verification/jobs",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(input),
        },
        {
          // A response can be lost after the durable job is created. Keep
          // transport retries under the explicit-key owner in the UI.
          maxAttempts: 1,
          requireOnline: true,
        },
      );
    },

    // GET /api/v1/verification/jobs — recent jobs, newest first.
    listJobs(limit?: number): Promise<ApiResult<unknown>> {
      const q = limit ? `?limit=${encodeURIComponent(String(limit))}` : "";
      return request<unknown>(`/api/v1/verification/jobs${q}`, {
        cache: "no-store",
      });
    },

    // GET /api/v1/verification/jobs/{id} — job + status summary.
    getJob(id: string): Promise<ApiResult<unknown>> {
      return request<unknown>(
        `/api/v1/verification/jobs/${encodeURIComponent(id)}`,
        { cache: "no-store" },
      );
    },

    // GET /api/v1/verification/jobs/{id}/results — per-address page.
    jobResults(
      id: string,
      opts?: { status?: VerificationStatus[]; limit?: number; offset?: number },
    ): Promise<ApiResult<unknown>> {
      const params = new URLSearchParams();
      if (opts?.status?.length) params.set("status", opts.status.join(","));
      if (opts?.limit) params.set("limit", String(opts.limit));
      if (opts?.offset) params.set("offset", String(opts.offset));
      const q = params.toString() ? `?${params.toString()}` : "";
      return request<unknown>(
        `/api/v1/verification/jobs/${encodeURIComponent(id)}/results${q}`,
        { cache: "no-store" },
      );
    },

    // POST /api/v1/verification/jobs/{id}/cancel — 204 on success.
    cancelJob(id: string): Promise<ApiResult<void>> {
      return request<void>(
        `/api/v1/verification/jobs/${encodeURIComponent(id)}/cancel`,
        { method: "POST" },
        { maxAttempts: 1, requireOnline: true },
      );
    },

    // GET /api/v1/verification/providers — configured + available vendors.
    listProviders(): Promise<ApiResult<ProvidersEnvelope>> {
      return request<ProvidersEnvelope>("/api/v1/verification/providers");
    },

    // PUT /api/v1/verification/providers/{provider} — configure a vendor.
    // The body carries a tenant-local opaque credential id, never a vault path
    // or key.
    saveProvider(
      provider: VerificationProvider,
      input: {
        credential_ref: string;
        enabled?: boolean;
        settings?: ProviderSettings;
      },
    ): Promise<ApiResult<VerificationProviderConfig>> {
      return request<VerificationProviderConfig>(
        `/api/v1/verification/providers/${encodeURIComponent(provider)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
        {
          timeoutMs: VENDOR_ROUND_TRIP_TIMEOUT_MS,
          maxAttempts: 1,
          requireOnline: true,
        },
      );
    },

    // DELETE /api/v1/verification/providers/{provider} — 204 on success.
    deleteProvider(provider: VerificationProvider): Promise<ApiResult<void>> {
      return request<void>(
        `/api/v1/verification/providers/${encodeURIComponent(provider)}`,
        { method: "DELETE" },
        { maxAttempts: 1, requireOnline: true },
      );
    },

    // GET /api/v1/verification/policy — where verification is enforced.
    getPolicy(): Promise<ApiResult<PolicyEnvelope>> {
      return request<PolicyEnvelope>("/api/v1/verification/policy");
    },

    // PUT /api/v1/verification/policy — update enforcement.
    savePolicy(
      policy: Partial<VerificationPolicy>,
    ): Promise<ApiResult<PolicyEnvelope>> {
      return request<PolicyEnvelope>("/api/v1/verification/policy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(policy),
      });
    },

    // GET /api/v1/verification/credits — balance + measured savings.
    credits(days?: number): Promise<ApiResult<CreditsSummary>> {
      const q = days ? `?days=${encodeURIComponent(String(days))}` : "";
      return request<CreditsSummary>(`/api/v1/verification/credits${q}`);
    },

    // GET /api/v1/verification/cache — what is currently cached.
    cacheSummary(): Promise<ApiResult<CacheSummary>> {
      return request<CacheSummary>("/api/v1/verification/cache");
    },

    // DELETE /api/v1/verification/cache — force a re-check of specific
    // addresses. The server refuses a wholesale wipe: every entry cost a
    // credit to obtain.
    invalidateCache(
      emails: string[],
    ): Promise<ApiResult<{ invalidated: number }>> {
      return request<{ invalidated: number }>(
        "/api/v1/verification/cache",
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ emails }),
        },
        { maxAttempts: 1, requireOnline: true },
      );
    },
  };
}

/**
 * CreditsUnmetered — the server's sentinel for "this provider has no
 * notion of a balance" (the free local tier). Rendering -1 as a credit
 * count would be actively misleading.
 */
export const CREDITS_UNMETERED = -1;

export function formatBalance(balance: number | null | undefined): string {
  if (balance === null || balance === undefined) return "Unknown";
  if (balance === CREDITS_UNMETERED) return "Unmetered";
  return balance.toLocaleString();
}

/**
 * Measured savings ratio from a totals block. Returns 0 rather than NaN
 * on an empty window, because this value is rendered directly.
 */
export function measuredSavingsRatio(totals: {
  verified: number;
  credits_spent: number;
}): number {
  if (!totals || totals.verified <= 0) return 0;
  const saved = Math.max(0, totals.verified - totals.credits_spent);
  return saved / totals.verified;
}
