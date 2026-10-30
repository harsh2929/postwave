import type { ApiRequester, ApiResult } from "./result";
import { createPushSuppressionsApi } from "./push-suppressions";

export {
  createPushSuppressionsApi,
  PUSH_PLATFORMS,
  PUSH_SUPPRESSION_REASONS,
} from "./push-suppressions";
export type {
  PushSuppressionApiIdentityOptions,
  PushSuppressionBulkImportReceipt,
  PushSuppressionBulkRemoveItem,
  PushSuppressionBulkRemoveReceipt,
  PushSuppressionDeleteReceipt,
  PushSuppressionListResponse,
  PushSuppressionLockedReason,
  PushSuppressionPlatform,
  PushSuppressionReason,
  PushSuppressionRow,
  PushSuppressionSource,
} from "./push-suppressions";

/* =====================================================================
 * Lists & Suppressions 2026 (Wave 1) — converged suppressions, audit
 * log, subscription types, list singleton + members, segment preview
 * count + recompute.
 *
 * Backend source of truth:
 *   - apps/api/internal/suppressions/{handlers,suppressions,store,audit}.go
 *   - apps/api/internal/subscription_types/{handlers,subscription_types}.go
 *   - apps/api/internal/lists/{lists,members}.go
 *   - apps/api/internal/segments/preview_count.go
 *
 * Wired routes (verified against main.go):
 *   GET    /api/v1/deliverability/suppressions
 *   POST   /api/v1/deliverability/suppressions
 *   DELETE /api/v1/deliverability/suppressions/{email}
 *   (D16#3: the /api/v1/suppressions/legacy* routes were listed here but
 *    are NOT mounted in the backend — their client methods were removed.)
 *
 *   GET    /api/v1/subscription-types
 *   POST   /api/v1/subscription-types
 *   PATCH  /api/v1/subscription-types/{id}
 *   DELETE /api/v1/subscription-types/{id}
 *   GET    /api/v1/subscribers/{id}/subscription-types
 *   POST   /api/v1/subscribers/{id}/subscription-types/{type_id}/opt-out
 *   DELETE /api/v1/subscribers/{id}/subscription-types/{type_id}/opt-out
 *
 *   GET    /api/v1/lists/{id}
 *   PATCH  /api/v1/lists/{id}
 *   GET    /api/v1/lists/{id}/subscribers
 *
 *   POST   /api/v1/segments/preview-count
 *   POST   /api/v1/segments/{id}/recompute
 *
 * NOTE: keep additions inside this block so sibling agents don't
 * conflict on the same lines.
 * =================================================================== */

/* ---------- suppressions (X1 converged surface) -------------------- */

/** Mirrors `suppressions.Channel` (migration 0245). */
export type SuppressionChannel = "email" | "sms" | "push" | "any";

/** Mirrors `suppressions.Scope` (migration 0245). */
export type SuppressionScope = "marketing" | "transactional" | "all";

/**
 * Canonical reasons admitted by the X1 CHECK constraint after
 * migration 0244. The legacy free-form values are normalised
 * server-side via NormalizeReason().
 */
export type SuppressionReason =
  | "hard_bounce"
  | "spam_complaint"
  | "manual_unsubscribe"
  | "list_manual"
  | "global_unsubscribe"
  | "soft_bounce_threshold"
  | "dsar_deletion"
  | "role_address"
  | "invalid_email"
  | "blocklist_auto"
  // SUB-047 / SUB-048: Klaviyo-compatible rich taxonomy. CHECK widened
  // in migration 0512; canonical strings from suppressions/store.go.
  | "soft_bounce"
  | "complaint"
  | "list_unsub_header"
  | "spamtrap"
  | "role_account"
  | "dns_failure"
  | "invalid_address";

/**
 * Source attribution — which surface wrote the row. Mirrors
 * `suppressions.Source`.
 */
export type SuppressionSource =
  | "postmark"
  | "mailgun"
  | "ses"
  | "manual"
  | "api"
  | "import";

/**
 * Mirrors `suppressions.Entry` (apps/api/internal/suppressions/store.go).
 * The Wave-1 backend added CampaignID, MessageID, BounceCode,
 * ProviderEventID, Channel, Scope, MatchKind, SourceTable on top of
 * the legacy fields so the audit UI can render
 * "suppressed by campaign X, bounce 550 5.1.1" without peeking into
 * the metadata bag.
 */
export interface SuppressionEntry {
  id: string;
  tenant_id?: string;
  email: string;
  reason: SuppressionReason | string;
  source: SuppressionSource | string;
  source_event_id?: string;
  campaign_id?: string;
  message_id?: string;
  bounce_code?: string;
  provider_event_id?: string;
  channel?: SuppressionChannel;
  scope?: SuppressionScope;
  /** "exact" | "domain" | "" — populated by the converger view. */
  match_kind?: string;
  /** "subscriber_suppressions" | "suppressions" | "email_suppressions". */
  source_table?: string;
  /**
   * SUB-048 — durable raw bounce classification the ingest receiver
   * derived from provider codes + metadata at ingest time (spamtrap /
   * role_account / dns_failure / invalid_address / …). Survives an
   * operator reclassification of `reason`. Empty for manual adds.
   */
  bounce_category?: string;
  created_at: string;
  expires_at?: string | null;
  metadata?: Record<string, unknown>;
}

/** Wire envelope for GET /api/v1/deliverability/suppressions. */
export interface SuppressionEntryPage {
  items: SuppressionEntry[];
  total: number;
  page: number;
  size: number;
}

/** Body for POST /api/v1/deliverability/suppressions. */
export interface SuppressionAddInput {
  email: string;
  reason?: SuppressionReason | string;
  source?: SuppressionSource | string;
  channel?: SuppressionChannel;
  scope?: SuppressionScope;
  /** RFC 3339; omit for permanent. */
  expires_at?: string;
  metadata?: Record<string, unknown>;
}

