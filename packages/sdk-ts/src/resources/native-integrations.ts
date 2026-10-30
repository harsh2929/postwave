// SPDX-License-Identifier: MIT
import { Resource } from "./_base.js";
import { integrationPathSegment } from "./integrations.js";
import { ServerError } from "../errors.js";
import type { PostwaveClient } from "../client.js";

export const SUPPORT_INTEGRATION_RUNTIME_HELD_CODE =
  "support_integration_runtime_held" as const;

function supportIntegrationRuntimeHeld(): ServerError {
  return new ServerError({
    status: 503,
    code: SUPPORT_INTEGRATION_RUNTIME_HELD_CODE,
    message:
      "Support-provider connection configuration, synchronization, ingestion, lifecycle mutations, and run history are release-held while Helpdesk privacy governance is incomplete.",
  });
}

const SUPPORT_INTEGRATION_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SUPPORT_INTEGRATION_UNSAFE_CURSOR_RE =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;

function supportIntegrationReadId(id: string): string {
  if (!SUPPORT_INTEGRATION_UUID_RE.test(id)) {
    throw new Error(
      "support integration id must be a lowercase canonical UUID",
    );
  }
  return id;
}

function supportIntegrationListQuery(
  options: SupportIntegrationListOptions,
): Record<string, string | number> | undefined {
  if (
    options.limit !== undefined &&
    (!Number.isSafeInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 100)
  ) {
    throw new Error("support integration limit must be from 1 through 100");
  }
  if (
    options.cursor !== undefined &&
    (typeof options.cursor !== "string" ||
      !options.cursor ||
      options.cursor !== options.cursor.trim() ||
      options.cursor.length > 4096 ||
      SUPPORT_INTEGRATION_UNSAFE_CURSOR_RE.test(options.cursor))
  ) {
    throw new Error("support integration cursor is invalid");
  }
  const query = {
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
  };
  return Object.keys(query).length === 0 ? undefined : query;
}

export type NativeIntegrationAuthMode =
  | "oauth"
  | "api_key"
  | "webhook_secret"
  | "credential_ref"
  | "service_account"
  | "manual";

export type NativeIntegrationFieldKind =
  | "string"
  | "url"
  | "secret"
  | "boolean"
  | "number"
  | "select"
  | "multi_select"
  | "json";

export interface NativeIntegrationProviderField {
  key: string;
  label: string;
  kind: NativeIntegrationFieldKind;
  required: boolean;
  help?: string;
  placeholder?: string;
  options?: Array<{ label: string; value: string }>;
}

export interface NativeIntegrationProviderSpec {
  key: string;
  name: string;
  category?: string;
  auth_modes?: NativeIntegrationAuthMode[];
  capabilities?: string[];
  sync_objects?: string[];
  sync_model?: string;
  verification_mode?: string;
  webhook_topics?: string[];
  required_scopes?: string[];
  fields?: NativeIntegrationProviderField[];
  docs_url?: string;
  setup_url?: string;
  oauth_authorize_url?: string;
  runtime_status?: string;
}

export interface NativeIntegrationProviderListResponse {
  items: NativeIntegrationProviderSpec[];
}

