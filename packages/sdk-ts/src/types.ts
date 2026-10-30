/**
 * Moosewave SDK – TypeScript types.
 *
 * Hand-mirrored from packages/openapi/openapi.yaml. The OpenAPI spec is the
 * source of truth; when it changes, update this file in the same PR.
 */

// ---------- shared ----------

export type SourcePlatform =
  | "mailchimp"
  // The gateway emits `mailchimp_api` for tenants migrated via the
  // Mailchimp v3 API path (vs CSV export). Was missing from the union;
  // every API-migrated subscriber would otherwise fail strict parsing.
  | "mailchimp_api"
  | "klaviyo"
  | "customerio"
  | "constant-contact"
  | "aweber"
  | "drip"
  | "campaign-monitor"
  | "omnisend"
  | "loops"
  | "flodesk"
  | "bento"
  | "activecampaign"
  | "convertkit"
  | "substack"
  | "beehiiv"
  | "brevo"
  | "hubspot"
  | "sendy"
  | "mailerlite"
  | "csv";

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

/**
 * Subscriber as returned by the gateway. Hand-mirrored from
 * `apps/api/internal/subscribers/types.go::Subscriber` (which is also
 * mirrored to `packages/openapi/openapi.yaml`'s Subscriber schema; the
 * spec ↔ Go parity is enforced by `scripts/check-subscriber-parity.mjs`
 * in CI). When the Go type changes, update both this and the spec.
 *
 * The `mailchimp_*` and `gdpr_permissions` / `groups` / `merge_fields`
 * fields are populated for tenants migrated from Mailchimp; they're
 * empty/null for native sign-ups but always present in the response.
 */
export interface Subscriber {
  id?: string;
  email: string;
  status: SubscriberStatus;
  mailchimp_status?: string;
  consent_timestamp: string | null;
  consent_source?: ConsentSource;
  custom_fields: Record<string, unknown>;
  merge_fields?: Record<string, unknown>;
  tags: string[];
  groups?: Array<Record<string, unknown>>;
  gdpr_permissions?: Array<Record<string, unknown>>;
  signup_ip?: string;
  unsubscribe_reason?: string;
  mailchimp_last_changed?: string | null;
  activity_summary?: Record<string, unknown>;
  source_id?: string;
  source_platform?: SourcePlatform;
  created_at?: string;
  updated_at?: string;
}

export interface SubscriberPage {
  items: Subscriber[];
  total: number;
  page: number;
  per_page: number;
}

// ---------- migrations ----------

export type MigrationStatus =
  | "pending"
  | "authenticating"
  | "discovering"
  | "dry_run"
  | "awaiting_confirmation"
  | "importing"
  | "rolling_back"
  | "completed"
  | "failed"
  | "rolled_back";

export interface MigrationProgress {
  subscribers_total: number;
  subscribers_done: number;
  segments_total: number;
  segments_done: number;
  automations_total: number;
  automations_done: number;
  paid_subs_total: number;
  paid_subs_done: number;
  archive_total: number;
  archive_done: number;
  templates_total?: number;
  templates_done?: number;
  source_archive_total?: number;
  source_archive_done?: number;
}

export interface ResourceWarning {
  resource: string;
  source_id?: string;
  name?: string;
  warning: string;
}

export interface VerificationReport {
  subscribers_imported: number;
  suppression_list_size: number;
  consent_known: number;
  consent_unknown: number;
  duplicate_subscribers_merged?: number;
  subscriber_merge_conflicts?: SubscriberMergeConflict[];
  custom_fields_mapped: Array<{
    source: string;
    canonical: string;
    type: string;
  }>;
  custom_fields_unmapped: string[];
  segments_translated: number;
  segments_with_warnings: Array<{ name: string; warning: string }>;
  automations_translated: number;
  automations_unsupported: Array<{ name: string; reason: string }>;
  automation_rebuilds?: AutomationRebuildItem[];
  paid_subs_imported: number;
  premium_memberships_observed?: number;
  archive_imported: number;
  discovery_warnings?: string[];
  campaign_archive_warnings?: ResourceWarning[];
  templates_imported?: number;
  template_warnings?: ResourceWarning[];
  source_archive_imported?: number;
  source_archive_warnings?: ResourceWarning[];
  source_archive_by_resource?: Record<string, number>;
  resource_completeness?: Array<{
    resource: string;
    label: string;
    source_total: number;
    imported: number;
    supported: boolean;
    status:
      | "imported_runtime"
      | "partial_runtime"
      | "preserved_for_rebuild"
      | "manual_rebuild_required"
      | "not_supported"
      | "not_detected";
    notes?: string[];
  }>;
  data_loss_estimate_pct: number;
}

