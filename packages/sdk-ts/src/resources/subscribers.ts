import { Resource } from "./_base.js";
import type { Subscriber, SubscriberPage } from "../types.js";

export type ProfileTransform =
  | "copy"
  | "lowercase"
  | "uppercase"
  | "trim"
  | "date"
  | "number"
  | "boolean"
  | "json_path";

export type ProfileTransformRuleStatus = "active" | "paused" | "archived";

export interface ProfileTransformRuleInput {
  name: string;
  source_path: string;
  target_key: string;
  transform?: ProfileTransform;
  status?: ProfileTransformRuleStatus;
}

export interface ProfileTransformRule extends ProfileTransformRuleInput {
  id: string;
  transform: ProfileTransform;
  status: ProfileTransformRuleStatus;
}

/**
 * Query params for `GET /api/v1/subscribers`.
 *
 * NOTE — there is deliberately NO `list_id` here. The SDK used to declare
 * `list_id?: number` and forward it as a query param, but the Go handler
 * never reads it: `Deps.List` builds `ListOptions{Q, Status, Sort, Order,
 * Cursor, Page, PerPage, IncludeArchived}` (apps/api/internal/subscribers/
 * handlers.go) and silently drops every other param. A caller filtering on
 * `list_id` therefore got the ENTIRE tenant back while the call looked
 * correct — the worst possible failure mode for an audience filter.
 *
 * List membership has its own endpoint. Use {@link ListsResource.members}
 * (`GET /api/v1/lists/{id}/subscribers`), which is tenant + list scoped and
 * supports the same `q` / `status` / `page` / `per_page` shape.
 */
export interface ListSubscribersParams {
  q?: string;
  status?: string;
  page?: number;
  per_page?: number;
  /**
   * Column to order by. Read by the Go handler's ListOptions →
   * normalizeSort (apps/api/internal/subscribers/handlers.go).
   */
  sort?: string;
  order?: "asc" | "desc";
  /**
   * SUB-009 soft delete: archived rows are HIDDEN unless a caller opts in.
   * Without this, an SDK consumer has no way to reach an archived contact
   * — which is what "I removed the wrong person" recovery needs.
   */
  include_archived?: boolean;
  /**
   * Opaque keyset cursor from a previous page. Materially cheaper than
   * OFFSET paging for a large tenant; the server decodes it in
   * decodeListCursor and ignores `page` when present.
   */
  cursor?: string;
}

/** Query params for `GET /api/v1/subscribers/search` (SUB-039). */
export interface SearchSubscribersParams {
  /**
   * Operator grammar: `tag:`/`-tag:`, `@domain`, `email:`, `name:`,
   * `status:`, `source:`. Routed through the FTS + pg_trgm indexes rather
   * than the ILIKE scan `list({q})` uses.
   */
  q: string;
  page?: number;
  per_page?: number;
}

export interface SubscriberImportCsvResult {
  total_rows: number;
  created: number;
  updated: number;
  skipped: number;
  errored: number;
  rows: Array<{
    row_number: number;
    email?: string;
    status: "created" | "updated" | "skipped" | "error";
    error?: string;
  }>;
}

export interface BatchSubscriberRecord {
  email: string;
  status?: string;
  first_name?: string;
  last_name?: string;
  custom_fields?: Record<string, string | number | boolean>;
  merge_fields?: Record<string, string | number | boolean>;
  tags?: string[];
}

export interface BatchSubscriberResult {
  total: number;
  created: number;
  updated: number;
  errored: number;
  rows: Array<{
    email: string;
    status: "created" | "updated" | "error";
    error?: string;
  }>;
}

export interface SubscriberMergeInput {
  primary_id: string;
  duplicate_id: string;
}

export interface SubscriberMergeResult {
  primary_id: string;
  duplicate_id: string;
  events_moved: number;
  suppressions_moved: number;
  tags_merged: number;
  custom_fields_merged: number;
}

export interface SubscriberActivityRow {
  id: number;
  event_type: string;
  campaign_id?: string;
  link_url?: string;
  user_agent?: string;
  at: string;
}

