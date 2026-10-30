// SPDX-License-Identifier: AGPL-3.0-only
//
// Typed wrappers around the segment HTTP endpoints exposed by apps/api.
//
// Note: the canonical SegmentNode AST is defined in packages/schema/src/index.ts
// (the @postwave/schema MIT package). It is not yet exposed as an npm
// dependency to apps/web, so we re-declare the structural type here. The
// shape MUST stay byte-compatible with the canonical definition — both ends
// serialise to/from the same jsonb column.

import { api } from "./api";

export type Comparator =
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
  // Presence operators — compiled to IS NULL / IS NOT NULL. Used by the
  // builder's "is set" / "is not set" date affordance (SEG-008).
  | "is_null"
  | "is_not_null"
  // Segment-of-segments (SUB-032): the value is the referenced segment's id.
  | "in_segment"
  | "not_in_segment"
  // Rolling windows. On engagement dates the value is a day count; on event
  // counts it is { days }. `ever` / `never` take no value.
  | "in_last_days"
  | "more_than_days_ago"
  | "ever"
  | "never"
  // Tag history: the value is { tag, days }.
  | "added_in_last_days"
  | "removed_in_last_days";

/**
 * Value of a tag-history rule: the tag and the look-back window in days. The
 * builder holds it while `days` is still being typed; a rule is complete (and
 * compiles) only once both are present.
 */
export interface TagWindowValue {
  tag: string;
  days?: number;
}

/**
 * Value of an event-count rule. Count comparators carry `count` and an
 * optional `days` window (omitted = all time); the window comparators carry
 * only `days`. `event_name` is the event as tracked ("Placed Order"): the
 * field key only carries its slug, and the compiler counts events whose name
 * equals the slug unless the value names the event.
 */
export interface EventCountValue {
  count?: number;
  days?: number;
  event_name?: string;
}

export interface SegmentAnd {
  op: "and";
  children: SegmentNode[];
}
export interface SegmentOr {
  op: "or";
  children: SegmentNode[];
}
export interface SegmentNot {
  op: "not";
  child: SegmentNode;
}
export interface SegmentCondition {
  op: "condition";
  field: string;
  comparator: Comparator;
  value:
    | string
    | number
    | boolean
    | string[]
    | number[]
    | TagWindowValue
    | EventCountValue;
}
export type SegmentNode =
  | SegmentAnd
  | SegmentOr
  | SegmentNot
  | SegmentCondition;