export interface SubscriberMergeConflict {
  email: string;
  source_ids?: string[];
  tags?: string[];
  conflict_fields?: string[];
}

export interface AutomationRebuildItem {
  rank: number;
  name: string;
  source_id?: string;
  status:
    | "not_started"
    | "rebuilding"
    | "test_passed"
    | "approved_not_needed"
    | "blocked";
  owner?: string;
  notes?: string;
  test_evidence?: string;
  updated_at?: string;
}

export interface PilotAcceptanceReport {
  job_id: string;
  source: SourcePlatform;
  generated_at: string;
  status: "pass" | "warning" | "blocker";
  blockers: number;
  warnings: number;
  items: Array<{
    key: string;
    label: string;
    status: "pass" | "warning" | "blocker";
    expected?: number;
    actual?: number;
    detail?: string;
    evidence?: string[];
  }>;
}

export interface ShadowResourceDelta {
  resource: string;
  label: string;
  source_total: number;
  imported: number;
  delta: number;
  status: string;
  supported: boolean;
  cutover_risk: string;
  notes?: string[];
}

export interface ShadowCheckResponse {
  job_id: string;
  source: SourcePlatform;
  generated_at: string;
  attempt_token?: string;
  import_epoch?: string;
  baseline_fingerprint?: string;
  error?: string;
  warnings?: string[];
  current_discovery: Record<string, number>;
  needs_delta_import: boolean;
  recommended_action: string;
  blockers?: string[];
  deltas: ShadowResourceDelta[];
}

export interface ShadowMonitor {
  job_id: string;
  tenant_id: string;
  source: SourcePlatform;
  enabled: boolean;
  interval_seconds: number;
  last_checked_at?: string | null;
  next_check_at?: string | null;
  last_recommended_action?: string;
  last_error?: string;
}

export interface ShadowMonitorResponse {
  monitor: ShadowMonitor;
  history: ShadowCheckResponse[];
}

export interface SourceEventMonitor {
  job_id: string;
  tenant_id: string;
  source: SourcePlatform;
  enabled: boolean;
  interval_seconds: number;
  enabled_since?: string | null;
  first_successful_sync_at?: string | null;
  successful_sync_count?: number;
  max_success_gap_seconds?: number;
  cursor?: string;
  last_event_at?: string | null;
  last_synced_at?: string | null;
  next_sync_at?: string | null;
  last_error?: string;
  events_seen?: number;
  events_applied?: number;
  created_at?: string;
  updated_at?: string;
}

export interface SourceEventRecord {
  id: string;
  job_id: string;
  tenant_id: string;
  source: SourcePlatform;
  source_event_id: string;
  resource_type: string;
  action: string;
  occurred_at?: string | null;
  applied: boolean;
  error?: string;
  review_status?: "pending" | "reviewed";
  review_detail?: string;
  review_evidence?: string[];
  reviewed_at?: string | null;
  payload?: Record<string, unknown>;
  created_at?: string;
}

export interface SourceEventMonitorResponse {
  monitor: SourceEventMonitor;
  events: SourceEventRecord[];
}

export interface RollbackRehearsalItem {
  key: string;
  label: string;
  status: "pass" | "warning" | "blocker";
  count?: number;
  detail?: string;
  order?: number;
}

export interface RollbackRehearsalReport {
  job_id: string;
  source: SourcePlatform;
  generated_at: string;
  status: "pass" | "warning" | "blocker";
  rollback_until?: string | null;
  total_resources: number;
  items: RollbackRehearsalItem[];
}

export interface MigrationJob {
  id: string;
  tenant_id: string;
  source: SourcePlatform;
  status: MigrationStatus;
  progress: MigrationProgress;
  cursor: Record<string, string | null>;
  started_at: string;
  completed_at: string | null;
  rollback_until: string | null;
  source_session_expires_at?: string | null;
  selected_audience_ids?: string[];
  verification_report: VerificationReport | null;
  error: string | null;
}

