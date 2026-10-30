import type { ApiResult } from "./result";

interface NativeFacadeRequestOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  requireOnline?: boolean;
  signal?: AbortSignal;
}

type SmsBroadcastsRequester = <T>(
  path: string,
  init?: RequestInit,
  opts?: NativeFacadeRequestOptions,
) => Promise<ApiResult<T>>;

/* ---------- R8 SMS broadcasts (sms/broadcasts.go) -------------------- */

/**
 * sms.Broadcast. Audience is EXACTLY ONE of list_ids | segment_id |
 * tag (server-enforced; violations come back as a typed 422). Counters
 * (sent/failed/held) are denormalised and refreshed by /progress.
 */
export interface SmsBroadcast {
  id: string;
  tenant_id: string;
  sender_profile_id?: string;
  campaign_id?: string;
  name: string;
  body: string;
  list_ids: string[];
  segment_id?: string;
  tag?: string;
  /** draft | scheduled | sending | sent | cancelled (render, don't switch). */
  status: string;
  scheduled_at?: string | null;
  sent_count: number;
  failed_count: number;
  held_count: number;
  segments_per_message: number;
  created_at: string;
  updated_at: string;
}

/** Create/PATCH body (sms.BroadcastUpsert) — all fields optional on
 *  PATCH; typed errors include `audience_too_large` (422). */
export interface SmsBroadcastUpsert {
  sender_profile_id?: string;
  name?: string;
  body?: string;
  list_ids?: string[];
  segment_id?: string;
  tag?: string;
  scheduled_at?: string | null;
}

export interface SmsBroadcastProgress {
  status: string;
  sent: number;
  failed: number;
  held: number;
  total: number;
}

export interface SmsBroadcastSendResponse {
  broadcast: SmsBroadcast;
  progress: SmsBroadcastProgress;
  enqueued: number;
}

export interface SmsBroadcastListResponse {
  tenantId: string;
  items: SmsBroadcast[];
  nextCursor?: string;
  snapshotAt: string;
  /** Server dispatch prerequisites only; recipient policy is rechecked later. */
  broadcastDispatchAvailable: boolean;
  broadcastDispatchUnavailableReason?: string;
}

type UnknownRecord = Record<string, unknown>;
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CURSOR_RE = /^v1\.[A-Za-z0-9_-]+$/u;
const BROADCAST_STATUSES = new Set([
  "draft",
  "scheduled",
  "sending",
  "sent",
  "cancelled",
]);
const BROADCAST_KEYS = new Set([
  "id",
  "tenant_id",
  "sender_profile_id",
  "campaign_id",
  "name",
  "body",
  "list_ids",
  "segment_id",
  "tag",
  "status",
  "scheduled_at",
  "sent_count",
  "failed_count",
  "held_count",
  "segments_per_message",
  "created_at",
  "updated_at",
]);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value)) &&
    /(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(value)
  );
}

function isBroadcast(value: unknown, tenantId: string): value is SmsBroadcast {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !BROADCAST_KEYS.has(key)) ||
    !UUID_V4_RE.test(value.id as string) ||
    value.tenant_id !== tenantId ||
    (value.sender_profile_id !== undefined &&
      !UUID_V4_RE.test(value.sender_profile_id as string)) ||
    (value.campaign_id !== undefined &&
      !UUID_V4_RE.test(value.campaign_id as string)) ||
    typeof value.name !== "string" ||
    value.name.length < 1 ||
    value.name.length > 256 ||
    typeof value.body !== "string" ||
    value.body.length > 16_384 ||
    !Array.isArray(value.list_ids) ||
    !value.list_ids.every(
      (id) => typeof id === "string" && UUID_V4_RE.test(id),
    ) ||
    (value.segment_id !== undefined &&
      !UUID_V4_RE.test(value.segment_id as string)) ||
    (value.tag !== undefined &&
      (typeof value.tag !== "string" ||
        value.tag.length < 1 ||
        value.tag.length > 128)) ||
    typeof value.status !== "string" ||
    !BROADCAST_STATUSES.has(value.status) ||
    (value.scheduled_at !== undefined &&
      value.scheduled_at !== null &&
      !isTimestamp(value.scheduled_at)) ||
    !["sent_count", "failed_count", "held_count", "segments_per_message"].every(
      (key) => Number.isInteger(value[key]) && (value[key] as number) >= 0,
    ) ||
    !isTimestamp(value.created_at) ||
    !isTimestamp(value.updated_at)
  ) {
    return false;
  }
  return new Set(value.list_ids as string[]).size === value.list_ids.length;
}

function invalidBroadcastResponse<T>(): ApiResult<T> {
  return {
    error: {
      kind: "parse",
      code: "invalid_sms_broadcast_response",
      message:
        "The SMS service returned a broadcast response that did not match the verified contract.",
    },
    retryability: "not-retryable",
  };
}

