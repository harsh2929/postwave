// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/events"
)

func TestCanonicalSourceEventIDPreservesPublisherIdentity(t *testing.T) {
	id := uuid.NewString()
	got := canonicalSourceEventID(events.Event{ID: id})
	if got != id {
		t.Fatalf("canonicalSourceEventID = %q; want publisher id %q", got, id)
	}
}

func TestCanonicalSourceEventIDFallbackIsStableAndUUIDShaped(t *testing.T) {
	event := events.Event{
		TenantID: "tenant-1",
		Topic:    "campaign.sent",
		At:       time.Date(2026, 7, 23, 1, 2, 3, 4, time.UTC),
		Payload:  map[string]any{"campaign_id": "campaign-1"},
	}
	first := canonicalSourceEventID(event)
	second := canonicalSourceEventID(event)
	if first != second {
		t.Fatalf("fallback ids differ: %q != %q", first, second)
	}
	if _, err := uuid.Parse(first); err != nil {
		t.Fatalf("fallback id %q is not UUID-shaped: %v", first, err)
	}
}

func TestTransactionallyOwnedEventsNeverRefanoutFromRealtimeBus(t *testing.T) {
	for _, topic := range AllowedEvents {
		if !isTransactionallyOwnedEvent(topic) {
			t.Errorf("public event %q is not transactionally owned", topic)
		}
	}
	if isTransactionallyOwnedEvent("subscriber.updated") {
		t.Error("non-catalog event unexpectedly marked transactionally owned")
	}
}
