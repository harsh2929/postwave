import type { ApiResult } from "./result";
import {
  responseContractFailure,
  responseIdentityMatches,
  responseIdentityMismatch,
} from "./subscriber-response-integrity";

export interface AudienceSegmentationRequestOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  requireOnline?: boolean;
  signal?: AbortSignal;
}

export type AudienceSegmentationRequester = <T>(
  path: string,
  init?: RequestInit,
  opts?: AudienceSegmentationRequestOptions,
) => Promise<ApiResult<T>>;

export interface AudienceSegmentationDependencies {
  llmRequestOptions: AudienceSegmentationRequestOptions;
}

/* ----- engagement: A/B results reader + drip-trigger CRUD ------------
 *
 * APPEND-ONLY wrappers for the new endpoints exposed in
 * apps/api/internal/abtests/handlers.go and
 * apps/api/internal/inbound_webhooks/handlers.go. Live below the
 * existing helpers so older code paths above are unaffected.
 * --------------------------------------------------------------------- */

export type ABMetric = "open_rate" | "click_rate" | "reply_rate";

export interface ABResultsVariant {
  id: string;
  variant_index: number;
  variant_label?: string;
  subject?: string;
  sent: number;
  hits: number;
  rate: number;
  is_control: boolean;
}

export interface ABFrequentistOutcome {
  z_score: number;
  p_value: number;
  lift_percent: number;
  significant_at_95: boolean;
  significant_after_correction: boolean;
}

export interface ABBayesianOutcome {
  prob_b_better: number;
  expected_lift: number;
  credible_interval_95: [number, number];
}

export interface ABBonferroni {
  num_comparisons: number;
  family_alpha: number;
  corrected_alpha: number;
  applied_to_frequentist: boolean;
  notes?: string;
}

export interface ABWinner {
  variant_index: number;
  variant_id?: string;
  method: "bayesian" | "frequentist" | "not_decided";
  confidence: number;
}

export interface ABResultsResponse {
  campaign_id: string;
  metric: ABMetric;
  variants: ABResultsVariant[];
  frequentist: Record<string, ABFrequentistOutcome>;
  bayesian: Record<string, ABBayesianOutcome>;
  bonferroni: ABBonferroni;
  winner?: ABWinner;
}

/**
 * GET /api/v1/campaigns/{id}/ab-results — operator-facing reader.
 * Returns variant scores, pairwise frequentist + Bayesian
 * comparisons against the control, and a "winner" pick (or
 * "not_decided" when nothing crossed 95% confidence).
 */
export function createGetABResults(request: AudienceSegmentationRequester) {
  return function getABResults(
    campaignID: string,
    metric: ABMetric = "open_rate",
  ): Promise<ApiResult<ABResultsResponse>> {
    const qs = `?metric=${encodeURIComponent(metric)}`;
    return request<ABResultsResponse>(
      `/api/v1/campaigns/${encodeURIComponent(campaignID)}/ab-results${qs}`,
    );
  };
}

/** G4 follow-up: bandit allocation-drift series (weight over time per arm). */
export interface ABWeightHistorySeries {
  variant_id: string;
  label: string;
  points: { at: string; weight: number }[];
}

export function createGetABWeightHistory(
  request: AudienceSegmentationRequester,
) {
  return function getABWeightHistory(
    campaignID: string,
  ): Promise<
    ApiResult<{ campaign_id: string; series: ABWeightHistorySeries[] }>
  > {
    return request(
      `/api/v1/campaigns/${encodeURIComponent(campaignID)}/ab-weight-history`,
    );
  };
}

export type TriggerOperator = "equals" | "contains" | "exists" | "regex";
export type TriggerAction =
  | "add_to_sequence"
  | "add_tag"
  | "remove_tag"
  | "start_automation";

