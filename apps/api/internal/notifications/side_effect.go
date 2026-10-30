// SPDX-License-Identifier: AGPL-3.0-only

package notifications

// SideEffect states what invoking an action actually changes.
//
// §11.1 permits registering an action type only when "registration,
// authentication, HTTPS, limited-use token, replay protection, and side-effect
// semantics pass". The first five are properties of the ticket and were already
// satisfied. This is the sixth, and nothing in the codebase could express it —
// which is precisely why binding an offer to a ticketed action was blocked. The
// blocker was never the token; it was that "does claiming an offer reserve
// inventory, record intent, or complete a purchase?" had no answer, and each
// answer implies different idempotency, refund and inventory behaviour.
//
// Declaring the class does not decide the product question. It makes the
// question un-skippable, attaches the obligations to the answer, and keeps an
// action whose consequences nobody has stated from becoming clickable in an
// email.
type SideEffect string

const (
	// SideEffectUnspecified is the zero value, so an action that forgets to
	// declare is closed by default rather than open by default.
	SideEffectUnspecified SideEffect = ""

	// SideEffectNone changes nothing. Navigation: the destination re-checks
	// entitlement on arrival, and the tap itself is inert.
	SideEffectNone SideEffect = "none"

	// SideEffectRecordsIntent writes a decision inside Moosewave and nothing
	// beyond it. Naturally idempotent — recording the same decision twice is
	// the same decision — and reversible by a further deliberate action. This
	// is the ceiling for what may be invoked from an email today.
	SideEffectRecordsIntent SideEffect = "records_intent"

	// SideEffectReservesInventory holds a scarce external resource. It needs an
	// expiry and a release path, because a hold nobody releases is a leak that
	// looks like sold-out stock.
	SideEffectReservesInventory SideEffect = "reserves_inventory"

	// SideEffectCompletesPurchase moves money or irreversibly fulfils. It needs
	// strict idempotency and a refund path, because the failure mode is a
	// double charge and the remedy is not another button.
	SideEffectCompletesPurchase SideEffect = "completes_purchase"
)

// Valid reports whether the class is one this build recognises. Unspecified is
// deliberately NOT valid: "nobody said" is not a declaration.
func (s SideEffect) Valid() bool {
	switch s {
	case SideEffectNone, SideEffectRecordsIntent,
		SideEffectReservesInventory, SideEffectCompletesPurchase:
		return true
	default:
		return false
	}
}

// Ticketable reports whether this action may be invoked from a limited-use
// email ticket.
//
// Only the classes whose worst case a person can undo. Reservation and purchase
// are expressible but gated, because the machinery each one implies — expiry
// and release, or strict idempotency and a refund path — does not exist yet.
// Admitting them now would register an action type against a guarantee this
// system cannot keep, which is the exact thing §11.1's gate exists to prevent.
//
// Raising the ceiling is a deliberate change here plus the machinery, not a
// property somebody sets on a catalog entry.
func (s SideEffect) Ticketable() bool {
	switch s {
	case SideEffectNone, SideEffectRecordsIntent:
		return true
	default:
		return false
	}
}

// RequiresExpiry reports whether the class obliges a bounded hold. The
// obligation lives on the class so it cannot be forgotten by whoever registers
// the action.
func (s SideEffect) RequiresExpiry() bool {
	return s == SideEffectReservesInventory
}

// RequiresRefundPath reports whether the class obliges a reversal that moves
// money back.
func (s SideEffect) RequiresRefundPath() bool {
	return s == SideEffectCompletesPurchase
}
