import type { ApiErr, ApiResult, QueueableApiResult } from "./result";

export interface CampaignSequenceRequestOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  requireOnline?: boolean;
  signal?: AbortSignal;
}

export type CampaignSequenceRequester = <T>(
  path: string,
  init?: RequestInit,
  opts?: CampaignSequenceRequestOptions,
) => Promise<ApiResult<T>>;

export interface CampaignSequenceOperationsDependencies {
  request: CampaignSequenceRequester;
  queueableRequest?: <T>(
    path: string,
    init?: RequestInit,
    opts?: CampaignSequenceRequestOptions,
  ) => Promise<QueueableApiResult<T>>;
  llmRequestOptions: CampaignSequenceRequestOptions;
  sequencePositionPathSegment: (position: number) => string | null;
  pollSequenceJob: (jobId: string) => Promise<ApiErr["error"] | undefined>;
  extractSequenceEmailAt: (
    detail: { steps?: unknown[]; emails?: unknown[] } | undefined,
    position: number,
  ) => SequenceRegeneratedEmail | null;
}

/** Regenerated email content returned by {@link api.regenerateSequenceStep}. */
export interface SequenceRegeneratedEmail {
  subject: string;
  body: string;
}

export interface Campaign {
  id?: string | number;
  name?: string;
  subject?: string;
  status?: string;
  sent_at?: string;
  /** G13: scheduled send time (returned by the List query); drives the
   *  calendar view + drag-to-reschedule. */
  scheduled_at?: string | null;
  created_at?: string;
  open_rate?: number;
  click_rate?: number;
  created_by?: string;
  /** Workstream 2 (A): nullable folder pointer. */
  folder_id?: string | null;
  /** Tags feature 12/12: up to 5 tag ids targeted directly by this
   *  campaign (Mailchimp parity). Empty / missing = no tag targeting. */
  target_tag_ids?: string[];
  segment_id?: string;
  list_id?: string;
  source_template_id?: string;
  source_template_updated_at?: string;
  reference_template_ids?: string[];
  template_variables?: Record<string, unknown>;
  /**
   * sto-strategy-persistence (P2): persisted send-time strategy for the
   * next dispatch. One of "none" | "modal_hour" | "per_recipient".
   * Default "none" = legacy "fire at scheduled_at for everyone" behaviour.
   * Surfaced in CampaignDetailSlideover as a read-only badge so operators
   * can confirm at a glance how the next send will be timed without
   * re-opening the SendTime page. Mirrors how Klaviyo Personalized Send
   * Time, Braze Intelligent Timing, Iterable STO, and MoEngage Sherpa
   * persist the chosen strategy on the campaign row.
   */
  send_time_strategy?: "none" | "modal_hour" | "per_recipient";
  /**
   * sto-message-prioritization (P2): workspace-level Message
   * Prioritization (Braze parity). Integer in [1..10], default 5
   * ("normal marketing"). Pin transactional/system mail at 10. When a
   * subscriber is eligible for multiple sends inside the same
   * frequency-cap window, the higher-priority campaign keeps the slot
   * and the lower-priority one is filtered out at queue-fill.
   * Missing / undefined on legacy payloads — treat as 5.
   */
  priority?: number;
  /**
   * G5 (campaigns 2026): per-recipient send-time optimization. When
   * per_recipient_optimize is true, the queue-fill stager materializes
   * one campaign_recipient_send_at row per subscriber inside
   * [send_window_start, send_window_end], firing each at that
   * subscriber's best_send_hour instead of all at scheduled_at. Read
   * back from the campaign row so the slideover can show a
   * "Personalized within window" badge. Mirrors the patchCampaignPSTO
   * write shape. Klaviyo Personalized Send Time / AC Predictive Sending
   * parity.
   */
  per_recipient_optimize?: boolean;
  send_window_start?: string | null;
  send_window_end?: string | null;
  /**
   * G21 (campaigns 2026): public web-archive state. archive_public flips
   * true once published; archive_slug is the per-issue slug joined with
   * the tenant archive slug to build the shareable "Web version" URL.
   */
  archive_public?: boolean;
  archive_slug?: string;
  /**
   * G15 (campaigns 2026): conversion goal binding. goal_event is the
   * tracked event name; goal_window_hours is the attribution window
   * (1/24/168/720). Empty/0 = no goal configured.
   */
  goal_event?: string;
  goal_window_hours?: number;
  /** G6: "static" (snapshot at compose) or "dynamic" (re-evaluate at send). */
  audience_mode?: string;
}

export interface Sequence {
  id?: string | number;
  name?: string;
  status?: string;
  steps?: number;
  active_runs?: number;
}

/**
 * CampaignDetail extends Campaign with body + tracking config. Mirrors
 * `Campaign` in apps/api/internal/campaigns/types.go.
 */
export interface CampaignDetail extends Campaign {
  preview_text?: string;
  body_html?: string;
  body_mjml?: string;
  plain_text?: string;
  from_name?: string;
  from_email?: string;
  reply_to?: string;
  segment_id?: string;
  scheduled_at?: string | null;
  updated_at?: string;
  campaign_type?: string;
  editor_mode?: string;
  content_blocks?: Array<Record<string, unknown>>;
  source_mode?: "semantic" | "legacy_html";
  content_schema_version?: number;
  fact_contract?: Record<string, unknown>;
  delivery_settings?: Record<string, unknown>;
}

/** Workstream 2 (A) — campaign folder row. */
export interface CampaignFolder {
  id: string;
  tenant_id?: string;
  name: string;
  campaign_count: number;
  created_at?: string;
  updated_at?: string;
}

