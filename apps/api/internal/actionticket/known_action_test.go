// SPDX-License-Identifier: AGPL-3.0-only

package actionticket

import (
	"testing"

	"github.com/postwave/postwave/apps/api/internal/notifications"
)

func TestKnownActionRequiresDeclaredSemanticsAndAnExecutor(t *testing.T) {
	// §11.1 registers an action type only when registration, authentication,
	// HTTPS, limited-use token, replay protection AND side-effect semantics
	// pass. The ticket supplies the first five. This is where the sixth is
	// enforced, so an action whose consequences nobody stated cannot be
	// authorised by a ticket no matter how well-formed the token is.
	var checked int
	for _, event := range notifications.ActionEvents() {
		for _, action := range notifications.ActionsForEvent(event) {
			checked++
			want := action.Kind == notifications.ActionAPI &&
				action.SideEffect.Ticketable() &&
				KnownActionForResource(action.ID, resourceKindForAction(action.ID))
			if got := KnownAction(action.ID); got != want {
				t.Errorf("KnownAction(%q) = %v, want %v for side effect %q",
					action.ID, got, want, action.SideEffect)
			}
		}
	}
	if checked == 0 {
		t.Fatal("the catalog exposed no actions, so this test proved nothing")
	}
}

func TestUnknownActionIsRejected(t *testing.T) {
	for _, id := range []string{"", "   ", "not.a.real.action"} {
		if KnownAction(id) {
			t.Errorf("KnownAction(%q) authorised an action the catalog does not define", id)
		}
	}
}

func TestReleaseHeldOfferActionsAreNotRegistered(t *testing.T) {
	// A dormant receipt primitive is not a shippable action surface. There is no
	// recipient-bound producer and neither portal action route is mounted, so
	// both actions stay outside the catalog and ticket minter.
	for _, action := range []string{"offer.decline", "offer.accept"} {
		if KnownAction(action) {
			t.Errorf("release-held %s is ticketable", action)
		}
	}
}

func TestExecutableActionRequiresExactResourceKind(t *testing.T) {
	for _, action := range []string{"approval.approve", "approval.reject"} {
		if !KnownActionForResource(action, "approval") {
			t.Errorf("%s is not executable for approval", action)
		}
		if KnownActionForResource(action, "notification") {
			t.Errorf("%s accepted the generic notification resource binding", action)
		}
	}
	for _, kind := range []string{"offer", "notification", "approval", "campaign"} {
		if KnownActionForResource("offer.decline", kind) {
			t.Errorf("release-held offer.decline accepted resource kind %q", kind)
		}
	}
}