export interface NativeIntegration {
  id: string;
  tenant_id?: string;
  provider: string;
  name?: string;
  status: string;
  health_state?: string;
  health_message?: string;
  last_sync_at?: string | null;
  last_error?: string | null;
  scopes?: string[];
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface NativeIntegrationListResponse {
  items: NativeIntegration[];
}

export interface NativeIntegrationCreateInput {
  provider: string;
  name?: string;
  status?: string;
  config?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  credentials?: Record<string, unknown>;
  credentials_ref?: string;
  scopes?: string[];
  metadata?: Record<string, unknown>;
}

export interface NativeIntegrationLifecycleInput {
  run_mode?: string;
  cursor?: string;
  since?: string;
  full?: boolean;
  objects?: string[];
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface NativeIntegrationIngestInput {
  [key: string]: unknown;
}

export interface NativeIntegrationIngestResponse {
  status: string;
  run_id?: string;
  [key: string]: unknown;
}

export interface NativeIntegrationSyncSummary {
  profiles?: number;
  events?: number;
  lists?: number;
  segments?: number;
  orders?: number;
  products?: number;
  reviews?: number;
  subscriptions?: number;
  support_tickets?: number;
  errors?: number;
  [key: string]: number | undefined;
}

export interface NativeIntegrationLifecycleResponse {
  id?: string;
  status: string;
  action?: string;
  provider?: string;
  run_id?: string;
  started_at?: string;
  completed_at?: string | null;
  summary?: NativeIntegrationSyncSummary;
  message?: string;
}

export interface NativeIntegrationRun {
  id: string;
  integration_id?: string;
  provider?: string;
  action: string;
  status: string;
  attempts?: number;
  started_at?: string;
  completed_at?: string | null;
  duration_ms?: number;
  summary?: NativeIntegrationSyncSummary;
  error?: string | null;
}

export interface NativeIntegrationRunsResponse {
  items: NativeIntegrationRun[];
}

export interface AnalyticsProviderField {
  key: string;
  label: string;
  required?: boolean;
  secret?: boolean;
  help?: string;
}

export interface AnalyticsProviderSpec {
  provider: string;
  name: string;
  category: string;
  auth_mode: string;
  managed: boolean;
  runtime_status: string;
  sync_model?: string;
  verification_mode?: string;
  capabilities: string[];
  required_settings: AnalyticsProviderField[];
  optional_settings?: AnalyticsProviderField[];
  scopes: string[];
  sync_objects: string[];
  webhook_topics?: string[];
  docs_url: string;
}

export interface AnalyticsIntegration extends NativeIntegration {
  credentials_ref?: string;
  settings?: Record<string, unknown>;
  sync_cursor?: string;
  error_message?: string;
}

export interface AnalyticsIntegrationInput {
  provider: string;
  name?: string;
  status?: string;
  scopes?: string[];
  credentials_ref?: string;
  settings?: Record<string, unknown>;
}

export interface AnalyticsProfileInput {
  source_id?: string;
  email: string;
  user_id?: string;
  anonymous_id?: string;
  first_name?: string;
  last_name?: string;
  full_name?: string;
  phone?: string;
  traits?: Record<string, unknown>;
  updated_at?: string;
}

export interface AnalyticsEventInput {
  source_id?: string;
  email: string;
  user_id?: string;
  anonymous_id?: string;
  event_name: string;
  properties?: Record<string, unknown>;
  occurred_at?: string;
}

export interface AnalyticsSyncRequest {
  run_mode?:
    | "manual"
    | "scheduled"
    | "backfill"
    | "retry"
    | "dry_run"
    | "webhook"
    | string;
  profiles?: AnalyticsProfileInput[];
  events?: AnalyticsEventInput[];
  cursor?: string;
}

export interface AnalyticsSyncSummary {
  integration_id: string;
  run_id?: string;
  status: string;
  profiles_seen: number;
  profiles_upserted: number;
  events_seen: number;
  events_tracked: number;
  rows_failed: number;
  cursor?: string;
  error_message?: string;
}

export interface AnalyticsSyncRun {
  id: string;
  tenant_id?: string;
  integration_id?: string;
  run_mode: string;
  status: string;
  cursor_from?: string;
  cursor_to?: string;
  profiles_seen: number;
  profiles_upserted: number;
  events_seen: number;
  events_tracked: number;
  rows_failed: number;
  error_message?: string;
  metadata?: Record<string, unknown>;
  started_at: string;
  completed_at?: string | null;
  created_at: string;
}

export interface AnalyticsSyncRunsResponse {
  items: AnalyticsSyncRun[];
}

export interface ManagedProviderField {
  key: string;
  label: string;
  required?: boolean;
  secret?: boolean;
  help?: string;
}

export interface ManagedProviderSpec {
  provider: string;
  name: string;
  category: string;
  auth_mode: string;
  managed: boolean;
  runtime_status: string;
  sync_model?: string;
  verification_mode?: string;
  capabilities: string[];
  required_settings: ManagedProviderField[];
  optional_settings?: ManagedProviderField[];
  scopes: string[];
  sync_objects: string[];
  webhook_topics?: string[];
  docs_url: string;
}

export interface ManagedNativeIntegration extends NativeIntegration {
  credentials_ref?: string;
  settings?: Record<string, unknown>;
  sync_cursor?: string;
  error_message?: string;
}

export interface ManagedNativeIntegrationInput {
  provider: string;
  name?: string;
  status?: string;
  scopes?: string[];
  credentials_ref?: string;
  settings?: Record<string, unknown>;
}

export interface ReviewDisconnectCleanupEvidence {
  provider: string;
  status: string;
  recorded_at?: string;
  acknowledged_at?: string;
  acknowledged_by?: string;
  completed_actions?: string[];
  operator_notes?: string;
  postwave_status: string;
  provider_cleanup_posture: string;
  managed_provider_cleanup: boolean;
  provider_scope_type?: string;
  provider_scope_id?: string;
  credential_ref_present?: boolean;
  webhook_secret_ref_present?: boolean;
  tokenized_ingest_token_present?: boolean;
  webhook_cleanup_status: string;
  credential_cleanup_status: string;
  postwave_effects?: string[];
  provider_console_actions?: string[];
  provider_cleanup_evidence?: string[];
}

export interface ReviewDisconnectResponse {
  ok: boolean;
  provider_cleanup?: ReviewDisconnectCleanupEvidence;
}

export interface ReviewProviderCleanupAcknowledgementInput {
  completed_actions?: string[];
  notes?: string;
  acknowledged_by?: string;
}

export type ReviewProviderSpec = ManagedProviderSpec;
export type ReviewIntegration = ManagedNativeIntegration;
export type ReviewIntegrationInput = ManagedNativeIntegrationInput;

export type LeadProviderSpec = ManagedProviderSpec;
export type LeadIntegration = ManagedNativeIntegration;
export type LeadIntegrationInput = ManagedNativeIntegrationInput;

export interface LeadDisconnectCleanupEvidence {
  provider: string;
  status: string;
  recorded_at?: string;
  postwave_status: string;
  provider_cleanup_posture: string;
  managed_provider_cleanup: boolean;
  cleanup_kind?: string;
  provider_scope_type?: string;
  provider_scope_id?: string;
  provider_webhook_id?: string;
  previous_provider_webhook_id?: string;
  endpoint?: string;
  deleted?: boolean;
  not_found?: boolean;
  skipped?: boolean;
  skip_reason?: string;
  cleanup_reason?: string;
  fields?: string[];
  credential_ref_present?: boolean;
  webhook_secret_ref_present?: boolean;
  webhook_cleanup_status: string;
  credential_cleanup_status: string;
  postwave_effects?: string[];
  provider_console_actions?: string[];
  provider_cleanup_evidence?: string[];
}

export interface LeadDisconnectResponse {
  ok: boolean;
  provider_cleanup?: LeadDisconnectCleanupEvidence;
}

export type SubscriptionProviderSpec = ManagedProviderSpec;
export type SubscriptionIntegration = ManagedNativeIntegration;
export type SubscriptionIntegrationInput = ManagedNativeIntegrationInput;

export interface SubscriptionDisconnectCleanupEvidence {
  provider: string;
  status: string;
  recorded_at?: string;
  acknowledged_at?: string;
  acknowledged_by?: string;
  completed_actions?: string[];
  operator_notes?: string;
  postwave_status: string;
  provider_cleanup_posture: string;
  managed_provider_cleanup: boolean;
  provider_scope_type?: string;
  provider_scope_id?: string;
  provider_webhook_id?: string;
  credential_ref_present?: boolean;
  webhook_secret_ref_present?: boolean;
  tokenized_ingest_token_present?: boolean;
  webhook_cleanup_status: string;
  credential_cleanup_status: string;
  postwave_effects?: string[];
  provider_console_actions?: string[];
  provider_cleanup_evidence?: string[];
}

export interface SubscriptionDisconnectResponse {
  ok: boolean;
  provider_cleanup?: SubscriptionDisconnectCleanupEvidence;
}

export interface SubscriptionProviderCleanupAcknowledgementInput {
  completed_actions?: string[];
  notes?: string;
  acknowledged_by?: string;
}

export interface LeadSubmissionInput {
  source_id?: string;
  email: string;
  first_name?: string;
  last_name?: string;
  full_name?: string;
  phone?: string;
  company?: string;
  form_id?: string;
  form_name?: string;
  event_name?: string;
  tags?: string[];
  fields?: Record<string, unknown>;
  submitted_at?: string;
}

export interface LeadSyncRequest {
  run_mode?:
    | "manual"
    | "scheduled"
    | "backfill"
    | "retry"
    | "dry_run"
    | "webhook"
    | string;
  submissions?: LeadSubmissionInput[];
  cursor?: string;
}

export interface LeadSyncSummary {
  integration_id: string;
  run_id?: string;
  status: string;
  submissions_seen: number;
  subscribers_upserted: number;
  events_tracked: number;
  rows_failed: number;
  cursor?: string;
  error_message?: string;
}

export interface LeadSyncRun {
  id: string;
  tenant_id?: string;
  integration_id?: string;
  run_mode: string;
  status: string;
  cursor_from?: string;
  cursor_to?: string;
  submissions_seen: number;
  subscribers_upserted: number;
  events_tracked: number;
  rows_failed: number;
  error_message?: string;
  metadata?: Record<string, unknown>;
  started_at: string;
  completed_at?: string | null;
  created_at: string;
}

export interface LeadSyncRunsResponse {
  items: LeadSyncRun[];
}

export interface SubscriptionInput {
  source_id?: string;
  email: string;
  customer_id?: string;
  subscription_id?: string;
  status?: string;
  product_id?: string;
  sku?: string;
  next_charge_at?: string;
  cancelled_at?: string;
  frequency?: string;
  properties?: Record<string, unknown>;
  updated_at?: string;
}

export interface SubscriptionShipmentInput {
  source_id?: string;
  email: string;
  order_id?: string;
  tracking_number?: string;
  carrier?: string;
  status?: string;
  eta?: string;
  delivered_at?: string;
  properties?: Record<string, unknown>;
  updated_at?: string;
}

export interface SubscriptionLifecycleEventInput {
  source_id?: string;
  email: string;
  event_name: string;
  subscription_id?: string;
  order_id?: string;
  tracking_number?: string;
  status?: string;
  properties?: Record<string, unknown>;
  occurred_at?: string;
}

export interface SubscriptionSyncRequest {
  run_mode?:
    | "manual"
    | "scheduled"
    | "backfill"
    | "retry"
    | "dry_run"
    | "webhook"
    | string;
  subscriptions?: SubscriptionInput[];
  shipments?: SubscriptionShipmentInput[];
  events?: SubscriptionLifecycleEventInput[];
  cursor?: string;
}

export interface SubscriptionSyncSummary {
  integration_id: string;
  run_id?: string;
  status: string;
  subscriptions_seen: number;
  subscriptions_upserted: number;
  shipments_seen: number;
  shipments_upserted: number;
  events_seen: number;
  events_tracked: number;
  rows_failed: number;
  cursor?: string;
  error_message?: string;
}

export interface SubscriptionSyncRun {
  id: string;
  tenant_id?: string;
  integration_id?: string;
  run_mode: string;
  status: string;
  cursor_from?: string;
  cursor_to?: string;
  subscriptions_seen: number;
  subscriptions_upserted: number;
  shipments_seen: number;
  shipments_upserted: number;
  events_seen: number;
  events_tracked: number;
  rows_failed: number;
  error_message?: string;
  metadata?: Record<string, unknown>;
  started_at: string;
  completed_at?: string | null;
  created_at: string;
}

export interface SubscriptionSyncRunsResponse {
  items: SubscriptionSyncRun[];
}

export interface ReviewInput {
  source_id?: string;
  product_id?: string;
  variant_id?: string;
  order_id?: string;
  customer_id?: string;
  reviewer_name?: string;
  reviewer_email?: string;
  rating: number;
  title?: string;
  body?: string;
  review_type?: string;
  status?: string;
  verified_buyer?: boolean;
  incentivized?: boolean;
  featured?: boolean;
  event_name?: string;
  metadata?: Record<string, unknown>;
  raw_payload?: Record<string, unknown>;
  submitted_at?: string;
}

export interface ReviewSyncRequest {
  run_mode?:
    | "manual"
    | "scheduled"
    | "backfill"
    | "retry"
    | "dry_run"
    | "webhook"
    | string;
  reviews?: ReviewInput[];
  cursor?: string;
}

export interface ReviewSyncSummary {
  integration_id: string;
  run_id?: string;
  status: string;
  reviews_seen: number;
  reviews_imported: number;
  profiles_upserted: number;
  events_tracked: number;
  rows_failed: number;
  cursor?: string;
  error_message?: string;
}

export interface ReviewSyncRun {
  id: string;
  tenant_id?: string;
  integration_id?: string;
  run_mode: string;
  status: string;
  cursor_from?: string;
  cursor_to?: string;
  reviews_seen: number;
  reviews_imported: number;
  profiles_upserted: number;
  events_tracked: number;
  rows_failed: number;
  error_message?: string;
  metadata?: Record<string, unknown>;
  started_at: string;
  completed_at?: string | null;
  created_at: string;
}

export interface ReviewSyncRunsResponse {
  items: ReviewSyncRun[];
}

export type LoyaltyProviderSpec = ManagedProviderSpec;
export type LoyaltyIntegration = ManagedNativeIntegration;
export type LoyaltyIntegrationInput = ManagedNativeIntegrationInput;

export interface LoyaltyDisconnectCleanupEvidence {
  provider: string;
  status: string;
  recorded_at?: string;
  acknowledged_at?: string;
  acknowledged_by?: string;
  completed_actions?: string[];
  operator_notes?: string;
  postwave_status: string;
  provider_cleanup_posture: string;
  managed_provider_cleanup: boolean;
  account_id?: string;
  webhook_secret_ref_present?: boolean;
  webhook_cleanup_status: string;
  credential_cleanup_status: string;
  postwave_effects?: string[];
  provider_console_actions?: string[];
  provider_cleanup_evidence?: string[];
}

export interface LoyaltyDisconnectResponse {
  ok: boolean;
  provider_cleanup?: LoyaltyDisconnectCleanupEvidence;
}

export interface LoyaltyProviderCleanupAcknowledgementInput {
  completed_actions?: string[];
  notes?: string;
  acknowledged_by?: string;
}

export interface LoyaltyMemberInput {
  source_id?: string;
  email: string;
  first_name?: string;
  last_name?: string;
  full_name?: string;
  phone?: string;
  points_balance?: number;
  points_earned?: number;
  vip_tier?: string;
  referral_code?: string;
  rewards_count?: number;
  properties?: Record<string, unknown>;
  updated_at?: string;
}

export interface LoyaltyEventInput {
  source_id?: string;
  email: string;
  event_name: string;
  points?: number;
  reward_id?: string;
  reward_name?: string;
  vip_tier?: string;
  properties?: Record<string, unknown>;
  occurred_at?: string;
}

export interface LoyaltySyncRequest {
  run_mode?:
    | "manual"
    | "scheduled"
    | "backfill"
    | "retry"
    | "dry_run"
    | "webhook"
    | string;
  members?: LoyaltyMemberInput[];
  events?: LoyaltyEventInput[];
  cursor?: string;
}

export interface LoyaltySyncSummary {
  integration_id: string;
  run_id?: string;
  status: string;
  members_seen: number;
  members_upserted: number;
  events_seen: number;
  events_tracked: number;
  rows_failed: number;
  cursor?: string;
  error_message?: string;
}

export interface LoyaltySyncRun {
  id: string;
  tenant_id?: string;
  integration_id?: string;
  run_mode: string;
  status: string;
  cursor_from?: string;
  cursor_to?: string;
  members_seen: number;
  members_upserted: number;
  events_seen: number;
  events_tracked: number;
  rows_failed: number;
  error_message?: string;
  metadata?: Record<string, unknown>;
  started_at: string;
  completed_at?: string | null;
  created_at: string;
}

export interface LoyaltySyncRunsResponse {
  items: LoyaltySyncRun[];
}

export interface CRMContactInput {
  source_id?: string;
  email: string;
  first_name?: string;
  last_name?: string;
  full_name?: string;
  phone?: string;
  company?: string;
  lifecycle_stage?: string;
  list_ids?: string[];
  tags?: string[];
  properties?: Record<string, unknown>;
  updated_at?: string;
}

export interface CRMEventInput {
  source_id?: string;
  email: string;
  event_name: string;
  properties?: Record<string, unknown>;
  occurred_at?: string;
}

export interface CRMSyncRequest {
  run_mode?: "manual" | "scheduled" | "backfill" | "retry" | "dry_run" | string;
  contacts?: CRMContactInput[];
  events?: CRMEventInput[];
  cursor?: string;
}

export interface CRMSyncSummary {
  integration_id: string;
  run_id?: string;
  status: string;
  contacts_seen: number;
  contacts_upserted: number;
  events_seen: number;
  events_tracked: number;
  rows_failed: number;
  cursor?: string;
  error_message?: string;
}

export interface CRMSyncRun {
  id: string;
  tenant_id?: string;
  integration_id?: string;
  run_mode: string;
  status: string;
  cursor_from?: string;
  cursor_to?: string;
  contacts_seen: number;
  contacts_upserted: number;
  events_seen: number;
  events_tracked: number;
  rows_failed: number;
  error_message?: string;
  metadata?: Record<string, unknown>;
  started_at: string;
  completed_at?: string | null;
  created_at: string;
}

export interface CRMSyncRunsResponse {
  items: CRMSyncRun[];
}

export interface CRMDisconnectCleanupEvidence {
  provider: string;
  status: string;
  recorded_at?: string;
  postwave_status: string;
  provider_cleanup_posture: string;
  managed_provider_cleanup: boolean;
  provider_scope_type?: string;
  provider_scope_id?: string;
  endpoint?: string;
  provider_webhook_ids?: string[];
  deleted_provider_webhook_ids?: string[];
  oauth_revocation_status?: string;
  oauth_token_type?: string;
  oauth_revoked?: boolean;
  oauth_revocation_skipped?: boolean;
  oauth_revocation_skip_reason?: string;
  credential_ref_present?: boolean;
  webhook_cleanup_status: string;
  credential_cleanup_status: string;
  postwave_effects?: string[];
  provider_console_actions?: string[];
  provider_cleanup_evidence?: string[];
}

export interface CRMDisconnectResponse {
  ok: boolean;
  provider_cleanup?: CRMDisconnectCleanupEvidence;
  hubspot_oauth_revocation?: Record<string, unknown>;
  pipedrive_oauth_revocation?: Record<string, unknown>;
  salesforce_oauth_revocation?: Record<string, unknown>;
}

export interface CRMOAuthAvailability {
  available?: boolean;
  configured?: boolean;
  requires_session?: boolean;
  start_url?: string;
  [key: string]: unknown;
}

export type CRMOAuthProvider =
  | "pipedrive"
  | "hubspot"
  | "salesforce"
  | "zoho"
  | "dynamics365"
  | "keap"
  | "gohighlevel";

const CRM_OAUTH_PROVIDERS = new Set<string>([
  "pipedrive",
  "hubspot",
  "salesforce",
  "zoho",
  "dynamics365",
  "keap",
  "gohighlevel",
]);

function crmOAuthProviderPathSegment(provider: CRMOAuthProvider): string {
  const value = provider.trim().toLowerCase();
  if (!CRM_OAUTH_PROVIDERS.has(value)) {
    throw new Error(`Unsupported CRM OAuth provider: ${provider}`);
  }
  return encodeURIComponent(value);
}

export type CRMOAuthStartQuery = Record<
  string,
  string | number | boolean | null | undefined
>;

export interface KlaviyoMarketingOAuthAvailability {
  available?: boolean;
  configured?: boolean;
  requires_session?: boolean;
  start_url?: string;
  callback_url?: string;
  pkce?: boolean;
  [key: string]: unknown;
}

export type KlaviyoMarketingOAuthStartQuery = Record<
  string,
  string | number | boolean | null | undefined
>;

export interface MarketingDisconnectCleanupEvidence {
  provider: string;
  status: string;
  recorded_at?: string;
  acknowledged_at?: string;
  acknowledged_by?: string;
  completed_actions?: string[];
  operator_notes?: string;
  postwave_status: string;
  provider_cleanup_posture: string;
  managed_provider_cleanup: boolean;
  cleanup_kind?: string;
  provider_scope_type?: string;
  provider_scope_id?: string;
  provider_webhook_id?: string;
  endpoint?: string;
  deleted?: boolean;
  not_found?: boolean;
  skipped?: boolean;
  skip_reason?: string;
  cleanup_reason?: string;
  topics?: string[];
  credential_ref_present?: boolean;
  webhook_secret_ref_present?: boolean;
  credential_cleanup_status: string;
  webhook_cleanup_status: string;
  postwave_effects?: string[];
  provider_console_actions?: string[];
  provider_cleanup_evidence?: string[];
}

export interface MarketingDisconnectResponse {
  ok: boolean;
  provider_cleanup?: MarketingDisconnectCleanupEvidence;
}

export interface MarketingProviderCleanupAcknowledgementInput {
  completed_actions?: string[];
  notes?: string;
  acknowledged_by?: string;
}

export interface SupportTicketInput {
  source_id?: string;
  conversation_id?: string;
  email: string;
  requester_name?: string;
  subject?: string;
  status?: string;
  priority?: string;
  assignee?: string;
  tags?: string[];
  properties?: Record<string, unknown>;
  updated_at?: string;
}

export interface SupportMessageInput {
  source_id?: string;
  conversation_id?: string;
  email: string;
  requester_name?: string;
  subject?: string;
  direction?: "inbound" | "outbound" | "internal" | string;
  sender_type?: "customer" | "agent" | "system" | "ai" | string;
  sender?: string;
  body_text?: string;
  body_html?: string;
  properties?: Record<string, unknown>;
  occurred_at?: string;
}

export interface SupportEventInput {
  source_id?: string;
  email: string;
  event_name: string;
  conversation_id?: string;
  ticket_id?: string;
  status?: string;
  properties?: Record<string, unknown>;
  occurred_at?: string;
}

export interface SupportSyncRequest {
  run_mode?:
    | "manual"
    | "scheduled"
    | "backfill"
    | "retry"
    | "dry_run"
    | "webhook"
    | string;
  tickets?: SupportTicketInput[];
  messages?: SupportMessageInput[];
  events?: SupportEventInput[];
  cursor?: string;
}

export interface SupportSyncSummary {
  integration_id: string;
  run_id?: string;
  status: string;
  tickets_seen: number;
  tickets_upserted: number;
  messages_seen: number;
  messages_upserted: number;
  profiles_upserted: number;
  events_seen: number;
  events_tracked: number;
  rows_failed: number;
  cursor?: string;
  error_message?: string;
}

export interface SupportProviderCatalogItem {
  key: string;
  name: string;
  runtime_status: "held";
  hold_code: typeof SUPPORT_INTEGRATION_RUNTIME_HELD_CODE;
}

export interface SupportProviderCatalogResponse {
  items: SupportProviderCatalogItem[];
  complete: true;
  provenance: {
    tenant_bound: false;
    source: "static_server_catalog";
  };
}

export interface SupportIntegrationProjection {
  tenantId: string;
  tenant_id: string;
  id: string;
  provider: string;
  name: string;
  status: string;
  runtime_status: "held";
  hold_code: typeof SUPPORT_INTEGRATION_RUNTIME_HELD_CODE;
  credential_configured: boolean;
  created_at: string;
  updated_at: string;
}

export interface SupportIntegrationListOptions {
  limit?: number;
  cursor?: string;
}

export interface SupportIntegrationListResponse {
  tenantId: string;
  items: SupportIntegrationProjection[];
  page: {
    has_more: boolean;
    next_cursor: string | null;
    as_of: string;
    consistency: "mutable_window";
    may_reorder: true;
  };
}

export interface SupportSyncRun {
  tenantId: string;
  tenant_id: string;
  id: string;
  integration_id: string;
  run_mode: string;
  status: string;
  tickets_seen: number;
  tickets_upserted: number;
  messages_seen: number;
  messages_upserted: number;
  rows_failed: number;
  error_omitted: boolean;
  started_at: string;
  completed_at?: string | null;
  created_at: string;
}

export interface SupportSyncRunsResponse {
  tenantId: string;
  items: SupportSyncRun[];
  page: {
    has_more: boolean;
    truncated: boolean;
    limit: number;
    as_of: string;
    consistency: "latest_capped_window";
    may_reorder: true;
  };
}

export interface SupportDisconnectCleanupEvidence {
  provider: string;
  status: string;
  recorded_at?: string;
  postwave_status: string;
  provider_cleanup_posture: string;
  managed_provider_cleanup: boolean;
  provider_scope_type?: string;
  provider_scope_id?: string;
  provider_webhook_id?: string;
  credential_ref_present?: boolean;
  webhook_secret_ref_present?: boolean;
  webhook_cleanup_status: string;
  credential_cleanup_status: string;
  postwave_effects?: string[];
  provider_console_actions?: string[];
  provider_cleanup_evidence?: string[];
}

export interface SupportDisconnectResponse {
  ok: boolean;
  provider_cleanup?: SupportDisconnectCleanupEvidence;
}

export interface CommerceNativeIntegration extends NativeIntegration {
  shop_domain?: string;
  settings?: Record<string, unknown>;
  sync_cursor?: string;
  sync_state?: Record<string, unknown> | null;
  error_message?: string;
}

export interface CommerceDisconnectCleanupEvidence {
  provider: string;
  status: string;
  recorded_at?: string;
  postwave_status: string;
  provider_cleanup_posture: string;
  managed_provider_cleanup: boolean;
  provider_scope_type?: string;
  provider_scope_id?: string;
  webhook_endpoint?: string;
  webhook_ids?: string[];
  credential_ref_present?: boolean;
  webhook_secret_ref_present?: boolean;
  webhook_cleanup_status: string;
  credential_cleanup_status: string;
  postwave_effects?: string[];
  provider_console_actions?: string[];
  provider_cleanup_evidence?: string[];
}

export interface CommerceDisconnectResponse {
  ok: boolean;
  provider_cleanup?: CommerceDisconnectCleanupEvidence;
}

export interface CommerceNativeProviderField {
  key: string;
  label: string;
  required?: boolean;
  secret?: boolean;
  help?: string;
}

export interface CommerceNativeProviderSpec {
  provider: string;
  name: string;
  category: string;
  auth_mode: string;
  managed: boolean;
  runtime_status: string;
  sync_model?: string;
  verification_mode?: string;
  capabilities: string[];
  required_settings: CommerceNativeProviderField[];
  optional_settings?: CommerceNativeProviderField[];
  scopes: string[];
  webhook_topics?: string[];
  sync_objects: string[];
  docs_url: string;
}

export interface CommerceNativeProviderListResponse {
  items: CommerceNativeProviderSpec[];
}

export interface CommerceNativeIntegrationCreateInput {
  provider: string;
  shop_domain?: string;
  status?: string;
  scopes?: string[];
  settings?: Record<string, unknown>;
  credential_ref?: string;
}

export interface CommerceNativeSyncInput {
  customers?: Array<Record<string, unknown>>;
  products?: Array<Record<string, unknown>>;
  product_deletions?: Array<Record<string, unknown>>;
  orders?: Array<Record<string, unknown>>;
  provider_events?: Array<Record<string, unknown>>;
  cursor?: string;
}

export interface CommerceNativeSyncSummary {
  customers_upserted: number;
  products_upserted: number;
  products_deleted?: number;
  orders_upserted: number;
  events_recorded?: number;
  cursor?: string;
}

export interface WarehouseNativeConnection {
  id: string;
  tenant_id?: string;
  name: string;
  provider: string;
  direction: string;
  status: string;
  credentials_ref?: string;
  config?: Record<string, unknown>;
  object_selection: string[];
  cadence: string;
  backfill_days: number;
  last_cursor?: string;
  error?: string;
  created_at?: string;
  updated_at?: string;
}

export interface WarehouseNativeConnectionInput {
  name: string;
  provider: string;
  direction?: string;
  status?: string;
  credentials_ref?: string;
  config?: Record<string, unknown>;
  object_selection?: string[];
  cadence?: string;
  backfill_days?: number;
}

export interface WarehouseNativeRunInput {
  direction?: "export" | "import" | string;
  run_mode?: "manual" | "scheduled" | "backfill" | "retry" | "dry_run" | string;
  object_selection?: string[];
  input_uri?: string;
  import_rows?: Array<Record<string, unknown>>;
}

export interface WarehouseNativeRun {
  id: string;
  connection_id?: string;
  direction: string;
  run_mode: string;
  status: string;
  object_selection?: string[];
  input_uri?: string;
  output_uri?: string;
  cursor_from?: string;
  cursor_to?: string;
  rows_scanned?: number;
  rows_exported?: number;
  rows_imported?: number;
  rows_failed?: number;
  schema_errors?: number;
  retry_count?: number;
  metrics?: Record<string, unknown>;
  error?: string;
  started_at?: string | null;
  completed_at?: string | null;
}

export interface WarehouseNativeRunsResponse {
  items: WarehouseNativeRun[];
}

export interface WarehouseNativeHealth {
  connection_id: string;
  provider: string;
  status: string;
  health: string;
  last_run_status?: string;
  last_run_at?: string | null;
  error?: string;
  missing_required_settings?: string[];
  warnings?: string[];
  provider_runtime_status?: string;
  provider_driver_attachment?: string;
  provider_health?: WarehouseNativeProviderHealth;
}

export interface WarehouseNativeProviderJobStatement {
  order: number;
  phase: string;
  object?: string;
  table?: string;
  sql: string;
  executable: boolean;
}

export interface WarehouseNativeProviderHealth {
  provider: string;
  state: string;
  live_state?: string;
  execution_mode?: string;
  message?: string;
  executable: boolean;
  missing_required_settings?: string[];
  statements?: WarehouseNativeProviderJobStatement[];
  statements_executed?: number;
  warnings?: string[];
  error?: string;
}

export interface WarehouseNativeHealthOptions {
  provider_check?: boolean;
}

export interface WarehouseProviderCleanupEvidence {
  provider: string;
  status: string;
  recorded_at?: string;
  acknowledged_at?: string;
  acknowledged_by?: string;
  completed_actions?: string[];
  operator_notes?: string;
  postwave_status?: string;
  provider_cleanup_posture: string;
  managed_provider_cleanup: boolean;
  provider_scope_type?: string;
  provider_scope_id?: string;
  credential_ref_present?: boolean;
  postwave_effects?: string[];
  provider_console_actions?: string[];
  provider_cleanup_evidence?: string[];
}

export interface WarehouseProviderCleanupAcknowledgementInput {
  completed_actions?: string[];
  notes?: string;
  acknowledged_by?: string;
}

export interface WarehouseProviderCleanupAcknowledgementResponse {
  ok: boolean;
  provider_cleanup?: WarehouseProviderCleanupEvidence;
}

export interface NativeIntegrationFamilyPaths {
  providers: string;
  integrations: string;
  ingest?: boolean;
}

export class NativeIntegrationFamilyResource extends Resource {
  private readonly paths: NativeIntegrationFamilyPaths;