export interface SubscriberEngagementResult {
  subscriber_id: string;
  email: string;
  score: number;
  counts: {
    sends: number;
    opens: number;
    clicks: number;
    replies: number;
  };
  window_days: number;
  computed_at: string;
  opens_30d: number;
  clicks_30d: number;
  last_open_at?: string;
  last_click_at?: string;
}

export class SubscribersResource extends Resource {
  /** List every tenant profile-transform rule, including paused/archived rules. */
  transformRules(): Promise<{ items: ProfileTransformRule[]; total: number }> {
    return this.client.request("GET", "/api/v1/profile-transform-rules");
  }

  /** Create or replace a profile-transform rule by its tenant-unique name. */
  upsertTransformRule(
    input: ProfileTransformRuleInput,
  ): Promise<ProfileTransformRule> {
    return this.client.request("POST", "/api/v1/profile-transform-rules", {
      body: input,
    });
  }

  deleteTransformRule(id: string): Promise<{ ok: true }> {
    const trimmed = id.trim();
    if (!trimmed) throw new Error("Profile transform rule ID is required");
    return this.client.request(
      "DELETE",
      `/api/v1/profile-transform-rules/${encodeURIComponent(trimmed)}`,
    );
  }

  list(params: ListSubscribersParams = {}): Promise<SubscriberPage> {
    return this.client.request("GET", "/api/v1/subscribers", {
      query: params as Record<
        string,
        string | number | boolean | null | undefined
      >,
    });
  }

  get(id: string): Promise<Subscriber> {
    return this.client.request(
      "GET",
      `/api/v1/subscribers/${encodeURIComponent(id)}`,
    );
  }

  create(
    input: Partial<Subscriber> & Pick<Subscriber, "email">,
  ): Promise<Subscriber> {
    return this.client.request("POST", "/api/v1/subscribers", { body: input });
  }

  /**
   * Batch upsert up to 1000 subscriber records in one round-trip. Each
   * record carries its own email (required) + status / first_name /
   * last_name / custom_fields / merge_fields / tags. Idempotent on email;
   * returns per-record created/updated/error outcomes.
   */
  batchUpsert(
    records: BatchSubscriberRecord[],
  ): Promise<BatchSubscriberResult> {
    return this.client.request("POST", "/api/v1/subscribers/batch", {
      body: { subscribers: records },
    });
  }

  /**
   * PATCH a subscriber.
   *
   * `ifMatch` is REQUIRED IN PRACTICE even though the signature keeps it optional
   * for back-compatibility: the handler parses If-Match and answers 428
   * `precondition_required` when it is absent OR a wildcard
   * (apps/api/internal/subscribers/handlers.go:590-594), before any mutation. So an
   * update without a token cannot succeed — it is not merely unprotected.
   *
   * Obtain the token from the detail GET's ETag via `getWithToken`.
   */
  update(
    id: string,
    patch: Partial<Subscriber>,
    options: { ifMatch?: string } = {},
  ): Promise<Subscriber> {
    return this.client.request(
      "PATCH",
      `/api/v1/subscribers/${encodeURIComponent(id)}`,
      {
        body: patch,
        ...(options.ifMatch
          ? { headers: { "If-Match": options.ifMatch } }
          : {}),
      },
    );
  }

  /**
   * Fetch a subscriber together with the optimistic-concurrency token to echo on
   * the next write.
   *
   * The detail GET sets `ETag: <ConcurrencyToken("subscriber", id, updated_at)>`
   * (handlers.go:315). Returning it alongside the row is the only way a caller can
   * satisfy the mandatory If-Match, and doing it in one method keeps the read and
   * the token from drifting apart in caller code.
   */
  async getWithToken(
    id: string,
  ): Promise<{ subscriber: Subscriber; concurrencyToken: string | null }> {
    let concurrencyToken: string | null = null;
    const subscriber = await this.client.request<Subscriber>(
      "GET",
      `/api/v1/subscribers/${encodeURIComponent(id)}`,
      {
        onResponseHeaders: (headers) => {
          concurrencyToken = headers.get("etag");
        },
      },
    );
    return { subscriber, concurrencyToken };
  }

  delete(id: string): Promise<void> {
    return this.client.request(
      "DELETE",
      `/api/v1/subscribers/${encodeURIComponent(id)}`,
    );
  }

