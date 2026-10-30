import type { ApiErr, ApiResult } from "./result";

export interface CampaignAuthoringRequestOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  requireOnline?: boolean;
  signal?: AbortSignal;
}

export type CampaignAuthoringRequester = <T>(
  path: string,
  init?: RequestInit,
  opts?: CampaignAuthoringRequestOptions,
) => Promise<ApiResult<T>>;

export interface CampaignAuthoringDependencies {
  apiUrl: (path: string) => string;
  errorFromResponse: (response: Response) => Promise<ApiErr["error"]>;
  getApiKey: () => string | null;
  llmRequestOptions: CampaignAuthoringRequestOptions;
  nativeFetch: (input: string, init?: RequestInit) => Promise<Response>;
  normalizeApiKey: (key: string | null | undefined) => string | null;
  transportError: (error: unknown) => ApiErr["error"];
}

/* =====================================================================
 * Full-surface wiring (feat/full-surface-wiring) — typed wrappers for
 * the 2026-06-11 coverage backlog (WIRING-COVERAGE-2026-06-11.md).
 * Shapes verified against the Go handlers in apps/api/internal/<pkg>
 * (and services/deliverability for the proxied routes). The manifest
 * UI agents code against is apps/desktop/WIRING-WRAPPERS.md.
 * =================================================================== */

/* ---------- #1 Block editor (email_blocks) ------------------------- */

/** One editor input in a block's config schema (email_blocks.FieldSpec). */
export interface EmailBlockFieldSpec {
  key: string;
  label: string;
  /** text | textarea | image_url | color | url | number | select | bool */
  type: string;
  options?: string[];
  help?: string;
}

/** One catalog entry (email_blocks.Block). */
export interface EmailBlock {
  id: string;
  name: string;
  category: string;
  description: string;
  fields: EmailBlockFieldSpec[];
  defaults: Record<string, unknown>;
}

/** Tenant brand settings surfaced once in the editor panel. */
export interface EmailBlockBrandDefaults {
  primary_color: string;
  body_font: string;
  heading_font: string;
  background_color: string;
}

export interface EmailBlockCatalogResponse {
  brand: EmailBlockBrandDefaults;
  blocks: EmailBlock[];
}

/** One node on the drag-drop canvas (email_blocks.BlockInstance). */
export interface EmailBlockInstance {
  block_id: string;
  config: Record<string, unknown>;
}

export interface EmailBlockComposeInput {
  brand: EmailBlockBrandDefaults;
  blocks: EmailBlockInstance[];
  /** Lets send-time compose resolve behavioral commerce feeds. */
  subscriber_email?: string;
  subject?: string;
}

export interface EmailBlockComposeResponse {
  mjml: string;
  warnings?: string[];
}

export function createEmailBlocksApi(request: CampaignAuthoringRequester) {
  const emailBlocksApi = {
    /** GET /api/v1/email-blocks/catalog (read_reports). */
    catalog(): Promise<ApiResult<EmailBlockCatalogResponse>> {
      return request<EmailBlockCatalogResponse>("/api/v1/email-blocks/catalog");
    },
    /** POST /api/v1/email-blocks/compose (write_campaigns) — pure MJML emit. */
    compose(
      input: EmailBlockComposeInput,
    ): Promise<ApiResult<EmailBlockComposeResponse>> {
      return request<EmailBlockComposeResponse>(
        "/api/v1/email-blocks/compose",
        {
          method: "POST",
          body: JSON.stringify(input),
        },
      );
    },
  };

  return emailBlocksApi;
}

/* ---------- #2 Send-window policy (send_window) -------------------- */

export interface SendWindowPolicy {
  start_local: string;
  end_local: string;
  timezone: string;
  weekday_bitmap: number;
  weekdays: string[];
  /** 'warn' | 'block' (server-defined enum). */
  enforcement: string;
  created_at: string;
  updated_at: string;
}

export interface SendWindowUpsertInput {
  start_local: string;
  end_local: string;
  timezone: string;
  weekday_bitmap?: number;
  enforcement: string;
}

export interface SendWindowVerdict {
  inside_window: boolean;
  enforcement: string;
  /** 'allow' | 'warn' | 'block' */
  should: string;
  reason?: string;
}

