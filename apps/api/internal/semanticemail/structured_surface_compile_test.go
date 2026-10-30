// SPDX-License-Identifier: AGPL-3.0-only

package semanticemail

import (
	"strings"
	"testing"
)

// Proves the declaration is CONNECTED, not merely that the helper is correct.
// StructuredPolicy.DeclaredSendSurface would otherwise be a field nobody reads.
func TestDeclaredTransactionalSendDoesNotEmitPromotionMarkup(t *testing.T) {
	options := validCompileOptions()
	options.StructuredPolicy.DeclaredSendSurface = "transactional"

	result, diagnostics := CompileV2(validDocumentV2(), options)
	if diagnostics.HasErrors() {
		t.Fatalf("a surface mismatch should warn, not invalidate the projection: %v", diagnostics)
	}
	// The fixture carries BOTH promotional and transactional kinds, which makes
	// this a test of selection rather than of blanket disabling: the
	// transactional ones must survive while the promotional ones are refused.
	var refusedPromotion, emittedTransactional int
	for _, status := range result.StructuredStatuses {
		promotional := status.Kind == StructuredDiscountOffer || status.Kind == StructuredPromotionCard
		switch {
		case promotional && status.Emitted:
			t.Fatalf("promotion markup emitted on a declared transactional send: %+v", status)
		case promotional:
			// "Not emitted" with no reason is indistinguishable from a compiler
			// bug when someone reads the receipt months later.
			if status.Eligibility != EligibilityUnverified ||
				!strings.Contains(status.EligibilityReason, "transactional") {
				t.Fatalf("refusal did not explain the surface mismatch: %+v", status)
			}
			refusedPromotion++
		case status.Emitted:
			emittedTransactional++
		}
		// A refusal must not disturb the other statuses; they answer different
		// questions and stay independent.
		if status.ObservedDisplay != "unknown" || status.ComprehensionEffect != "unproven" {
			t.Fatalf("a refusal changed the display/comprehension statuses: %+v", status)
		}
	}
	if refusedPromotion == 0 {
		t.Fatal("no promotional declaration was refused; the surface check did not run")
	}
	if emittedTransactional == 0 {
		t.Fatal("no transactional markup survived; the check disabled rather than selected")
	}
}

// The matching surface must still compile, or the check would simply disable
// structured data rather than target it.
func TestDeclaredPromotionsSendStillEmitsPromotionMarkup(t *testing.T) {
	options := validCompileOptions()
	options.StructuredPolicy.DeclaredSendSurface = "promotions"

	result, diagnostics := CompileV2(validDocumentV2(), options)
	if diagnostics.HasErrors() {
		t.Fatalf("unexpected errors: %v", diagnostics)
	}
	var emittedPromotion, refusedTransactional int
	for _, status := range result.StructuredStatuses {
		promotional := status.Kind == StructuredDiscountOffer || status.Kind == StructuredPromotionCard
		switch {
		case promotional && status.Emitted:
			emittedPromotion++
		case !promotional && !status.Emitted:
			refusedTransactional++
		case !promotional:
			t.Fatalf("transactional markup emitted on a declared Promotions send: %+v", status)
		}
	}
	if emittedPromotion == 0 {
		t.Fatal("promotion markup was not emitted on a declared Promotions send")
	}
	// The mirror image of the previous test: selection cuts both ways, so a
	// bug that refused everything cannot pass both.
	if refusedTransactional == 0 {
		t.Fatal("transactional markup survived a declared Promotions send")
	}
}

// Existing callers pass no declaration, and their behaviour must not change.
func TestUndeclaredSurfaceCompilesExactlyAsBefore(t *testing.T) {
	withDeclaration := validCompileOptions()
	withDeclaration.StructuredPolicy.DeclaredSendSurface = ""
	declared, _ := CompileV2(validDocumentV2(), withDeclaration)
	baseline, _ := CompileV2(validDocumentV2(), validCompileOptions())
	if string(declared.JSONLD) != string(baseline.JSONLD) {
		t.Fatalf("an empty declaration changed the projection: %s vs %s",
			declared.JSONLD, baseline.JSONLD)
	}
}
