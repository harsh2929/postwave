// SPDX-License-Identifier: AGPL-3.0-only

package notifications

import "testing"

// §11.1 registers an action type only when "registration, authentication,
// HTTPS, limited-use token, replay protection, and side-effect semantics pass".
// The first five are properties of the ticket. This is the sixth, and it was
// the one thing nothing in the codebase could express — which is why binding an
// offer to a ticketed action was blocked.

func TestAnUndeclaredSideEffectIsNeverTicketable(t *testing.T) {
	// The whole point of the gate. An action whose consequences nobody has
	// stated must not become clickable from an email, because the blast radius
	// of guessing wrong is a charge or a decremented inventory that no one
	// authorised. Unspecified is the zero value, so the default is closed.
	if SideEffectUnspecified.Ticketable() {
		t.Error("an action with undeclared side-effect semantics was ticketable")
	}
	if SideEffect("invented_later").Ticketable() {
		t.Error("an unrecognised side-effect class was ticketable")
	}
}

func TestReversibleSideEffectsAreTicketable(t *testing.T) {
	for _, effect := range []SideEffect{SideEffectNone, SideEffectRecordsIntent} {
		if !effect.Ticketable() {
			t.Errorf("%q is not ticketable, but it changes no state a person cannot undo", effect)
		}
	}
}

func TestInventoryAndPurchaseAreDeclaredButGated(t *testing.T) {
	// Declared so the vocabulary can express them, gated because the machinery
	// each implies does not exist: a reservation needs an expiry and a release
	// path, and a purchase needs strict idempotency and a refund path. Letting
	// one through today would be claiming a guarantee we cannot keep.
	for _, effect := range []SideEffect{SideEffectReservesInventory, SideEffectCompletesPurchase} {
		if effect.Ticketable() {
			t.Errorf("%q is ticketable, but its release/refund machinery does not exist", effect)
		}
		if !effect.Valid() {
			t.Errorf("%q is not a valid declaration, so the semantics cannot even be stated", effect)
		}
	}
}

func TestReservationRequiresAnExpiryAndPurchaseARefundPath(t *testing.T) {
	// The obligations are attached to the class rather than remembered by
	// whoever registers the action.
	if !SideEffectReservesInventory.RequiresExpiry() {
		t.Error("a reservation does not require an expiry; a hold nobody releases is a leak")
	}
	if SideEffectRecordsIntent.RequiresExpiry() {
		t.Error("recording intent should not require an expiry")
	}
	if !SideEffectCompletesPurchase.RequiresRefundPath() {
		t.Error("a purchase does not require a refund path")
	}
	if SideEffectReservesInventory.RequiresRefundPath() {
		t.Error("a reservation should not require a refund path; releasing the hold is the reversal")
	}
}

func TestEveryCatalogActionDeclaresItsSideEffect(t *testing.T) {
	// No action may sit in the catalog with unstated consequences. This is what
	// keeps the gate honest as the catalog grows: a new entry that forgets the
	// declaration fails here rather than silently becoming un-ticketable much
	// later, where the cause would be invisible.
	for _, event := range ActionEvents() {
		for _, action := range ActionsForEvent(event) {
			if !action.SideEffect.Valid() {
				t.Errorf("action %q on event %q declares no valid side-effect class (%q)",
					action.ID, event, action.SideEffect)
			}
		}
	}
}

func TestNavigationCarriesNoSideEffect(t *testing.T) {
	// A navigate action re-checks entitlement on arrival and changes nothing on
	// the way. Declaring it as anything else would overstate what a tap does.
	for _, event := range ActionEvents() {
		for _, action := range ActionsForEvent(event) {
			if action.Kind == ActionNavigate && action.SideEffect != SideEffectNone {
				t.Errorf("navigate action %q declares side effect %q", action.ID, action.SideEffect)
			}
		}
	}
}
