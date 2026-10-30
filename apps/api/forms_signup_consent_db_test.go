// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/subscribers"
)

// The consent the visitor gave on a hosted form has to be what the profile's
// Consent tab shows, because that tab is the answer an operator gives a
// regulator, a subject-access request, or anyone asking why this address is
// being emailed.
//
// It read "Unknown" with no timestamp for every form signup. The tab lists
// subscriber_channel_consents, and migration 1766's canonical fold writes that
// table with an UPDATE, so it could only correct a row the channel-consent
// PATCH surface had already inserted. A hosted form never goes through that
// surface: it recorded exact-address evidence, enabled the subscriber, and left
// the tab saying nothing had ever been recorded.
//
// The state is read back through the repository call the tab's endpoint makes,
// not through SQL of this test's own devising.
func TestASingleOptInFormSignupIsConsentedOnTheConsentTab(t *testing.T) {
	e := newFormsSignupE2E(t)
	email := "consent-soi-" + uuid.NewString()[:8] + "@example.test"

	if rec := e.submitFrom(e.soiFormID, email); rec.Code != http.StatusOK {
		t.Fatalf("submit = %d %s", rec.Code, rec.Body.String())
	}
	e.drain()

	consent := e.emailConsentOnConsentTab(email)
	if consent.Status != "opted_in" {
		t.Fatalf("email consent status = %q, want opted_in (the visitor ticked the form's required consent box)", consent.Status)
	}
	if consent.ConsentTimestamp == nil {
		t.Fatal(`email consent has no timestamp, so the tab reads "Not recorded" for consent it holds`)
	}

	// The evidence behind that state: what was agreed to, under which policy,
	// from which address and browser — the same tuple the preference centre and
	// the operator's own grant record.
	proof := e.emailConsentProof(email)
	for _, want := range []string{
		"ticked the consent checkbox",
		`"I agree to receive emails."`,
		"Launch list",
	} {
		if !strings.Contains(proof.evidence, want) {
			t.Errorf("consent evidence %q does not describe %q", proof.evidence, want)
		}
	}
	if proof.source != subscribers.ConsentSingleOptIn {
		t.Errorf("consent source = %q, want %q", proof.source, subscribers.ConsentSingleOptIn)
	}
	if proof.ip != "198.51.100.7" || proof.userAgent != "Mozilla/5.0 (form visitor)" {
		t.Errorf("consent proof recorded ip %q / user agent %q, want the visitor's", proof.ip, proof.userAgent)
	}
	if proof.policyVersion == "" {
		t.Error("consent proof records no policy version")
	}
	// The submission's own consent event is the other half of the trail. It
	// used to prove only that "consent was captured for form <uuid>".
	if event := e.submissionConsentProofText(email); !strings.Contains(event, `"I agree to receive emails."`) {
		t.Errorf("the submission's consent event proves %q, which names no act the visitor took", event)
	}
}

// A double opt-in is not consent yet, and it is not nothing either: the
// visitor asked, and an email is in flight. The tab said "Unknown" both
// before and after the click, so an operator could not tell an address that
// was waiting on its confirmation from one that had never been asked.
func TestADoubleOptInFormSignupIsPendingUntilTheLinkIsClicked(t *testing.T) {
	e := newFormsSignupE2E(t)
	email := "consent-doi-" + uuid.NewString()[:8] + "@example.test"

	if rec := e.submitFrom(e.doiFormID, email); rec.Code != http.StatusOK {
		t.Fatalf("submit = %d %s", rec.Code, rec.Body.String())
	}
	e.drain()

	pending := e.emailConsentOnConsentTab(email)
	if pending.Status != "pending" {
		t.Fatalf("email consent status before the click = %q, want pending", pending.Status)
	}
	if pending.ConsentTimestamp != nil {
		t.Errorf("email consent is timestamped at %v before anyone confirmed anything", pending.ConsentTimestamp)
	}
	if pending.ConsentSource != subscribers.ConsentDoubleOptIn {
		t.Errorf("pending consent source = %q, want %q so the tab can say what is awaited",
			pending.ConsentSource, subscribers.ConsentDoubleOptIn)
	}

	if rec := e.confirm(e.tokenFor(email)); rec.Code != http.StatusOK {
		t.Fatalf("confirm = %d %s", rec.Code, rec.Body.String())
	}
	e.drain()

	confirmed := e.emailConsentOnConsentTab(email)
	if confirmed.Status != "opted_in" || confirmed.ConsentTimestamp == nil {
		t.Fatalf("email consent after the click = %+v, want opted_in with a timestamp", confirmed)
	}
	proof := e.emailConsentProof(email)
	if proof.source != subscribers.ConsentDoubleOptIn {
		t.Errorf("consent source = %q, want %q", proof.source, subscribers.ConsentDoubleOptIn)
	}
	if !strings.Contains(proof.evidence, "clicked the confirmation link") {
		t.Errorf("consent evidence %q does not record the click that granted it", proof.evidence)
	}
}

