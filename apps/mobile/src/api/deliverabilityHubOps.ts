/**
 * api/deliverabilityHubOps.ts — the hub's operator verbs and recovery
 * evidence, absent from mobile until 2026-08-28.
 *
 *   POST /api/v1/deliverability/hub/repair-override   (admin)
 *   GET  /api/v1/deliverability/hub/webhook-errors    (viewer)
 *
 * The override POST is the 2am verb: the platform auto-throttled sending, the
 * operator fixed the cause, and this is the only way to restore the recorded
 * cap. ONLINE-ONLY AND NEVER QUEUED — a queued release that lands an hour
 * later re-opens sending capacity at a moment nobody chose, which is the exact
 * class of surprise the throttle exists to prevent.
 *
 * The webhook-errors read is recovery EVIDENCE: a dead ESP event webhook
 * silently stops bounce/complaint ingestion, so every downstream rate looks
 * healthy precisely because the bad news stopped arriving.
 */
import { rawRequest, sdkResource, type AIApiError } from "./request";

import type { SendingCapOutcome } from "@postwave/sdk";

import {
  itemsOf,
  numberOr,
  str,
  WireShapeError,
} from "@/lib/deliverabilityContracts";

class HubOpsError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(error: AIApiError, fallback: string) {
    super(error.message || fallback);
    this.name = "HubOpsError";
    this.status = error.status;
    this.code = error.code;
  }
}

interface RepairOverrideWireBody {
  ok?: unknown;
  cleared?: unknown;
  cap_coordination_outcome?: unknown;
  error?: unknown;
}

export type RepairOverrideOutcome =
  | {
      kind: "committed";
      cleared: true;
      capCoordinationOutcome: "committed";
    }
  | {
      kind: "committed-conservatively-fenced";
      cleared: true;
      capCoordinationOutcome: "committed-conservatively-fenced";
      message: string;
      requiresReconciliation: true;
    }
  | {
      kind: "commit-outcome-unknown";
      cleared: false;
      capCoordinationOutcome: "commit-outcome-unknown-conservatively-fenced";
      message: string;
      requiresReconciliation: true;
    }
  | {
      kind: "nothing-to-clear";
      cleared: false;
      message: string;
    }
  | {
      kind: "outcome-unknown";
      cleared: false;
      message: string;
      requiresReconciliation: true;
    };

function repairWireBody(value: unknown): RepairOverrideWireBody | null {
  return isRecord(value) ? value : null;
}

function nestedRepairError(
  body: RepairOverrideWireBody | null,
): { code: string; message: string } | null {
  if (!isRecord(body?.error)) return null;
  const code = body.error.code;
  const message = body.error.message;
  return typeof code === "string" &&
    typeof message === "string" &&
    message.trim()
    ? { code, message: message.trim() }
    : null;
}

function capOutcomeFromHeaders(
  headers: Headers,
): SendingCapOutcome | undefined {
  const value = headers.get("x-postwave-sending-cap-outcome");
  return value === "not-committed" ||
    value === "committed" ||
    value === "committed-conservatively-fenced" ||
    value === "commit-outcome-unknown-conservatively-fenced"
    ? value
    : undefined;
}

function classifiedRepairError(
  error: AIApiError,
): Exclude<RepairOverrideOutcome, { kind: "committed" }> | null {
  const body = repairWireBody(error.payload);
  const nested = nestedRepairError(body);

  if (
    error.status === 404 &&
    error.responseMetadata?.sendingCapOutcome === "not-committed" &&
    error.code === "no_override" &&
    nested?.code === "no_override"
  ) {
    return {
      kind: "nothing-to-clear",
      cleared: false,
      message: nested.message,
    };
  }

  if (
    error.status === 503 &&
    error.responseMetadata?.sendingCapOutcome ===
      "committed-conservatively-fenced" &&
    error.code === "sending_cap_convergence_pending" &&
    nested?.code === "sending_cap_convergence_pending" &&
    body?.ok === true &&
    body.cleared === true &&
    body.cap_coordination_outcome === "committed-conservatively-fenced"
  ) {
    return {
      kind: "committed-conservatively-fenced",
      cleared: true,
      capCoordinationOutcome: "committed-conservatively-fenced",
      message: nested.message,
      requiresReconciliation: true,
    };
  }

  if (
    error.status === 503 &&
    error.responseMetadata?.sendingCapOutcome ===
      "commit-outcome-unknown-conservatively-fenced" &&
    error.code === "sending_cap_commit_outcome_unknown" &&
    nested?.code === "sending_cap_commit_outcome_unknown" &&
    body?.ok === false &&
    body.cleared === false &&
    body.cap_coordination_outcome ===
      "commit-outcome-unknown-conservatively-fenced"
  ) {
    return {
      kind: "commit-outcome-unknown",
      cleared: false,
      capCoordinationOutcome: "commit-outcome-unknown-conservatively-fenced",
      message: nested.message,
      requiresReconciliation: true,
    };
  }

  return null;
}

