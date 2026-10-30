// SPDX-License-Identifier: AGPL-3.0-only

package offers

import (
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/semanticemail"
)

const bridgeOfferID = "6b1f1f6c-4b0e-4f3a-9c2e-1a2b3c4d5e6f"

func bridgeReference() semanticemail.CanonicalOfferReference {
	return semanticemail.CanonicalOfferReference{
		NodeID:                   "blk_offer",
		CanonicalOfferID:         bridgeOfferID,
		AuthoredCode:             "SPRING20",
		AuthoredAvailabilityEnds: "2026-06-01T00:00:00Z",
	}
}

// When the message and the entity agree there is nothing to report.
//
// First, because a comparison that always finds something is not a comparison;
// and second, so the disagreement cases below cannot pass vacuously.
func TestAnAgreeingMessageAndEntityProduceNoDisagreement(t *testing.T) {
	until := at("2026-06-01T00:00:00Z")
	offer := &Offer{
		ID: bridgeOfferID, Type: "discount", Title: "Spring sale",
		ValidUntil: &until, ActionURL: "https://example.test/buy", InventoryState: "in_stock",
		Metadata: map[string]any{"code": "SPRING20"},
	}
	if got := CompareMessageToCanonical(bridgeReference(), offer, at("2026-05-01T12:00:00Z")); len(got) != 0 {
		t.Fatalf("disagreements = %+v for a message that matches the entity exactly", got)
	}
}

// Every way the two records can drift has to be named.
func TestDisagreementsBetweenTheMessageAndTheEntityAreNamed(t *testing.T) {
	now := at("2026-05-01T12:00:00Z")
	messageEnd := at("2026-06-01T00:00:00Z")
	actionURL := "https://example.test/buy"

	for _, testCase := range []struct {
		name  string
		offer Offer
		field string
	}{
		{
			name: "the entity's window moved and the message still prints the old one",
			offer: Offer{
				ID: bridgeOfferID, ActionURL: actionURL, InventoryState: "in_stock",
				ValidUntil: timePointer(messageEnd.Add(-72 * time.Hour)),
			},
			field: DisagreementAvailabilityEnds,
		},
		{
			name: "the entity has no end and the message invented a deadline",
			offer: Offer{
				ID: bridgeOfferID, ActionURL: actionURL, InventoryState: "in_stock",
			},
			field: DisagreementAvailabilityEnds,
		},
		{
			name: "the entity sold out while the message still presents it",
			offer: Offer{
				ID: bridgeOfferID, ActionURL: actionURL, InventoryState: "sold_out",
				ValidUntil: &messageEnd,
			},
			field: DisagreementInventoryState,
		},
		{
			name: "nothing asserts availability, which is not the same as available",
			offer: Offer{
				ID: bridgeOfferID, ActionURL: actionURL, InventoryState: "unknown",
				ValidUntil: &messageEnd,
			},
			field: DisagreementInventoryState,
		},
		{
			name: "the message prints a code the entity does not use",
			offer: Offer{
				ID: bridgeOfferID, ActionURL: actionURL, InventoryState: "in_stock",
				ValidUntil: &messageEnd, Metadata: map[string]any{"code": "SUMMER30"},
			},
			field: DisagreementCode,
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			offer := testCase.offer
			got := CompareMessageToCanonical(bridgeReference(), &offer, now)
			if !hasDisagreement(got, testCase.field) {
				t.Fatalf("disagreements = %+v, want one on %q", got, testCase.field)
			}
		})
	}

	// A message that states no end for an offer that HAS one told the reader it
	// is open-ended.
	silent := semanticemail.CanonicalOfferReference{NodeID: "blk_offer", CanonicalOfferID: bridgeOfferID}
	offer := Offer{ID: bridgeOfferID, ActionURL: actionURL, InventoryState: "in_stock", ValidUntil: &messageEnd}
	if got := CompareMessageToCanonical(silent, &offer, now); !hasDisagreement(got, DisagreementAvailabilityEnds) {
		t.Fatalf("disagreements = %+v; a message that never states the expiry of an expiring "+
			"offer has told the reader something untrue by omission", got)
	}

	// An offer already over when the message is read.
	past := now.Add(-time.Hour)
	expired := Offer{ID: bridgeOfferID, ActionURL: actionURL, InventoryState: "in_stock", ValidUntil: &past}
	expiredReference := bridgeReference()
	expiredReference.AuthoredAvailabilityEnds = past.UTC().Format(time.RFC3339)
	got := CompareMessageToCanonical(expiredReference, &expired, now)
	if !hasDisagreement(got, DisagreementExpired) {
		t.Fatalf("disagreements = %+v, want the expired offer reported", got)
	}
}

// A malformed reference must not take the whole resolution down with it.
func TestOnlyWellFormedReferencesReachTheDatabase(t *testing.T) {
	valid := []string{bridgeOfferID, "00000000-0000-0000-0000-000000000000"}
	for _, value := range valid {
		if !canonicalOfferIDShape(value) {
			t.Errorf("well-formed reference rejected: %q", value)
		}
	}
	invalid := []string{
		"", "offer-1", "6B1F1F6C-4B0E-4F3A-9C2E-1A2B3C4D5E6F",
		"6b1f1f6c4b0e4f3a9c2e1a2b3c4d5e6f", "6b1f1f6c-4b0e-4f3a-9c2e-1a2b3c4d5e6g",
		"6b1f1f6c-4b0e-4f3a-9c2e-1a2b3c4d5e6f ", "'; drop table offers--",
	}
	for _, value := range invalid {
		if canonicalOfferIDShape(value) {
			t.Errorf("malformed reference accepted: %q", value)
		}
	}
}

func hasDisagreement(disagreements []Disagreement, field string) bool {
	for _, disagreement := range disagreements {
		if disagreement.Field == field {
			return true
		}
	}
	return false
}

func timePointer(value time.Time) *time.Time { return &value }
