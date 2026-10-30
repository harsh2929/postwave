/**
 * lib/deliverability-hub-api.ts — the deliverability hub.
 *
 * WHY THIS EXISTS. Web reached exactly one `/api/v1/deliverability/*` path
 * (suppressions) while desktop reached twelve. The hub — the score, its inputs,
 * DNS health, blocklist hits, bounce classes and webhook errors — had no web
 * surface at all, on a product whose whole job is landing in the inbox.
 *
 * THE SCORE IS NOT ALWAYS MEANINGFUL, AND THE SERVER SAYS SO. `/hub` answers
 * with `score`, `grade` AND a verdict on whether the sample supports them:
 *
 *     "score": 100, "grade": "A",
 *     "sample_qualified": false,
 *     "minimum_sample_sends": 1000,
 *     "sample_reason": "fewer than 1,000 successful campaign sends in the
 *                       30-day model window"
 *
 * A workspace that has never sent anything is graded A. Mobile shipped that
 * number as fact and had to be fixed; desktop reads `sample_qualified` to
 * neutralise its tone but never shows the reason. This client keeps all three
 * fields so the UI can refuse to present an unqualified grade as a finding,
 * and can say WHY in the server's own words rather than inventing copy.
 */
import { api } from "@/lib/api";

export interface DeliverabilityBreach {
  code: string;
  severity: string;
  message?: string;
}

export interface DeliverabilityHubSummary {
  tenant_id: string;
  score: number;
  grade: string;
  status: string;
  trend: string;
  trend_delta: number;
  bounce_rate: number;
  complaint_rate: number;
  engagement_rate: number;
  opens_machine_pct: number;
  event_rate_scope: string;
  model_version: string;
  /** False when the window holds too little sending for the score to mean anything. */
  sample_qualified: boolean;
  minimum_sample_sends: number;
  /** The server's own sentence explaining an unqualified sample. Render verbatim. */
  sample_reason: string;
  window_days: number;
  breaches: DeliverabilityBreach[];
  blocklist_hits: unknown[];
  auto_throttled: boolean;
  totals: { sends_7d: number; sends_30d: number };
  computed_at: string;
}

export interface DnsHealthIdentity {
  domain?: string;
  spf?: string;
  dkim?: string;
  dmarc?: string;
  [key: string]: unknown;
}

export interface BlocklistHit {
  domain?: string;
  provider?: string;
  listed_at?: string;
  [key: string]: unknown;
}

export interface WebhookErrorItem {
  endpoint?: string;
  status?: number;
  error?: string;
  [key: string]: unknown;
}

/** One day of the bounce-class series. `counts` is NULL on days with no sends. */
export interface BounceClassDay {
  day: string;
  counts: Record<string, number> | null;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export async function getDeliverabilityHub(): Promise<DeliverabilityHubSummary> {
  const res = await api.get<DeliverabilityHubSummary>(
    "/api/v1/deliverability/hub",
  );
  return {
    ...res,
    breaches: asArray<DeliverabilityBreach>(res?.breaches),
    blocklist_hits: asArray(res?.blocklist_hits),
  };
}

export async function getDnsHealth(): Promise<DnsHealthIdentity[]> {
  const res = await api.get<{ identities?: unknown }>(
    "/api/v1/deliverability/hub/dns-health",
  );
  return asArray<DnsHealthIdentity>(res?.identities);
}

export async function getBlocklistHits(): Promise<BlocklistHit[]> {
  const res = await api.get<{ items?: unknown }>(
    "/api/v1/deliverability/hub/blocklist-hits",
  );
  return asArray<BlocklistHit>(res?.items);
}

export async function getWebhookErrors(): Promise<WebhookErrorItem[]> {
  const res = await api.get<{ items?: unknown }>(
    "/api/v1/deliverability/hub/webhook-errors",
  );
  return asArray<WebhookErrorItem>(res?.items);
}

/**
 * The bounce-class series.
 *
 * Days with no sending carry `counts: null` — confirmed against the running
 * server — so any consumer that does `Object.entries(day.counts)` throws on a
 * quiet day. Nulls are normalised to an empty object here, once, rather than at
 * every call site.
 */
export async function getBounceClassBreakdown(): Promise<BounceClassDay[]> {
  const res = await api.get<{ series?: unknown }>(
    "/api/v1/deliverability/hub/bounce-class-breakdown",
  );
  return asArray<BounceClassDay>(res?.series).map((d) => ({
    day: String(d?.day ?? ""),
    counts: d?.counts && typeof d.counts === "object" ? d.counts : {},
  }));
}

const REPAIR_OUTCOME_HEADER = "x-postwave-sending-cap-outcome";

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
      nothingToClear: true;
    }
  | {
      kind: "outcome-unknown";
      cleared: false;
      message: string;
      requiresReconciliation: true;
    };

