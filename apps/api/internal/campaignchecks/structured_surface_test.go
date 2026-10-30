// SPDX-License-Identifier: AGPL-3.0-only

package campaignchecks

import (
	"encoding/json"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/structuredregistry"
)

func rootOfType(t *testing.T, markupType string) any {
	t.Helper()
	var value any
	if err := json.Unmarshal([]byte(
		`{"@context":"https://schema.org","@type":"`+markupType+`"}`), &value); err != nil {
		t.Fatal(err)
	}
	return value
}

// A sender who declares a transactional send and attaches a Promotions
// annotation has made an error worth naming: Gmail ignores the markup there, so
// the campaign ships with structured data that does nothing.
func TestDeclaredTransactionalSurfaceRejectsPromotionsAnnotations(t *testing.T) {
	err := validateStructuredRootsForSurface(
		rootOfType(t, "DiscountOffer"), structuredregistry.SurfaceTransactional)
	if err == nil {
		t.Fatal("DiscountOffer accepted on a declared transactional send")
	}
}

func TestDeclaredPromotionsSurfaceRejectsTransactionalTypes(t *testing.T) {
	err := validateStructuredRootsForSurface(
		rootOfType(t, "Order"), structuredregistry.SurfacePromotions)
	if err == nil {
		t.Fatal("Order accepted on a declared Promotions send")
	}
}

func TestDeclaredSurfaceAcceptsItsOwnTypes(t *testing.T) {
	for markupType, surface := range map[string]structuredregistry.Surface{
		"DiscountOffer":    structuredregistry.SurfacePromotions,
		"PromotionCard":    structuredregistry.SurfacePromotions,
		"Order":            structuredregistry.SurfaceTransactional,
		"EventReservation": structuredregistry.SurfaceTransactional,
	} {
		if err := validateStructuredRootsForSurface(rootOfType(t, markupType), surface); err != nil {
			t.Fatalf("%s on its own surface was rejected: %v", markupType, err)
		}
	}
}

// No declaration means we cannot assess surface fitness. It must fall back to
// the union rather than picking a surface for the sender — guessing "probably
// promotional" would block a legitimate receipt, and guessing the other way
// would silently approve markup that does nothing.
func TestUndeclaredSurfaceFallsBackToTheUnionRatherThanGuessing(t *testing.T) {
	for _, markupType := range []string{"DiscountOffer", "Order"} {
		if err := validateStructuredRootsForSurface(rootOfType(t, markupType), ""); err != nil {
			t.Fatalf("%s rejected with no declared surface: %v", markupType, err)
		}
	}
	// An unregistered type is still refused with no declaration: the fallback
	// widens the surface question, not the type allowlist.
	if err := validateStructuredRootsForSurface(rootOfType(t, "SpaceshipOffer"), ""); err == nil {
		t.Fatal("an unregistered type passed when no surface was declared")
	}
}

// A surface nobody registered is not a licence. Falling back to the union on an
// unrecognised value would make "gmail-newsletters-tab" a way to bypass the
// per-surface rule entirely.
func TestUnrecognisedDeclaredSurfaceFailsClosed(t *testing.T) {
	if err := validateStructuredRootsForSurface(
		rootOfType(t, "DiscountOffer"), "newsletter-tab"); err == nil {
		t.Fatal("an unrecognised declared surface behaved as permissive")
	}
}