export interface AdapterCapabilities {
  source: SourcePlatform;
  auth_method: "oauth2" | "api_key" | "csv_upload";
  supports: {
    subscribers: boolean;
    segments: boolean;
    automations: boolean;
    automation_mode?: "runtime" | "rebuild_review" | "none";
    campaign_archive: boolean;
    paid_subs: boolean;
    consent_timestamps: boolean;
    templates?: boolean;
    campaigns?: boolean;
    reports?: boolean;
    groups?: boolean;
    forms?: boolean;
    landing_pages?: boolean;
    ecommerce?: boolean;
    crm?: boolean;
    custom_objects?: boolean;
    sms?: boolean;
  };
}

export interface OAuthStartResponse {
  authorize_url: string;
  state: string;
}

export interface DiscoveryAudience {
  id: string;
  /**
   * Provider names may be absent. Klaviyo supplies deterministic
   * `Klaviyo list <id>` / `Klaviyo segment <id>` fallbacks.
   */
  name?: string;
  subscribers_total: number;
}

export interface DiscoveryReport {
  /**
   * Authoritative migration job identity for this report. Reuse this exact
   * value for subsequent dry-run, commit, reconnect, and job-detail requests.
   */
  job_id: string;
  source?: SourcePlatform;
  subscribers_count: number;
  /**
   * Profiles excluded because the stable source record has no primary email.
   * This does not inventory Klaviyo secondary addresses or prove independent
   * per-address consent/suppression parity.
   */
  profiles_without_email_count?: number;
  /**
   * Additional source email identities that are not independent sendable
   * subscribers. HubSpot aliases are evidence only and do not prove
   * per-address consent.
   */
  additional_email_identities_count?: number;
  /**
   * Klaviyo reports the exact enumerated send-targetable audience projection
   * after validated list-level suppressions; raw membership is not separate.
   * HubSpot reports the combined count of list snapshots and active email
   * subscription-definition targeting boundaries, not a lists-only count.
   */
  segments_count: number;
  automations_count: number;
  paid_subs_count: number;
  archive_count: number;
  /**
   * Includes mandatory review records. Klaviyo has eight unconditional static
   * checklist rows; source_total=1 is one checklist, not detected inventory.
   */
  source_archive_count?: number;
  templates_count?: number;
  campaigns_count?: number;
  reports_count?: number;
  groups_count?: number;
  forms_count?: number;
  landing_pages_count?: number;
  ecommerce_count?: number;
  /**
   * Exact source object-type metadata count. Customer.io object profiles and
   * relationships require a separate provider export and are not represented.
   */
  custom_objects_count?: number;
  /** Exact Customer.io subscription-center channel-definition count. */
  subscription_channels_count?: number;
  sms_campaigns_count?: number;
  push_campaigns_count?: number;
  resource_metadata?: VerificationReport["resource_completeness"];
  custom_fields?: string[];
  warnings?: string[];
  audiences?: DiscoveryAudience[];
  capabilities: AdapterCapabilities;
}

export interface RollbackProgress {
  state: "pending" | "running" | "completed" | "failed";
  archive_deleted: number;
  archive_total: number;
  templates_deleted: number;
  templates_total: number;
  automations_deleted: number;
  automations_total: number;
  segments_deleted: number;
  segments_total: number;
  subscribers_deleted: number;
  subscribers_total: number;
  lists_deleted: number;
  lists_total: number;
  paid_subs_deleted: number;
  paid_subs_total: number;
  started_at: string;
  completed_at?: string;
  error?: string;
}

export interface RollbackStartResponse {
  job_id: string;
  state: "running";
}

// ---------- voice profile + sequences ----------

export interface VoiceProfile {
  tenant_id: string;
  version: number;
  generated_at: string;
  stylistic: {
    avg_sentence_length: number;
    sentence_length_variance: number;
    avg_paragraph_length: number;
    formality_score: number;
    hedging_frequency: number;
    passive_voice_pct: number;
  };
  vocabulary: {
    distinctive_terms: Array<{ term: string; score: number }>;
    recurring_phrases: Array<{ phrase: string; n: number; count: number }>;
    idiom_markers: string[];
    metaphor_patterns: string[];
  };
  structural: {
    opening_hook_style: string;
    closing_pattern: string;
    bullet_list_usage_rate: number;
    markdown_style_hint: string;
  };
  tonal: {
    humor: number;
    optimism: number;
    personal_vs_observational: number;
    directness: number;
  };
  persona: {
    pronoun_usage: Record<string, number>;
    self_disclosure_rate: number;
    recurring_themes: string[];
  };
  representative_samples: Array<{
    text: string;
    source?: string;
    url?: string;
  }>;
  source_summary: Record<
    string,
    { word_count: number; item_count: number; last_ingested_at: string }
  >;
}