interface RepairResponseMeta {
  status: number;
  capOutcome: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

function responseMetaOf(
  meta: RepairResponseMeta | undefined,
): RepairResponseMeta | undefined {
  // Kept as a helper because TypeScript cannot prove that an `onResponse`
  // callback ran while the awaited request was in progress.
  return meta;
}

function errorStatus(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.status === "number" ? error.status : undefined;
}

function errorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function errorBody(error: unknown): unknown {
  return isRecord(error) ? error.body : undefined;
}

function provesNotCommitted(
  status: number | undefined,
  code: string | undefined,
  meta: RepairResponseMeta | undefined,
  body: RepairOverrideWireBody | null,
  nested: { code: string; message: string } | null,
): boolean {
  return (
    typeof status === "number" &&
    status >= 400 &&
    meta?.status === status &&
    meta.capOutcome === "not-committed" &&
    typeof code === "string" &&
    code.length > 0 &&
    nested?.code === code &&
    (body?.cap_coordination_outcome === undefined ||
      body.cap_coordination_outcome === "not-committed") &&
    (body?.ok === undefined || body.ok === false) &&
    (body?.cleared === undefined || body.cleared === false)
  );
}

/**
 * Clears an active throttle override, exactly once.
 *
 * This endpoint has two result-bearing 503s. A convergence failure means the
 * database change COMMITTED while shared sending-cap authority stayed fenced;
 * an unreadable commit receipt means the database outcome is UNKNOWN and the
 * fence remains in place. Treating either as a generic retryable 5xx can turn
 * a committed clear into a second write (or a misleading later 404), so the
 * response is classified only when status, header, code, and body agree.
 *
 * 404 `no_override` is a healthy stale-view reconciliation. Every other
 * malformed or unrecognised response remains an error; no outcome is guessed.
 */
export async function clearRepairOverride(): Promise<RepairOverrideOutcome> {
  let observed: RepairResponseMeta | undefined;
  try {
    const raw = await api.post<unknown>(
      "/api/v1/deliverability/hub/repair-override",
      {},
      {
        requireOnline: true,
        maxAttempts: 1,
        // This route has no durable idempotency-replay contract. Do not mint a
        // key that could imply otherwise; the response itself is the receipt.
        idempotencyKey: null,
        onResponse: (response) => {
          observed = {
            status: response.status,
            capOutcome: response.headers.get(REPAIR_OUTCOME_HEADER),
          };
        },
      },
    );
    const meta = responseMetaOf(observed);
    const body = repairWireBody(raw);
    if (
      meta?.status !== 200 ||
      meta.capOutcome !== "committed" ||
      body?.ok !== true ||
      body.cleared !== true ||
      body.cap_coordination_outcome !== "committed" ||
      body.error !== undefined
    ) {
      throw new Error(
        "The server did not provide an exact committed cap-restoration receipt.",
      );
    }
    return {
      kind: "committed",
      cleared: true,
      capCoordinationOutcome: "committed",
    };
  } catch (err) {
    const meta = responseMetaOf(observed);
    const body = repairWireBody(errorBody(err));
    const nested = nestedRepairError(body);
    const status = errorStatus(err);
    const code = errorCode(err);

    if (
      status === 404 &&
      meta?.status === 404 &&
      meta.capOutcome === "not-committed" &&
      code === "no_override" &&
      nested?.code === "no_override"
    ) {
      return {
        kind: "nothing-to-clear",
        cleared: false,
        nothingToClear: true,
      };
    }

    if (
      status === 503 &&
      meta?.status === 503 &&
      meta.capOutcome === "committed-conservatively-fenced" &&
      code === "sending_cap_convergence_pending" &&
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
      status === 503 &&
      meta?.status === 503 &&
      meta.capOutcome === "commit-outcome-unknown-conservatively-fenced" &&
      code === "sending_cap_commit_outcome_unknown" &&
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

    // A mutation response that cannot prove `not-committed` may follow a
    // durable clear even when its body was lost, malformed, or replaced by a
    // proxy. Return a held value so the UI can require a fresh GET instead of
    // exposing the POST again. Exact non-commit proof remains a normal
    // rejection and is safe for a later deliberate attempt.
    if (provesNotCommitted(status, code, meta, body, nested)) throw err;
    return {
      kind: "outcome-unknown",
      cleared: false,
      message:
        "The repair request did not return a complete outcome receipt. Its POST is held until fresh health verifies the current repair state.",
      requiresReconciliation: true,
    };
  }
}
