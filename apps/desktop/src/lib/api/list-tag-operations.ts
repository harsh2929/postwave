import type { ApiErr, ApiResult, QueueableApiResult } from "./result";
import {
  responseContractFailure,
  responseIdentityMatches,
  responseIdentityMismatch,
} from "./subscriber-response-integrity";

export interface ListTagRequestOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  requireOnline?: boolean;
  signal?: AbortSignal;
}

export type ListTagRequester = <T>(
  path: string,
  init?: RequestInit,
  opts?: ListTagRequestOptions,
) => Promise<ApiResult<T>>;

export interface ListTagOperationsDependencies {
  request: ListTagRequester;
  queueableRequest?: <T>(
    path: string,
    init?: RequestInit,
    opts?: ListTagRequestOptions,
  ) => Promise<QueueableApiResult<T>>;
}

/**
 * Mirrors the Go `lists.List` struct in apps/api/internal/lists/lists.go.
 * `id` is a Listmonk integer; we accept string|number defensively because
 * older builds JSON-encoded ints as strings.
 */
export interface List {
  id: number | string;
  /**
   * Canonical Moosewave identity used by tenant-scoped persistence APIs.
   * Never substitute the Listmonk bigint `id` where a UUID is required.
   */
  postwave_uuid?: string;
  name: string;
  /** "public" | "private" — defaults to "private" on create. */
  type?: string;
  /** "single" | "double" — defaults to "single" on create. */
  optin?: string;
  tags?: string[];
  description?: string;
  /** Listmonk emits ISO-8601 — exposed for sort / display. */
  created_at?: string;
  updated_at?: string;
  /** Listmonk denormalises subscriber count into the row. */
  subscriber_count?: number;
  // Tolerate any extra fields Listmonk attaches (uuid, mvac state, etc).
  [extra: string]: unknown;
}

/**
 * GET /api/v1/lists envelope. Listmonk wraps in `{data:{results:[…]}}`;
 * we tolerate every alias the rest of the client uses so the page can run
 * the standard unwrap ladder.
 */
export interface ListsResponse {
  /** Listmonk's canonical wrapper. */
  data?:
    | { results?: List[]; total?: number; per_page?: number; page?: number }
    | List[];
  /** Defensive aliases for older / mock backends. */
  items?: List[];
  results?: List[];
  total?: number;
}

/** One list a subscriber belongs to — GET /api/v1/lists/for-subscriber/{id} (D04#10). */
export interface SubscriberListRef {
  id: string;
  name: string;
}

export interface SubscriberListsResponse {
  items: SubscriberListRef[];
  count?: number;
  /** Optional on older gateways; validated when a gateway echoes it. */
  subscriber_id?: string;
}

export interface SubscriberListMutationResponse {
  ok?: boolean;
  added?: number;
  skipped?: number;
  /** Optional forward-compatible identity echoes. */
  subscriber_id?: string;
  subscriber_ids?: string[];
  list_id?: string | number;
}

function validateMembershipIdentity(
  payload: SubscriberListMutationResponse | undefined,
  subscriberId: string,
  listId: string,
): ApiErr | null {
  if (!payload) return null;
  if (
    payload.subscriber_id !== undefined &&
    !responseIdentityMatches(subscriberId, payload.subscriber_id)
  ) {
    return responseIdentityMismatch("subscriber");
  }
  if (
    payload.subscriber_ids !== undefined &&
    (payload.subscriber_ids.length !== 1 ||
      !responseIdentityMatches(subscriberId, payload.subscriber_ids[0] ?? ""))
  ) {
    return responseIdentityMismatch("subscriber");
  }
  if (
    payload.list_id !== undefined &&
    !responseIdentityMatches(listId, payload.list_id)
  ) {
    return responseIdentityMismatch("list");
  }
  return null;
}

/** Body for POST /api/v1/lists. */
export interface ListCreateInput {
  name: string;
  type?: "public" | "private";
  optin?: "single" | "double";
  tags?: string[];
  description?: string;
}

