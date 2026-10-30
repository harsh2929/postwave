// Package canonical mirrors the subset of canonical migration types the
// automation runtime needs to execute Automation ASTs.
//
// Mirror — keep in sync with services/migration/internal/canonical/types.go
// until we have a shared schema package. Any change to the migration
// canonical types MUST be reflected here in the same PR.
//
// We deliberately copy rather than import migration's package because:
//   - the runtime should not depend on the migration service (different
//     deploy unit, different release cadence), and
//   - the migration package pulls in a wider type surface (MigrationJob,
//     adapter capabilities, etc.) that has no business in the runtime.
package canonical

import (
	"strings"
	"time"
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

// Subscriber is the canonical contact record (subset used by runtime).
type Subscriber struct {
	Email            string                 `json:"email"`
	Phone            string                 `json:"phone,omitempty"`
	Status           SubscriberStatus       `json:"status"`
	ConsentTimestamp *time.Time             `json:"consent_timestamp"`
	ConsentSource    ConsentSource          `json:"consent_source"`
	CustomFields     map[string]interface{} `json:"custom_fields"`
	Tags             []string               `json:"tags"`
	SourceID         string                 `json:"source_id"`
	SourcePlatform   string                 `json:"source_platform"`
}

// SegmentNode is a tagged-union AST node (unchanged from migration mirror).
type SegmentNode struct {
	Op         string        `json:"op"`
	Children   []SegmentNode `json:"children,omitempty"`
	Field      string        `json:"field,omitempty"`
	Comparator string        `json:"comparator,omitempty"`
	Value      interface{}   `json:"value,omitempty"`
}

// SegmentCondition is a leaf segment node (used inline by branch nodes).
type SegmentCondition struct {
	Op         string      `json:"op"` // always "condition"
	Field      string      `json:"field"`
	Comparator string      `json:"comparator"`
	Value      interface{} `json:"value"`
}

// Automation is a translated journey/sequence/automation flow.
// ReEnrollment controls whether a subscriber may enter a flow more than once.
//
// Every recurring flow a marketing platform exists to run — abandoned cart,
// browse abandonment, win-back, birthday, back-in-stock, replenishment —
// requires re-entry. Before this existed, the execution row's primary key was
// sha256(automation_id | email), so a subscriber traversed any given flow
// exactly once, ever.
//
// The zero value is ReEnrollOnce, and that is deliberate: defaulting to
// "always" would make every subscriber who has ever completed a flow eligible
// again the instant this deploys, mass-re-sending the entire history.
// Operators opt in per flow.
type ReEnrollment string

const (
	// ReEnrollOnce is the zero value: a subscriber enters at most once.
	// Correct for welcome series and onboarding.
	ReEnrollOnce ReEnrollment = ""
	// ReEnrollAlways starts a fresh run on every matching trigger. Correct
	// for abandoned cart, back-in-stock, replenishment.
	ReEnrollAlways ReEnrollment = "always"
	// ReEnrollAfterCooldown starts a fresh run only when the previous run
	// began more than CooldownHours ago. Correct for win-back and birthday,
	// where re-entry is wanted but not unboundedly often.
	ReEnrollAfterCooldown ReEnrollment = "cooldown"
)

type Automation struct {
	ID       string              `json:"id"`
	TenantID string              `json:"tenant_id"`
	Name     string              `json:"name"`
	Status   string              `json:"status"` // active|paused|draft
	Triggers []AutomationTrigger `json:"triggers"`
	Nodes    []AutomationNode    `json:"nodes"`
	Edges    []AutomationEdge    `json:"edges"`
	EntryID  string              `json:"entry_id"`

	// ReEnrollment defaults to ReEnrollOnce (the zero value), preserving the
	// historical fire-once behaviour for every flow that does not opt in.
	ReEnrollment ReEnrollment `json:"re_enrollment,omitempty"`
	// CooldownHours applies only when ReEnrollment == ReEnrollAfterCooldown.
	CooldownHours int `json:"cooldown_hours,omitempty"`
}

// AutomationTrigger fires an automation. Type discriminates the payload.
//
// Engagement-based trigger types (consumed by runtime/events.go):
//   - "subscriber_opened_email"   — fires on an opened event. Optional
//     CampaignID narrows to a single campaign; WithinDays narrows to a
//     recency window evaluated against the event's at-time.
//   - "subscriber_clicked_link"   — fires on a clicked event. Optional
//     CampaignID + URLPattern (substring match) narrow.
//   - "subscriber_did_not_open"   — fires when a campaign was sent more
//     than AfterDays ago to the subscriber and there is still no opened
//     event recorded. Scheduled by the runtime as a one-time evaluator
//     job at campaign.sent_at + AfterDays.
type AutomationTrigger struct {
	ID         string     `json:"id,omitempty"`
	CreatedAt  *time.Time `json:"created_at,omitempty"`
	Type       string     `json:"type"`
	ListID     string     `json:"list_id,omitempty"`
	Tag        string     `json:"tag,omitempty"`
	GroupID    string     `json:"group_id,omitempty"`
	FormID     string     `json:"form_id,omitempty"`
	SegmentID  string     `json:"segment_id,omitempty"`
	EventName  string     `json:"event_name,omitempty"`
	Field      string     `json:"field,omitempty"`
	OffsetDays int        `json:"offset_days,omitempty"`
	// Engagement-trigger qualifiers.
	CampaignID string                 `json:"campaign_id,omitempty"`
	URLPattern string                 `json:"url_pattern,omitempty"`
	WithinDays int                    `json:"within_days,omitempty"`
	AfterDays  int                    `json:"after_days,omitempty"`
	Metadata   map[string]interface{} `json:"metadata,omitempty"`
	// Recurring "every N days" trigger fields. Type must be
	// TriggerKindEveryNDays. EveryNDays is the day cadence (1+);
	// TimeOfDay is "HH:MM" in TZ (IANA name; defaults to UTC).
	EveryNDays int    `json:"every_n_days,omitempty"`
	TimeOfDay  string `json:"time_of_day,omitempty"`
	TZ         string `json:"tz,omitempty"`
	// Platform-domain trigger qualifiers (kind: product_event,
	// inbound_webhook, email_reply). PropertyFilters narrows
	// product_event triggers to events whose properties JSON contains
	// every (key, value) pair listed.
	PropertyFilters map[string]interface{} `json:"property_filters,omitempty"`
	// Lifecycle-stage trigger qualifiers (kind:
	// subscriber_lifecycle_stage_changed, SUB-136). FromStage / ToStage
	// optionally narrow the transition: a non-empty ToStage requires the
	// subscriber to have entered exactly that stage (e.g. "customer"); a
	// non-empty FromStage additionally requires they came from that stage
	// (e.g. opportunity → customer fires an onboarding sequence). Empty on either
	// side means "any stage" on that side, so a bare trigger fires on every
	// lifecycle transition.
	FromStage string `json:"from_stage,omitempty"`
	ToStage   string `json:"to_stage,omitempty"`
}

// TriggerKindEveryNDays is the recurring "every N days at time-of-day"
// trigger kind. The scheduler computes the next fire time anchored to
// TimeOfDay in TZ stepping by N days.
const TriggerKindEveryNDays = "every_n_days"

// Platform-domain trigger discriminators consumed by the dispatcher when
// the apps/api gateway forwards events from /api/v1/track,
// /api/public/inbound, and /api/public/inbound-email.
const (
	TriggerProductEvent   = "product_event"
	TriggerInboundWebhook = "inbound_webhook"
	TriggerEmailReply     = "email_reply"
	// TriggerLifecycleStageChanged (SUB-136) fires when a subscriber
	// transitions between lifecycle stages. The apps/api lifecycle Upsert
	// handler forwards a subscriber_lifecycle_stage_changed event (carrying
	// previous_stage + stage on the payload) whenever a PUT
	// /api/v1/subscribers/{id}/lifecycle actually changes the stage. A
	// onboarding sequence keyed on to_stage="customer" then fires.
	TriggerLifecycleStageChanged = "subscriber_lifecycle_stage_changed"
	// TriggerSegmentJoined fires when a subscriber newly enters a saved
	// segment. The apps/api SegmentEventWorker detects the membership
	// transition (a subscriber now matching the segment predicate who was
	// not previously cached in segment_subscribers) and forwards a
	// segment_joined event carrying segment_id on the payload. The trigger's
	// SegmentID narrows it to one segment (Required in the flow catalog).
	TriggerSegmentJoined = "segment_joined"
)

// Audience-membership triggers.
//
// The flow-builder catalog has always advertised these as
// RuntimeStatus:"supported", but the runtime had no matcher for them, and their
// apps/api producers wrote rows into flow_runs — a queue with no consumer. So
// "send a welcome email when someone joins this list" and "start a flow when
// this tag is applied" were both inert end to end.
const (
	// TriggerTagAdded fires when a tag is applied to a subscriber.
	// Payload: {"tag": "<name>"}. An empty AutomationTrigger.Tag matches any tag.
	TriggerTagAdded = "tag_added"
	// TriggerTagRemoved fires when a tag is removed. Same payload shape.
	TriggerTagRemoved = "tag_removed"
	// TriggerListJoined fires when a subscriber joins a list.
	// Payload: {"list_id": "<postwave uuid>", "listmonk_list_id": "<engine id>"}
	// (apps/api enqueue_list_joined_flow_runs, migration 2052). An empty
	// AutomationTrigger.ListID matches any list.
	TriggerListJoined = "list_joined"
)

// MatchTagEvent reports whether a tag_added / tag_removed trigger fires for the
// given tag. An unqualified trigger (no Tag) matches any tag.
func MatchTagEvent(t AutomationTrigger, tag string) bool {
	if t.Tag == "" {
		return true
	}
	return strings.EqualFold(strings.TrimSpace(t.Tag), strings.TrimSpace(tag))
}

// MatchListJoined reports whether a list_joined trigger fires for a join of the
// list identified by listIDs — every identity the join carries.
//
// A list has two identities: the Moosewave uuid membership is keyed on, and the
// engine id every list picker holds (the flow editor saves the trigger with
// the latter). Comparing the trigger with the uuid alone meant a flow built in
// the editor never fired. A trigger naming the list by either identity fires;
// a uuid compares case-insensitively. An unqualified trigger (no ListID)
// matches any list.
func MatchListJoined(t AutomationTrigger, listIDs ...string) bool {
	want := strings.TrimSpace(t.ListID)
	if want == "" {
		return true
	}
	for _, id := range listIDs {
		if got := strings.TrimSpace(id); got != "" && strings.EqualFold(got, want) {
			return true
		}
	}
	return false
}

// MatchLifecycleStage reports whether trigger t fires for a lifecycle-stage
// transition from fromStage to toStage. Kept here (alongside
// MatchProductEvent) so the matcher is unit-testable without importing the
// runtime package.
//
// Semantics: an empty t.ToStage matches any destination stage; a non-empty
// t.ToStage requires an exact match on the stage entered. An empty t.FromStage
// matches any origin stage (including an initial stage assignment with no prior
// stage); a non-empty t.FromStage requires an exact match on the stage left.
// So a trigger with FromStage="opportunity", ToStage="customer" fires only on
// that specific transition, while a bare trigger fires on every
// stage change.
func MatchLifecycleStage(t AutomationTrigger, fromStage, toStage string) bool {
	if t.Type != TriggerLifecycleStageChanged {
		return false
	}
	if !ValidLifecycleStage(toStage) ||
		(fromStage != "" && !ValidLifecycleStage(fromStage)) ||
		!ValidLifecycleTrigger(t) {
		return false
	}
	if t.ToStage != "" && t.ToStage != toStage {
		return false
	}
	if t.FromStage != "" && t.FromStage != fromStage {
		return false
	}
	return true
}

// ValidLifecycleStage is the one runtime vocabulary shared with the
// subscriber lifecycle API and database CHECK constraints. Keeping validation
// here prevents an impossible flow definition from being silently inert.
func ValidLifecycleStage(stage string) bool {
	switch stage {
	case "subscriber", "lead", "mql", "sql", "opportunity", "customer", "evangelist", "other":
		return true
	default:
		return false
	}
}

// ValidLifecycleTrigger validates the optional stage qualifiers on a
// lifecycle-stage trigger. Empty qualifiers intentionally retain the documented
// wildcard semantics; any non-empty value must be canonical.
func ValidLifecycleTrigger(t AutomationTrigger) bool {
	if t.Type != TriggerLifecycleStageChanged {
		return false
	}
	return (t.FromStage == "" || ValidLifecycleStage(t.FromStage)) &&
		(t.ToStage == "" || ValidLifecycleStage(t.ToStage))
}

// MatchSegmentJoined reports whether trigger t fires for a subscriber that
// just entered the segment identified by segmentID. A segment_joined trigger
// MUST name a segment (SegmentID); a trigger with an empty SegmentID never
// fires (there is no "any segment" semantic — that would enroll on every
// segment transition platform-wide). The comparison is exact-match on the
// segment id string.
func MatchSegmentJoined(t AutomationTrigger, segmentID string) bool {
	if t.Type != TriggerSegmentJoined {
		return false
	}
	if t.SegmentID == "" || segmentID == "" {
		return false
	}
	return t.SegmentID == segmentID
}

// MatchProductEvent reports whether trigger t fires for a product event with
// the supplied event name + properties bag. Kept here so the matcher is
// unit-testable without importing the runtime package.
func MatchProductEvent(t AutomationTrigger, eventName string, properties map[string]interface{}) bool {
	if t.Type != TriggerProductEvent {
		return false
	}
	if t.EventName != "" && t.EventName != eventName {
		return false
	}
	for k, v := range t.PropertyFilters {
		got, ok := properties[k]
		if !ok || got != v {
			return false
		}
	}
	return true
}

// AutomationNode is a step in the journey graph.
//
// Type values include "wait", "wait_until", "wait_until_trigger",
// "send_email", "send_sms", "branch", "percentage_split", "webhook",
// "goal", and "action".
type AutomationNode struct {
	ID              string                   `json:"id"`
	Type            string                   `json:"type"`
	DurationSeconds int64                    `json:"duration_seconds,omitempty"`
	WaitUntil       *time.Time               `json:"wait_until,omitempty"`
	WaitTrigger     *AutomationTrigger       `json:"wait_trigger,omitempty"`
	TemplateID      string                   `json:"template_id,omitempty"`
	SMSBody         string                   `json:"sms_body,omitempty"`
	WebhookURL      string                   `json:"webhook_url,omitempty"`
	WebhookMethod   string                   `json:"webhook_method,omitempty"`
	Condition       *SegmentCondition        `json:"condition,omitempty"`
	Goal            *SegmentCondition        `json:"goal,omitempty"`
	Variants        []AutomationSplitVariant `json:"variants,omitempty"`
	TrueNext        *string                  `json:"true_next,omitempty"`
	FalseNext       *string                  `json:"false_next,omitempty"`
	Action          *AutomationAction        `json:"action,omitempty"`
	Metadata        map[string]interface{}   `json:"metadata,omitempty"`
	// RequiresApproval, when true, causes the automation runtime to halt the
	// execution at this node, request a human approval, and refuse to advance
	// until that approval row is decided. Used by safety-conscious tenants
	// to gate agent-authored automations.
	RequiresApproval bool `json:"requires_approval,omitempty"`
}

// AutomationAction mutates subscriber state.
//
// Kind values: "add_tag" | "remove_tag" | "move_to_list" | "unsubscribe".
type AutomationAction struct {
	Kind     string                 `json:"kind"`
	Tag      string                 `json:"tag,omitempty"`
	ListID   string                 `json:"list_id,omitempty"`
	GroupID  string                 `json:"group_id,omitempty"`
	Field    string                 `json:"field,omitempty"`
	Value    interface{}            `json:"value,omitempty"`
	Message  string                 `json:"message,omitempty"`
	URL      string                 `json:"url,omitempty"`
	Metadata map[string]interface{} `json:"metadata,omitempty"`
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

// NextNode returns the linear successor of nodeID in the automation's edges,
// or empty string if none. Branch nodes do not use this (they pick true/false
// explicitly); wait/send/action nodes do.
func (a *Automation) NextNode(nodeID string) string {
	for _, e := range a.Edges {
		if e.From == nodeID {
			return e.To
		}
	}
	return ""
}

// FindNode returns the node with the given ID, or nil.
func (a *Automation) FindNode(nodeID string) *AutomationNode {
	for i := range a.Nodes {
		if a.Nodes[i].ID == nodeID {
			return &a.Nodes[i]
		}
	}
	return nil
}