  constructor(client: PostwaveClient, paths: NativeIntegrationFamilyPaths) {
    super(client);
    this.paths = paths;
  }

  providers(): Promise<NativeIntegrationProviderListResponse> {
    return this.client.request("GET", this.paths.providers);
  }

  list(): Promise<NativeIntegrationListResponse> {
    return this.client.request("GET", this.paths.integrations);
  }

  create(input: NativeIntegrationCreateInput): Promise<NativeIntegration> {
    return this.client.request("POST", this.paths.integrations, {
      body: input,
    });
  }

  get(id: string): Promise<NativeIntegration> {
    return this.client.request(
      "GET",
      `${this.paths.integrations}/${integrationPathSegment(id, "native integration id")}`,
    );
  }

  sync(
    id: string,
    input: NativeIntegrationLifecycleInput = {},
  ): Promise<NativeIntegrationLifecycleResponse> {
    return this.client.request(
      "POST",
      `${this.paths.integrations}/${integrationPathSegment(id, "native integration id")}/sync`,
      { body: input },
    );
  }

  backfill(
    id: string,
    input: NativeIntegrationLifecycleInput = {},
  ): Promise<NativeIntegrationLifecycleResponse> {
    return this.client.request(
      "POST",
      `${this.paths.integrations}/${integrationPathSegment(id, "native integration id")}/backfill`,
      { body: input },
    );
  }