/** Reasons accepted by the converged X1 surface. UI dropdown source. */
export const SUPPRESSION_REASONS_X1: ReadonlyArray<{
  value: SuppressionReason;
  label: string;
}> = [
  { value: "manual_unsubscribe", label: "Manual unsubscribe" },
  { value: "list_manual", label: "List manual" },
  { value: "hard_bounce", label: "Hard bounce" },
  { value: "spam_complaint", label: "Spam complaint" },
  { value: "global_unsubscribe", label: "Global unsubscribe" },
  { value: "soft_bounce_threshold", label: "Soft-bounce threshold" },
  { value: "dsar_deletion", label: "DSAR deletion" },
  { value: "role_address", label: "Role address" },
  { value: "invalid_email", label: "Invalid email" },
  { value: "blocklist_auto", label: "Auto blocklist" },
  // SUB-047 / SUB-048: Klaviyo-compatible rich taxonomy (migration 0512).
  { value: "soft_bounce", label: "Soft bounce" },
  { value: "complaint", label: "Complaint" },
  { value: "list_unsub_header", label: "List-unsubscribe header" },
  { value: "spamtrap", label: "Spam trap" },
  { value: "role_account", label: "Role account" },
  { value: "dns_failure", label: "DNS failure" },
  { value: "invalid_address", label: "Invalid address" },
];

/**
 * Suppression audit row — mirrors `suppressions.AuditEntry`. Created
 * on every X1 + legacy mutation so an operator can answer "who
 * removed this address?" in compliance review. Served by
 * GET /api/v1/suppressions/{emailOrId}/audit.
 */
export interface SuppressionAuditEntry {
  id?: string;
  tenant_id: string;
  email: string;
  action: "add" | "remove" | "update" | "expire";
  /** Display label for who acted ("Jane D.", "API key pw_ab…"). */
  actor?: string;
  actor_user_id?: string;
  actor_api_key_id?: string;
  reason?: string;
  source_table:
    | "subscriber_suppressions"
    | "suppressions"
    | "email_suppressions"
    | string;
  payload?: Record<string, unknown>;
  created_at?: string;
}

/** Envelope for GET /api/v1/suppressions/{emailOrId}/audit. */
export interface SuppressionAuditPage {
  items: SuppressionAuditEntry[];
  total?: number;
  page?: number;
  /** Echo of the resolved email when the path segment was an id. */
  email?: string;
}

/* ---------- suppressions: methods --------------------------------- */

export function createSuppressionsConvergedApi(request: ApiRequester) {
  /**
   * Legacy fallback for {@link suppressionsConvergedApi.get}: paginate
   * client-side with a bounded budget (5 pages × 200 rows) against
   * servers that pre-date the `email=` list filter. Outcomes (audit
   * §4.3 B1):
   *   - hit found                  → { data }
   *   - full table scanned, no hit → honest 404 (genuinely absent)
   *   - budget exhausted first     → `scan_truncated` error — we must
   *     NOT report "not suppressed" for an address we never reached
   *     (compliance falsehood).
   */
  async function legacySuppressionScan(
    email: string,
  ): Promise<ApiResult<SuppressionEntry>> {
    const PAGE_SIZE = 200;
    const MAX_PAGES = 5;
    const target = email.trim().toLowerCase();
    let scanned = 0;
    let total = Number.POSITIVE_INFINITY;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const res = await suppressionsConvergedApi.list({
        page,
        size: PAGE_SIZE,
      });
      if (res.error) return res;
      const items = res.data.items || [];
      const hit = items.find(
        (e) => (e.email || "").trim().toLowerCase() === target,
      );
      if (hit) return { data: hit };
      scanned += items.length;
      if (typeof res.data.total === "number" && res.data.total >= 0) {
        total = res.data.total;
      }
      // Exhausted the table — the address is genuinely not suppressed.
      if (scanned >= total || items.length < PAGE_SIZE) {
        return {
          error: {
            message: "no suppression for email",
            kind: "http",
            status: 404,
            code: "not_found",
          },
        };
      }
    }
    return {
      error: {
        code: "scan_truncated",
        message: `Could not confirm suppression status: scanned ${scanned} of ${Number.isFinite(total) ? total : "unknown"} entries before hitting the lookup budget.`,
      },
    };
  }

  /**
   * X1 / converged suppressions API. Read + write the canonical
   * subscriber_suppressions table; the send-loop's converger view
   * stitches legacy hits in transparently.
   */
  const suppressionsConvergedApi = {
    /**
     * GET /api/v1/deliverability/suppressions?page=&size=&email=&q=
     * `email` is an EXACT (citext) match; `q` is a prefix filter. Both
     * are honoured by current servers; older builds ignore unknown query
     * params except where noted in `get()` below.
     */
    list(
      opts: { page?: number; size?: number; email?: string; q?: string } = {},
    ): Promise<ApiResult<SuppressionEntryPage>> {
      const params = new URLSearchParams();
      if (opts.page) params.set("page", String(opts.page));
      if (opts.size) params.set("size", String(opts.size));
      if (opts.email) params.set("email", opts.email);
      if (opts.q) params.set("q", opts.q);
      const qs = params.toString();
      return request<SuppressionEntryPage>(
        `/api/v1/deliverability/suppressions${qs ? `?${qs}` : ""}`,
      );
    },

    /**
     * GET a single row by email via the server-side `email=` exact
     * filter (citext — case is collapsed server-side). Outcomes:
     *   - hit found        → { data }
     *   - empty result     → honest 404 (genuinely absent)
     *   - 400 from server  → an OLDER server that rejects the filter
     *     param; falls back to the legacy bounded client-side scan
     *     (5 pages × 200 rows — see {@link legacySuppressionScan}).
     */
    async get(email: string): Promise<ApiResult<SuppressionEntry>> {
      const res = await suppressionsConvergedApi.list({
        email: email.trim(),
        size: 1,
      });
      if (res.error) {
        // Older server rejecting the email= filter — budgeted scan.
        if (res.error.kind === "http" && res.error.status === 400) {
          return legacySuppressionScan(email);
        }
        return res;
      }
      const hit = (res.data.items || [])[0];
      if (!hit) {
        return {
          error: {
            message: "no suppression for email",
            kind: "http",
            status: 404,
            code: "not_found",
          },
        };
      }
      return { data: hit };
    },

    /** POST /api/v1/deliverability/suppressions */
    add(input: SuppressionAddInput): Promise<ApiResult<SuppressionEntry>> {
      return request<SuppressionEntry>("/api/v1/deliverability/suppressions", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },

    /** DELETE /api/v1/deliverability/suppressions/{email} */
    remove(email: string): Promise<ApiResult<{ ok: boolean }>> {
      return request<{ ok: boolean }>(
        `/api/v1/deliverability/suppressions/${encodeURIComponent(email)}`,
        { method: "DELETE" },
      );
    },

    // D16#3: migrate() / listLegacy() / removeLegacy() were removed — the
    // POST /suppressions/migrate-legacy, GET /suppressions/legacy and DELETE
    // /suppressions/legacy/{id} routes are not registered anywhere in the
    // backend (no handler funcs, no route mount) and had zero UI callers.
    // The block comment previously mis-labelled them "(flagged)" as if
    // env-gated; they simply do not exist.
  };

  return suppressionsConvergedApi;
}

