// SPDX-License-Identifier: MIT

// Package canonical defines the canonical migration schema that every adapter
// normalizes source-platform data into. This is the source of truth for the
// Go module; the TypeScript counterpart in @postwave/schema is generated from
// or kept in sync with this file.
package canonical

import "time"

// SourcePlatform enumerates the ESPs Moosewave can migrate from.
type SourcePlatform string

const (
	SourceMailchimp       SourcePlatform = "mailchimp"
	SourceConvertKit      SourcePlatform = "convertkit"
	SourceSubstack        SourcePlatform = "substack"
	SourceBeehiiv         SourcePlatform = "beehiiv"
	SourceMailerLite      SourcePlatform = "mailerlite"
	SourceBrevo           SourcePlatform = "brevo"
	SourceActiveCampaign  SourcePlatform = "activecampaign"
	SourceHubSpot         SourcePlatform = "hubspot"
	SourceSendy           SourcePlatform = "sendy"
	SourceCSV             SourcePlatform = "csv"
	SourceKlaviyo         SourcePlatform = "klaviyo"
	SourceCustomerIO      SourcePlatform = "customerio"
	SourceConstantContact SourcePlatform = "constant-contact"
	SourceAWeber          SourcePlatform = "aweber"
	SourceDrip            SourcePlatform = "drip"
	SourceCampaignMonitor SourcePlatform = "campaign-monitor"
	SourceOmnisend        SourcePlatform = "omnisend"
	SourceLoops           SourcePlatform = "loops"
	SourceFlodesk         SourcePlatform = "flodesk"
	SourceBento           SourcePlatform = "bento"
)

// SubscriberStatus matches Listmonk's status vocabulary.
type SubscriberStatus string

const (
	StatusEnabled     SubscriberStatus = "enabled"
	StatusDisabled    SubscriberStatus = "disabled"
	StatusBlocklisted SubscriberStatus = "blocklisted"
	StatusUnconfirmed SubscriberStatus = "unconfirmed"
)

// ConsentSource is how the subscriber originally opted in.
type ConsentSource string

const (
	ConsentDoubleOptIn ConsentSource = "double_optin"
	ConsentSingleOptIn ConsentSource = "single_optin"
	ConsentImport      ConsentSource = "import"
	ConsentAPI         ConsentSource = "api"
	ConsentUnknown     ConsentSource = "unknown"
)

// Subscriber is the canonical contact record.
type Subscriber struct {
	Email            string                 `json:"email"`
	Status           SubscriberStatus       `json:"status"`
	ConsentTimestamp *time.Time             `json:"consent_timestamp"` // nil = unknown
	ConsentSource    ConsentSource          `json:"consent_source"`
	CustomFields     map[string]interface{} `json:"custom_fields"`
	Tags             []string               `json:"tags"`
	SourceID         string                 `json:"source_id"`
	SourcePlatform   SourcePlatform         `json:"source_platform"`
}

// Segment is a saved audience filter, translated to a portable AST.
type Segment struct {
	Name             string      `json:"name"`
	Description      string      `json:"description,omitempty"`
	QueryAST         SegmentNode `json:"query_ast"`
	SourceDefinition string      `json:"source_definition,omitempty"`
}

// SegmentNode is a tagged-union AST node.
//
// Encoding (matches TS):
//   - Op = "and" | "or"     → uses Children
//   - Op = "not"            → uses Children[0] (the single child)
//   - Op = "condition"      → uses Field, Comparator, Value
//
// We collapse the 4 TS shapes into one Go struct with a discriminator so JSON
// round-trips cleanly without a custom UnmarshalJSON forest.
type SegmentNode struct {
	Op         string        `json:"op"`
	Children   []SegmentNode `json:"children,omitempty"`
	Field      string        `json:"field,omitempty"`
	Comparator string        `json:"comparator,omitempty"`
	Value      interface{}   `json:"value,omitempty"`
}

// SegmentCondition is a leaf segment node (used by branch nodes inline).
type SegmentCondition struct {
	Op         string      `json:"op"` // always "condition"
	Field      string      `json:"field"`
	Comparator string      `json:"comparator"`
	Value      interface{} `json:"value"`
}

// Automation is a translated journey/sequence/automation flow.
type Automation struct {
	Name             string              `json:"name"`
	Status           string              `json:"status"` // active|paused|draft
	Triggers         []AutomationTrigger `json:"triggers"`
	Nodes            []AutomationNode    `json:"nodes"`
	Edges            []AutomationEdge    `json:"edges"`
	SourceDefinition string              `json:"source_definition,omitempty"`
}

