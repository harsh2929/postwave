package runtime

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/services/automation/internal/canonical"
)

// tag_added / tag_removed / list_joined are advertised by the flow-builder
// catalog as RuntimeStatus:"supported". Their producers in apps/api write rows
// into flow_runs — a queue with no consumer — and the automation service had no
// matcher for these event types at all, so even a delivered event would have
// been dropped on the floor.
//
// Net: "send a welcome email when someone joins this list" and "start a flow
// when this tag is applied" were both inert.

func fireEvent(t *testing.T, e *Engine, r *MemoryResolver, q *MemoryQueue, ev EngagementEvent) {
	t.Helper()
	d := &EventDispatcher{Engine: e, Lister: r}
	if err := d.HandleEvent(context.Background(), ev); err != nil {
		t.Fatal(err)
	}
	drain(t, e, q)
}

func TestTagAddedTriggerFiresTheFlow(t *testing.T) {
	e, lm, q, _, r := buildEngine(t)
	r.PutAutomation(&canonical.Automation{
		ID: "a", TenantID: "t", Status: "active",
		Triggers: []canonical.AutomationTrigger{{Type: canonical.TriggerTagAdded, Tag: "vip"}},
		EntryID:  "n1",
		Nodes:    []canonical.AutomationNode{{ID: "n1", Type: "send_email", TemplateID: "1"}},
	})
	r.PutSubscriber("t", canonical.Subscriber{Email: "u@x.com"})

	// Wrong tag — must not fire.
	fireEvent(t, e, r, q, EngagementEvent{
		TenantID: "t", SubscriberEmail: "u@x.com", EventType: canonical.TriggerTagAdded,
		Payload: map[string]interface{}{"tag": "other"}, At: time.Now().UTC(),
	})
	if len(lm.sends) != 0 {
		t.Fatalf("a different tag must not fire the flow; sent %d", len(lm.sends))
	}

	// Matching tag — must fire.
	fireEvent(t, e, r, q, EngagementEvent{
		TenantID: "t", SubscriberEmail: "u@x.com", EventType: canonical.TriggerTagAdded,
		Payload: map[string]interface{}{"tag": "vip"}, At: time.Now().UTC(),
	})
	if len(lm.sends) != 1 {
		t.Fatalf("tag_added must start the flow; sent %d, want 1", len(lm.sends))
	}
}

func TestTagRemovedTriggerFiresTheFlow(t *testing.T) {
	e, lm, q, _, r := buildEngine(t)
	r.PutAutomation(&canonical.Automation{
		ID: "a", TenantID: "t", Status: "active",
		Triggers: []canonical.AutomationTrigger{{Type: canonical.TriggerTagRemoved, Tag: "vip"}},
		EntryID:  "n1",
		Nodes:    []canonical.AutomationNode{{ID: "n1", Type: "send_email", TemplateID: "1"}},
	})
	r.PutSubscriber("t", canonical.Subscriber{Email: "u@x.com"})

	fireEvent(t, e, r, q, EngagementEvent{
		TenantID: "t", SubscriberEmail: "u@x.com", EventType: canonical.TriggerTagRemoved,
		Payload: map[string]interface{}{"tag": "vip"}, At: time.Now().UTC(),
	})
	if len(lm.sends) != 1 {
		t.Fatalf("tag_removed must start the flow; sent %d, want 1", len(lm.sends))
	}
}

// An empty Tag on the trigger means "any tag".
func TestTagTriggerWithNoTagMatchesAny(t *testing.T) {
	e, lm, q, _, r := buildEngine(t)
	r.PutAutomation(&canonical.Automation{
		ID: "a", TenantID: "t", Status: "active",
		Triggers: []canonical.AutomationTrigger{{Type: canonical.TriggerTagAdded}},
		EntryID:  "n1",
		Nodes:    []canonical.AutomationNode{{ID: "n1", Type: "send_email", TemplateID: "1"}},
	})
	r.PutSubscriber("t", canonical.Subscriber{Email: "u@x.com"})
	fireEvent(t, e, r, q, EngagementEvent{
		TenantID: "t", SubscriberEmail: "u@x.com", EventType: canonical.TriggerTagAdded,
		Payload: map[string]interface{}{"tag": "anything"}, At: time.Now().UTC(),
	})
	if len(lm.sends) != 1 {
		t.Fatalf("an unqualified tag trigger matches any tag; sent %d, want 1", len(lm.sends))
	}
}

// joinedListPayload is the trigger_payload apps/api enqueues for a join of a
// list whose Moosewave uuid is joinedListUUID and engine id is 10 — the exact
// shape its enqueue_list_joined_flow_runs() writes (asserted against the
// database in apps/api flowbuilder TestListJoinedTriggerBuiltInTheEditorEnrolsWhoJoins).
const joinedListUUID = "5f0c8f3e-7a2b-4c41-9d6e-2b1a8c3d4e5f"

func joinedListPayload() map[string]interface{} {
	return map[string]interface{}{"list_id": joinedListUUID, "listmonk_list_id": "10"}
}