  ingest(
    id: string,
    input: NativeIntegrationIngestInput,
  ): Promise<NativeIntegrationIngestResponse> {
    if (this.paths.ingest !== true) {
      throw new Error("native integration family does not support ingest");
    }
    return this.client.request(
      "POST",
      `${this.paths.integrations}/${integrationPathSegment(id, "native integration id")}/ingest`,
      { body: input },
    );
  }

  pause(id: string): Promise<NativeIntegrationLifecycleResponse> {
    return this.client.request(
      "POST",
      `${this.paths.integrations}/${integrationPathSegment(id, "native integration id")}/pause`,
    );
  }

  disconnect(id: string): Promise<NativeIntegrationLifecycleResponse> {
    return this.client.request(
      "DELETE",
      `${this.paths.integrations}/${integrationPathSegment(id, "native integration id")}`,
    );
  }

  runs(id: string, limit = 25): Promise<NativeIntegrationRunsResponse> {
    return this.client.request(
      "GET",
      `${this.paths.integrations}/${integrationPathSegment(id, "native integration id")}/runs`,
      { query: { limit } },
    );
  }
}

export class MarketingNativeIntegrationsResource extends NativeIntegrationFamilyResource {
  acknowledgeProviderCleanup(
    id: string,
    input: MarketingProviderCleanupAcknowledgementInput,
  ): Promise<MarketingDisconnectResponse> {
    return this.client.request(
      "POST",
      `/api/v1/marketing-integrations/${integrationPathSegment(id, "native marketing integration id")}/provider-cleanup/acknowledge`,
      { body: input },
    );
  }

