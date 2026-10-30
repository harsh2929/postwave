// SPDX-License-Identifier: AGPL-3.0-only
package forms

import (
	"net/http"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/testsupport/listmonkv6"
)

// A published form slug is a public URL, and the only friction in front of the
// submit endpoint is a honeypot a script leaves empty. So the response body is
// the whole disclosure surface: while an existing address answered
// `already_subscribed` and a new one answered `subscribed` /
// `pending-confirmation`, anyone could test arbitrary addresses for membership
// of any brand's list at one probe each — and every negative probe also created
// a real subscriber and, in double opt-in, mailed the victim.
//
// The expectations here are written out as literal wire bytes rather than
// derived from the handler, so they fail if the handler starts distinguishing
// the two cases again in either direction. They drive the real handler: an
// address Listmonk already holds takes a different path downstream, and the
// answer must not show it.
func TestPublicSubmitConflictIsIndistinguishableFromFirstSubmission(t *testing.T) {
	for _, tc := range []struct {
		name string
		mode OptInMode
		want string
	}{
		{name: "single opt-in", mode: OptInSingle, want: `{"ok":true,"state":"subscribed","message":"Thanks!"}` + "\n"},
		{name: "double opt-in", mode: OptInDouble, want: `{"ok":true,"state":"pending-confirmation","message":"Thanks!"}` + "\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newSignupHarness(t, harnessForm{optIn: tc.mode, settings: map[string]any{"successMessage": "Thanks!"}})
			h.engine.SeedSubscriber("victim@example.com", "", listmonkv6.StatusEnabled, nil, nil)

			fresh := h.post(body(consentedBody, "fresh@example.com"))
			existing := h.post(body(consentedBody, "victim@example.com"))
			for label, rec := range map[string]int{"fresh": fresh.Code, "existing": existing.Code} {
				if rec != http.StatusOK {
					t.Fatalf("%s address status = %d, want 200", label, rec)
				}
			}
			if fresh.Body.String() != tc.want || existing.Body.String() != tc.want {
				t.Fatalf("fresh = %q, existing = %q; both must be %q", fresh.Body.String(), existing.Body.String(), tc.want)
			}
			h.drain()
		})
	}
}

// The browser (non-JSON) path leaked the same fact through the redirect target,
// because the mode segment of the success URL was derived from the state
// string. Pin that an existing address lands on the page a fresh one does.
func TestPublicSubmitConflictRedirectMatchesFirstSubmission(t *testing.T) {
	h := newSignupHarness(t, harnessForm{optIn: OptInDouble})
	h.engine.SeedSubscriber("victim@example.com", "", listmonkv6.StatusEnabled, nil, nil)
	want := "https://forms.example.test/forms/success?form=" + h.slug + "&mode=double"
	for _, email := range []string{"fresh%40example.com", "victim%40example.com"} {
		rec := h.post("email="+email+"&consent=yes", "Content-Type", "application/x-www-form-urlencoded")
		if got := rec.Header().Get("Location"); rec.Code != http.StatusSeeOther || got != want {
			t.Fatalf("%s: %d Location = %q, want %q", email, rec.Code, got, want)
		}
	}
}