/** Body for PATCH /api/v1/lists/{id}. */
export interface ListUpdateInput {
  name?: string;
  type?: "public" | "private";
  optin?: "single" | "double";
  tags?: string[];
  description?: string;
}

/**
 * Mirrors the Go `tags.Tag` struct in apps/api/internal/tags/tags.go.
 * Refined Tags PR 1 added color + description columns server-side.
 */
export interface Tag {
  id: string;
  name: string;
  color?: string;
  /** Refined Tags PR 1: optional free-text description. */
  description?: string;
  created_at?: string;
  /** Refined Tags PR 2: provenance — actor uuid that inserted the row.
   *  NULL for rows that predate migration 0262. */
  created_by?: string | null;
  updated_at?: string | null;
  /** Refined Tags PR 2: actor uuid that last touched the row. */
  updated_by?: string | null;
  /** Refined Tags PR 2: soft-delete state. Present means archived.
   *  List() hides archived rows unless include_archived=true. */
  archived_at?: string | null;
  /** Refined Tags PR 2: operator flag for PII-bearing tags. */
  pii?: boolean;
  /** Feature 9: nullable FK into tag_groups for namespacing.
   *  null/undefined means "no group" (ungrouped bucket in the UI). */
  group_id?: string | null;
  /** Monotonic tenant-scoped record revision returned by the server. */
  version?: number;
  /** Exact strong ETag: `"tag:<uuid>:v<N>"`. */
  etag?: string;
}

/**
 * Feature 9: tag groups / namespaces (Klaviyo Tag Groups parity).
 * Mirrors the Go `tags.TagGroup` struct.
 */
export interface TagGroup {
  id: string;
  name: string;
  color?: string;
  sort_order: number;
  created_at?: string;
}

export interface TagGroupCreateInput {
  name: string;
  color?: string;
  sort_order?: number;
}

export interface TagGroupUpdateInput {
  name?: string;
  color?: string;
  sort_order?: number;
}

/**
 * GET /api/v1/tags envelope. The Go handler returns `{items:[…]}`; older
 * mocks may use `data` or a bare array.
 */
export interface TagsResponse {
  items?: Tag[];
  data?: Tag[];
  results?: Tag[];
}

/**
 * Mirrors the Go `tags.HistoryRow` struct in apps/api/internal/tags/history.go.
 * Refined Tags PR 3 (migration 0263) — one row per tag mutation event.
 */
export interface TagHistoryRow {
  id: string;
  tag_id?: string;
  tag_name?: string;
  subscriber_id?: string;
  action:
    | "tag_added"
    | "tag_removed"
    | "tag_created"
    | "tag_updated"
    | "tag_archived"
    | "tag_restored"
    | "tag_deleted"
    | "tag_renamed"
    | "tag_merged"
    | "tag_redacted";
  source: string;
  actor_id?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
  occurred_at: string;
}

/** Body for POST /api/v1/tags. */
export interface TagCreateInput {
  name: string;
  color?: string;
  /** Refined Tags PR 1: optional free-text description. */
  description?: string;
  /** Optional sensitivity flag accepted by the versioned server contract. */
  pii?: boolean;
  /** Optional tenant-owned tag-group id; empty string means ungrouped. */
  group_id?: string;
}

/** Body for PATCH /api/v1/tags/{id}. */
export interface TagUpdateInput {
  name?: string;
  color?: string;
  pii?: boolean;
  description?: string;
  /** Feature 9: pass "" to clear the group, a uuid to (re)assign. */
  group_id?: string;
}

/**
 * The production Tags handler currently accepts only these fields. Keep this
 * allow-list at the transport boundary: strict JSON decoding rejects future
 * governance fields, and an omitted PATCH field must remain omitted.
 */
function supportedTagCreateBody(
  input: TagCreateInput,
): Record<string, unknown> {
  return {
    name: input.name,
    ...(input.color !== undefined ? { color: input.color } : {}),
    ...(input.description !== undefined
      ? { description: input.description }
      : {}),
    ...(input.group_id !== undefined ? { group_id: input.group_id } : {}),
    ...(input.pii !== undefined ? { pii: input.pii } : {}),
  };
}

