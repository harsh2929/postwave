package flowbuilder

// Unit coverage for the trigger-matching helper that powers MatchFlowsForEvent.
// The DB-touching path is exercised separately in track/fanout_test via a
// mock RunEnqueuer; here we just lock down the JSON shape contract.

import "testing"

func TestMatchProductEventTrigger_MatchesByName(t *testing.T) {
	triggers := []byte(`[{"type":"product_event","event_name":"placed_order"}]`)
	idx, _, ok := matchProductEventTrigger(triggers, "placed_order")
	if !ok || idx != 0 {
		t.Fatalf("idx=%d ok=%v, want 0,true", idx, ok)
	}
}

func TestMatchProductEventTrigger_CaseInsensitive(t *testing.T) {
	triggers := []byte(`[{"type":"PRODUCT_EVENT","event_name":"Placed_Order"}]`)
	_, _, ok := matchProductEventTrigger(triggers, "placed_order")
	if !ok {
		t.Fatalf("expected case-insensitive match")
	}
}

func TestMatchProductEventTrigger_LegacyCustomEvent(t *testing.T) {
	triggers := []byte(`[{"type":"custom_event","event_name":"checkout_started"}]`)
	_, _, ok := matchProductEventTrigger(triggers, "checkout_started")
	if !ok {
		t.Fatalf("expected custom_event trigger to match")
	}
}

func TestMatchProductEventTrigger_WildcardOnEmptyName(t *testing.T) {
	// Draft flows can have a product_event trigger without an event_name set
	// yet. We treat that as a dev-time wildcard, so the runtime still sees
	// the flow being exercised. Production flows must have a concrete name.
	triggers := []byte(`[{"type":"product_event"}]`)
	_, _, ok := matchProductEventTrigger(triggers, "anything")
	if !ok {
		t.Fatalf("expected empty event_name to wildcard")
	}
}

func TestMatchProductEventTrigger_IgnoresOtherTriggerTypes(t *testing.T) {
	triggers := []byte(`[{"type":"list_joined","list_id":"L1"}]`)
	if _, _, ok := matchProductEventTrigger(triggers, "anything"); ok {
		t.Fatalf("list_joined trigger should not match product events")
	}
}

func TestMatchProductEventTrigger_MismatchEventName(t *testing.T) {
	triggers := []byte(`[{"type":"product_event","event_name":"placed_order"}]`)
	if _, _, ok := matchProductEventTrigger(triggers, "viewed_product"); ok {
		t.Fatalf("expected miss on different event_name")
	}
}

func TestMatchProductEventTrigger_BadJSONNoMatch(t *testing.T) {
	if _, _, ok := matchProductEventTrigger([]byte("not-json"), "x"); ok {
		t.Fatalf("expected miss on invalid json")
	}
}

func TestMatchProductEventTrigger_DeliveredTriggerAndOptimizedDelay(t *testing.T) {
	triggers := []byte(`[{"type":"subscriber_delivered_email","delay_strategy":"optimized"}]`)
	idx, strategy, ok := matchProductEventTrigger(triggers, "subscriber.delivered")
	if !ok || idx != 0 || strategy != "optimized" {
		t.Fatalf("idx=%d strategy=%q ok=%v, want 0,optimized,true", idx, strategy, ok)
	}
}
