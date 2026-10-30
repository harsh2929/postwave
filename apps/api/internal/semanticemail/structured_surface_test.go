// SPDX-License-Identifier: AGPL-3.0-only

package semanticemail

import "testing"

// Expectations are written out rather than derived from the registry. Reading
// them from the code under test would make this unfalsifiable — the same
// mistake that let a registry deletion pass unnoticed in campaignchecks.
func TestExpectedUseCaseIsDerivedForEveryStructuredKind(t *testing.T) {
	expected := map[StructuredDataKind]StructuredDataUseCase{
		StructuredDiscountOffer:    UseCaseGmailPromotion,
		StructuredPromotionCard:    UseCaseGmailPromotion,
		StructuredEventReservation: UseCaseGmailTransaction,
		StructuredOrder:            UseCaseGmailTransaction,
	}
	for kind, want := range expected {
		got, known := expectedUseCaseForKind(kind)
		if !known {
			t.Fatalf("kind %q has no registered surface", kind)
		}
		if got != want {
			t.Fatalf("kind %q expects use case %q, want %q", kind, got, want)
		}
	}
}

// An unmapped kind must be reported, not defaulted. Defaulting to
// "transactional" is how a newly added kind would quietly acquire a rule
// nobody chose for it.
func TestUnmappedStructuredKindIsNotSilentlyDefaulted(t *testing.T) {
	if _, known := expectedUseCaseForKind(StructuredDataKind("loyalty_pass")); known {
		t.Fatal("an unregistered structured kind was given a use case")
	}
	if _, known := expectedUseCaseForKind(""); known {
		t.Fatal("an empty structured kind was given a use case")
	}
}

// Every kind the schema translation knows must also be answerable, or the
// validator would reject a kind the rest of this package accepts.
func TestEverySchemaMappedKindResolves(t *testing.T) {
	for kind := range schemaTypeForKind {
		if _, known := expectedUseCaseForKind(kind); !known {
			t.Fatalf("kind %q is schema-mapped but has no use case", kind)
		}
	}
}