  klaviyoOAuthAvailability(): Promise<KlaviyoMarketingOAuthAvailability> {
    return this.client.request(
      "GET",
      "/api/v1/marketing-integrations/klaviyo/oauth/availability",
    );
  }

  klaviyoOAuthStartUrl(query: KlaviyoMarketingOAuthStartQuery = {}): string {
    const path = "/api/v1/marketing-integrations/klaviyo/oauth/start";
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      params.set(key, String(value));
    }
    const encoded = params.toString();
    return encoded ? `${path}?${encoded}` : path;
  }
}

export class CommerceNativeIntegrationsResource extends Resource {
  providers(): Promise<CommerceNativeProviderListResponse> {
    return this.client.request("GET", "/api/v1/commerce/providers");
  }

  list(): Promise<CommerceNativeIntegration[]> {
    return this.client.request("GET", "/api/v1/commerce/integrations");
  }

  create(
    input: CommerceNativeIntegrationCreateInput,
  ): Promise<CommerceNativeIntegration> {
    return this.client.request("POST", "/api/v1/commerce/integrations", {
      body: input,
    });
  }

  get(id: string): Promise<CommerceNativeIntegration> {
    return this.client.request(
      "GET",
      `/api/v1/commerce/integrations/${integrationPathSegment(id, "commerce integration id")}`,
    );
  }

