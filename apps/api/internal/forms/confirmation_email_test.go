// SPDX-License-Identifier: AGPL-3.0-only
package forms

import (
	"context"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestConfirmationURLIsAbsoluteOrRefused(t *testing.T) {
	for base, want := range map[string]string{
		"https://forms.example.test":        "https://forms.example.test/forms/launch/confirm/tok",
		"https://forms.example.test/":       "https://forms.example.test/forms/launch/confirm/tok",
		"https://example.test/hosted/":      "https://example.test/hosted/forms/launch/confirm/tok",
		"http://localhost:3000?x=1#section": "http://localhost:3000/forms/launch/confirm/tok",
	} {
		got, err := confirmationURL(base, "launch", "tok")
		if err != nil || got != want {
			t.Errorf("confirmationURL(%q) = %q, %v; want %q", base, got, err, want)
		}
	}
	for _, base := range []string{"", "/forms", "forms.example.test", "ftp://forms.example.test", "https://"} {
		if got, err := confirmationURL(base, "launch", "tok"); err == nil {
			t.Errorf("confirmationURL(%q) = %q; a link nobody can open must be refused", base, got)
		}
	}
}

func TestConfirmationMessageWithTheDefaultCopy(t *testing.T) {
	msg := confirmationMessage(&Form{Settings: map[string]any{}}, "https://f.test/forms/s/confirm/t")
	if msg.Subject != "Confirm your subscription" {
		t.Fatalf("subject = %q", msg.Subject)
	}
	want := "Please confirm that you want to receive our emails by opening this link:\n\n" +
		"https://f.test/forms/s/confirm/t\n\n" +
		"If you didn't ask to subscribe, ignore this email and you won't be added."
	if msg.Body != want {
		t.Fatalf("body = %q, want %q", msg.Body, want)
	}
	if !strings.Contains(msg.HTMLBody, `<a href="https://f.test/forms/s/confirm/t"`) ||
		!strings.Contains(msg.HTMLBody, "didn&#39;t ask to subscribe") {
		t.Fatalf("html = %s", msg.HTMLBody)
	}
}

// An operator body that forgot the placeholder must still carry a link, and a
// subject cannot smuggle a header break.
func TestConfirmationMessageAlwaysCarriesTheLink(t *testing.T) {
	msg := confirmationMessage(&Form{Settings: map[string]any{
		"confirmationSubject": "Confirm\r\nBcc: attacker@example.com",
		"confirmationBody":    "Thanks for signing up.",
	}}, "https://f.test/c")
	if msg.Subject != "Confirm Bcc: attacker@example.com" {
		t.Fatalf("subject = %q, want line breaks collapsed", msg.Subject)
	}
	if msg.Body != "Thanks for signing up.\n\nhttps://f.test/c" {
		t.Fatalf("body = %q", msg.Body)
	}
	if !strings.Contains(msg.HTMLBody, `<a href="https://f.test/c"`) {
		t.Fatalf("html has no link: %s", msg.HTMLBody)
	}
}

func TestConfirmationEmailWithoutAMailerGuardOrLinkIsAnError(t *testing.T) {
	target := &confirmationTarget{TenantID: "t", Email: "a@example.com", Token: "tok", Form: Form{Slug: "s"}}
	d := &Deps{PublicHostBase: "https://f.test"}
	if state, err := d.deliverConfirmation(context.Background(), target); !errors.Is(err, ErrConfirmationMailerUnavailable) || state != ConfirmationEmailSendFailed {
		t.Fatalf("no mailer = %q %v, want send_failed ErrConfirmationMailerUnavailable", state, err)
	}
	mail := &recordingMailer{}
	d.ConfirmationMailer, d.ConfirmationFrom = mail, "From <f@example.test>"
	if _, err := d.deliverConfirmation(context.Background(), target); err == nil {
		t.Fatal("a confirmation email was sent without checking the recipient")
	}
	d.RecipientGuard = &staticRecipientGuard{}
	d.PublicHostBase = ""
	if _, err := d.deliverConfirmation(context.Background(), target); err == nil {
		t.Fatal("a relative confirmation link was sent")
	}
	if n := len(mail.messages()); n != 0 {
		t.Fatalf("%d emails sent", n)
	}
}

// The standard sender's email is fixed text: the workspace and form names
// are the only operator-written words in it, on one line and bounded.
func TestTheStandardSenderSendsAFixedTextNamingTheWorkspaceAndForm(t *testing.T) {
	msg := standardConfirmationMessage("Acme\nBcc: x@evil.test", "Spring <b>launch</b> "+strings.Repeat("x", 200), "https://f.test/c")
	if msg.Subject != "Confirm your subscription to Acme Bcc: x@evil.test" {
		t.Fatalf("subject = %q", msg.Subject)
	}
	if !strings.HasPrefix(msg.Body, "You asked to get emails from Acme Bcc: x@evil.test by signing up with the form “Spring <b>launch</b> xxx") ||
		!strings.Contains(msg.Body, "…”.\n\nTo confirm, open this link:\n\nhttps://f.test/c\n\n") ||
		!strings.HasSuffix(msg.Body, "you won't get anything else from Acme Bcc: x@evil.test.") {
		t.Fatalf("body = %q", msg.Body)
	}
	if strings.Contains(msg.HTMLBody, "<b>") || !strings.Contains(msg.HTMLBody, `<a href="https://f.test/c"`) {
		t.Fatalf("html = %s, want the names escaped and the link", msg.HTMLBody)
	}
	if blank := standardConfirmationMessage("  ", "", "https://f.test/c"); blank.Subject != "Confirm your subscription to this sender" {
		t.Fatalf("blank names subject = %q", blank.Subject)
	}
}

func TestEvaluateSignupConsent(t *testing.T) {
	withCheckbox := &Form{ID: "form-1", Name: "Weekly letter", Structure: defaultStructure()}
	noCheckbox := &Form{ID: "form-2", Name: "Quick signup", Structure: map[string]any{"fields": []map[string]any{
		{"id": "e", "kind": "email", "required": true},
	}}}
	for _, tc := range []struct {
		name     string
		form     *Form
		consent  string
		affirmed bool
		evidence string
	}{
		{"ticked checkbox", withCheckbox, "yes", true, `ticked the consent checkbox "I agree to receive emails." and submitted the form "Weekly letter" (form form-1)`},
		{"unticked checkbox", withCheckbox, "", false, ""},
		{"declined checkbox", withCheckbox, "no", false, ""},
		{"no checkbox", noCheckbox, "", true, `submitted the form "Quick signup" (form form-2). It has no consent checkbox`},
		{"no checkbox, explicit decline", noCheckbox, "false", false, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := evaluateSignupConsent(tc.form, &SubmitInput{Consent: tc.consent})
			if got.Affirmed != tc.affirmed || !strings.Contains(got.Evidence, tc.evidence) || (!tc.affirmed && got.Evidence != "") {
				t.Fatalf("evaluateSignupConsent = %+v, want affirmed=%v evidence containing %q", got, tc.affirmed, tc.evidence)
			}
		})
	}
}