function supportedTagPatchBody(patch: TagUpdateInput): Record<string, unknown> {
  return {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.color !== undefined ? { color: patch.color } : {}),
    ...(patch.description !== undefined
      ? { description: patch.description }
      : {}),
    ...(patch.group_id !== undefined ? { group_id: patch.group_id } : {}),
    ...(patch.pii !== undefined ? { pii: patch.pii } : {}),
  };
}

const TAG_ETAG_RE =
  /^"tag:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):v([1-9][0-9]*)"$/iu;
const TAG_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function boundedTagText(
  value: unknown,
  maximum: number,
  requireNonBlank = false,
): value is string {
  return (
    typeof value === "string" &&
    Array.from(value).length <= maximum &&
    (!requireNonBlank || value.trim().length > 0)
  );
}

function tagTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value)) &&
    /(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
  );
}

function optionalTagUuid(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (typeof value === "string" && TAG_UUID_RE.test(value))
  );
}

function exactTagEtag(
  value: unknown,
  expectedId?: string,
  expectedVersion?: number,
): value is string {
  if (typeof value !== "string") return false;
  const match = TAG_ETAG_RE.exec(value);
  if (!match) return false;
  const version = Number(match[2]);
  return (
    Number.isSafeInteger(version) &&
    version > 0 &&
    (expectedId === undefined ||
      match[1]?.toLowerCase() === expectedId.toLowerCase()) &&
    (expectedVersion === undefined || version === expectedVersion)
  );
}

function verifiedTagMutation(
  response: QueueableApiResult<Tag>,
  expected: { id?: string; name?: string },
): QueueableApiResult<Tag> {
  if (response.error || response.queued) return response;
  const tag = response.data;
  if (
    !tag ||
    typeof tag.id !== "string" ||
    !TAG_UUID_RE.test(tag.id) ||
    (expected.id !== undefined && tag.id !== expected.id) ||
    !boundedTagText(tag.name, 100, true) ||
    (expected.name !== undefined && tag.name !== expected.name) ||
    !boundedTagText(tag.color ?? "", 32) ||
    !boundedTagText(tag.description, 4_096) ||
    !optionalTagUuid(tag.group_id) ||
    !optionalTagUuid(tag.created_by) ||
    !optionalTagUuid(tag.updated_by) ||
    !tagTimestamp(tag.created_at) ||
    !tagTimestamp(tag.updated_at) ||
    !(
      tag.archived_at === undefined ||
      tag.archived_at === null ||
      tagTimestamp(tag.archived_at)
    ) ||
    typeof tag.pii !== "boolean" ||
    !Number.isSafeInteger(tag.version) ||
    (tag.version ?? 0) < 1 ||
    !exactTagEtag(tag.etag, tag.id, tag.version) ||
    response.serverVersion !== tag.etag
  ) {
    return responseContractFailure(
      "The tags service did not return a matching strong version. The previous verified tag was kept; refresh before retrying.",
    );
  }
  return response;
}

function verifiedTagGroupMutation(
  response: ApiResult<TagGroup>,
  expected: { id?: string; name?: string },
): ApiResult<TagGroup> {
  if (response.error) return response;
  const group = response.data;
  if (
    !group ||
    typeof group.id !== "string" ||
    !TAG_UUID_RE.test(group.id) ||
    (expected.id !== undefined && group.id !== expected.id) ||
    !boundedTagText(group.name, 100, true) ||
    (expected.name !== undefined && group.name !== expected.name) ||
    !boundedTagText(group.color ?? "", 32) ||
    !Number.isSafeInteger(group.sort_order) ||
    !tagTimestamp(group.created_at)
  ) {
    return responseContractFailure(
      "The tag-groups service returned an invalid resource. The previous verified groups were kept; refresh before retrying.",
    );
  }
  return response;
}

/** Refined Tags PR 1: one row of the taxonomy listing. Joins live
 *  usage from subscribers.tags with the canonical registry. */
