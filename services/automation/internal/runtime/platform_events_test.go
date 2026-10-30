// SPDX-License-Identifier: AGPL-3.0-only
package runtime

import (
	"testing"
	"time"

	"github.com/postwave/postwave/services/automation/internal/canonical"
)

func ev(eventType string, payload map[string]interface{}) EngagementEvent {
	return EngagementEvent{
		TenantID:        "t1",
		SubscriberEmail: "u@x",
		EventType:       eventType,
		Payload:         payload,
		At:              time.Now().UTC(),
	}
}

func TestMatchPlatformTrigger_ProductEvent(t *testing.T) {
	trig := canonical.AutomationTrigger{
		Type:            canonical.TriggerProductEvent,
		EventName:       "purchase",
		PropertyFilters: map[string]interface{}{"plan": "pro"},
	}
	hit := ev(canonical.TriggerProductEvent, map[string]interface{}{
		"event_name": "purchase",
		"plan":       "pro",
	})
	if !matchPlatformTrigger(trig, hit) {
		t.Fatal("product_event with matching props should match")
	}
	miss := ev(canonical.TriggerProductEvent, map[string]interface{}{
		"event_name": "purchase",
		"plan":       "free",
	})
	if matchPlatformTrigger(trig, miss) {
		t.Fatal("product_event with mismatching props should not match")
	}
}

func TestMatchPlatformTrigger_InboundWebhook(t *testing.T) {
	trig := canonical.AutomationTrigger{
		Type:            canonical.TriggerInboundWebhook,
		EventName:       "stripe.charge.refunded",
		PropertyFilters: map[string]interface{}{"livemode": true},
	}
	hit := ev(canonical.TriggerInboundWebhook, map[string]interface{}{
		"event_name": "stripe.charge.refunded",
		"livemode":   true,
	})
	if !matchPlatformTrigger(trig, hit) {
		t.Fatal("inbound_webhook should match")
	}
	miss := ev(canonical.TriggerInboundWebhook, map[string]interface{}{
		"event_name": "stripe.charge.refunded",
		"livemode":   false,
	})
	if matchPlatformTrigger(trig, miss) {
		t.Fatal("inbound_webhook with bad property should not match")
	}
}

func TestMatchPlatformTrigger_EmailReply(t *testing.T) {
	trig := canonical.AutomationTrigger{
		Type:       canonical.TriggerEmailReply,
		CampaignID: "c1",
		URLPattern: "interested",
	}
	hit := ev(canonical.TriggerEmailReply, map[string]interface{}{
		"body": "yes I am very interested",
	})
	hit.CampaignID = "c1"
	if !matchPlatformTrigger(trig, hit) {
		t.Fatal("email_reply with matching body+campaign should match")
	}
	miss := ev(canonical.TriggerEmailReply, map[string]interface{}{"body": "no thanks"})
	miss.CampaignID = "c1"
	if matchPlatformTrigger(trig, miss) {
		t.Fatal("email_reply without keyword should not match")
	}
	wrongCampaign := ev(canonical.TriggerEmailReply, map[string]interface{}{"body": "interested"})
	wrongCampaign.CampaignID = "c2"
	if matchPlatformTrigger(trig, wrongCampaign) {
		t.Fatal("email_reply with wrong campaign should not match")
	}
}

func TestMatchPlatformTrigger_RejectsUnknownType(t *testing.T) {
	trig := canonical.AutomationTrigger{Type: "list_join"}
	if matchPlatformTrigger(trig, ev("list_join", nil)) {
		t.Fatal("non-platform trigger should not route through platform dispatch")
	}
}
