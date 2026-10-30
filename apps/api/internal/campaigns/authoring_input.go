package campaigns

import (
	"encoding/json"
	"strings"
	"time"
)

// createAuthoringInput is the public generic-create contract. Dispatch-owned
// fields are decoded only so the handler can return one stable lifecycle error;
// they are never copied into the repository input.
type createAuthoringInput struct {
	Name                    string           `json:"name"`
	Subject                 string           `json:"subject"`
	CampaignType            string           `json:"campaign_type"`
	EditorMode              string           `json:"editor_mode"`
	PreviewText             string           `json:"preview_text"`
	BodyHTML                string           `json:"body_html"`
	BodyMJML                string           `json:"body_mjml"`
	PlainText               string           `json:"plain_text"`
	FromName                string           `json:"from_name"`
	ReplyTo                 string           `json:"reply_to"`
	ContentBlocks           []map[string]any `json:"content_blocks"`
	ReusableSectionIDs      []string         `json:"reusable_section_ids"`
	Variants                []map[string]any `json:"variants"`
	TrackingSettings        map[string]any   `json:"tracking_settings"`
	DeliverySettings        map[string]any   `json:"delivery_settings"`
	SourceMode              string           `json:"source_mode"`
	ContentSchemaVersion    int              `json:"content_schema_version"`
	FactContract            json.RawMessage  `json:"fact_contract"`
	SegmentID               string           `json:"segment_id"`
	Priority                int              `json:"priority,omitempty"`
	ListID                  string           `json:"list_id,omitempty"`
	SourceTemplateID        string           `json:"source_template_id,omitempty"`
	SourceTemplateUpdatedAt *time.Time       `json:"source_template_updated_at,omitempty"`
	ReferenceTemplateIDs    []string         `json:"reference_template_ids,omitempty"`
	TemplateVariables       map[string]any   `json:"template_variables,omitempty"`

	Status      json.RawMessage `json:"status"`
	ScheduledAt json.RawMessage `json:"scheduled_at"`
}

func (in createAuthoringInput) hasDispatchState() bool {
	return len(in.Status) != 0 || len(in.ScheduledAt) != 0
}

func (in createAuthoringInput) repositoryInput() CreateInput {
	return CreateInput{
		Name:                    in.Name,
		Subject:                 in.Subject,
		CampaignType:            in.CampaignType,
		EditorMode:              in.EditorMode,
		PreviewText:             in.PreviewText,
		BodyHTML:                in.BodyHTML,
		BodyMJML:                in.BodyMJML,
		PlainText:               in.PlainText,
		FromName:                in.FromName,
		ReplyTo:                 in.ReplyTo,
		ContentBlocks:           in.ContentBlocks,
		ReusableSectionIDs:      in.ReusableSectionIDs,
		Variants:                in.Variants,
		TrackingSettings:        in.TrackingSettings,
		DeliverySettings:        in.DeliverySettings,
		SourceMode:              in.SourceMode,
		ContentSchemaVersion:    in.ContentSchemaVersion,
		FactContract:            in.FactContract,
		SegmentID:               in.SegmentID,
		Priority:                in.Priority,
		ListID:                  in.ListID,
		SourceTemplateID:        in.SourceTemplateID,
		SourceTemplateUpdatedAt: in.SourceTemplateUpdatedAt,
		ReferenceTemplateIDs:    in.ReferenceTemplateIDs,
		TemplateVariables:       in.TemplateVariables,
	}
}

// updateAuthoringInput mirrors the generic PATCH authoring surface but keeps
// lifecycle truth (status and scheduled_at) outside the resulting UpdateInput.
// Internal state transitions continue to use UpdateInput or Repo.SetStatus.
type updateAuthoringInput struct {
	Name                 *string          `json:"name"`
	Subject              *string          `json:"subject"`
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
	FactContract         json.RawMessage  `json:"fact_contract"`
	SegmentID            *string          `json:"segment_id"`
	ListID               *string          `json:"list_id"`
	Priority             *int             `json:"priority,omitempty"`
	GoalEvent            *string          `json:"goal_event,omitempty"`
	GoalWindowHours      *int             `json:"goal_window_hours,omitempty"`
	AudienceMode         *string          `json:"audience_mode,omitempty"`

	Status      json.RawMessage `json:"status"`
	ScheduledAt json.RawMessage `json:"scheduled_at"`
}

func (in updateAuthoringInput) hasDispatchState() bool {
	return len(in.Status) != 0 || len(in.ScheduledAt) != 0
}

