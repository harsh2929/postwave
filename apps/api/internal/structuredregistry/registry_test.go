// SPDX-License-Identifier: AGPL-3.0-only

package structuredregistry

import "testing"

// §11.1: "Maintain provider/version-specific registries rather than a global
// 'supports JSON-LD' switch." Gmail Promotions annotations only apply to
// Promotions-compatible campaigns; the same markup on a transactional send is
// not a lesser benefit, it is ignored entirely.
func TestPromotionsAnnotationsAreNotSupportedOnTransactionalSends(t *testing.T) {
	if support := Lookup(ProviderGmail, SurfacePromotions, "DiscountOffer"); support != SupportSupported {
		t.Fatalf("DiscountOffer on Promotions = %q, want supported", support)
	}
	if support := Lookup(ProviderGmail, SurfaceTransactional, "DiscountOffer"); support == SupportSupported {
		t.Fatal("DiscountOffer claimed as supported on a transactional send; Gmail ignores it there")
	}
}

func TestTransactionalTypesAreNotSupportedInPromotions(t *testing.T) {
	if support := Lookup(ProviderGmail, SurfaceTransactional, "Order"); support != SupportSupported {
		t.Fatalf("Order on transactional = %q, want supported", support)
	}
	if support := Lookup(ProviderGmail, SurfacePromotions, "Order"); support == SupportSupported {
		t.Fatal("Order claimed as supported in Promotions")
	}
}

// "Other providers remain unsupported or experimental until primary
// documentation and live certification exist." Defaulting an unknown provider
// to anything but unsupported would let a registry gap read as a capability.
func TestUnknownProviderAndTypeFailClosed(t *testing.T) {
	for name, support := range map[string]Support{
		"unknown provider": Lookup("fastmail", SurfacePromotions, "DiscountOffer"),
		"unknown type":     Lookup(ProviderGmail, SurfacePromotions, "SpaceshipOffer"),
		"empty type":       Lookup(ProviderGmail, SurfacePromotions, ""),
		"unknown surface":  Lookup(ProviderGmail, "newsletter-tab", "DiscountOffer"),
	} {
		if support != SupportUnsupported {
			t.Fatalf("%s = %q, want unsupported", name, support)
		}
	}
}

// The four statuses of §11.1. Valid markup does not imply an eligible sender,
// an eligible sender does not imply the card was displayed, and none of them
// imply the documented-but-unproven comprehension benefit.
func TestValidMarkupAloneClaimsNothingFurther(t *testing.T) {
	assessment := Assessment{
		MarkupValid: true,
		Support:     SupportSupported,
	}
	if assessment.SenderEligibility != EligibilityUnknown {
		t.Fatal("eligibility defaulted to something other than unknown")
	}
	if assessment.Display != DisplayUnobserved {
		t.Fatal("display defaulted to something other than unobserved")
	}
	if assessment.ClaimsDisplay() {
		t.Fatal("valid, supported markup claimed display without an observation")
	}
}

func TestDisplayIsOnlyClaimedFromAnActualObservation(t *testing.T) {
	eligible := Assessment{
		MarkupValid:       true,
		Support:           SupportSupported,
		SenderEligibility: EligibilityRegistered,
	}
	if eligible.ClaimsDisplay() {
		t.Fatal("an eligible sender with valid markup claimed display; eligibility is not display")
	}
	observed := eligible
	observed.Display = DisplayObserved
	if !observed.ClaimsDisplay() {
		t.Fatal("an actual observation did not claim display")
	}
	absent := eligible
	absent.Display = DisplayAbsent
	if absent.ClaimsDisplay() {
		t.Fatal("an observation that the card was ABSENT claimed display")
	}
}

// The status the blueprint says stays unproven. This is asserted as a property
// of the type rather than of any copy: there is no field or method through
// which a caller could assert a comprehension benefit.
func TestComprehensionBenefitCannotBeAsserted(t *testing.T) {
	if ComprehensionBenefit() != "unproven" {
		t.Fatal("comprehension benefit is reported as anything other than unproven")
	}
}

// A summary sentence exists so callers render one authored string instead of
// assembling their own from the parts and dropping a qualifier.
func TestHeadlineDistinguishesEachStatus(t *testing.T) {
	cases := map[string]Assessment{
		"unsupported": {MarkupValid: true, Support: SupportUnsupported},
		"unknown eligibility": {
			MarkupValid: true, Support: SupportSupported,
		},
		"eligible but unobserved": {
			MarkupValid: true, Support: SupportSupported, SenderEligibility: EligibilityRegistered,
		},
		"observed": {
			MarkupValid: true, Support: SupportSupported,
			SenderEligibility: EligibilityRegistered, Display: DisplayObserved,
		},
	}
	seen := map[string]string{}
	for name, assessment := range cases {
		headline := assessment.Headline()
		if headline == "" {
			t.Fatalf("%s: empty headline", name)
		}
		for other, previous := range seen {
			if previous == headline {
				t.Fatalf("%s and %s produce the same sentence %q; the statuses are not distinguished",
					name, other, headline)
			}
		}
		seen[name] = headline
	}
	// The one claim that must never appear.
	for name, assessment := range cases {
		if contains(assessment.Headline(), "will display") ||
			contains(assessment.Headline(), "improves AI") {
			t.Fatalf("%s: headline promises an outcome we cannot support: %q", name, assessment.Headline())
		}
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && (func() bool {
		for i := 0; i+len(needle) <= len(haystack); i++ {
			if haystack[i:i+len(needle)] == needle {
				return true
			}
		}
		return false
	})()
}