function provesNotCommitted(
  error: AIApiError,
  body: RepairOverrideWireBody | null,
  nested: { code: string; message: string } | null,
): boolean {
  return (
    error.status >= 400 &&
    error.responseMetadata?.sendingCapOutcome === "not-committed" &&
    typeof error.code === "string" &&
    error.code.length > 0 &&
    nested?.code === error.code &&
    (body?.cap_coordination_outcome === undefined ||
      body.cap_coordination_outcome === "not-committed") &&
    (body?.ok === undefined || body.ok === false) &&
    (body?.cleared === undefined || body.cleared === false)
  );
}

function unprovenRepairOutcome(): RepairOverrideOutcome {
  return {
    kind: "outcome-unknown",
    cleared: false,
    message:
      "The repair request did not return a complete outcome receipt. Its POST is held until fresh repair state is loaded.",
    requiresReconciliation: true,
  };
}

/**
 * Clear the active auto-throttle repair override.
 *
 * The handler answers a committed receipt on 200, and two result-bearing 503
 * envelopes: committed-but-conservatively-fenced, or commit-outcome-unknown
 * with the conservative fence retained. Those are values, not generic server
 * failures, so callers can tell the truth without blind retries. A route-exact
 * 404 `no_override` is a stale-view reconciliation. Other non-2xx responses
 * are thrown with the server's sentence.
 */
export async function clearRepairOverride(): Promise<RepairOverrideOutcome> {
  let successfulCapOutcome: SendingCapOutcome | undefined;
  const res = await sdkResource<unknown>((client) =>
    client.request("POST", "/api/v1/deliverability/hub/repair-override", {
      body: {},
      // The SDK normally auto-mints an Idempotency-Key, which also enables
      // its 429/5xx retry loop. This route has no replay receipt contract and
      // a 503 may mean COMMITTED, so null is the single-attempt guarantee.
      idempotencyKey: null,
      // rawRequest intentionally hides successful status metadata. Use the
      // same SDK-result seam with an exact-status guard so a 201/204 cannot
      // masquerade as the route's canonical 200 committed receipt.
      expectedStatus: 200,
      onResponseHeaders: (headers: Headers) => {
        successfulCapOutcome = capOutcomeFromHeaders(headers);
      },
    } as Parameters<typeof client.request>[2]),
  );
  if (res.error) {
    const classified = classifiedRepairError(res.error);
    if (classified) return classified;
    const body = repairWireBody(res.error.payload);
    if (provesNotCommitted(res.error, body, nestedRepairError(body))) {
      throw new HubOpsError(res.error, "Couldn't clear the repair override.");
    }
    return unprovenRepairOutcome();
  }
  const data = repairWireBody(res.data);
  // All three receipt fields must agree. `ok: true` by itself is not a cap
  // restoration proof, and accepting it would erase the fence state.
  if (
    successfulCapOutcome !== "committed" ||
    data?.ok !== true ||
    data.cleared !== true ||
    data.cap_coordination_outcome !== "committed" ||
    data.error !== undefined
  ) {
    return unprovenRepairOutcome();
  }
  return {
    kind: "committed",
    cleared: true,
    capCoordinationOutcome: "committed",
  };
}

export interface WebhookErrorRow {
  id: string;
  event: string;
  url: string;
  error: string;
  statusCode: number;
  attemptCount: number;
  lastAttemptAt: string;
  status: string;
}

export interface FailedVerificationRow {
  identityId: string;
  domain: string;
  verifyState: string;
  lastError: string;
  lastAttemptAt: string;
}

export interface WebhookErrorsReport {
  items: WebhookErrorRow[];
  failedVerifications: FailedVerificationRow[];
  window: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `GET /api/v1/deliverability/hub/webhook-errors` — failed outbound webhook
 * deliveries (7d) plus failed DNS verifications, exactly the two feeds whose
 * silence fakes good health.
 */
export async function fetchWebhookErrors(): Promise<WebhookErrorsReport> {
  const res = await rawRequest<unknown>(
    "GET",
    "/api/v1/deliverability/hub/webhook-errors",
  );
  if (res.error) {
    throw new HubOpsError(res.error, "Couldn't load webhook failures.");
  }
  if (!isRecord(res.data)) throw new WireShapeError("webhook errors");
  const items: WebhookErrorRow[] = [];
  for (const row of itemsOf(res.data.items ?? [], "webhook errors")) {
    if (!isRecord(row)) continue;
    const id = str(row.id).trim();
    if (!id) continue;
    items.push({
      id,
      event: str(row.event),
      url: str(row.url),
      error: str(row.error),
      statusCode: Math.max(0, numberOr(row.status_code, 0)),
      attemptCount: Math.max(0, numberOr(row.attempt_count, 0)),
      lastAttemptAt: str(row.last_attempt_at),
      status: str(row.status),
    });
  }
  const failedVerifications: FailedVerificationRow[] = [];
  for (const row of itemsOf(
    res.data.failed_verifications ?? [],
    "failed verifications",
  )) {
    if (!isRecord(row)) continue;
    const domain = str(row.domain).trim();
    if (!domain) continue;
    failedVerifications.push({
      identityId: str(row.identity_id),
      domain,
      verifyState: str(row.verify_state),
      lastError: str(row.last_error),
      lastAttemptAt: str(row.last_attempt_at),
    });
  }
  return { items, failedVerifications, window: str(res.data.window, "7d") };
}
