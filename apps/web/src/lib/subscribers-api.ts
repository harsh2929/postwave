// SPDX-License-Identifier: AGPL-3.0-only

import { api } from "./api";
import { isMockModeEnabled } from "./mock-mode";

export type SubscriberStatus =
  | "enabled"
  | "disabled"
  | "blocklisted"
  | "unconfirmed";

export type ConsentSource =
  | "double_optin"
  | "single_optin"
  | "import"
  | "api"
  | "unknown";

export interface Subscriber {
  id?: string;
  /** Stable identity-graph profile UUID, distinct from the row id. */
  profile_id?: string;
  email: string;
  primary_email?: string;
  external_id?: string | null;
  status: SubscriberStatus;
  mailchimp_status?: string;
  consent_timestamp: string | null;
  consent_source: ConsentSource;
  consent_email_marketing_at?: string | null;
  consent_sms_marketing_at?: string | null;
  consent_profiling_at?: string | null;
  consent_targeted_ads_at?: string | null;
  consent_ai_processing_at?: string | null;
  custom_fields: Record<string, string | number | boolean | null>;
  merge_fields?: Record<string, string | number | boolean | null>;
  tags: string[];
  first_name?: string;
  last_name?: string;
  full_name?: string;
  display_name?: string;
  locale?: string | null;
  language?: string | null;
  country?: string | null;
  region?: string | null;
  data_region?: string | null;
  signup_source?: string;
  account_id?: string | null;
  federated_master_id?: string | null;
  frequency_preference?: "default" | "weekly" | "monthly" | "paused";
  paused_until?: string | null;
  source_id?: string;
  source_platform?: string;
  /** Exact strong server revision; this is also emitted as the ETag header. */
  version?: string;
  archived_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface SubscriberPage {
  items: Subscriber[];
  total: number;
  page: number;
  per_page: number;
}

export interface SubscriberCounts {
  enabled: number;
  suppressed: number;
  pending: number;
}

export interface CreateSubscriberInput {
  email: string;
  status?: SubscriberStatus;
  consent_timestamp?: string | null;
  consent_source?: ConsentSource;
  custom_fields?: Record<string, string | number | boolean | null>;
  tags?: string[];
  source_id?: string;
  source_platform?: string;
}

export type UpdateSubscriberInput = Partial<CreateSubscriberInput> & {
  first_name?: string;
  last_name?: string;
  full_name?: string;
  merge_fields?: Record<string, string | number | boolean | null>;
  display_name?: string;
  locale?: string;
  language?: string;
  country?: string;
  region?: string;
  frequency_preference?: "default" | "weekly" | "monthly" | "paused";
  paused_until?: string | null;
  clear_paused_until?: boolean;
  consent_channel?: string;
  consent_legal_basis?: string;
  consent_jurisdiction?: string;
  consent_evidence?: string;
  consent_reason?: string;
  consent_policy_version?: string;
};

export interface SubscriberMutationOptions {
  expectedVersion?: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

const EXACT_SUBSCRIBER_VERSION = /^"subscriber:([A-Za-z0-9._~-]+):v[0-9]+"$/;

export function isExactSubscriberVersion(
  value: unknown,
  subscriberId?: string,
): value is string {
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    value.trim() !== value
  ) {
    return false;
  }
  const match = EXACT_SUBSCRIBER_VERSION.exec(value);
  return Boolean(
    match &&
    (subscriberId === undefined ||
      match[1]?.toLowerCase() === subscriberId.trim().toLowerCase()),
  );
}

const USE_MOCKS = isMockModeEnabled();
const loadMocks = () => import("./subscribers-mocks");

async function withMockFallback<T>(
  realCall: () => Promise<T>,
  fallback: () => T | Promise<T>,
): Promise<T> {
  if (USE_MOCKS) return await fallback();
  return realCall();
}

export interface ListSubscribersParams {
  page?: number;
  perPage?: number;
  /** Backend `?status=` value ("enabled" | "blocklisted" | "unconfirmed" | …). */
  status?: string;
  sort?: string;
  order?: "asc" | "desc";
  includeArchived?: boolean;
}

export function listSubscribers(
  params: ListSubscribersParams = {},
  signal?: AbortSignal,
): Promise<SubscriberPage> {
  const page = params.page ?? 1;
  const perPage = params.perPage ?? 50;
  return withMockFallback(
    () =>
      api.get<SubscriberPage>("/api/v1/subscribers", {
        query: {
          page,
          per_page: perPage,
          status: params.status || undefined,
          sort: params.sort || undefined,
          order: params.order || undefined,
          include_archived: params.includeArchived ? "true" : undefined,
        },
        signal,
      }),
    async () => (await loadMocks()).mockListSubscribers(page, perPage),
  );
}

export function searchSubscribers(
  q: string,
  page = 1,
  perPage = 50,
  signal?: AbortSignal,
  options: { includeArchived?: boolean } = {},
): Promise<SubscriberPage> {
  return withMockFallback(
    () =>
      api.get<SubscriberPage>("/api/v1/subscribers/search", {
        // The search hides archived contacts unless asked, exactly like the
        // list: without the flag "Show archived" stopped applying the moment
        // the operator typed a query.
        query: {
          q,
          page,
          per_page: perPage,
          include_archived: options.includeArchived ? "true" : undefined,
        },
        signal,
      }),
    async () => (await loadMocks()).mockSearchSubscribers(q, page, perPage),
  );
}

/** Tenant-wide lifecycle counts. Each request asks the backend for only one
 * row while using its filtered total, so dashboard KPIs never reflect merely
 * the current 50-row page. */
export function getSubscriberCounts(signal?: AbortSignal): Promise<SubscriberCounts> {
  return withMockFallback(
    async () => {
      const [enabled, suppressed, pending] = await Promise.all([
        api.get<SubscriberPage>("/api/v1/subscribers", {
          query: { page: 1, per_page: 1, status: "enabled" },
          signal,
        }),
        api.get<SubscriberPage>("/api/v1/subscribers", {
          query: { page: 1, per_page: 1, status: "blocklisted" },
          signal,
        }),
        api.get<SubscriberPage>("/api/v1/subscribers", {
          query: { page: 1, per_page: 1, status: "unconfirmed" },
          signal,
        }),
      ]);
      return {
        enabled: enabled.total,
        suppressed: suppressed.total,
        pending: pending.total,
      };
    },
    async () => {
      const page = await (await loadMocks()).mockListSubscribers(1, 10_000);
      return {
        enabled: page.items.filter((s) => s.status === "enabled").length,
        suppressed: page.items.filter((s) => s.status === "blocklisted").length,
        pending: page.items.filter((s) => s.status === "unconfirmed").length,
      };
    },
  );
}

export function createSubscriber(
  input: CreateSubscriberInput,
  options: SubscriberMutationOptions = {},
): Promise<Subscriber> {
  return withMockFallback(
    () => api.post<Subscriber>("/api/v1/subscribers", input, {
      idempotencyKey: options.idempotencyKey,
      maxAttempts: 1,
      requireOnline: true,
      signal: options.signal,
    }),
    async () => (await loadMocks()).mockCreateSubscriber(input),
  );
}

export function suppressSubscriber(
  id: string,
  options: SubscriberMutationOptions,
): Promise<void> {
  return withMockFallback(
    async () => {
      if (!isExactSubscriberVersion(options.expectedVersion, id)) {
        throw new Error("Reload this subscriber before suppressing it.");
      }
      let responseVersion: string | null = null;
      await api.post<void>(
        `/api/v1/subscribers/${encodeURIComponent(id)}/suppress`,
        undefined,
        {
          headers: { "If-Match": options.expectedVersion },
          idempotencyKey: options.idempotencyKey,
          maxAttempts: 1,
          requireOnline: true,
          signal: options.signal,
          onResponse: (response) => {
            responseVersion = response.headers.get("ETag");
          },
        },
      );
      if (!isExactSubscriberVersion(responseVersion, id)) {
        throw new Error(
          "The subscriber service did not confirm the suppression revision.",
        );
      }
    },
    async () => {
      (await loadMocks()).mockSuppressSubscriber(id);
    },
  );
}

// Re-enable through the canonical suppression removal path. It clears both
// suppression stores and updates subscriber status atomically; a status-only
// PATCH would leave the send gate blocking the address.
export interface SuppressionRemovalResult {
  ok: true;
  deleted: boolean;
  subscriber_status_changed: false;
  reviewed_resubscribe_required?: boolean;
}

export async function unsuppressSubscriber(
  id: string,
  email: string,
  options: SubscriberMutationOptions = {},
): Promise<SuppressionRemovalResult> {
  return withMockFallback(
    async () => {
      const result = await api.delete<SuppressionRemovalResult>(
        `/api/v1/deliverability/suppressions/${encodeURIComponent(
          email.trim().toLowerCase(),
        )}`,
        {
          idempotencyKey: options.idempotencyKey,
          maxAttempts: 1,
          requireOnline: true,
          signal: options.signal,
        },
      );
      if (
        result.ok !== true ||
        typeof result.deleted !== "boolean" ||
        result.subscriber_status_changed !== false ||
        (result.reviewed_resubscribe_required !== undefined &&
          typeof result.reviewed_resubscribe_required !== "boolean")
      ) {
        throw new Error(
          "The suppression service returned an invalid removal result.",
        );
      }
      return result;
    },
    async () => {
      (await loadMocks()).mockUnsuppressSubscriber(id);
      return {
        ok: true,
        deleted: true,
        subscriber_status_changed: false,
      };
    },
  );
}

export async function deleteSubscriber(
  id: string,
  options: SubscriberMutationOptions = {},
): Promise<void> {
  return withMockFallback(
    async () => {
      const etag = options.expectedVersion ?? (await ensureSubscriberETag(id));
      if (!isExactSubscriberVersion(etag, id)) {
        throw new Error(
          "Reload this subscriber before permanently deleting it.",
        );
      }
      return api.delete<void>(`/api/v1/subscribers/${encodeURIComponent(id)}`, {
        headers: { "If-Match": etag },
        idempotencyKey: options.idempotencyKey,
        maxAttempts: 1,
        requireOnline: true,
        signal: options.signal,
      });
    },
    async () => {
      (await loadMocks()).mockDeleteSubscriber(id);
    },
  );
}

/* -------------------------------------------------------------------------- *
 * Detail fetch + optimistic-concurrency (ETag) edit path
 *
 * The PATCH/archive/unarchive endpoints require `If-Match` with the opaque
 * concurrency token the server emits as the `ETag` header on GET (NOT the
 * numeric `version` field). We capture that header on read and echo it on the
 * next write, mirroring `campaigns-api.ts`.
 * -------------------------------------------------------------------------- */

const subscriberETags = new Map<string, string>();

function captureSubscriberETag(id: string, response: Response): void {
  // A 412 means the cached token is DEAD. `api.request` invokes onResponse
  // before it checks `res.ok`, and WritePreconditionFailed carries no ETag, so
  // a set-only capture left the rejected token in the map. `ensureSubscriberETag`
  // re-reads only when the cache is EMPTY, so every later save resent the dead
  // token and earned another 412 — editing the subscriber stayed broken until a
  // reload, and the cache is shared with archive/unarchive, so one conflict
  // poisoned those too. Same fix as `captureCampaignETag`.
  if (response.status === 412) {
    subscriberETags.delete(id);
    return;
  }
  const etag = response.headers.get("ETag");
  if (etag) subscriberETags.set(id, etag);
}

export async function getSubscriber(id: string): Promise<Subscriber> {
  let responseVersion: string | null = null;
  const subscriber = await api.get<Subscriber>(
    `/api/v1/subscribers/${encodeURIComponent(id)}`,
    {
      onResponse: (response) => {
        captureSubscriberETag(id, response);
        responseVersion = response.headers.get("ETag");
      },
    },
  );
  if (
    !subscriber.id ||
    !isExactSubscriberVersion(subscriber.version, subscriber.id) ||
    subscriber.version !== responseVersion
  ) {
    throw new Error(
      "The subscriber service returned an invalid profile revision.",
    );
  }
  return subscriber;
}

async function ensureSubscriberETag(id: string): Promise<string> {
  const cached = subscriberETags.get(id);
  if (cached) return cached;
  await getSubscriber(id);
  const fresh = subscriberETags.get(id);
  if (!fresh) {
    throw new Error("Could not obtain the record's concurrency token.");
  }
  return fresh;
}

export async function updateSubscriber(
  id: string,
  input: UpdateSubscriberInput,
  options: SubscriberMutationOptions = {},
): Promise<Subscriber> {
  const etag = options.expectedVersion ?? (await ensureSubscriberETag(id));
  if (!isExactSubscriberVersion(etag, id)) {
    throw new Error("Reload this subscriber before saving changes.");
  }
  let responseVersion: string | null = null;
  const subscriber = await api.patch<Subscriber>(
    `/api/v1/subscribers/${encodeURIComponent(id)}`,
    input,
    {
      headers: { "If-Match": etag },
      idempotencyKey: options.idempotencyKey,
      maxAttempts: 1,
      onResponse: (response) => {
        captureSubscriberETag(id, response);
        responseVersion = response.headers.get("ETag");
      },
      requireOnline: true,
      signal: options.signal,
    },
  );
  if (
    subscriber.id !== id ||
    !isExactSubscriberVersion(subscriber.version, id) ||
    subscriber.version !== responseVersion
  ) {
    throw new Error(
      "The subscriber service returned an invalid profile revision.",
    );
  }
  return subscriber;
}

export async function archiveSubscriber(id: string, options: SubscriberMutationOptions = {}): Promise<Subscriber> {
  const etag = await ensureSubscriberETag(id);
  return api.patch<Subscriber>(
    `/api/v1/subscribers/${encodeURIComponent(id)}/archive`,
    undefined,
    {
      headers: { "If-Match": etag },
      idempotencyKey: options.idempotencyKey,
      maxAttempts: 1,
      requireOnline: true,
      signal: options.signal,
      onResponse: (response) => captureSubscriberETag(id, response),
    },
  );
}

export async function unarchiveSubscriber(id: string, options: SubscriberMutationOptions = {}): Promise<Subscriber> {
  const etag = await ensureSubscriberETag(id);
  return api.patch<Subscriber>(
    `/api/v1/subscribers/${encodeURIComponent(id)}/unarchive`,
    undefined,
    {
      headers: { "If-Match": etag },
      idempotencyKey: options.idempotencyKey,
      maxAttempts: 1,
      requireOnline: true,
      signal: options.signal,
      onResponse: (response) => captureSubscriberETag(id, response),
    },
  );
}

/* ------------------------------- CSV export ------------------------------- */

export interface ExportSubscribersParams {
  status?: string;
  q?: string;
  sort?: string;
  order?: "asc" | "desc";
  includeArchived?: boolean;
  limit?: number;
}

/** Export the selected rows as CSV. `bulk/export-by-segment` accepts explicit
 *  ids and streams text/csv — the shared request parser returns the raw body
 *  as a string when it isn't JSON. */
export function exportSelectedCsv(ids: string[]): Promise<string> {
  return api.post<string>("/api/v1/subscribers/bulk/export-by-segment", {
    subscriber_ids: ids,
  });
}

/** Build the `export.csv` path with the active filter, for `fetchTextAuthed`. */
export function subscribersExportPath(params: ExportSubscribersParams): string {
  const qs = new URLSearchParams();
  if (params.status) qs.set("status", params.status);
  if (params.q) qs.set("q", params.q);
  if (params.sort) qs.set("sort", params.sort);
  if (params.order) qs.set("order", params.order);
  if (params.includeArchived) qs.set("include_archived", "true");
  if (params.limit) qs.set("limit", String(params.limit));
  const query = qs.toString();
  return `/api/v1/subscribers/export.csv${query ? `?${query}` : ""}`;
}

/* --------------------------- Bulk operations ------------------------------ *
 * One-shot server-side bulk verbs. `subscriber_ids` is capped at 10k; supply
 * ids OR a segment_id, never both.
 * -------------------------------------------------------------------------- */

export interface BulkResult {
  affected: number;
  skipped?: number;
  source?: string;
  recovery_token?: string;
  recovery_until?: string;
  recovery_expired?: boolean;
  exclusions?: Record<string, number>;
}

interface BulkTarget {
  subscriber_ids?: string[];
  segment_id?: string;
}

type SubscriberBulkVerb =
  | "delete"
  | "tag"
  | "untag"
  | "add-to-list"
  | "unsubscribe"
  | "resubscribe";

function bulk<T = BulkResult>(
  verb: SubscriberBulkVerb,
  body: unknown,
  options: SubscriberMutationOptions = {},
): Promise<T> {
  return api.post<T>(`/api/v1/subscribers/bulk/${verb}`, body, {
    idempotencyKey: options.idempotencyKey,
    maxAttempts: 1,
    requireOnline: true,
    signal: options.signal,
  });
}

export function bulkDeleteSubscribers(ids: string[], options: SubscriberMutationOptions = {}): Promise<BulkResult> {
  return bulk("delete", { subscriber_ids: ids } satisfies BulkTarget, options);
}

export function bulkTagSubscribers(
  ids: string[],
  tag: string,
  options: SubscriberMutationOptions = {},
): Promise<BulkResult> {
  return bulk("tag", { subscriber_ids: ids, tag }, options);
}

export function bulkUntagSubscribers(
  ids: string[],
  tag: string,
  options: SubscriberMutationOptions = {},
): Promise<BulkResult> {
  return bulk("untag", { subscriber_ids: ids, tag }, options);
}

export function bulkAddToList(
  ids: string[],
  listId: string,
  options: SubscriberMutationOptions = {},
): Promise<BulkResult> {
  return bulk("add-to-list", { subscriber_ids: ids, list_id: listId }, options);
}

/** Bulk suppress == bulk unsubscribe (status -> blocklisted). */
export function bulkUnsubscribeSubscribers(ids: string[], options: SubscriberMutationOptions = {}): Promise<BulkResult> {
  return bulk("unsubscribe", { subscriber_ids: ids } satisfies BulkTarget, options);
}

export function bulkResubscribeSubscribers(ids: string[], options: SubscriberMutationOptions = {}): Promise<BulkResult> {
  return bulk("resubscribe", { subscriber_ids: ids } satisfies BulkTarget, options);
}

/** Redeem a recovery token returned by a reversible bulk op (tag/untag). */
export function bulkRecover(recoveryToken: string, options: SubscriberMutationOptions = {}): Promise<BulkResult> {
  return api.post<BulkResult>("/api/v1/subscribers/bulk/recover", {
    recovery_token: recoveryToken,
  }, {
    idempotencyKey: options.idempotencyKey,
    maxAttempts: 1,
    requireOnline: true,
    signal: options.signal,
  });
}

/* ------------------------------- Bulk paste ------------------------------- */

export interface BulkPasteRow {
  email: string;
  status: "created" | "updated" | "skipped" | "error";
  error_code?: string;
  error?: string;
}

export interface BulkPasteResponse {
  parsed: number;
  created: number;
  updated: number;
  skipped: number;
  errored: number;
  rows: BulkPasteRow[];
}

export function bulkPasteSubscribers(input: {
  emails: string;
  status?: string;
  tags?: string[];
}, options: SubscriberMutationOptions = {}): Promise<BulkPasteResponse> {
  return api.post<BulkPasteResponse>("/api/v1/subscribers/bulk-paste", input, {
    idempotencyKey: options.idempotencyKey,
    maxAttempts: 1,
    requireOnline: true,
    signal: options.signal,
  });
}