export interface TagUsage {
  tag: string;
  subscribers: number;
  /** True when the tag exists in the canonical registry; false when
   *  it's an orphan (used on subscribers but never registered). */
  registered: boolean;
  created_at?: string;
}

/** Refined Tags PR 1: subscribers-with-tag projection. */
export interface TagSubscriber {
  id: string;
  email: string;
  status: string;
  created_at: string;
}

/** Refined Tags PR 2: one suggestion row from the typeahead endpoint. */
export interface TagSuggestion {
  tag: string;
  subscribers: number;
  registered: boolean;
}

/** Feature 10/12: one bucket in the per-tag membership curve. */
export interface TagMembershipBucket {
  /** ISO date string yyyy-mm-dd. */
  date: string;
  /** added - removed for the day. */
  net: number;
}

/** Feature 10/12: payload returned by GET /tag-taxonomy/{id}/membership. */
export interface TagMembership {
  tag_id: string;
  days: number;
  current_count: number;
  added: number;
  removed: number;
  daily: TagMembershipBucket[];
  coverage: {
    contract_version: string;
    coverage_started_at: string;
    as_of: string;
    completeness: "complete_from_coverage_start";
    source: "subscriber_tags_event_ledger";
    /** True only when the requested history window starts after coverage. */
    requested_window_complete: boolean;
  };
}

/**
 * Migration 0244 (subscriber_tags join) — one row of the
 * "subscribers carrying tag X" projection backed by the indexed join
 * rather than the legacy unnest+GROUP BY path.
 */
export interface TagJoinSubscriber {
  subscriber_id: string;
  email: string;
  applied_at: string;
  source: string;
}

/**
 * Migration 0244 — one row of "tags this subscriber carries" with
 * provenance (who applied it, when, from which surface).
 */
export interface SubscriberTagApplication {
  tag_id: string;
  tag_name: string;
  subscriber_id: string;
  applied_at: string;
  applied_by?: string;
  source: string;
}

export interface ListHealthResult {
  tag?: string;
  window_days: number;
  total_subscribers: number;
  active_subscribers: number;
  engaged_subscribers: number;
  blocklisted_count: number;
  bounces: number;
  complaints: number;
  unsubscribes: number;
  bounce_rate: number;
  complaint_rate: number;
  unsubscribe_rate: number;
  engagement_rate: number;
  suppression_rate: number;
  score: number;
  grade: string;
  notes: string[];
}

/** GET /api/v1/lists — Listmonk passthrough; payload is `{data:{results:[…]}}`. */
export function createListLists({ request }: ListTagOperationsDependencies) {
  return async function listLists(): Promise<ApiResult<ListsResponse>> {
    const response = await request<ListsResponse>("/api/v1/lists");
    if (response.error) return response;
    const nested = response.data.data;
    const items = Array.isArray(nested)
      ? nested
      : nested && Array.isArray(nested.results)
        ? nested.results
        : (response.data.items ?? response.data.results);
    if (
      !Array.isArray(items) ||
      items.some(
        (item) =>
          !item ||
          (typeof item.id !== "string" && typeof item.id !== "number") ||
          String(item.id).trim() === "" ||
          typeof item.name !== "string" ||
          item.name.trim() === "",
      ) ||
      new Set(items.map((item) => String(item.id).trim().toLowerCase()))
        .size !== items.length
    ) {
      return responseContractFailure(
        "The lists service returned invalid or duplicate list identities. The previous verified lists were kept; retry the request.",
      );
    }
    return response;
  };
}

/** GET /api/v1/lists/for-subscriber/{id} — the lists a subscriber
 *  belongs to, for the subscriber slideover's Lists section (D04#10). */