/** Workstream 2 (B) — single comment on a campaign draft. */
export interface CampaignFeedback {
  id: string;
  tenant_id?: string;
  campaign_id: string;
  author_user_id?: string;
  author_label?: string;
  body: string;
  resolved_at?: string | null;
  resolved_by?: string;
  created_at: string;
  updated_at?: string;
}

/** Workstream 2 (C) — pass/warn/fail result of one pre-send check. */
export interface CampaignChecklistItem {
  key: string;
  label: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

/** Workstream 2 (C) — full pre-send checklist response. */
export interface CampaignChecklist {
  campaign_id: string;
  ready: boolean;
  checks: CampaignChecklistItem[];
}

/**
 * Campaigns 2026 pack 1 (G7) — send-preview payload. Fields whose value
 * is -1 mean "unavailable" or "not applicable" (for example, a suppression
 * timeout or a tenant with no warmup cap). The send ceremony rejects an
 * unavailable suppression result; the all-`-1` cap tuple remains the server's
 * documented no-cap representation. Wire-level int64s are surfaced as plain JS
 * numbers because audiences > 2^53 are outside the supported product ceiling.
 */
export interface CampaignSendPreview {
  campaign_id: string;
  audience_kind: "segment" | "list" | "workspace";
  segment_label?: string;
  recipients: number;
  suppressed_excluded: number;
  deliverable: number;
  tier_cap_today: number;
  tier_cap_remaining: number;
  tier_cap_remaining_after: number;
  over_cap: boolean;
  counted_at: string;
}

/** G3 (campaigns 2026): one inbound reply threaded to a campaign. */
export interface CampaignReply {
  id: string;
  from_email: string;
  subject: string;
  body_text: string;
  received_at: string;
  classification?:
    | "human_reply"
    | "auto_reply"
    | "out_of_office"
    | "bounce"
    | "unsubscribe_request"
    | "challenge_response";
  source?: string;
  body_redacted: boolean;
  /** Empty in v1; populated by the G3 follow-up intent classifier. */
  intent_label?: string;
  intent_confidence?: number;
  intent_classified_at?: string | null;
  intent_classifier?: string;
  intent_revision?: number;
}

/** G3 (campaigns 2026): reply-listing wrapper. */
export interface CampaignRepliesListing {
  campaign_id: string;
  count: number;
  intent_counts: Record<string, number>;
  replies: CampaignReply[];
}

/**
 * G17 (campaigns 2026): persistent AI post-send summary. body_markdown
 * is the rendered text (markdown subset — headings + bold + paragraphs).
 * source is "deterministic" in v1 (template renderer) or "voice" after
 * the G17 follow-up wires the voice service. inputs_snapshot carries
 * the stats the renderer consumed so a regenerate can diff against
 * them.
 */
export interface CampaignAISummary {
  campaign_id: string;
  body_markdown: string;
  source: "deterministic" | "voice";
  inputs_snapshot: Record<string, unknown>;
  generated_at: string;
}

/** Workstream 2 (D) — parsed `{{#if}}…{{else}}…{{/if}}` region. */
export interface CampaignRegion {
  key: string;
  start: number;
  end: number;
  true_branch: string;
  false_branch: string;
  has_else: boolean;
  children?: CampaignRegion[];
}

/** Workstream 2 (D) — response for GET /api/v1/campaigns/{id}/regions. */
export interface CampaignRegionsResponse {
  campaign_id: string;
  source: "body_html" | "plain_text";
  regions: CampaignRegion[];
}

/** PATCH body for /api/v1/campaigns/{id}. */
export interface CampaignUpdateInput {
  name?: string;
  subject?: string;
  status?: string;
  preview_text?: string;
  body_html?: string;
  body_mjml?: string;
  plain_text?: string;
  content_blocks?: Array<Record<string, unknown>>;
  source_mode?: "semantic" | "legacy_html";
  content_schema_version?: number;
  fact_contract?: Record<string, unknown>;
  delivery_settings?: Record<string, unknown>;
  from_name?: string;
  from_email?: string;
  reply_to?: string;
  segment_id?: string;
  scheduled_at?: string | null;
  /** G15: conversion goal binding. goal_event "" clears it. */
  goal_event?: string;
  goal_window_hours?: number;
  /** G6: audience mode — "static" | "dynamic". */
  audience_mode?: string;
}

/** G6: response of POST /api/v1/audiences/count. */
export interface AudienceCountResult {
  base: number;
  excluded: number;
  deliverable: number;
  kind: string;
}

/**
 * POST body for /api/v1/campaigns/test-send.
 *
 * Mirrors `campaigns.TestSendInput` in apps/api. `campaign_id` is optional
 * — when omitted the backend uses the inline `subject` + `body_html`
 * verbatim, which is what the sequence step "Send test" affordance needs.
 * `body_mjml` is currently unused by the desktop call sites (we always
 * pre-render to HTML client-side) but kept here for parity.
 */
export interface CampaignTestSendInput {
  campaign_id?: string;
  to_email: string;
  subject: string;
  body_html: string;
  body_mjml?: string;
}

/** 202 Accepted body from /api/v1/campaigns/test-send. */
export interface CampaignTestSendResponse {
  message_id: string;
  to: string;
  accepted_at: string;
}

/** One step inside a Voice sequence. */
export interface SequenceStep {
  position: number;
  subject: string;
  body?: string;
  body_html?: string;
  /** Days to wait after the previous step (0 for the first step). */
  interval_days?: number;
  delay_days?: number;
}

/**
 * One A/B arm on an email step (roadmap: per-step variants). Mirrors
 * `generation.EmailVariant` in services/voice — `weight_bp` is basis
 * points (sum across a step's variants should be 10000). Resolution is
 * a pure deterministic hash; see {@link voiceRoadmapApi.getStepVariant}.
 */
export interface SequenceEmailVariant {
  key: string;
  subject: string;
  body: string;
  body_html?: string;
  weight_bp: number;
}

/**
 * Sequence-level success criterion (roadmap: goals / exit criteria).
 * Mirrors `generation.SequenceGoal` in services/voice. `kind` is one
 * of "conversion" | "click" | "open" (GoalKind* constants); conversion
 * goals never evaluate true in-repo today (no conversion event source
 * feeding the sequence funnel).
 */
export interface SequenceGoal {
  kind: "conversion" | "click" | "open";
  /** When true, a participant who meets the goal exits the sequence. */
  exit_on_goal: boolean;
}

export interface SequenceCanvasStep {
  type: "email" | "delay" | "condition" | "tag_add" | "tag_remove" | "exit";
  position: number;
  email?: {
    subject: string;
    body?: string;
    body_html?: string;
    delay_seconds?: number;
    template_id?: string;
    /**
     * Roadmap addition (additive): optional A/B arms for this email
     * step. Persisted + validated on top-level AND branch steps, but
     * only top-level steps are resolvable through the
     * /steps/{position}/variant endpoint (branch steps have no flat
     * position identity on the wire).
     */
    variants?: SequenceEmailVariant[];
  };
  delay?: {
    seconds: number;
    value?: number;
    unit?: "minutes" | "hours" | "days";
  };
  condition?: {
    predicate: string;
    value?: string;
    yes_branch?: SequenceCanvasStep[];
    no_branch?: SequenceCanvasStep[];
  };
  tag?: {
    tag: string;
  };
}

export type SequenceStoredStep = SequenceStep | SequenceCanvasStep;

/**
 * Entry-condition for a sequence — what kicks a subscriber into the
 * flow. The four kinds mirror the promise the ValueProp surface made
 * for the list page (event / list subscribe / scheduled) plus a
 * segment-match variant that's the natural fourth.
 *
 * The desktop sends the whole `trigger` envelope on PATCH; backends
 * that don't yet persist the field round-trip it from the request body
 * (we accept that early days will be client-only). The Voice service
 * adds this to `SequenceDetail` JSON when present so the next GET
 * surfaces what the operator picked.
 */
export interface SequenceTrigger {
  /** "list_subscribe" | "segment_match" | "custom_event" | "schedule"
   *  | "tag_added" | "tag_removed" — the last two fire when a tag is
   *  applied or stripped (flowbuilder trigger.kind tag.added/tag.removed,
   *  eventually-consistent after the tag_history commit). */
  kind:
    | "list_subscribe"
    | "segment_match"
    | "custom_event"
    | "schedule"
    | "tag_added"
    | "tag_removed";
  /** Listmonk list id (list_subscribe). Optional pending picker. */
  list_id?: number | string;
  /** Saved segment id (segment_match). Optional pending picker. */
  segment_id?: string;
  /** Custom event name (custom_event), e.g. "checkout.completed". */
  event_name?: string;
  /** Optional cron expression for "schedule" — backend-validated. */
  cron?: string;
  /** Optional ISO-8601 one-shot run time for "schedule" — wall clock. */
  run_at?: string;
  /** Tag name selector for tag_added / tag_removed. Matched case-
   *  insensitively against the catalogue on dispatch. */
  tag_name?: string;
}

/**
 * SequenceDetail — full Voice sequence including all steps.
 *
 * Note: this interface intentionally does NOT extend `Sequence` because
 * `Sequence.steps` is the *count* of steps in list views, while the
 * detail view returns the full step array. We `Omit` the conflict and
 * redeclare. The shape is otherwise permissive because the upstream
 * Voice service is proxied through and may evolve independently.
 */
export interface SequenceDetail extends Omit<Sequence, "steps"> {
  description?: string;
  steps?: SequenceStoredStep[];
  emails?: SequenceStep[];
  /** Entry condition — null/absent means "not configured yet". */
  trigger?: SequenceTrigger | null;
  created_at?: string;
  updated_at?: string;
  /**
   * Monotonically-increasing row version required by every PATCH and DELETE.
   * The canvas captures this on GET and feeds it back through `If-Match` on
   * the next mutation. A missing/invalid version fails closed client-side.
   */
  version?: number;
  /**
   * Roadmap addition (additive): optional sequence goal. Absent/null
   * means "no goal configured". Stored in voice_sequences.goal.
   */
  goal?: SequenceGoal | null;
  /**
   * Roadmap addition (additive): stuck-participant threshold in days.
   * >= 1 enables the stuck report + scanner; 0/absent disables.
   */
  stuck_after_days?: number;
}

/** PATCH body for /api/v1/voice/sequences/{id}. */
export interface SequenceUpdateInput {
  name?: string;
  description?: string;
  status?: string;
  steps?: SequenceStoredStep[];
  /**
   * Phase-2 ops-based delta surface. When set, the backend ignores
   * the full-array `steps` field and applies the ordered op list to
   * the current step list inside a single transaction. Each call MUST
   * also send an If-Match header carrying the row's `version`; the
   * helper {@link patchSequenceOps} below pulls the version off the
   * known SequenceDetail and emits the header automatically.
   *
   * Stale writers see 412 Precondition Failed and the canvas should
   * re-fetch + re-emit the deltas against the latest version.
   */
  ops?: SequencePatchOp[];
  /**
   * Entry-condition update. Send `null` to clear; omit to leave
   * untouched. Sent verbatim — backends that don't yet recognise the
   * field will drop it, which is fine for the v1 client-only path
   * while the Voice service catches up.
   */
  trigger?: SequenceTrigger | null;
  /**
   * Roadmap addition (additive): send `null` to clear the goal, a
   * {@link SequenceGoal} to set/replace it; omit to leave untouched.
   */
  goal?: SequenceGoal | null;
  /**
   * Roadmap addition (additive): 0 disables stuck detection, 1..N
   * enables it with that idle threshold; omit to leave untouched.
   */
  stuck_after_days?: number;
}

/**
 * One element of the ops-based PATCH delta. Mirrors the Go-side
 * `sequenceOp` struct in services/voice — keep the shape in sync.
 *
 *   - "insert" reads `after_id` (omit to prepend) + `step`
 *   - "move"   reads `step_id` + `before_id` (omit to move to end)
 *   - "update" reads `step_id` + `patch`
 *   - "delete" reads `step_id`
 *
 * `step_id` / `after_id` / `before_id` are 1-based positions; the
 * canvas tracks the server-assigned position from the last GET and
 * feeds it back here. Stable client-minted IDs would be cleaner but
 * require a schema change to land first — see the Phase-2 task.
 */
export interface SequencePatchOp {
  op: "insert" | "move" | "update" | "delete";
  step_id?: number;
  after_id?: number;
  before_id?: number;
  step?: SequenceStoredStep;
  patch?: SequenceStoredStep;
}

/** G22: response of POST /api/v1/campaigns/{id}/preview-as. */
export interface CampaignPreviewAs {
  subscriber_email: string;
  body_html: string;
  /** Region KEYs that fell back to the default branch (e.g. segment
   *  membership the preview can't evaluate). */
  unresolved_regions?: string[];
}

/** G19: one authored language variant of a campaign. */
export interface CampaignTranslation {
  locale: string;
  subject: string;
  body_html: string;
  body_mjml?: string;
  updated_at?: string;
}

/** GET /api/v1/campaigns/{id} */
export function createGetCampaign({
  request,
}: CampaignSequenceOperationsDependencies) {
  return function getCampaign(
    id: string | number,
  ): Promise<ApiResult<CampaignDetail>> {
    return request<CampaignDetail>(
      `/api/v1/campaigns/${encodeURIComponent(String(id))}`,
    );
  };
}

/** PATCH /api/v1/campaigns/{id} */
export function createUpdateCampaign({
  request,
  queueableRequest,
}: CampaignSequenceOperationsDependencies) {
  return function updateCampaign(
    id: string | number,
    patch: CampaignUpdateInput,
  ): Promise<QueueableApiResult<CampaignDetail>> {
    return (queueableRequest ?? request)<CampaignDetail>(
      `/api/v1/campaigns/${encodeURIComponent(String(id))}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    );
  };
}

/**
 * G5 (campaigns 2026): PATCH /api/v1/campaigns/{id}/psto
 *
 * Toggles per-recipient send-time optimization on a campaign plus
 * the send-window range. Window must be 30 days or shorter.
 */
export function createPatchCampaignPSTO({
  request,
}: CampaignSequenceOperationsDependencies) {
  return function patchCampaignPSTO(
    id: string | number,
    input: {
      per_recipient_optimize: boolean;
      send_window_start?: string | null;
      send_window_end?: string | null;
    },
  ): Promise<ApiResult<CampaignDetail>> {
    return request<CampaignDetail>(
      `/api/v1/campaigns/${encodeURIComponent(String(id))}/psto`,
      { method: "PATCH", body: JSON.stringify(input) },
    );
  };
}

/** POST /api/v1/campaigns/{id}/send — queue immediate dispatch.
 *
 *  maxAttempts: 1 (audit §4.3): a real send must never be auto-
 *  re-fired on 5xx — double-send safety would otherwise rest on
 *  every backend handler honouring Idempotency-Key. The operator
 *  retries explicitly from the error toast. */
export function createSendCampaign({
  request,
}: CampaignSequenceOperationsDependencies) {
  return function sendCampaign(id: string | number): Promise<
    ApiResult<{
      ok?: boolean;
      queued?: boolean;
      message?: string;
      // Backend returns 202 { status: "approval_required", approval_id }
      // when an approval policy blocks the send — NOTHING is dispatched.
      status?: string;
      approval_id?: string;
      approval_status?: string;
      recipients_queued?: number;
      assurance_rollout_mode?: "warn" | "block";
      assurance_status?:
        | "ok"
        | "warn"
        | "critical"
        | "pending"
        | "stale"
        | "unavailable"
        | "error";
      assurance_reason_code?: string;
    }>
  > {
    return request<{
      ok?: boolean;
      queued?: boolean;
      message?: string;
      status?: string;
      approval_id?: string;
      approval_status?: string;
      recipients_queued?: number;
      assurance_rollout_mode?: "warn" | "block";
      assurance_status?:
        | "ok"
        | "warn"
        | "critical"
        | "pending"
        | "stale"
        | "unavailable"
        | "error";
      assurance_reason_code?: string;
    }>(
      `/api/v1/campaigns/${encodeURIComponent(String(id))}/send`,
      { method: "POST", body: JSON.stringify({}) },
      { maxAttempts: 1, requireOnline: true },
    );
  };
}

/**
 * POST /api/v1/campaigns/test-send — one-off transactional preview.
 *
 * The campaigns service exposes this for two callers:
 *   1. The campaign editor's "Send test" affordance (existing).
 *   2. The sequence step editor — a single step's subject + body can
 *      be tested without an enclosing campaign row, because the handler
 *      accepts ad-hoc `subject` + `body_html` when `campaign_id` is
 *      empty (see apps/api/internal/campaigns/handlers.go::TestSend).
 *
 * The backend pulls the From address from the tenant's transactional
 * sender config; we don't pass `from_email`. Returns 202 Accepted with
 * a message id once the upstream Listmonk send has been handed off.
 */
export function createTestSendCampaignEmail({
  request,
}: CampaignSequenceOperationsDependencies) {
  return function testSendCampaignEmail(
    input: CampaignTestSendInput,
  ): Promise<ApiResult<CampaignTestSendResponse>> {
    return request<CampaignTestSendResponse>(
      "/api/v1/campaigns/test-send",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
      // Send-like POST: never auto-retry (audit §4.3 — double-send risk).
      { maxAttempts: 1 },
    );
  };
}

/** DELETE /api/v1/campaigns/{id} */
export function createDeleteCampaign({
  request,
}: CampaignSequenceOperationsDependencies) {
  return function deleteCampaign(
    id: string | number,
  ): Promise<ApiResult<{ ok: boolean }>> {
    return request<{ ok: boolean }>(
      `/api/v1/campaigns/${encodeURIComponent(String(id))}`,
      { method: "DELETE" },
    );
  };
}

/** GET /api/v1/campaigns/folders */
export function createListCampaignFolders({
  request,
}: CampaignSequenceOperationsDependencies) {
  return async function listCampaignFolders(): Promise<
    ApiResult<{ items: CampaignFolder[] }>
  > {
    const res = await request<{ items: CampaignFolder[] }>(
      "/api/v1/campaigns/folders",
    );
    if (
      res.error &&
      res.error.kind === "http" &&
      (res.error.status === 404 || res.error.status === 501)
    ) {
      return { data: { items: [] } };
    }
    return res;
  };
}

/** POST /api/v1/campaigns/folders */
export function createCreateCampaignFolder({
  request,
}: CampaignSequenceOperationsDependencies) {
  return function createCampaignFolder(
    name: string,
  ): Promise<ApiResult<CampaignFolder>> {
    return request<CampaignFolder>("/api/v1/campaigns/folders", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  };
}

/** PATCH /api/v1/campaigns/folders/{id} */
export function createUpdateCampaignFolder({
  request,
}: CampaignSequenceOperationsDependencies) {
  return function updateCampaignFolder(
    id: string,
    name: string,
  ): Promise<ApiResult<CampaignFolder>> {
    return request<CampaignFolder>(
      `/api/v1/campaigns/folders/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify({ name }) },
    );
  };
}