export type VoiceSourceType =
  | "rss"
  | "sitemap"
  | "substack"
  | "beehiiv"
  | "manual_paste"
  | "file_upload";

export interface VoiceSource {
  id: string;
  tenant_id: string;
  type: VoiceSourceType;
  params: Record<string, unknown>;
  last_ingested_at?: string;
  last_item_count: number;
}

export interface RegisterVoiceSource {
  type: VoiceSourceType;
  params: Record<string, unknown>;
}

export interface StyleControls {
  humor?: number;
  directness?: number;
  formality_shift?: number;
  length?: "" | "shorter" | "longer" | "as-is";
}

export interface GeneratedEmail {
  position: number;
  delay_seconds: number;
  subject: string;
  body: string;
  body_html?: string;
  voice_fidelity_score: number;
  regeneration_count: number;
}

export type SequenceStepType =
  | "email"
  | "delay"
  | "condition"
  | "tag_add"
  | "tag_remove"
  | "exit";

export interface SequenceEmailStep {
  subject: string;
  body: string;
  body_html?: string;
  delay_seconds?: number;
  template_id?: string;
}

export interface SequenceDelayStep {
  seconds: number;
  value?: number;
  unit?: "minutes" | "hours" | "days";
}

export interface SequenceConditionStep {
  predicate: string;
  value?: string;
  yes_branch: SequenceStep[];
  no_branch: SequenceStep[];
}

export interface SequenceTagStep {
  tag: string;
}

export interface SequenceStep {
  type: SequenceStepType;
  position: number;
  email?: SequenceEmailStep;
  delay?: SequenceDelayStep;
  condition?: SequenceConditionStep;
  tag?: SequenceTagStep;
}

export interface Sequence {
  id: string;
  tenant_id: string;
  template_id: string;
  name: string;
  status: "draft" | "active" | "archived";
  /** Monotonic revision used by sequence PATCH/DELETE If-Match guards. */
  version: number;
  emails: GeneratedEmail[];
  steps?: SequenceStep[];
  created_at: string;
  updated_at: string;
  low_fidelity_flag?: boolean;
}

export interface GenerateRequest {
  template_id: string;
  name: string;
  variables?: Record<string, string>;
  style_controls?: StyleControls;
  profile?: VoiceProfile;
}

export interface RegenerateRequest {
  style_controls?: StyleControls;
  user_hint?: string;
  variables?: Record<string, string>;
}

// ---------- templates ----------

export type TemplateCategory =
  | "welcome"
  | "course_launch"
  | "product_launch"
  | "re_engagement"
  | "newsletter_series"
  | "saas_onboarding"
  | "partnership"
  | "year_in_review"
  | "crisis"
  | "cold_warm"
  | "sales"
  | "community"
  | "misc";

export interface Template {
  id: string;
  slug: string;
  category: TemplateCategory;
  name: string;
  description: string;
  length: number;
  variables: Array<{
    key: string;
    label: string;
    required: boolean;
    example: string;
  }>;
  emails: Array<{
    position: number;
    delay_seconds: number;
    subject_skeleton: string;
    body_skeleton: string;
    notes: string;
  }>;
  tags: string[];
  author: string;
  performance: {
    open_rate: number;
    click_rate: number;
    conversion_rate: number;
    sample_size: number;
  };
  created_at?: string;
  updated_at?: string;
}

// ---------- forms ----------

export type OptInMode = "single" | "double";
export type FormStatus = "draft" | "published" | "archived";
/**
 * `received` is a response that did not ask to subscribe: the form's consent
 * checkbox was left unticked, so nothing was confirmed or joined.
 */
export type SubmissionStatus = "pending" | "confirmed" | "unsubscribed" | "received";