  sync(
    id: string,
    input: CommerceNativeSyncInput,
  ): Promise<CommerceNativeSyncSummary> {
    return this.client.request(
      "POST",
      `/api/v1/commerce/integrations/${integrationPathSegment(id, "commerce integration id")}/sync`,
      { body: input },
    );
  }

  backfill(
    id: string,
    input: CommerceNativeSyncInput,
  ): Promise<CommerceNativeSyncSummary> {
    return this.client.request(
      "POST",
      `/api/v1/commerce/integrations/${integrationPathSegment(id, "commerce integration id")}/backfill`,
      { body: input },
    );
  }

  pause(id: string): Promise<CommerceNativeIntegration> {
    return this.client.request(
      "POST",
      `/api/v1/commerce/integrations/${integrationPathSegment(id, "commerce integration id")}/pause`,
    );
  }

  disconnect(id: string): Promise<CommerceDisconnectResponse> {
    return this.client.request(
      "DELETE",
      `/api/v1/commerce/integrations/${integrationPathSegment(id, "commerce integration id")}`,
    );
  }
}

export class WarehouseNativeIntegrationsResource extends Resource {
  providers(): Promise<NativeIntegrationProviderListResponse> {
    return this.client.request("GET", "/api/v1/warehouse/providers");
  }

  list(status?: string): Promise<{ items: WarehouseNativeConnection[] }> {
    return this.client.request("GET", "/api/v1/warehouse/connections", {
      query: status ? { status } : undefined,
    });
  }

  create(
    input: WarehouseNativeConnectionInput,
  ): Promise<WarehouseNativeConnection> {
    return this.client.request("POST", "/api/v1/warehouse/connections", {
      body: input,
    });
  }

  get(id: string): Promise<WarehouseNativeConnection> {
    return this.client.request(
      "GET",
      `/api/v1/warehouse/connections/${integrationPathSegment(id, "native warehouse connection id")}`,
    );
  }

  health(
    id: string,
    options: WarehouseNativeHealthOptions = {},
  ): Promise<WarehouseNativeHealth> {
    return this.client.request(
      "GET",
      `/api/v1/warehouse/connections/${integrationPathSegment(id, "native warehouse connection id")}/health`,
      { query: options.provider_check ? { provider_check: true } : undefined },
    );
  }

  sync(
    id: string,
    input: WarehouseNativeRunInput = {},
  ): Promise<WarehouseNativeRun> {
    return this.client.request(
      "POST",
      `/api/v1/warehouse/connections/${integrationPathSegment(id, "native warehouse connection id")}/runs`,
      { body: { ...input, run_mode: input.run_mode ?? "manual" } },
    );
  }

  backfill(
    id: string,
    input: WarehouseNativeRunInput = {},
  ): Promise<WarehouseNativeRun> {
    return this.client.request(
      "POST",
      `/api/v1/warehouse/connections/${integrationPathSegment(id, "native warehouse connection id")}/runs`,
      { body: { ...input, run_mode: input.run_mode ?? "backfill" } },
    );
  }

  pause(id: string): Promise<WarehouseNativeConnection> {
    return this.client.request(
      "POST",
      `/api/v1/warehouse/connections/${integrationPathSegment(id, "native warehouse connection id")}/pause`,
    );
  }

  disconnect(id: string): Promise<void> {
    return this.client.request(
      "DELETE",
      `/api/v1/warehouse/connections/${integrationPathSegment(id, "native warehouse connection id")}`,
    );
  }

  acknowledgeProviderCleanup(
    id: string,
    input: WarehouseProviderCleanupAcknowledgementInput,
  ): Promise<WarehouseProviderCleanupAcknowledgementResponse> {
    return this.client.request(
      "POST",
      `/api/v1/warehouse/connections/${integrationPathSegment(id, "native warehouse connection id")}/provider-cleanup/acknowledge`,
      { body: input },
    );
  }

  runs(id: string, limit = 25): Promise<WarehouseNativeRunsResponse> {
    return this.client.request(
      "GET",
      `/api/v1/warehouse/connections/${integrationPathSegment(id, "native warehouse connection id")}/runs`,
      { query: { limit } },
    );
  }
}

export class AnalyticsNativeIntegrationsResource extends Resource {
  providers(): Promise<{ items: AnalyticsProviderSpec[] }> {
    return this.client.request(
      "GET",
      "/api/v1/analytics-integrations/providers",
    );
  }

  list(): Promise<{ items: AnalyticsIntegration[] }> {
    return this.client.request("GET", "/api/v1/analytics-integrations");
  }

  create(input: AnalyticsIntegrationInput): Promise<AnalyticsIntegration> {
    return this.client.request("POST", "/api/v1/analytics-integrations", {
      body: input,
    });
  }

  get(id: string): Promise<AnalyticsIntegration> {
    return this.client.request(
      "GET",
      `/api/v1/analytics-integrations/${integrationPathSegment(id, "native analytics integration id")}`,
    );
  }

  sync(id: string, input: AnalyticsSyncRequest): Promise<AnalyticsSyncSummary> {
    return this.client.request(
      "POST",
      `/api/v1/analytics-integrations/${integrationPathSegment(id, "native analytics integration id")}/sync`,
      { body: input },
    );
  }

  backfill(
    id: string,
    input: AnalyticsSyncRequest,
  ): Promise<AnalyticsSyncSummary> {
    return this.client.request(
      "POST",
      `/api/v1/analytics-integrations/${integrationPathSegment(id, "native analytics integration id")}/backfill`,
      { body: input },
    );
  }

  ingest(
    id: string,
    input: AnalyticsEventInput,
  ): Promise<AnalyticsSyncSummary> {
    return this.client.request(
      "POST",
      `/api/v1/analytics-integrations/${integrationPathSegment(id, "native analytics integration id")}/ingest`,
      { body: input },
    );
  }

  pause(id: string): Promise<AnalyticsIntegration> {
    return this.client.request(
      "POST",
      `/api/v1/analytics-integrations/${integrationPathSegment(id, "native analytics integration id")}/pause`,
    );
  }

  disconnect(id: string): Promise<{ ok: boolean }> {
    return this.client.request(
      "DELETE",
      `/api/v1/analytics-integrations/${integrationPathSegment(id, "native analytics integration id")}`,
    );
  }

  runs(id: string, limit = 25): Promise<AnalyticsSyncRunsResponse> {
    return this.client.request(
      "GET",
      `/api/v1/analytics-integrations/${integrationPathSegment(id, "native analytics integration id")}/runs`,
      { query: { limit } },
    );
  }
}

export class CRMNativeIntegrationsResource extends Resource {
  oauthAvailability(provider: CRMOAuthProvider): Promise<CRMOAuthAvailability> {
    return this.client.request(
      "GET",
      `/api/v1/crm/${crmOAuthProviderPathSegment(provider)}/oauth/availability`,
    );
  }

  oauthStartUrl(
    provider: CRMOAuthProvider,
    query: CRMOAuthStartQuery = {},
  ): string {
    const path = `/api/v1/crm/${crmOAuthProviderPathSegment(provider)}/oauth/start`;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      params.set(key, String(value));
    }
    const encoded = params.toString();
    return encoded ? `${path}?${encoded}` : path;
  }

