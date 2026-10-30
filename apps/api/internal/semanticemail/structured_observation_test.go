// SPDX-License-Identifier: AGPL-3.0-only

package semanticemail

import (
	"testing"

	"github.com/postwave/postwave/apps/api/internal/structuredregistry"
)

func emittedStatus() StructuredDataStatus {
	return StructuredDataStatus{
		NodeID: "n1", Provider: ProviderGmail, Kind: StructuredDiscountOffer,
		Valid: true, Eligibility: EligibilityEligible, Emitted: true,
		ObservedDisplay: "unknown", ComprehensionEffect: "unproven",
	}
}

// The compiler receipt is frozen evidence of what the COMPILER did. An
// observation happens later, in a controlled mailbox, and writing it back into
// the receipt would both rewrite frozen evidence and trip the overclaim check
// that requires every compile-time status to say "unknown".
func TestAssessingAStatusNeverMutatesTheReceipt(t *testing.T) {
	status := emittedStatus()
	_ = AssessStructuredStatus(status, structuredregistry.DisplayObserved)
	if status.ObservedDisplay != "unknown" {
		t.Fatalf("the compiler status was mutated to %q", status.ObservedDisplay)
	}
	if status.ComprehensionEffect != "unproven" {
		t.Fatalf("comprehension effect was mutated to %q", status.ComprehensionEffect)
	}
}

// With no observation the assessment must be unobserved, not absent. "Nobody
// looked" and "we looked and it was not there" are different facts, and only
// the second is evidence about the provider.
func TestNoObservationIsUnobservedRatherThanAbsent(t *testing.T) {
	assessment := AssessStructuredStatus(emittedStatus(), structuredregistry.DisplayUnobserved)
	if assessment.Display != structuredregistry.DisplayUnobserved {
		t.Fatalf("display = %q, want unobserved", assessment.Display)
	}
	if assessment.ClaimsDisplay() {
		t.Fatal("an unobserved assessment claimed display")
	}
}

func TestAnObservationOfAbsenceIsRecordedAndClaimsNothing(t *testing.T) {
	assessment := AssessStructuredStatus(emittedStatus(), structuredregistry.DisplayAbsent)
	if assessment.Display != structuredregistry.DisplayAbsent {
		t.Fatalf("display = %q, want absent", assessment.Display)
	}
	if assessment.ClaimsDisplay() {
		t.Fatal("an observation of ABSENCE claimed display")
	}
}

func TestAnObservationOfDisplayIsClaimed(t *testing.T) {
	assessment := AssessStructuredStatus(emittedStatus(), structuredregistry.DisplayObserved)
	if !assessment.ClaimsDisplay() {
		t.Fatal("an actual observation did not claim display")
	}
}

// The rule that matters most. Markup the compiler never emitted cannot have
// been seen rendering, so an observation claiming otherwise is incoherent
// evidence — a capture attributed to the wrong message, or a mailbox reading a
// previous send. Accepting it would let a display claim outlive the markup.
func TestMarkupThatWasNeverEmittedCannotBeObservedDisplaying(t *testing.T) {
	for name, status := range map[string]StructuredDataStatus{
		"not emitted": {Valid: true, Eligibility: EligibilityEligible, Emitted: false},
		"ineligible":  {Valid: true, Eligibility: EligibilityUnverified, Emitted: false},
		"invalid":     {Valid: false, Emitted: false},
	} {
		assessment := AssessStructuredStatus(status, structuredregistry.DisplayObserved)
		if assessment.ClaimsDisplay() {
			t.Errorf("%s: markup that was never emitted was assessed as displayed", name)
		}
		if assessment.Display != structuredregistry.DisplayUnobserved {
			t.Errorf("%s: display = %q, want the observation discarded as incoherent",
				name, assessment.Display)
		}
	}
}

// Eligibility carries across so the assessment can distinguish "eligible and
// not yet seen" from "not eligible, so it will never be seen".
func TestEligibilityIsCarriedIntoTheAssessment(t *testing.T) {
	eligible := AssessStructuredStatus(emittedStatus(), structuredregistry.DisplayUnobserved)
	if eligible.SenderEligibility != structuredregistry.EligibilityRegistered {
		t.Fatalf("eligible status became %q", eligible.SenderEligibility)
	}
	unverified := emittedStatus()
	unverified.Eligibility = EligibilityUnverified
	unverified.Emitted = false
	if got := AssessStructuredStatus(unverified, structuredregistry.DisplayUnobserved).SenderEligibility; got == structuredregistry.EligibilityRegistered {
		t.Fatal("an unverified sender was assessed as registered")
	}
}
