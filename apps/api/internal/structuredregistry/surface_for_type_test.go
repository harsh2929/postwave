// SPDX-License-Identifier: AGPL-3.0-only

package structuredregistry

import "testing"

// The mapping from markup type to the surface it belongs on existed in two
// places: this registry, and a hardcoded conditional in semanticemail's
// validator. SurfaceForType exists so there is one, and the validator derives
// from it rather than restating it.
func TestSurfaceForTypeAnswersForEveryRegisteredType(t *testing.T) {
	expected := map[string]Surface{
		"DiscountOffer":    SurfacePromotions,
		"PromotionCard":    SurfacePromotions,
		"Order":            SurfaceTransactional,
		"EventReservation": SurfaceTransactional,
	}
	for markupType, want := range expected {
		got, ok := SurfaceForType(ProviderGmail, markupType)
		if !ok {
			t.Fatalf("%s has no surface", markupType)
		}
		if got != want {
			t.Fatalf("%s maps to %q, want %q", markupType, got, want)
		}
	}
	// Every registered type must be answerable, or a caller deriving its rule
	// from here would silently lose a case the registry still accepts.
	for _, markupType := range AllKnownTypes() {
		if _, ok := SurfaceForType(ProviderGmail, markupType); !ok {
			t.Fatalf("registered type %q has no surface mapping", markupType)
		}
	}
}

func TestSurfaceForTypeRefusesUnknownTypes(t *testing.T) {
	if _, ok := SurfaceForType(ProviderGmail, "SpaceshipOffer"); ok {
		t.Fatal("an unregistered type was given a surface")
	}
	if _, ok := SurfaceForType("fastmail", "DiscountOffer"); ok {
		t.Fatal("an unregistered provider was given a surface")
	}
}

// A type registered on two surfaces has no single answer, and inventing one
// would let a caller enforce a rule the registry does not actually state.
func TestSurfaceForTypeRefusesAnAmbiguousType(t *testing.T) {
	original := registry[ProviderGmail][SurfaceTransactional]["DiscountOffer"]
	registry[ProviderGmail][SurfaceTransactional]["DiscountOffer"] = SupportSupported
	defer func() {
		if original == "" {
			delete(registry[ProviderGmail][SurfaceTransactional], "DiscountOffer")
			return
		}
		registry[ProviderGmail][SurfaceTransactional]["DiscountOffer"] = original
	}()
	if _, ok := SurfaceForType(ProviderGmail, "DiscountOffer"); ok {
		t.Fatal("a type supported on two surfaces was given a single surface")
	}
}
