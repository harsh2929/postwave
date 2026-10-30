package affiliates

import "errors"

// Affiliate-program operational boundaries are compile-time fail-closed.
//
// The underlying ledger is platform-global, but the current authenticated
// admin boundary is workspace-scoped. The public offer also lacks the approved
// commercial, tax, privacy, attribution, and settlement evidence required to
// create financial obligations. Changing one flag is intentionally
// insufficient to launch the program: composition, route authorization,
// contracts, and release evidence must change in the same reviewed release.
const (
	AdminOperationsAvailable  = false
	PublicOfferAvailable      = false
	NewAttributionAvailable   = false
	PayoutOperationsAvailable = false
)

// ErrProgramUnavailable is returned by direct runtime entry points when the
// commercial affiliate program is not release-qualified.
var ErrProgramUnavailable = errors.New("affiliates: program is not release-qualified")

// OperationallyAvailable deliberately requires the complete release boundary.
// A partial flag change must never expose enrollment, partner records,
// attribution, commission moderation, or settlement independently.
func OperationallyAvailable() bool {
	return AdminOperationsAvailable &&
		PublicOfferAvailable &&
		NewAttributionAvailable &&
		PayoutOperationsAvailable
}
