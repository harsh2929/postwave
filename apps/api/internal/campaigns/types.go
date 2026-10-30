package campaigns

import (
	"encoding/json"
	"time"
)

const (
	StatusDraft     = "draft"
	StatusScheduled = "scheduled"
	StatusSending   = "sending"
	StatusSent      = "sent"
	StatusPaused    = "paused"
	// X1+X2+X3 send-domain extensions: pause/resume/cancel mid-flight.
	StatusCancelled = "cancelled"
	StatusFailed    = "failed"
)

const (
	PriorityMin           = 1
	PriorityDefault       = 5
	PriorityMax           = 10
	PriorityTransactional = PriorityMax
)

func NormalizePriority(priority int) int {
	if priority == 0 {
		return PriorityDefault
	}
	if priority < PriorityMin {
		return PriorityMin
	}
	if priority > PriorityMax {
		return PriorityMax
	}
	return priority
}

type Campaign struct {
	ID                 string           `json:"id"`
	TenantID           string           `json:"tenant_id"`
	Name               string           `json:"name"`
	Subject            string           `json:"subject"`
	Status             string           `json:"status"`
	CampaignType       string           `json:"campaign_type"`
	EditorMode         string           `json:"editor_mode"`
	PreviewText        string           `json:"preview_text,omitempty"`
	BodyHTML           string           `json:"body_html,omitempty"`
	BodyMJML           string           `json:"body_mjml,omitempty"`
	PlainText          string           `json:"plain_text,omitempty"`
	FromName           string           `json:"from_name,omitempty"`
	ReplyTo            string           `json:"reply_to,omitempty"`
	ContentBlocks      []map[string]any `json:"content_blocks"`
	ReusableSectionIDs []string         `json:"reusable_section_ids"`
	Variants           []map[string]any `json:"variants"`
	TrackingSettings   map[string]any   `json:"tracking_settings"`
	DeliverySettings   map[string]any   `json:"delivery_settings"`
	// These fields make the mutable draft's semantic authority explicit. The
	// Fact Contract is normalized v1 JSON or {} when no contract exists yet.
	SourceMode           string          `json:"source_mode"`
	ContentSchemaVersion int             `json:"content_schema_version"`
	FactContract         json.RawMessage `json:"fact_contract"`
	SegmentID            string          `json:"segment_id,omitempty"`
	// FolderID surfaces the campaign's folder so the list-view folder
	// filter works (D06#6); empty string = uncategorised (folder_id NULL).
	FolderID string `json:"folder_id,omitempty"`
	// ListID is the audience list this campaign targets, surfaced as
	// the stringified `audience_list_id` column (Listmonk lists are
	// bigint upstream). Mutually exclusive with SegmentID in normal
	// use — the pre-send checklist treats either being non-empty as
	// "audience selected".
	ListID      string     `json:"list_id,omitempty"`
	ScheduledAt *time.Time `json:"scheduled_at,omitempty"`
	SentAt      *time.Time `json:"sent_at,omitempty"`
	Priority    int        `json:"priority,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`

	// G5 (campaigns 2026): per-recipient send-time optimization.
	// When PerRecipientOptimize=true the scheduler materializes a row
	// in campaign_recipient_send_at per subscriber inside [WindowStart,
	// WindowEnd] at each one's best-engagement hour. The
	// materialization scheduler is a G5 follow-up; toggling this
	// persists the intent.
	PerRecipientOptimize bool       `json:"per_recipient_optimize,omitempty"`
	SendWindowStart      *time.Time `json:"send_window_start,omitempty"`
	SendWindowEnd        *time.Time `json:"send_window_end,omitempty"`

	// G21 (campaigns 2026): public web-archive surfacing. ArchivePublic
	// is true once the campaign is published to the public archive;
	// ArchiveSlug is the per-issue slug the desktop joins with the tenant
	// archive slug to build the shareable "Web version" URL.
	ArchivePublic bool   `json:"archive_public,omitempty"`
	ArchiveSlug   string `json:"archive_slug,omitempty"`

	// G15 (campaigns 2026): conversion goal binding. GoalEvent is the
	// tracked conversion event name; GoalWindowHours is the attribution
	// window (1/24/168/720). Empty/zero = no goal configured.
	GoalEvent       string `json:"goal_event,omitempty"`
	GoalWindowHours int    `json:"goal_window_hours,omitempty"`

	// G6 (campaigns 2026): audience mode — "dynamic" (re-evaluate at
	// send, default) or "static" (snapshot at compose). FrozenFreezeID
	// links a static campaign to its segment_static_freezes snapshot;
	// queue-fill sends to that frozen membership instead of re-evaluating.
	AudienceMode   string `json:"audience_mode,omitempty"`
	FrozenFreezeID string `json:"frozen_freeze_id,omitempty"`

	// OpenRate / ClickRate are the list-view engagement rates as a 0..1
	// FRACTION (unique openers|clickers / delivered), populated by List()
	// from a batched campaign_report_events roll-up (D06#8 — the desktop
	// list columns were permanently empty because the list endpoint never
	// returned these). Pointers so a never-sent campaign serialises them as
	// absent → the desktop renders "—" rather than a misleading 0%.
	OpenRate  *float64 `json:"open_rate,omitempty"`
	ClickRate *float64 `json:"click_rate,omitempty"`

	// Template lineage (migration 1748). These fields make catalog-driven
	// drafts auditable without coupling campaign reads to the template table.
	SourceTemplateID               string         `json:"source_template_id,omitempty"`
	SourceTemplateUpdatedAt        *time.Time     `json:"source_template_updated_at,omitempty"`
	ReferenceTemplateIDs           []string       `json:"reference_template_ids,omitempty"`
	TemplateVariables              map[string]any `json:"template_variables,omitempty"`
	SourceTemplateDesignDraftID    string         `json:"source_template_design_draft_id,omitempty"`
	SourceTemplateDesignRevision   int            `json:"source_template_design_revision,omitempty"`
	SourceTemplateDesignOutputHash string         `json:"source_template_design_output_hash,omitempty"`
}

