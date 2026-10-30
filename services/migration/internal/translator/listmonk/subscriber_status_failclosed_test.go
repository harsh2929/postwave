package listmonk

import (
	"testing"

	"github.com/postwave/migrate/canonical"
)

// TestUnknownCanonicalStatusIsNotMailable pins the direction this mapping must
// fail in.
//
// toListmonkPayloadWithOptions initialised `status := "enabled"` and had no
// default arm, so any canonical.SubscriberStatus outside the four known values
// — including the empty string — produced a MAILABLE contact.
//
// canonical.SubscriberStatus is a bare string with no validator, and the values
// that fall through are not invented: "pending", "cleaned" and "archived" are
// Mailchimp's own subscriber statuses, meaning an unconfirmed double-opt-in, a
// hard-bounced or invalid address, and one deliberately removed from the
// audience. Importing any as enabled mails somebody who opted out of the
// platform being migrated FROM, and nothing downstream would notice.
//
// Two sibling files already resolve an empty status to disabled
// (subscriber_store.go, subscriber_projection.go). This one disagreed with both
// while being the one that builds the payload written to the send store.
func TestUnknownCanonicalStatusIsNotMailable(t *testing.T) {
	for _, status := range []canonical.SubscriberStatus{
		"",         // an adapter that never set it
		"unknown",  // anything unmapped
		"pending",  // Mailchimp: double opt-in never confirmed
		"cleaned",  // Mailchimp: hard-bounced / invalid
		"archived", // Mailchimp: removed from the audience
		"transactional",
		"non_subscribed",
		"deleted",
	} {
		got := toListmonkPayload(canonical.Subscriber{Email: "a@b.c", Status: status}).Status
		if got == "enabled" {
			t.Errorf("canonical status %q imported as MAILABLE (%q)", string(status), got)
		}
		if got != "disabled" {
			t.Errorf("canonical status %q -> %q, want disabled", string(status), got)
		}
	}
}

// TestKnownStatusesStillMapExactly is the guard-the-guard: a mapping that
// answered "disabled" for everything would satisfy the test above while
// breaking every real import.
func TestKnownStatusesStillMapExactly(t *testing.T) {
	cases := map[canonical.SubscriberStatus]string{
		canonical.StatusEnabled:     "enabled",
		canonical.StatusDisabled:    "disabled",
		canonical.StatusBlocklisted: "blocklisted",
		// Listmonk has no subscriber-level "unconfirmed"; disabled + an attribs
		// flag is the documented representation.
		canonical.StatusUnconfirmed: "disabled",
	}
	for status, want := range cases {
		if got := toListmonkPayload(canonical.Subscriber{Email: "a@b.c", Status: status}).Status; got != want {
			t.Errorf("canonical %q -> %q, want %q", string(status), got, want)
		}
	}
}