export function createSendWindowApi(request: CampaignAuthoringRequester) {
  const sendWindowApi = {
    /** GET /api/v1/send-window — `{policy: null}` when unset. */
    get(): Promise<ApiResult<{ policy: SendWindowPolicy | null }>> {
      return request<{ policy: SendWindowPolicy | null }>(
        "/api/v1/send-window",
      );
    },
    /** PUT /api/v1/send-window (admin) — returns the stored policy. */
    upsert(input: SendWindowUpsertInput): Promise<ApiResult<SendWindowPolicy>> {
      return request<SendWindowPolicy>("/api/v1/send-window", {
        method: "PUT",
        body: JSON.stringify(input),
      });
    },
    /** POST /api/v1/send-window/check — verdict for a candidate time. */
    check(scheduledAt: string): Promise<ApiResult<SendWindowVerdict>> {
      return request<SendWindowVerdict>("/api/v1/send-window/check", {
        method: "POST",
        body: JSON.stringify({ scheduled_at: scheduledAt }),
      });
    },
    /** DELETE /api/v1/send-window (admin). */
    remove(): Promise<ApiResult<void>> {
      return request<void>("/api/v1/send-window", { method: "DELETE" });
    },
  };

  return sendWindowApi;
}

/* ---------- #3 Accessibility check (a11y) --------------------------- */

export interface A11yFinding {
  rule: string;
  severity: "info" | "warn" | "error" | string;
  message: string;
  snippet?: string;
  /** WCAG criterion, e.g. "1.1.1". */
  wcag?: string;
}

export interface A11yReport {
  findings: A11yFinding[];
  counts: { info: number; warn: number; error: number };
  /** 0..100; 100 = no findings. */
  score: number;
}