/* ---------- subscription types ------------------------------------ */

/** Mirrors `subscription_types.Channel`. */
export type SubscriptionTypeChannel = "email" | "sms" | "push" | "all";

/** Mirrors `subscription_types.OptOutSource`. */
export type SubscriptionTypeOptOutSource =
  | "preference_center"
  | "api"
  | "admin"
  | "one_click"
  | "import"
  | "webhook";

/** Mirrors `subscription_types.SubscriptionType`. */
export interface SubscriptionType {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  channel: SubscriptionTypeChannel;
  is_default: boolean;
  is_internal: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/** Mirrors `subscription_types.SubscriberView` (per-subscriber row). */
export interface SubscriptionTypeOptOut {
  type: SubscriptionType;
  opted_out: boolean;
  opted_out_at?: string;
  source?: SubscriptionTypeOptOutSource;
  channel?: SubscriptionTypeChannel;
}

/** Body for POST /api/v1/subscription-types. */
export interface SubscriptionTypeCreateInput {
  name: string;
  description?: string;
  channel?: SubscriptionTypeChannel;
  is_default?: boolean;
  sort_order?: number;
}

/** Body for PATCH /api/v1/subscription-types/{id}. All fields optional. */
export interface SubscriptionTypeUpdateInput {
  name?: string;
  description?: string;
  channel?: SubscriptionTypeChannel;
  is_default?: boolean;
  sort_order?: number;
}

/** Body for POST /…/opt-out. All fields optional. */
export interface SubscriptionTypeOptOutInput {
  channel?: SubscriptionTypeChannel;
  source?: SubscriptionTypeOptOutSource;
  source_event_id?: string;
}

export function createSubscriptionTypesApi(request: ApiRequester) {
  const subscriptionTypesApi = {
    /** GET /api/v1/subscription-types?channel=email */
    list(
      opts: { channel?: SubscriptionTypeChannel } = {},
    ): Promise<ApiResult<SubscriptionType[]>> {
      const params = new URLSearchParams();
      if (opts.channel) params.set("channel", opts.channel);
      const qs = params.toString();
      return request<SubscriptionType[]>(
        `/api/v1/subscription-types${qs ? `?${qs}` : ""}`,
      );
    },

    /**
     * GET a single subscription type by id. No dedicated singleton on
     * the Wave-1 backend — filter the list and surface 404 when missing.
     *
     * Unlike suppressions, this is NOT a truncated-sample lookup: the
     * backend list endpoint is unpaginated and returns every row for the
     * tenant (verified: subscription_types/handlers.go::List → Repo.List
     * with no LIMIT), so a miss here is a genuine 404.
     */
    async get(id: string): Promise<ApiResult<SubscriptionType>> {
      const res = await subscriptionTypesApi.list();
      if (res.error) return res;
      const hit = (res.data || []).find((t) => t.id === id);
      if (!hit) {
        return {
          error: {
            message: "subscription type not found",
            kind: "http",
            status: 404,
            code: "not_found",
          },
        };
      }
      return { data: hit };
    },

    /** POST /api/v1/subscription-types */
    create(
      input: SubscriptionTypeCreateInput,
    ): Promise<ApiResult<SubscriptionType>> {
      return request<SubscriptionType>("/api/v1/subscription-types", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },

    /** PATCH /api/v1/subscription-types/{id} */
    update(
      id: string,
      patch: SubscriptionTypeUpdateInput,
    ): Promise<ApiResult<SubscriptionType>> {
      return request<SubscriptionType>(
        `/api/v1/subscription-types/${encodeURIComponent(id)}`,
        { method: "PATCH", body: JSON.stringify(patch) },
      );
    },

    /** DELETE /api/v1/subscription-types/{id} */
    remove(id: string): Promise<ApiResult<{ ok: boolean }>> {
      return request<{ ok: boolean }>(
        `/api/v1/subscription-types/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
    },
  };

  return subscriptionTypesApi;
}

/** Per-subscriber subscription-type opt-out surface. */
export function createSubscriberSubscriptionTypesApi(request: ApiRequester) {
  const subscriberSubscriptionTypesApi = {
    /** GET /api/v1/subscribers/{id}/subscription-types */
    list(subscriberID: string): Promise<ApiResult<SubscriptionTypeOptOut[]>> {
      return request<SubscriptionTypeOptOut[]>(
        `/api/v1/subscribers/${encodeURIComponent(subscriberID)}/subscription-types`,
      );
    },

    /** POST /api/v1/subscribers/{id}/subscription-types/{type_id}/opt-out */
    optOut(
      subscriberID: string,
      typeID: string,
      input: SubscriptionTypeOptOutInput = {},
    ): Promise<ApiResult<SubscriptionTypeOptOut>> {
      return request<SubscriptionTypeOptOut>(
        `/api/v1/subscribers/${encodeURIComponent(subscriberID)}/subscription-types/${encodeURIComponent(typeID)}/opt-out`,
        { method: "POST", body: JSON.stringify(input) },
      );
    },

    /**
     * DELETE /api/v1/subscribers/{id}/subscription-types/{type_id}/opt-out
     * Optional `channel` query param scopes the opt-in to a single
     * channel; omit to opt in across all channels.
     */
    optIn(
      subscriberID: string,
      typeID: string,
      opts: { channel?: SubscriptionTypeChannel } = {},
    ): Promise<ApiResult<{ ok: boolean }>> {
      const params = new URLSearchParams();
      if (opts.channel) params.set("channel", opts.channel);
      const qs = params.toString();
      return request<{ ok: boolean }>(
        `/api/v1/subscribers/${encodeURIComponent(subscriberID)}/subscription-types/${encodeURIComponent(typeID)}/opt-out${qs ? `?${qs}` : ""}`,
        { method: "DELETE" },
      );
    },
  };

  return subscriberSubscriptionTypesApi;
}

/* ---------- lists: singleton get / patch / members ---------------- */

/** Mirrors `lists.List` (proxied from Listmonk). */
export interface ListsListEntry {
  id: number;
  name: string;
  type?: string;
  optin?: string;
  tags?: string[];
  description?: string;
  [extra: string]: unknown;
}

/** PATCH whitelist — mirrors `lists.UpdateListInput`. */
export interface ListsUpdateInput {
  name?: string;
  type?: string;
  optin?: string;
  tags?: string[];
  description?: string;
}

/** Mirrors `lists.MemberSubscriber`. */
export interface ListMember {
  id: string;
  email: string;
  status: string;
  source?: string;
  added_at: string;
}

/** Mirrors `lists.MembersPage`. */
export interface ListMembersPage {
  items: ListMember[];
  total: number;
  page: number;
  per_page: number;
}

/** Result of POST /api/v1/lists/{id}/subscribers (bulk add). */
export interface ListAddMembersResult {
  added: number;
  /** Already members / suppressed / unknown ids — not added. */
  skipped: number;
}

/**
 * One per-list suppression row — GET /api/v1/lists/{id}/suppressions.
 * The wire carries NO id field; rows are keyed by `email` (unique per
 * list). Use `email` as the React row key.
 */
export interface ListSuppressionRow {
  email: string;
  reason: string;
  source: string;
  provider_event_id?: string;
  metadata?: Record<string, unknown>;
  suppressed_at: string;
  expires_at?: string | null;
  created_at: string;
  /** Which physical table the row came from (converger attribution). */
  source_table?: string;
}

/** Envelope for GET /api/v1/lists/{id}/suppressions. */
export interface ListSuppressionsPage {
  items: ListSuppressionRow[];
  total: number;
  page: number;
  per_page: number;
}

export function createListsExtendedApi(request: ApiRequester) {
  const listsExtendedApi = {
    /** GET /api/v1/lists/{id} — singleton proxy to Listmonk. */
    get(id: string | number): Promise<ApiResult<ListsListEntry>> {
      return request<ListsListEntry>(
        `/api/v1/lists/${encodeURIComponent(String(id))}`,
      );
    },

    /** PATCH /api/v1/lists/{id} */
    patch(
      id: string | number,
      input: ListsUpdateInput,
    ): Promise<ApiResult<ListsListEntry>> {
      return request<ListsListEntry>(
        `/api/v1/lists/${encodeURIComponent(String(id))}`,
        { method: "PATCH", body: JSON.stringify(input) },
      );
    },

    /**
     * GET /api/v1/lists/{id}/subscribers — paginated members tab.
     * Accepts either the Moosewave uuid or the Listmonk bigint id; the
     * backend resolves via list_id_map.
     */
    members(
      id: string | number,
      opts: {
        query?: string;
        status?: "enabled" | "disabled" | "blocklisted" | "unconfirmed";
        page?: number;
        perPage?: number;
      } = {},
    ): Promise<ApiResult<ListMembersPage>> {
      const params = new URLSearchParams();
      if (opts.query) params.set("query", opts.query);
      if (opts.status) params.set("status", opts.status);
      if (opts.page) params.set("page", String(opts.page));
      if (opts.perPage) params.set("per_page", String(opts.perPage));
      const qs = params.toString();
      return request<ListMembersPage>(
        `/api/v1/lists/${encodeURIComponent(String(id))}/subscribers${qs ? `?${qs}` : ""}`,
      );
    },

    /**
     * POST /api/v1/lists/{id}/subscribers — bulk-add existing subscribers
     * to the list by id (≤1000 per call; larger batches are rejected
     * locally so the server's 400 never fires). Returns `{added,
     * skipped}` — skipped covers already-members and unknown ids.
     */
    addMembers(
      listId: string | number,
      ids: string[],
    ): Promise<ApiResult<ListAddMembersResult>> {
      if (ids.length === 0) {
        return Promise.resolve({ data: { added: 0, skipped: 0 } });
      }
      if (ids.length > 1000) {
        return Promise.resolve({
          error: {
            kind: "invalid_config",
            message: "addMembers accepts at most 1000 subscriber ids per call.",
          },
        });
      }
      return request<ListAddMembersResult>(
        `/api/v1/lists/${encodeURIComponent(String(listId))}/subscribers`,
        { method: "POST", body: JSON.stringify({ subscriber_ids: ids }) },
      );
    },

    /**
     * DELETE /api/v1/lists/{id}/subscribers/{sub_id} — remove one member.
     * 204 on success (resolves `{data: undefined}`); idempotency is the
     * server's call — a second delete may 404.
     */
    removeMember(
      listId: string | number,
      subId: string,
    ): Promise<ApiResult<void>> {
      return request<void>(
        `/api/v1/lists/${encodeURIComponent(String(listId))}/subscribers/${encodeURIComponent(subId)}`,
        { method: "DELETE" },
      );
    },

    /**
     * GET /api/v1/lists/{id}/suppressions?page=&per_page= — suppressions
     * scoped to this list. Rows carry no id — key the table on `email`.
     */
    suppressions(
      listId: string | number,
      opts: { page?: number; perPage?: number } = {},
    ): Promise<ApiResult<ListSuppressionsPage>> {
      const params = new URLSearchParams();
      if (opts.page) params.set("page", String(opts.page));
      if (opts.perPage) params.set("per_page", String(opts.perPage));
      const qs = params.toString();
      return request<ListSuppressionsPage>(
        `/api/v1/lists/${encodeURIComponent(String(listId))}/suppressions${qs ? `?${qs}` : ""}`,
      );
    },
  };

  return listsExtendedApi;
}

/* ---------- segments: preview count + recompute ------------------- */

/** Mirrors `segments.PreviewCountResponse`. */
export interface PreviewCountResult {
  count: number;
  computed_in_ms: number;
  capped: boolean;
}

/** Body for POST /api/v1/segments/preview-count. */
export interface PreviewCountInput {
  /** Compiled AST — preferred input (visual builder). */
  queryAst?: unknown;
  /** Free-form NL description — best-effort compile fallback. */
  text?: string;
}

/** Mirrors `segments.RecomputeResponse`. */
export interface SegmentRecomputeResult {
  scheduled_at: string;
  count: number;
}

export function createSegmentsExtendedApi(request: ApiRequester) {
  const segmentsExtendedApi = {
    /**
     * POST /api/v1/segments/preview-count — fast COUNT(*) for the
     * builder. Supply either a compiled AST or a free-text description.
     */
    previewCount(
      input: PreviewCountInput,
    ): Promise<ApiResult<PreviewCountResult>> {
      return request<PreviewCountResult>("/api/v1/segments/preview-count", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },

    /**
     * POST /api/v1/segments/{id}/recompute — force a re-evaluation of
     * a saved segment. Synchronous; refreshes last_count + last_evaluated_at.
     */
    recompute(id: string): Promise<ApiResult<SegmentRecomputeResult>> {
      return request<SegmentRecomputeResult>(
        `/api/v1/segments/${encodeURIComponent(id)}/recompute`,
        { method: "POST" },
      );
    },
  };

  return segmentsExtendedApi;
}

/* ---------- end Lists & Suppressions 2026 (Wave 1) ---------------- */

/* =====================================================================
 * SMS + Push suppressions (Wave 2/3 — GAP-LS-014 / GAP-LS-015 /
 * GAP-LS-100 / GAP-LS-109 / GAP-LS-145 / GAP-LS-146 / GAP-LS-147 /
 * GAP-LS-148)
 *
 * Schema reference:
 *   - sms_suppressions      (migration 0098 + extended in 0253)
 *   - push_token_suppressions, sms_quiet_hours, sms_keyword_responses
 *     (migration 0253)
 *
 * Mounted backend routes used by the desktop authority:
 *   - GET    /api/v1/sms/suppressions (unfiltered/reason/cursor page)
 *   - POST   /api/v1/sms/suppressions/query (exact phone in JSON body)
 *   - POST   /api/v1/sms/suppressions (manual record)
 *   - DELETE /api/v1/sms/suppressions/{id} (tenant/id-bound receipt)
 * A missing route remains an explicit unavailable/error state; it is never
 * treated as an empty registry or evidence of readiness.
 * =================================================================== */

export type SmsSuppressionReason =
  | "manual"
  | "stop_keyword"
  | "help_keyword"
  | "carrier_block"
  | "complaint"
  | "quiet_hours"
  | "expired";

export type SmsSuppressionSource =
  | "twilio"
  | "telnyx"
  | "bandwidth"
  | "manual"
  | "api"
  | "import";

/** Strict private projection of one active `sms_suppressions` row. */
export interface SmsSuppressionRow {
  id: string;
  /** Canonical US/Canada E.164 recipient. */
  phone_e164: string;
  reason: SmsSuppressionReason;
  source: SmsSuppressionSource;
  created_at: string;
  /** Only an operator-authored manual row is reversible. */
  reversible: boolean;
  /** Required for locked carrier/system rows; absent for reversible rows. */
  locked_reason?: "carrier_or_system_authority";
}

export interface SmsSuppressionListResponse {
  tenantId: string;
  items: SmsSuppressionRow[];
  /** Complete matching-set count at snapshotAt, not the page length. */
  total: number;
  nextCursor?: string;
  snapshotAt: string;
}

export interface SmsSuppressionDeleteReceipt {
  ok: true;
  tenantId: string;
  id: string;
}

export const SMS_SUPPRESSION_REASONS: ReadonlyArray<{
  value: string;
  label: string;
}> = [
  { value: "manual", label: "Manual" },
  { value: "stop_keyword", label: "STOP keyword" },
  { value: "help_keyword", label: "HELP keyword" },
  { value: "carrier_block", label: "Carrier block" },
  { value: "complaint", label: "Complaint" },
  { value: "quiet_hours", label: "Quiet hours" },
  { value: "expired", label: "Expired" },
];

interface SmsSuppressionApiIdentityOptions {
  getApiIdentityGeneration?: () => number | null;
  getTenantId?: () => string | null;
}

export function createSmsSuppressionsApi(
  request: ApiRequester,
  options: SmsSuppressionApiIdentityOptions = {},
) {
  type UnknownRecord = Record<string, unknown>;
  interface IdentitySnapshot {
    generation: number;
    tenantId: string;
  }
  const getTenantId = options.getTenantId ?? (() => null);
  const getApiIdentityGeneration =
    options.getApiIdentityGeneration ?? (() => 0);
  const uuidV4 =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  const tenantUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
  const usCanadaE164 = /^\+1[2-9][0-9]{2}[2-9][0-9]{6}$/u;
  const cursorPattern = /^v1\.[A-Za-z0-9_-]+$/u;
  const rfc3339 =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/u;
  const controls = /[\u0000-\u001f\u007f]/u;
  const reasons = new Set<string>(
    SMS_SUPPRESSION_REASONS.map(({ value }) => value),
  );
  const sources = new Set<string>([
    "twilio",
    "telnyx",
    "bandwidth",
    "manual",
    "api",
    "import",
  ]);
  const rowKeys = new Set([
    "id",
    "phone_e164",
    "reason",
    "source",
    "created_at",
    "reversible",
    "locked_reason",
  ]);

  function isRecord(value: unknown): value is UnknownRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function hasOnlyKeys(
    value: UnknownRecord,
    keys: ReadonlySet<string>,
  ): boolean {
    return Object.keys(value).every((key) => keys.has(key));
  }

  function daysInMonth(year: number, month: number): number {
    if (month === 2) {
      const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
      return leap ? 29 : 28;
    }
    return [4, 6, 9, 11].includes(month) ? 30 : 31;
  }

  function isTimestamp(value: unknown): value is string {
    if (
      typeof value !== "string" ||
      value.length < 20 ||
      value.length > 64 ||
      value.trim() !== value ||
      controls.test(value)
    ) {
      return false;
    }
    const parts = rfc3339.exec(value);
    const parsed = Date.parse(value);
    if (
      !parts ||
      !Number.isFinite(parsed) ||
      parsed < Date.UTC(2000, 0, 1) ||
      parsed >= Date.UTC(2100, 0, 1)
    )
      return false;
    const year = Number(parts[1]);
    const month = Number(parts[2]);
    const day = Number(parts[3]);
    return (
      year >= 2000 &&
      year < 2100 &&
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= daysInMonth(year, month) &&
      Number(parts[4]) <= 23 &&
      Number(parts[5]) <= 59 &&
      Number(parts[6]) <= 59 &&
      Number(parts[8] ?? 0) <= 14 &&
      Number(parts[9] ?? 0) <= 59 &&
      !(Number(parts[8] ?? 0) === 14 && Number(parts[9] ?? 0) !== 0)
    );
  }

  function isCursor(value: unknown): value is string {
    return (
      typeof value === "string" &&
      value.length >= 4 &&
      value.length <= 4096 &&
      cursorPattern.test(value)
    );
  }

  function captureIdentity(): IdentitySnapshot | null {
    const tenantId = getTenantId();
    const generation = getApiIdentityGeneration();
    return typeof tenantId === "string" &&
      tenantUuid.test(tenantId) &&
      Number.isSafeInteger(generation) &&
      (generation as number) >= 0
      ? { generation: generation as number, tenantId }
      : null;
  }

  function identityIsCurrent(identity: IdentitySnapshot): boolean {
    return (
      getTenantId() === identity.tenantId &&
      getApiIdentityGeneration() === identity.generation
    );
  }

  function isSmsSuppressionRow(value: unknown): value is SmsSuppressionRow {
    if (!isRecord(value) || !hasOnlyKeys(value, rowKeys)) return false;
    if (
      typeof value.id !== "string" ||
      !uuidV4.test(value.id) ||
      typeof value.phone_e164 !== "string" ||
      !usCanadaE164.test(value.phone_e164) ||
      typeof value.reason !== "string" ||
      !reasons.has(value.reason) ||
      typeof value.source !== "string" ||
      !sources.has(value.source) ||
      !isTimestamp(value.created_at) ||
      typeof value.reversible !== "boolean"
    ) {
      return false;
    }
    const operatorReversible =
      value.reason === "manual" && value.source === "manual";
    return (
      value.reversible === operatorReversible &&
      (operatorReversible
        ? value.locked_reason === undefined
        : value.locked_reason === "carrier_or_system_authority")
    );
  }

  function isSmsSuppressionPage(
    value: unknown,
    identity: IdentitySnapshot,
    limit: number,
    opts: {
      cursor?: string;
      phone?: string;
      reason?: SmsSuppressionReason;
    },
  ): value is SmsSuppressionListResponse {
    if (
      !isRecord(value) ||
      !hasOnlyKeys(
        value,
        new Set(["tenantId", "items", "total", "nextCursor", "snapshotAt"]),
      ) ||
      typeof value.tenantId !== "string" ||
      !tenantUuid.test(value.tenantId) ||
      value.tenantId !== identity.tenantId ||
      !Array.isArray(value.items) ||
      value.items.length > limit ||
      !value.items.every(isSmsSuppressionRow) ||
      !Number.isSafeInteger(value.total) ||
      (value.total as number) < value.items.length ||
      !isTimestamp(value.snapshotAt) ||
      (value.nextCursor !== undefined && !isCursor(value.nextCursor))
    ) {
      return false;
    }
    const ids = new Set<string>();
    const phones = new Set<string>();
    let prior: SmsSuppressionRow | undefined;
    const snapshotTime = Date.parse(value.snapshotAt);
    for (const item of value.items) {
      const createdTime = Date.parse(item.created_at);
      if (
        ids.has(item.id) ||
        phones.has(item.phone_e164) ||
        createdTime > snapshotTime ||
        (opts.reason !== undefined && item.reason !== opts.reason) ||
        (opts.phone !== undefined && item.phone_e164 !== opts.phone)
      ) {
        return false;
      }
      ids.add(item.id);
      phones.add(item.phone_e164);
      if (
        prior &&
        (createdTime > Date.parse(prior.created_at) ||
          (createdTime === Date.parse(prior.created_at) && item.id >= prior.id))
      ) {
        return false;
      }
      prior = item;
    }
    if (
      opts.phone !== undefined &&
      ((value.total as number) > 1 || value.nextCursor !== undefined)
    ) {
      return false;
    }
    if (
      value.nextCursor !== undefined &&
      (value.items.length !== limit ||
        (value.total as number) <= value.items.length)
    ) {
      return false;
    }
    return !(
      opts.cursor === undefined &&
      value.nextCursor === undefined &&
      value.total !== value.items.length
    );
  }

  function invalidSuppressionResponse<T>(): ApiResult<T> {
    return {
      error: {
        kind: "parse",
        code: "invalid_sms_suppression_response",
        message:
          "The SMS service returned a suppression response that did not match the verified contract.",
      },
      retryability: "not-retryable",
    };
  }

  function invalidSuppressionRequest<T>(message: string): ApiResult<T> {
    return {
      error: {
        kind: "invalid_config",
        code: "invalid_sms_suppression_request",
        message,
      },
      retryability: "not-retryable",
    };
  }

  function identityChanged<T>(): ApiResult<T> {
    return {
      error: {
        kind: "network",
        code: "identity_changed",
        message:
          "This response belongs to a previous workspace identity and was discarded.",
      },
      retryability: "not-retryable",
    };
  }

  async function decodeSuppressionResult<T>(
    pending: Promise<ApiResult<unknown>>,
    identity: IdentitySnapshot,
    guard: (value: unknown) => value is T,
  ): Promise<ApiResult<T>> {
    const result = await pending;
    if (!identityIsCurrent(identity)) return identityChanged<T>();
    if ("error" in result && result.error) return result;
    if (!guard(result.data)) return invalidSuppressionResponse<T>();
    return { ...result, data: result.data };
  }

  const smsSuppressionsApi = {
    list(
      opts: {
        reason?: SmsSuppressionReason;
        phone?: string;
        cursor?: string;
        limit?: number;
        signal?: AbortSignal;
      } = {},
    ): Promise<ApiResult<SmsSuppressionListResponse>> {
      const identity = captureIdentity();
      const limit = opts.limit ?? 100;
      if (!identity) {
        return Promise.resolve(
          invalidSuppressionRequest(
            "A stable canonical workspace identity is required before loading SMS suppressions.",
          ),
        );
      }
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
        return Promise.resolve(
          invalidSuppressionRequest("SMS suppression page size must be 1–200."),
        );
      }
      if (opts.reason !== undefined && !reasons.has(opts.reason)) {
        return Promise.resolve(
          invalidSuppressionRequest("SMS suppression reason is not supported."),
        );
      }
      if (opts.phone !== undefined && !usCanadaE164.test(opts.phone)) {
        return Promise.resolve(
          invalidSuppressionRequest(
            "SMS suppression phone filters must be canonical US/Canada E.164.",
          ),
        );
      }
      if (opts.phone !== undefined && opts.cursor !== undefined) {
        return Promise.resolve(
          invalidSuppressionRequest(
            "Exact SMS suppression lookups do not accept a pagination cursor.",
          ),
        );
      }
      if (opts.phone !== undefined && opts.limit !== undefined) {
        return Promise.resolve(
          invalidSuppressionRequest(
            "Exact SMS suppression lookups do not accept a page size.",
          ),
        );
      }
      if (opts.cursor !== undefined && !isCursor(opts.cursor)) {
        return Promise.resolve(
          invalidSuppressionRequest("SMS suppression cursor is malformed."),
        );
      }
      const params = new URLSearchParams();
      if (opts.reason) params.set("reason", opts.reason);
      if (opts.cursor) params.set("cursor", opts.cursor);
      if (opts.limit !== undefined) params.set("limit", String(opts.limit));
      const qs = params.toString();
      const pending = opts.phone
        ? request<unknown>(
            "/api/v1/sms/suppressions/query",
            {
              method: "POST",
              body: JSON.stringify({
                phone: opts.phone,
                ...(opts.reason ? { reason: opts.reason } : {}),
              }),
              ...(opts.signal ? { signal: opts.signal } : {}),
            },
            { idempotencyKey: null, requireOnline: true },
          )
        : request<unknown>(
            `/api/v1/sms/suppressions${qs ? `?${qs}` : ""}`,
            opts.signal ? { signal: opts.signal } : undefined,
          );
      return decodeSuppressionResult(
        pending,
        identity,
        (value): value is SmsSuppressionListResponse =>
          isSmsSuppressionPage(value, identity, opts.phone ? 1 : limit, opts),
      );
    },
    add(
      input: { phone: string; reason: "manual" },
      opts: { signal?: AbortSignal } = {},
    ): Promise<ApiResult<SmsSuppressionRow>> {
      const identity = captureIdentity();
      if (
        !identity ||
        !usCanadaE164.test(input.phone) ||
        input.reason !== "manual"
      ) {
        return Promise.resolve(
          invalidSuppressionRequest(
            "Manual suppression requires a stable workspace and canonical US/Canada phone.",
          ),
        );
      }
      return decodeSuppressionResult(
        request<unknown>("/api/v1/sms/suppressions", {
          method: "POST",
          body: JSON.stringify(input),
          ...(opts.signal ? { signal: opts.signal } : {}),
        }),
        identity,
        (value): value is SmsSuppressionRow =>
          isSmsSuppressionRow(value) &&
          value.phone_e164 === input.phone &&
          value.reason === "manual" &&
          value.source === "manual" &&
          value.reversible,
      );
    },
    remove(
      id: string,
      opts: { signal?: AbortSignal } = {},
    ): Promise<ApiResult<SmsSuppressionDeleteReceipt>> {
      const identity = captureIdentity();
      if (!identity || !uuidV4.test(id)) {
        return Promise.resolve(
          invalidSuppressionRequest(
            "Manual suppression removal requires a stable workspace and canonical row id.",
          ),
        );
      }
      return decodeSuppressionResult(
        request<unknown>(`/api/v1/sms/suppressions/${encodeURIComponent(id)}`, {
          method: "DELETE",
          ...(opts.signal ? { signal: opts.signal } : {}),
        }),
        identity,
        (value): value is SmsSuppressionDeleteReceipt =>
          isRecord(value) &&
          hasOnlyKeys(value, new Set(["ok", "tenantId", "id"])) &&
          value.ok === true &&
          value.tenantId === identity.tenantId &&
          value.id === id,
      );
    },
  };

  return smsSuppressionsApi;
}

/**
 * Mirrors `sms_quiet_hours` — wire shape verified against the live Go
 * handlers (replaces the Wave-3 placeholder). Times are stored as
 * minutes-since-midnight; the server ALSO returns pre-formatted
 * `start_local`/`end_local` strings for display.
 */
export interface SmsQuietHoursRow {
  id: string;
  /** Canonical tenant identity; every private row is bound before rendering. */
  tenant_id: string;
  /** Operator-facing rule name. */
  label: string;
  country_code: string;
  /** Minutes since local midnight (0..1439). */
  start_minute: number;
  end_minute: number;
  /** Server-formatted "HH:MM" display strings derived from minutes. */
  start_local: string;
  end_local: string;
  /** Days of week the rule applies to (0=Sunday … 6=Saturday, per quiet_hours.go). */
  days: number[];
  timezone: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Body for POST / PATCH /api/v1/sms/quiet-hours. Invalid payloads
 * (bad minutes, unknown timezone, empty days) 422 with code
 * `validation_failed`.
 */
export interface SmsQuietHoursInput {
  label?: string;
  country_code: string;
  start_minute: number;
  end_minute: number;
  /** Days of week (0=Sunday … 6=Saturday, per quiet_hours.go). Omit for every day. */
  days?: number[];
  timezone: string;
  enabled?: boolean;
}

export type SmsQuietHoursPatchInput = Partial<SmsQuietHoursInput> & {
  /** Compare-and-swap token captured from the exact row being edited. */
  expected_updated_at: string;
};

export interface SmsPolicyDeleteReceipt {
  ok: true;
  tenantId: string;
  id: string;
}

export function createSmsQuietHoursApi(request: ApiRequester) {
  const smsQuietHoursApi = {
    /** GET /api/v1/sms/quiet-hours → strict tenant-bound envelope. */
    list(
      opts: { signal?: AbortSignal } = {},
    ): Promise<ApiResult<{ tenantId: string; items: SmsQuietHoursRow[] }>> {
      return request<{ tenantId: string; items: SmsQuietHoursRow[] }>(
        "/api/v1/sms/quiet-hours",
        opts.signal ? { signal: opts.signal } : undefined,
      );
    },
    /** POST /api/v1/sms/quiet-hours — 422 `validation_failed` on bad input. */
    create(
      input: SmsQuietHoursInput,
      opts: { signal?: AbortSignal } = {},
    ): Promise<ApiResult<SmsQuietHoursRow>> {
      return request<SmsQuietHoursRow>("/api/v1/sms/quiet-hours", {
        method: "POST",
        body: JSON.stringify(input),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    },
    /** PATCH /api/v1/sms/quiet-hours/{id} — partial update. */
    update(
      id: string,
      input: SmsQuietHoursPatchInput,
      opts: { signal?: AbortSignal } = {},
    ): Promise<ApiResult<SmsQuietHoursRow>> {
      return request<SmsQuietHoursRow>(
        `/api/v1/sms/quiet-hours/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          body: JSON.stringify(input),
          ...(opts.signal ? { signal: opts.signal } : {}),
        },
      );
    },
    /** DELETE /api/v1/sms/quiet-hours/{id}. */
    remove(
      id: string,
      input: { expected_updated_at: string },
      opts: { signal?: AbortSignal } = {},
    ): Promise<ApiResult<SmsPolicyDeleteReceipt>> {
      return request<SmsPolicyDeleteReceipt>(
        `/api/v1/sms/quiet-hours/${encodeURIComponent(id)}`,
        {
          method: "DELETE",
          body: JSON.stringify(input),
          ...(opts.signal ? { signal: opts.signal } : {}),
        },
      );
    },
  };

  return smsQuietHoursApi;
}

/* ---------- end SMS + Push suppressions (Wave 2/3) ---------------- */

export function createListsAndSuppressionsApis(
  request: ApiRequester,
  opts: SmsSuppressionApiIdentityOptions = {},
) {
  return {
    suppressionsConvergedApi: createSuppressionsConvergedApi(request),
    subscriptionTypesApi: createSubscriptionTypesApi(request),
    subscriberSubscriptionTypesApi:
      createSubscriberSubscriptionTypesApi(request),
    listsExtendedApi: createListsExtendedApi(request),
    segmentsExtendedApi: createSegmentsExtendedApi(request),
    smsSuppressionsApi: createSmsSuppressionsApi(request, opts),
    pushSuppressionsApi: createPushSuppressionsApi(request, opts),
    smsQuietHoursApi: createSmsQuietHoursApi(request),
  };
}