  providers(): Promise<{ items: ManagedProviderSpec[] }> {
    return this.client.request("GET", "/api/v1/crm/providers");
  }

  list(): Promise<{ items: ManagedNativeIntegration[] }> {
    return this.client.request("GET", "/api/v1/crm/integrations");
  }

  create(
    input: ManagedNativeIntegrationInput,
  ): Promise<ManagedNativeIntegration> {
    return this.client.request("POST", "/api/v1/crm/integrations", {
      body: input,
    });
  }

  get(id: string): Promise<ManagedNativeIntegration> {
    return this.client.request(
      "GET",
      `/api/v1/crm/integrations/${integrationPathSegment(id, "CRM import integration id")}`,
    );
  }

  sync(id: string, input: CRMSyncRequest): Promise<CRMSyncSummary> {
    return this.client.request(
      "POST",
      `/api/v1/crm/integrations/${integrationPathSegment(id, "CRM import integration id")}/sync`,
      { body: input },
    );
  }

  backfill(id: string, input: CRMSyncRequest): Promise<CRMSyncSummary> {
    return this.client.request(
      "POST",
      `/api/v1/crm/integrations/${integrationPathSegment(id, "CRM import integration id")}/backfill`,
      { body: input },
    );
  }

  pause(id: string): Promise<ManagedNativeIntegration> {
    return this.client.request(
      "POST",
      `/api/v1/crm/integrations/${integrationPathSegment(id, "CRM import integration id")}/pause`,
    );
  }

  disconnect(id: string): Promise<CRMDisconnectResponse> {
    return this.client.request(
      "DELETE",
      `/api/v1/crm/integrations/${integrationPathSegment(id, "CRM import integration id")}`,
    );
  }

  runs(id: string, limit = 25): Promise<CRMSyncRunsResponse> {
    return this.client.request(
      "GET",
      `/api/v1/crm/integrations/${integrationPathSegment(id, "CRM import integration id")}/runs`,
      { query: { limit } },
    );
  }
}

export class SupportNativeIntegrationsResource extends Resource {
  providers(): Promise<SupportProviderCatalogResponse> {
    return this.client.request("GET", "/api/v1/support-integrations/providers");
  }