// AutomationTrigger fires an automation. Type discriminates the payload.
//
// Supported types:
//   - "subscriber_added_to_list" — uses ListID
//   - "tag_added"                — uses Tag
//   - "custom_event"             — uses EventName
//   - "date_field"               — uses Field + OffsetDays
//   - "subscriber_opened_email"  — uses optional CampaignID + WithinDays
//   - "subscriber_clicked_link"  — uses optional CampaignID + URLPattern + WithinDays
//   - "subscriber_did_not_open"  — uses CampaignID + AfterDays
type AutomationTrigger struct {
	Type       string `json:"type"`
	ListID     string `json:"list_id,omitempty"`
	Tag        string `json:"tag,omitempty"`
	GroupID    string `json:"group_id,omitempty"`
	FormID     string `json:"form_id,omitempty"`
	SegmentID  string `json:"segment_id,omitempty"`
	EventName  string `json:"event_name,omitempty"`
	Field      string `json:"field,omitempty"`
	OffsetDays int    `json:"offset_days,omitempty"`
	// Engagement-trigger qualifiers.
	CampaignID string                 `json:"campaign_id,omitempty"`
	URLPattern string                 `json:"url_pattern,omitempty"`
	WithinDays int                    `json:"within_days,omitempty"`
	AfterDays  int                    `json:"after_days,omitempty"`
	Metadata   map[string]interface{} `json:"metadata,omitempty"`
}

// AutomationNode is a step in the journey graph.
//
// Type values include:
// "wait" | "wait_until" | "wait_until_trigger" | "wait_for_condition" |
// "send_email" | "send_sms" | "send_postcard" | "branch" |
// "percentage_split" | "webhook" | "webhook_emit" |
// "update_subscriber" | "list_membership" | "set_goal" |
// "goal" | "action".
//
// RawSource preserves the verbatim source-platform payload for nodes the
// translator promoted into canonical form, so the orchestrator's verifier and
// the in-product rebuild view can still cite the original journey shape.
type AutomationNode struct {
	ID              string                   `json:"id"`
	Type            string                   `json:"type"`
	DurationSeconds int64                    `json:"duration_seconds,omitempty"`
	WaitUntil       *time.Time               `json:"wait_until,omitempty"`
	WaitTrigger     *AutomationTrigger       `json:"wait_trigger,omitempty"`
	TimeoutSeconds  int64                    `json:"timeout_seconds,omitempty"`
	TemplateID      string                   `json:"template_id,omitempty"`
	SMSBody         string                   `json:"sms_body,omitempty"`
	WebhookURL      string                   `json:"webhook_url,omitempty"`
	WebhookMethod   string                   `json:"webhook_method,omitempty"`
	WebhookTarget   string                   `json:"webhook_target,omitempty"`
	Condition       *SegmentCondition        `json:"condition,omitempty"`
	Goal            *SegmentCondition        `json:"goal,omitempty"`
	Variants        []AutomationSplitVariant `json:"variants,omitempty"`
	TrueNext        *string                  `json:"true_next,omitempty"`
	FalseNext       *string                  `json:"false_next,omitempty"`
	Action          *AutomationAction        `json:"action,omitempty"`
	Metadata        map[string]interface{}   `json:"metadata,omitempty"`
	RawSource       map[string]interface{}   `json:"raw_source,omitempty"`
}

// AutomationAction mutates subscriber state.
//
// Kind values include "add_tag", "remove_tag", "move_to_list",
// "unsubscribe", "archive_contact", "update_contact",
// "update_subscriber", "add_group", "remove_group", "notify",
// "list_add", "list_remove", "physical_mail", and "webhook_emit".
type AutomationAction struct {
	Kind       string                 `json:"kind"`
	Tag        string                 `json:"tag,omitempty"`
	ListID     string                 `json:"list_id,omitempty"`
	GroupID    string                 `json:"group_id,omitempty"`
	Field      string                 `json:"field,omitempty"`
	Value      interface{}            `json:"value,omitempty"`
	Message    string                 `json:"message,omitempty"`
	URL        string                 `json:"url,omitempty"`
	Properties map[string]interface{} `json:"properties,omitempty"`
	Metadata   map[string]interface{} `json:"metadata,omitempty"`
}