// Anyone can POST anyone's address to a published double opt-in form. Doing
// that must not take away consent the address already gave: the pending state
// records a request, and a request is not a retraction.
func TestADoubleOptInSubmissionNeverUnwindsConsentAlreadyGiven(t *testing.T) {
	e := newFormsSignupE2E(t)
	email := "consent-both-" + uuid.NewString()[:8] + "@example.test"

	if rec := e.submitFrom(e.soiFormID, email); rec.Code != http.StatusOK {
		t.Fatalf("single opt-in submit = %d %s", rec.Code, rec.Body.String())
	}
	e.drain()
	if got := e.emailConsentOnConsentTab(email).Status; got != "opted_in" {
		t.Fatalf("email consent after the single opt-in signup = %q, want opted_in", got)
	}

	if rec := e.submitFrom(e.doiFormID, email); rec.Code != http.StatusOK {
		t.Fatalf("double opt-in submit = %d %s", rec.Code, rec.Body.String())
	}
	e.drain()

	after := e.emailConsentOnConsentTab(email)
	if after.Status != "opted_in" || after.ConsentTimestamp == nil {
		t.Fatalf("email consent after a second form asked = %+v, want the granted consent untouched", after)
	}
}

// submitFrom posts a signup the way a browser on the hosted page does, with an
// address and a user agent the consent evidence must keep.
func (e *formsSignupE2E) submitFrom(formID, email string) *httptest.ResponseRecorder {
	e.t.Helper()
	body := `{"email":"` + email + `","name":"Ada Lovelace","consent":"yes"}`
	req := httptest.NewRequest(http.MethodPost, "/api/public/forms/launch-"+formID[:8]+"/submit", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Mozilla/5.0 (form visitor)")
	req.RemoteAddr = "198.51.100.7:52012"
	rec := httptest.NewRecorder()
	e.router.ServeHTTP(rec, req)
	return rec
}

// emailConsentOnConsentTab reads the email channel consent through
// ListChannelConsents — the repository call GET
// /api/v1/subscribers/{id}/channel-consents makes, which is what the profile's
// Consent tab renders.
func (e *formsSignupE2E) emailConsentOnConsentTab(email string) subscribers.ChannelConsent {
	e.t.Helper()
	items, _, err := e.subscribers.ListChannelConsents(e.t.Context(), e.tenantID, e.subscriberID(email))
	if err != nil {
		e.t.Fatalf("list channel consents: %v", err)
	}
	for _, item := range items {
		if item.Channel == "email" {
			return item
		}
	}
	e.t.Fatalf("no email consent row for %s; the Consent tab shows Unknown / Not recorded", email)
	return subscribers.ChannelConsent{}
}

func (e *formsSignupE2E) subscriberID(email string) string {
	e.t.Helper()
	page, err := e.subscribers.Search(e.t.Context(), e.tenantID, email, 1, 10, false)
	if err != nil {
		e.t.Fatalf("subscriber search: %v", err)
	}
	if page.Total != 1 {
		e.t.Fatalf("subscribers matching %s = %d, want 1", email, page.Total)
	}
	return page.Items[0].ID
}

type e2eConsentProof struct {
	source, evidence, policyVersion, ip, userAgent string
}

// emailConsentProof reads the structured consent proof and the immutable
// consent event behind the latest email grant.
func (e *formsSignupE2E) emailConsentProof(email string) e2eConsentProof {
	e.t.Helper()
	tx, err := db.WithTenant(e.t.Context(), e.pool, e.tenantID)
	if err != nil {
		e.t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(e.t.Context()) }()
	var got e2eConsentProof
	if err := tx.QueryRow(e.t.Context(), `
SELECT record.source,
       COALESCE(record.evidence ->> 'evidence', ''),
       COALESCE(record.evidence ->> 'policy_version', ''),
       COALESCE(host(record.ip_addr), ''),
       COALESCE(record.user_agent, '')
  FROM consent_records AS record
 WHERE record.tenant_id = $1::uuid
   AND record.email = $2
   AND record.consent_status = 'granted'
 ORDER BY record.captured_at DESC, record.id DESC
 LIMIT 1`, e.tenantID, email).Scan(
		&got.source, &got.evidence, &got.policyVersion, &got.ip, &got.userAgent); err != nil {
		e.t.Fatalf("read consent proof for %s: %v", email, err)
	}
	return got
}

// submissionConsentProofText reads the proof the submission's own consent
// event carries (the row the public submit writes keyed to the submission).
func (e *formsSignupE2E) submissionConsentProofText(email string) string {
	e.t.Helper()
	tx, err := db.WithTenant(e.t.Context(), e.pool, e.tenantID)
	if err != nil {
		e.t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(e.t.Context()) }()
	var proof string
	if err := tx.QueryRow(e.t.Context(), `
SELECT COALESCE(event.proof_text, '')
  FROM consent_events AS event
 WHERE event.tenant_id = $1::uuid
   AND event.subject_email = $2
   AND event.source = 'public_form'
 ORDER BY event.recorded_at DESC, event.id DESC
 LIMIT 1`, e.tenantID, email).Scan(&proof); err != nil {
		e.t.Fatalf("read the submission consent event for %s: %v", email, err)
	}
	return proof
}