// AudienceListID returns the list-typed audience id. Helper so the
// send + checklist code reads c.AudienceListID() rather than peeking
// at the bare field — keeps room for swapping the storage shape later
// without touching every call site.
func (c *Campaign) AudienceListID() string {
	if c == nil {
		return ""
	}
	return c.ListID
}

// CreateInput is the repository/internal workflow input. Its ScheduledAt field
// is intentionally unavailable on the generic HTTP create contract; governed
// internal rollout workflows may still create a scheduled row explicitly.
type CreateInput struct {
	Name                           string           `json:"name"`
	Subject                        string           `json:"subject"`
	CampaignType                   string           `json:"campaign_type"`
	EditorMode                     string           `json:"editor_mode"`
	PreviewText                    string           `json:"preview_text"`
	BodyHTML                       string           `json:"body_html"`
	BodyMJML                       string           `json:"body_mjml"`
	PlainText                      string           `json:"plain_text"`
	FromName                       string           `json:"from_name"`
	ReplyTo                        string           `json:"reply_to"`
	ContentBlocks                  []map[string]any `json:"content_blocks"`
	ReusableSectionIDs             []string         `json:"reusable_section_ids"`
	Variants                       []map[string]any `json:"variants"`
	TrackingSettings               map[string]any   `json:"tracking_settings"`
	DeliverySettings               map[string]any   `json:"delivery_settings"`
	SourceMode                     string           `json:"source_mode,omitempty"`
	ContentSchemaVersion           int              `json:"content_schema_version,omitempty"`
	FactContract                   json.RawMessage  `json:"fact_contract,omitempty"`
	SegmentID                      string           `json:"segment_id"`
	ScheduledAt                    *time.Time       `json:"scheduled_at"`
	Priority                       int              `json:"priority,omitempty"`
	ListID                         string           `json:"list_id,omitempty"`
	SourceTemplateID               string           `json:"source_template_id,omitempty"`
	SourceTemplateUpdatedAt        *time.Time       `json:"source_template_updated_at,omitempty"`
	ReferenceTemplateIDs           []string         `json:"reference_template_ids,omitempty"`
	TemplateVariables              map[string]any   `json:"template_variables,omitempty"`
	SourceTemplateDesignDraftID    string           `json:"source_template_design_draft_id,omitempty"`
	SourceTemplateDesignRevision   int              `json:"source_template_design_revision,omitempty"`
	SourceTemplateDesignOutputHash string           `json:"source_template_design_output_hash,omitempty"`
}