// AutomationSplitVariant describes one branch in a percentage or multivariate
// journey split.
type AutomationSplitVariant struct {
	ID         string                 `json:"id"`
	Label      string                 `json:"label,omitempty"`
	Percentage int                    `json:"percentage,omitempty"`
	Next       string                 `json:"next,omitempty"`
	Metadata   map[string]interface{} `json:"metadata,omitempty"`
}

// AutomationEdge connects two AutomationNodes.
type AutomationEdge struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// PaidSub mirrors a Stripe subscription belonging to the migrating publication.
type PaidSub struct {
	StripeCustomerID     string         `json:"stripe_customer_id"`
	StripeSubscriptionID string         `json:"stripe_subscription_id"`
	StripePriceID        string         `json:"stripe_price_id"`
	Status               string         `json:"status"`
	CurrentPeriodEnd     time.Time      `json:"current_period_end"`
	TrialEnd             *time.Time     `json:"trial_end"`
	Email                string         `json:"email"`
	SourcePlatform       SourcePlatform `json:"source_platform"`
}

// CampaignArchive is one previously-sent campaign with rendered content + stats.
type CampaignArchive struct {
	SourceID        string                 `json:"source_id"`
	Subject         string                 `json:"subject"`
	HTML            string                 `json:"html"`
	Text            string                 `json:"text"`
	SentAt          time.Time              `json:"sent_at"`
	RecipientsCount int                    `json:"recipients_count"`
	Opens           int                    `json:"opens"`
	Clicks          int                    `json:"clicks"`
	Report          map[string]interface{} `json:"report,omitempty"`
	Warnings        []string               `json:"warnings,omitempty"`
	SourcePlatform  SourcePlatform         `json:"source_platform"`
}

// EmailTemplate is an editable campaign template pulled from a source ESP.
type EmailTemplate struct {
	SourceID         string                 `json:"source_id"`
	Name             string                 `json:"name"`
	Subject          string                 `json:"subject,omitempty"`
	PreviewText      string                 `json:"preview_text,omitempty"`
	HTML             string                 `json:"html"`
	DefaultContent   map[string]interface{} `json:"default_content,omitempty"`
	SourceDefinition string                 `json:"source_definition,omitempty"`
	Warnings         []string               `json:"warnings,omitempty"`
	SourcePlatform   SourcePlatform         `json:"source_platform"`
}

// SourceArchiveItem is a read-only preservation record for source objects that
// Moosewave cannot execute natively yet, such as CRM deals, forms, ecommerce
// orders, custom objects, or SMS history.
type SourceArchiveItem struct {
	SourceID        string                 `json:"source_id"`
	ResourceType    string                 `json:"resource_type"`
	Name            string                 `json:"name"`
	Status          string                 `json:"status,omitempty"`
	LinkedContactID string                 `json:"linked_contact_id,omitempty"`
	OccurredAt      *time.Time             `json:"occurred_at,omitempty"`
	Payload         map[string]interface{} `json:"payload"`
	Warnings        []string               `json:"warnings,omitempty"`
	SourcePlatform  SourcePlatform         `json:"source_platform"`
}

// SourceEvent is an incremental source-side mutation captured during shadow
// mode. Adapters emit this for surfaces where the provider exposes an
// update cursor. The hosted migration service can persist the event and, when
// a canonical projection is present, replay it into Moosewave immediately.
type SourceEvent struct {
	SourceID       string                 `json:"source_id"`
	ResourceType   string                 `json:"resource_type"`
	Action         string                 `json:"action"` // upsert|delete|suppress|archive|manual_review
	OccurredAt     time.Time              `json:"occurred_at"`
	Subscriber     *Subscriber            `json:"subscriber,omitempty"`
	Payload        map[string]interface{} `json:"payload,omitempty"`
	SourcePlatform SourcePlatform         `json:"source_platform"`
}

type SourceEventBatch struct {
	Events        []SourceEvent `json:"events"`
	NextCursor    string        `json:"next_cursor,omitempty"`
	HighWatermark time.Time     `json:"high_watermark,omitempty"`
}

