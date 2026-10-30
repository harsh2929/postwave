// SPDX-License-Identifier: AGPL-3.0-only
package canonical

import "testing"

func TestMatchProductEvent_NameOnly(t *testing.T) {
	trig := AutomationTrigger{Type: TriggerProductEvent, EventName: "purchase"}
	if !MatchProductEvent(trig, "purchase", nil) {
		t.Fatal("expected name-only match")
	}
	if MatchProductEvent(trig, "signup", nil) {
		t.Fatal("expected mismatch on different name")
	}
}

func TestMatchProductEvent_PropertyFilters(t *testing.T) {
	trig := AutomationTrigger{
		Type:            TriggerProductEvent,
		EventName:       "purchase",
		PropertyFilters: map[string]interface{}{"plan": "pro"},
	}
	if !MatchProductEvent(trig, "purchase", map[string]interface{}{"plan": "pro", "amount": 29}) {
		t.Fatal("expected match with extra props")
	}
	if MatchProductEvent(trig, "purchase", map[string]interface{}{"plan": "free"}) {
		t.Fatal("expected mismatch on filter value")
	}
	if MatchProductEvent(trig, "purchase", map[string]interface{}{"amount": 29}) {
		t.Fatal("expected mismatch when filter key missing")
	}
}

func TestMatchProductEvent_RejectsWrongType(t *testing.T) {
	trig := AutomationTrigger{Type: "list_join"}
	if MatchProductEvent(trig, "purchase", nil) {
		t.Fatal("non-product trigger should not match")
	}
}