export function createListsForSubscriber({
  request,
}: ListTagOperationsDependencies) {
  return async function listsForSubscriber(
    subscriberId: string,
  ): Promise<ApiResult<SubscriberListsResponse>> {
    const response = await request<SubscriberListsResponse>(
      `/api/v1/lists/for-subscriber/${encodeURIComponent(subscriberId)}`,
    );
    if (response.error) return response;
    if (
      response.data.subscriber_id !== undefined &&
      !responseIdentityMatches(subscriberId, response.data.subscriber_id)
    ) {
      return responseIdentityMismatch("subscriber");
    }
    if (
      !Array.isArray(response.data.items) ||
      response.data.items.some(
        (item) =>
          typeof item?.id !== "string" ||
          item.id.trim() === "" ||
          typeof item.name !== "string",
      ) ||
      new Set(response.data.items.map((item) => item.id)).size !==
        response.data.items.length ||
      (response.data.count !== undefined &&
        response.data.count !== response.data.items.length)
    ) {
      return responseContractFailure(
        "The list-membership service returned an incomplete response. The previous verified memberships were kept; retry the request.",
      );
    }
    return response;
  };
}

/** POST /api/v1/lists/{id}/subscribers — add a subscriber to a list (D04#10). */
export function createAddSubscriberToList({
  request,
}: ListTagOperationsDependencies) {
  return async function addSubscriberToList(
    listId: string,
    subscriberId: string,
  ): Promise<ApiResult<SubscriberListMutationResponse>> {
    const response = await request<SubscriberListMutationResponse>(
      `/api/v1/lists/${encodeURIComponent(listId)}/subscribers`,
      {
        method: "POST",
        body: JSON.stringify({ subscriber_ids: [subscriberId] }),
      },
    );
    if (response.error) return response;
    const identityError = validateMembershipIdentity(
      response.data,
      subscriberId,
      listId,
    );
    if (identityError) return identityError;
    const { added, skipped } = response.data;
    if (
      (added !== undefined && (!Number.isSafeInteger(added) || added < 0)) ||
      (skipped !== undefined &&
        (!Number.isSafeInteger(skipped) || skipped < 0)) ||
      ((added !== undefined || skipped !== undefined) &&
        (added ?? 0) + (skipped ?? 0) !== 1)
    ) {
      return responseContractFailure(
        "The list-membership service did not confirm exactly one subscriber. The previous verified memberships were kept; retry the request.",
      );
    }
    return response;
  };
}

/** DELETE /api/v1/lists/{id}/subscribers/{sub_id} — remove from a list (D04#10). */
export function createRemoveSubscriberFromList({
  request,
}: ListTagOperationsDependencies) {
  return async function removeSubscriberFromList(
    listId: string,
    subscriberId: string,
  ): Promise<ApiResult<SubscriberListMutationResponse | undefined>> {
    const response = await request<SubscriberListMutationResponse | undefined>(
      `/api/v1/lists/${encodeURIComponent(listId)}/subscribers/${encodeURIComponent(subscriberId)}`,
      { method: "DELETE" },
    );
    if (response.error) return response;
    const identityError = validateMembershipIdentity(
      response.data,
      subscriberId,
      listId,
    );
    return identityError ?? response;
  };
}

/** POST /api/v1/lists — create an audience container. */
export function createCreateList({
  request,
  queueableRequest,
}: ListTagOperationsDependencies) {
  return function createList(
    input: ListCreateInput,
  ): Promise<QueueableApiResult<List>> {
    return (queueableRequest ?? request)<List>("/api/v1/lists", {
      method: "POST",
      body: JSON.stringify({
        name: input.name,
        type: input.type ?? "private",
        optin: input.optin ?? "single",
        tags: input.tags ?? [],
        description: input.description ?? "",
      }),
    });
  };
}

/**
 * PATCH /api/v1/lists/{id} — rename / update. The Go gateway today
 * mounts only GET / POST / DELETE; this method exists so the UI can
 * call rename when the upstream lands the route. A 404 is the
 * expected current state and callers MUST handle it gracefully.
 */
export function createUpdateList({
  request,
  queueableRequest,
}: ListTagOperationsDependencies) {
  return function updateList(
    id: string | number,
    patch: ListUpdateInput,
  ): Promise<QueueableApiResult<List>> {
    return (queueableRequest ?? request)<List>(
      `/api/v1/lists/${encodeURIComponent(String(id))}`,
      {
        method: "PATCH",
        body: JSON.stringify(patch),
      },
    );
  };
}