export function createSmsBroadcastsApi(
  request: SmsBroadcastsRequester,
  getTenantId: () => string | null = () => null,
) {
  return {
    /** GET /api/v1/sms/broadcasts → items plus dispatch readiness (admin). */
    async list(
      opts: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
    ): Promise<ApiResult<SmsBroadcastListResponse>> {
      const params = new URLSearchParams();
      if (opts.cursor) params.set("cursor", opts.cursor);
      if (opts.limit !== undefined) params.set("limit", String(opts.limit));
      const query = params.toString();
      const result = await request<unknown>(
        `/api/v1/sms/broadcasts${query ? `?${query}` : ""}`,
        undefined,
        opts.signal ? { signal: opts.signal } : undefined,
      );
      if ("error" in result && result.error) return result;
      const value = result.data;
      const tenantId = getTenantId();
      if (
        !isRecord(value) ||
        Object.keys(value).some(
          (key) =>
            !new Set([
              "tenantId",
              "items",
              "nextCursor",
              "snapshotAt",
              "broadcastDispatchAvailable",
              "broadcastDispatchUnavailableReason",
            ]).has(key),
        ) ||
        !tenantId ||
        !UUID_V4_RE.test(tenantId) ||
        value.tenantId !== tenantId ||
        !Array.isArray(value.items) ||
        !Number.isInteger(opts.limit ?? 50) ||
        (opts.limit ?? 50) < 1 ||
        (opts.limit ?? 50) > 200 ||
        value.items.length > (opts.limit ?? 50) ||
        !value.items.every((item) => isBroadcast(item, tenantId)) ||
        new Set(value.items.map((item) => (item as SmsBroadcast).id)).size !==
          value.items.length ||
        !isTimestamp(value.snapshotAt) ||
        (value.nextCursor !== undefined &&
          (typeof value.nextCursor !== "string" ||
            value.nextCursor.length > 4096 ||
            !CURSOR_RE.test(value.nextCursor) ||
            value.items.length !== (opts.limit ?? 50))) ||
        typeof value.broadcastDispatchAvailable !== "boolean" ||
        (value.broadcastDispatchAvailable
          ? value.broadcastDispatchUnavailableReason !== undefined
          : typeof value.broadcastDispatchUnavailableReason !== "string" ||
            value.broadcastDispatchUnavailableReason.length < 1 ||
            value.broadcastDispatchUnavailableReason.length > 128)
      ) {
        return invalidBroadcastResponse();
      }
      return { ...result, data: value as unknown as SmsBroadcastListResponse };
    },
    /** POST /api/v1/sms/broadcasts — 201 (admin). */
    create(input: SmsBroadcastUpsert): Promise<ApiResult<SmsBroadcast>> {
      return request<SmsBroadcast>("/api/v1/sms/broadcasts", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    /** GET /api/v1/sms/broadcasts/{id}. */
    get(id: string): Promise<ApiResult<SmsBroadcast>> {
      return request<SmsBroadcast>(
        `/api/v1/sms/broadcasts/${encodeURIComponent(id)}`,
      );
    },
    /** PATCH /api/v1/sms/broadcasts/{id} — draft|scheduled only (admin). */
    update(
      id: string,
      patch: SmsBroadcastUpsert,
    ): Promise<ApiResult<SmsBroadcast>> {
      return request<SmsBroadcast>(
        `/api/v1/sms/broadcasts/${encodeURIComponent(id)}`,
        { method: "PATCH", body: JSON.stringify(patch) },
      );
    },
    /** DELETE /api/v1/sms/broadcasts/{id} → `{ok:true}` (not while sending). */
    remove(id: string): Promise<ApiResult<{ ok: boolean }>> {
      return request<{ ok: boolean }>(
        `/api/v1/sms/broadcasts/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
    },
    /** POST /api/v1/sms/broadcasts/{id}/send — 202
     *  `{broadcast,progress,enqueued}`. Idempotent server-side (the
     *  draft|scheduled → sending claim flips exactly once); still
     *  requireOnline because it's a real send. 503
     *  sms_provider_unconfigured when no provider is wired. */
    send(id: string): Promise<ApiResult<SmsBroadcastSendResponse>> {
      return request<SmsBroadcastSendResponse>(
        `/api/v1/sms/broadcasts/${encodeURIComponent(id)}/send`,
        { method: "POST", body: "{}" },
        { requireOnline: true, timeoutMs: 30_000 },
      );
    },
    /** POST /api/v1/sms/broadcasts/{id}/cancel → updated Broadcast. */
    cancel(id: string): Promise<ApiResult<SmsBroadcast>> {
      return request<SmsBroadcast>(
        `/api/v1/sms/broadcasts/${encodeURIComponent(id)}/cancel`,
        { method: "POST", body: "{}" },
        { requireOnline: true },
      );
    },
    /** GET /api/v1/sms/broadcasts/{id}/progress — refreshes counters and
     *  lazily finalises sending → sent when the queue drains. */
    progress(
      id: string,
      opts: { signal?: AbortSignal } = {},
    ): Promise<ApiResult<SmsBroadcastProgress>> {
      return request<SmsBroadcastProgress>(
        `/api/v1/sms/broadcasts/${encodeURIComponent(id)}/progress`,
        undefined,
        opts.signal ? { signal: opts.signal } : undefined,
      );
    },
  };
}