export interface InboundTrigger {
  id: string;
  tenant_id: string;
  webhook_id: string;
  name: string;
  active: boolean;
  match_jsonpath: string;
  match_operator: TriggerOperator;
  match_value?: string | null;
  email_jsonpath: string;
  action_type: TriggerAction;
  action_target_id: string;
  fired_count: number;
  last_fired_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface InboundTriggerInput {
  name: string;
  active?: boolean;
  match_jsonpath: string;
  match_operator: TriggerOperator;
  match_value?: string | null;
  email_jsonpath: string;
  action_type: TriggerAction;
  action_target_id: string;
}

export type InboundTriggerPatch = Partial<InboundTriggerInput>;

export function createListInboundTriggers(
  request: AudienceSegmentationRequester,
) {
  return function listInboundTriggers(
    webhookID: string,
  ): Promise<ApiResult<{ items: InboundTrigger[] }>> {
    return request<{ items: InboundTrigger[] }>(
      `/api/v1/inbound-webhooks/${encodeURIComponent(webhookID)}/triggers`,
    );
  };
}

export function createCreateInboundTrigger(
  request: AudienceSegmentationRequester,
) {
  return function createInboundTrigger(
    webhookID: string,
    input: InboundTriggerInput,
  ): Promise<ApiResult<InboundTrigger>> {
    return request<InboundTrigger>(
      `/api/v1/inbound-webhooks/${encodeURIComponent(webhookID)}/triggers`,
      { method: "POST", body: JSON.stringify(input) },
    );
  };
}

export function createUpdateInboundTrigger(
  request: AudienceSegmentationRequester,
) {
  return function updateInboundTrigger(
    webhookID: string,
    triggerID: string,
    patch: InboundTriggerPatch,
  ): Promise<ApiResult<InboundTrigger>> {
    return request<InboundTrigger>(
      `/api/v1/inbound-webhooks/${encodeURIComponent(webhookID)}/triggers/${encodeURIComponent(triggerID)}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    );
  };
}

export function createDeleteInboundTrigger(
  request: AudienceSegmentationRequester,
) {
  return function deleteInboundTrigger(
    webhookID: string,
    triggerID: string,
  ): Promise<ApiResult<{ ok: boolean }>> {
    return request<{ ok: boolean }>(
      `/api/v1/inbound-webhooks/${encodeURIComponent(webhookID)}/triggers/${encodeURIComponent(triggerID)}`,
      { method: "DELETE" },
    );
  };
}

// =============================================================================
// Workstream 1 — Mailchimp parity: merge fields, saved segments,
// contact ratings + history, list webhooks scope.
// =============================================================================

export type MergeFieldType =
  | "text"
  | "number"
  | "boolean"
  | "date"
  | "address"
  | "phone";

export interface MergeFieldSchema {
  tenant_id: string;
  key: string;
  label: string;
  type: MergeFieldType;
  default_value: string;
  required: boolean;
  position: number;
  value_count: number;
  created_at: string;
  updated_at: string;
}

export interface MergeFieldSchemaInput {
  key: string;
  label: string;
  type: MergeFieldType;
  default_value?: string;
  required?: boolean;
  position?: number;
}

export interface MergeFieldSchemaPatch {
  label?: string;
  type?: MergeFieldType;
  default_value?: string;
  required?: boolean;
  position?: number;
}

export interface SubscriberMergeValues {
  subscriber_id: string;
  values: Record<string, string>;
}

const MERGE_FIELD_TYPES: MergeFieldType[] = [
  "text",
  "number",
  "boolean",
  "date",
  "address",
  "phone",
];
const MERGE_FIELD_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,31}$/;

export function isMergeFieldSchema(value: unknown): value is MergeFieldSchema {
  if (!value || typeof value !== "object") return false;
  const field = value as Partial<MergeFieldSchema>;
  return (
    typeof field.tenant_id === "string" &&
    field.tenant_id.length > 0 &&
    typeof field.key === "string" &&
    MERGE_FIELD_KEY_PATTERN.test(field.key) &&
    typeof field.label === "string" &&
    typeof field.type === "string" &&
    MERGE_FIELD_TYPES.includes(field.type as MergeFieldType) &&
    typeof field.default_value === "string" &&
    typeof field.required === "boolean" &&
    Number.isSafeInteger(field.position) &&
    typeof field.value_count === "number" &&
    Number.isSafeInteger(field.value_count) &&
    field.value_count >= 0 &&
    typeof field.created_at === "string" &&
    !Number.isNaN(Date.parse(field.created_at)) &&
    typeof field.updated_at === "string" &&
    !Number.isNaN(Date.parse(field.updated_at))
  );
}

function isSubscriberMergeValues(
  value: unknown,
): value is SubscriberMergeValues {
  if (!value || typeof value !== "object") return false;
  const response = value as Partial<SubscriberMergeValues>;
  return (
    typeof response.subscriber_id === "string" &&
    response.subscriber_id.length > 0 &&
    Boolean(response.values) &&
    typeof response.values === "object" &&
    !Array.isArray(response.values) &&
    Object.values(response.values).every((item) => typeof item === "string")
  );
}

function invalidMergeFieldContract(message: string): ApiResult<never> {
  return {
    error: {
      message,
      code: "invalid_merge_field_contract",
      kind: "parse",
    },
    retryability: "manual",
  };
}

export function createListMergeFieldSchema(
  request: AudienceSegmentationRequester,
) {
  return async function listMergeFieldSchema(): Promise<
    ApiResult<{ items: MergeFieldSchema[] }>
  > {
    const response = await request<{ items: MergeFieldSchema[] }>(
      "/api/v1/merge-fields/schema",
    );
    if (response.error) return response;
    const items = response.data?.items;
    if (!Array.isArray(items) || !items.every(isMergeFieldSchema)) {
      return invalidMergeFieldContract(
        "The audience-field service returned an incomplete schema.",
      );
    }
    const keys = new Set(items.map((item) => item.key));
    const tenantIDs = new Set(items.map((item) => item.tenant_id));
    if (keys.size !== items.length || tenantIDs.size > 1) {
      return invalidMergeFieldContract(
        "The audience-field service returned duplicate or cross-workspace rows.",
      );
    }
    return response;
  };
}

export function createCreateMergeFieldSchema(
  request: AudienceSegmentationRequester,
) {
  return async function createMergeFieldSchema(
    input: MergeFieldSchemaInput,
  ): Promise<ApiResult<MergeFieldSchema>> {
    const response = await request<MergeFieldSchema>(
      "/api/v1/merge-fields/schema",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
    if (response.error) return response;
    if (!isMergeFieldSchema(response.data)) {
      return invalidMergeFieldContract(
        "The audience-field service did not return the created field.",
      );
    }
    if (!responseIdentityMatches(input.key, response.data.key)) {
      return responseIdentityMismatch("audience field");
    }
    return response;
  };
}

export function createPatchMergeFieldSchema(
  request: AudienceSegmentationRequester,
) {
  return async function patchMergeFieldSchema(
    key: string,
    patch: MergeFieldSchemaPatch,
  ): Promise<ApiResult<MergeFieldSchema>> {
    const response = await request<MergeFieldSchema>(
      `/api/v1/merge-fields/schema/${encodeURIComponent(key)}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    );
    if (response.error) return response;
    if (!isMergeFieldSchema(response.data)) {
      return invalidMergeFieldContract(
        "The audience-field service did not return the updated field.",
      );
    }
    if (!responseIdentityMatches(key, response.data.key)) {
      return responseIdentityMismatch("audience field");
    }
    return response;
  };
}

export function createDeleteMergeFieldSchema(
  request: AudienceSegmentationRequester,
) {
  return async function deleteMergeFieldSchema(
    key: string,
  ): Promise<ApiResult<{ ok: boolean }>> {
    const response = await request<{ ok: boolean }>(
      `/api/v1/merge-fields/schema/${encodeURIComponent(key)}`,
      { method: "DELETE" },
    );
    if (response.error) return response;
    if (response.data?.ok !== true) {
      return invalidMergeFieldContract(
        "The audience-field service did not confirm removal.",
      );
    }
    return response;
  };
}

export function createGetSubscriberMergeFields(
  request: AudienceSegmentationRequester,
) {
  return async function getSubscriberMergeFields(
    id: string | number,
  ): Promise<ApiResult<SubscriberMergeValues>> {
    const response = await request<SubscriberMergeValues>(
      `/api/v1/subscribers/${encodeURIComponent(String(id))}/merge-fields`,
    );
    if (response.error) return response;
    if (!isSubscriberMergeValues(response.data)) {
      return invalidMergeFieldContract(
        "The subscriber audience-field response was incomplete.",
      );
    }
    if (!responseIdentityMatches(id, response.data.subscriber_id)) {
      return responseIdentityMismatch("subscriber");
    }
    return response;
  };
}

export function createPatchSubscriberMergeFields(
  request: AudienceSegmentationRequester,
) {
  return async function patchSubscriberMergeFields(
    id: string | number,
    values: Record<string, string>,
  ): Promise<ApiResult<SubscriberMergeValues>> {
    const response = await request<SubscriberMergeValues>(
      `/api/v1/subscribers/${encodeURIComponent(String(id))}/merge-fields`,
      { method: "PATCH", body: JSON.stringify(values) },
    );
    if (response.error) return response;
    if (!isSubscriberMergeValues(response.data)) {
      return invalidMergeFieldContract(
        "The subscriber audience-field response was incomplete.",
      );
    }
    if (!responseIdentityMatches(id, response.data.subscriber_id)) {
      return responseIdentityMismatch("subscriber");
    }
    return response;
  };
}

/* ----- saved segments ---------------------------------------------- */

/**
 * Comparators understood by the segments compiler (apps/api/internal/segments/compile.go).
 * Tag lifecycle comparators (`added_in_last_days` / `removed_in_last_days`)
 * compile to an EXISTS clause against tag_history and require a
 * `{tag, days}` value shape.
 */
export type SegmentComparator =
  | "="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "equals"
  | "not_equals"
  | "contains"
  | "not_contains"
  | "starts_with"
  | "ends_with"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "not_in"
  | "before"
  | "after"
  | "between"
  | "exists"
  | "not_exists"
  | "is_null"
  | "is_not_null"
  | "in_last_days"
  | "more_than_days_ago"
  | "ever"
  | "never"
  | "in_segment"
  | "not_in_segment"
  | "added_in_last_days"
  | "removed_in_last_days";

export interface SegmentTagWindowValue {
  tag: string;
  days: number;
}

export interface SegmentConditionNode {
  op: "condition";
  field: string;
  comparator: SegmentComparator;
  value: unknown;
}

export interface SegmentBooleanNode {
  op: "and" | "or";
  children: SegmentNode[];
}

export interface SegmentNotNode {
  op: "not";
  child?: SegmentNode;
  children?: SegmentNode[];
}

export type SegmentNode =
  | SegmentConditionNode
  | SegmentBooleanNode
  | SegmentNotNode;

/**
 * SUB-026 — the structured predicate_json contract for saved segments.
 * Both halves are optional so the legacy flat `{status, q}` blob still
 * satisfies the type (it simply has no `ast`):
 *   - `filters` is for UI reconstruction (re-applying the saved view to
 *     the page's filter chips). Only `status` + `q` are compiled
 *     server-side today; the richer fields are persisted for when the
 *     visual builder emits them.
 *   - `ast` is the SegmentNode the server evaluates for previews. The NL
 *     and visual builders write this; the basic save path omits it.
 */
export interface SavedSegmentFilters {
  status?: string;
  q?: string;
  tags?: string[];
  custom_fields?: Record<string, unknown>;
  engagement?: Record<string, unknown>;
  date_range?: Record<string, unknown>;
}

export interface SavedSegmentPredicate {
  filters?: SavedSegmentFilters;
  ast?: SegmentNode;
}

/** SUB-040 — a saved segment's sharing scope: creator-only vs workspace. */
export type SavedSegmentScope = "personal" | "workspace";

/** Server-enforced maximum reusable views per workspace. */
export const SAVED_SEGMENT_MAX_ITEMS = 200;

export interface SavedSegment {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  /**
   * The persisted predicate. New saves carry the structured
   * {filters?, ast?} shape (SUB-026); legacy rows are the flat
   * {status?, q?} blob. Typed `unknown` so existing call sites that
   * narrow it by hand keep compiling.
   */
  predicate_json: unknown;
  created_at: string;
  updated_at: string;
  last_run_at?: string;