/** DELETE /api/v1/lists/{id} — remove an audience container. */
export function createDeleteList({ request }: ListTagOperationsDependencies) {
  return function deleteList(
    id: string | number,
  ): Promise<ApiResult<{ ok?: boolean }>> {
    return request<{ ok?: boolean }>(
      `/api/v1/lists/${encodeURIComponent(String(id))}`,
      { method: "DELETE" },
    );
  };
}

export function createGetListHealth({
  request,
}: ListTagOperationsDependencies) {
  return function getListHealth(
    opts: { tag?: string; windowDays?: number } = {},
  ): Promise<ApiResult<ListHealthResult>> {
    const params = new URLSearchParams();
    if (opts.tag) params.set("tag", opts.tag);
    if (opts.windowDays) params.set("window_days", String(opts.windowDays));
    const qs = params.toString();
    return request<ListHealthResult>(
      `/api/v1/list-health${qs ? `?${qs}` : ""}`,
    );
  };
}

/** GET /api/v1/tags — tenant-scoped tag catalogue, returns `{items:[…]}`.
 *  Refined Tags PR 2: pass `includeArchived` to surface soft-deleted rows.
 *  Feature 9: pass `groupId` to filter; "none" surfaces ungrouped tags. */
export function createListTags({ request }: ListTagOperationsDependencies) {
  return function listTags(
    opts: { includeArchived?: boolean; groupId?: string } = {},
  ): Promise<ApiResult<TagsResponse>> {
    const params = new URLSearchParams();
    if (opts.includeArchived) params.set("include_archived", "true");
    if (opts.groupId) params.set("group_id", opts.groupId);
    const qs = params.toString();
    return request<TagsResponse>(`/api/v1/tags${qs ? `?${qs}` : ""}`);
  };
}

/** POST /api/v1/tags — create a tag definition. Refined Tags PR 1
 *  persists color + description on the server. PR 2 adds the PII flag.
 *  Feature 9 forwards the group_id FK. */
export function createCreateTag({
  request,
  queueableRequest,
}: ListTagOperationsDependencies) {
  return async function createTag(
    input: TagCreateInput,
  ): Promise<QueueableApiResult<Tag>> {
    const response = await (queueableRequest ?? request)<Tag>("/api/v1/tags", {
      method: "POST",
      body: JSON.stringify(supportedTagCreateBody(input)),
    });
    return verifiedTagMutation(response, { name: input.name });
  };
}

/**
 * PATCH /api/v1/tags/{id} — partial update (name / color / description / pii / group_id).
 * Refined Tags PR 1 mounted the route on the Go side; PR 2 stamps
 * updated_at + updated_by automatically server-side. Feature 9
 * forwards the group_id FK ("" clears, uuid assigns).
 */
export function createUpdateTag({
  request,
  queueableRequest,
}: ListTagOperationsDependencies) {
  return async function updateTag(
    id: string,
    patch: TagUpdateInput,
    expectedEtag: string,
  ): Promise<QueueableApiResult<Tag>> {
    if (!exactTagEtag(expectedEtag, id)) {
      return responseContractFailure(
        "The tag update was blocked because its exact server version is missing. Refresh the catalogue before retrying.",
      );
    }
    const response = await (queueableRequest ?? request)<Tag>(
      `/api/v1/tags/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify(supportedTagPatchBody(patch)),
        headers: { "If-Match": expectedEtag },
      },
    );
    return verifiedTagMutation(response, { id });
  };
}

/** Feature 9: tag groups CRUD. Mirrors /api/v1/tags shape. */
export function createListTagGroups({
  request,
}: ListTagOperationsDependencies) {
  return function listTagGroups(): Promise<ApiResult<{ items: TagGroup[] }>> {
    return request<{ items: TagGroup[] }>("/api/v1/tag-groups");
  };
}

export function createCreateTagGroup({
  request,
}: ListTagOperationsDependencies) {
  return async function createTagGroup(
    input: TagGroupCreateInput,
  ): Promise<ApiResult<TagGroup>> {
    const response = await request<TagGroup>("/api/v1/tag-groups", {
      method: "POST",
      body: JSON.stringify({
        name: input.name,
        color: input.color ?? "",
        sort_order: input.sort_order ?? 0,
      }),
    });
    return verifiedTagGroupMutation(response, { name: input.name });
  };
}

export function createUpdateTagGroup({
  request,
}: ListTagOperationsDependencies) {
  return async function updateTagGroup(
    id: string,
    patch: TagGroupUpdateInput,
  ): Promise<ApiResult<TagGroup>> {
    const response = await request<TagGroup>(
      `/api/v1/tag-groups/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify(patch),
      },
    );
    return verifiedTagGroupMutation(response, { id, name: patch.name });
  };
}