func (in updateAuthoringInput) repositoryInput() UpdateInput {
	return UpdateInput{
		Name:                 in.Name,
		Subject:              in.Subject,
		CampaignType:         in.CampaignType,
		EditorMode:           in.EditorMode,
		PreviewText:          in.PreviewText,
		BodyHTML:             in.BodyHTML,
		BodyMJML:             in.BodyMJML,
		PlainText:            in.PlainText,
		FromName:             in.FromName,
		ReplyTo:              in.ReplyTo,
		ContentBlocks:        in.ContentBlocks,
		ReusableSectionIDs:   in.ReusableSectionIDs,
		Variants:             in.Variants,
		TrackingSettings:     in.TrackingSettings,
		DeliverySettings:     in.DeliverySettings,
		SourceMode:           in.SourceMode,
		ContentSchemaVersion: in.ContentSchemaVersion,
		FactContract:         in.FactContract,
		SegmentID:            in.SegmentID,
		ListID:               in.ListID,
		Priority:             in.Priority,
		GoalEvent:            in.GoalEvent,
		GoalWindowHours:      in.GoalWindowHours,
		AudienceMode:         in.AudienceMode,
	}
}

// freezesOnceDispatched reports whether this input changes what a recipient
// receives — the message itself, or who is on the list to get it.
//
// The distinction matters because `Repo.Update` is the lifecycle writer as well
// as the authoring writer. The send loop pauses an incomplete campaign through
// it (send.go), the queue route flips to `sending` through it, and an operator
// resuming a paused send goes through SetStatus. Freezing every field on a
// dispatching campaign would deadlock all of that.
//
// So the rule is drawn around delivery, not around mutation:
//
//   - Frozen: subject, bodies, preview text, sender identity, blocks, variants,
//     tracking settings (they rewrite the links in the message), segment, list
//     and audience mode (they decide who is still to receive it).
//   - Not frozen: status (lifecycle, owned by the dispatch routes), name (an
//     internal label — renaming a running send is harmless), priority.
//   - scheduled_at IS frozen, even though it is lifecycle rather than content.
//     Moving the send time of a campaign that already began sending is not a
//     reschedule, it is a fiction: those recipients hold their message. Clearing
//     it is worse — the campaign would read as an unscheduled draft with a
//     partial send sitting behind it. The dispatch routes own status; nothing
//     owns "un-send".
//   - delivery_settings is BOTH. It holds operational knobs an operator needs
//     precisely while a send is in flight (throttles), and it holds from_email,
//     which sendloop.loadCampaignBodies reads per batch to build the From header.
//     So it is frozen only when the write would change the sender — see
//     changesSender. Freezing the whole field would block "slow this send down";
//     leaving it open let a mid-send PATCH swap the From address, and let a
//     partial write erase it, since map fields here REPLACE rather than merge.
//   - Not frozen, deliberately: goal_event and goal_window_hours. They change
//     what the report measures, not what is delivered. Changing them mid-send
//     does make an attribution window incoherent, but that is a measurement
//     concern with its own fix; it does not put two different emails out under
//     one campaign id.
func (in UpdateInput) freezesOnceDispatched(current map[string]any) bool {
	switch {
	case in.Subject != nil, in.BodyHTML != nil, in.BodyMJML != nil,
		in.PlainText != nil, in.PreviewText != nil,
		in.FromName != nil, in.ReplyTo != nil,
		in.EditorMode != nil, in.CampaignType != nil,
		in.SegmentID != nil, in.ListID != nil, in.AudienceMode != nil:
		return true
	case in.ContentBlocks != nil, in.ReusableSectionIDs != nil,
		in.Variants != nil, in.TrackingSettings != nil,
		in.SourceMode != nil, in.ContentSchemaVersion != nil,
		in.FactContract != nil:
		return true
	case in.ScheduledAt != nil, in.ClearScheduledAt:
		return true
	}
	return in.changesSender(current)
}

// changesSender reports whether this input would alter delivery_settings'
// from_email — including dropping it.
//
// The drop is the case worth spelling out. DeliverySettings REPLACES rather than
// merges, so a client sending {"delivery_settings":{"rate_limit":5}} to slow a
// send down removes from_email entirely, and senderHeaders then emits no From
// header at all for every remaining batch. That is a content change even though
// the caller never mentioned the sender.
func (in UpdateInput) changesSender(current map[string]any) bool {
	if in.DeliverySettings == nil {
		return false
	}
	str := func(m map[string]any) string {
		v, _ := m["from_email"].(string)
		return strings.TrimSpace(v)
	}
	return str(in.DeliverySettings) != str(current)
}