  /* SUB-040 — sharing / pinning / ordering / folders. The list endpoint
   * orders pinned-first (is_pinned DESC, pin_order ASC, updated_at DESC). */
  /** Pins the bookmark to the top of the segment picker. */
  is_pinned: boolean;
  /** Manual drag-to-reorder position WITHIN the pinned group (lower =
   *  higher). Absent when unpinned. */
  pin_order?: number;
  /** 'personal' (creator-only) or 'workspace' (every tenant member). */
  visibility_scope: SavedSegmentScope;
  /** The user who saved it. Absent for legacy rows + API-key workspace writes. */
  created_by_user_id?: string;
  /** Files the bookmark under a segment_folders row. Absent when unfiled. */
  folder_id?: string;

  /* SUB-084 — denormalised live membership for the SavedSegmentsManager count
   * badge (migration 1512). Refreshed on an explicit preview/recount
   * (previewSavedSegment / previewSavedSegmentDetail write these back). */
  /** Membership size from the most recent preview/evaluation. Absent (= never
   *  evaluated) → the badge renders "—". Cleared when the predicate changes. */
  last_count?: number;
  /** When last_count was last written. Absent = never. The UI pairs it with
   *  last_count to signal staleness. */
  last_evaluated_at?: string;
}

export interface SavedSegmentInput {
  name: string;
  description?: string;
  predicate_json: unknown;
  /** SUB-040 — optional organizer fields on create. Defaults to
   *  'personal' server-side when omitted. */
  visibility_scope?: SavedSegmentScope;
  folder_id?: string;
}

export interface SavedSegmentPatch {
  name?: string;
  description?: string;
  predicate_json?: unknown;
  touch?: boolean;