  list(
    options: SupportIntegrationListOptions = {},
  ): Promise<SupportIntegrationListResponse> {
    try {
      return this.client.request("GET", "/api/v1/support-integrations", {
        query: supportIntegrationListQuery(options),
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  create(
    input: ManagedNativeIntegrationInput,
  ): Promise<ManagedNativeIntegration> {
    void input;
    return Promise.reject(supportIntegrationRuntimeHeld());
  }

  get(id: string): Promise<SupportIntegrationProjection> {
    try {
      return this.client.request(
        "GET",
        `/api/v1/support-integrations/${supportIntegrationReadId(id)}`,
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }

  sync(id: string, input: SupportSyncRequest): Promise<SupportSyncSummary> {
    void id;
    void input;
    return Promise.reject(supportIntegrationRuntimeHeld());
  }

  backfill(id: string, input: SupportSyncRequest): Promise<SupportSyncSummary> {
    void id;
    void input;
    return Promise.reject(supportIntegrationRuntimeHeld());
  }

  ingest(id: string, input: SupportEventInput): Promise<SupportSyncSummary> {
    void id;
    void input;
    return Promise.reject(supportIntegrationRuntimeHeld());
  }

  pause(id: string): Promise<ManagedNativeIntegration> {
    void id;
    return Promise.reject(supportIntegrationRuntimeHeld());
  }

  disconnect(id: string): Promise<SupportDisconnectResponse> {
    void id;
    return Promise.reject(supportIntegrationRuntimeHeld());
  }

  runs(id: string, limit = 25): Promise<SupportSyncRunsResponse> {
    void id;
    void limit;
    return Promise.reject(supportIntegrationRuntimeHeld());
  }
}

export class LeadNativeIntegrationsResource extends Resource {
  providers(): Promise<{ items: LeadProviderSpec[] }> {
    return this.client.request("GET", "/api/v1/lead-integrations/providers");
  }

  list(): Promise<{ items: LeadIntegration[] }> {
    return this.client.request("GET", "/api/v1/lead-integrations");
  }

  create(input: LeadIntegrationInput): Promise<LeadIntegration> {
    return this.client.request("POST", "/api/v1/lead-integrations", {
      body: input,
    });
  }

  get(id: string): Promise<LeadIntegration> {
    return this.client.request(
      "GET",
      `/api/v1/lead-integrations/${integrationPathSegment(id, "lead ingest integration id")}`,
    );
  }

  sync(id: string, input: LeadSyncRequest): Promise<LeadSyncSummary> {
    return this.client.request(
      "POST",
      `/api/v1/lead-integrations/${integrationPathSegment(id, "lead ingest integration id")}/sync`,
      { body: input },
    );
  }

  backfill(id: string, input: LeadSyncRequest): Promise<LeadSyncSummary> {
    return this.client.request(
      "POST",
      `/api/v1/lead-integrations/${integrationPathSegment(id, "lead ingest integration id")}/backfill`,
      { body: input },
    );
  }

  ingest(id: string, input: LeadSubmissionInput): Promise<LeadSyncSummary> {
    return this.client.request(
      "POST",
      `/api/v1/lead-integrations/${integrationPathSegment(id, "lead ingest integration id")}/ingest`,
      { body: input },
    );
  }

  pause(id: string): Promise<LeadIntegration> {
    return this.client.request(
      "POST",
      `/api/v1/lead-integrations/${integrationPathSegment(id, "lead ingest integration id")}/pause`,
    );
  }

  disconnect(id: string): Promise<LeadDisconnectResponse> {
    return this.client.request(
      "DELETE",
      `/api/v1/lead-integrations/${integrationPathSegment(id, "lead ingest integration id")}`,
    );
  }

  runs(id: string, limit = 25): Promise<LeadSyncRunsResponse> {
    return this.client.request(
      "GET",
      `/api/v1/lead-integrations/${integrationPathSegment(id, "lead ingest integration id")}/runs`,
      { query: { limit } },
    );
  }
}

export class SubscriptionNativeIntegrationsResource extends Resource {
  providers(): Promise<{ items: SubscriptionProviderSpec[] }> {
    return this.client.request(
      "GET",
      "/api/v1/subscription-integrations/providers",
    );
  }

  list(): Promise<{ items: SubscriptionIntegration[] }> {
    return this.client.request("GET", "/api/v1/subscription-integrations");
  }

  create(
    input: SubscriptionIntegrationInput,
  ): Promise<SubscriptionIntegration> {
    return this.client.request("POST", "/api/v1/subscription-integrations", {
      body: input,
    });
  }

  get(id: string): Promise<SubscriptionIntegration> {
    return this.client.request(
      "GET",
      `/api/v1/subscription-integrations/${integrationPathSegment(id, "subscription ingest integration id")}`,
    );
  }

  sync(
    id: string,
    input: SubscriptionSyncRequest,
  ): Promise<SubscriptionSyncSummary> {
    return this.client.request(
      "POST",
      `/api/v1/subscription-integrations/${integrationPathSegment(id, "subscription ingest integration id")}/sync`,
      { body: input },
    );
  }

  backfill(
    id: string,
    input: SubscriptionSyncRequest,
  ): Promise<SubscriptionSyncSummary> {
    return this.client.request(
      "POST",
      `/api/v1/subscription-integrations/${integrationPathSegment(id, "subscription ingest integration id")}/backfill`,
      { body: input },
    );
  }

  ingest(
    id: string,
    input: SubscriptionLifecycleEventInput,
  ): Promise<SubscriptionSyncSummary> {
    return this.client.request(
      "POST",
      `/api/v1/subscription-integrations/${integrationPathSegment(id, "subscription ingest integration id")}/ingest`,
      { body: input },
    );
  }

  pause(id: string): Promise<SubscriptionIntegration> {
    return this.client.request(
      "POST",
      `/api/v1/subscription-integrations/${integrationPathSegment(id, "subscription ingest integration id")}/pause`,
    );
  }

  disconnect(id: string): Promise<SubscriptionDisconnectResponse> {
    return this.client.request(
      "DELETE",
      `/api/v1/subscription-integrations/${integrationPathSegment(id, "subscription ingest integration id")}`,
    );
  }

  acknowledgeProviderCleanup(
    id: string,
    input: SubscriptionProviderCleanupAcknowledgementInput,
  ): Promise<SubscriptionDisconnectResponse> {
    return this.client.request(
      "POST",
      `/api/v1/subscription-integrations/${integrationPathSegment(id, "subscription ingest integration id")}/provider-cleanup/acknowledge`,
      { body: input },
    );
  }

  runs(id: string, limit = 25): Promise<SubscriptionSyncRunsResponse> {
    return this.client.request(
      "GET",
      `/api/v1/subscription-integrations/${integrationPathSegment(id, "subscription ingest integration id")}/runs`,
      { query: { limit } },
    );
  }
}

export class ReviewNativeIntegrationsResource extends Resource {
  providers(): Promise<{ items: ReviewProviderSpec[] }> {
    return this.client.request("GET", "/api/v1/review-integrations/providers");
  }

  list(): Promise<{ items: ReviewIntegration[] }> {
    return this.client.request("GET", "/api/v1/review-integrations");
  }

  create(input: ReviewIntegrationInput): Promise<ReviewIntegration> {
    return this.client.request("POST", "/api/v1/review-integrations", {
      body: input,
    });
  }

  get(id: string): Promise<ReviewIntegration> {
    return this.client.request(
      "GET",
      `/api/v1/review-integrations/${integrationPathSegment(id, "native review integration id")}`,
    );
  }

  sync(id: string, input: ReviewSyncRequest): Promise<ReviewSyncSummary> {
    return this.client.request(
      "POST",
      `/api/v1/review-integrations/${integrationPathSegment(id, "native review integration id")}/sync`,
      { body: input },
    );
  }

  backfill(id: string, input: ReviewSyncRequest): Promise<ReviewSyncSummary> {
    return this.client.request(
      "POST",
      `/api/v1/review-integrations/${integrationPathSegment(id, "native review integration id")}/backfill`,
      { body: input },
    );
  }

  ingest(id: string, input: ReviewInput): Promise<ReviewSyncSummary> {
    return this.client.request(
      "POST",
      `/api/v1/review-integrations/${integrationPathSegment(id, "native review integration id")}/ingest`,
      { body: input },
    );
  }

  pause(id: string): Promise<ReviewIntegration> {
    return this.client.request(
      "POST",
      `/api/v1/review-integrations/${integrationPathSegment(id, "native review integration id")}/pause`,
    );
  }

  disconnect(id: string): Promise<ReviewDisconnectResponse> {
    return this.client.request(
      "DELETE",
      `/api/v1/review-integrations/${integrationPathSegment(id, "native review integration id")}`,
    );
  }

  acknowledgeProviderCleanup(
    id: string,
    input: ReviewProviderCleanupAcknowledgementInput,
  ): Promise<ReviewDisconnectResponse> {
    return this.client.request(
      "POST",
      `/api/v1/review-integrations/${integrationPathSegment(id, "native review integration id")}/provider-cleanup/acknowledge`,
      { body: input },
    );
  }

  runs(id: string, limit = 25): Promise<ReviewSyncRunsResponse> {
    return this.client.request(
      "GET",
      `/api/v1/review-integrations/${integrationPathSegment(id, "native review integration id")}/runs`,
      { query: { limit } },
    );
  }
}

export class LoyaltyNativeIntegrationsResource extends Resource {
  providers(): Promise<{ items: LoyaltyProviderSpec[] }> {
    return this.client.request("GET", "/api/v1/loyalty-integrations/providers");
  }

  list(): Promise<{ items: LoyaltyIntegration[] }> {
    return this.client.request("GET", "/api/v1/loyalty-integrations");
  }

  create(input: LoyaltyIntegrationInput): Promise<LoyaltyIntegration> {
    return this.client.request("POST", "/api/v1/loyalty-integrations", {
      body: input,
    });
  }

  get(id: string): Promise<LoyaltyIntegration> {
    return this.client.request(
      "GET",
      `/api/v1/loyalty-integrations/${integrationPathSegment(id, "native loyalty integration id")}`,
    );
  }

  sync(id: string, input: LoyaltySyncRequest): Promise<LoyaltySyncSummary> {
    return this.client.request(
      "POST",
      `/api/v1/loyalty-integrations/${integrationPathSegment(id, "native loyalty integration id")}/sync`,
      { body: input },
    );
  }

  backfill(id: string, input: LoyaltySyncRequest): Promise<LoyaltySyncSummary> {
    return this.client.request(
      "POST",
      `/api/v1/loyalty-integrations/${integrationPathSegment(id, "native loyalty integration id")}/backfill`,
      { body: input },
    );
  }

  ingest(id: string, input: LoyaltyEventInput): Promise<LoyaltySyncSummary> {
    return this.client.request(
      "POST",
      `/api/v1/loyalty-integrations/${integrationPathSegment(id, "native loyalty integration id")}/ingest`,
      { body: input },
    );
  }

  pause(id: string): Promise<LoyaltyIntegration> {
    return this.client.request(
      "POST",
      `/api/v1/loyalty-integrations/${integrationPathSegment(id, "native loyalty integration id")}/pause`,
    );
  }

  disconnect(id: string): Promise<LoyaltyDisconnectResponse> {
    return this.client.request(
      "DELETE",
      `/api/v1/loyalty-integrations/${integrationPathSegment(id, "native loyalty integration id")}`,
    );
  }

  acknowledgeProviderCleanup(
    id: string,
    input: LoyaltyProviderCleanupAcknowledgementInput,
  ): Promise<LoyaltyDisconnectResponse> {
    return this.client.request(
      "POST",
      `/api/v1/loyalty-integrations/${integrationPathSegment(id, "native loyalty integration id")}/provider-cleanup/acknowledge`,
      { body: input },
    );
  }

  runs(id: string, limit = 25): Promise<LoyaltySyncRunsResponse> {
    return this.client.request(
      "GET",
      `/api/v1/loyalty-integrations/${integrationPathSegment(id, "native loyalty integration id")}/runs`,
      { query: { limit } },
    );
  }
}

export class NativeIntegrationsResource {
  readonly commerce: CommerceNativeIntegrationsResource;
  readonly crm: CRMNativeIntegrationsResource;
  readonly lead: LeadNativeIntegrationsResource;
  readonly reviews: ReviewNativeIntegrationsResource;
  readonly loyalty: LoyaltyNativeIntegrationsResource;
  readonly subscriptions: SubscriptionNativeIntegrationsResource;
  readonly support: SupportNativeIntegrationsResource;
  readonly analytics: AnalyticsNativeIntegrationsResource;
  readonly marketing: MarketingNativeIntegrationsResource;
  readonly warehouse: WarehouseNativeIntegrationsResource;

  constructor(client: PostwaveClient) {
    this.commerce = new CommerceNativeIntegrationsResource(client);
    this.crm = new CRMNativeIntegrationsResource(client);
    this.lead = new LeadNativeIntegrationsResource(client);
    this.reviews = new ReviewNativeIntegrationsResource(client);
    this.loyalty = new LoyaltyNativeIntegrationsResource(client);
    this.subscriptions = new SubscriptionNativeIntegrationsResource(client);
    this.support = new SupportNativeIntegrationsResource(client);
    this.analytics = new AnalyticsNativeIntegrationsResource(client);
    this.marketing = new MarketingNativeIntegrationsResource(client, {
      providers: "/api/v1/marketing-integrations/providers",
      integrations: "/api/v1/marketing-integrations",
    });
    this.warehouse = new WarehouseNativeIntegrationsResource(client);
  }
}
