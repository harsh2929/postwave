// SPDX-License-Identifier: AGPL-3.0-only

import { api } from "./api";

export interface MailchimpCompatSummary {
  contacts: {
    total: number;
    by_mailchimp_status: Record<string, number>;
    groups: number;
    activity_events: number;
  };
  campaigns: {
    total: number;
    by_type: Record<string, number>;
    assets: number;
    reusable_sections: number;
  };
  reports: { events: number; reportable_campaigns: number };
  automations: { total: number; by_status: Record<string, number> };
  growth: {
    landing_pages: number;
    popups: number;
    views: number;
    conversions: number;
  };
  ecommerce: {
    integrations: number;
    customers: number;
    products: number;
    orders: number;
    revenue_cents: number;
    attributed_revenue_cents: number;
  };
}

export interface CompatResource {
  id: string;
  name?: string;
  status?: string;
  slug?: string;
  provider?: string;
  shop_domain?: string;
  source_id?: string;
  triggers?: Array<Record<string, unknown>>;
  nodes?: Array<Record<string, unknown>>;
  edges?: Array<Record<string, unknown>>;
  goals?: Array<Record<string, unknown>>;
  updated_at?: string;
  created_at?: string;
}

export interface ImportedTemplate extends CompatResource {
  name: string;
  subject?: string;
  category?: string;
  html?: string;
  mjml?: string;
}

export interface ImportedForm extends CompatResource {
  name: string;
  status?: string;
  form_type?: string;
  public_url?: string;
  fields?: Array<Record<string, unknown>>;
}

export interface ReportHistoryItem extends CompatResource {
  campaign_id?: string;
  subject?: string;
  sent_at?: string;
  opens?: number;
  clicks?: number;
  revenue_cents?: number;
}

