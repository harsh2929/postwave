// SPDX-License-Identifier: AGPL-3.0-only

// Package structuredregistry is the provider- and surface-specific registry of
// structured email markup (F08).
//
// The blueprint is explicit that this must not be "a global supports-JSON-LD
// switch". Gmail's Promotions annotations apply to Promotions-compatible
// campaigns; the same markup on a transactional send is not a smaller benefit,
// it is ignored. A flat type allowlist cannot express that, so it ends up
// telling a sender their markup is fine on a send where it does nothing.
//
// The other half of F08 is keeping four statuses apart. Verbatim from §11.1:
//
//	"Valid markup," "eligible sender," "observed display," and "helps AI
//	comprehension" are four separate statuses; the last remains unproven.
//
// They collapse in one direction — someone validates JSON-LD and tells the
// customer their email "will show a rich card in Gmail". Assessment keeps them
// as separate fields whose zero values are the humble ones, and the comprehension
// benefit has no field at all, because a value that cannot be written cannot be
// overclaimed.
package structuredregistry

import "strings"

type Provider string

type Surface string

type Support string

const (
	ProviderGmail Provider = "gmail"

	// The two Gmail surfaces with documented, distinct markup behaviour.
	SurfacePromotions    Surface = "promotions"
	SurfaceTransactional Surface = "transactional"

	SupportSupported Support = "supported"
	// SupportExperimental means the type is documented but unverified here. It
	// is deliberately NOT the default: an unknown entry must not read as a
	// capability awaiting confirmation.
	SupportExperimental Support = "experimental"
	SupportUnsupported  Support = "unsupported"
)

// SenderEligibility is independent of markup validity. Gmail gates its
// annotations on sender registration, so perfectly valid markup from an
// unregistered sender does nothing at all.
type SenderEligibility string

const (
	// EligibilityUnknown is the empty string so it is the literal ZERO VALUE of
	// the type, not merely the conventional default. A named constant like
	// "unknown" would leave the real zero value as "", and a struct built with
	// some fields omitted would carry a state no branch below handles. Use
	// String() for display.
	EligibilityUnknown    SenderEligibility = ""
	EligibilityRegistered SenderEligibility = "registered"
	EligibilityIneligible SenderEligibility = "ineligible"
)

func (e SenderEligibility) String() string {
	if e == EligibilityUnknown {
		return "unknown"
	}
	return string(e)
}

// DisplayObservation records what a controlled mailbox actually saw. There is
// no "expected" member: an expectation is a prediction, and this type exists to
// carry observations.
type DisplayObservation string

const (
	// Zero value, for the same reason as EligibilityUnknown: an Assessment
	// built without this field must mean "nobody looked", never "it rendered".
	DisplayUnobserved DisplayObservation = ""
	DisplayObserved   DisplayObservation = "observed"
	DisplayAbsent     DisplayObservation = "absent"
)

func (d DisplayObservation) String() string {
	if d == DisplayUnobserved {
		return "unobserved"
	}
	return string(d)
}

// registry maps provider → surface → type. Absence means unsupported; there is
// no wildcard, because a wildcard is the global switch this package exists to
// avoid.
var registry = map[Provider]map[Surface]map[string]Support{
	ProviderGmail: {
		// Promotions annotations. Gmail documents these for Promotions-tab
		// campaigns only.
		SurfacePromotions: {
			"DiscountOffer": SupportSupported,
			"PromotionCard": SupportSupported,
		},
		// Transactional Highlights. Documented for the specific use case, and
		// additionally gated on sender eligibility, which Lookup does not
		// answer — see Assessment.
		SurfaceTransactional: {
			"Order":            SupportSupported,
			"EventReservation": SupportSupported,
		},
	},
}

// Lookup answers only "is this type meaningful on this provider's surface".
// It deliberately does not answer whether the sender may use it, nor whether
// anything was displayed.
func Lookup(provider Provider, surface Surface, markupType string) Support {
	markupType = strings.TrimSpace(markupType)
	if markupType == "" {
		return SupportUnsupported
	}
	surfaces, ok := registry[provider]
	if !ok {
		return SupportUnsupported
	}
	types, ok := surfaces[surface]
	if !ok {
		return SupportUnsupported
	}
	support, ok := types[markupType]
	if !ok {
		return SupportUnsupported
	}
	return support
}

