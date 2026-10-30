// SPDX-License-Identifier: AGPL-3.0-only
//
// Migration domain types for the admin app.
//
// Keep in sync with `packages/schema/src/index.ts` (canonical TS) and the Go
// equivalents at `services/migration/internal/canonical/types.go` until codegen
// lands.

import type { SourcePlatform as SchemaSourcePlatform } from "@postwave/schema";

export type SourcePlatform = Exclude<SchemaSourcePlatform, "mailchimp_api">;

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

export interface VerificationReport {
  subscribers_imported: number;
  suppression_list_size: number;
  consent_known?: number;
  consent_unknown?: number;
  duplicate_subscribers_merged?: number;
  subscriber_merge_conflicts?: Array<{
    email: string;
    source_ids?: string[];
    tags?: string[];
    conflict_fields?: string[];
  }>;
  // MIGR-028: a small, redacted preview of how records will land (dry-run).
  sample_subscribers?: Array<{
    email: string;
    status: string;
    tags?: string[];
    source_id?: string;
    custom_fields?: Record<string, unknown>;
  }>;
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
  archive_imported: number;
  discovery_warnings?: string[];
  campaign_archive_warnings?: Array<{
    resource: string;
    source_id?: string;
    name?: string;
    warning: string;
  }>;
  templates_imported?: number;
  template_warnings?: Array<{
    resource: string;
    source_id?: string;
    name?: string;
    warning: string;
  }>;
  source_archive_imported?: number;
  source_archive_by_resource?: Record<string, number>;
  source_archive_warnings?: Array<{
    resource: string;
    source_id?: string;
    name?: string;
    warning: string;
  }>;
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

export interface PilotAcceptanceItem {
  key: string;
  label: string;
  status: "pass" | "warning" | "blocker";
  expected?: number;
  actual?: number;
  detail?: string;
  evidence?: string[];
}

export interface PilotAcceptanceReport {
  job_id: string;
  source: SourcePlatform;
  generated_at: string;
  status: "pass" | "warning" | "blocker";
  blockers: number;
  warnings: number;
  items: PilotAcceptanceItem[];
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
  // MIGR-037: operator-supplied name/annotation.
  label?: string | null;
  notes?: string | null;
}

export interface AdapterCapabilities {
  source: SourcePlatform;
  auth_method: "oauth2" | "api_key" | "csv_upload";
  intake_available?: boolean;
  intake_unavailable_code?: string;
  commit_available?: boolean;
  commit_unavailable_code?: string;
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

// Discovery report — what the source platform contains. Returned by the
// discovery phase before dry-run.
export interface DiscoveryReport {
  source: SourcePlatform;
  subscribers_count: number;
  /**
   * Source profiles excluded because they have no usable current primary
   * email. Provider-specific discovery notes define whether this is an exact
   * inventory or a stable-API boundary.
   */
  profiles_without_email_count?: number;
  /**
   * Exact HubSpot additional-email values discovered beyond the current
   * primary email. They remain non-sendable identity/reconciliation evidence
   * and are never materialized as independent Moosewave subscribers.
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
  archive_count: number;
  paid_subs_count: number;
  templates_count?: number;
  campaigns_count?: number;
  reports_count?: number;
  groups_count?: number;
  forms_count?: number;
  landing_pages_count?: number;
  ecommerce_count?: number;
  crm_count?: number;
  deals_count?: number;
  pipelines_count?: number;
  /**
   * Exact source object-type metadata count. Customer.io object profiles and
   * relationships require a separate provider export and are not represented.
   */
  custom_objects_count?: number;
  /** Exact Customer.io subscription-center channel-definition count. */
  subscription_channels_count?: number;
  sms_campaigns_count?: number;
  push_campaigns_count?: number;
  /**
   * Includes mandatory review records. Klaviyo has eight unconditional static
   * checklist rows; source_total=1 is one checklist, not detected inventory.
   */
  source_archive_count?: number;
  resource_metadata?: VerificationReport["resource_completeness"];
  custom_fields: string[];
  warnings: string[];
  audiences?: Array<{
    id: string;
    /**
     * Provider names may be absent. Klaviyo supplies deterministic
     * `Klaviyo list <id>` / `Klaviyo segment <id>` fallbacks.
     */
    name?: string;
    subscribers_total: number;
  }>;
}

export interface RollbackStatus {
  state: "pending" | "running" | "completed" | "failed";
  archive_deleted: number;
  archive_total: number;
  templates_deleted?: number;
  templates_total?: number;
  automations_deleted: number;
  automations_total: number;
  segments_deleted: number;
  segments_total: number;
  subscribers_deleted: number;
  subscribers_total: number;
  paid_subs_deleted?: number;
  paid_subs_total?: number;
  started_at: string;
  completed_at?: string;
  error?: string;
}

export interface AuditEntry {
  id: string;
  timestamp: string;
  event: string;
  actor: string;
  fields: Record<string, string | number | boolean | null>;
}

export const SOURCE_LABELS: Record<SourcePlatform, string> = {
  mailchimp: "Mailchimp",
  klaviyo: "Klaviyo",
  customerio: "Customer.io",
  "constant-contact": "Constant Contact",
  aweber: "AWeber",
  drip: "Drip",
  "campaign-monitor": "Campaign Monitor",
  omnisend: "Omnisend",
  loops: "Loops",
  flodesk: "Flodesk",
  bento: "Bento",
  activecampaign: "ActiveCampaign",
  convertkit: "ConvertKit",
  substack: "Substack",
  beehiiv: "Beehiiv",
  brevo: "Brevo",
  hubspot: "HubSpot",
  sendy: "Sendy CSV",
  mailerlite: "MailerLite",
  csv: "CSV upload",
};

export const MIGRATION_SOURCE_PLATFORMS = [
  "mailchimp",
  "klaviyo",
  "customerio",
  "constant-contact",
  "aweber",
  "drip",
  "campaign-monitor",
  "omnisend",
  "loops",
  "flodesk",
  "bento",
  "activecampaign",
  "convertkit",
  "substack",
  "beehiiv",
  "brevo",
  "hubspot",
  "sendy",
  "mailerlite",
  "csv",
] as const satisfies readonly SourcePlatform[];

export const TERMINAL_STATUSES: MigrationStatus[] = [
  "completed",
  "failed",
  "rolled_back",
];

export function isTerminal(status: MigrationStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