/** Last outcome of a submission's double opt-in email. */
export type ConfirmationEmailState =
  | "queued"
  | "sent"
  | "send_failed"
  | "no_sender"
  | "quota_exceeded"
  | "recipient_suppressed";

export interface Form {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  optInMode: OptInMode;
  structure: Record<string, unknown>;
  settings: Record<string, unknown>;
  status: FormStatus;
  createdAt: string;
  updatedAt: string;
}

export interface FormListItem extends Form {
  submissions30d: number;
  conversionRate: number;
}

export interface FormCreateInput {
  name: string;
  slug: string;
  optInMode: OptInMode;
  successMessage?: string;
  successRedirectUrl?: string;
}

export interface FormUpdateInput {
  name?: string;
  slug?: string;
  optInMode?: OptInMode;
  structure?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  status?: FormStatus;
}

export interface Submission {
  id: string;
  formId: string;
  email: string;
  customFields: Record<string, string>;
  status: SubmissionStatus;
  ip?: string | null;
  userAgent?: string | null;
  submittedAt: string;
  confirmedAt?: string | null;
  /** Absent when the submission has no confirmation email. */
  confirmationEmail?: ConfirmationEmailState;
}

export interface SubmitInput {
  email: string;
  name?: string;
  consent?: string;
  website?: string;
  customFields?: Record<string, string>;
  captchaToken?: string;
}

// ---------- deliverability ----------

export type Placement =
  | "primary"
  | "promotions"
  | "updates"
  | "social"
  | "spam"
  | "blocked"
  | "missing";

export type Provider =
  | "gmail"
  | "outlook_com"
  | "o365"
  | "icloud"
  | "yahoo"
  | "proton"
  | "gmx"
  | "mailru";

export interface CampaignReport {
  campaign_id: string;
  providers: Array<{
    provider: Provider;
    total: number;
    placements: Record<Placement, number>;
  }>;
  overall_pct: Partial<Record<Placement, number>>;
  total_inboxes: number;
  generated_at: string;
  diagnostic_id?: string;
}

export type ReputationScore = "low" | "medium" | "high";

export interface Reputation {
  domain: string;
  ip: string;
  google_score: ReputationScore;
  microsoft_score: ReputationScore;
  sender_score: number;
  blacklist_hits: string[];
  checked_at: string;
}

export type AuthStatus = "ok" | "warn" | "fail";

export interface AuthRecord {
  status: AuthStatus;
  detail: string;
}

export interface AuthCheck {
  domain: string;
  spf: AuthRecord;
  dkim: AuthRecord;
  dmarc: AuthRecord;
  bimi: AuthRecord;
  ptr: AuthRecord;
}

export interface ContentScan {
  spam_score: number;
  spam_reasons?: string[];
  image_text_ratio: number;
  link_reputation: AuthStatus;
  html_issues?: string[];
}

export interface PredictedPlacement {
  primary: number;
  promotions: number;
  spam: number;
}

export interface PredictInput {
  html: string;
  subject: string;
  reputation?: Reputation;
  history?: {
    open_rate: number;
    click_rate: number;
    complaint_rate: number;
    bounce_rate: number;
    sample_size: number;
  };
  links?: string[];
}

export interface PredictResponse {
  predicted: PredictedPlacement;
  content: ContentScan;
  at: string;
}

export type FixAction = "dns_record" | "copy_change" | "image_swap" | "resend";

export interface Fix {
  title: string;
  detail: string;
  action: FixAction;
  dns_record?: { type: string; name: string; value: string; ttl?: number };
  estimated_impact: number;
}

export interface Diagnosis {
  campaign_id: string;
  diagnosis: string;
  fixes: Fix[];
  predicted_impact: Record<string, number>;
  generated_at: string;
}

export type RenderEnvironment =
  | "gmail_web"
  | "gmail_ios"
  | "gmail_android"
  | "outlook_web"
  | "outlook_ios"
  | "outlook_desktop"
  | "apple_mail_macos"
  | "apple_mail_ios";

export interface RenderInput {
  html: string;
  environments?: RenderEnvironment[];
}

export interface Render {
  environment: RenderEnvironment;
  screenshot_url: string;
  width_px: number;
  height_px: number;
}

export interface RenderResponse {
  renders: Render[];
  cache_hit: boolean;
}

// ---------- sending ----------