// SupportedTypes returns the types meaningful on one provider surface. Used by
// the compiler so generated markup is chosen for the surface being sent rather
// than filtered afterwards.
func SupportedTypes(provider Provider, surface Surface) []string {
	types := registry[provider][surface]
	out := make([]string, 0, len(types))
	for markupType, support := range types {
		if support == SupportSupported {
			out = append(out, markupType)
		}
	}
	sortStrings(out)
	return out
}

// SurfaceForType answers which surface a markup type belongs on.
//
// This exists so callers derive the mapping instead of restating it. The
// authoring validator in semanticemail previously carried its own conditional
// ("DiscountOffer or PromotionCard means promotion, else transaction"), which
// is the same rule written twice and free to drift from the registry.
//
// A type supported on two surfaces returns false rather than picking one: there
// is no single correct answer, and inventing one would let a caller enforce a
// rule this registry does not state.
func SurfaceForType(provider Provider, markupType string) (Surface, bool) {
	markupType = strings.TrimSpace(markupType)
	if markupType == "" {
		return "", false
	}
	var found Surface
	matches := 0
	for surface, types := range registry[provider] {
		if types[markupType] == SupportSupported {
			found = surface
			matches++
		}
	}
	if matches != 1 {
		return "", false
	}
	return found, true
}

// AllKnownTypes is every type meaningful on SOME registered provider surface.
//
// This exists for validators that do not yet know which surface a campaign is
// being sent to. It is a strictly weaker check than Lookup: it will accept a
// Promotions annotation on a transactional send. Callers that know the surface
// must use Lookup instead — the union is a floor, not the contract.
func AllKnownTypes() []string {
	seen := map[string]struct{}{}
	for _, surfaces := range registry {
		for _, types := range surfaces {
			for markupType, support := range types {
				if support == SupportSupported {
					seen[markupType] = struct{}{}
				}
			}
		}
	}
	out := make([]string, 0, len(seen))
	for markupType := range seen {
		out = append(out, markupType)
	}
	sortStrings(out)
	return out
}

func sortStrings(values []string) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j] < values[j-1]; j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
}

// Assessment is the four statuses, kept apart.
//
// Note what is NOT here: any field asserting a comprehension benefit, and any
// single boolean meaning "this worked". Both zero values — EligibilityUnknown
// and DisplayUnobserved — are the humble ones, so a partially-filled Assessment
// understates rather than overstates.
type Assessment struct {
	MarkupValid       bool
	Support           Support
	SenderEligibility SenderEligibility
	Display           DisplayObservation
}

// ClaimsDisplay is true only from an actual observation.
//
// Valid + supported + eligible is the strongest PREDICTION available, and it is
// still not evidence. This method is the one place that distinction is decided,
// so a caller cannot assemble the same claim from the parts and reach a
// different answer.
func (a Assessment) ClaimsDisplay() bool {
	return a.Display == DisplayObserved
}

// Headline is the server-authored sentence, so every surface renders the same
// qualified claim rather than composing one from the fields and dropping the
// qualifier — the failure this project keeps meeting.
func (a Assessment) Headline() string {
	if !a.MarkupValid {
		return "structured markup is invalid and was not attached"
	}
	if a.Support != SupportSupported {
		return "structured markup is valid but this provider surface does not use this type, so it has no effect here"
	}
	switch a.Display {
	case DisplayObserved:
		return "structured markup was observed rendering in a controlled mailbox"
	case DisplayAbsent:
		return "structured markup was valid and eligible, but a controlled mailbox did not render it"
	}
	switch a.SenderEligibility {
	case EligibilityRegistered:
		return "structured markup is valid and the sender is registered; no controlled mailbox has observed it rendering"
	case EligibilityIneligible:
		return "structured markup is valid but this sender is not registered with the provider, so it will not be used"
	default:
		return "structured markup is valid; sender registration is unconfirmed and no rendering has been observed"
	}
}

// ComprehensionBenefit is a function rather than a field so there is no
// assignable place to put a different answer.
//
// The fourth status from §11.1. No published evidence establishes that this
// markup improves an assistant's comprehension, and the product must not imply
// it. When such evidence exists it arrives with a calibration report, not with
// an edit here.
func ComprehensionBenefit() string { return "unproven" }
