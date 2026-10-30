// platform_events.go wires the new trigger kinds (product_event,
// inbound_webhook, email_reply) into EventDispatcher.HandleEvent.
//
// Previously HandleEvent only matched the engagement triggers
// (opened/clicked/did_not_open). The Sprint X3 wave added platform-domain
// matchers in canonical/types.go (MatchProductEvent and friends). This
// file adds a tiny dispatch table that routes incoming events of those
// kinds to the right matcher, then enqueues entry-node executions through
// the engine.

package runtime

import (
	"encoding/json"
	"strconv"
	"strings"

	"github.com/postwave/postwave/services/automation/internal/canonical"
)

// platformMatcher is one entry in the wire-event-to-matcher dispatch table.
// It returns true when the trigger fires for the supplied event payload.
type platformMatcher func(t canonical.AutomationTrigger, ev EngagementEvent) bool

// platformDispatch maps incoming event_type strings to the matcher that
// evaluates each automation trigger of that kind. Adding a new trigger
// kind is a one-line registration plus the matcher in the canonical
// package — no engine changes required.
var platformDispatch = map[string]platformMatcher{
	canonical.TriggerProductEvent:          matchProductEventWire,
	canonical.TriggerInboundWebhook:        matchInboundWebhookWire,
	canonical.TriggerEmailReply:            matchEmailReplyWire,
	canonical.TriggerLifecycleStageChanged: matchLifecycleStageWire,
	canonical.TriggerSegmentJoined:         matchSegmentJoinedWire,
	canonical.TriggerTagAdded:              matchTagEventWire,
	canonical.TriggerTagRemoved:            matchTagEventWire,
	canonical.TriggerListJoined:            matchListJoinedWire,
}

// matchTagEventWire matches tag_added / tag_removed. The tag rides on the
// payload as {"tag": "<name>"}; an unqualified trigger matches any tag.
func matchTagEventWire(t canonical.AutomationTrigger, ev EngagementEvent) bool {
	tag, _ := ev.Payload["tag"].(string)
	return canonical.MatchTagEvent(t, tag)
}

// matchListJoinedWire matches list_joined against every identity of the joined
// list the payload carries; an unqualified trigger matches any list.
func matchListJoinedWire(t canonical.AutomationTrigger, ev EngagementEvent) bool {
	return canonical.MatchListJoined(t, listJoinedPayloadIDs(ev.Payload)...)
}

// listJoinedPayloadIDs returns the joined list's identities from a list_joined
// payload: {"list_id": "<postwave uuid>", "listmonk_list_id": "<engine id>"}
// as enqueued by apps/api (migration 2052). A payload that has passed through
// a generic JSON decoder may carry the engine id as a number; it is rendered
// back to its decimal form rather than fmt's exponent notation.
func listJoinedPayloadIDs(payload map[string]interface{}) []string {
	ids := make([]string, 0, 2)
	for _, key := range []string{"list_id", "listmonk_list_id"} {
		switch v := payload[key].(type) {
		case string:
			ids = append(ids, v)
		case float64:
			ids = append(ids, strconv.FormatFloat(v, 'f', -1, 64))
		case json.Number:
			ids = append(ids, v.String())
		case int:
			ids = append(ids, strconv.Itoa(v))
		case int64:
			ids = append(ids, strconv.FormatInt(v, 10))
		}
	}
	return ids
}

// matchPlatformTrigger routes an incoming event to the appropriate
// matcher based on EventType. Returns false when EventType is not a
// platform-domain event or when the trigger does not match.
func matchPlatformTrigger(t canonical.AutomationTrigger, ev EngagementEvent) bool {
	if t.Type != ev.EventType {
		return false
	}
	fn, ok := platformDispatch[ev.EventType]
	if !ok {
		return false
	}
	return fn(t, ev)
}

// matchProductEventWire adapts the wire EngagementEvent to the canonical
// MatchProductEvent helper. The properties bag rides on Payload.
func matchProductEventWire(t canonical.AutomationTrigger, ev EngagementEvent) bool {
	return canonical.MatchProductEvent(t, eventName(ev), ev.Payload)
}

// matchInboundWebhookWire matches inbound-webhook events. The optional
// EventName narrows by name (the apps/api ingester sets it from the
// webhook body's `event` field when present).
func matchInboundWebhookWire(t canonical.AutomationTrigger, ev EngagementEvent) bool {
	if t.EventName != "" && t.EventName != eventName(ev) {
		return false
	}
	for k, want := range t.PropertyFilters {
		got, ok := ev.Payload[k]
		if !ok || got != want {
			return false
		}
	}
	return true
}

// matchEmailReplyWire matches inbound-email replies. Optional CampaignID
// narrows to a specific outbound campaign; URLPattern (interpreted as a
// substring of the reply body) further narrows.
func matchEmailReplyWire(t canonical.AutomationTrigger, ev EngagementEvent) bool {
	if t.CampaignID != "" && t.CampaignID != ev.CampaignID {
		return false
	}
	if t.URLPattern != "" {
		body, _ := ev.Payload["body"].(string)
		if !strings.Contains(body, t.URLPattern) {
			return false
		}
	}
	return true
}

// matchLifecycleStageWire adapts the wire EngagementEvent to the canonical
// MatchLifecycleStage helper (SUB-136). The transition stages ride on the
// Payload: "to_stage"/"stage" for the destination and
// "from_stage"/"previous_stage" for the origin (the apps/api lifecycle
// forwarder sets both name pairs so either convention resolves). An initial
// stage assignment with no prior stage simply has an empty from-stage, which
// still matches a trigger that does not pin FromStage.
func matchLifecycleStageWire(t canonical.AutomationTrigger, ev EngagementEvent) bool {
	to := payloadString(ev.Payload, "to_stage", "stage")
	from := payloadString(ev.Payload, "from_stage", "previous_stage")
	return canonical.MatchLifecycleStage(t, from, to)
}

// matchSegmentJoinedWire matches segment_joined events. The apps/api
// SegmentEventWorker forwards segment_id on the payload when a subscriber
// newly enters a segment; the trigger's SegmentID narrows it to one segment.
func matchSegmentJoinedWire(t canonical.AutomationTrigger, ev EngagementEvent) bool {
	return canonical.MatchSegmentJoined(t, payloadString(ev.Payload, "segment_id"))
}

// payloadString returns the first non-empty string value among keys from the
// event payload, or "" when none is present. Tolerates the two naming
// conventions the lifecycle forwarder may use for the same datum.
func payloadString(payload map[string]interface{}, keys ...string) string {
	for _, k := range keys {
		if s, ok := payload[k].(string); ok && s != "" {
			return s
		}
	}
	return ""
}

// eventName extracts the event name from a wire EngagementEvent. For
// platform-domain events the name lives on Payload["event_name"] (set by
// the apps/api forwarder). When absent we fall back to EventType so the
// matcher always has *some* string to compare.
func eventName(ev EngagementEvent) string {
	if s, ok := ev.Payload["event_name"].(string); ok && s != "" {
		return s
	}
	return ev.EventType
}