func TestSignupSourceFor(t *testing.T) {
	for _, tc := range []struct {
		origin, referer, want string
	}{
		{"", "", signupSourceHostedPage},
		{"https://forms.example.test", "", signupSourceHostedPage},
		{"https://FORMS.example.test", "", signupSourceHostedPage},
		{"null", "https://forms.example.test/forms/x", signupSourceHostedPage},
		{"https://shop.example.com", "", signupSourceEmbeddedForm},
		{"", "https://blog.example.org/post", signupSourceEmbeddedForm},
		{"not a url", "", signupSourceHostedPage},
	} {
		r := httptest.NewRequest("POST", "/submit", nil)
		if tc.origin != "" {
			r.Header.Set("Origin", tc.origin)
		}
		if tc.referer != "" {
			r.Header.Set("Referer", tc.referer)
		}
		if got := signupSourceFor(r, "https://forms.example.test"); got != tc.want {
			t.Errorf("origin %q referer %q = %q, want %q", tc.origin, tc.referer, got, tc.want)
		}
	}
}

func TestDoubleOptInEvidenceNamesTheFormAndTheSubmission(t *testing.T) {
	got := doubleOptInEvidence("Weekly\nletter", "form-9", time.Date(2026, 9, 15, 1, 2, 3, 0, time.UTC))
	want := `The visitor submitted the form "Weekly letter" (form form-9) at 2026-09-15T01:02:03Z and then clicked the confirmation link emailed to this address.`
	if got != want {
		t.Fatalf("evidence = %q, want %q", got, want)
	}
	long := strings.Repeat("x", 5000)
	if evidence := doubleOptInEvidence(long, "f", time.Now()); len(evidence) > 2048 {
		t.Fatalf("evidence is %d bytes; consent evidence must stay within 2048", len(evidence))
	}
}