// A flow built in the editor names its list by the engine id the picker
// holds. It must fire for a join, whose payload leads with the uuid — through
// both entry points: the event dispatcher and the drainer's direct Trigger.
func TestListJoinedTriggerFiresForEitherIdentityOfTheList(t *testing.T) {
	for _, tc := range []struct {
		name    string
		trigger string
		fires   bool
	}{
		{"engine id, as the flow editor saves it", "10", true},
		{"postwave uuid, upper-case", strings.ToUpper(joinedListUUID), true},
		{"postwave uuid, padded", "  " + joinedListUUID + " ", true},
		{"another list's engine id", "11", false},
		{"another list's uuid", "0b8a6c2e-1d3f-4e5a-8b7c-9d0e1f2a3b4c", false},
	} {
		t.Run(tc.name+"/dispatcher", func(t *testing.T) {
			e, lm, q, _, r := buildEngine(t)
			r.PutAutomation(&canonical.Automation{
				ID: "a", TenantID: "t", Status: "active",
				Triggers: []canonical.AutomationTrigger{{Type: canonical.TriggerListJoined, ListID: tc.trigger}},
				EntryID:  "n1",
				Nodes:    []canonical.AutomationNode{{ID: "n1", Type: "send_email", TemplateID: "1"}},
			})
			r.PutSubscriber("t", canonical.Subscriber{Email: "u@x.com"})
			fireEvent(t, e, r, q, EngagementEvent{
				TenantID: "t", SubscriberEmail: "u@x.com", EventType: canonical.TriggerListJoined,
				Payload: joinedListPayload(), At: time.Now().UTC(),
			})
			if fired := len(lm.sends) == 1; fired != tc.fires {
				t.Fatalf("trigger list_id %q fired=%v (sends=%d), want %v", tc.trigger, fired, len(lm.sends), tc.fires)
			}
		})
		t.Run(tc.name+"/trigger", func(t *testing.T) {
			e, lm, q, _, r := buildEngine(t)
			r.PutAutomation(&canonical.Automation{
				ID: "a", TenantID: "t", Status: "active",
				Triggers: []canonical.AutomationTrigger{{Type: canonical.TriggerListJoined, ListID: tc.trigger}},
				EntryID:  "n1",
				Nodes:    []canonical.AutomationNode{{ID: "n1", Type: "send_email", TemplateID: "1"}},
			})
			r.PutSubscriber("t", canonical.Subscriber{Email: "u@x.com"})
			if err := e.Trigger(WithTenant(context.Background(), "t"), "a", canonical.TriggerListJoined, "u@x.com", joinedListPayload()); err != nil {
				t.Fatal(err)
			}
			drain(t, e, q)
			if fired := len(lm.sends) == 1; fired != tc.fires {
				t.Fatalf("trigger list_id %q fired=%v (sends=%d), want %v", tc.trigger, fired, len(lm.sends), tc.fires)
			}
		})
	}
}

// A payload that went through a generic JSON decoder carries the engine id as
// a number; it must still match, and not as "1e+06".
func TestListJoinedPayloadIDsRenderNumericEngineIDsExactly(t *testing.T) {
	got := listJoinedPayloadIDs(map[string]interface{}{"list_id": joinedListUUID, "listmonk_list_id": float64(1000000)})
	if len(got) != 2 || got[0] != joinedListUUID || got[1] != "1000000" {
		t.Fatalf("listJoinedPayloadIDs = %v", got)
	}
	if !canonical.MatchListJoined(canonical.AutomationTrigger{ListID: "1000000"}, got...) {
		t.Fatal("a numeric engine id in the payload did not match the trigger")
	}
}

// The welcome-series case: join a list, get the welcome email.
func TestListJoinedTriggerFiresTheFlow(t *testing.T) {
	e, lm, q, _, r := buildEngine(t)
	r.PutAutomation(&canonical.Automation{
		ID: "a", TenantID: "t", Status: "active",
		Triggers: []canonical.AutomationTrigger{{Type: canonical.TriggerListJoined, ListID: "L1"}},
		EntryID:  "n1",
		Nodes:    []canonical.AutomationNode{{ID: "n1", Type: "send_email", TemplateID: "1"}},
	})
	r.PutSubscriber("t", canonical.Subscriber{Email: "u@x.com"})

	// A different list must not fire it.
	fireEvent(t, e, r, q, EngagementEvent{
		TenantID: "t", SubscriberEmail: "u@x.com", EventType: canonical.TriggerListJoined,
		Payload: map[string]interface{}{"list_id": "L2"}, At: time.Now().UTC(),
	})
	if len(lm.sends) != 0 {
		t.Fatalf("joining a different list must not fire the flow; sent %d", len(lm.sends))
	}

	fireEvent(t, e, r, q, EngagementEvent{
		TenantID: "t", SubscriberEmail: "u@x.com", EventType: canonical.TriggerListJoined,
		Payload: map[string]interface{}{"list_id": "L1"}, At: time.Now().UTC(),
	})
	if len(lm.sends) != 1 {
		t.Fatalf("list_joined must start the welcome flow; sent %d, want 1", len(lm.sends))
	}
}