export function createDeleteTagGroup({
  request,
}: ListTagOperationsDependencies) {
  return async function deleteTagGroup(
    id: string,
  ): Promise<ApiResult<{ ok?: boolean }>> {
    const response = await request<{ ok?: boolean }>(
      `/api/v1/tag-groups/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    if (response.error) return response;
    return response.data.ok === true
      ? response
      : responseContractFailure(
          "The tag-groups service did not confirm deletion. The previous verified groups were kept; refresh before retrying.",
        );
  };
}

/** DELETE /api/v1/tags/{id} — hard-delete a tag definition. (D16#4:
 *  the archiveTag/restoreTag PATCH /tags/{id}/archive|restore methods
 *  were removed — those routes are not mounted and had no UI callers;
 *  the reversible-removal path they steered to does not exist yet.) */
export function createDeleteTag({ request }: ListTagOperationsDependencies) {
  return function deleteTag(id: string): Promise<ApiResult<{ ok?: boolean }>> {
    return request<{ ok?: boolean }>(`/api/v1/tags/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  };
}

/** GET /api/v1/tags/{id}/history — per-tag audit log paginated by
 *  occurred_at cursor. Refined Tags PR 3 (migration 0263). */
export function createListTagHistory({
  request,
}: ListTagOperationsDependencies) {
  return function listTagHistory(
    id: string,
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<ApiResult<{ items: TagHistoryRow[]; next_cursor?: string }>> {
    const params = new URLSearchParams();
    if (opts.cursor) params.set("cursor", opts.cursor);
    if (opts.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return request<{ items: TagHistoryRow[]; next_cursor?: string }>(
      `/api/v1/tags/${encodeURIComponent(id)}/history${qs ? `?${qs}` : ""}`,
    );
  };
}

/** Refined Tags PR 1: rich taxonomy list — joins live usage from
 *  subscribers.tags with the canonical tags registry. Surfaces
 *  orphan tags (used on subscribers but never registered) and
 *  unused tags (registered but never applied).
 *
 *  Refined Tags PR 2: the Go handler now emits `items`, but earlier
 *  versions used `tags`. We accept both so a cached/older API still
 *  works. */
export function createListTagTaxonomy({
  request,
}: ListTagOperationsDependencies) {
  return function listTagTaxonomy(): Promise<
    ApiResult<{ items: TagUsage[]; tags?: TagUsage[] }>
  > {
    return request<{ items: TagUsage[]; tags?: TagUsage[] }>(
      "/api/v1/tag-taxonomy",
    );
  };
}

/** Refined Tags PR 1: merge two tags (A → B) across all subscribers.
 *
 *  Full-surface wiring 2026-06: the Go handler actually responds
 *  `{from, into, subscribers_updated}` (tag_taxonomy.go Merge) — the
 *  old `{merged}` field never existed on the wire. Type widened
 *  additively so existing callers keep compiling. */
export function createMergeTags({ request }: ListTagOperationsDependencies) {
  return function mergeTags(input: { from: string; into: string }): Promise<
    ApiResult<{
      from?: string;
      into: string;
      subscribers_updated?: number;
      /** Legacy client-side alias — never sent by the server. */
      merged?: number;
    }>
  > {
    return request<{
      from?: string;
      into: string;
      subscribers_updated?: number;
      merged?: number;
    }>("/api/v1/tag-taxonomy/merge", {
      method: "POST",
      body: JSON.stringify(input),
    });
  };
}

/** Refined Tags PR 1: rename across all subscribers AND in the
 *  canonical registry in one transaction. */
export function createRenameTagAcross({
  request,
}: ListTagOperationsDependencies) {
  return function renameTagAcross(input: {
    from: string;
    to: string;
  }): Promise<ApiResult<{ subscribers_updated: number }>> {
    return request<{ subscribers_updated: number }>(
      "/api/v1/tag-taxonomy/rename",
      { method: "POST", body: JSON.stringify(input) },
    );
  };
}

/** Refined Tags PR 1: list subscribers carrying a given tag, for
 *  the tag detail slideover. */
export function createListSubscribersWithTag({
  request,
}: ListTagOperationsDependencies) {
  return function listSubscribersWithTag(
    tag: string,
    limit = 50,
  ): Promise<ApiResult<{ tag: string; items: TagSubscriber[] }>> {
    const params = new URLSearchParams({ tag, limit: String(limit) });
    return request<{ tag: string; items: TagSubscriber[] }>(
      `/api/v1/tag-taxonomy/subscribers?${params.toString()}`,
    );
  };
}

/** Refined Tags PR 2: typeahead suggestions over the union of the
 *  canonical registry + live usage in subscribers.tags. Ranked by
 *  subscriber count, then alphabetical. Empty `q` returns the top
 *  most-used tags. */
export function createSuggestTags({ request }: ListTagOperationsDependencies) {
  return function suggestTags(
    q: string,
    limit = 10,
  ): Promise<ApiResult<{ items: TagSuggestion[]; q: string }>> {
    const params = new URLSearchParams({ q, limit: String(limit) });
    return request<{ items: TagSuggestion[]; q: string }>(
      `/api/v1/tag-taxonomy/suggest?${params.toString()}`,
    );
  };
}

/** Feature 10/12: per-tag membership analytics — joiner/leaver counts
 *  + per-day net curve aggregated from tag_history. */
export function createTagMembership({
  request,
}: ListTagOperationsDependencies) {
  return function tagMembership(
    tagId: string,
    days = 30,
  ): Promise<ApiResult<TagMembership>> {
    const params = new URLSearchParams({ days: String(days) });
    return request<TagMembership>(
      `/api/v1/tag-taxonomy/${encodeURIComponent(tagId)}/membership?${params.toString()}`,
    );
  };
}

export function createListTagOperationsMethods(
  dependencies: ListTagOperationsDependencies,
) {
  return {
    listLists: createListLists(dependencies),
    listsForSubscriber: createListsForSubscriber(dependencies),
    addSubscriberToList: createAddSubscriberToList(dependencies),
    removeSubscriberFromList: createRemoveSubscriberFromList(dependencies),
    createList: createCreateList(dependencies),
    updateList: createUpdateList(dependencies),
    deleteList: createDeleteList(dependencies),
    getListHealth: createGetListHealth(dependencies),
    listTags: createListTags(dependencies),
    createTag: createCreateTag(dependencies),
    updateTag: createUpdateTag(dependencies),
    listTagGroups: createListTagGroups(dependencies),
    createTagGroup: createCreateTagGroup(dependencies),
    updateTagGroup: createUpdateTagGroup(dependencies),
    deleteTagGroup: createDeleteTagGroup(dependencies),
    deleteTag: createDeleteTag(dependencies),
    listTagHistory: createListTagHistory(dependencies),
    listTagTaxonomy: createListTagTaxonomy(dependencies),
    mergeTags: createMergeTags(dependencies),
    renameTagAcross: createRenameTagAcross(dependencies),
    listSubscribersWithTag: createListSubscribersWithTag(dependencies),
    suggestTags: createSuggestTags(dependencies),
    tagMembership: createTagMembership(dependencies),
  };
}