  /**
   * Structured search. Accepts the bare query string (back-compatible) or
   * the full param object — the server reads `page`/`per_page` here via
   * pageParams(r), which the string-only signature made unreachable, so a
   * large result set was capped at one page with no way to ask for more.
   */
  search(params: string | SearchSubscribersParams): Promise<SubscriberPage> {
    const query: Record<string, string | number | undefined> =
      typeof params === "string"
        ? { q: params }
        : {
            q: params.q,
            ...(params.page !== undefined ? { page: params.page } : {}),
            ...(params.per_page !== undefined
              ? { per_page: params.per_page }
              : {}),
          };
    return this.client.request("GET", "/api/v1/subscribers/search", { query });
  }

  suppress(id: string): Promise<void> {
    return this.client.request(
      "POST",
      `/api/v1/subscribers/${encodeURIComponent(id)}/suppress`,
    );
  }

  importCsv(
    filename: string,
    csv: string | ArrayBuffer | Uint8Array,
  ): Promise<SubscriberImportCsvResult> {
    const body =
      typeof csv === "string"
        ? csv
        : new TextDecoder().decode(
            csv instanceof Uint8Array ? csv : new Uint8Array(csv),
          );
    return this.client.request("POST", "/api/v1/subscribers/import", {
      rawBody: body,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "X-Postwave-Filename": filename,
      },
    });
  }

  exportCsv(params: { limit?: number } = {}): Promise<string> {
    return this.client.request("GET", "/api/v1/subscribers/export.csv", {
      query: params,
      asText: true,
      headers: { Accept: "text/csv" },
    });
  }

  merge(input: SubscriberMergeInput): Promise<SubscriberMergeResult> {
    return this.client.request("POST", "/api/v1/subscribers/merge", {
      body: input,
    });
  }

  activity(
    id: string,
    params: { limit?: number; before?: string } = {},
  ): Promise<{ items: SubscriberActivityRow[]; limit: number }> {
    return this.client.request(
      "GET",
      `/api/v1/subscribers/${encodeURIComponent(id)}/activity`,
      { query: params },
    );
  }

  engagement(id: string): Promise<SubscriberEngagementResult> {
    return this.client.request(
      "GET",
      `/api/v1/subscribers/${encodeURIComponent(id)}/engagement`,
    );
  }

  async engagementBatch(ids: string[]): Promise<SubscriberEngagementResult[]> {
    const res = await this.client.request<{
      items: SubscriberEngagementResult[];
    }>("GET", "/api/v1/subscribers/engagement", {
      query: { ids: ids.join(",") },
    });
    return res.items;
  }

  /**
   * Create a tenant-scoped custom field (schema slot for subscriber records).
   * `type` is one of "string" | "number" | "boolean" | "date".
   */
  customFieldCreate(input: {
    key: string;
    label: string;
    type: "string" | "number" | "boolean" | "date";
  }): Promise<{ id: string; key: string; label: string; type: string }> {
    return this.client.request("POST", "/api/v1/custom-fields", {
      body: input,
    });
  }

  /**
   * Inferred trait for a subscriber (SUB-***): an AI-derived demographic or
   * interest signal. `trait` is one of "gender" | "age_group" | "interests".
   */
  inferredTrait(
    id: string,
    trait: "gender" | "age_group" | "interests",
  ): Promise<unknown> {
    return this.client.request(
      "GET",
      `/api/v1/subscribers/${encodeURIComponent(id)}/traits/inferred_${trait}`,
    );
  }

  /** List saved first-party lookalike audiences (SUB-068). */
  lookalikeList(): Promise<unknown> {
    return this.client.request("GET", "/api/v1/subscribers/lookalike");
  }

  /** Generate a first-party lookalike audience from a seed segment (SUB-068). */
  lookalikeGenerate(input: Record<string, unknown>): Promise<unknown> {
    return this.client.request("POST", "/api/v1/subscribers/lookalike", {
      body: input,
    });
  }

  /** Fetch one lookalike audience header plus a page of ranked members. */
  lookalikeGet(
    id: string,
    params: { page?: number; per_page?: number } = {},
  ): Promise<unknown> {
    return this.client.request(
      "GET",
      `/api/v1/subscribers/lookalike/${encodeURIComponent(id)}`,
      { query: params },
    );
  }
}
