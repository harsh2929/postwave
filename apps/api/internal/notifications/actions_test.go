// SPDX-License-Identifier: AGPL-3.0-only
package notifications

import "testing"

// One catalog, two surfaces.
//
// `mobilepush.categoryForEvent` used to hold its own switch, and it was the ONLY
// place an event's actionable buttons were decided — the in-app feed row had no
// actions column at all, so it could not agree with it even in principle. An
// approval offered Approve/Reject on a phone and "open the page" in the bell.

func TestAnApprovalOffersTheSameActionsOnEverySurface(t *testing.T) {
	for _, event := range []string{"approval.requested", "approval.escalated"} {
		actions := ActionsForEvent(event)
		if len(actions) != 2 {
			t.Fatalf("%s has %d actions, want approve + reject", event, len(actions))
		}
		if CategoryForEvent(event) != CategoryApproval {
			t.Errorf("%s maps to category %q, want %q — a phone would register "+
				"different buttons from the ones the feed row advertises",
				event, CategoryForEvent(event), CategoryApproval)
		}
		var approve, reject bool
		for _, a := range actions {
			switch a.ID {
			case "approval.approve":
				approve = true
				if !a.Primary {
					t.Errorf("%s: approve is not the primary action", event)
				}
				if a.Kind != ActionAPI || a.Method != "POST" || a.Path == "" {
					t.Errorf("%s: approve is not an invocable API action: %+v", event, a)
				}
			case "approval.reject":
				reject = true
				if a.Style != "danger" {
					t.Errorf("%s: reject is not marked danger, so a client cannot "+
						"distinguish it from the affirmative one", event)
				}
			}
		}
		if !approve || !reject {
			t.Errorf("%s is missing approve or reject: %+v", event, actions)
		}
	}
	// The escalation is the same decision as the request, so it must carry the
	// same actions — a person chased about an approval has to be able to act
	// from the chase.
	req, esc := ActionsForEvent("approval.requested"), ActionsForEvent("approval.escalated")
	if len(req) != len(esc) {
		t.Fatalf("a request offers %d actions and its escalation %d", len(req), len(esc))
	}
	for i := range req {
		if req[i].ID != esc[i].ID {
			t.Errorf("action %d differs between a request (%s) and its escalation (%s)",
				i, req[i].ID, esc[i].ID)
		}
	}
}

// Exactly one primary per event: a client that can show only one button needs
// an unambiguous answer, and two primaries is the same as none.
func TestAtMostOneActionIsPrimary(t *testing.T) {
	for event := range eventActions {
		primaries := 0
		for _, a := range ActionsForEvent(event) {
			if a.Primary {
				primaries++
			}
		}
		if primaries > 1 {
			t.Errorf("%s has %d primary actions; a client showing one button has "+
				"no way to choose", event, primaries)
		}
	}
}

// Security is NAVIGATE, deliberately. A one-tap mass revocation from a
// notification is how somebody locks themselves out of a laptop by dismissing a
// banner.
func TestTheSecurityActionSendsSomewhereRatherThanActing(t *testing.T) {
	actions := ActionsForEvent("auth.new_device_sign_in")
	if len(actions) != 1 {
		t.Fatalf("got %d actions, want one", len(actions))
	}
	if actions[0].Kind != ActionNavigate {
		t.Fatalf("the security action is %q; a destructive one-tap from a "+
			"notification revokes sessions somebody is still using", actions[0].Kind)
	}
	if CategoryForEvent("auth.new_device_sign_in") != CategorySecurity {
		t.Error("the security event does not map to the security push category")
	}
}

// An event with nothing to do returns an empty slice, never nil: a nil
// serialises as `null` where clients expect a list, and "no actions" must not
// be a second shape to handle.
func TestAnUnknownEventHasNoActionsAndTheEntityCategory(t *testing.T) {
	actions := ActionsForEvent("subscriber.bounced")
	if actions == nil {
		t.Fatal("nil actions; this serialises as null and forces every client to " +
			"handle a second empty shape")
	}
	if len(actions) != 0 {
		t.Fatalf("got %+v, want none", actions)
	}
	if CategoryForEvent("subscriber.bounced") != CategoryEntity {
		t.Error("an event with no catalog entry did not fall back to the entity category")
	}
}

func TestDormantRetentionOfferAdvertisesNoUnsafeActions(t *testing.T) {
	actions := ActionsForEvent("retention.offer_available")
	if len(actions) != 0 {
		t.Fatalf("release-held retention offer advertises unmounted actions: %+v", actions)
	}
	if CategoryForEvent("retention.offer_available") != CategoryEntity {
		t.Fatal("release-held retention offer maps to an actionable push category")
	}
	for _, event := range ActionEvents() {
		if event == "retention.offer_available" {
			t.Fatal("release-held retention offer remains registered in the action catalog")
		}
	}
}

// Every API action must name a method and a path, or a client has a button it
// cannot press.
func TestEveryApiActionIsInvocable(t *testing.T) {
	seen := 0
	for event := range eventActions {
		for _, a := range ActionsForEvent(event) {
			if a.Label == "" || a.ID == "" {
				t.Errorf("%s: action with no id or label: %+v", event, a)
			}
			if a.Kind != ActionAPI {
				continue
			}
			seen++
			if a.Method == "" || a.Path == "" {
				t.Errorf("%s: API action %q has no method or path; the button "+
					"cannot be pressed", event, a.ID)
			}
		}
	}
	if seen == 0 {
		t.Fatal("no API actions examined; this test is measuring nothing")
	}
}

// The catalog must not be mutable through what it hands out. A caller that
// appended to a returned slice would corrupt every later notification of that
// type.
func TestTheCatalogCannotBeMutatedByACaller(t *testing.T) {
	first := ActionsForEvent("approval.requested")
	if len(first) == 0 {
		t.Fatal("no actions to mutate")
	}
	first[0].Label = "Tampered"
	second := ActionsForEvent("approval.requested")
	if second[0].Label == "Tampered" {
		t.Fatal("the catalog handed out its own backing array; one caller's edit " +
			"changes what every later notification advertises")
	}
}
