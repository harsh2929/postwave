// SPDX-License-Identifier: AGPL-3.0-only

package mobilepush

import (
	"testing"

	"github.com/postwave/postwave/apps/api/internal/notifications"
)

// Mobile's category and the feed row's actions are ONE decision.
//
// Written because a mutation proved they were not yet tied together: making
// `categoryForEvent` return a different category for `approval.requested` than
// the shared catalog left every test in three packages green. That is exactly
// the divergence this whole change removes — a phone registering buttons the
// in-app feed knows nothing about — reintroduced by a one-line edit nobody
// would notice in review.
func TestTheMobileCategoryComesFromTheSharedCatalog(t *testing.T) {
	// Every event the catalog knows, plus one it does not, so the fallback is
	// covered too.
	events := []string{
		"approval.requested",
		"approval.escalated",
		"auth.new_device_sign_in",
		"subscriber.bounced",
	}
	for _, event := range events {
		got := categoryForEvent(event)
		want := notifications.CategoryForEvent(event)
		if got != want {
			t.Errorf("categoryForEvent(%q) = %q but the shared catalog says %q. A "+
				"phone would register different buttons from the ones the feed row "+
				"advertises for the same notification.", event, got, want)
		}
	}
}

// The local wire constants must equal the shared ones. They are what goes on
// the wire and into the CHECK constraint, so a rename in either place produces
// a category no client has registered — and the notification arrives with no
// buttons at all.
func TestTheLocalCategoryConstantsMatchTheSharedOnes(t *testing.T) {
	for _, pair := range []struct {
		local, shared string
		name          string
	}{
		{pushCategoryApproval, notifications.CategoryApproval, "approval"},
		{pushCategorySecurity, notifications.CategorySecurity, "security"},
		{pushCategoryEntity, notifications.CategoryEntity, "entity"},
	} {
		if pair.local != pair.shared {
			t.Errorf("%s category: mobilepush says %q, notifications says %q",
				pair.name, pair.local, pair.shared)
		}
	}
}

// An event with buttons must map to a category that HAS buttons. The entity
// category is the plain one; an approval landing there arrives with nothing to
// press despite the feed row advertising Approve and Reject.
func TestAnEventWithActionsDoesNotLandInThePlainCategory(t *testing.T) {
	for _, event := range []string{"approval.requested", "approval.escalated", "auth.new_device_sign_in"} {
		if len(notifications.ActionsForEvent(event)) == 0 {
			t.Fatalf("%s has no actions; this test is checking the wrong events", event)
		}
		if categoryForEvent(event) == pushCategoryEntity {
			t.Errorf("%s has actions but maps to the plain entity category, so the "+
				"push arrives with nothing to press", event)
		}
	}
}