// UpdateInput is the repository/internal mutation input. Status and ScheduledAt
// are dispatch-owned and are deliberately omitted from generic HTTP PATCH
// decoding (see updateAuthoringInput). Internal lifecycle code may still use
// them, while action handlers prefer Repo.SetStatus for constrained transitions.
type UpdateInput struct {
	// IfMatchToken carries the optimistic-concurrency token parsed from the
	// request's If-Match header (json:"-" so the client can never set it via
	// the body). When non-empty, Update returns ErrPreconditionFailed unless
	// it matches the row's current version.
	IfMatchToken string `json:"-"`

	Name                 *string          `json:"name"`
	Subject              *string          `json:"subject"`
	Status               *string          `json:"status"`
	CampaignType         *string          `json:"campaign_type"`
	EditorMode           *string          `json:"editor_mode"`
	PreviewText          *string          `json:"preview_text"`
	BodyHTML             *string          `json:"body_html"`
	BodyMJML             *string          `json:"body_mjml"`
	PlainText            *string          `json:"plain_text"`
	FromName             *string          `json:"from_name"`
	ReplyTo              *string          `json:"reply_to"`
	ContentBlocks        []map[string]any `json:"content_blocks"`
	ReusableSectionIDs   []string         `json:"reusable_section_ids"`
	Variants             []map[string]any `json:"variants"`
	TrackingSettings     map[string]any   `json:"tracking_settings"`
	DeliverySettings     map[string]any   `json:"delivery_settings"`
	SourceMode           *string          `json:"source_mode"`
	ContentSchemaVersion *int             `json:"content_schema_version"`
	// nil means absent from PATCH; {} explicitly clears the draft contract.
	FactContract json.RawMessage `json:"fact_contract"`
	SegmentID    *string         `json:"segment_id"`
	// ListID selects a list audience: the engine id every client holds, or the
	// Moosewave list uuid. Update resolves it through the tenant's list_id_map
	// and stores the engine id. nil leaves the list alone and "" clears it. A
	// list and a segment are mutually exclusive, so a client switching the
	// source sends both fields, the unused one as "".
	ListID      *string    `json:"list_id"`
	ScheduledAt *time.Time `json:"scheduled_at"`
	// ClearScheduledAt unschedules. ScheduledAt is a pointer whose nil means
	// "leave it alone", so removing a schedule cannot be expressed by the field
	// itself — it needs its own instruction. json:"-" because only the lifecycle
	// route may set it; a client cannot unschedule by smuggling a flag through
	// the authoring body.
	ClearScheduledAt bool `json:"-"`
	Priority         *int `json:"priority,omitempty"`
	// G15 (campaigns 2026): conversion goal. GoalEvent "" clears the
	// goal; GoalWindowHours must be one of 1/24/168/720 when a goal is set.
	GoalEvent       *string `json:"goal_event,omitempty"`
	GoalWindowHours *int    `json:"goal_window_hours,omitempty"`
	// G6 (campaigns 2026): audience mode — "static" | "dynamic".
	AudienceMode *string `json:"audience_mode,omitempty"`
}

type TestSendInput struct {
	CampaignID string `json:"campaign_id"`
	ToEmail    string `json:"to_email"`
	Subject    string `json:"subject"`
	BodyHTML   string `json:"body_html"`
	BodyMJML   string `json:"body_mjml"`
	PlainText  string `json:"plain_text"`
}

type TestSendResponse struct {
	MessageID  string    `json:"message_id"`
	To         string    `json:"to"`
	AcceptedAt time.Time `json:"accepted_at"`
}
