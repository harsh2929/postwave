// SPDX-License-Identifier: AGPL-3.0-only

package semanticemail

import (
	"strings"

	"github.com/postwave/postwave/apps/api/internal/structuredregistry"
)

// schemaTypeForKind maps our internal kind onto the schema.org type name the
// provider registry is keyed by. Kept next to the derivation below so the two
// halves of the translation stay together.
var schemaTypeForKind = map[StructuredDataKind]string{
	StructuredDiscountOffer:    "DiscountOffer",
	StructuredPromotionCard:    "PromotionCard",
	StructuredEventReservation: "EventReservation",
	StructuredOrder:            "Order",
}

// useCaseForDeclaredSurface translates a declared send surface into the use
// case whose markup applies there. Derived from the registry's surface names so
// the compiler and the artifact validator recognise the same set of strings.
//
// Returns false for an empty OR unrecognised surface; the caller distinguishes
// those two, because absent means "cannot assess" and unrecognised means "do
// not trust".
func useCaseForDeclaredSurface(surface string) (StructuredDataUseCase, bool) {
	switch structuredregistry.Surface(strings.TrimSpace(surface)) {
	case structuredregistry.SurfacePromotions:
		return UseCaseGmailPromotion, true
	case structuredregistry.SurfaceTransactional:
		return UseCaseGmailTransaction, true
	default:
		return "", false
	}
}

// expectedUseCaseForKind derives the required Gmail use case from the provider
// registry instead of restating the mapping.
//
// The authoring validator (this package) and the artifact validator
// (campaignchecks) both need to know which surface a markup type belongs on.
// That was written out twice; the registry is now the single statement of it,
// so adding a type in one place cannot leave the other silently permissive.
//
// Returns false when the registry has no unambiguous surface for the kind,
// which the caller reports rather than defaulting — defaulting to
// "transactional" is how an unregistered type would quietly acquire a rule.
func expectedUseCaseForKind(kind StructuredDataKind) (StructuredDataUseCase, bool) {
	schemaType, ok := schemaTypeForKind[kind]
	if !ok {
		return "", false
	}
	surface, ok := structuredregistry.SurfaceForType(structuredregistry.ProviderGmail, schemaType)
	if !ok {
		return "", false
	}
	switch surface {
	case structuredregistry.SurfacePromotions:
		return UseCaseGmailPromotion, true
	case structuredregistry.SurfaceTransactional:
		return UseCaseGmailTransaction, true
	default:
		return "", false
	}
}
