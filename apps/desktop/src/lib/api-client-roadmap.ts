/**
 * Typed roadmap API slices extracted from the core transport module.
 *
 * Keeping these domain wrappers in a separate module makes the transport and
 * authentication boundary reviewable while preserving the public exports from
 * api-client.ts. Each factory receives the configured no-throw request
 * function, so this module has no runtime dependency cycle with api-client.
 */

import type { ApiRequestOpts, ApiResult } from "./api-client";
import {
  responseContractFailure,
  responseIdentityMatches,
  responseIdentityMismatch,
} from "./api/subscriber-response-integrity";

export type RoadmapRequest = <T>(
  path: string,
  init?: RequestInit,
  opts?: ApiRequestOpts,
) => Promise<ApiResult<T>>;

/* ---------- R9 Goals (goals pkg) -------------------------------------- */

export type TenantGoalMetric =
  | "subscribers"
  | "open_rate"
  | "revenue_cents"
  | "list_growth";
export type TenantGoalPeriod = "monthly" | "quarterly";

/** goals.Goal. (Named TenantGoal to avoid clashing with the campaign-
 *  template Goals + sequence goals already in this module.) */
export interface TenantGoal {
  id: string;
  name?: string;
  metric: TenantGoalMetric;
  target: number;
  period: TenantGoalPeriod;
  starts_at: string;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

export interface TenantGoalCreateInput {
  name?: string;
  metric: TenantGoalMetric;
  target: number;
  period?: TenantGoalPeriod;
  starts_at?: string;
}

export interface TenantGoalPatch {
  name?: string;
  target?: number;
  period?: TenantGoalPeriod;
  starts_at?: string;
}

/** One row of GET /goals/progress (goals.ProgressEntry). */
export interface TenantGoalProgress {
  goal: TenantGoal;
  current: number;
  target: number;
  pct: number;
  /** "ahead" | "on_track" | "behind" */
  pace: string;
  period_start: string;
  period_end: string;
  as_of: string;
}

export function createGoalsApi(request: RoadmapRequest) {
  return {
    /** GET /api/v1/goals → `{goals}` (NOT `{items}`). */
    list(): Promise<ApiResult<{ goals: TenantGoal[] }>> {
      return request<{ goals: TenantGoal[] }>("/api/v1/goals");
    },
    /** POST /api/v1/goals — 201 (admin). 400 on bad metric/period. */
    create(input: TenantGoalCreateInput): Promise<ApiResult<TenantGoal>> {
      return request<TenantGoal>("/api/v1/goals", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    /** PATCH /api/v1/goals/{id} (admin). */
    update(id: string, patch: TenantGoalPatch): Promise<ApiResult<TenantGoal>> {
      return request<TenantGoal>(`/api/v1/goals/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
    },
    /** DELETE /api/v1/goals/{id} (admin). */
    remove(id: string): Promise<ApiResult<{ ok: boolean }>> {
      return request<{ ok: boolean }>(
        `/api/v1/goals/${encodeURIComponent(id)}`,
        {
          method: "DELETE",
        },
      );
    },
    /** GET /api/v1/goals/progress → `{progress,as_of}`. */
    progress(): Promise<
      ApiResult<{ progress: TenantGoalProgress[]; as_of: string }>
    > {
      return request<{ progress: TenantGoalProgress[]; as_of: string }>(
        "/api/v1/goals/progress",
      );
    },
  };
}

/* ---------- R10 Audit evidence export schedules ----------------------- */

/** handlers.AuditExportSchedule (audit_export_schedules.go). */
export interface AuditExportSchedule {
  id: string;
  /** "weekly" | "monthly" */
  cadence: "weekly" | "monthly";
  recipients: string[];
  filters?: Record<string, unknown>;
  enabled: boolean;
  created_by_email?: string;
  last_enqueued_at?: string | null;
  created_at: string;
}

export function createAuditExportSchedulesApi(request: RoadmapRequest) {
  return {
    /** GET /api/v1/audit/export-schedules → `{schedules}` (audit:read). */
    list(): Promise<ApiResult<{ schedules: AuditExportSchedule[] }>> {
      return request<{ schedules: AuditExportSchedule[] }>(
        "/api/v1/audit/export-schedules",
      );
    },
    /** POST /api/v1/audit/export-schedules — 201 (audit:configure_sinks). */
    create(input: {
      cadence: "weekly" | "monthly";
      recipients: string[];
      filters?: Record<string, unknown>;
    }): Promise<ApiResult<AuditExportSchedule>> {
      return request<AuditExportSchedule>("/api/v1/audit/export-schedules", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    /** DELETE /api/v1/audit/export-schedules/{id} → `{deleted:true}`
     *  (200, NOT 204; 404 when unknown). */
    remove(id: string): Promise<ApiResult<{ deleted: boolean }>> {
      return request<{ deleted: boolean }>(
        `/api/v1/audit/export-schedules/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
    },
  };
}

/* ---------- R12 Referrals leaderboard (referrals/leaderboard.go) ----- */

/** Emails arrive pre-masked (a***@domain) — operator overview, not PII. */
export interface ReferralLeaderboardItem {
  referrer_email_masked: string;
  conversions: number;
  milestone: number;
  rank: number;
}

export interface ReferralLeaderboardResponse {
  window_days: number;
  items: ReferralLeaderboardItem[];
}

export function createReferralsLeaderboardApi(request: RoadmapRequest) {
  return {
    /** GET /api/v1/referrals/leaderboard?window=90d&limit=20 — window is
     *  a day-count string ("30d"/"90"); invalid values fall back to 90. */
    get(
      opts: { window?: string; limit?: number } = {},
    ): Promise<ApiResult<ReferralLeaderboardResponse>> {
      const params = new URLSearchParams();
      if (opts.window) params.set("window", opts.window);
      if (opts.limit != null) params.set("limit", String(opts.limit));
      const qs = params.toString();
      return request<ReferralLeaderboardResponse>(
        `/api/v1/referrals/leaderboard${qs ? `?${qs}` : ""}`,
      );
    },
  };
}

/* ---------- R13 Win-back settings (retention_offers/winback.go) ------ */

export interface WinbackSettings {
  enabled: boolean;
  /** Churn-risk enrolment threshold ∈ (0, 1]. */
  churn_threshold: number;
  /** READ-ONLY: profile_predictions rows for the tenant. 0 → the
   *  predictive model hasn't run; render the data-gap explainer. */
  churn_profiles_scored: number;
}

export function createWinbackSettingsApi(request: RoadmapRequest) {
  return {
    /** GET /api/v1/retention-offers/winback-settings. */
    get(): Promise<ApiResult<WinbackSettings>> {
      return request<WinbackSettings>(
        "/api/v1/retention-offers/winback-settings",
      );
    },
    /** PUT /api/v1/retention-offers/winback-settings `{enabled,
     *  churn_threshold}` — threshold 0 means "use the default"; out-of-
     *  range values are a 400. Returns the persisted settings. */
    put(input: {
      enabled: boolean;
      churn_threshold: number;
    }): Promise<ApiResult<WinbackSettings>> {
      return request<WinbackSettings>(
        "/api/v1/retention-offers/winback-settings",
        { method: "PUT", body: JSON.stringify(input) },
      );
    },
  };
}

/* ---------- R14 Merge apply (merge/apply.go) -------------------------- */

/** The computed merge outcome — returned by dry_run and executed
 *  verbatim by a real apply. */

export interface MergePlan {
  tags: string[];
  custom_fields: Record<string, unknown>;
  status: string;
  consent_timestamp?: string | null;
  gdpr_permissions: Record<string, unknown>[];
  conflicts: {
    field: string;
    primary_value: unknown;
    duplicate_value: unknown;
    resolution: "primary_wins" | "most_restrictive_wins" | string;
  }[];
  preserved_on_duplicate: string[];
}

export interface MergeApplyResponse {
  primary_id: string;
  duplicate_id: string;
  dry_run: boolean;
  plan: MergePlan;
  events_moved: number;
  suppressions_moved: number;
  loser_soft_deleted: boolean;
  primary_updated_at: string;
  duplicate_updated_at: string;
  plan_fingerprint: string;
}

function validReviewedMergePlan(plan: MergePlan): boolean {
  return (
    Array.isArray(plan?.tags) &&
    plan.tags.every((tag) => typeof tag === "string" && tag.trim() !== "") &&
    new Set(plan.tags).size === plan.tags.length &&
    typeof plan.custom_fields === "object" &&
    plan.custom_fields !== null &&
    !Array.isArray(plan.custom_fields) &&
    typeof plan.status === "string" &&
    plan.status.trim() !== "" &&
    (plan.consent_timestamp == null ||
      Number.isFinite(Date.parse(plan.consent_timestamp))) &&
    Array.isArray(plan.gdpr_permissions) &&
    plan.gdpr_permissions.every(
      (permission) =>
        typeof permission === "object" &&
        permission !== null &&
        !Array.isArray(permission),
    ) &&
    Array.isArray(plan.conflicts) &&
    plan.conflicts.every(
      (conflict) =>
        typeof conflict?.field === "string" &&
        conflict.field.trim() !== "" &&
        typeof conflict.resolution === "string" &&
        conflict.resolution.trim() !== "",
    ) &&
    Array.isArray(plan.preserved_on_duplicate) &&
    plan.preserved_on_duplicate.every(
      (item) => typeof item === "string" && item.trim() !== "",
    )
  );
}

function sameReviewedInstant(expected: string, actual: string): boolean {
  const expectedTime = Date.parse(expected);
  const actualTime = Date.parse(actual);
  return (
    Number.isFinite(expectedTime) &&
    Number.isFinite(actualTime) &&
    expectedTime === actualTime
  );
}

export function createMergeApplyApi(request: RoadmapRequest) {
  return {
    /** Scan/version-bound POST /api/v1/merge/apply. dry_run:true returns an
     *  exact fingerprinted plan; a real apply must replay that fingerprint.
     *  409 covers stale review/candidate state and already-merged losers. */
    apply(
      input: {
        primary_id: string;
        duplicate_id: string;
        scan_id: string;
        expected_primary_updated_at: string;
        expected_duplicate_updated_at: string;
        expected_plan_fingerprint?: string;
        dry_run?: boolean;
      },
      opts?: { signal?: AbortSignal },
    ): Promise<ApiResult<MergeApplyResponse>> {
      return request<MergeApplyResponse>(
        "/api/v1/merge/apply",
        { method: "POST", body: JSON.stringify(input) },
        { requireOnline: true, signal: opts?.signal },
      ).then((response) => {
        if (response.error) return response;
        if (
          !responseIdentityMatches(
            input.primary_id,
            response.data.primary_id,
          ) ||
          !responseIdentityMatches(
            input.duplicate_id,
            response.data.duplicate_id,
          )
        ) {
          return responseIdentityMismatch("subscriber");
        }
        const dryRun = input.dry_run === true;
        if (
          response.data.dry_run !== dryRun ||
          !sameReviewedInstant(
            input.expected_primary_updated_at,
            response.data.primary_updated_at,
          ) ||
          !sameReviewedInstant(
            input.expected_duplicate_updated_at,
            response.data.duplicate_updated_at,
          ) ||
          !/^sha256:[0-9a-f]{64}$/u.test(response.data.plan_fingerprint) ||
          (!dryRun &&
            response.data.plan_fingerprint !==
              input.expected_plan_fingerprint) ||
          response.data.loser_soft_deleted !== !dryRun ||
          !Number.isSafeInteger(response.data.events_moved) ||
          response.data.events_moved < 0 ||
          !Number.isSafeInteger(response.data.suppressions_moved) ||
          response.data.suppressions_moved < 0 ||
          (dryRun &&
            (response.data.events_moved !== 0 ||
              response.data.suppressions_moved !== 0)) ||
          !validReviewedMergePlan(response.data.plan)
        ) {
          return responseContractFailure(
            dryRun
              ? "The merge service returned an incomplete reviewed plan. Nothing was applied; refresh the duplicate scan."
              : "The merge service returned an incomplete apply result. Refresh subscribers and verify both rows before retrying.",
          );
        }
        return response;
      });
    },
  };
}

/* ====================================================================
 * Task-2 packages (previous audit gaps). Verdicts:
 *   form_variants  — MOUNTED (main.go:2017)  → wrappers below
 *   landingpages   — MOUNTED (main.go:2170+) → wrappers below
 *   social_capture — MOUNTED (main.go:2267)  → wrappers below
 *   socialads      — NO HTTP SURFACE (provider-client registry consumed
 *                    by mailchimpv3 facade) → documented UNMOUNTED in
 *                    ROADMAP-WRAPPERS.md, no wrapper.
 * ================================================================== */

/* ---------- T1 Form display variants (form_variants) ----------------- */

/**
 * form_variants.Variant — NOTE this package alone is camelCase on the
 * wire (formId, displayConfig, trafficPct, …); every other surface in
 * this module is snake_case. conversionRate is 0..1.
 */

export interface FormVariant {
  id: string;
  tenantId: string;
  formId: string;
  label: string;
  displayConfig: Record<string, unknown>;
  trafficPct: number;
  /** "active" | "paused" | "promoted" (render, don't switch). */
  status: string;
  promotedAt?: string | null;
  lastZScore: number;
  impressions: number;
  submissions: number;
  conversionRate: number;
  createdAt: string;
  updatedAt: string;
}

export interface FormVariantCreateInput {
  label: string;
  displayConfig: Record<string, unknown>;
  trafficPct?: number;
}

export interface FormVariantPatch {
  label?: string;
  displayConfig?: Record<string, unknown>;
  trafficPct?: number;
  status?: string;
}

/** form_variants.Promotion — one auto-promotion decision record. */
export interface FormVariantPromotion {
  id: string;
  formId: string;
  winnerVariantId: string;
  winnerRate: number;
  runnerUpRate: number;
  zScore: number;
  winnerImpressions: number;
  runnerUpImpressions: number;
  decidedAt: string;
}

/** Bandit re-weight outcome (form_variants.Decision). */
export interface FormVariantEvaluateResponse {
  decision: {
    weights: Record<string, number>;
    [k: string]: unknown;
  };
  samples: Array<Record<string, unknown>>;
}

export function createFormVariantsApi(request: RoadmapRequest) {
  return {
    /** GET /api/v1/forms/{id}/variants — BARE ARRAY. */
    list(formId: string): Promise<ApiResult<FormVariant[]>> {
      return request<FormVariant[]>(
        `/api/v1/forms/${encodeURIComponent(formId)}/variants`,
      );
    },
    /** POST /api/v1/forms/{id}/variants — 201. */
    create(
      formId: string,
      input: FormVariantCreateInput,
    ): Promise<ApiResult<FormVariant>> {
      return request<FormVariant>(
        `/api/v1/forms/${encodeURIComponent(formId)}/variants`,
        { method: "POST", body: JSON.stringify(input) },
      );
    },
    /** PATCH /api/v1/forms/{id}/variants/{variantId}. */
    update(
      formId: string,
      variantId: string,
      patch: FormVariantPatch,
    ): Promise<ApiResult<FormVariant>> {
      return request<FormVariant>(
        `/api/v1/forms/${encodeURIComponent(formId)}/variants/${encodeURIComponent(variantId)}`,
        { method: "PATCH", body: JSON.stringify(patch) },
      );
    },
    /** DELETE /api/v1/forms/{id}/variants/{variantId} → `{ok:true}`. */
    remove(
      formId: string,
      variantId: string,
    ): Promise<ApiResult<{ ok: boolean }>> {
      return request<{ ok: boolean }>(
        `/api/v1/forms/${encodeURIComponent(formId)}/variants/${encodeURIComponent(variantId)}`,
        { method: "DELETE" },
      );
    },
    /** GET /api/v1/forms/{id}/variants/promotions — BARE ARRAY. */
    listPromotions(formId: string): Promise<ApiResult<FormVariantPromotion[]>> {
      return request<FormVariantPromotion[]>(
        `/api/v1/forms/${encodeURIComponent(formId)}/variants/promotions`,
      );
    },
    /** POST /api/v1/forms/{id}/variants/evaluate — manual bandit pass →
     *  `{decision,samples}`. Idempotent given identical counters. */
    evaluate(formId: string): Promise<ApiResult<FormVariantEvaluateResponse>> {
      return request<FormVariantEvaluateResponse>(
        `/api/v1/forms/${encodeURIComponent(formId)}/variants/evaluate`,
        { method: "POST", body: "{}" },
      );
    },
  };
}

/* ---------- T2 Landing pages (landingpages) -------------------------- */

/** landingpages.LandingPage — blocks/seo/tracking/metrics are
 *  free-form jsonb (never null on the wire; empty `{}`/`[]`). */

export interface LandingPage {
  id: string;
  tenant_id: string;
  slug: string;
  name: string;
  /** "draft" | "published" | "archived" (render, don't switch). */
  status: string;
  domain?: string;
  template: string;
  blocks: Array<Record<string, unknown>>;
  seo: Record<string, unknown>;
  tracking: Record<string, unknown>;
  metrics: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface LandingPageCreateInput {
  slug: string;
  name: string;
  domain?: string;
  template?: string;
  blocks?: Array<Record<string, unknown>>;
  seo?: Record<string, unknown>;
  tracking?: Record<string, unknown>;
}

export interface LandingPagePatch {
  name?: string;
  status?: string;
  domain?: string;
  template?: string;
  blocks?: Array<Record<string, unknown>>;
  seo?: Record<string, unknown>;
  tracking?: Record<string, unknown>;
}

export function createLandingPagesApi(request: RoadmapRequest) {
  return {
    /** GET /api/v1/landing-pages — BARE ARRAY (read:campaigns). Public
     *  render lives in apps/web at /landing/[slug], not here. */
    list(): Promise<ApiResult<LandingPage[]>> {
      return request<LandingPage[]>("/api/v1/landing-pages");
    },
    /** GET /api/v1/landing-pages/{id}. */
    get(id: string): Promise<ApiResult<LandingPage>> {
      return request<LandingPage>(
        `/api/v1/landing-pages/${encodeURIComponent(id)}`,
      );
    },
    /** POST /api/v1/landing-pages — 201 (admin). */
    create(input: LandingPageCreateInput): Promise<ApiResult<LandingPage>> {
      return request<LandingPage>("/api/v1/landing-pages", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    /** PATCH /api/v1/landing-pages/{id} (admin). */
    update(
      id: string,
      patch: LandingPagePatch,
    ): Promise<ApiResult<LandingPage>> {
      return request<LandingPage>(
        `/api/v1/landing-pages/${encodeURIComponent(id)}`,
        { method: "PATCH", body: JSON.stringify(patch) },
      );
    },
    /** DELETE /api/v1/landing-pages/{id} (admin). */
    remove(id: string): Promise<ApiResult<{ ok: boolean }>> {
      return request<{ ok: boolean }>(
        `/api/v1/landing-pages/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
    },
  };
}

/* ---------- T3 Social capture (social_capture) ------------------------ */

/** social_capture.AutoReplyRule. */

export interface SocialCaptureRule {
  id?: string;
  tenant_id?: string;
  name: string;
  network: string;
  status: string;
  trigger_phrases: string[];
  questions?: Array<{ key: string; label: string; required: boolean }>;
  property_mappings?: Record<string, unknown>;
  target_list_id?: string;
  target_segment_id?: string;
  sms_list_id?: string;
  sender_profile_id?: string;
  reply_template?: string;
  consent_handoff?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

/** social_capture.Lead. */
export interface SocialCaptureLead {
  id?: string;
  tenant_id?: string;
  rule_id?: string;
  network: string;
  external_user_id?: string;
  external_thread_id?: string;
  subscriber_email?: string;
  phone_e164?: string;
  answers?: Record<string, unknown>;
  mapped_properties?: Record<string, unknown>;
  status: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
}

/** social_capture.TapToTextLink. */
export interface SocialCaptureTapLink {
  id?: string;
  tenant_id?: string;
  slug?: string;
  name: string;
  status: string;
  sms_list_id?: string;
  sender_profile_id?: string;
  destination_phone: string;
  keyword: string;
  message_body: string;
  consent_text?: string;
  success_url?: string;
  proof_metadata?: Record<string, unknown>;
  stats?: Record<string, unknown>;
  sms_uri?: string;
  public_url?: string;
  created_at?: string;
}

export function createSocialCaptureApi(request: RoadmapRequest) {
  return {
    /** GET /api/v1/social-capture/catalog — networks + capability matrix
     *  (loosely typed: server returns a nested literal map). */
    catalog(): Promise<ApiResult<Record<string, unknown>>> {
      return request<Record<string, unknown>>("/api/v1/social-capture/catalog");
    },
    /** POST /api/v1/social-capture/validate — dry-run rule validation
     *  (admin). 200 with the validation verdict body either way. */
    validateRule(
      rule: SocialCaptureRule,
    ): Promise<ApiResult<Record<string, unknown>>> {
      return request<Record<string, unknown>>(
        "/api/v1/social-capture/validate",
        {
          method: "POST",
          body: JSON.stringify(rule),
        },
      );
    },
    /** GET /api/v1/social-capture/auto-replies[?status=] → `{items}`. */
    listRules(
      opts: { status?: string } = {},
    ): Promise<ApiResult<{ items: SocialCaptureRule[] }>> {
      const qs = opts.status
        ? `?status=${encodeURIComponent(opts.status)}`
        : "";
      return request<{ items: SocialCaptureRule[] }>(
        `/api/v1/social-capture/auto-replies${qs}`,
      );
    },
    /** POST /api/v1/social-capture/auto-replies — 201 (admin); 400 with
     *  the validation verdict when the rule is invalid. */
    createRule(rule: SocialCaptureRule): Promise<ApiResult<SocialCaptureRule>> {
      return request<SocialCaptureRule>("/api/v1/social-capture/auto-replies", {
        method: "POST",
        body: JSON.stringify(rule),
      });
    },
    /** GET /api/v1/social-capture/auto-replies/{id}. */
    getRule(id: string): Promise<ApiResult<SocialCaptureRule>> {
      return request<SocialCaptureRule>(
        `/api/v1/social-capture/auto-replies/${encodeURIComponent(id)}`,
      );
    },
    /** GET /api/v1/social-capture/leads[?rule_id=] → `{items}`. */
    listLeads(
      opts: { ruleId?: string } = {},
    ): Promise<ApiResult<{ items: SocialCaptureLead[] }>> {
      const qs = opts.ruleId
        ? `?rule_id=${encodeURIComponent(opts.ruleId)}`
        : "";
      return request<{ items: SocialCaptureLead[] }>(
        `/api/v1/social-capture/leads${qs}`,
      );
    },
    /** GET /api/v1/social-capture/tap-to-text[?status=] → `{items}`. */
    listTapLinks(
      opts: { status?: string } = {},
    ): Promise<ApiResult<{ items: SocialCaptureTapLink[] }>> {
      const qs = opts.status
        ? `?status=${encodeURIComponent(opts.status)}`
        : "";
      return request<{ items: SocialCaptureTapLink[] }>(
        `/api/v1/social-capture/tap-to-text${qs}`,
      );
    },
    /** POST /api/v1/social-capture/tap-to-text — 201 (admin); response
     *  carries the minted slug + sms_uri + public_url. */
    createTapLink(
      link: SocialCaptureTapLink,
    ): Promise<ApiResult<SocialCaptureTapLink>> {
      return request<SocialCaptureTapLink>(
        "/api/v1/social-capture/tap-to-text",
        {
          method: "POST",
          body: JSON.stringify(link),
        },
      );
    },
    /** GET /api/v1/social-capture/tap-to-text/{id}. */
    getTapLink(id: string): Promise<ApiResult<SocialCaptureTapLink>> {
      return request<SocialCaptureTapLink>(
        `/api/v1/social-capture/tap-to-text/${encodeURIComponent(id)}`,
      );
    },
  };
}

/* ---------- end roadmap build-tier wrappers (2026-06) ---------------- */

/* ====================================================================
 * Subscribers ai-intelligence batch (group 5) — SUB-067 / SUB-068 /
 * SUB-070. Thin wrappers over the just-shipped backend surfaces in
 * apps/api/internal/subscribers/{presend_refine,lookalike,
 * decision_explanations}.go.
 * ==================================================================== */

/* ---------- SUB-067 — Pre-send Audience Refine / Optimization ------- */

/** One churn-risk-suppressed subscriber in the presend-refine preview
 *  sample. Mirrors subscribers.PreSendExcludedSubscriber. */
export interface PreSendExcludedSubscriber {
  subscriber_id: string;
  email: string;
  /** Cached churn_score, 0..100. */
  churn_score: number;
  /** Exclusion reason; "churn_risk" today. */
  reason: string;
}

/** POST/GET /api/v1/campaigns/{id}/presend-refine response. Mirrors
 *  subscribers.PreSendRefineResult. */
export interface PreSendRefineResult {
  campaign_id: string;
  /** churn_score (0..100) at/above which a subscriber is excluded. */
  churn_threshold: number;
  /** Cooling-off re-entry window in hours (default 24). */
  cooling_off_hours?: number;
  /** Total subscribers the gate would suppress from this send. */
  excluded_count: number;
  /** Of those, how many carry a cooling-off expiry. */
  cooling_off_count: number;
  /** ISO instant the latest exclusion auto-expires (re-entry). */
  cooling_off_until?: string;
  /** True when the result is a non-persisting preview. */
  dry_run: boolean;
  /** Whether subscribers already cooling-off under another campaign
   *  were additionally excluded. */
  exclude_recently_paused: boolean;
  /** Bounded sample (≤25) of the highest-risk excluded subscribers. */
  affected_subscribers_sample: PreSendExcludedSubscriber[];
}

/** POST /api/v1/campaigns/{id}/presend-refine body. All fields
 *  optional; zero values use the backend defaults (threshold 80,
 *  cooling-off 24h). */
export interface PreSendRefineInput {
  churn_threshold?: number;
  cooling_off_hours?: number;
  exclude_recently_paused?: boolean;
  /** Preview the counts + sample WITHOUT persisting exclusion rows. */
  dry_run?: boolean;
}

export function createPresendRefineApi(request: RoadmapRequest) {
  return {
    /**
     * POST /api/v1/campaigns/{id}/presend-refine — preview-and-commit
     * gate. Pass `{dry_run: true}` (the default here) to preview counts +
     * the highest-risk sample without writing exclusion rows. Drop
     * `dry_run` to commit the exclusion set for the send path. Write
     * scope on the server. requireOnline so a commit never replays
     * silently on reconnect.
     */
    preview(
      campaignId: string | number,
      input: PreSendRefineInput = {},
    ): Promise<ApiResult<PreSendRefineResult>> {
      const body: PreSendRefineInput = { dry_run: true, ...input };
      return request<PreSendRefineResult>(
        `/api/v1/campaigns/${encodeURIComponent(String(campaignId))}/presend-refine`,
        { method: "POST", body: JSON.stringify(body) },
        { requireOnline: true },
      );
    },
    /** GET /api/v1/campaigns/{id}/presend-refine — the currently-active
     *  exclusion set for a campaign. Read scope. */
    get(campaignId: string | number): Promise<ApiResult<PreSendRefineResult>> {
      return request<PreSendRefineResult>(
        `/api/v1/campaigns/${encodeURIComponent(String(campaignId))}/presend-refine`,
      );
    },
    /** DELETE /api/v1/campaigns/{id}/presend-refine — clear all
     *  exclusions (force re-entry). Returns `{cleared}`. Write scope. */
    clear(
      campaignId: string | number,
    ): Promise<ApiResult<{ cleared: number }>> {
      return request<{ cleared: number }>(
        `/api/v1/campaigns/${encodeURIComponent(String(campaignId))}/presend-refine`,
        { method: "DELETE" },
        { requireOnline: true },
      );
    },
  };
}
