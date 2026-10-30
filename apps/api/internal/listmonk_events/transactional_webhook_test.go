// SPDX-License-Identifier: AGPL-3.0-only
package listmonk_events

import (
	"testing"
	"time"
)

func TestBounceWebhookEventUsesPersistedProviderIdentity(t *testing.T) {
	t.Parallel()

	at := time.Date(2026, 7, 23, 10, 11, 12, 13, time.UTC)
	event, ok := bounceWebhookEvent(CanonicalEvent{
		TenantID:        "11111111-1111-4111-8111-111111111111",
		EventType:       EventBounced,
		ProviderEventID: "provider-event-7",
		MessageID:       "message-7",
		SubscriberEmail: "Reader@Example.com",
		CampaignID:      "22222222-2222-4222-8222-222222222222",
		BounceType:      "hard",
		Reason:          "mailbox unavailable",
		At:              at,
	})
	if !ok {
		t.Fatal("bounce did not produce a canonical webhook event")
	}
	if event.EventType != "bounce.received" {
		t.Fatalf("event type = %q; want bounce.received", event.EventType)
	}
	if event.SourceEventID != "listmonk-bounce:provider-event-7:reader@example.com:22222222-2222-4222-8222-222222222222:2026-07-23T10:11:12.000000013Z" {
		t.Fatalf("source id = %q", event.SourceEventID)
	}
	if event.OccurredAt != at {
		t.Fatalf("occurred at = %s; want %s", event.OccurredAt, at)
	}
	if event.Body["provider_event_id"] != "provider-event-7" ||
		event.Body["email"] != "Reader@Example.com" ||
		event.Body["bounce_type"] != "hard" {
		t.Fatalf("payload = %#v", event.Body)
	}
}

func TestBounceWebhookEventIgnoresNonBounceEvents(t *testing.T) {
	t.Parallel()
	if _, ok := bounceWebhookEvent(CanonicalEvent{
		TenantID:  "11111111-1111-4111-8111-111111111111",
		EventType: EventOpened,
	}); ok {
		t.Fatal("open event produced a bounce webhook")
	}
}