// AdapterCapabilities describes what a given source adapter can pull.
type AdapterCapabilities struct {
	Source     SourcePlatform `json:"source"`
	AuthMethod string         `json:"auth_method"` // oauth2|api_key|csv_upload
	Supports   struct {
		Subscribers bool `json:"subscribers"`
		Segments    bool `json:"segments"`
		Automations bool `json:"automations"`
		// AutomationMode clarifies the meaning of Automations when a source can
		// read automation definitions but cannot safely materialize executable
		// runtime flows. Values: runtime|rebuild_review|none.
		AutomationMode    string `json:"automation_mode,omitempty"`
		CampaignArchive   bool   `json:"campaign_archive"`
		PaidSubs          bool   `json:"paid_subs"`
		ConsentTimestamps bool   `json:"consent_timestamps"`
		Templates         bool   `json:"templates"`
		Campaigns         bool   `json:"campaigns"`
		Reports           bool   `json:"reports"`
		Groups            bool   `json:"groups"`
		Forms             bool   `json:"forms"`
		LandingPages      bool   `json:"landing_pages"`
		Ecommerce         bool   `json:"ecommerce"`
		CRM               bool   `json:"crm"`
		CustomObjects     bool   `json:"custom_objects"`
		SMS               bool   `json:"sms"`
	} `json:"supports"`
}

// MigrationStatus is the lifecycle state of a MigrationJob.
type MigrationStatus string

const (
	MigPending              MigrationStatus = "pending"
	MigAuthenticating       MigrationStatus = "authenticating"
	MigDiscovering          MigrationStatus = "discovering"
	MigDryRun               MigrationStatus = "dry_run"
	MigAwaitingConfirmation MigrationStatus = "awaiting_confirmation"
	MigImporting            MigrationStatus = "importing"
	MigCompleted            MigrationStatus = "completed"
	MigRollingBack          MigrationStatus = "rolling_back"
	MigFailed               MigrationStatus = "failed"
	MigRolledBack           MigrationStatus = "rolled_back"
)

// MigrationJob is the durable record of a single migration run.
type MigrationJob struct {
	ID                     string              `json:"id"`
	TenantID               string              `json:"tenant_id"`
	Source                 SourcePlatform      `json:"source"`
	Status                 MigrationStatus     `json:"status"`
	Progress               MigrationProgress   `json:"progress"`
	Cursor                 map[string]*string  `json:"cursor"`
	StartedAt              time.Time           `json:"started_at"`
	CompletedAt            *time.Time          `json:"completed_at"`
	RollbackUntil          *time.Time          `json:"rollback_until"`
	SourceSessionExpiresAt *time.Time          `json:"source_session_expires_at,omitempty"`
	SelectedAudienceIDs    []string            `json:"selected_audience_ids,omitempty"`
	VerificationReport     *VerificationReport `json:"verification_report"`
	Error                  *string             `json:"error"`
	// MIGR-037: operator-supplied name/annotation (nullable).
	Label *string `json:"label,omitempty"`
	Notes *string `json:"notes,omitempty"`
}

// MigrationProgress is the per-resource counter pair.
type MigrationProgress struct {
	SubscribersTotal   int `json:"subscribers_total"`
	SubscribersDone    int `json:"subscribers_done"`
	SegmentsTotal      int `json:"segments_total"`
	SegmentsDone       int `json:"segments_done"`
	AutomationsTotal   int `json:"automations_total"`
	AutomationsDone    int `json:"automations_done"`
	PaidSubsTotal      int `json:"paid_subs_total"`
	PaidSubsDone       int `json:"paid_subs_done"`
	ArchiveTotal       int `json:"archive_total"`
	ArchiveDone        int `json:"archive_done"`
	TemplatesTotal     int `json:"templates_total,omitempty"`
	TemplatesDone      int `json:"templates_done,omitempty"`
	SourceArchiveTotal int `json:"source_archive_total,omitempty"`
	SourceArchiveDone  int `json:"source_archive_done,omitempty"`
}

// CustomFieldMapping documents how a source field landed in canonical space.
type CustomFieldMapping struct {
	Source    string `json:"source"`
	Canonical string `json:"canonical"`
	Type      string `json:"type"`
}

// SubscriberMergeConflict records duplicate source rows that landed on one
// destination subscriber, for example the same email appearing in multiple
// Mailchimp audiences.
type SubscriberMergeConflict struct {
	Email          string   `json:"email"`
	SourceIDs      []string `json:"source_ids,omitempty"`
	Tags           []string `json:"tags,omitempty"`
	ConflictFields []string `json:"conflict_fields,omitempty"`
}

// ResourceWarning records partial-fidelity details for non-subscriber
// resources that still imported.
type ResourceWarning struct {
	Resource string `json:"resource"`
	SourceID string `json:"source_id,omitempty"`
	Name     string `json:"name,omitempty"`
	Warning  string `json:"warning"`
}

// SegmentWarning surfaces a translation issue for a single segment.
type SegmentWarning struct {
	Name    string `json:"name"`
	Warning string `json:"warning"`
}

