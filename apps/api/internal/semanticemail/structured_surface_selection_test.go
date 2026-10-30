// SPDX-License-Identifier: AGPL-3.0-only

package semanticemail

import "testing"

func policyWithEverythingEnabled(surface string) StructuredPolicy {
	return StructuredPolicy{
		Gmail: GmailPolicy{
			RegisteredSender: true,
			Authenticated:    true,
			Promotions:       true,
			Transactions:     true,
		},
		DeclaredSendSurface: surface,
	}
}

// The tenant having Promotions annotations ENABLED is a different question from
// this particular send being a promotion. Without the second question, a
// declared receipt still compiles a DiscountOffer that Gmail ignores — valid,
// eligible, emitted, and inert.
func TestPromotionMarkupIsNotEmittedOnADeclaredTransactionalSend(t *testing.T) {
	eligible, reason := gmailEligibility(
		StructuredDataContent{UseCase: UseCaseGmailPromotion, Enabled: true},
		policyWithEverythingEnabled("transactional").Gmail,
		policyWithEverythingEnabled("transactional").DeclaredSendSurface,
	)
	if eligible {
		t.Fatal("promotion markup was eligible on a declared transactional send")
	}
	if reason == "" {
		t.Fatal("refusal carried no reason; the status would say nothing useful")
	}
}

func TestTransactionalMarkupIsNotEmittedOnADeclaredPromotionsSend(t *testing.T) {
	eligible, _ := gmailEligibility(
		StructuredDataContent{UseCase: UseCaseGmailTransaction, Enabled: true},
		policyWithEverythingEnabled("promotions").Gmail,
		"promotions",
	)
	if eligible {
		t.Fatal("transactional markup was eligible on a declared Promotions send")
	}
}

func TestMarkupMatchingTheDeclaredSurfaceStaysEligible(t *testing.T) {
	for surface, useCase := range map[string]StructuredDataUseCase{
		"promotions":    UseCaseGmailPromotion,
		"transactional": UseCaseGmailTransaction,
	} {
		eligible, reason := gmailEligibility(
			StructuredDataContent{UseCase: useCase, Enabled: true},
			policyWithEverythingEnabled(surface).Gmail,
			surface,
		)
		if !eligible {
			t.Fatalf("%s markup on its own declared surface was refused: %s", surface, reason)
		}
	}
}

// No declaration must not silently disable structured data for every existing
// caller. Absent a declaration the surface question is unanswerable, so it
// falls through to the enablement policy exactly as before.
func TestUndeclaredSurfaceLeavesExistingEligibilityUnchanged(t *testing.T) {
	for _, useCase := range []StructuredDataUseCase{UseCaseGmailPromotion, UseCaseGmailTransaction} {
		eligible, reason := gmailEligibility(
			StructuredDataContent{UseCase: useCase, Enabled: true},
			policyWithEverythingEnabled("").Gmail,
			"",
		)
		if !eligible {
			t.Fatalf("%s markup was refused with no declared surface: %s", useCase, reason)
		}
	}
}

// An unrecognised surface fails closed, matching the artifact-time validator.
// Falling through on an unknown value would make any invented string a way to
// skip the check.
func TestUnrecognisedDeclaredSurfaceRefusesMarkup(t *testing.T) {
	eligible, reason := gmailEligibility(
		StructuredDataContent{UseCase: UseCaseGmailPromotion, Enabled: true},
		policyWithEverythingEnabled("newsletter-tab").Gmail,
		"newsletter-tab",
	)
	if eligible {
		t.Fatal("an unrecognised declared surface behaved as permissive")
	}
	if reason == "" {
		t.Fatal("refusal carried no reason")
	}
}