export interface Segment {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  queryAst: SegmentNode;
  lastCount?: number | null;
  lastEvaluatedAt?: string | null;
  /** Persisted archive-scope toggle (SEG-034); defaults false (active-only). */
  includeArchived?: boolean;
  /** Folder this segment is filed under (SEG-038); null/undefined when unfiled. */
  folderId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSegmentInput {
  name: string;
  description?: string;
  queryAst: SegmentNode;
  /** Persist the archive-scope toggle with the definition (SEG-034). */
  includeArchived?: boolean;
  /** File the new segment under a folder (SEG-038). */
  folderId?: string | null;
}

export interface UpdateSegmentInput {
  name?: string;
  description?: string;
  queryAst?: SegmentNode;
  /** Persist the archive-scope toggle (SEG-034); omit to leave unchanged. */
  includeArchived?: boolean;
  /**
   * File the segment under a folder (SEG-038). Omit to leave unchanged; ""
   * to unfile (folder_id → null); a folder id to file it there.
   */
  folderId?: string | null;
}

// --- Segment folders (SEG-038) --------------------------------------------
// Folder registry shared with saved segments. GET/POST/PATCH/DELETE at
// /api/v1/segment-folders. Assignment is via updateSegment({ folderId }).

export interface SegmentFolder {
  id: string;
  name: string;
  created_at?: string;
  updated_at?: string;
}

export function listSegmentFolders(): Promise<SegmentFolder[]> {
  return api
    .get<{ items: SegmentFolder[] }>("/api/v1/segment-folders")
    .then((r) => (Array.isArray(r?.items) ? r.items : []));
}

export function createSegmentFolder(name: string): Promise<SegmentFolder> {
  return api.post<SegmentFolder>("/api/v1/segment-folders", { name });
}

export function deleteSegmentFolder(id: string): Promise<{ ok: true }> {
  return api.delete<{ ok: true }>(
    `/api/v1/segment-folders/${encodeURIComponent(id)}`,
  );
}

export interface PreviewResponse {
  count: number;
  workspace_total: number;
  workspace_percentage: number;
  generated_at: string;
  archive_scope: "active_only" | "including_archived";
  applied_exclusions: string[];
}

// Tenant custom-field registry. The segment AST addresses a custom field as
// `field: "custom.<key>"` (see apps/api/internal/segments/compile.go), so the
// builder needs the tenant's declared fields to offer them in the FieldPicker.
export interface CustomField {
  id: string;
  key: string;
  label: string;
  // Backend supports a richer type taxonomy than the builder's 4 kinds; the
  // editor maps these down to its FieldKind. See customFieldKind() callers.
  type:
    | "string"
    | "number"
    | "boolean"
    | "date"
    | "enum"
    | "array"
    | "object"
    | "email"
    | "url"
    | "phone"
    | "region";
}

export function listCustomFields(): Promise<CustomField[]> {
  return api.get<CustomField[]>("/api/v1/custom-fields");
}

export function listSegments(): Promise<Segment[]> {
  return api.get<Segment[]>("/api/v1/segments");
}

const segmentEtags = new Map<string, string>();

function rememberSegmentEtag(id: string, response: Response): void {
  // A 412 means the cached token is DEAD. `api.request` runs onResponse before
  // it checks `res.ok`, and a rejected precondition carries no ETag, so a
  // set-only capture leaves it in the map and every later save resends it —
  // another 412, forever, with no way out but a reload. Dropping it lets the
  // next save proceed unconditioned (the same stance campaigns-api takes: never
  // manufacture a token we do not have). Mirrors `captureCampaignETag`.
  if (response.status === 412) {
    segmentEtags.delete(id);
    return;
  }
  const etag = response.headers.get("etag");
  if (etag) segmentEtags.set(id, etag);
}

export function getSegment(id: string): Promise<Segment> {
  return api.get<Segment>(`/api/v1/segments/${encodeURIComponent(id)}`, {
    onResponse: (response) => rememberSegmentEtag(id, response),
  });
}

export function createSegment(input: CreateSegmentInput): Promise<Segment> {
  let responseEtag = "";
  return api
    .post<Segment>("/api/v1/segments", input, {
      onResponse: (response) => {
        responseEtag = response.headers.get("etag") ?? "";
      },
    })
    .then((segment) => {
      if (responseEtag) segmentEtags.set(segment.id, responseEtag);
      return segment;
    });
}

export function updateSegment(
  id: string,
  patch: UpdateSegmentInput,
): Promise<Segment> {
  return api.patch<Segment>(
    `/api/v1/segments/${encodeURIComponent(id)}`,
    patch,
    {
      headers: segmentEtags.has(id)
        ? { "If-Match": segmentEtags.get(id)! }
        : undefined,
      onResponse: (response) => rememberSegmentEtag(id, response),
    },
  );
}

export function deleteSegment(id: string): Promise<{ ok: true }> {
  return api.delete<{ ok: true }>(`/api/v1/segments/${encodeURIComponent(id)}`);
}

export interface PreviewOptions {
  signal?: AbortSignal;
  /** Expand match count + workspace denominator to archived subscribers. */
  includeArchived?: boolean;
}

export function previewSegment(
  ast: SegmentNode,
  opts?: PreviewOptions,
): Promise<PreviewResponse> {
  return api.post<PreviewResponse>(
    "/api/v1/segments/preview",
    {
      queryAst: ast,
      ...(opts?.includeArchived ? { include_archived: true } : {}),
    },
    opts?.signal ? { signal: opts.signal } : undefined,
  );
}

// --- Recompute (SEG-006) --------------------------------------------------
// POST /api/v1/segments/{id}/recompute refreshes last_count + last_evaluated_at
// synchronously and returns the fresh count.
export interface RecomputeResponse {
  scheduled_at: string;
  count: number;
}

export function recomputeSegment(id: string): Promise<RecomputeResponse> {
  return api.post<RecomputeResponse>(
    `/api/v1/segments/${encodeURIComponent(id)}/recompute`,
  );
}

// --- Usage (SEG-010) ------------------------------------------------------
// GET /api/v1/segments/{id}/usage lists every campaign/form/audience-destination
// that references the segment, so delete can warn on real dependents.
export interface SegmentUsageReference {
  kind: "campaign" | "form" | "audience_destination" | string;
  id: string;
  name: string;
  status?: string;
  /**
   * True for a campaign that hasn't started sending: while one uses the
   * segment, the API refuses to delete it (409 segment_in_use). Decided by the
   * server with the refusal's own rule, so a paused campaign that already began
   * sending is false whatever its status says.
   */
  blocks_delete?: boolean;
}
export interface SegmentUsageResponse {
  items: SegmentUsageReference[];
  count: number;
}

export function getSegmentUsage(id: string): Promise<SegmentUsageResponse> {
  return api.get<SegmentUsageResponse>(
    `/api/v1/segments/${encodeURIComponent(id)}/usage`,
  );
}

// --- Starter templates (SEG-011) ------------------------------------------
// GET /api/v1/segments/templates returns a static catalog of starter
// predictive audiences, each with a ready-to-materialize AST.
export interface SegmentTemplate {
  key: string;
  label: string;
  description: string;
  icon_hint?: string;
  category: string;
  suggested_name: string;
  /** Serialized SegmentNode AST. */
  predicate_json: SegmentNode;
}

export function listSegmentTemplates(): Promise<SegmentTemplate[]> {
  return api
    .get<{ items: SegmentTemplate[] }>("/api/v1/segments/templates")
    .then((r) => (Array.isArray(r.items) ? r.items : []));
}

// --- Predicate registry (SEG-013) -----------------------------------------
// GET /api/v1/segments/predicate-registry describes the full predicate surface
// the compiler supports (engagement, predictive/RFM, geo, custom objects).
export interface PredicateDefinition {
  key: string;
  label: string;
  category: string;
  /** The category as a heading people read ("Custom fields", not "custom_field"). */
  category_label?: string;
  value_type: string;
  comparators: string[];
  options?: string[];
  source: string;
  source_ref?: string;
  activation: string[];
  compiler_status: string;
  help?: string;
}
export interface PredicateRegistryResponse {
  registry_version: string;
  boolean_ops: string[];
  predicates: PredicateDefinition[];
  metrics: unknown[];
  custom_objects: unknown[];
  warnings?: string[];
}

export function getPredicateRegistry(): Promise<PredicateRegistryResponse> {
  return api.get<PredicateRegistryResponse>(
    "/api/v1/segments/predicate-registry",
  );
}

// --- Natural-language compile (SEG-014) -----------------------------------
// POST /api/v1/segments/compile-from-text turns a description into an AST.
export interface CompileFromTextResponse {
  ast: SegmentNode;
  queryAst: SegmentNode;
  engine_used: "rules" | "ai" | string;
  rationale?: string;
  suggested_name?: string;
  nutrition_facts?: unknown;
}

export function compileFromText(
  text: string,
  opts?: { engine?: "rules" | "ai"; acknowledged?: boolean },
): Promise<CompileFromTextResponse> {
  const engine = opts?.engine ?? "rules";
  return api.post<CompileFromTextResponse>(
    "/api/v1/segments/compile-from-text",
    {
      text,
      ...(opts?.acknowledged ? { ai_processing_acknowledged: true } : {}),
    },
    { query: { engine } },
  );
}

// --- AI suggestions (SEG-037) ---------------------------------------------
export interface AiSuggestion {
  key: string;
  name: string;
  description: string;
  predicate_json: SegmentNode;
  estimated_size: number;
  rationale: string;
  category: string;
}
export interface AiSuggestionsResponse {
  items: AiSuggestion[];
  generated: string;
  notice: string;
}

export function getAiSuggestions(): Promise<AiSuggestionsResponse> {
  return api.get<AiSuggestionsResponse>("/api/v1/segments/ai-suggestions");
}

// --- Size history / growth (SEG-039) --------------------------------------
export interface SizeHistoryPoint {
  evaluated_at: string;
  count: number;
}
export interface SizeHistoryResponse {
  segment_id: string;
  window_days: number;
  series: SizeHistoryPoint[];
  note?: string;
}

export function getSizeHistory(
  id: string,
  windowDays?: number,
): Promise<SizeHistoryResponse> {
  // The API reads `window` ("90d"); a `window_days` parameter is ignored and
  // silently falls back to the 90-day default.
  return api.get<SizeHistoryResponse>(
    `/api/v1/segments/${encodeURIComponent(id)}/size-history`,
    windowDays ? { query: { window: `${windowDays}d` } } : undefined,
  );
}

// --- Overlap / comparison (SEG-042) ---------------------------------------
export interface OverlapResponse {
  a: string;
  b: string;
  a_count: number;
  b_count: number;
  intersection: number;
  jaccard: number;
}

export function getSegmentOverlap(
  a: string,
  b: string,
): Promise<OverlapResponse> {
  return api.get<OverlapResponse>("/api/v1/segments/overlap", {
    query: { a, b },
  });
}

// --- Definition history (SEG-041) -----------------------------------------
/** Serialized segment snapshot carried on a history entry (SEG-041). */
export interface SegmentHistorySnapshot {
  queryAst?: SegmentNode;
  name?: string;
  description?: string;
}

export interface DefinitionHistoryEntry {
  audit_id: number;
  at: string;
  actor_label: string;
  action: string;
  before?: SegmentHistorySnapshot | null;
  after?: SegmentHistorySnapshot | null;
}

export function getDefinitionHistory(
  id: string,
): Promise<{ items: DefinitionHistoryEntry[] }> {
  return api.get<{ items: DefinitionHistoryEntry[] }>(
    `/api/v1/segments/${encodeURIComponent(id)}/definition-history`,
  );
}

// --- Engagement summary (SEG-053, partial) --------------------------------
export interface EngagementSummaryResponse {
  segment_id: string;
  window_days: number;
  member_count: number;
  sends: number;
  opens: number;
  clicks: number;
  unsubs: number;
  bounces: number;
  complaints: number;
  open_rate: number;
  click_rate: number;
  unsub_rate: number;
  rate_basis: string;
  generated_at: string;
}

export function getEngagementSummary(
  id: string,
): Promise<EngagementSummaryResponse> {
  return api.get<EngagementSummaryResponse>(
    `/api/v1/segments/${encodeURIComponent(id)}/engagement-summary`,
  );
}

// --- Live members --------------------------------------------------------
// GET /api/v1/segments/{id}/members evaluates the definition now, under the
// segment's own archive scope, and pages through who matches (newest first).
export interface LiveMember {
  subscriber_id: string;
  email: string;
  /** True only in segments that include archived subscribers. */
  archived: boolean;
}
export interface LiveMembersResponse {
  items: LiveMember[];
  page: number;
  per_page: number;
  total: number;
  archive_scope: "active_only" | "including_archived";
  generated_at: string;
}

export function getSegmentMembers(
  id: string,
  page = 1,
  perPage = 50,
): Promise<LiveMembersResponse> {
  return api.get<LiveMembersResponse>(
    `/api/v1/segments/${encodeURIComponent(id)}/members`,
    { query: { page, per_page: perPage } },
  );
}

// --- Snapshots / members (SEG-015, SEG-053) -------------------------------
// A snapshot materializes a point-in-time membership sample; its members
// endpoint is the privacy-safe way to answer "who is in this segment?".
export interface SegmentSnapshot {
  id: string;
  segment_id: string;
  count: number;
  sample_size: number;
  evaluated_at: string;
  created_at: string;
}
export interface SnapshotMember {
  email: string;
  subscriber_id: string;
}
export interface SnapshotMembersResponse {
  items: SnapshotMember[];
  page: number;
  per_page: number;
  total: number;
  sample_size: number;
  sample_is_complete: boolean;
}

export function listSnapshots(id: string): Promise<SegmentSnapshot[]> {
  return api
    .get<{
      items: SegmentSnapshot[];
    }>(`/api/v1/segments/${encodeURIComponent(id)}/snapshots`)
    .then((r) => (Array.isArray(r.items) ? r.items : []));
}

export function createSnapshot(id: string): Promise<SegmentSnapshot> {
  return api.post<SegmentSnapshot>(
    `/api/v1/segments/${encodeURIComponent(id)}/snapshot`,
  );
}

export function getSnapshotMembers(
  snapshotId: string,
  page = 1,
  perPage = 50,
): Promise<SnapshotMembersResponse> {
  return api.get<SnapshotMembersResponse>(
    `/api/v1/segments/snapshots/${encodeURIComponent(snapshotId)}/members`,
    { query: { page, per_page: perPage } },
  );
}

// --- Decay radar (SEG-051) -------------------------------------------------
// An anomaly-detection worker records segment membership swings (who left /
// entered, and why) with optional AI narration; these wrappers surface it.
export interface DecayEvent {
  id: string;
  segment_id: string;
  snapshot_date: string;
  anomaly_kind: string;
  prior_count: number;
  new_count: number;
  leaver_count: number;
  entrant_count: number;
  narration?: string;
  narration_model?: string;
  dismissed_at?: string | null;
  created_at: string;
}
export interface DecayMember {
  subscriber_id: string;
  email: string;
  direction: string;
}
export interface DecayMembersResponse {
  items: DecayMember[];
  page: number;
  per_page: number;
  total: number;
  /** True when the per-direction membership log hit its cap — the drill-down
   * is a bounded sample, not the exhaustive set. */
  bounded_by_log_cap: boolean;
}

export function listDecayEvents(
  id: string,
  opts: { undismissed?: boolean; limit?: number } = {},
): Promise<DecayEvent[]> {
  const query: Record<string, string | number> = {};
  if (opts.undismissed) query.undismissed = "true";
  if (opts.limit) query.limit = opts.limit;
  return api
    .get<{
      items: DecayEvent[];
    }>(`/api/v1/segments/${encodeURIComponent(id)}/decay-events`, { query })
    .then((r) => (Array.isArray(r.items) ? r.items : []));
}

export function getDecayEventMembers(
  id: string,
  eventId: string,
  opts: { direction: "entered" | "left"; page?: number; perPage?: number },
): Promise<DecayMembersResponse> {
  return api.get<DecayMembersResponse>(
    `/api/v1/segments/${encodeURIComponent(id)}/decay-events/${encodeURIComponent(eventId)}/members`,
    {
      query: {
        direction: opts.direction,
        page: opts.page ?? 1,
        per_page: opts.perPage ?? 50,
      },
    },
  );
}

export function dismissDecayEvent(
  id: string,
  eventId: string,
): Promise<{ dismissed: boolean }> {
  return api.post<{ dismissed: boolean }>(
    `/api/v1/segments/${encodeURIComponent(id)}/decay-events/${encodeURIComponent(eventId)}/dismiss`,
  );
}

/** Generate an AI narration for a decay event. The backend returns 503
 * `ai_unavailable` when the model is offline — callers should toast, not error. */
export function narrateDecayEvent(
  id: string,
  eventId: string,
): Promise<DecayEvent> {
  return api.post<DecayEvent>(
    `/api/v1/segments/${encodeURIComponent(id)}/decay-events/${encodeURIComponent(eventId)}/narrate`,
  );
}

// --- Profit & loss + holdout lift (SEG-053) -------------------------------
// The P&L endpoint reconciles observed revenue, AOV, CLV, and cost pillars
// for a segment's members over a window; `lift` is populated only when a
// holdout is configured AND include_lift is requested. Currency fields stay
// honest — net contribution is nil when revenue/cost currencies differ.
export interface SegmentLiftResult {
  holdout_percent: number;
  control_size: number;
  treated_size: number;
  control_conv_rate: number;
  treated_conv_rate: number;
  incremental_lift: number;
  lift_percent: number;
  window_days: number;
  confidence_low: boolean;
}

export interface SegmentPnLResponse {
  segment_id: string;
  member_count: number;
  window_days: number;
  currency?: string;
  revenue_cents: number;
  revenue_conversions: number;
  revenue_per_member_cents?: number | null;
  revenue_scope: string;
  aov_cents?: number | null;
  aov_order_count: number;
  aov_currency?: string;
  clv_members_scored: number;
  clv_historic_sum_cents: number;
  clv_predicted_sum_cents: number;
  clv_realised_vs_predicted?: number | null;
  unsub_count: number;
  complaint_count: number;
  total_cost_cents: number;
  cost_currency: string;
  cost_config_present: boolean;
  net_contribution_cents?: number | null;
  net_contribution_per_member_cents?: number | null;
  lift?: SegmentLiftResult | null;
  lift_skipped_reason?: string;
  sequence_attribution_unsupported: boolean;
  cross_currency_revenue_excluded: boolean;
  generated_at: string;
}

export function getSegmentPnL(
  id: string,
  opts: { days?: number; includeLift?: boolean } = {},
): Promise<SegmentPnLResponse> {
  const query: Record<string, string | number | boolean> = {};
  if (opts.days) query.days = opts.days;
  if (opts.includeLift) query.include_lift = true;
  return api.get<SegmentPnLResponse>(
    `/api/v1/segments/${encodeURIComponent(id)}/pnl`,
    { query },
  );
}

export interface SegmentHoldoutConfig {
  segment_id: string;
  percent: number;
  seed: string;
  window_days: number;
  decided_at?: string | null;
  created_at: string;
  updated_at: string;
}

export function setSegmentHoldout(
  id: string,
  input: { percent: number; window_days?: number },
): Promise<SegmentHoldoutConfig> {
  return api.post<SegmentHoldoutConfig>(
    `/api/v1/segments/${encodeURIComponent(id)}/holdout`,
    input,
  );
}

export function deleteSegmentHoldout(id: string): Promise<{ ok: true }> {
  return api.delete<{ ok: true }>(
    `/api/v1/segments/${encodeURIComponent(id)}/holdout`,
  );
}

// --- Growth report CSV export (SEG-040) -----------------------------------
// Path builder for the streamed CSV; fetched via fetchTextAuthed so the
// tenant header rides along (a bare anchor download cannot attach it).
export function segmentGrowthReportCsvPath(id: string): string {
  return `/api/v1/segments/${encodeURIComponent(id)}/growth/report.csv`;
}