// AutomationUnsupported flags an automation that could not be ported.
type AutomationUnsupported struct {
	Name   string `json:"name"`
	Reason string `json:"reason"`
}

// AutomationRebuildItem tracks the manual rebuild/test status for a migrated
// automation that cannot be translated safely without human review.
type AutomationRebuildItem struct {
	Rank         int        `json:"rank"`
	Name         string     `json:"name"`
	SourceID     string     `json:"source_id,omitempty"`
	Status       string     `json:"status"` // not_started|rebuilding|test_passed|approved_not_needed|blocked
	Owner        string     `json:"owner,omitempty"`
	Notes        string     `json:"notes,omitempty"`
	TestEvidence string     `json:"test_evidence,omitempty"`
	UpdatedAt    *time.Time `json:"updated_at,omitempty"`
}

// ResourceCompleteness is a resource-level parity row for dry-run and import
// reports. It intentionally names resources the way users see them in the
// migration UI rather than mirroring internal table names.
type ResourceCompleteness struct {
	Resource    string   `json:"resource"`
	Label       string   `json:"label"`
	SourceTotal int      `json:"source_total"`
	Imported    int      `json:"imported"`
	Supported   bool     `json:"supported"`
	Status      string   `json:"status"` // imported_runtime|partial_runtime|preserved_for_rebuild|manual_rebuild_required|not_supported|not_detected
	Notes       []string `json:"notes,omitempty"`
}

// SubscriberSample is a redacted preview of how one subscriber will land in
// Moosewave, shown in the dry-run report (MIGR-028). It is a bounded subset of
// Subscriber — no consent internals, email local-part masked, custom_fields
// capped — so an operator can eyeball the mapping before committing.
type SubscriberSample struct {
	Email        string                 `json:"email"`
	Status       SubscriberStatus       `json:"status"`
	Tags         []string               `json:"tags,omitempty"`
	SourceID     string                 `json:"source_id,omitempty"`
	CustomFields map[string]interface{} `json:"custom_fields,omitempty"`
}

// VerificationReport is the dry-run / post-import audit produced for the user.
type VerificationReport struct {
	SubscribersImported        int                       `json:"subscribers_imported"`
	SuppressionListSize        int                       `json:"suppression_list_size"`
	ConsentKnown               int                       `json:"consent_known"`
	ConsentUnknown             int                       `json:"consent_unknown"`
	DuplicateSubscribersMerged int                       `json:"duplicate_subscribers_merged,omitempty"`
	SubscriberMergeConflicts   []SubscriberMergeConflict `json:"subscriber_merge_conflicts,omitempty"`
	CustomFieldsMapped         []CustomFieldMapping      `json:"custom_fields_mapped"`
	CustomFieldsUnmapped       []string                  `json:"custom_fields_unmapped"`
	SegmentsTranslated         int                       `json:"segments_translated"`
	SegmentsWithWarnings       []SegmentWarning          `json:"segments_with_warnings"`
	AutomationsTranslated      int                       `json:"automations_translated"`
	AutomationsUnsupported     []AutomationUnsupported   `json:"automations_unsupported"`
	AutomationRebuilds         []AutomationRebuildItem   `json:"automation_rebuilds,omitempty"`
	PaidSubsImported           int                       `json:"paid_subs_imported"`
	PremiumMembershipsObserved int                       `json:"premium_memberships_observed,omitempty"`
	ArchiveImported            int                       `json:"archive_imported"`
	DiscoveryWarnings          []string                  `json:"discovery_warnings,omitempty"`
	CampaignArchiveWarnings    []ResourceWarning         `json:"campaign_archive_warnings,omitempty"`
	TemplatesImported          int                       `json:"templates_imported,omitempty"`
	TemplateWarnings           []ResourceWarning         `json:"template_warnings,omitempty"`
	SourceArchiveImported      int                       `json:"source_archive_imported,omitempty"`
	SourceArchiveWarnings      []ResourceWarning         `json:"source_archive_warnings,omitempty"`
	SourceArchiveByResource    map[string]int            `json:"source_archive_by_resource,omitempty"`
	SubscriberTagsImported     int                       `json:"-"`
	SampleSubscribers          []SubscriberSample        `json:"sample_subscribers,omitempty"`
	ResourceCompleteness       []ResourceCompleteness    `json:"resource_completeness"`
	DataLossEstimatePct        float64                   `json:"data_loss_estimate_pct"`
}
