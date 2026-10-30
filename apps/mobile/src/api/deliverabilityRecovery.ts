/**
 * api/deliverabilityRecovery.ts — the containment policies and recovery
 * queues around the deliverability hub.
 *
 *   GET   /api/v1/blocklist/auto-suppress                    (viewer)
 *   PATCH /api/v1/blocklist/auto-suppress                    (admin)
 *   GET   /api/v1/spam-trap-guard/stats                      (viewer)
 *   GET   /api/v1/spam-trap-guard/hits?days=                 (viewer)
 *   GET   /api/v1/soft-bounce-recovery/stats                 (viewer)
 *   POST  /api/v1/soft-bounce-recovery/run-now               (admin)
 *   GET   /api/v1/intelligent-retry/events                   (admin)
 *   POST  /api/v1/intelligent-retry/events/{id}/mark-ready   (admin)
 *   POST  /api/v1/intelligent-retry/events/{id}/dismiss      (admin)
 *
 * Every write here is ONLINE-ONLY, never queued: each one either flips a live
 * containment policy or moves a held recipient, and a replayed copy landing
 * later acts on a world the operator no longer sees.
 */
import { rawRequest, type AIApiError } from "./request";

import {
  itemsOf,
  numberOr,
  str,
  WireShapeError,
} from "@/lib/deliverabilityContracts";

class RecoveryError extends Error {
  readonly status: number;