export interface CampaignAsset extends CompatResource {
  name: string;
  asset_type: "image" | "file" | "video" | "product";
  url: string;
  alt_text?: string;
  metadata: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface CampaignSection extends CompatResource {
  name: string;
  category: string;
  blocks: Array<Record<string, unknown>>;
  html?: string;
  mjml?: string;
  created_at?: string;
  updated_at?: string;
}

export interface PopupForm extends CompatResource {
  tenant_id?: string;
  public_key?: string;
  name: string;
  status: "draft" | "published" | "paused" | "archived";
  trigger: Record<string, unknown>;
  targeting: Record<string, unknown>;
  blocks: Array<Record<string, unknown>>;
  form_id?: string;
  metrics: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface CampaignReport {
  campaign_id: string;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  complained: number;
  unsubscribed: number;
  conversions: number;
  revenue_cents: number;
  open_rate: number;
  click_rate: number;
  top_links: Array<{ key: string; count: number }>;
  devices: Array<{ key: string; count: number }>;
  clients: Array<{ key: string; count: number }>;
  geography: Array<{ key: string; count: number }>;
  per_recipient: Array<{
    email: string;
    sent: number;
    opened: number;
    clicked: number;
    bounced: number;
    complained: number;
    unsubscribed: number;
    revenue_cents: number;
  }>;
}

export interface CampaignPlannerResponse {
  window?: Record<string, string>;
  touchpoints: Array<{
    id: string;
    channel: string;
    kind: string;
    name: string;
    status: string;
    scheduled_at?: string;
    sent_at?: string;
    campaign_id?: string;
    parent_campaign_id?: string;
    item_type?: string;
    links?: Record<string, string>;
    report?: Record<string, unknown>;
  }>;
  tasks: Array<{
    id: string;
    campaign_id?: string;
    title: string;
    status: string;
    priority: string;
    channel?: string;
    kind?: string;
    blocked_by?: string[];
    due_at?: string;
  }>;
  workflow?: {
    phases: Array<{
      id: string;
      name: string;
      status: string;
      touchpoints: string[];
      tasks: string[];
    }>;
    reporting: Array<Record<string, string>>;
    generated_at: string;
    completeness: Record<string, unknown>;
  };
  channels?: Array<{
    channel: string;
    draft: number;
    scheduled: number;
    sending: number;
    sent: number;
    planned: number;
    cancelled: number;
    failed: number;
  }>;
  capabilities: Array<{ feature: string; status: string; detail: string }>;
  summary: Record<string, number>;
  reports?: Array<Record<string, unknown>>;
}

export interface MultivariateTestResponse {
  campaign_id: string;
  enabled: boolean;
  winner_metric: string;
  evaluation_window_hours: number;
  sample_pct: number;
  winner_recipients_pct: number;
  variations: Array<{
    id: string;
    label: string;
    subject_line?: string;
    from_name?: string;
    from_email?: string;
    send_time_offset_minutes?: number;
    weight: number;
    results?: Record<string, unknown>;
  }>;
  dimensions: string[];
  limits: Record<string, unknown>;
  execution?: {
    status: string;
    ready: boolean;
    variant_count: number;
    sample_pct: number;
    holdout_pct: number;
    winner_rollout_pct: number;
    dimensions: string[];
    warnings?: string[];
    provider_contract: string;
    next_action: string;
  };
  report?: Array<{
    variant_id: string;
    label: string;
    recipients: number;
    delivered: number;
    open_rate: number;
    click_rate: number;
    reply_rate: number;
    lift_vs_control: Record<string, number>;
    confidence_vs_control: number;
    winner: boolean;
  }>;
}

export interface OptimizationResponse {
  campaign_id: string;
  recommendation: {
    label: string;
    send_at?: string;
    score: number;
    confidence: string;
    reason: string;
    grade?: string;
    method_note?: string;
  };
  candidates?: Array<{
    label: string;
    send_at?: string;
    score: number;
    opens: number;
    clicks: number;
    confidence: string;
    grade?: string;
    delivered?: number;
    engagement_rate?: number;
  }>;
  days?: Array<{
    label: string;
    send_at?: string;
    score: number;
    opens: number;
    clicks: number;
    confidence: string;
    grade?: string;
    delivered?: number;
    engagement_rate?: number;
  }>;
  data_points: number;
  method: string;
}

export interface ClickMapResponse {
  campaign_id: string;
  total_clicks: number;
  links: Array<{
    link_id: string;
    url: string;
    selector?: string;
    clicks: number;
    unique_clicks: number;
    share: number;
    devices: Record<string, number>;
    coordinates?: Record<string, number>;
  }>;
  device_views: Array<{
    device: string;
    total_clicks: number;
  }>;
  overlay?: {
    html?: string;
    render_hint: string;
    width: number;
    height: number;
    legend: Record<string, unknown>;
  };
}

export interface CustomReportResponse {
  id: string;
  view: string;
  metrics: string[];
  group_by: string[];
  rows: Array<{
    dimensions: Record<string, string>;
    metrics: Record<string, number>;
  }>;
  graph: Array<{
    date: string;
    metrics: Record<string, number>;
  }>;
  export?: Record<string, string>;
  exports?: Record<string, string>;
  retention?: Record<string, unknown>;
  available_metrics?: string[];
  available_group_by?: string[];
  generated_at: string;
}

export interface DeliveryInsightsResponse {
  campaign_id: string;
  status: string;
  can_cancel: boolean;
  cancelled: boolean;
  progress: Record<string, number>;
  delivery_status: string;
  warnings: string[];
  cancellation_guarantee?: string;
  provider_cancellation?: Record<string, unknown>;
  queue_stopped_at?: string;
}

export interface CampaignInboxResponse {
  campaign_id: string;
  replies: Array<{
    id: string;
    email_address: string;
    subject?: string;
    snippet?: string;
    received_at: string;
    needs_follow_up: boolean;
  }>;
  threads: Array<{
    email_address: string;
    replies: number;
    last_at: string;
  }>;
  total_items: number;
  distinct_replyers: number;
  reply_rate: number;
  follow_up_open?: number;
  last_reply_at?: string;
  campaign_summary?: Record<string, unknown>;
  report_links?: Record<string, string>;
}

export interface MultiChannelReadinessResponse {
  channels: Array<{
    feature: string;
    status: string;
    detail: string;
    actions?: string[];
  }>;
  providers?: Record<
    string,
    {
      provider: string;
      status: string;
      detail: string;
      missing?: string[];
      docs?: string[];
      version?: string;
      credential_source?: string;
      tenant_scoped?: boolean;
      connection_id?: string;
      account_id?: string;
      scopes?: string[];
      connected_at?: string;
      validated_at?: string;
      expires_at?: string;
    }
  >;
  provider_setup?: Array<{
    provider: string;
    label: string;
    status: string;
    action: string;
    docs?: string[];
    required?: string[];
    description: string;
  }>;
  operational_mode: string;
  summary: Record<string, number>;
  warnings: string[];
  generated_at: string;
}

export interface SurveyResource {
  id: string;
  name: string;
  status: string;
  public_url: string;
  questions: Array<{
    id: string;
    type: string;
    label: string;
    required: boolean;
    choices?: string[];
  }>;
  builder?: {
    mode: string;
    question_types: string[];
    design_controls: string[];
    notification_events: string[];
    export_formats: string[];
    hosted: boolean;
  };
  exports?: Record<string, string>;
  notification_channels?: string[];
  design_controls?: string[];
  design?: Record<string, unknown>;
  notifications?: Record<string, unknown>;
  metrics: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface SurveysResponse {
  surveys: SurveyResource[];
  total_items: number;
}

export interface LandingPageParityResponse {
  status: string;
  counts: Record<string, number>;
  capabilities: Array<{ feature: string; status: string; detail: string }>;
  builder?: Record<string, unknown>;
  import_parity?: Record<string, string>;
  report_links?: Record<string, string>;
  generated_at: string;
}

export interface WebsiteBuilderStatusResponse {
  status: string;
  detail: string;
  fallback: string;
  capabilities: Array<{ feature: string; status: string; detail: string }>;
  generated_at: string;
}

export interface AudienceInsightsResponse {
  list_id: string;
  contact_ratings: Record<string, number>;
  status_counts: Record<string, number>;
  predicted_demographics: Record<string, number>;
  predictive_clv: Record<string, unknown>;
  prebuilt_segments?: Array<Record<string, unknown>>;
  segment_dimensions: string[];
  model_notes?: string[];
  segment_coverage?: Record<string, unknown>;
  generated_at: string;
}

export interface AdvancedSegmentSchemaResponse {
  list_id: string;
  dimensions: Array<{
    key: string;
    label: string;
    type: string;
    operators: string[];
    description: string;
  }>;
  operators: string[];
  prebuilt_segments?: Array<Record<string, unknown>>;
  examples?: Array<Record<string, unknown>>;
  evaluator?: Record<string, unknown>;
  coverage?: Record<string, string>;
  unsupported?: string[];
  limits: Record<string, unknown>;
  generated_at: string;
}

export interface ContentStudioResponse {
  status: string;
  files: Array<{
    id: string;
    folder_id?: string;
    type: string;
    name: string;
    alt_text?: string;
    full_size_url: string;
    thumbnail_url?: string;
    size?: number;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }>;
  folders: Array<{ id: string; name: string; file_count?: number }>;
  summary: Record<string, number>;
  capabilities: Array<{ feature: string; status: string; detail: string }>;
  lifecycle?: Record<string, unknown>;
  policies?: Record<string, unknown>;
  parity?: Record<string, string>;
  limitations?: string[];
  generated_at: string;
}

export interface InlineAIResponse {
  mode: string;
  channel: string;
  provider_mode?: string;
  provider_status?: string;
  text: string;
  variants: string[];
  actions?: string[];
  metadata: Record<string, unknown>;
  capabilities?: Array<{ feature: string; status: string; detail: string }>;
  warnings?: string[];
  generated_at: string;
}

export interface CreativeAssistantResponse {
  id: string;
  goal: string;
  channel: string;
  provider_mode?: string;
  provider_status?: string;
  subject_lines?: string[];
  preview_texts?: string[];
  headlines?: string[];
  body_drafts?: string[];
  sms_drafts?: string[];
  checklist: string[];
  capabilities?: Array<{ feature: string; status: string; detail: string }>;
  limits?: Record<string, unknown>;
  warnings?: string[];
}

export interface VideoConvertResponse {
  provider: string;
  video_id: string;
  url: string;
  thumbnail_url: string;
  merge_tag: string;
  email_html: string;
  plain_text: string;
  pipeline?: string;
  transcode_status?: string;
  upload_supported?: boolean;
  supported_sources?: string[];
  asset_lifecycle?: Record<string, string>;
  warnings?: string[];
}

export interface MailchimpBlockCatalogResponse {
  blocks: Array<{
    id: string;
    name: string;
    category: string;
    description: string;
    fields: string[];
    default_data: Record<string, unknown>;
    mailchimp_key: string;
    editor_parity?: string;
    render_phase?: string;
    send_time_behavior?: string;
    limitations?: string[];
  }>;
  total_items: number;
  editor_contract?: Record<string, string>;
  send_time_contract?: Record<string, string>;
  coverage?: Record<string, string>;
  limitations?: string[];
  generated_at: string;
}

export interface TemplateLanguagePreviewResponse {
  html?: string;
  text?: string;
  found_tags: string[];
  unsupported_tags: string[];
  warnings: string[];
  required_footer_present: boolean;
  parser?: string;
  supported_syntax?: string[];
  unsupported_syntax?: string[];
}

export interface BatchResponse {
  id: string;
  status: string;
  execution_mode?: string;
  durability?: string;
  total_operations: number;
  finished_operations: number;
  errored_operations: number;
  submitted_at: string;
  completed_at?: string;
  response_body_url?: string;
  callback_url?: string;
  webhook_status?: string;
  limits?: Record<string, unknown>;
}

export interface BatchesResponse {
  batches: BatchResponse[];
  total_items: number;
}

export interface AccountExport {
  id: string;
  status: string;
  started_at: string;
  finished_at?: string;
  download_url?: string;
  sections?: string[];
  counts?: Record<string, number>;
  manifest?: Record<string, unknown>;
  completeness?: Record<string, string>;
  retention_days?: number;
  warnings?: string[];
}

export interface AccountExportsResponse {
  exports: AccountExport[];
  total_items: number;
}

export interface ConnectedSite {
  id: string;
  foreign_id?: string;
  domain: string;
  url: string;
  name: string;
  platform: string;
  list_id?: string;
  status: string;
  script_installed: boolean;
  sync_status: string;
  script_status?: string;
  tracking_contract?: Record<string, unknown>;
  verification_steps?: string[];
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ConnectedSitesResponse {
  sites: ConnectedSite[];
  total_items: number;
}

export interface VerifiedDomain {
  id: string;
  domain: string;
  status: string;
  verified: boolean;
  dns_records: Array<{ type: string; name: string; value: string }>;
  purpose: string;
  verification_contract?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  created_at: string;
  verified_at?: string;
}

export interface VerifiedDomainsResponse {
  domains: VerifiedDomain[];
  total_items: number;
}

export interface IntegrationMarketplaceResponse {
  status: string;
  items: Array<{
    id: string;
    name: string;
    category: string;
    status: string;
    provider: string;
    description: string;
    scopes?: string[];
  }>;
  total_items: number;
  categories: Record<string, number>;
  capabilities: Array<{ feature: string; status: string; detail: string }>;
  native_connectors?: string[];
  catalog_only?: number;
  automation_coverage?: Record<string, string>;
  caveats?: string[];
  generated_at: string;
}

export interface AgencyEcosystemResponse {
  status: string;
  program?: Record<string, unknown>;
  resources: Array<{
    id: string;
    name: string;
    kind: string;
    status: string;
    description: string;
  }>;
  partner_path: string[];
  certification_tracks?: string[];
  caveats?: string[];
  generated_at: string;
}

export interface MailchimpParityWorkbenchResponse {
  status: string;
  streams: Array<{
    stream: string;
    status: string;
    total: number;
    complete: number;
    blocked: number;
    foundation_ready: number;
    tasks: string[];
  }>;
  tasks: Array<{
    id: string;
    stream: string;
    title: string;
    status: string;
    phase?: string;
    owner?: string;
    activation?: string;
    implementation_anchors?: string[];
    acceptance?: string[];
    completed_at?: string;
    requires_external?: boolean;
    local_work_complete?: boolean;
    provider_gates?: string[];
    completion_evidence?: MailchimpLocalClosureEvidence[];
  }>;
  provider_gates: Array<{
    id: string;
    label: string;
    detail: string;
    status: string;
    streams?: string[];
    evidence?: Record<string, unknown>;
  }>;
  local_closures?: MailchimpLocalClosure[];
  summary: Record<string, unknown>;
  generated_at: string;
}

export interface MailchimpLocalClosureEvidence {
  kind: string;
  label: string;
  anchor: string;
}

export interface MailchimpLocalClosure {
  task_id: string;
  stream: string;
  title: string;
  status: string;
  requires_external: boolean;
  local_work_complete: boolean;
  closed_without_user: boolean;
  provider_gates: string[];
  provider_gate_details: Array<{
    id: string;
    label?: string;
    status: string;
  }>;
  remaining_provider_gates: string[];
  evidence: MailchimpLocalClosureEvidence[];
}

export interface MailchimpLocalClosuresResponse {
  status: string;
  closures: MailchimpLocalClosure[];
  summary: Record<string, unknown>;
  generated_at: string;
}

export interface MailchimpCompatRequestOptions {
  signal?: AbortSignal;
  idempotencyKey?: string;
  requireOnline?: boolean;
  maxAttempts?: number;
}

function protectedReadOptions(options?: MailchimpCompatRequestOptions) {
  return { ...options, requireOnline: true, maxAttempts: 1 };
}

function protectedWriteOptions(options?: MailchimpCompatRequestOptions) {
  return { ...options, requireOnline: true, maxAttempts: 1 };
}

export function getMailchimpCompatSummary(
  options?: MailchimpCompatRequestOptions,
): Promise<MailchimpCompatSummary> {
  return api.get<MailchimpCompatSummary>(
    "/api/v1/mailchimp-compat/summary",
    protectedReadOptions(options),
  );
}

export function mailchimpCompatPath(path: string): string {
  const segments = path.split("/");
  if (
    segments.length === 0 ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new Error("Invalid Mailchimp compatibility resource path");
  }
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

export type MailchimpCompatResourcePath =
  | "groups"
  | "assets"
  | "sections"
  | "automations"
  | "landing-pages"
  | "popups"
  | "ecommerce/integrations";

export function listCompatResources<T = CompatResource>(
  path: MailchimpCompatResourcePath,
  options?: MailchimpCompatRequestOptions,
): Promise<T[]> {
  return api.get<T[]>(
    `/api/v1/mailchimp-compat/${mailchimpCompatPath(path)}`,
    protectedReadOptions(options),
  );
}

export function createCompatResource<T = CompatResource>(
  path: MailchimpCompatResourcePath,
  body: unknown,
  options?: MailchimpCompatRequestOptions,
): Promise<T> {
  return api.post<T>(
    `/api/v1/mailchimp-compat/${mailchimpCompatPath(path)}`,
    body,
    protectedWriteOptions(options),
  );
}

export function getCampaignReport(
  id: string,
  options?: MailchimpCompatRequestOptions,
): Promise<CampaignReport> {
  return api.get<CampaignReport>(
    `/api/v1/mailchimp-compat/campaigns/${encodeURIComponent(id)}/report`,
    protectedReadOptions(options),
  );
}

export function getCampaignPlanner(
  options?: MailchimpCompatRequestOptions,
): Promise<CampaignPlannerResponse> {
  return api.get<CampaignPlannerResponse>(
    "/api/mailchimp/3.0/campaign-manager/calendar",
    protectedReadOptions(options),
  );
}

export function getMultivariateTest(
  id: string,
  options?: MailchimpCompatRequestOptions,
): Promise<MultivariateTestResponse> {
  return api.get<MultivariateTestResponse>(
    `/api/mailchimp/3.0/campaigns/${encodeURIComponent(id)}/multivariate`,
    protectedReadOptions(options),
  );
}

export function getSendTimeOptimization(
  id: string,
  options?: MailchimpCompatRequestOptions,
): Promise<OptimizationResponse> {
  return api.get<OptimizationResponse>(
    `/api/mailchimp/3.0/campaigns/${encodeURIComponent(id)}/send-time-optimization`,
    protectedReadOptions(options),
  );
}

export function getSendDayOptimization(
  id: string,
  options?: MailchimpCompatRequestOptions,
): Promise<OptimizationResponse> {
  return api.get<OptimizationResponse>(
    `/api/mailchimp/3.0/campaigns/${encodeURIComponent(id)}/send-day-optimization`,
    protectedReadOptions(options),
  );
}

export function getClickMap(
  id: string,
  options?: MailchimpCompatRequestOptions,
): Promise<ClickMapResponse> {
  return api.get<ClickMapResponse>(
    `/api/mailchimp/3.0/reports/${encodeURIComponent(id)}/click-map`,
    protectedReadOptions(options),
  );
}

export const CUSTOM_REPORT_DEFAULT_METRICS = [
  "sent",
  "opened",
  "clicked",
  "revenue_cents",
];
export const CUSTOM_REPORT_DEFAULT_GROUP_BY = "campaign";

export function getCustomReport(
  opts?: {
    metrics?: string[];
    group_by?: string;
  },
  options?: MailchimpCompatRequestOptions,
): Promise<CustomReportResponse> {
  const metrics = opts?.metrics?.length
    ? opts.metrics
    : CUSTOM_REPORT_DEFAULT_METRICS;
  const groupBy = opts?.group_by || CUSTOM_REPORT_DEFAULT_GROUP_BY;
  return api.get<CustomReportResponse>("/api/mailchimp/3.0/reports/custom", {
    ...protectedReadOptions(options),
    query: {
      metrics: metrics.join(","),
      group_by: groupBy,
    },
  });
}

export function getDeliveryInsights(
  id: string,
  options?: MailchimpCompatRequestOptions,
): Promise<DeliveryInsightsResponse> {
  return api.get<DeliveryInsightsResponse>(
    `/api/mailchimp/3.0/campaigns/${encodeURIComponent(id)}/delivery-insights`,
    protectedReadOptions(options),
  );
}

export function cancelDelivery(
  id: string,
  options?: MailchimpCompatRequestOptions,
): Promise<DeliveryInsightsResponse> {
  return api.post<DeliveryInsightsResponse>(
    `/api/mailchimp/3.0/campaigns/${encodeURIComponent(id)}/delivery-insights/cancel`,
    {},
    protectedWriteOptions(options),
  );
}

export function getCampaignInbox(
  id: string,
  options?: MailchimpCompatRequestOptions,
): Promise<CampaignInboxResponse> {
  return api.get<CampaignInboxResponse>(
    `/api/mailchimp/3.0/campaigns/${encodeURIComponent(id)}/inbox`,
    protectedReadOptions(options),
  );
}

export function getMultiChannelReadiness(
  options?: MailchimpCompatRequestOptions,
): Promise<MultiChannelReadinessResponse> {
  return api.get<MultiChannelReadinessResponse>(
    "/api/mailchimp/3.0/growth/channels",
    protectedReadOptions(options),
  );
}

export function getSurveys(
  options?: MailchimpCompatRequestOptions,
): Promise<SurveysResponse> {
  return api.get<SurveysResponse>(
    "/api/mailchimp/3.0/surveys",
    protectedReadOptions(options),
  );
}

export function getLandingPageParity(
  options?: MailchimpCompatRequestOptions,
): Promise<LandingPageParityResponse> {
  return api.get<LandingPageParityResponse>(
    "/api/mailchimp/3.0/landing-pages/parity",
    protectedReadOptions(options),
  );
}

export function getWebsiteBuilderStatus(
  options?: MailchimpCompatRequestOptions,
): Promise<WebsiteBuilderStatusResponse> {
  return api.get<WebsiteBuilderStatusResponse>(
    "/api/mailchimp/3.0/website-builder",
    protectedReadOptions(options),
  );
}

export function getAudienceInsights(
  options?: MailchimpCompatRequestOptions,
): Promise<AudienceInsightsResponse> {
  return api.get<AudienceInsightsResponse>(
    "/api/mailchimp/3.0/audience/insights",
    protectedReadOptions(options),
  );
}

export function getAdvancedSegmentSchema(
  options?: MailchimpCompatRequestOptions,
): Promise<AdvancedSegmentSchemaResponse> {
  return api.get<AdvancedSegmentSchemaResponse>(
    "/api/mailchimp/3.0/segments/advanced/schema",
    protectedReadOptions(options),
  );
}

export function getContentStudio(
  options?: MailchimpCompatRequestOptions,
): Promise<ContentStudioResponse> {
  return api.get<ContentStudioResponse>(
    "/api/mailchimp/3.0/content-studio",
    protectedReadOptions(options),
  );
}

export function getBatches(
  options?: MailchimpCompatRequestOptions,
): Promise<BatchesResponse> {
  return api.get<BatchesResponse>(
    "/api/mailchimp/3.0/batches",
    protectedReadOptions(options),
  );
}

export function createBatch(
  body: {
    operations: Array<{
      method: string;
      path: string;
      operation_id?: string;
      body?: unknown;
    }>;
    callback_url?: string;
  },
  options?: MailchimpCompatRequestOptions,
): Promise<BatchResponse> {
  return api.post<BatchResponse>(
    "/api/mailchimp/3.0/batches",
    body,
    protectedWriteOptions(options),
  );
}

export function getAccountExports(
  options?: MailchimpCompatRequestOptions,
): Promise<AccountExportsResponse> {
  return api.get<AccountExportsResponse>(
    "/api/mailchimp/3.0/account-exports",
    protectedReadOptions(options),
  );
}

export function createAccountExport(
  body?: { sections?: string[] },
  options?: MailchimpCompatRequestOptions,
): Promise<AccountExport> {
  return api.post<AccountExport>(
    "/api/mailchimp/3.0/account-exports",
    body ?? {},
    protectedWriteOptions(options),
  );
}

export function getConnectedSites(
  options?: MailchimpCompatRequestOptions,
): Promise<ConnectedSitesResponse> {
  return api.get<ConnectedSitesResponse>(
    "/api/mailchimp/3.0/connected-sites",
    protectedReadOptions(options),
  );
}

export function getVerifiedDomains(
  options?: MailchimpCompatRequestOptions,
): Promise<VerifiedDomainsResponse> {
  return api.get<VerifiedDomainsResponse>(
    "/api/mailchimp/3.0/verified-domains",
    protectedReadOptions(options),
  );
}

export function getIntegrationMarketplace(
  options?: MailchimpCompatRequestOptions,
): Promise<IntegrationMarketplaceResponse> {
  return api.get<IntegrationMarketplaceResponse>(
    "/api/mailchimp/3.0/integration-marketplace",
    protectedReadOptions(options),
  );
}

export function getAgencyEcosystem(
  options?: MailchimpCompatRequestOptions,
): Promise<AgencyEcosystemResponse> {
  return api.get<AgencyEcosystemResponse>(
    "/api/mailchimp/3.0/agency-ecosystem",
    protectedReadOptions(options),
  );
}

export function getMailchimpParityWorkbench(
  options?: MailchimpCompatRequestOptions,
): Promise<MailchimpParityWorkbenchResponse> {
  return api.get<MailchimpParityWorkbenchResponse>(
    "/api/mailchimp/3.0/parity/workbench",
    protectedReadOptions(options),
  );
}

export function getMailchimpLocalClosures(
  options?: MailchimpCompatRequestOptions,
): Promise<MailchimpLocalClosuresResponse> {
  return api.get<MailchimpLocalClosuresResponse>(
    "/api/mailchimp/3.0/parity/local-closures",
    protectedReadOptions(options),
  );
}

export function applyMailchimpLocalClosures(
  options?: MailchimpCompatRequestOptions,
): Promise<MailchimpLocalClosuresResponse> {
  return api.post<MailchimpLocalClosuresResponse>(
    "/api/mailchimp/3.0/parity/local-closures/apply",
    {},
    protectedWriteOptions(options),
  );
}

export function getMailchimpBlockCatalog(
  options?: MailchimpCompatRequestOptions,
): Promise<MailchimpBlockCatalogResponse> {
  return api.get<MailchimpBlockCatalogResponse>(
    "/api/mailchimp/3.0/content-blocks",
    protectedReadOptions(options),
  );
}

export function generateCreativeAssistant(
  body: {
    goal?: string;
    channel?: string;
    audience?: string;
    tone?: string;
    offer?: string;
    brand_voice?: string;
    context?: Record<string, unknown>;
  },
  options?: MailchimpCompatRequestOptions,
): Promise<CreativeAssistantResponse> {
  return api.post<CreativeAssistantResponse>(
    "/api/mailchimp/3.0/creative-assistant/generate",
    body,
    protectedWriteOptions(options),
  );
}

export function runInlineAI(
  body: {
    channel?: string;
    mode?: string;
    text?: string;
    tone?: string;
    prompt?: string;
    context?: Record<string, unknown>;
  },
  options?: MailchimpCompatRequestOptions,
): Promise<InlineAIResponse> {
  return api.post<InlineAIResponse>(
    "/api/mailchimp/3.0/builder/ai",
    body,
    protectedWriteOptions(options),
  );
}

export function convertVideoForEmail(
  body: {
    url: string;
    title?: string;
    thumbnail_url?: string;
    alt_text?: string;
    cta?: string;
  },
  options?: MailchimpCompatRequestOptions,
): Promise<VideoConvertResponse> {
  return api.post<VideoConvertResponse>(
    "/api/mailchimp/3.0/videos/email-convert",
    body,
    protectedWriteOptions(options),
  );
}

export function previewMailchimpTemplate(
  body: {
    html?: string;
    text?: string;
    variables?: Record<string, unknown>;
  },
  options?: MailchimpCompatRequestOptions,
): Promise<TemplateLanguagePreviewResponse> {
  return api.post<TemplateLanguagePreviewResponse>(
    "/api/mailchimp/3.0/template-language/preview",
    body,
    protectedWriteOptions(options),
  );
}

export function recordCampaignEvent(
  id: string,
  body: {
    subscriber_email: string;
    event_type: string;
    link_url?: string;
    device?: string;
    client?: string;
    country?: string;
    revenue_cents?: number;
  },
  options?: MailchimpCompatRequestOptions,
): Promise<{ ok: true }> {
  return api.post<{ ok: true }>(
    `/api/v1/mailchimp-compat/campaigns/${encodeURIComponent(id)}/events`,
    body,
    protectedWriteOptions(options),
  );
}

export function pauseJourney(
  id: string,
  options?: MailchimpCompatRequestOptions,
): Promise<CompatResource> {
  return api.post<CompatResource>(
    `/api/v1/mailchimp-compat/automations/${encodeURIComponent(id)}/pause`,
    undefined,
    protectedWriteOptions(options),
  );
}

export function resumeJourney(
  id: string,
  options?: MailchimpCompatRequestOptions,
): Promise<CompatResource> {
  return api.post<CompatResource>(
    `/api/v1/mailchimp-compat/automations/${encodeURIComponent(id)}/resume`,
    undefined,
    protectedWriteOptions(options),
  );
}

export function syncDemoCommerce(
  id: string,
  options?: MailchimpCompatRequestOptions,
): Promise<MailchimpCompatSummary["ecommerce"]> {
  return api.post<MailchimpCompatSummary["ecommerce"]>(
    `/api/v1/mailchimp-compat/ecommerce/integrations/${encodeURIComponent(
      id,
    )}/sync-demo`,
    undefined,
    protectedWriteOptions(options),
  );
}

export function getPublicPopup(
  key: string,
  tenant?: string,
): Promise<PopupForm> {
  return api.get<PopupForm>(`/api/public/popups/${encodeURIComponent(key)}`, {
    query: { tenant },
    credentials: "omit",
  });
}

export function submitPublicPopup(
  key: string,
  body: { email: string; metadata?: Record<string, unknown> },
  tenant?: string,
): Promise<{ ok: true; popup_id: string }> {
  return api.post<{ ok: true; popup_id: string }>(
    `/api/public/popups/${encodeURIComponent(key)}/convert`,
    body,
    { query: { tenant }, credentials: "omit" },
  );
}