export interface SendingState {
  tenant_id: string;
  provider: "postmark" | "ses";
  server_id: string;
  signature_id: string;
  from_email: string;
  tier: "shared" | "dedicated";
  provisioned_at: string;
}

export interface WarmupState {
  started: boolean;
  warmup_started_at?: string;
  warmup_day?: number;
  todays_cap?: number;
  todays_sent?: number;
  schedule: Array<{ day: number; cap_pct: number }>;
}

// ---------- automations ----------

export interface AutomationTriggerInput {
  automation_id: string;
  trigger_type: string;
  subscriber_email: string;
  payload?: Record<string, unknown>;
}

export interface AutomationExecution {
  id: string;
  automation_id: string;
  subscriber_email: string;
  current_node_id: string;
  paused: boolean;
  started_at: string;
  next_step_at?: string;
}

// ---------- webhooks ----------

/**
 * Canonical outbound topics accepted by webhook subscription and delivery
 * APIs. Keep the runtime tuple public so integrations such as the first-party
 * MCP adapter can validate against the SDK contract instead of restating it.
 */
export const OUTBOUND_WEBHOOK_EVENT_TYPES = [
  "campaign.sent",
  "subscriber.added",
  "subscriber.removed",
  "subscriber.unsubscribed",
  "approval.requested",
  "approval.decided",
  "audit.created",
  "bounce.received",
  "list_health.degraded",
  "list.subscriber.added",
  "email.bounced",
  "email.complained",
  "email.delivered",
  "assurance.run.completed",
  "assurance.run.blocked",
] as const;

export type WebhookEventType = (typeof OUTBOUND_WEBHOOK_EVENT_TYPES)[number];

export interface WebhookEvent<T = Record<string, unknown>> {
  id: string;
  type: WebhookEventType;
  occurred_at: string;
  data: T;
}

export interface WebhookEnvelope<T = Record<string, unknown>> {
  event: WebhookEvent<T>;
  webhook: { id: string };
  delivery: { id: string; attempt: number };
}

export type WebhookSigningAlgorithm = "hmac_sha256" | "ecdsa_p256" | "ed25519";

export type WebhookReceiverAuthConfig =
  | { type: "none" }
  | { type: "bearer"; bearer_token: string }
  | { type: "headers" | "custom_headers"; headers: Record<string, string> }
  | { type: "mtls"; mtls_cert_pem: string; mtls_key_pem: string }
  | {
      type: "combined";
      bearer_token?: string;
      headers?: Record<string, string>;
      mtls_cert_pem?: string;
      mtls_key_pem?: string;
    };

/** Value-free metadata returned by read APIs. Credential values are write-only. */
export interface WebhookReceiverAuthMetadata {
  type: "bearer" | "headers" | "custom_headers" | "mtls" | "combined";
  bearer_configured?: boolean;
  header_names?: string[];
  mtls_configured?: boolean;
  secret_redacted?: boolean;
}

export interface WebhookSubscription {
  id: string;
  tenant_id: string;
  url: string;
  events: WebhookEventType[];
  active: boolean;
  description?: string;
  created_by_user_id?: string;
  created_at: string;
  updated_at: string;
  last_succeeded_at?: string;
  last_failed_at?: string;
  consecutive_failures: number;
  signing_algorithm: WebhookSigningAlgorithm;
  signing_public_key?: string;
  secondary_public_key?: string;
  secondary_expires_at?: string;
  rotated_at?: string;
  list_id?: string;
  auth_config?: WebhookReceiverAuthMetadata;
  auth_config_status?: "ready" | "legacy_pending" | "invalid";
}

export interface WebhookSubscriptionInput {
  url: string;
  events: WebhookEventType[];
  description?: string;
  algorithm?: WebhookSigningAlgorithm;
  list_id?: string;
  auth_config?: WebhookReceiverAuthConfig;
}

export interface WebhookSubscriptionUpdate {
  url?: string;
  events?: WebhookEventType[];
  description?: string;
  active?: boolean;
  /**
   * Omit to preserve receiver credentials, null (or type=none) to clear them,
   * or provide a complete object to atomically replace them.
   */
  auth_config?: WebhookReceiverAuthConfig | null;
}

// ---------- account ----------

export interface MeResponse {
  tenant: string;
  user: string | null;
}