  constructor(error: AIApiError, fallback: string) {
    super(error.message || fallback);
    this.name = "RecoveryError";
    this.status = error.status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* ------------------------------------------- blocklist auto-suppress --- */

export interface AutoSuppressState {
  autoSuppress: boolean;
  eligibleNow: number;
  activeSuppressions: number;
  observedAt: string;
}

function parseAutoSuppress(value: unknown): AutoSuppressState {
  if (!isRecord(value)) throw new WireShapeError("auto-suppress state");
  return {
    autoSuppress: value.auto_suppress === true,
    eligibleNow: Math.max(0, numberOr(value.eligible_now, 0)),
    activeSuppressions: Math.max(0, numberOr(value.active_suppressions, 0)),
    observedAt: str(value.observed_at),
  };
}

export async function fetchAutoSuppress(): Promise<AutoSuppressState> {
  const res = await rawRequest<unknown>(
    "GET",
    "/api/v1/blocklist/auto-suppress",
  );
  if (res.error) {
    throw new RecoveryError(
      res.error,
      "Couldn't load the auto-suppress policy.",
    );
  }
  return parseAutoSuppress(res.data);
}

/** Flip the policy; the server answers with the fresh state as a receipt. */
export async function setAutoSuppress(
  enabled: boolean,
): Promise<AutoSuppressState> {
  const res = await rawRequest<unknown>(
    "PATCH",
    "/api/v1/blocklist/auto-suppress",
    { auto_suppress: enabled },
  );
  if (res.error) {
    throw new RecoveryError(
      res.error,
      "Couldn't change the auto-suppress policy.",
    );
  }
  return parseAutoSuppress(res.data);
}

/* ------------------------------------------------- spam-trap evidence --- */

export interface SpamTrapStats {
  hitsLast30Days: number;
  blocklistedCount: number;
  eligibleNow: number;
  observedAt: string;
}

export async function fetchSpamTrapStats(): Promise<SpamTrapStats> {
  const res = await rawRequest<unknown>("GET", "/api/v1/spam-trap-guard/stats");
  if (res.error) {
    throw new RecoveryError(res.error, "Couldn't load spam-trap stats.");
  }
  if (!isRecord(res.data)) throw new WireShapeError("spam-trap stats");
  return {
    hitsLast30Days: Math.max(0, numberOr(res.data.hits_last_30_days, 0)),
    blocklistedCount: Math.max(0, numberOr(res.data.blocklisted_count, 0)),
    eligibleNow: Math.max(0, numberOr(res.data.eligible_now, 0)),
    observedAt: str(res.data.observed_at),
  };
}

export interface SpamTrapHit {
  email: string;
  firstHitAt: string;
  lastHitAt: string;
  hitCount: number;
  status: string;
}

export async function fetchSpamTrapHits(days = 30): Promise<SpamTrapHit[]> {
  const res = await rawRequest<unknown>(
    "GET",
    `/api/v1/spam-trap-guard/hits?days=${encodeURIComponent(String(days))}`,
  );
  if (res.error) {
    throw new RecoveryError(res.error, "Couldn't load spam-trap hits.");
  }
  const rows = isRecord(res.data) ? (res.data.hits ?? []) : res.data;
  const out: SpamTrapHit[] = [];
  for (const row of itemsOf(rows, "spam-trap hits")) {
    if (!isRecord(row)) continue;
    const email = str(row.email).trim();
    if (!email) continue;
    out.push({
      email,
      firstHitAt: str(row.first_hit_at),
      lastHitAt: str(row.last_hit_at),
      hitCount: Math.max(0, numberOr(row.hit_count, 0)),
      status: str(row.status),
    });
  }
  return out;
}

/* --------------------------------------------- soft-bounce recovery --- */

export interface SoftBounceStats {
  disabledCount: number;
  eligibleSuppressionsNow: number;
  recoveryWindowDays: number;
}

export async function fetchSoftBounceStats(): Promise<SoftBounceStats> {
  const res = await rawRequest<unknown>(
    "GET",
    "/api/v1/soft-bounce-recovery/stats",
  );
  if (res.error) {
    throw new RecoveryError(
      res.error,
      "Couldn't load soft-bounce recovery stats.",
    );
  }
  if (!isRecord(res.data)) throw new WireShapeError("soft-bounce stats");
  return {
    disabledCount: Math.max(0, numberOr(res.data.disabled_count, 0)),
    eligibleSuppressionsNow: Math.max(
      0,
      numberOr(res.data.eligible_suppressions_now, 0),
    ),
    recoveryWindowDays: Math.max(0, numberOr(res.data.recovery_window_days, 0)),
  };
}

/**
 * Run the recovery pass now. `recovered` is a compatibility field the server
 * pins to zero (the worker never changes lifecycle status); the honest number
 * is `expired_suppressions` — transient suppressions cleaned up.
 */
export async function runSoftBounceRecovery(): Promise<{
  expiredSuppressions: number;
}> {
  const res = await rawRequest<unknown>(
    "POST",
    "/api/v1/soft-bounce-recovery/run-now",
    {},
  );
  if (res.error) {
    throw new RecoveryError(res.error, "Couldn't run the recovery pass.");
  }
  const data = res.data as { expired_suppressions?: unknown } | null;
  return {
    expiredSuppressions: Math.max(0, numberOr(data?.expired_suppressions, 0)),
  };
}

/* ------------------------------------------------- intelligent retry --- */

export interface RetryEvent {
  id: string;
  tenantId: string;
  campaignId: string;
  subscriberEmail: string;
  reason: string;
  status: string;
  retryAfter: string;
  attempts: number;
  createdAt: string;
  /** Exact server revision required by either status transition. */
  updatedAt: string;
}

const RFC3339_NANO =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

function exactRetryRevision(value: unknown): string | null {
  const revision = str(value);
  if (
    revision === "" ||
    revision.length > 64 ||
    revision.trim() !== revision ||
    !RFC3339_NANO.test(revision) ||
    !Number.isFinite(Date.parse(revision))
  ) {
    return null;
  }
  return revision;
}

function exactTenantIdentity(value: string): string | null {
  return value !== "" && value.trim() === value ? value : null;
}

function parseRetryEvent(
  row: Record<string, unknown>,
  expectedTenantId: string,
): RetryEvent {
  const id = str(row.id).trim();
  const tenantId = str(row.tenant_id);
  const updatedAt = exactRetryRevision(row.updated_at);
  // A row without its CAS token is not actionable. Do not surface a control
  // that can only issue a precondition-free/stale write.
  if (!id || !updatedAt || tenantId !== expectedTenantId) {
    throw new WireShapeError("retry event");
  }
  return {
    id,
    tenantId,
    campaignId: str(row.campaign_id),
    subscriberEmail: str(row.subscriber_email),
    reason: str(row.reason),
    status: str(row.status),
    retryAfter: str(row.retry_after),
    attempts: Math.max(0, numberOr(row.attempts, 0)),
    createdAt: str(row.created_at),
    updatedAt,
  };
}

export async function fetchRetryEvents(
  expectedTenantId: string,
  limit = 100,
): Promise<RetryEvent[]> {
  const exactTenantId = exactTenantIdentity(expectedTenantId);
  if (!exactTenantId) throw new WireShapeError("retry tenant identity");
  const res = await rawRequest<unknown>(
    "GET",
    `/api/v1/intelligent-retry/events?limit=${encodeURIComponent(String(limit))}`,
  );
  if (res.error) {
    throw new RecoveryError(res.error, "Couldn't load the retry queue.");
  }
  if (!isRecord(res.data) || !Array.isArray(res.data.items)) {
    throw new WireShapeError("retry events");
  }
  const out: RetryEvent[] = [];
  for (const row of itemsOf(res.data.items, "retry events")) {
    if (!isRecord(row)) throw new WireShapeError("retry event");
    // One wrong-tenant row poisons the entire envelope. Filtering it would
    // conceal a server isolation failure while still trusting adjacent rows.
    out.push(parseRetryEvent(row, exactTenantId));
  }
  return out;
}

export type RetryEventAction = "mark-ready" | "dismiss";

/** Advance one recipient's eligibility for worker re-evaluation, or drop it. */
export async function setRetryEventStatus(
  id: string,
  action: RetryEventAction,
  expectedUpdatedAt: string,
  expectedTenantId: string,
): Promise<RetryEvent> {
  const exactID = id.trim();
  const exactRevision = exactRetryRevision(expectedUpdatedAt);
  const exactTenantId = exactTenantIdentity(expectedTenantId);
  if (!exactID || exactID !== id) {
    throw new WireShapeError("retry event id");
  }
  if (!exactRevision) {
    throw new WireShapeError("retry event revision");
  }
  if (!exactTenantId) {
    throw new WireShapeError("retry tenant identity");
  }
  const res = await rawRequest<unknown>(
    "POST",
    `/api/v1/intelligent-retry/events/${encodeURIComponent(exactID)}/${action}`,
    { expected_updated_at: exactRevision },
    // A status CAS may have committed even if its response was lost. Do not
    // auto-mint a key or replay it; reload the row before any later decision.
    { idempotencyKey: null },
  );
  if (res.error) {
    throw new RecoveryError(
      res.error,
      action === "dismiss"
        ? "Couldn't dismiss the held send."
        : "Couldn't mark the held send ready.",
    );
  }
  if (!isRecord(res.data)) throw new WireShapeError("retry event");
  return parseRetryEvent(res.data, exactTenantId);
}