  /* SUB-040 — organizer fields. Omit to leave unchanged. */
  is_pinned?: boolean;
  pin_order?: number;
  visibility_scope?: SavedSegmentScope;
  /**
   * folder_id semantics (server-side): omit/null → leave unchanged;
   * "" (empty string) → unfile (set NULL); "<uuid>" → file under that
   * folder.
   */
  folder_id?: string;
}

/** SUB-040 — a flat (single-level) folder for grouping saved segments. */
export interface SegmentFolder {
  id: string;
  tenant_id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

/** POST /api/v1/segments/saved/{id}/preview — SUB-026 bare match count. */
export interface SavedPreviewResponse {
  count: number;
}

/**
 * GET /api/v1/segments/saved/{id}/preview — SUB-030 enriched preview the
 * segment-picker dropdown reads. This contract is intentionally aggregate-only:
 * it returns live count, workspace total, percentage, and generated-at evidence,
 * never member identifiers or email addresses.
 */
export interface SavedSegmentPreview {
  id: string;
  count: number;
  workspace_total: number;
  workspace_percentage: number;
  generated_at: string;
}

export interface SavedSegmentsListResponse {
  items: SavedSegment[];
  /** Tenant-wide count, including personal rows the current user cannot list. */
  total_items?: number;
  /** Optional only for rolling-deploy compatibility; current servers send it. */
  max_items?: number;
}

export function createListSavedSegments(
  request: AudienceSegmentationRequester,
) {
  return async function listSavedSegments(): Promise<
    ApiResult<SavedSegmentsListResponse>
  > {
    return request<SavedSegmentsListResponse>("/api/v1/segments/saved");
  };
}

export function createCreateSavedSegment(
  request: AudienceSegmentationRequester,
) {
  return async function createSavedSegment(
    input: SavedSegmentInput,
  ): Promise<ApiResult<SavedSegment>> {
    return request<SavedSegment>("/api/v1/segments/saved", {
      method: "POST",
      body: JSON.stringify(input),
    });
  };
}

export function createPatchSavedSegment(
  request: AudienceSegmentationRequester,
) {
  return async function patchSavedSegment(
    id: string,
    patch: SavedSegmentPatch,
  ): Promise<ApiResult<SavedSegment>> {
    return request<SavedSegment>(
      `/api/v1/segments/saved/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    );
  };
}

export function createDeleteSavedSegment(
  request: AudienceSegmentationRequester,
) {
  return async function deleteSavedSegment(
    id: string,
  ): Promise<ApiResult<{ ok: boolean }>> {
    return request<{ ok: boolean }>(
      `/api/v1/segments/saved/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  };
}

/* ----- SUB-033: lookalike audiences -------------------------------- */

/**
 * SUB-033 lookalike-audience metadata header (migration 0901). The
 * materialised, ranked members live separately and are fetched via
 * listLookalikeAudienceMembers.
 */
export interface LookalikeModel {
  id: string;
  name?: string;
  seed_segment_id: string;
  size_requested: number;
  /** Realised member count (<= size_requested). */
  member_count: number;
  /** Number of seed members the centroid was built from. */
  seed_count: number;
  confidence_threshold?: number | null;
  model_version: string;
  status: "pending" | "running" | "ready" | "failed";
  /** Seed stats + feature dimensions for the explainability panel. */
  payload?: Record<string, unknown>;
  error?: string;
  created_at?: string;
  updated_at?: string;
}

/** SUB-033 one ranked, modeled member of a lookalike audience (migration 0902). */
export interface LookalikeMember {
  subscriber_id: string;
  email?: string;
  /** Centroid-cosine similarity to the seed in [0,1] (1 = most similar). */
  similarity_score: number;
  /** 1-based position by descending similarity. */
  rank: number;
  /** Per-member contributing-feature snapshot. */
  features?: Record<string, unknown>;
}

/** SUB-033 paginated GET .../members response. */
export interface LookalikeMemberPage {
  items: LookalikeMember[];
  total: number;
  page: number;
  per_page: number;
  /** False unless the caller explicitly opts into direct member identities. */
  pii_included: boolean;
}

/** SUB-033 POST /api/v1/audiences/lookalike body. */
export interface CreateLookalikeInput {
  name?: string;
  seed_segment_id: string;
  /** Target audience size; must be in [100, 10000]. Defaults to 1000 server-side. */
  size?: number;
  /** Optional similarity floor in [0,1]; candidates below it are dropped. */
  confidence_threshold?: number | null;
  /** Explicit acknowledgement of the first-party modeling disclosure. */
  data_use_acknowledged: true;
}

/** SUB-033 lookalike size bounds (Klaviyo/Mailchimp parity range). */
export const LOOKALIKE_MIN_SIZE = 100;
export const LOOKALIKE_MAX_SIZE = 10000;
export const LOOKALIKE_DEFAULT_SIZE = 1000;

const LOOKALIKE_MODEL_STATUSES = new Set([
  "pending",
  "running",
  "ready",
  "failed",
]);

function isLookalikeModel(value: unknown): value is LookalikeModel {
  if (!value || typeof value !== "object") return false;
  const model = value as Partial<LookalikeModel>;
  return (
    typeof model.id === "string" &&
    model.id.trim().length > 0 &&
    typeof model.seed_segment_id === "string" &&
    model.seed_segment_id.trim().length > 0 &&
    Number.isSafeInteger(model.size_requested) &&
    (model.size_requested ?? 0) >= LOOKALIKE_MIN_SIZE &&
    (model.size_requested ?? 0) <= LOOKALIKE_MAX_SIZE &&
    Number.isSafeInteger(model.member_count) &&
    (model.member_count ?? -1) >= 0 &&
    (model.member_count ?? 0) <= (model.size_requested ?? 0) &&
    Number.isSafeInteger(model.seed_count) &&
    (model.seed_count ?? -1) >= 0 &&
    typeof model.model_version === "string" &&
    typeof model.status === "string" &&
    LOOKALIKE_MODEL_STATUSES.has(model.status) &&
    (model.confidence_threshold == null ||
      (typeof model.confidence_threshold === "number" &&
        Number.isFinite(model.confidence_threshold) &&
        model.confidence_threshold >= 0.5 &&
        model.confidence_threshold <= 1))
  );
}

function invalidLookalikeContract(detail: string): ApiResult<never> {
  return responseContractFailure(
    `The lookalike service returned an incomplete response. ${detail}`,
  );
}

/**
 * SUB-033 — POST /api/v1/audiences/lookalike. Generates a materialised
 * lookalike audience by ranking non-seed subscribers by first-party
 * similarity to the seed segment's members (email domain, signup source,
 * engagement tier, churn tier ONLY — no third-party data). Requires the
 * write:subscribers scope.
 */
export function createCreateLookalikeAudience(
  request: AudienceSegmentationRequester,
) {
  return async function createLookalikeAudience(
    input: CreateLookalikeInput,
    options?: { signal?: AbortSignal },
  ): Promise<ApiResult<LookalikeModel>> {
    const response = await request<LookalikeModel>(
      "/api/v1/audiences/lookalike",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
      options?.signal ? { signal: options.signal } : undefined,
    );
    if (response.error) return response;
    if (!isLookalikeModel(response.data)) {
      return invalidLookalikeContract("No unverified audience was shown.");
    }
    if (
      !responseIdentityMatches(
        input.seed_segment_id,
        response.data.seed_segment_id,
      )
    ) {
      return responseIdentityMismatch("lookalike audience");
    }
    return response;
  };
}

/** SUB-033 — GET /api/v1/audiences/lookalike/{id}: the model header. */
export function createGetLookalikeAudience(
  request: AudienceSegmentationRequester,
) {
  return async function getLookalikeAudience(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<ApiResult<LookalikeModel>> {
    const response = await request<LookalikeModel>(
      `/api/v1/audiences/lookalike/${encodeURIComponent(id)}`,
      undefined,
      options?.signal ? { signal: options.signal } : undefined,
    );
    if (response.error) return response;
    if (!isLookalikeModel(response.data)) {
      return invalidLookalikeContract("No unverified audience was shown.");
    }
    if (!responseIdentityMatches(id, response.data.id)) {
      return responseIdentityMismatch("lookalike audience");
    }
    return response;
  };
}

/**
 * SUB-033 — GET /api/v1/audiences/lookalike/{id}/members. Returns the
 * materialised, ranked members (rank 1 = most similar), paginated.
 */
export function createListLookalikeAudienceMembers(
  request: AudienceSegmentationRequester,
) {
  return async function listLookalikeAudienceMembers(
    id: string,
    opts?: {
      page?: number;
      perPage?: number;
      includePII?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<ApiResult<LookalikeMemberPage>> {
    const qs = new URLSearchParams();
    if (opts?.page) qs.set("page", String(opts.page));
    if (opts?.perPage) qs.set("per_page", String(opts.perPage));
    if (opts?.includePII) qs.set("include_pii", "true");
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    const response = await request<LookalikeMemberPage>(
      `/api/v1/audiences/lookalike/${encodeURIComponent(id)}/members${suffix}`,
      undefined,
      opts?.signal ? { signal: opts.signal } : undefined,
    );
    if (response.error) return response;
    const page = response.data;
    if (
      !Array.isArray(page.items) ||
      !Number.isSafeInteger(page.total) ||
      page.total < 0 ||
      !Number.isSafeInteger(page.page) ||
      page.page < 1 ||
      !Number.isSafeInteger(page.per_page) ||
      page.per_page < 1 ||
      typeof page.pii_included !== "boolean" ||
      (!page.pii_included &&
        page.items.some(
          (member) =>
            Boolean(member.subscriber_id) ||
            Boolean(member.email) ||
            (member.features != null &&
              Object.keys(member.features).length > 0),
        ))
    ) {
      return invalidLookalikeContract(
        "No unverified subscriber identities were shown.",
      );
    }
    return response;
  };
}

/** SUB-033 — DELETE /api/v1/audiences/lookalike/{id}. Write scope. */
export function createDeleteLookalikeAudience(
  request: AudienceSegmentationRequester,
) {
  return async function deleteLookalikeAudience(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<ApiResult<void>> {
    return request<void>(
      `/api/v1/audiences/lookalike/${encodeURIComponent(id)}`,
      { method: "DELETE" },
      options?.signal ? { signal: options.signal } : undefined,
    );
  };
}

/* ----- SUB-040: segment folders -----------------------------------
 *
 * A flat folder surface so operators can group saved-segment bookmarks
 * under a named folder. Deleting a folder un-files (ON DELETE SET NULL)
 * rather than deletes its segments.
 */

/** GET /api/v1/segment-folders → `{items}` name-sorted. */
export function createListSegmentFolders(
  request: AudienceSegmentationRequester,
) {
  return async function listSegmentFolders(): Promise<
    ApiResult<{ items: SegmentFolder[] }>
  > {
    return request<{ items: SegmentFolder[] }>("/api/v1/segment-folders");
  };
}

export function createCreateSegmentFolder(
  request: AudienceSegmentationRequester,
) {
  return async function createSegmentFolder(
    name: string,
  ): Promise<ApiResult<SegmentFolder>> {
    return request<SegmentFolder>("/api/v1/segment-folders", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  };
}

export function createPatchSegmentFolder(
  request: AudienceSegmentationRequester,
) {
  return async function patchSegmentFolder(
    id: string,
    name: string,
  ): Promise<ApiResult<SegmentFolder>> {
    return request<SegmentFolder>(
      `/api/v1/segment-folders/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify({ name }) },
    );
  };
}

export function createDeleteSegmentFolder(
  request: AudienceSegmentationRequester,
) {
  return async function deleteSegmentFolder(
    id: string,
  ): Promise<ApiResult<{ ok: boolean }>> {
    return request<{ ok: boolean }>(
      `/api/v1/segment-folders/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  };
}

/**
 * SUB-026 — compile a saved segment's persisted predicate (its top-level
 * `ast`, or the {status, q} filter snapshot when no ast is present) and
 * return the live count of matching subscribers, so the UI can show
 * "X subscribers match" before loading the segment.
 *
 * 422 (unevaluable predicate — a legacy bare-AST row with nothing the
 * server can apply) resolves to a `null` count rather than an error, so
 * the dropdown can render "—" instead of a scary failure banner.
 */
export function createPreviewSavedSegment(
  request: AudienceSegmentationRequester,
) {
  return async function previewSavedSegment(
    id: string,
  ): Promise<ApiResult<SavedPreviewResponse>> {
    const res = await request<SavedPreviewResponse>(
      `/api/v1/segments/saved/${encodeURIComponent(id)}/preview`,
      { method: "POST" },
    );
    return res;
  };
}

/**
 * SUB-030 — the enriched preview the segment-picker dropdown reads: the
 * live match count, the workspace total, the membership-as-%-of-workspace,
 * and generated-at evidence. GET is idempotent; the picker owns a short-lived
 * local freshness window while the server response remains non-cacheable.
 * It never exposes member samples or direct identifiers.
 */
export function createPreviewSavedSegmentDetail(
  request: AudienceSegmentationRequester,
) {
  return async function previewSavedSegmentDetail(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<ApiResult<SavedSegmentPreview>> {
    return request<SavedSegmentPreview>(
      `/api/v1/segments/saved/${encodeURIComponent(id)}/preview`,
      { method: "GET", cache: "no-store" },
      options?.signal ? { signal: options.signal } : undefined,
    );
  };
}

/* ----- SUB-064 / SUB-027: NL segment compiler ---------------------- */

/**
 * Nutrition-facts payload the AI compiler emits alongside the AST. The
 * desktop renders this as the small explainer line below the editable
 * chips ("Predicates: opened, clicked. Time windows: last 7d. Source:
 * ai-compiler"). Source attribution is hidden for the rules engine.
 */
export interface SegmentNutritionFacts {
  predicates: string[];
  time_windows: string[];
  source: string;
  model?: string;
}

export interface SegmentAIProcessingDisclosure {
  provider?: string;
  model?: string;
  data_categories: string[];
  /** `not_declared` is deliberate: the UI must not invent a vendor policy. */
  retention: "not_declared" | string;
  /** `not_declared` is deliberate: the UI must not imply data residency. */
  residency: "not_declared" | string;
}

export interface SegmentAIProcessingPreflight {
  available: boolean;
  ai_processing: SegmentAIProcessingDisclosure;
}

/**
 * Wire shape of POST /api/v1/segments/compile-from-text. Both engines
 * (rules + ai) return the same envelope; only the rules engine
 * populates rationale + suggested_name, and only the ai engine
 * populates nutrition_facts.
 */
export interface CompileFromTextResponse {
  ast: SegmentNode;
  engine_used: "rules" | "ai";
  query_ast?: SegmentNode;
  queryAst?: SegmentNode;
  rationale?: string;
  suggested_name?: string;
  suggestedName?: string;
  nutrition_facts?: SegmentNutritionFacts;
  ai_processing?: SegmentAIProcessingDisclosure;
}

export function isSegmentNutritionFacts(
  value: unknown,
): value is SegmentNutritionFacts {
  if (!value || typeof value !== "object") return false;
  const facts = value as Partial<SegmentNutritionFacts>;
  const validList = (items: unknown): items is string[] =>
    Array.isArray(items) &&
    items.length <= 128 &&
    items.every(
      (item) =>
        typeof item === "string" && item.length > 0 && item.length <= 200,
    );
  return (
    validList(facts.predicates) &&
    validList(facts.time_windows) &&
    typeof facts.source === "string" &&
    facts.source.length > 0 &&
    facts.source.length <= 120 &&
    (facts.model === undefined ||
      (typeof facts.model === "string" && facts.model.length <= 200))
  );
}

function isCompileFromTextResponse(
  value: unknown,
  requestedEngine: "rules" | "ai",
): value is CompileFromTextResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as Partial<CompileFromTextResponse>;
  if (
    response.engine_used !== requestedEngine ||
    !response.ast ||
    typeof response.ast !== "object"
  ) {
    return false;
  }
  const serializedAST = safeJSONString(response.ast);
  if (
    !serializedAST ||
    (response.query_ast !== undefined &&
      safeJSONString(response.query_ast) !== serializedAST) ||
    (response.queryAst !== undefined &&
      safeJSONString(response.queryAst) !== serializedAST)
  ) {
    return false;
  }
  const names = [response.suggested_name, response.suggestedName].filter(
    (name) => name !== undefined,
  );
  if (
    names.some((name) => typeof name !== "string" || name.length > 120) ||
    (names.length === 2 && names[0] !== names[1]) ||
    (response.rationale !== undefined &&
      (typeof response.rationale !== "string" ||
        response.rationale.length > 4096)) ||
    (response.nutrition_facts !== undefined &&
      !isSegmentNutritionFacts(response.nutrition_facts))
  ) {
    return false;
  }
  return (
    requestedEngine !== "ai" ||
    isSegmentAIProcessingDisclosure(response.ai_processing)
  );
}

function safeJSONString(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

export function isSegmentAIProcessingDisclosure(
  value: unknown,
): value is SegmentAIProcessingDisclosure {
  if (!value || typeof value !== "object") return false;
  const disclosure = value as Partial<SegmentAIProcessingDisclosure>;
  return (
    (disclosure.provider === undefined ||
      (typeof disclosure.provider === "string" &&
        disclosure.provider.length <= 200)) &&
    (disclosure.model === undefined ||
      (typeof disclosure.model === "string" &&
        disclosure.model.length <= 200)) &&
    Array.isArray(disclosure.data_categories) &&
    disclosure.data_categories.length > 0 &&
    disclosure.data_categories.length <= 16 &&
    disclosure.data_categories.every(
      (category) => typeof category === "string" && category.length <= 120,
    ) &&
    typeof disclosure.retention === "string" &&
    disclosure.retention.length > 0 &&
    disclosure.retention.length <= 200 &&
    typeof disclosure.residency === "string" &&
    disclosure.residency.length > 0 &&
    disclosure.residency.length <= 200
  );
}

function isSegmentAIProcessingPreflight(
  value: unknown,
): value is SegmentAIProcessingPreflight {
  if (!value || typeof value !== "object") return false;
  const preflight = value as Partial<SegmentAIProcessingPreflight>;
  return (
    typeof preflight.available === "boolean" &&
    isSegmentAIProcessingDisclosure(preflight.ai_processing)
  );
}

export function createGetSegmentAIProcessingDisclosure(
  request: AudienceSegmentationRequester,
) {
  return async function getSegmentAIProcessingDisclosure(options?: {
    signal?: AbortSignal;
  }): Promise<ApiResult<SegmentAIProcessingPreflight>> {
    const response = await request<SegmentAIProcessingPreflight>(
      "/api/v1/segments/compile-from-text",
      { method: "GET", cache: "no-store" },
      options?.signal ? { signal: options.signal } : undefined,
    );
    if (response.error) return response;
    if (!isSegmentAIProcessingPreflight(response.data)) {
      return responseContractFailure(
        "The AI-processing preflight returned an incomplete disclosure. External processing remains unavailable.",
      );
    }
    return response;
  };
}

/**
 * Calls POST /api/v1/segments/compile-from-text. Default engine is
 * `rules`; the caller is expected to retry with `engine: 'ai'` when the
 * rules compiler returns 422 (the caller can detect this via
 * res.error.status when res.error.kind === 'http').
 */
export function createCompileSegmentFromText(
  request: AudienceSegmentationRequester,
  dependencies: AudienceSegmentationDependencies,
) {
  return async function compileSegmentFromText(
    prompt: string,
    opts?: {
      engine?: "ai" | "rules";
      signal?: AbortSignal;
      aiProcessingAcknowledged?: boolean;
    },
  ): Promise<ApiResult<CompileFromTextResponse>> {
    const engine = opts?.engine ?? "rules";
    if (engine === "ai" && opts?.aiProcessingAcknowledged !== true) {
      return responseContractFailure(
        "Explicit AI-processing acknowledgement is required before sending this description.",
      );
    }
    const qs = engine === "ai" ? "?engine=ai" : "";
    // Only the `ai` engine is LLM-backed (60s budget, no auto-retry).
    // The `rules` engine is a fast deterministic compiler and keeps the
    // default timeout/retry behavior.
    const response = await request<CompileFromTextResponse>(
      `/api/v1/segments/compile-from-text${qs}`,
      {
        method: "POST",
        body: JSON.stringify({
          text: prompt,
          ...(engine === "ai" ? { ai_processing_acknowledged: true } : {}),
        }),
      },
      engine === "ai"
        ? {
            ...dependencies.llmRequestOptions,
            ...(opts?.signal ? { signal: opts.signal } : {}),
          }
        : opts?.signal
          ? { signal: opts.signal }
          : {},
    );
    if (response.error) return response;
    if (!isCompileFromTextResponse(response.data, engine)) {
      return responseContractFailure(
        "The audience compiler returned an incomplete or inconsistent response. No draft was accepted.",
      );
    }
    return response;
  };
}

export interface CompiledSegmentPreview {
  count: number;
  workspace_total: number;
  workspace_percentage: number;
  generated_at: string;
  archive_scope: "active_only" | "including_archived";
  applied_exclusions: string[];
}

export function isCompiledSegmentPreview(
  value: unknown,
): value is CompiledSegmentPreview {
  if (!value || typeof value !== "object") return false;
  const preview = value as Partial<CompiledSegmentPreview>;
  return (
    Number.isSafeInteger(preview.count) &&
    (preview.count ?? -1) >= 0 &&
    Number.isSafeInteger(preview.workspace_total) &&
    (preview.workspace_total ?? -1) >= 0 &&
    typeof preview.workspace_percentage === "number" &&
    Number.isFinite(preview.workspace_percentage) &&
    preview.workspace_percentage >= 0 &&
    preview.workspace_percentage <= 100 &&
    typeof preview.generated_at === "string" &&
    !Number.isNaN(Date.parse(preview.generated_at)) &&
    (preview.archive_scope === "active_only" ||
      preview.archive_scope === "including_archived") &&
    Array.isArray(preview.applied_exclusions) &&
    preview.applied_exclusions.every((item) => typeof item === "string")
  );
}

/** Aggregate-only preview: intentionally returns no member identities or SQL. */
export function createPreviewCompiledSegment(
  request: AudienceSegmentationRequester,
) {
  return async function previewCompiledSegment(
    ast: SegmentNode,
    options?: {
      signal?: AbortSignal;
      includeArchived?: boolean;
      targetChannel?: "email" | "sms" | "push";
    },
  ): Promise<ApiResult<CompiledSegmentPreview>> {
    const response = await request<CompiledSegmentPreview>(
      "/api/v1/segments/preview",
      {
        method: "POST",
        body: JSON.stringify({
          queryAst: ast,
          include_archived: options?.includeArchived ?? false,
          target_channel: options?.targetChannel,
        }),
        cache: "no-store",
      },
      options?.signal ? { signal: options.signal } : undefined,
    );
    if (response.error) return response;
    if (!isCompiledSegmentPreview(response.data)) {
      return responseContractFailure(
        "The audience preview response was incomplete. No estimate was shown.",
      );
    }
    return response;
  };
}

/* ----- SUB-075: per-user Subscribers view prefs -------------------- */

export interface SubscribersViewPrefs {
  columns?: string[];
  widths?: Record<string, number>;
  sort?: string;
  order?: "asc" | "desc" | "";
}

export function createGetSubscribersViewPrefs(
  request: AudienceSegmentationRequester,
) {
  return async function getSubscribersViewPrefs(): Promise<
    ApiResult<SubscribersViewPrefs>
  > {
    const res = await request<SubscribersViewPrefs>(
      "/api/v1/me/prefs/subscribers_view",
    );
    // Defaults ONLY for 404 (no prefs row / route absent). A 401 is an
    // auth failure and must propagate — swallowing it masked expired
    // sessions as "fresh defaults" (audit §4.1).
    if (res.error && res.error.kind === "http" && res.error.status === 404) {
      return { data: {} };
    }
    return res;
  };
}

export function createPutSubscribersViewPrefs(
  request: AudienceSegmentationRequester,
) {
  return async function putSubscribersViewPrefs(
    prefs: SubscribersViewPrefs,
  ): Promise<ApiResult<SubscribersViewPrefs>> {
    return request<SubscribersViewPrefs>("/api/v1/me/prefs/subscribers_view", {
      method: "PUT",
      body: JSON.stringify(prefs),
    });
  };
}

/* ----- contact ratings + history ----------------------------------- */

export interface ContactRatingResponse {
  subscriber_id: string;
  rating: number | null;
}

export interface ContactHistoryEvent {
  id: string;
  tenant_id: string;
  subscriber_id: string;
  kind: string;
  at: string;
  payload: Record<string, unknown>;
}

export interface ContactHistoryPage {
  subscriber_id: string;
  items: ContactHistoryEvent[];
  next_cursor?: string;
}

/* ----- SUB-066: per-channel optimal send times --------------------- */

/**
 * One per-channel optimal send window (subscribers.ChannelSendTime).
 * `best_send_hour` is a modal hour-of-week 0-167 (UTC-bucketed), null
 * when no per-channel value has been computed yet — the caller falls
 * back to the aggregate. `day_of_week` (0=Sun) and `hour_of_day` are
 * the backend-derived split of `best_send_hour` (omitted when null).
 */
export interface ChannelSendTime {
  channel: string;
  best_send_hour: number | null;
  best_send_hour_at?: string;
  day_of_week?: number;
  hour_of_day?: number;
}

/**
 * GET /api/v1/subscribers/{id}/send-times (subscribers.PerChannelSendTimes).
 * Per-channel optimal windows plus the legacy channel-agnostic aggregate
 * (`aggregate_best_send_hour`, null when cold). A channel row with a null
 * `best_send_hour` should fall back to the aggregate.
 */
export interface PerChannelSendTimes {
  subscriber_id: string;
  aggregate_best_send_hour: number | null;
  aggregate_best_send_hour_at?: string;
  channels: ChannelSendTime[];
}

/**
 * Reads per-channel optimal send windows for one subscriber. 404 (route
 * not deployed / subscriber not found) resolves to an empty envelope so
 * the slideover renders its cold-start state rather than an error.
 */
export function createGetSubscriberSendTimes(
  request: AudienceSegmentationRequester,
) {
  return async function getSubscriberSendTimes(
    id: string | number,
  ): Promise<ApiResult<PerChannelSendTimes>> {
    const res = await request<PerChannelSendTimes>(
      `/api/v1/subscribers/${encodeURIComponent(String(id))}/send-times`,
    );
    if (res.error && res.error.kind === "http" && res.error.status === 404) {
      return {
        data: {
          subscriber_id: String(id),
          aggregate_best_send_hour: null,
          channels: [],
        },
      };
    }
    if (!res.error && !responseIdentityMatches(id, res.data.subscriber_id)) {
      return responseIdentityMismatch("subscriber");
    }
    return res;
  };
}

export function createSetSubscriberRating(
  request: AudienceSegmentationRequester,
) {
  return async function setSubscriberRating(
    id: string | number,
    rating: number,
  ): Promise<ApiResult<ContactRatingResponse>> {
    const response = await request<ContactRatingResponse>(
      `/api/v1/subscribers/${encodeURIComponent(String(id))}/rating`,
      { method: "PATCH", body: JSON.stringify({ rating }) },
    );
    if (
      !response.error &&
      !responseIdentityMatches(id, response.data.subscriber_id)
    ) {
      return responseIdentityMismatch("subscriber");
    }
    return response;
  };
}

export function createListSubscriberHistory(
  request: AudienceSegmentationRequester,
) {
  return async function listSubscriberHistory(
    id: string | number,
    opts: { limit?: number; before?: string; signal?: AbortSignal } = {},
  ): Promise<ApiResult<ContactHistoryPage>> {
    const qs = new URLSearchParams();
    if (opts.limit) qs.set("limit", String(opts.limit));
    if (opts.before) qs.set("before", opts.before);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    const response = await request<ContactHistoryPage>(
      `/api/v1/subscribers/${encodeURIComponent(String(id))}/history${suffix}`,
      undefined,
      opts.signal ? { signal: opts.signal } : undefined,
    );
    if (
      !response.error &&
      (!Array.isArray(response.data.items) ||
        response.data.items.length > 200 ||
        (response.data.next_cursor !== undefined &&
          (typeof response.data.next_cursor !== "string" ||
            response.data.next_cursor.length === 0 ||
            response.data.next_cursor.length > 512)) ||
        response.data.items.some(
          (event) =>
            typeof event?.id !== "string" ||
            event.id.length === 0 ||
            event.id.length > 128 ||
            typeof event.kind !== "string" ||
            event.kind.length === 0 ||
            event.kind.length > 100 ||
            typeof event.at !== "string" ||
            event.at.length > 64 ||
            !Number.isFinite(Date.parse(event.at)) ||
            event.payload === null ||
            typeof event.payload !== "object" ||
            Array.isArray(event.payload),
        ))
    ) {
      return responseContractFailure(
        "The subscriber history service returned an incomplete response. The previous verified history was kept; retry the request.",
      );
    }
    if (
      !response.error &&
      (!responseIdentityMatches(id, response.data.subscriber_id) ||
        response.data.items.some(
          (event) => !responseIdentityMatches(id, event.subscriber_id),
        ))
    ) {
      return responseIdentityMismatch("subscriber");
    }
    return response;
  };
}

/* ---------- SUB-008 — temporal attribute history -------------------- *
 *
 * Per-field before/after change log for the mutable subscriber
 * attributes that are NOT tags (tags have their own history). Mirrors
 * `subscribers.AttributeHistoryEvent` / `AttributeHistoryPage`
 * (apps/api/internal/subscribers/attribute_history.go). The list
 * endpoint pages newest-first via a `before` RFC3339 cursor.
 */
export interface SubscriberAttributeHistoryEvent {
  id: string;
  subscriber_id: string;
  /** Scalar column name ("status") or "<custom_fields|merge_fields>.<key>". */
  field_name: string;
  /** null when the field was absent before the change (added). */
  old_value: string | null;
  /** null when the field was absent after the change (removed). */
  new_value: string | null;
  /** Emitting verb: subscriber_upsert | subscriber_update | manual. */
  source: string;
  /** Actor UUID; empty when system-driven. */
  changed_by?: string;
  changed_at: string;
}

export interface SubscriberAttributeHistoryPage {
  items: SubscriberAttributeHistoryEvent[];
  /** RFC3339 timestamp to pass back as `before`; empty on the last page. */
  next_cursor?: string;
}

/** GET /api/v1/subscribers/{id}/attribute-history?limit=&before= */
export function createListSubscriberAttributeHistory(
  request: AudienceSegmentationRequester,
) {
  return async function listSubscriberAttributeHistory(
    id: string | number,
    opts: { limit?: number; before?: string } = {},
  ): Promise<ApiResult<SubscriberAttributeHistoryPage>> {
    const qs = new URLSearchParams();
    if (opts.limit) qs.set("limit", String(opts.limit));
    if (opts.before) qs.set("before", opts.before);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    const response = await request<SubscriberAttributeHistoryPage>(
      `/api/v1/subscribers/${encodeURIComponent(String(id))}/attribute-history${suffix}`,
    );
    if (!response.error && !Array.isArray(response.data.items)) {
      return responseContractFailure(
        "The subscriber attribute-history service returned an incomplete response. The previous verified history was kept; retry the request.",
      );
    }
    if (
      !response.error &&
      response.data.items.some(
        (event) => !responseIdentityMatches(id, event.subscriber_id),
      )
    ) {
      return responseIdentityMismatch("subscriber");
    }
    return response;
  };
}

export function createAudienceSegmentationMethods(
  request: AudienceSegmentationRequester,
  dependencies: AudienceSegmentationDependencies,
) {
  return {
    getABResults: createGetABResults(request),
    getABWeightHistory: createGetABWeightHistory(request),
    listInboundTriggers: createListInboundTriggers(request),
    createInboundTrigger: createCreateInboundTrigger(request),
    updateInboundTrigger: createUpdateInboundTrigger(request),
    deleteInboundTrigger: createDeleteInboundTrigger(request),
    listMergeFieldSchema: createListMergeFieldSchema(request),
    createMergeFieldSchema: createCreateMergeFieldSchema(request),
    patchMergeFieldSchema: createPatchMergeFieldSchema(request),
    deleteMergeFieldSchema: createDeleteMergeFieldSchema(request),
    getSubscriberMergeFields: createGetSubscriberMergeFields(request),
    patchSubscriberMergeFields: createPatchSubscriberMergeFields(request),
    listSavedSegments: createListSavedSegments(request),
    createSavedSegment: createCreateSavedSegment(request),
    patchSavedSegment: createPatchSavedSegment(request),
    deleteSavedSegment: createDeleteSavedSegment(request),
    createLookalikeAudience: createCreateLookalikeAudience(request),
    getLookalikeAudience: createGetLookalikeAudience(request),
    listLookalikeAudienceMembers: createListLookalikeAudienceMembers(request),
    deleteLookalikeAudience: createDeleteLookalikeAudience(request),
    listSegmentFolders: createListSegmentFolders(request),
    createSegmentFolder: createCreateSegmentFolder(request),
    patchSegmentFolder: createPatchSegmentFolder(request),
    deleteSegmentFolder: createDeleteSegmentFolder(request),
    previewSavedSegment: createPreviewSavedSegment(request),
    previewSavedSegmentDetail: createPreviewSavedSegmentDetail(request),
    previewCompiledSegment: createPreviewCompiledSegment(request),
    getSegmentAIProcessingDisclosure:
      createGetSegmentAIProcessingDisclosure(request),
    compileSegmentFromText: createCompileSegmentFromText(request, dependencies),
    getSubscribersViewPrefs: createGetSubscribersViewPrefs(request),
    putSubscribersViewPrefs: createPutSubscribersViewPrefs(request),
    getSubscriberSendTimes: createGetSubscriberSendTimes(request),
    setSubscriberRating: createSetSubscriberRating(request),
    listSubscriberHistory: createListSubscriberHistory(request),
    listSubscriberAttributeHistory:
      createListSubscriberAttributeHistory(request),
  };
}
