// SPDX-License-Identifier: AGPL-3.0-only

import { api } from "./api";
import { isMockModeEnabled } from "./mock-mode";

export type CampaignStatus =
  | "draft"
  | "scheduled"
  | "sending"
  | "sent"
  | "paused"
  | "cancelled"
  | "failed";

export const CAMPAIGN_SCHEDULING_RELEASE_HOLD =
  "Campaign scheduling is unavailable until durable dispatch recovery is release-qualified. No fixed-time, best-time, recipient-timezone, or recurring delivery will be queued from this web app.";

export class CampaignSchedulingUnavailableError extends Error {
  readonly code = "campaign_scheduling_unqualified";

  constructor() {
    super(CAMPAIGN_SCHEDULING_RELEASE_HOLD);
    this.name = "CampaignSchedulingUnavailableError";
  }
}

export function rejectCampaignScheduling<T>(): Promise<T> {
  return Promise.reject(new CampaignSchedulingUnavailableError());
}

export interface Campaign {
  id: string;
  tenant_id: string;
  name: string;
  subject: string;
  status: CampaignStatus;
  campaign_type?:
    | "regular"
    | "plain_text"
    | "ab_test"
    | "rss"
    | "automated"
    | "transactional";
  editor_mode?: "blocks" | "html" | "plain_text" | "mjml";
  preview_text?: string;
  body_html?: string;
  body_mjml?: string;
  plain_text?: string;
  from_name?: string;
  reply_to?: string;
  content_blocks?: Array<Record<string, unknown>>;
  /** Authoritative content source. Semantic campaigns must never round-trip
   * through the legacy HTML/block renderers. */
  source_mode?: "semantic" | "legacy_html";
  /** Current server contract: semantic=2, legacy_html=1. */
  content_schema_version?: number;
  /** Normalized Fact Contract v1, or an empty object. */
  fact_contract?: Record<string, unknown>;
  reusable_section_ids?: string[];
  variants?: Array<Record<string, unknown>>;
  tracking_settings?: Record<string, unknown>;
  delivery_settings?: Record<string, unknown>;
  segment_id?: string;
  /** The list audience: the list's numeric catalogue id, as a string. */
  list_id?: string;
  /**
   * "static" once the audience has been frozen: the campaign then sends to
   * the snapshot taken at freeze time, and its list or segment cannot change.
   */
  audience_mode?: "static" | "dynamic";
  source_template_id?: string;
  source_template_updated_at?: string;
  reference_template_ids?: string[];
  template_variables?: Record<string, unknown>;
  scheduled_at?: string | null;
  sent_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateCampaignInput {
  name: string;
  subject: string;
  campaign_type?: Campaign["campaign_type"];
  editor_mode?: Campaign["editor_mode"];
  preview_text?: string;
  body_html?: string;
  body_mjml?: string;
  plain_text?: string;
  from_name?: string;
  reply_to?: string;
  content_blocks?: Array<Record<string, unknown>>;
  source_mode?: Campaign["source_mode"];
  content_schema_version?: number;
  fact_contract?: Record<string, unknown>;
  reusable_section_ids?: string[];
  variants?: Array<Record<string, unknown>>;
  tracking_settings?: Record<string, unknown>;
  delivery_settings?: Record<string, unknown>;
  /** Send to one segment. "" clears it on update. */
  segment_id?: string;
  /**
   * Send to one list (its numeric catalogue id). "" clears it on update. A
   * campaign targets one list or one segment, never both; with neither it
   * sends to every eligible contact in the workspace.
   */
  list_id?: string;
  source_template_id?: string;
  source_template_updated_at?: string;
  reference_template_ids?: string[];
  template_variables?: Record<string, unknown>;
  scheduled_at?: string | null;
}

/**
 * Canonical subject-line A/B draft creation. The endpoint owns the parent,
 * normalized variants, settings, and dispatch children; web must not
 * approximate this with unrelated campaign POSTs.
 */
export interface CreateCampaignABTestInput {
  name: string;
  subject_variants: string[];
  audience_list_id?: string;
  audience_segment_id?: string;
  body_html?: string;
  body_mjml?: string;
  plain_text?: string;
  preview_text?: string;
  from_name?: string;
  reply_to?: string;
  split_percentage?: number;
  tracking_settings?: Record<string, unknown>;
  delivery_settings?: Record<string, unknown>;
  from_name_variants?: string[];
  body_html_variants?: string[];
  send_time_offset_minutes?: number[];
}

export interface CreateCampaignABTestResponse {
  parent: Campaign;
  children: Campaign[];
}

export type UpdateCampaignInput = Partial<CreateCampaignInput> & {
  status?: CampaignStatus;
};

export interface CampaignQueueResponse {
  campaign_id: string;
  content_revision_id?: string;
  assurance_run_id?: string;
  send_plan_id?: string;
  assurance_decision?: "pass" | "warn" | "overridden";
  assurance_rollout_mode?: "warn" | "block";
  assurance_status?:
    | "ok"
    | "warn"
    | "critical"
    | "pending"
    | "stale"
    | "unavailable"
    | "error";
  assurance_reason_code?:
    | "authorized"
    | "authorized_warn"
    | "authorized_override"
    | "not_assured"
    | "run_pending"
    | "run_stale"
    | "evidence_unavailable"
    | "deterministic_block"
    | "integrity_mismatch"
    | "dependency_error";
  recipients_queued: number;
  status: CampaignStatus | "approval_required";
  approval_id?: string;
  approval_status?: string;
  message?: string;
  sandbox?: boolean;
}

const USE_MOCKS = isMockModeEnabled();
const loadMocks = () => import("./campaigns-mocks");
const campaignETags = new Map<string, string>();

/**
 * Strong version captured with the campaign representation currently held by
 * the detail editor. Mutations that require optimistic concurrency may read
 * it, but must never manufacture a replacement at write time.
 */
export function getCampaignETag(id: string): string | null {
  const value = campaignETags.get(id) ?? "";
  return isExactStrongCampaignETag(value) ? value : null;
}

/**
 * Forget a campaign validator after a governed write was attempted.
 *
 * An apply-finding response can be lost after the server commits. Keeping the
 * old token in that ambiguous state would let another repair be offered
 * against content the editor no longer knows it holds. The next GET must pair
 * a fresh representation with its own validator before another write.
 */
export function discardCampaignETag(id: string): void {
  campaignETags.delete(id);
}

/** Exact OpenAPI `CampaignAssuranceStrongETag` validation. */
export function isExactStrongCampaignETag(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (new TextEncoder().encode(value).byteLength > 512) return false;
  return /^"[^,\u0000-\u001f\u007f-\u009f]+"$/.test(value);
}

function captureCampaignETag(id: string, response: Response): void {
  // A 412 means the cached token is DEAD. `api.patch` invokes onResponse before
  // checking `res.ok`, and WritePreconditionFailed carries no ETag, so without
  // this the stale value survived and every retry resent it — the editor could
  // never recover, and the UI has no 412 handling to explain why.
  if (response.status === 412) {
    discardCampaignETag(id);
    return;
  }
  const etag = response.headers.get("ETag");
  if (isExactStrongCampaignETag(etag)) campaignETags.set(id, etag);
  else discardCampaignETag(id);
}

async function withMockFallback<T>(
  realCall: () => Promise<T>,
  fallback: () => T | Promise<T>,
): Promise<T> {
  if (USE_MOCKS) return await fallback();
  return realCall();
}

export function listCampaigns(
  params?: {
    limit?: number;
    page?: number;
    perPage?: number;
    query?: string;
    /** Filter to campaigns built from this template (TMPL-026). */
    sourceTemplateId?: string;
  },
  options?: { signal?: AbortSignal },
): Promise<Campaign[]> {
  return withMockFallback(
    () => {
      const search = new URLSearchParams();
      if (params?.limit) search.set("limit", String(params.limit));
      if (params?.page) search.set("page", String(params.page));
      if (params?.perPage) search.set("per_page", String(params.perPage));
      if (params?.query?.trim()) search.set("query", params.query.trim());
      if (params?.sourceTemplateId) {
        search.set("source_template_id", params.sourceTemplateId);
      }
      const suffix = search.size ? `?${search.toString()}` : "";
      return api.get<Campaign[]>(
        `/api/v1/campaigns${suffix}`,
        options
          ? { ...options, requireOnline: true, maxAttempts: 1 }
          : undefined,
      );
    },
    async () => (await loadMocks()).mockListCampaigns(),
  );
}

export interface CampaignCounts {
  total: number;
  by_status: Record<string, number>;
}

export function countCampaigns(query = ""): Promise<CampaignCounts> {
  return withMockFallback(
    () =>
      api.get<CampaignCounts>(
        `/api/v1/campaigns/count${query.trim() ? `?query=${encodeURIComponent(query.trim())}` : ""}`,
      ),
    async () => (await loadMocks()).mockCountCampaigns(query),
  );
}

export function getCampaign(id: string): Promise<Campaign> {
  return withMockFallback(
    () =>
      api.get<Campaign>(`/api/v1/campaigns/${encodeURIComponent(id)}`, {
        onResponse: (response) => captureCampaignETag(id, response),
      }),
    async () => (await loadMocks()).mockGetCampaign(id),
  );
}

export function createCampaign(
  input: CreateCampaignInput,
  options?: { signal?: AbortSignal },
): Promise<Campaign> {
  return withMockFallback(
    () =>
      api.post<Campaign>("/api/v1/campaigns", input, {
        ...options,
        // One bounded attempt, always. The create carries no server-side
        // idempotency, and the default transport retried a slow or failed
        // POST up to three times at 15 s each — ~47 s of "Creating…" with a
        // chance of a second draft — whenever the caller passed no options,
        // which is exactly how the New campaign dialog called it.
        requireOnline: true,
        maxAttempts: 1,
      }),
    async () => (await loadMocks()).mockCreateCampaign(input),
  );
}

export function createCampaignABTest(
  input: CreateCampaignABTestInput,
): Promise<CreateCampaignABTestResponse> {
  return withMockFallback(
    () =>
      api.post<CreateCampaignABTestResponse>(
        "/api/v1/campaigns/ab-test",
        input,
        // One response binds several newly-created resources. It cannot be
        // replayed safely from the generic offline outbox, and callers need
        // the parent id before they can navigate to the canonical test.
        { requireOnline: true },
      ),
    async () => (await loadMocks()).mockCreateCampaignABTest(input),
  );
}

export function updateCampaign(
  id: string,
  patch: UpdateCampaignInput,
): Promise<Campaign> {
  return withMockFallback(
    () => {
      // WHY THERE IS NO SAVE-TIME FETCH HERE.
      //
      // An earlier version of this function, on finding no cached ETag, issued
      // a GET to obtain one and then sent it as If-Match. That is theatre. The
      // token it minted described the server's CURRENT state — including the
      // concurrent edit it was about to destroy — so the precondition passed by
      // construction and could only ever fail for a write committed inside the
      // GET→PATCH window. An adversarial review demonstrated the loss against a
      // server mock that honours If-Match faithfully: Alice's stale content
      // overwrote Bob's committed edit, with a 200.
      //
      // It was worse than doing nothing, because the surrounding comments and
      // tests then asserted a protection that did not exist.
      //
      // The honest position: a concurrency token is only meaningful if it was
      // captured WITH the content the editor is holding. When the caller has no
      // token, the client cannot manufacture one — and the server accepts the
      // unconditional write by design (campaign updates are `optional` posture;
      // see scripts/check-optimistic-concurrency.mjs, which records that as a
      // decision rather than an oversight). Closing this properly means either
      // capturing per-row tokens where editing starts, or making the server
      // `required` — a deliberate cutover, not a client patch.
      const etag = campaignETags.get(id);
      return api.patch<Campaign>(
        `/api/v1/campaigns/${encodeURIComponent(id)}`,
        patch,
        {
          headers: etag ? { "If-Match": etag } : undefined,
          onResponse: (response) => captureCampaignETag(id, response),
        },
      );
    },
    async () => (await loadMocks()).mockUpdateCampaign(id, patch),
  );
}

/**
 * Delete a campaign.
 *
 * `beforeUnload` is for the one caller that must land a delete the page is
 * about to stop existing for: the list's deferred delete, whose Undo window can
 * be cut short by the tab closing. It asks the browser to keep the request
 * alive past unload and takes a single attempt, because nothing will be around
 * to retry or to read the answer.
 */
export function deleteCampaign(
  id: string,
  opts: { beforeUnload?: boolean } = {},
): Promise<void> {
  return withMockFallback(
    () =>
      api.delete<void>(
        `/api/v1/campaigns/${encodeURIComponent(id)}`,
        opts.beforeUnload ? { keepalive: true, maxAttempts: 1 } : undefined,
      ),
    async () => {
      (await loadMocks()).mockDeleteCampaign(id);
    },
  );
}

export function sendCampaign(
  id: string,
): Promise<Campaign | CampaignQueueResponse> {
  return withMockFallback(
    () =>
      api.post<Campaign | CampaignQueueResponse>(
        `/api/v1/campaigns/${encodeURIComponent(id)}/queue`,
        undefined,
        { requireOnline: true },
      ),
    async () => (await loadMocks()).mockSendCampaign(id),
  );
}

function transitionCampaign(
  id: string,
  action: "pause" | "resume" | "cancel",
): Promise<Campaign> {
  return withMockFallback(
    () =>
      api.post<Campaign>(
        `/api/v1/campaigns/${encodeURIComponent(id)}/${action}`,
        undefined,
        { requireOnline: true },
      ),
    async () => (await loadMocks()).mockTransitionCampaign(id, action),
  );
}

export const pauseCampaign = (id: string) => transitionCampaign(id, "pause");
export const resumeCampaign = (id: string) => transitionCampaign(id, "resume");
export const cancelCampaign = (id: string) => transitionCampaign(id, "cancel");

export interface AudienceCountResult {
  base: number;
  excluded: number;
  deliverable: number;
  kind: "list" | "segment";
}

// Counts the resolved audience for a list or segment so the editor can show
// "N will receive this". Backed by POST /api/v1/audiences/count (apps/api
// campaigns/audience_count.go). Not mock-backed: callers tolerate failure.
export function countAudience(
  input: { segment_id?: string; list_id?: string },
  opts?: { signal?: AbortSignal },
): Promise<AudienceCountResult> {
  return api.post<AudienceCountResult>("/api/v1/audiences/count", input, opts);
}

export function sendCampaignTest(
  id: string,
  toEmail: string,
): Promise<{ message_id: string; to: string; accepted_at: string }> {
  return withMockFallback(
    () =>
      api.post<{ message_id: string; to: string; accepted_at: string }>(
        `/api/v1/campaigns/${encodeURIComponent(id)}/test-send`,
        {
          to_email: toEmail,
        },
      ),
    async () => (await loadMocks()).mockSendCampaignTest(toEmail),
  );
}

/**
 * Id-less content test-send: renders + sends arbitrary content to a single
 * inbox via the same transactional path as campaign test-sends. Powers
 * "send a test" for templates (TMPL-022), sequence emails (SEQ-045), and A/B
 * variants (CAMP-046) — none of which have a campaign id. Subject is required
 * by the endpoint; callers fall back to a name when a draft has none.
 */
export function sendContentTest(input: {
  to_email: string;
  subject: string;
  body_html?: string;
  body_mjml?: string;
  plain_text?: string;
}): Promise<{ message_id: string; to: string; accepted_at: string }> {
  return withMockFallback(
    () =>
      api.post<{ message_id: string; to: string; accepted_at: string }>(
        `/api/v1/campaigns/test-send`,
        input,
      ),
    async () => (await loadMocks()).mockSendCampaignTest(input.to_email),
  );
}

// --- Duplicate / clone (CAMP-006). POST /api/v1/campaigns/{id}/clone returns
// the new draft's id + name; the caller navigates to /app/campaigns/{id}. ---
export interface CloneCampaignResult {
  id: string;
  name: string;
}

export function cloneCampaign(
  id: string,
  name?: string,
): Promise<CloneCampaignResult> {
  return withMockFallback(
    () =>
      api.post<CloneCampaignResult>(
        `/api/v1/campaigns/${encodeURIComponent(id)}/clone`,
        name ? { name } : undefined,
      ),
    async () => (await loadMocks()).mockCloneCampaign(id, name),
  );
}

// --- Send preview / audience confirmation (CAMP-002). GET
// /api/v1/campaigns/{id}/send-preview resolves the exact activation-time
// audience the same way queue-fill does: recipients, deliverable (after
// suppression), the resolved segment label, and warmup tier-cap head-room. ---
export interface SendPreviewResult {
  campaign_id: string;
  audience_kind: "segment" | "list" | "workspace" | string;
  /**
   * The name of the list or segment the campaign sends to. Absent for a
   * whole-workspace audience, or when the name could not be read.
   */
  audience_label?: string;
  /** Older servers name segments only here. */
  segment_label?: string;
  /** True when the send goes to a frozen snapshot of the audience. */
  audience_frozen?: boolean;
  recipients: number;
  suppressed_excluded: number; // -1 sentinel when suppression resolve timed out
  deliverable: number;
  tier_cap_today: number; // -1 = no cap
  tier_cap_remaining: number; // -1 = no cap
  tier_cap_remaining_after: number; // -1 = no cap
  over_cap: boolean;
  counted_at: string;
}

export function getSendPreview(
  id: string,
  opts?: { signal?: AbortSignal },
): Promise<SendPreviewResult> {
  return withMockFallback(
    () =>
      api.get<SendPreviewResult>(
        `/api/v1/campaigns/${encodeURIComponent(id)}/send-preview`,
        opts,
      ),
    async () => (await loadMocks()).mockSendPreview(id),
  );
}

// --- Pre-send checklist (CAMP-011). GET /api/v1/campaigns/{id}/checklist runs
// the from-address / subject / body / list / recipients / unsubscribe gates and
// returns a `ready` flag plus per-check pass/warn/fail rows. ---
export type ChecklistStatus = "pass" | "warn" | "fail";
export interface ChecklistItem {
  key: string;
  label: string;
  status: ChecklistStatus;
  detail: string;
}
export interface CampaignChecklist {
  campaign_id: string;
  ready: boolean;
  checks: ChecklistItem[];
}

export function getCampaignChecklist(
  id: string,
  opts?: { signal?: AbortSignal },
): Promise<CampaignChecklist> {
  return withMockFallback(
    () =>
      api.get<CampaignChecklist>(
        `/api/v1/campaigns/${encodeURIComponent(id)}/checklist`,
        opts,
      ),
    async () => (await loadMocks()).mockCampaignChecklist(id),
  );
}

// --- Save the current campaign as a reusable template (CAMP-038). ---
export interface SaveAsTemplateInput {
  slug: string;
  name?: string;
  description?: string;
  category?: string;
  tags?: string[];
}

export function saveCampaignAsTemplate(
  id: string,
  input: SaveAsTemplateInput,
): Promise<{ id?: string; slug: string }> {
  return withMockFallback(
    () =>
      api.post<{ id?: string; slug: string }>(
        `/api/v1/campaigns/${encodeURIComponent(id)}/save-as-template`,
        input,
      ),
    async () => ({ slug: input.slug }),
  );
}

// --- Resend to non-openers (CAMP-041). ---
export interface ResendUnopenedInput {
  subject: string;
  name?: string;
  send_after_hours?: number;
}

export function resendUnopened(
  id: string,
  input: ResendUnopenedInput,
): Promise<{ campaign_id?: string; status?: string }> {
  return withMockFallback(
    () =>
      api.post<{ campaign_id?: string; status?: string }>(
        `/api/v1/campaigns/${encodeURIComponent(id)}/resend-unopened`,
        input,
        { requireOnline: true },
      ),
    async () => ({ status: "scheduled" }),
  );
}

// --- Smart scheduling (CAMP-010) -----------------------------------------

/** Release-held recurrence adapter. Always rejects before transport. */
export function setCampaignRecurrence(
  _id: string,
  _recurrenceCron: string,
  _recurrenceUntil?: string | null,
): Promise<Campaign> {
  return rejectCampaignScheduling();
}

/** Release-held best-time adapter. Always rejects before transport. */
export function scheduleByBestTime(
  _id: string,
  _input: { within_days?: number; strategy?: string } = {},
): Promise<unknown> {
  return rejectCampaignScheduling();
}

/** Release-held recipient-timezone adapter. Always rejects before transport. */
export function upsertTimezoneSchedule(
  _id: string,
  _input: { local_time: string; date?: string; fallback_tz?: string },
): Promise<unknown> {
  return rejectCampaignScheduling();
}

// --- CSV report export (CAMP-037). Path only; the caller streams it via
// fetchTextAuthed and hands the text to downloadTextFile. ---
export function campaignReportCsvPath(id: string): string {
  return `/api/v1/campaigns/${encodeURIComponent(id)}/report.csv`;
}
