// Canonical migration schema. Every adapter normalizes source-platform data
// into these types. Consumers (services/migration, apps/web) import from here.
//
// Go equivalents are hand-mirrored and MUST be kept in sync. There are TWO of
// them, and this header used to name a third that does not exist
// (services/migration/internal/canonical/types.go) — so the one instruction
// telling a maintainer where to mirror a change pointed at nothing:
//
//   packages/migrate/canonical/types.go
//       SourcePlatform, SubscriberStatus, ConsentSource — the import-side
//       vocabularies. Closest to a full mirror of this file.
//   services/automation/internal/canonical/types.go
//       SubscriberStatus plus the runtime automation/segment shapes.
//
// WHAT IS AND IS NOT ENFORCED. apps/web's canonical-source-platform-parity and
// canonical-enum-parity tests hold SourcePlatform, SubscriberStatus and
// ConsentSource to their Go counterparts, and canonical-comparator-parity now
// holds `SegmentCondition.comparator` to the Go evaluator that executes it.
//
// That last one was previously recorded here as unenforceable, because Go
// models the field as a bare `Comparator string` with no constants. True of Go
// CONSTANTS; not true of Go BEHAVIOUR — services/automation's branch evaluator
// switches on the comparator, and the set of cases it answers is the real
// vocabulary. Reading the switch closed the gap, and immediately found one:
// `is_null`/`is_not_null` were implemented there and absent from this file.
//
// STILL UNENFORCED: `ConsentSource` on the automation side (Go: `type
// ConsentSource string`, no constants AND no switch to read), so a value added
// there is unvalidated on the Go side.

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

export interface Subscriber {
  id?: string; // Moosewave mirror UUID when returned by the API
  email: string;
  status: SubscriberStatus;
  consent_timestamp: string | null; // ISO8601; null = "unknown" (surface to user)
  consent_source: ConsentSource;
  custom_fields: Record<string, string | number | boolean | null>;
  tags: string[];
  source_id: string; // original ID from source platform
  source_platform: SourcePlatform;
}

export type SourcePlatform =
  | "mailchimp"
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
  | "convertkit"
  | "substack"
  | "beehiiv"
  | "brevo"
  | "activecampaign"
  | "hubspot"
  | "sendy"
  | "mailerlite"
  | "csv";

// Segments arrive as a source-specific definition; we translate into a
// canonical AST that compiles to Postgres SQL against subscribers.attribs.
export interface Segment {
  name: string;
  description?: string;
  query_ast: SegmentNode;
  source_definition?: string; // raw original definition for fallback display
}

export type SegmentNode =
  | SegmentAnd
  | SegmentOr
  | SegmentNot
  | SegmentCondition;

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
  field: string; // "email" | "tag" | "list" | "engaged_within_days" | "custom.<key>"
  // Held to services/automation's branch evaluator by
  // apps/web canonical-comparator-parity. `is_null`/`is_not_null` were honoured
  // by that evaluator and missing here, so two capabilities the runtime
  // supports could not be expressed by a typed client at all.
  comparator:
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
    | "is_null"
    | "is_not_null";
  // Optional because the two null-checks take no operand: the evaluator answers
  // them from whether the field resolved at all, before it looks at a value.
  // Go has always modelled this as `interface{}`, so nothing is widened on the
  // wire -- only the TypeScript type catches up with it.
  value?: string | number | boolean | string[] | number[];
}

// Automations translated into canonical AST. Runtime in services/automation
// executes these against Listmonk's transactional API.
export interface Automation {
  name: string;
  status: "active" | "paused" | "draft";
  triggers: AutomationTrigger[];
  nodes: AutomationNode[];
  edges: AutomationEdge[];
  source_definition?: string;
}

export type AutomationTrigger =
  | { type: "subscriber_added_to_list"; list_id: string }
  | { type: "tag_added"; tag: string }
  | { type: "custom_event"; event_name: string }
  | { type: "date_field"; field: string; offset_days: number };

export type AutomationNode =
  | { id: string; type: "wait"; duration_seconds: number }
  | { id: string; type: "send_email"; template_id: string }
  | {
      id: string;
      type: "branch";
      condition: SegmentCondition;
      true_next: string | null;
      false_next: string | null;
    }
  | { id: string; type: "action"; action: AutomationAction };

export type AutomationAction =
  | { kind: "add_tag"; tag: string }
  | { kind: "remove_tag"; tag: string }
  | { kind: "move_to_list"; list_id: string }
  | { kind: "unsubscribe" };

export interface AutomationEdge {
  from: string;
  to: string;
}

export interface PaidSub {
  stripe_customer_id: string;
  stripe_subscription_id: string;
  stripe_price_id: string;
  status:
    | "active"
    | "trialing"
    | "past_due"
    | "canceled"
    | "incomplete"
    | "incomplete_expired"
    | "unpaid";
  current_period_end: string;
  trial_end: string | null;
  email: string;
  source_platform: SourcePlatform;
}

export interface CampaignArchive {
  source_id: string;
  subject: string;
  html: string;
  text: string;
  sent_at: string;
  recipients_count: number;
  opens: number;
  clicks: number;
  source_platform: SourcePlatform;
}

// Adapter capability matrix — rendered in the migration UI.
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
    /** Whether advertised automation support creates runtime flows or review-only rebuild records. */
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

// Migration job lifecycle
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
  automation_rebuilds?: Array<{
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
  }>;
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

export interface ResourceWarning {
  resource: string;
  source_id?: string;
  name?: string;
  warning: string;
}
