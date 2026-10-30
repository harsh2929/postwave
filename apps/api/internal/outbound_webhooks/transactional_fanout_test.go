// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"testing"

	"github.com/google/uuid"
)

func TestCanonicalTransactionalEventAliasesAreExplicit(t *testing.T) {
	cases := map[string]string{
		"subscriber.created":      "subscriber.added",
		"subscriber.deleted":      "subscriber.removed",
		"subscriber.bounced":      "bounce.received",
		"subscriber.unsubscribed": "subscriber.unsubscribed",
		"campaign.sent":           "campaign.sent",
	}
	for input, want := range cases {
		got, ok := canonicalTransactionalEventType(input)
		if !ok || got != want {
			t.Fatalf("canonicalTransactionalEventType(%q) = (%q, %v); want (%q, true)", input, got, ok, want)
		}
	}
	if got, ok := canonicalTransactionalEventType("subscriber.updated"); ok || got != "subscriber.updated" {
		t.Fatalf("unsupported legacy event mapped as canonical: (%q, %v)", got, ok)
	}
	if IsTransactionalEventType("subscriber.updated") {
		t.Fatal("legacy-only subscriber.updated advertised as canonical")
	}
}

func TestTransactionalSourceEventIDIsStableAndTopicIndependent(t *testing.T) {
	first := transactionalSourceEventID("tenant-1", "request-123")
	retry := transactionalSourceEventID("tenant-1", "request-123")
	if first != retry {
		t.Fatalf("retry source ids differ: %q != %q", first, retry)
	}
	if _, err := uuid.Parse(first); err != nil {
		t.Fatalf("source id = %q; want UUID: %v", first, err)
	}
	existing := uuid.NewString()
	if got := transactionalSourceEventID("tenant-1", existing); got != existing {
		t.Fatalf("UUID source identity changed: got %q want %q", got, existing)
	}
}

func TestTransactionalListIDReadsOnlyTopLevelListScope(t *testing.T) {
	if got := transactionalListID([]byte(`{"list_id":" list-1 "}`)); got != "list-1" {
		t.Fatalf("list id = %q; want list-1", got)
	}
	if got := transactionalListID([]byte(`{"nested":{"list_id":"list-2"}}`)); got != "" {
		t.Fatalf("nested list id escaped scope contract: %q", got)
	}
}

func TestTransactionalBodyJSONRequiresBoundedObject(t *testing.T) {
	if got, err := transactionalBodyJSON(nil); err != nil || string(got) != "{}" {
		t.Fatalf("nil body = %q, %v; want {}", got, err)
	}
	if _, err := transactionalBodyJSON([]string{"not", "an", "object"}); err == nil {
		t.Fatal("array event data accepted")
	}
	tooLarge := map[string]any{"value": string(make([]byte, maxTransactionalEventDataBytes))}
	if _, err := transactionalBodyJSON(tooLarge); err == nil {
		t.Fatal("oversized event data accepted")
	}
}