export function createA11yApi(request: CampaignAuthoringRequester) {
  const a11yApi = {
    /** POST /api/v1/a11y/check — static HTML checks; safe per-keystroke. */
    check(input: {
      html: string;
      subject?: string;
    }): Promise<ApiResult<A11yReport>> {
      return request<A11yReport>("/api/v1/a11y/check", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
  };

  return a11yApi;
}

/* ---------- #4 AI translations (translations) ----------------------- */

export interface TranslationSettings {
  tenant_id: string;
  enabled: boolean;
  default_locale: string;
  supported_locales: string[];
  fallback_strategy: string;
  locale_attribute: string;
  updated_at: string;
}

export interface TranslationSettingsInput {
  enabled?: boolean;
  default_locale?: string;
  supported_locales?: string[];
  fallback_strategy?: string;
  locale_attribute?: string;
}

export interface TranslationDictionaryEntry {
  id: string;
  term: string;
  /** locale → translated term. */
  translations: Record<string, string>;
  case_sensitive: boolean;
  notes?: string;
  updated_at: string;
}

export interface TranslationDictionaryEntryInput {
  term: string;
  translations: Record<string, string>;
  case_sensitive?: boolean;
  notes?: string;
}

export interface TranslationImportResult {
  imported: number;
  skipped: number;
  errors?: string[];
}

export interface TranslationRenderResult {
  body: string;
  locale: string;
  cache_hit: boolean;
  dictionary_matches: number;
  /** True when translations are disabled or locale == default locale. */
  skipped: boolean;
}

export function createTranslationsApi(
  request: CampaignAuthoringRequester,
  dependencies: CampaignAuthoringDependencies,
) {
  const translationsApi = {
    /** GET /api/v1/translations/settings. */
    getSettings(): Promise<ApiResult<TranslationSettings>> {
      return request<TranslationSettings>("/api/v1/translations/settings");
    },
    /** PUT /api/v1/translations/settings — partial update via pointers. */
    putSettings(
      input: TranslationSettingsInput,
    ): Promise<ApiResult<TranslationSettings>> {
      return request<TranslationSettings>("/api/v1/translations/settings", {
        method: "PUT",
        body: JSON.stringify(input),
      });
    },
    /** GET /api/v1/translations/dictionary → `{entries}`. */
    listDictionary(): Promise<
      ApiResult<{ entries: TranslationDictionaryEntry[] }>
    > {
      return request<{ entries: TranslationDictionaryEntry[] }>(
        "/api/v1/translations/dictionary",
      );
    },
    /** POST /api/v1/translations/dictionary — upsert keyed by term. */
    upsertDictionaryEntry(
      input: TranslationDictionaryEntryInput,
    ): Promise<ApiResult<TranslationDictionaryEntry>> {
      return request<TranslationDictionaryEntry>(
        "/api/v1/translations/dictionary",
        { method: "POST", body: JSON.stringify(input) },
      );
    },
    /** DELETE /api/v1/translations/dictionary/{id}. */
    deleteDictionaryEntry(id: string): Promise<ApiResult<void>> {
      return request<void>(
        `/api/v1/translations/dictionary/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
    },
    /**
     * POST /api/v1/translations/dictionary/import — raw text/csv body
     * (the handler also accepts multipart field `file`; raw is simpler).
     */
    importDictionaryCSV(
      csv: string,
    ): Promise<ApiResult<TranslationImportResult>> {
      return request<TranslationImportResult>(
        "/api/v1/translations/dictionary/import",
        {
          method: "POST",
          body: csv,
          headers: { "Content-Type": "text/csv" },
        },
      );
    },
    /**
     * GET /api/v1/translations/dictionary/export.csv — returns the raw
     * CSV blob (non-JSON response, so this bypasses the JSON core).
     */
    async exportDictionaryCSV(): Promise<
      ApiResult<{ blob: Blob; filename: string }>
    > {
      try {
        const headers: Record<string, string> = { Accept: "text/csv" };
        const key = dependencies.normalizeApiKey(dependencies.getApiKey());
        if (key) headers.Authorization = `Bearer ${key}`;
        const res = await dependencies.nativeFetch(
          dependencies.apiUrl("/api/v1/translations/dictionary/export.csv"),
          {
            method: "GET",
            headers,
            mode: "cors",
            credentials: "include",
            cache: "no-store",
          },
        );
        if (!res.ok) {
          return { error: await dependencies.errorFromResponse(res) };
        }
        const cd = res.headers.get("Content-Disposition") ?? "";
        const m = /filename="([^"]+)"/.exec(cd);
        const filename = m?.[1] ?? "translations-dictionary.csv";
        const blob = await res.blob();
        return { data: { blob, filename } };
      } catch (err) {
        return { error: dependencies.transportError(err) };
      }
    },
    /**
     * POST /api/v1/translations/preview — renders a body in a target
     * locale. LLM-backed on cache miss (AI gateway translate), so it
     * carries LLM_REQUEST_OPTS (60s, single attempt).
     */
    preview(input: {
      body: string;
      locale: string;
    }): Promise<ApiResult<TranslationRenderResult>> {
      return request<TranslationRenderResult>(
        "/api/v1/translations/preview",
        { method: "POST", body: JSON.stringify(input) },
        dependencies.llmRequestOptions,
      );
    },
  };

  return translationsApi;
}

/* ---------- #5 From-name picker (from_name_picker) ------------------ */

export interface FromNameRow {
  from_name: string;
  campaigns_using: number;
  total_recipients: number;
  opens: number;
  clicks: number;
  complaints: number;
  open_rate: number;
  click_rate: number;
  complaint_rate: number;
  /** 0..1 — saturates ~10 campaigns / 100k recipients. */
  confidence: number;
  rank: number;
}

export interface FromNamePickerResponse {
  window_days: number;
  min_campaigns: number;
  from_names: FromNameRow[];
  count: number;
}

export function createFromNamePickerApi(request: CampaignAuthoringRequester) {
  const fromNamePickerApi = {
    /** GET /api/v1/from-name-picker?days=&min_campaigns=. */
    list(
      opts: { days?: number; minCampaigns?: number } = {},
    ): Promise<ApiResult<FromNamePickerResponse>> {
      const params = new URLSearchParams();
      if (opts.days != null) params.set("days", String(opts.days));
      if (opts.minCampaigns != null) {
        params.set("min_campaigns", String(opts.minCampaigns));
      }
      const qs = params.toString();
      return request<FromNamePickerResponse>(
        `/api/v1/from-name-picker${qs ? `?${qs}` : ""}`,
      );
    },
  };

  return fromNamePickerApi;
}

/* ---------- #6 Link checker (link_checker) -------------------------- */

export interface LinkCheckResult {
  url: string;
  status: number;
  ok: boolean;
  error?: string;
}

export function createLinkCheckerApi(request: CampaignAuthoringRequester) {
  const linkCheckerApi = {
    /**
     * POST /api/v1/campaigns/{id}/check-links — HEAD-sweeps every URL in
     * the campaign body. Returns a BARE ARRAY of per-link verdicts.
     * Network-bound on the server side, so we allow a longer timeout.
     */
    check(campaignId: string | number): Promise<ApiResult<LinkCheckResult[]>> {
      return request<LinkCheckResult[]>(
        `/api/v1/campaigns/${encodeURIComponent(String(campaignId))}/check-links`,
        { method: "POST", body: JSON.stringify({}) },
        { timeoutMs: 30_000, maxAttempts: 1 },
      );
    },
  };

  return linkCheckerApi;
}

/* ---------- #7 UTM templates (utm_tagging) -------------------------- */

export interface UTMTemplate {
  id: string;
  campaign_id?: string;
  is_default: boolean;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface UTMTemplateInput {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
}

export interface UTMPreviewResponse {
  original: string;
  rewritten: string;
  template: UTMTemplate;
}

export function createUtmTemplatesApi(request: CampaignAuthoringRequester) {
  const utmTemplatesApi = {
    /** GET /api/v1/utm-templates → `{templates, count}` (default + per-campaign). */
    list(): Promise<ApiResult<{ templates: UTMTemplate[]; count: number }>> {
      return request<{ templates: UTMTemplate[]; count: number }>(
        "/api/v1/utm-templates",
      );
    },
    /** POST /api/v1/utm-templates (admin) — upsert the tenant default. */
    upsertDefault(input: UTMTemplateInput): Promise<ApiResult<{ id: string }>> {
      return request<{ id: string }>("/api/v1/utm-templates", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    /** POST /api/v1/utm-templates/campaign/{id} (admin) — per-campaign override. */
    upsertCampaign(
      campaignId: string | number,
      input: UTMTemplateInput,
    ): Promise<ApiResult<{ id: string }>> {
      return request<{ id: string }>(
        `/api/v1/utm-templates/campaign/${encodeURIComponent(String(campaignId))}`,
        { method: "POST", body: JSON.stringify(input) },
      );
    },
    /** DELETE /api/v1/utm-templates/{id} (admin) — 204 on success. */
    remove(id: string): Promise<ApiResult<void>> {
      return request<void>(`/api/v1/utm-templates/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
    },
    /** POST /api/v1/utm-templates/preview — rewrite one URL. */
    preview(input: {
      url: string;
      campaign_id?: string;
    }): Promise<ApiResult<UTMPreviewResponse>> {
      return request<UTMPreviewResponse>("/api/v1/utm-templates/preview", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
  };

  return utmTemplatesApi;
}

/* ---------- #8 Subject analyzer (subject_analyzer) ------------------ */

export interface SubjectAttrs {
  length: number;
  length_bucket: string;
  word_count: number;
  emoji_count: number;
  has_question: boolean;
  has_personalize: boolean;
  uppercase_ratio: number;
  all_caps: boolean;
}

export interface SubjectBucket {
  attribute: string;
  bucket: string;
  campaigns: number;
  open_rate: number;
  click_rate: number;
}

export interface SubjectBucketsResponse {
  window_days: number;
  campaigns_total: number;
  buckets: SubjectBucket[];
}

export interface SubjectScoreResponse {
  subject: string;
  attributes: SubjectAttrs;
  expected_open: number;
  expected_click: number;
  matched_history: number;
  suggestions: string[];
}

export function createSubjectAnalyzerApi(request: CampaignAuthoringRequester) {
  const subjectAnalyzerApi = {
    /** GET /api/v1/subject-analyzer/buckets?days= — historical rollup. */
    buckets(days?: number): Promise<ApiResult<SubjectBucketsResponse>> {
      const qs = days != null ? `?days=${days}` : "";
      return request<SubjectBucketsResponse>(
        `/api/v1/subject-analyzer/buckets${qs}`,
      );
    },
    /** POST /api/v1/subject-analyzer/score — heuristic, NOT LLM-backed. */
    score(subject: string): Promise<ApiResult<SubjectScoreResponse>> {
      return request<SubjectScoreResponse>("/api/v1/subject-analyzer/score", {
        method: "POST",
        body: JSON.stringify({ subject }),
      });
    },
  };

  return subjectAnalyzerApi;
}

/* ---------- #9 Email validation (email_validator) ------------------- */

export interface EmailValidationResult {
  email: string;
  valid: boolean;
  /** 'ok' | 'syntax_invalid' | 'no_mx' | 'disposable' | 'role_account' */
  verdict: string;
  domain?: string;
  has_mx: boolean;
  disposable: boolean;
  role_account: boolean;
  reasons: string[];
}

export interface EmailValidationBatchResponse {
  results: EmailValidationResult[];
  summary: { total: number; valid: number; invalid: number };
}

export function createEmailValidationApi(request: CampaignAuthoringRequester) {
  const emailValidationApi = {
    /** POST /api/v1/email-validation/check — single address. */
    check(email: string): Promise<ApiResult<EmailValidationResult>> {
      return request<EmailValidationResult>(
        "/api/v1/email-validation/check",
        { method: "POST", body: JSON.stringify({ email }) },
        // DNS MX lookups can outlive the 5s default on cold cache.
        { timeoutMs: 15_000 },
      );
    },
    /** POST /api/v1/email-validation/check-batch. */
    checkBatch(
      emails: string[],
    ): Promise<ApiResult<EmailValidationBatchResponse>> {
      return request<EmailValidationBatchResponse>(
        "/api/v1/email-validation/check-batch",
        { method: "POST", body: JSON.stringify({ emails }) },
        { timeoutMs: 30_000, maxAttempts: 1 },
      );
    },
  };

  return emailValidationApi;
}

/* ---------- #10 Resend unopened (resend_unopened) ------------------- */

export interface ResendUnopenedInput {
  /** Override subject for the resend; default "Re: <original>". */
  subject?: string;
  name?: string;
  /** Hours after original send before the resend fires. */
  send_after_hours?: number;
}

export interface ResendUnopenedResponse {
  /** New (clone) campaign id. */
  id: string;
  name: string;
  subject: string;
  original_id: string;
  audience_size: number;
  send_after_hours: number;
}

export function createResendUnopenedApi(request: CampaignAuthoringRequester) {
  const resendUnopenedApi = {
    /** POST /api/v1/campaigns/{id}/resend-unopened (admin) — 201. */
    resend(
      campaignId: string | number,
      input: ResendUnopenedInput = {},
    ): Promise<ApiResult<ResendUnopenedResponse>> {
      return request<ResendUnopenedResponse>(
        `/api/v1/campaigns/${encodeURIComponent(String(campaignId))}/resend-unopened`,
        { method: "POST", body: JSON.stringify(input) },
        // Creates + targets a real campaign; never auto-replay offline.
        { requireOnline: true },
      );
    },
  };

  return resendUnopenedApi;
}

/* ---------- #11 Clone campaign (campaign_clone) --------------------- */

export function createCampaignCloneApi(request: CampaignAuthoringRequester) {
  const campaignCloneApi = {
    /** POST /api/v1/campaigns/{id}/clone (admin) — 201 {id, name}. */
    clone(
      campaignId: string | number,
      name?: string,
    ): Promise<ApiResult<{ id: string; name: string }>> {
      return request<{ id: string; name: string }>(
        `/api/v1/campaigns/${encodeURIComponent(String(campaignId))}/clone`,
        { method: "POST", body: JSON.stringify(name ? { name } : {}) },
      );
    },
  };

  return campaignCloneApi;
}

/* ---------- #12 Holdout (holdout) ----------------------------------- */

export interface CampaignHoldout {
  campaign_id: string;
  percent: number;
  seed: string;
  decided_at?: string | null;
  held_out_count: number;
  sent_count: number;
  created_at: string;
  updated_at: string;
}

/** GET .../holdout/lift — `{status:"pending"}` until decided. */
export interface HoldoutLift {
  campaign_id: string;
  percent: number;
  status?: "pending";
  message?: string;
  decided_at?: string;
  held_out_subs?: number;
  sent_subs?: number;
  held_out_clicks?: number;
  sent_clicks?: number;
  held_out_click_rate?: number;
  sent_click_rate?: number;
  incremental_lift?: number;
  lift_percent?: number;
}

export function createHoldoutApi(request: CampaignAuthoringRequester) {
  const holdoutApi = {
    /** POST /api/v1/campaigns/{id}/holdout (admin) — 201 {campaign_id, percent, seed}. */
    create(
      campaignId: string | number,
      percent: number,
    ): Promise<
      ApiResult<{ campaign_id: string; percent: number; seed: string }>
    > {
      return request<{ campaign_id: string; percent: number; seed: string }>(
        `/api/v1/campaigns/${encodeURIComponent(String(campaignId))}/holdout`,
        { method: "POST", body: JSON.stringify({ percent }) },
      );
    },
    /** GET /api/v1/campaigns/{id}/holdout — 404 when none. */
    get(campaignId: string | number): Promise<ApiResult<CampaignHoldout>> {
      return request<CampaignHoldout>(
        `/api/v1/campaigns/${encodeURIComponent(String(campaignId))}/holdout`,
      );
    },
    /** DELETE /api/v1/campaigns/{id}/holdout (admin). */
    remove(campaignId: string | number): Promise<ApiResult<void>> {
      return request<void>(
        `/api/v1/campaigns/${encodeURIComponent(String(campaignId))}/holdout`,
        { method: "DELETE" },
      );
    },
    /** GET /api/v1/campaigns/{id}/holdout/lift. */
    lift(campaignId: string | number): Promise<ApiResult<HoldoutLift>> {
      return request<HoldoutLift>(
        `/api/v1/campaigns/${encodeURIComponent(String(campaignId))}/holdout/lift`,
      );
    },
  };

  return holdoutApi;
}

/* ---------- #13 Control groups (control_group) ---------------------- */

export interface ControlGroup {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  percent: number;
  seed: string;
  status: string;
  starts_at: string;
  ends_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ControlGroupCreateInput {
  name: string;
  description?: string;
  percent: number;
  /** Optional; server generates a random 128-bit hex seed when omitted. */
  seed?: string;
  ends_at?: string;
}

export interface ControlGroupUpdateInput {
  description?: string;
  status?: string;
  ends_at?: string;
}

export interface ControlGroupReport {
  group_id: string;
  window_days: number;
  /**
   * False while control-group membership is not yet excluded at send time —
   * i.e. the "control" cohort received the campaign too. The server then
   * omits the three comparison fields below rather than publishing a lift
   * number measured on noise.
   */
  enforced: boolean;
  warning?: string;
  control_size: number;
  treated_size: number;
  /** Omitted unless `enforced`. */
  control_engagement_rate?: number;
  /** Omitted unless `enforced`. */
  treated_engagement_rate?: number;
  /** Omitted unless `enforced`. */
  incremental_lift?: number;
  generated_at: string;
}

export function createControlGroupsApi(request: CampaignAuthoringRequester) {
  const controlGroupsApi = {
    /** GET /api/v1/control-groups → `{items}`. */
    list(): Promise<ApiResult<{ items: ControlGroup[] }>> {
      return request<{ items: ControlGroup[] }>("/api/v1/control-groups");
    },
    /** POST /api/v1/control-groups — 201, returns the row. */
    create(input: ControlGroupCreateInput): Promise<ApiResult<ControlGroup>> {
      return request<ControlGroup>("/api/v1/control-groups", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    /** GET /api/v1/control-groups/{id}. */
    get(id: string): Promise<ApiResult<ControlGroup>> {
      return request<ControlGroup>(
        `/api/v1/control-groups/${encodeURIComponent(id)}`,
      );
    },
    /** PATCH /api/v1/control-groups/{id}. */
    update(
      id: string,
      input: ControlGroupUpdateInput,
    ): Promise<ApiResult<ControlGroup>> {
      return request<ControlGroup>(
        `/api/v1/control-groups/${encodeURIComponent(id)}`,
        { method: "PATCH", body: JSON.stringify(input) },
      );
    },
    /** DELETE /api/v1/control-groups/{id}. */
    remove(id: string): Promise<ApiResult<void>> {
      return request<void>(`/api/v1/control-groups/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
    },
    /** GET /api/v1/control-groups/{id}/report?window=<days>. */
    report(
      id: string,
      windowDays?: number,
    ): Promise<ApiResult<ControlGroupReport>> {
      const qs = windowDays != null ? `?window=${windowDays}` : "";
      return request<ControlGroupReport>(
        `/api/v1/control-groups/${encodeURIComponent(id)}/report${qs}`,
      );
    },
  };

  return controlGroupsApi;
}

/* ---------- #14 Content optimizer (content_optimizer) --------------- */

export interface OptimizerArmInput {
  key?: string;
  subject?: string;
  preview_text?: string;
  body_html?: string;
  metadata?: Record<string, unknown>;
}

export interface OptimizerPreviewInput {
  arms?: OptimizerArmInput[];
  exploration_rate?: number;
  max_active_arms?: number;
  primary_metric?: string;
  min_sample_per_arm?: number;
  persist_as_run?: boolean;
  activation_status?: string;
}

export interface OptimizerArmAllocation {
  key: string;
  subject?: string;
  preview_text?: string;
  allocation_percent: number;
  exploration_percent: number;
  exploitation_percent: number;
  score: number;
  reason: string;
  metadata?: Record<string, unknown>;
}

export interface OptimizerPreviewResponse {
  campaign_id: string;
  method: string;
  primary_metric: string;
  exploration_rate: number;
  min_sample_per_arm: number;
  recommended_arms: OptimizerArmAllocation[];
  generated_at: string;
  run_id?: string;
}

export interface OptimizerRun {
  id: string;
  campaign_id: string;
  status: string;
  config: Record<string, unknown>;
  preview: OptimizerPreviewResponse;
  created_at: string;
  updated_at: string;
}

export function createContentOptimizerApi(request: CampaignAuthoringRequester) {
  const contentOptimizerApi = {
    /** GET /api/v1/campaigns/{id}/content-optimizer — latest run (404 when none). */
    get(campaignId: string | number): Promise<ApiResult<OptimizerRun>> {
      return request<OptimizerRun>(
        `/api/v1/campaigns/${encodeURIComponent(String(campaignId))}/content-optimizer`,
      );
    },
    /** POST .../content-optimizer/preview — allocation preview, no persist. */
    preview(
      campaignId: string | number,
      input: OptimizerPreviewInput = {},
    ): Promise<ApiResult<OptimizerPreviewResponse>> {
      return request<OptimizerPreviewResponse>(
        `/api/v1/campaigns/${encodeURIComponent(String(campaignId))}/content-optimizer/preview`,
        { method: "POST", body: JSON.stringify(input) },
      );
    },
    /** POST .../content-optimizer — 201, persists a run. */
    createRun(
      campaignId: string | number,
      input: OptimizerPreviewInput = {},
    ): Promise<ApiResult<OptimizerRun>> {
      return request<OptimizerRun>(
        `/api/v1/campaigns/${encodeURIComponent(String(campaignId))}/content-optimizer`,
        { method: "POST", body: JSON.stringify(input) },
      );
    },
  };

  return contentOptimizerApi;
}

/* ---------- #15 Content remix (content_remix) ----------------------- */

export interface RemixAsset {
  channel: string;
  title: string;
  body: string;
  source: string;
  created_at: string;
}

export interface RemixResponse {
  campaign_id: string;
  assets: RemixAsset[];
  generated_at: string;
}

export function createContentRemixApi(
  request: CampaignAuthoringRequester,
  dependencies: CampaignAuthoringDependencies,
) {
  const contentRemixApi = {
    /**
     * POST /api/v1/campaigns/{id}/remix — derives social/blog/sms assets
     * from the campaign body. Currently provider-free (template-driven,
     * NOT LLM-backed per content_remix.go), but it's positioned to grow
     * an LLM path — we pre-emptively give it the LLM budget so a backend
     * swap doesn't strand the client at 5s.
     */
    remix(
      campaignId: string | number,
      input: { channels?: string[]; tone?: string } = {},
    ): Promise<ApiResult<RemixResponse>> {
      return request<RemixResponse>(
        `/api/v1/campaigns/${encodeURIComponent(String(campaignId))}/remix`,
        { method: "POST", body: JSON.stringify(input) },
        dependencies.llmRequestOptions,
      );
    },
  };

  return contentRemixApi;
}

export function createCampaignAuthoringApis(
  request: CampaignAuthoringRequester,
  dependencies: CampaignAuthoringDependencies,
) {
  return {
    emailBlocksApi: createEmailBlocksApi(request),
    sendWindowApi: createSendWindowApi(request),
    a11yApi: createA11yApi(request),
    translationsApi: createTranslationsApi(request, dependencies),
    fromNamePickerApi: createFromNamePickerApi(request),
    linkCheckerApi: createLinkCheckerApi(request),
    utmTemplatesApi: createUtmTemplatesApi(request),
    subjectAnalyzerApi: createSubjectAnalyzerApi(request),
    emailValidationApi: createEmailValidationApi(request),
    resendUnopenedApi: createResendUnopenedApi(request),
    campaignCloneApi: createCampaignCloneApi(request),
    holdoutApi: createHoldoutApi(request),
    controlGroupsApi: createControlGroupsApi(request),
    contentOptimizerApi: createContentOptimizerApi(request),
    contentRemixApi: createContentRemixApi(request, dependencies),
  };
}
