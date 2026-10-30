// SPDX-License-Identifier: AGPL-3.0-only

package campaignchecks

import (
	"encoding/json"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/structuredregistry"
)

func parseRoot(t *testing.T, raw string) any {
	t.Helper()
	var value any
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		t.Fatalf("fixture is not JSON: %v", err)
	}
	return value
}

// The allowlist must come from the provider registry rather than a second
// literal list in this file. Without this test the two can drift silently:
// removing a type from the registry left the validator accepting it, because
// nothing here exercised the boundary.
func TestStructuredValidationAcceptsExactlyTheRegistryTypes(t *testing.T) {
	// Written out rather than read from AllKnownTypes(). Deriving the
	// expectation from the code under test makes the assertion unfalsifiable:
	// remove a type from the registry and a range over AllKnownTypes() simply
	// stops checking it, so the test passes while the capability disappears.
	// Verified by mutation — the loop-driven version did not catch exactly that.
	expected := []string{"DiscountOffer", "EventReservation", "Order", "PromotionCard"}
	if known := structuredregistry.AllKnownTypes(); len(known) != len(expected) {
		t.Fatalf("registry contents changed to %v; update this list deliberately "+
			"and confirm the provider documentation still supports each type", known)
	}
	for _, markupType := range expected {
		root := parseRoot(t, `{"@context":"https://schema.org","@type":"`+markupType+`"}`)
		if err := validateStructuredRoots(root); err != nil {
			t.Fatalf("registry type %q was rejected by the validator: %v", markupType, err)
		}
	}
	for _, markupType := range []string{"SpaceshipOffer", "Person", "WebPage", ""} {
		root := parseRoot(t, `{"@context":"https://schema.org","@type":"`+markupType+`"}`)
		if err := validateStructuredRoots(root); err == nil {
			t.Fatalf("type %q is not in the registry but the validator accepted it", markupType)
		}
	}
}

// The union is a floor, not the contract. This pins the known weakness so it
// is a documented limitation rather than a silent one: a Promotions annotation
// still passes generic validation on a transactional send, and closing that
// requires plumbing the send surface into validateStructuredRoots.
func TestGenericValidationStillAcceptsAPromotionsTypeWithoutSurfaceContext(t *testing.T) {
	root := parseRoot(t, `{"@context":"https://schema.org","@type":"DiscountOffer"}`)
	if err := validateStructuredRoots(root); err != nil {
		t.Fatalf("unexpected rejection: %v", err)
	}
	// The surface-aware answer, which this call site cannot yet reach.
	if support := structuredregistry.Lookup(
		structuredregistry.ProviderGmail,
		structuredregistry.SurfaceTransactional,
		"DiscountOffer",
	); support == structuredregistry.SupportSupported {
		t.Fatal("registry now claims DiscountOffer works on transactional sends")
	}
}