/** DELETE /api/v1/campaigns/folders/{id} */
export function createDeleteCampaignFolder({
  request,
}: CampaignSequenceOperationsDependencies) {
  return function deleteCampaignFolder(
    id: string,
  ): Promise<ApiResult<{ ok?: boolean }>> {
    return request<{ ok?: boolean }>(
      `/api/v1/campaigns/folders/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  };
}

/** PATCH /api/v1/campaigns/{id}/folder — move (or unset with empty id). */
export function createMoveCampaignToFolder({
  request,
}: CampaignSequenceOperationsDependencies) {
  return function moveCampaignToFolder(
    campaignID: string | number,
    folderID: string,
  ): Promise<ApiResult<{ ok: boolean; folder_id: string }>> {
    return request<{ ok: boolean; folder_id: string }>(
      `/api/v1/campaigns/${encodeURIComponent(String(campaignID))}/folder`,
      { method: "PATCH", body: JSON.stringify({ folder_id: folderID }) },
    );
  };
}

/** GET /api/v1/campaigns/{id}/feedback */
export function createListCampaignFeedback({
  request,
}: CampaignSequenceOperationsDependencies) {
  return function listCampaignFeedback(
    campaignID: string | number,
  ): Promise<ApiResult<{ items: CampaignFeedback[] }>> {
    return request<{ items: CampaignFeedback[] }>(
      `/api/v1/campaigns/${encodeURIComponent(String(campaignID))}/feedback`,
    );
  };
}

/** POST /api/v1/campaigns/{id}/feedback */
export function createCreateCampaignFeedback({
  request,
}: CampaignSequenceOperationsDependencies) {
  return function createCampaignFeedback(
    campaignID: string | number,
    body: string,
  ): Promise<ApiResult<CampaignFeedback>> {
    return request<CampaignFeedback>(
      `/api/v1/campaigns/${encodeURIComponent(String(campaignID))}/feedback`,
      { method: "POST", body: JSON.stringify({ body }) },
    );
  };
}

/** POST /api/v1/campaigns/{id}/feedback/{fid}/resolve */
export function createResolveCampaignFeedback({
  request,
}: CampaignSequenceOperationsDependencies) {
  return function resolveCampaignFeedback(
    campaignID: string | number,
    feedbackID: string,
  ): Promise<ApiResult<CampaignFeedback>> {
    return request<CampaignFeedback>(
      `/api/v1/campaigns/${encodeURIComponent(String(campaignID))}/feedback/${encodeURIComponent(feedbackID)}/resolve`,
      { method: "POST", body: JSON.stringify({}) },
    );
  };
}

/** GET /api/v1/campaigns/{id}/checklist */
export function createGetCampaignChecklist({
  request,
}: CampaignSequenceOperationsDependencies) {
  return function getCampaignChecklist(
    campaignID: string | number,
  ): Promise<ApiResult<CampaignChecklist>> {
    return request<CampaignChecklist>(
      `/api/v1/campaigns/${encodeURIComponent(String(campaignID))}/checklist`,
    );
  };
}

/**
 * GET /api/v1/campaigns/{id}/send-preview
 *
 * Returns who would actually receive the campaign if Send was clicked
 * right now: audience size, suppression delta, deliverable count,
 * and warmup-cap headroom. The send-confirm modal treats this as mandatory,
 * campaign-bound evidence and fails closed when recipient or suppression
 * values are unavailable or internally inconsistent.
 */
export function createGetCampaignSendPreview({
  request,
}: CampaignSequenceOperationsDependencies) {
  return function getCampaignSendPreview(
    campaignID: string | number,
  ): Promise<ApiResult<CampaignSendPreview>> {
    return request<CampaignSendPreview>(
      `/api/v1/campaigns/${encodeURIComponent(String(campaignID))}/send-preview`,
    );
  };
}

/**
 * G3 (campaigns 2026): per-campaign reply list. Reads inbound_emails
 * by campaign_id (populated by the inbound MX route when In-Reply-To
 * matches an outgoing campaign Message-ID). intent_label populated
 * by the G3 follow-up classifier.
 */
export function createListCampaignReplies({
  request,
}: CampaignSequenceOperationsDependencies) {
  return function listCampaignReplies(
    campaignID: string | number,
    opts: { limit?: number; intent?: string } = {},
  ): Promise<ApiResult<CampaignRepliesListing>> {
    const params = new URLSearchParams({ limit: String(opts.limit ?? 50) });
    if (opts.intent) params.set("intent", opts.intent);
    return request<CampaignRepliesListing>(
      `/api/v1/campaigns/${encodeURIComponent(String(campaignID))}/replies?${params.toString()}`,
    );
  };
}

/**
 * G22 (campaigns 2026): render the campaign body as a SPECIFIC
 * subscriber would receive it — merge tags + {% if %} + dynamic
 * regions all resolved against that subscriber's real fields.
 */
export function createPreviewCampaignAsSubscriber({
  request,
}: CampaignSequenceOperationsDependencies) {
  return function previewCampaignAsSubscriber(
    campaignID: string | number,
    input: { subscriber_id?: string; subscriber_email?: string },
  ): Promise<ApiResult<CampaignPreviewAs>> {
    return request<CampaignPreviewAs>(
      `/api/v1/campaigns/${encodeURIComponent(String(campaignID))}/preview-as`,
      { method: "POST", body: JSON.stringify(input) },
    );
  };
}

/** G6 follow-up: snapshot the campaign's current segment membership and
 *  switch it to static audience mode. */
export function createFreezeCampaignAudience({
  request,
}: CampaignSequenceOperationsDependencies) {
  return function freezeCampaignAudience(
    campaignId: string | number,
  ): Promise<ApiResult<{ ok: boolean; frozen_members: number }>> {
    return request(
      `/api/v1/campaigns/${encodeURIComponent(String(campaignId))}/audience/freeze`,
      { method: "POST" },
    );
  };
}

/** G12 follow-up: add an organizational tag to many campaigns at once. */
export function createBulkTagCampaigns({
  request,
}: CampaignSequenceOperationsDependencies) {
  return function bulkTagCampaigns(
    campaignIds: string[],
    tag: string,
  ): Promise<ApiResult<{ ok: boolean; tag: string; tagged: number }>> {
    return request("/api/v1/campaigns/org-tags/bulk", {
      method: "POST",
      body: JSON.stringify({ campaign_ids: campaignIds, tag }),
    });
  };
}

/** G19: list a campaign's authored language variants. */
export function createListCampaignTranslations({
  request,
}: CampaignSequenceOperationsDependencies) {
  return function listCampaignTranslations(
    campaignId: string | number,
  ): Promise<
    ApiResult<{ campaign_id: string; translations: CampaignTranslation[] }>
  > {
    return request(
      `/api/v1/campaigns/${encodeURIComponent(String(campaignId))}/translations`,
    );
  };
}

/** G19: create/update a campaign's variant for one locale. */
export function createUpsertCampaignTranslation({
  request,
}: CampaignSequenceOperationsDependencies) {
  return function upsertCampaignTranslation(
    campaignId: string | number,
    locale: string,
    input: { subject: string; body_html: string; body_mjml?: string },
  ): Promise<ApiResult<CampaignTranslation>> {
    return request(
      `/api/v1/campaigns/${encodeURIComponent(String(campaignId))}/translations/${encodeURIComponent(locale)}`,
      { method: "PUT", body: JSON.stringify(input) },
    );
  };
}

/** G19: delete a locale variant. */
export function createDeleteCampaignTranslation({
  request,
}: CampaignSequenceOperationsDependencies) {
  return function deleteCampaignTranslation(
    campaignId: string | number,
    locale: string,
  ): Promise<ApiResult<{ ok: boolean; locale: string }>> {
    return request(
      `/api/v1/campaigns/${encodeURIComponent(String(campaignId))}/translations/${encodeURIComponent(locale)}`,
      { method: "DELETE" },
    );
  };
}

/**
 * G6 (campaigns 2026): audience count preview — list/segment minus
 * exclusions — for the compose audience picker.
 */
export function createAudienceCount({
  request,
}: CampaignSequenceOperationsDependencies) {
  return function audienceCount(input: {
    list_id?: string;
    segment_id?: string;
    exclude_list_ids?: string[];
    exclude_segment_ids?: string[];
  }): Promise<ApiResult<AudienceCountResult>> {
    return request<AudienceCountResult>("/api/v1/audiences/count", {
      method: "POST",
      body: JSON.stringify(input),
    });
  };
}

/** G3: single reply (with intent) for the view-thread modal. */
export function createGetCampaignReply({
  request,
}: CampaignSequenceOperationsDependencies) {
  return function getCampaignReply(
    campaignID: string | number,
    replyID: string | number,
  ): Promise<ApiResult<CampaignReply>> {
    return request<CampaignReply>(
      `/api/v1/campaigns/${encodeURIComponent(String(campaignID))}/replies/${encodeURIComponent(String(replyID))}`,
    );
  };
}

export function createClassifyCampaignReply({
  request,
}: CampaignSequenceOperationsDependencies) {
  return function classifyCampaignReply(
    campaignID: string | number,
    replyID: string | number,
  ): Promise<ApiResult<CampaignReply>> {
    return request<CampaignReply>(
      `/api/v1/campaigns/${encodeURIComponent(String(campaignID))}/replies/${encodeURIComponent(String(replyID))}/classify`,
      { method: "POST", body: JSON.stringify({}) },
    );
  };
}

/**
 * G17 (campaigns 2026): persistent AI post-send summary. Markdown
 * body + provenance. Renderer is deterministic in v1; voice-service
 * synthesis is a G17 follow-up. 404 when no summary has been
 * generated yet — call regenerateCampaignSummary first.
 */
export function createGetCampaignSummary({
  request,
}: CampaignSequenceOperationsDependencies) {
  return function getCampaignSummary(
    campaignID: string | number,
  ): Promise<ApiResult<CampaignAISummary>> {
    return request<CampaignAISummary>(
      `/api/v1/campaigns/${encodeURIComponent(String(campaignID))}/summary`,
    );
  };
}

/** POST /api/v1/campaigns/{id}/summary/regenerate — recompute. */
export function createRegenerateCampaignSummary({
  request,
}: CampaignSequenceOperationsDependencies) {
  return function regenerateCampaignSummary(
    campaignID: string | number,
    opts?: { force?: boolean },
  ): Promise<ApiResult<CampaignAISummary>> {
    return request<CampaignAISummary>(
      `/api/v1/campaigns/${encodeURIComponent(String(campaignID))}/summary/regenerate`,
      {
        method: "POST",
        // force re-runs the paid voice round trip even if a fresh summary
        // exists; the backend gates force to admins (403 otherwise).
        body: JSON.stringify({ force: opts?.force ?? false }),
      },
    );
  };
}

/** GET /api/v1/campaigns/{id}/regions */
export function createGetCampaignRegions({
  request,
}: CampaignSequenceOperationsDependencies) {
  return function getCampaignRegions(
    campaignID: string | number,
  ): Promise<ApiResult<CampaignRegionsResponse>> {
    return request<CampaignRegionsResponse>(
      `/api/v1/campaigns/${encodeURIComponent(String(campaignID))}/regions`,
    );
  };
}

/** GET /api/v1/voice/sequences/{id} */
export function createGetSequence({
  request,
}: CampaignSequenceOperationsDependencies) {
  return function getSequence(
    id: string | number,
  ): Promise<ApiResult<SequenceDetail>> {
    return request<SequenceDetail>(
      `/api/v1/voice/sequences/${encodeURIComponent(String(id))}`,
    );
  };
}

/** PATCH /api/v1/voice/sequences/{id}
 *
 * Every caller MUST pass `expectedVersion` so the request carries
 * `If-Match: <version>`. The backend rejects missing tokens with 428 and stale
 * versions with 412; this helper fails closed before transport for invalid
 * versions.
 */
export function createUpdateSequence({
  request,
}: CampaignSequenceOperationsDependencies) {
  return async function updateSequence(
    id: string | number,
    patch: SequenceUpdateInput,
    expectedVersion: number,
  ): Promise<ApiResult<SequenceDetail>> {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      return {
        error: {
          kind: "invalid_config",
          message:
            "A fresh sequence version is required before saving. Reload the sequence and try again.",
        },
      };
    }
    return request<SequenceDetail>(
      `/api/v1/voice/sequences/${encodeURIComponent(String(id))}`,
      {
        method: "PATCH",
        body: JSON.stringify(patch),
        headers: { "If-Match": `"${expectedVersion}"` },
      },
    );
  };
}

/**
 * POST /api/v1/voice/sequences/{id}/regenerate/{position}
 *
 * The voice service runs Claude in a detached job and returns
 * `202 {job_id}` (D07#2). This method reconciles all three response
 * shapes it can produce and returns the regenerated email content:
 *   - async 202 `{job_id}`   → poll the job to completion, re-fetch the
 *     sequence, and extract the email at `position`;
 *   - sync single email      → return `{subject, body}` directly;
 *   - full SequenceDetail     → extract the email at `position`.
 * The old code typed the response as SequenceDetail and never polled,
 * so a canvas sequence's regenerate always surfaced "no editable email".
 */
export function createRegenerateSequenceStep({
  request,
  llmRequestOptions: LLM_REQUEST_OPTS,
  sequencePositionPathSegment,
  pollSequenceJob,
  extractSequenceEmailAt,
}: CampaignSequenceOperationsDependencies) {
  return async function regenerateSequenceStep(
    id: string | number,
    position: number,
  ): Promise<ApiResult<SequenceRegeneratedEmail>> {
    const positionSegment = sequencePositionPathSegment(position);
    if (!positionSegment) {
      return {
        error: {
          kind: "invalid_config",
          message: "Sequence email position must be a positive integer.",
        },
      };
    }
    const seqId = String(id);
    const res = await request<Record<string, unknown>>(
      `/api/v1/voice/sequences/${encodeURIComponent(seqId)}/regenerate/${positionSegment}`,
      { method: "POST", body: JSON.stringify({}) },
      LLM_REQUEST_OPTS,
    );
    if (res.error) return { error: res.error };
    const data = res.data ?? {};
    // Async job envelope → poll to completion, then re-fetch + extract.
    if (typeof data.job_id === "string" && data.job_id) {
      const jobErr = await pollSequenceJob(data.job_id);
      if (jobErr) return { error: jobErr };
      const detailRes = await request<SequenceDetail>(
        `/api/v1/voice/sequences/${encodeURIComponent(seqId)}`,
      );
      if (detailRes.error) return { error: detailRes.error };
      const email = extractSequenceEmailAt(detailRes.data, position);
      if (!email) {
        return {
          error: {
            kind: "parse",
            message: "Regenerated email not found in the sequence.",
          },
        };
      }
      return { data: email };
    }
    // Full SequenceDetail response (steps/emails present) → extract.
    if (Array.isArray(data.steps) || Array.isArray(data.emails)) {
      const email = extractSequenceEmailAt(
        data as { steps?: unknown[]; emails?: unknown[] },
        position,
      );
      if (email) return { data: email };
    }
    // Synchronous single-email response (dev/tests where jobs are unwired).
    if (typeof data.subject === "string") {
      return {
        data: {
          subject: data.subject,
          body:
            (typeof data.body === "string" && data.body) ||
            (typeof data.body_html === "string" && data.body_html) ||
            "",
        },
      };
    }
    return {
      error: {
        kind: "parse",
        message: "AI regenerate returned no editable email content.",
      },
    };
  };
}

/** DELETE /api/v1/voice/sequences/{id} */
export function createDeleteSequence({
  request,
}: CampaignSequenceOperationsDependencies) {
  return async function deleteSequence(
    id: string | number,
    expectedVersion: number,
  ): Promise<ApiResult<{ ok: boolean }>> {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      return {
        error: {
          kind: "invalid_config",
          message:
            "A fresh sequence version is required before deleting. Reload the sequence and try again.",
        },
      };
    }
    return request<{ ok: boolean }>(
      `/api/v1/voice/sequences/${encodeURIComponent(String(id))}`,
      {
        method: "DELETE",
        headers: { "If-Match": `"${expectedVersion}"` },
      },
    );
  };
}

export function createCampaignSequenceOperationsMethods(
  dependencies: CampaignSequenceOperationsDependencies,
) {
  return {
    getCampaign: createGetCampaign(dependencies),
    updateCampaign: createUpdateCampaign(dependencies),
    patchCampaignPSTO: createPatchCampaignPSTO(dependencies),
    sendCampaign: createSendCampaign(dependencies),
    testSendCampaignEmail: createTestSendCampaignEmail(dependencies),
    deleteCampaign: createDeleteCampaign(dependencies),
    listCampaignFolders: createListCampaignFolders(dependencies),
    createCampaignFolder: createCreateCampaignFolder(dependencies),
    updateCampaignFolder: createUpdateCampaignFolder(dependencies),
    deleteCampaignFolder: createDeleteCampaignFolder(dependencies),
    moveCampaignToFolder: createMoveCampaignToFolder(dependencies),
    listCampaignFeedback: createListCampaignFeedback(dependencies),
    createCampaignFeedback: createCreateCampaignFeedback(dependencies),
    resolveCampaignFeedback: createResolveCampaignFeedback(dependencies),
    getCampaignChecklist: createGetCampaignChecklist(dependencies),
    getCampaignSendPreview: createGetCampaignSendPreview(dependencies),
    listCampaignReplies: createListCampaignReplies(dependencies),
    previewCampaignAsSubscriber:
      createPreviewCampaignAsSubscriber(dependencies),
    freezeCampaignAudience: createFreezeCampaignAudience(dependencies),
    bulkTagCampaigns: createBulkTagCampaigns(dependencies),
    listCampaignTranslations: createListCampaignTranslations(dependencies),
    upsertCampaignTranslation: createUpsertCampaignTranslation(dependencies),
    deleteCampaignTranslation: createDeleteCampaignTranslation(dependencies),
    audienceCount: createAudienceCount(dependencies),
    getCampaignReply: createGetCampaignReply(dependencies),
    classifyCampaignReply: createClassifyCampaignReply(dependencies),
    getCampaignSummary: createGetCampaignSummary(dependencies),
    regenerateCampaignSummary: createRegenerateCampaignSummary(dependencies),
    getCampaignRegions: createGetCampaignRegions(dependencies),
    getSequence: createGetSequence(dependencies),
    updateSequence: createUpdateSequence(dependencies),
    regenerateSequenceStep: createRegenerateSequenceStep(dependencies),
    deleteSequence: createDeleteSequence(dependencies),
  };
}
