// SPDX-License-Identifier: AGPL-3.0-only
package forms

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/testsupport/listmonkv6"
)

const consentedBody = `{"email":"%s","name":"Ada  Lovelace","consent":"yes","customFields":{"city":"Oslo"}}`

func body(format, email string) string { return strings.Replace(format, "%s", email, 1) }

// A new address signing up to a list-targeted form used to get 502 with
// Listmonk already holding the subscriber, and no submission on record. Now
// the submission, its target list and the durable audience intent commit
// together, and the audience step joins the list and enrols the address in
// Listmonk with a confirmed subscription.
func TestSingleOptInSignupToAListIsRecordedJoinsTheListAndReachesListmonk(t *testing.T) {
	h := newSignupHarness(t, harnessForm{optIn: OptInSingle, settings: map[string]any{
		"targetListId": "7", "successMessage": "Welcome aboard",
	}})
	h.engine.AddList(7, "Launch", "single")
	listID := h.mapList(7)

	rec := h.post(body(consentedBody, "new@example.com"))
	if rec.Code != http.StatusOK {
		t.Fatalf("submit = %d %s, want 200", rec.Code, rec.Body.String())
	}
	if got, want := rec.Body.String(), `{"ok":true,"state":"subscribed","message":"Welcome aboard"}`+"\n"; got != want {
		t.Fatalf("response = %q, want %q", got, want)
	}
	stored := h.submission("new@example.com")
	if stored.Status != string(SubmissionConfirmed) || stored.Name != "Ada  Lovelace" ||
		!reflect.DeepEqual(stored.TargetListIDs, []string{listID}) || stored.SignupSource != signupSourceHostedPage {
		t.Fatalf("stored submission = %+v, want confirmed, named, joining %s from the hosted page", stored, listID)
	}
	intents := h.appendsOf(OutboxKindRecordSignup)
	if len(intents) != 1 {
		t.Fatalf("signup intents = %d, want exactly 1 in the submission's transaction", len(intents))
	}

	h.drain()
	signups := h.audience.recorded()
	if len(signups) != 1 {
		t.Fatalf("audience writes = %d, want 1", len(signups))
	}
	got := signups[0]
	if got.Email != "new@example.com" || got.Name != "Ada  Lovelace" || got.SubmissionID != stored.ID ||
		!reflect.DeepEqual(got.ListIDs, []string{listID}) || got.IP != "203.0.113.10" {
		t.Fatalf("audience signup = %+v", got)
	}
	if got.Consent == nil || got.Consent.Method != consentMethodSingleOptIn || got.Consent.MailboxVerified ||
		!strings.Contains(got.Consent.Evidence, `"I agree to receive emails."`) ||
		got.Consent.PolicyVersion != formSignupConsentPolicy || got.Consent.Reason != singleOptInReason {
		t.Fatalf("single opt-in consent = %+v", got.Consent)
	}
	engineSub, ok := h.engine.Subscriber("new@example.com")
	if !ok {
		t.Fatal("the signup never reached Listmonk")
	}
	if engineSub.Status != listmonkv6.StatusEnabled || !reflect.DeepEqual(engineSub.Lists, map[int64]string{7: listmonkv6.SubscriptionConfirmed}) {
		t.Fatalf("Listmonk subscriber = %+v, want enabled with list 7 confirmed", engineSub)
	}
	if engineSub.Attribs["city"] != "Oslo" || engineSub.Attribs["name"] != "Ada  Lovelace" {
		t.Fatalf("Listmonk attribs = %v, want the form fields and the name", engineSub.Attribs)
	}
	if n := len(h.engine.RequestsTo(http.MethodPost, "/api/tx")); n != 0 {
		t.Fatalf("%d /api/tx calls; a single opt-in sends no confirmation", n)
	}
}

// Re-submitting an address Listmonk already has used to answer "subscribed"
// and do nothing else: POST /api/subscribers answers 409 and never adds lists
// to an existing subscriber. The submission must be recorded and the address
// must join the form's list.
func TestAnExistingAddressJoinsTheFormsListAndIsRecorded(t *testing.T) {
	h := newSignupHarness(t, harnessForm{optIn: OptInSingle, settings: map[string]any{"targetListId": 9}})
	h.engine.AddList(5, "Older list", "single")
	h.engine.AddList(9, "New list", "single")
	h.mapList(9)
	known := h.engine.SeedSubscriber("known@example.com", "Known", listmonkv6.StatusEnabled,
		map[string]any{"plan": "pro"}, map[int64]string{5: listmonkv6.SubscriptionConfirmed})

	if rec := h.post(body(consentedBody, "known@example.com")); rec.Code != http.StatusOK {
		t.Fatalf("submit = %d %s", rec.Code, rec.Body.String())
	}
	if n := h.count(`SELECT count(*) FROM form_submissions WHERE form_id = $1::uuid`, h.formID); n != 1 {
		t.Fatalf("form_submissions = %d, want 1", n)
	}
	h.drain()

	adds := h.engine.RequestsTo(http.MethodPut, "/api/subscribers/lists")
	if len(adds) != 1 {
		t.Fatalf("list-membership calls = %d, want exactly 1", len(adds))
	}
	want := `{"ids":[` + strconv.FormatInt(known, 10) + `],"action":"add","target_list_ids":[9],"status":"confirmed"}`
	if string(adds[0].Body) != want {
		t.Fatalf("list add = %s, want %s", adds[0].Body, want)
	}
	engineSub, _ := h.engine.Subscriber("known@example.com")
	if wantLists := map[int64]string{5: listmonkv6.SubscriptionConfirmed, 9: listmonkv6.SubscriptionConfirmed}; !reflect.DeepEqual(engineSub.Lists, wantLists) {
		t.Fatalf("Listmonk lists = %v, want %v", engineSub.Lists, wantLists)
	}
	// An unverified POST can name anyone's address: what it typed never
	// replaces the stored name or attributes.
	if engineSub.Name != "Known" || !reflect.DeepEqual(engineSub.Attribs, map[string]any{"plan": "pro"}) {
		t.Fatalf("Listmonk subscriber = %q %v, want the stored name and attributes untouched", engineSub.Name, engineSub.Attribs)
	}
	for _, method := range []string{http.MethodPut, http.MethodPatch} {
		if n := len(h.engine.RequestsTo(method, "/api/subscribers/"+strconv.FormatInt(known, 10))); n != 0 {
			t.Fatalf("%d %s /api/subscribers/:id calls from an unverified form POST", n, method)
		}
	}
}

// An unverified form POST naming someone's address must not undo their
// opt-out: no list add for a blocklisted subscriber, none over an
// unsubscribed membership.
func TestASingleOptInSubmissionNeverReversesAnOptOut(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status string
		lists  map[int64]string
	}{
		{"blocklisted subscriber", listmonkv6.StatusBlocklisted, map[int64]string{}},
		{"unsubscribed from the form's list", listmonkv6.StatusEnabled, map[int64]string{9: listmonkv6.SubscriptionUnsubscribed}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newSignupHarness(t, harnessForm{optIn: OptInSingle, settings: map[string]any{"targetListId": 9}})
			h.engine.AddList(9, "List", "single")
			h.mapList(9)
			h.audience.subscribed = func(AudienceSignup) bool { return true }
			h.engine.SeedSubscriber("optedout@example.com", "", tc.status, nil, tc.lists)

			if rec := h.post(body(consentedBody, "optedout@example.com")); rec.Code != http.StatusOK {
				t.Fatalf("submit = %d %s", rec.Code, rec.Body.String())
			}
			h.drain()
			if adds := h.engine.RequestsTo(http.MethodPut, "/api/subscribers/lists"); len(adds) != 0 {
				t.Fatalf("list add sent for an opted-out address: %s", adds[0].Body)
			}
			engineSub, _ := h.engine.Subscriber("optedout@example.com")
			if engineSub.Status != tc.status || !reflect.DeepEqual(engineSub.Lists, tc.lists) {
				t.Fatalf("Listmonk subscriber changed to %+v", engineSub)
			}
		})
	}
}

// Double opt-in: the confirmation email is queued with the submission and
// goes out through the product's mailer, from the form's own sender on a
// domain the workspace verified, with the operator's subject and body and an
// absolute link to this submission's token. Listmonk gets nothing (so it
// never mails an opt-in of its own) until the link is clicked.
func TestDoubleOptInMailsTheConfirmationLinkThroughTheOutboundMailer(t *testing.T) {
	h := newSignupHarness(t, harnessForm{optIn: OptInDouble, settings: map[string]any{
		"targetListId":          2, // Listmonk's own double opt-in list
		"confirmationSubject":   "Please confirm",
		"confirmationBody":      "Hi!\nConfirm <here>:\n\n{{confirm_url}}\n\nThanks & bye",
		"confirmationFromEmail": "news@Acme.test",
		"confirmationFromName":  "Acme News",
	}})
	h.mapList(2)
	h.senders.verified = map[string]bool{"acme.test": true}

	rec := h.post(body(consentedBody, "doi@example.com"))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"state":"pending-confirmation"`) {
		t.Fatalf("submit = %d %s, want 200 pending-confirmation", rec.Code, rec.Body.String())
	}
	stored := h.submission("doi@example.com")
	if stored.Status != string(SubmissionPending) || stored.Token == "" || stored.EmailState != string(ConfirmationEmailQueued) {
		t.Fatalf("stored = %+v, want pending with a token and the email queued", stored)
	}
	if queued := h.appendsOf(OutboxKindSendConfirmation); len(queued) != 1 || len(h.mailer.messages()) != 0 {
		t.Fatalf("confirmation sends queued = %d with %d sent before the outbox ran, want 1 queued and none sent", len(queued), len(h.mailer.messages()))
	}
	h.drain()
	sent := h.mailer.messages()
	if len(sent) != 1 {
		t.Fatalf("confirmation emails = %d, want 1", len(sent))
	}
	if state := h.submission("doi@example.com").EmailState; state != string(ConfirmationEmailSent) {
		t.Fatalf("confirmation email state = %q, want sent", state)
	}
	link := "https://forms.example.test/forms/" + h.slug + "/confirm/" + stored.Token
	msg := sent[0]
	if msg.To != "doi@example.com" || msg.From != `"Acme News" <news@Acme.test>` || msg.TenantID != h.tenantID ||
		msg.Subject != "Please confirm" || msg.Tags["purpose"] != confirmationMailPurpose || msg.Tags["sender"] != "workspace" {
		t.Fatalf("message envelope = %+v", msg)
	}
	if msg.Body != "Hi!\nConfirm <here>:\n\n"+link+"\n\nThanks & bye" {
		t.Fatalf("text body = %q", msg.Body)
	}
	if !strings.Contains(msg.HTMLBody, `<a href="`+link+`"`) ||
		!strings.Contains(msg.HTMLBody, "Hi!<br>Confirm &lt;here&gt;:") ||
		!strings.Contains(msg.HTMLBody, "Thanks &amp; bye") {
		t.Fatalf("html body does not carry the escaped text and the link: %s", msg.HTMLBody)
	}

	if got := h.audience.recorded(); len(got) != 1 || got[0].Consent != nil || len(got[0].ListIDs) != 0 {
		t.Fatalf("pending signup audience write = %+v, want the identity only", got)
	}
	// Nothing is subscribed until the link is clicked, so the form writes
	// nothing to Listmonk.
	if got := h.engine.Requests(); len(got) != 0 {
		t.Fatalf("%d Listmonk request(s) before confirmation, first %s %s", len(got), got[0].Method, got[0].Path)
	}
	if n := h.engine.OptinMailsSent(); n != 0 {
		t.Fatalf("Listmonk would have sent %d opt-in mails of its own", n)
	}
	if n := len(h.engine.RequestsTo(http.MethodPost, "/api/tx")); n != 0 {
		t.Fatalf("%d /api/tx calls; the confirmation goes through the mailer", n)
	}
}

// A mailer failure leaves the submission pending with the failure on it: the
// outbox retries the send (the error it keeps names no address), the visitor
// was still told to check their inbox, and the operator's resend reports it.
func TestAFailedConfirmationEmailIsRetriedAndResendReportsIt(t *testing.T) {
	h := newSignupHarness(t, harnessForm{optIn: OptInDouble})
	// SES names the recipient in this refusal; the error the outbox stores
	// and logs must not.
	h.mailer.err = errors.New("ses permanent: Email address is not verified. The following identities failed the check: FAIL@example.com")

	rec := h.post(body(consentedBody, "fail@example.com"))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"pending-confirmation"`) {
		t.Fatalf("submit = %d %s", rec.Code, rec.Body.String())
	}
	err := h.tryDrain()
	if err == nil || !strings.Contains(err.Error(), "failed the check: [recipient]") || strings.Contains(strings.ToLower(err.Error()), "fail@example.com") {
		t.Fatalf("send error for the outbox = %v, want it retried with the address redacted", err)
	}
	stored := h.submission("fail@example.com")
	if stored.Status != string(SubmissionPending) || stored.EmailState != string(ConfirmationEmailSendFailed) {
		t.Fatalf("stored = %+v, want pending with send_failed", stored)
	}
	// The Submissions page reads the outcome off the list.
	list := h.serve(http.MethodGet, "/api/v1/forms/"+h.formID+"/submissions", "")
	if list.Code != http.StatusOK || !strings.Contains(list.Body.String(), `"status":"pending","ip":`) ||
		!strings.Contains(list.Body.String(), `"confirmationEmail":"send_failed"`) {
		t.Fatalf("submissions list = %d %s, want the pending submission with its failed email", list.Code, list.Body.String())
	}
	h.mailer.err = nil
	if err := h.tryDrain(); err != nil || len(h.mailer.messages()) != 1 || h.submission("fail@example.com").EmailState != string(ConfirmationEmailSent) {
		t.Fatalf("retry = %v with %d emails, want the email sent and recorded", err, len(h.mailer.messages()))
	}

	resend := "/api/v1/forms/" + h.formID + "/submissions/" + stored.ID + "/resend-confirmation"
	h.mailer.err = errors.New("ses throttled")
	failed := h.serve(http.MethodPost, resend, "")
	if failed.Code != http.StatusBadGateway || !strings.Contains(failed.Body.String(), `"code":"confirmation_email_failed"`) ||
		!strings.Contains(failed.Body.String(), "Try again in a few minutes.") ||
		h.submission("fail@example.com").EmailState != string(ConfirmationEmailSendFailed) {
		t.Fatalf("resend with a failing mailer = %d %s, want 502 confirmation_email_failed recorded", failed.Code, failed.Body.String())
	}

	h.deps.ConfirmationMailer = nil
	unconfigured := h.serve(http.MethodPost, resend, "")
	if unconfigured.Code != http.StatusServiceUnavailable || !strings.Contains(unconfigured.Body.String(), `"code":"confirmation_email_unavailable"`) {
		t.Fatalf("resend without a mailer = %d %s, want 503", unconfigured.Code, unconfigured.Body.String())
	}

	h.deps.ConfirmationMailer = h.mailer
	h.mailer.err = nil
	ok := h.serve(http.MethodPost, resend, "")
	if ok.Code != http.StatusOK || len(h.mailer.messages()) != 2 || h.submission("fail@example.com").EmailState != string(ConfirmationEmailSent) {
		t.Fatalf("resend = %d %s with %d emails, want 200 and a second email", ok.Code, ok.Body.String(), len(h.mailer.messages()))
	}
}

// Without a verified sender of its own, a form's confirmation goes from the
// standard sender with the fixed text, never the operator's subject and body;
// the standard sender is capped per workspace per hour; with neither sender
// nothing is sent and the operator is told what to set up; an address that
// bounced, complained or was erased is never mailed.
func TestWhoAConfirmationEmailIsSentFrom(t *testing.T) {
	h := newSignupHarness(t, harnessForm{optIn: OptInDouble, settings: map[string]any{
		"confirmationSubject":   "Win a prize",
		"confirmationBody":      "Visit https://phish.example {{confirm_url}}",
		"confirmationFromEmail": "news@unverified.test",
	}})
	h.deps.StandardSenderHourlyLimit = 2
	h.guard.blocked = map[string]bool{"bounced@example.com": true}
	for _, email := range []string{"one@example.com", "two@example.com", "three@example.com", "bounced@example.com"} {
		if rec := h.post(body(consentedBody, email)); rec.Code != http.StatusOK {
			t.Fatalf("submit %s = %d %s", email, rec.Code, rec.Body.String())
		}
	}
	err := h.tryDrain()
	if !errors.Is(err, ErrConfirmationQuotaExceeded) {
		t.Fatalf("third send = %v, want ErrConfirmationQuotaExceeded for the outbox to retry", err)
	}
	sent := h.mailer.messages()
	if len(sent) != 2 || !reflect.DeepEqual(h.senders.asked, []string{"unverified.test", "unverified.test", "unverified.test"}) {
		t.Fatalf("emails = %d, sender checks = %v; want two sent after checking the form's sender each time", len(sent), h.senders.asked)
	}
	msg := sent[0]
	if msg.From != "Signups <signups@example.test>" || msg.Tags["sender"] != "standard" ||
		msg.Subject != "Confirm your subscription to form signups" ||
		!strings.Contains(msg.Body, "by signing up with the form “Weekly letter”") || strings.Contains(msg.Body, "phish") {
		t.Fatalf("standard sender email = %+v", msg)
	}
	if state := h.submission("three@example.com").EmailState; state != string(ConfirmationEmailQuotaExceeded) {
		t.Fatalf("throttled submission state = %q, want quota_exceeded", state)
	}
	throttled := h.serve(http.MethodPost, "/api/v1/forms/"+h.formID+"/submissions/"+h.submission("three@example.com").ID+"/resend-confirmation", "")
	if throttled.Code != http.StatusTooManyRequests || !strings.Contains(throttled.Body.String(), `"code":"confirmation_quota_exceeded"`) {
		t.Fatalf("resend over the hourly cap = %d %s, want 429", throttled.Code, throttled.Body.String())
	}

	h.deps.StandardSenderHourlyLimit = 10
	h.deps.ConfirmationFrom = ""
	h.drained++ // the outbox would retry the throttled event; skip to the next
	if err := h.tryDrain(); err != nil {
		t.Fatalf("a refusal the operator must resolve was returned for retry: %v", err)
	}
	if state := h.submission("bounced@example.com").EmailState; state != string(ConfirmationEmailRecipientSuppressed) {
		t.Fatalf("suppressed address state = %q, want recipient_suppressed", state)
	}
	noSender := h.serve(http.MethodPost, "/api/v1/forms/"+h.formID+"/submissions/"+h.submission("three@example.com").ID+"/resend-confirmation", "")
	if noSender.Code != http.StatusUnprocessableEntity || !strings.Contains(noSender.Body.String(), `"code":"confirmation_sender_missing"`) ||
		h.submission("three@example.com").EmailState != string(ConfirmationEmailNoSender) {
		t.Fatalf("resend without a sender = %d %s, want 422 confirmation_sender_missing recorded", noSender.Code, noSender.Body.String())
	}
	if n := len(h.mailer.messages()); n != 2 {
		t.Fatalf("emails = %d, want still 2", n)
	}
}

// A single opt-in from an address that had unsubscribed cannot re-subscribe
// it on a form POST anyone could send. The owner of the mailbox can: the
// submission becomes pending and gets the confirmation email, whose click is
// verified consent. The visitor's answer is the ordinary single opt-in one.
func TestAnUnsubscribedAddressIsSentAConfirmationToComeBack(t *testing.T) {
	h := newSignupHarness(t, harnessForm{optIn: OptInSingle, settings: map[string]any{"targetListId": 7}})
	h.engine.AddList(7, "Launch", "single")
	listID := h.mapList(7)
	h.audience.optedOut = map[string]bool{"back@example.com": true}

	rec := h.post(body(consentedBody, "back@example.com"))
	if !strings.Contains(rec.Body.String(), `"state":"subscribed"`) {
		t.Fatalf("submit = %d %s, want the single opt-in answer", rec.Code, rec.Body.String())
	}
	h.drain()
	stored := h.submission("back@example.com")
	if stored.Status != string(SubmissionPending) || stored.Token == "" || stored.EmailState != string(ConfirmationEmailSent) {
		t.Fatalf("stored = %+v, want pending with a sent confirmation", stored)
	}
	sent := h.mailer.messages()
	if len(sent) != 1 || !strings.Contains(sent[0].Body, "/confirm/"+stored.Token) {
		t.Fatalf("emails = %+v, want one confirmation carrying the submission's link", sent)
	}
	if got := h.engine.Requests(); len(got) != 0 {
		t.Fatalf("%d Listmonk request(s) for an address that stays unsubscribed", len(got))
	}
	// A redelivered signup event neither mints a second link nor mails again.
	if err := h.handler.RecordSubmitted(context.Background(), h.tenantID, []byte(`{"submission_id":"`+stored.ID+`","subscribe":true,"consent":{"method":"single_optin"}}`)); err != nil {
		t.Fatalf("redelivery: %v", err)
	}
	h.drain()
	if again := h.submission("back@example.com"); again.Token != stored.Token || len(h.mailer.messages()) != 1 {
		t.Fatalf("redelivery changed the link or mailed again: %+v, %d emails", again, len(h.mailer.messages()))
	}

	if confirm := h.serve(http.MethodGet, "/api/public/forms/confirm/"+stored.Token, ""); confirm.Code != http.StatusOK {
		t.Fatalf("confirm = %d %s", confirm.Code, confirm.Body.String())
	}
	h.drain()
	signups := h.audience.recorded()
	last := signups[len(signups)-1]
	if last.Consent == nil || !last.Consent.MailboxVerified || !reflect.DeepEqual(last.ListIDs, []string{listID}) {
		t.Fatalf("after the click the audience write = %+v, want verified consent joining the form's list", last)
	}
}

// Clicking the link is verified consent: the audience step joins the list
// with double opt-in consent, and Listmonk enables the subscriber and
// confirms that list over PATCH — the subscriber's other subscriptions stay.
func TestConfirmingEnablesTheSignupAndKeepsEveryOtherSubscription(t *testing.T) {
	h := newSignupHarness(t, harnessForm{optIn: OptInDouble, settings: map[string]any{"targetListId": 7}})
	h.engine.AddList(5, "Existing", "single")
	h.engine.AddList(7, "Launch", "single")
	listID := h.mapList(7)
	existing := h.engine.SeedSubscriber("both@example.com", "Both", listmonkv6.StatusDisabled,
		map[string]any{"plan": "pro"}, map[int64]string{5: listmonkv6.SubscriptionConfirmed})

	if rec := h.post(body(consentedBody, "both@example.com")); rec.Code != http.StatusOK {
		t.Fatalf("submit = %d %s", rec.Code, rec.Body.String())
	}
	h.drain()
	stored := h.submission("both@example.com")

	confirm := h.serve(http.MethodGet, "/api/public/forms/confirm/"+stored.Token, "")
	if confirm.Code != http.StatusOK || !strings.Contains(confirm.Body.String(), `"confirmed"`) {
		t.Fatalf("confirm = %d %s", confirm.Code, confirm.Body.String())
	}
	confirmEvents := h.appendsOf(OutboxKindEnableListmonk)
	if len(confirmEvents) != 1 {
		t.Fatalf("confirm intents = %d, want 1", len(confirmEvents))
	}
	payload, _ := json.Marshal(confirmEvents[0].Payload)
	if strings.Contains(string(payload), "both@example.com") || !strings.Contains(string(payload), stored.ID) {
		t.Fatalf("confirm payload = %s, want the submission id and no address", payload)
	}
	h.drain()

	signups := h.audience.recorded()
	confirmed := signups[len(signups)-1]
	if confirmed.Consent == nil || confirmed.Consent.Method != consentMethodDoubleOptIn || !confirmed.Consent.MailboxVerified ||
		!reflect.DeepEqual(confirmed.ListIDs, []string{listID}) || confirmed.Consent.Reason != doubleOptInReason ||
		!strings.Contains(confirmed.Consent.Evidence, "clicked the confirmation link") {
		t.Fatalf("confirmation audience write = %+v", confirmed)
	}
	engineSub, _ := h.engine.Subscriber("both@example.com")
	wantLists := map[int64]string{5: listmonkv6.SubscriptionConfirmed, 7: listmonkv6.SubscriptionConfirmed}
	// The click proved the mailbox is the visitor's, so what they typed is
	// merged in over the kept attributes.
	if engineSub.Status != listmonkv6.StatusEnabled || !reflect.DeepEqual(engineSub.Lists, wantLists) ||
		engineSub.Attribs["plan"] != "pro" || engineSub.Attribs["city"] != "Oslo" {
		t.Fatalf("Listmonk after confirm = %+v, want enabled on %v with attribs kept and the form's merged in", engineSub, wantLists)
	}
	subscriberPath := "/api/subscribers/" + strconv.FormatInt(existing, 10)
	if n := len(h.engine.RequestsTo(http.MethodPut, subscriberPath)); n != 0 {
		t.Fatalf("%d PUT %s calls; PUT wipes subscriptions", n, subscriberPath)
	}
	if n := len(h.engine.RequestsTo(http.MethodPatch, subscriberPath)); n == 0 {
		t.Fatal("the subscriber was never enabled over PATCH")
	}
}

// A double opt-in click may restore a subscription the address had
// unsubscribed from: it is fresh, verified consent.
func TestAConfirmedDoubleOptInRestoresAnUnsubscribedMembership(t *testing.T) {
	h := newSignupHarness(t, harnessForm{optIn: OptInDouble, settings: map[string]any{"targetListId": 7}})
	h.engine.AddList(7, "Launch", "single")
	h.mapList(7)
	h.engine.SeedSubscriber("back@example.com", "", listmonkv6.StatusEnabled, nil,
		map[int64]string{7: listmonkv6.SubscriptionUnsubscribed})

	h.post(body(consentedBody, "back@example.com"))
	h.drain()
	if adds := h.engine.RequestsTo(http.MethodPut, "/api/subscribers/lists"); len(adds) != 0 {
		t.Fatalf("an unconfirmed signup touched the unsubscribed membership: %s", adds[0].Body)
	}
	stored := h.submission("back@example.com")
	h.serve(http.MethodGet, "/api/public/forms/confirm/"+stored.Token, "")
	h.drain()
	engineSub, _ := h.engine.Subscriber("back@example.com")
	if engineSub.Lists[7] != listmonkv6.SubscriptionConfirmed {
		t.Fatalf("membership after the confirmed opt-in = %q, want confirmed", engineSub.Lists[7])
	}
}

// A form that has a consent checkbox the visitor left unticked records a
// response and subscribes nobody; it must not claim "subscribed".
func TestAnUntickedConsentCheckboxRecordsAResponseWithoutSubscribing(t *testing.T) {
	structure := map[string]any{"fields": []map[string]any{
		{"id": "f_email", "kind": "email", "label": "Email", "required": true},
		{"id": "f_consent", "kind": "checkbox", "label": "Send me the newsletter", "required": false},
	}}
	h := newSignupHarness(t, harnessForm{optIn: OptInSingle, structure: structure, settings: map[string]any{
		"targetListId": 7, "successMessage": "You're subscribed!",
	}})
	h.engine.AddList(7, "Launch", "single")
	h.mapList(7)

	rec := h.post(`{"email":"reader@example.com"}`)
	if got, want := rec.Body.String(), `{"ok":true,"state":"received"}`+"\n"; rec.Code != http.StatusOK || got != want {
		t.Fatalf("submit = %d %q, want 200 %q", rec.Code, got, want)
	}
	stored := h.submission("reader@example.com")
	if stored.Status != string(SubmissionReceived) || stored.Token != "" || len(stored.TargetListIDs) != 0 {
		t.Fatalf("stored = %+v, want a received response that joins no list", stored)
	}
	if n := h.count(`SELECT count(*) FROM form_submissions WHERE form_id = $1::uuid AND confirmed_at IS NOT NULL`, h.formID); n != 0 {
		t.Fatalf("%d response(s) stamped confirmed; nothing was confirmed", n)
	}
	h.drain()
	got := h.audience.recorded()
	if len(got) != 1 || got[0].Consent != nil || len(got[0].ListIDs) != 0 {
		t.Fatalf("audience write = %+v, want the identity only", got)
	}
	if got := h.engine.Requests(); len(got) != 0 {
		t.Fatalf("%d Listmonk request(s) for a visitor who did not subscribe, first %s %s", len(got), got[0].Method, got[0].Path)
	}
	if n := len(h.mailer.messages()); n != 0 {
		t.Fatalf("%d emails sent to a visitor who did not subscribe", n)
	}

	native := h.post("email=reader2%40example.com", "Content-Type", "application/x-www-form-urlencoded")
	if loc := native.Header().Get("Location"); native.Code != http.StatusSeeOther ||
		loc != "https://forms.example.test/forms/success?form="+h.slug+"&mode=received" {
		t.Fatalf("native post = %d Location %q, want the received page", native.Code, loc)
	}
}

// A visitor who submits with the consent box unticked and then ticks it and
// submits again within the double-submit window has asked to subscribe: the
// second submission is recorded and answered as a signup, not deduplicated
// against the response that subscribed nobody. The honeypot answers a bot's
// unticked body exactly as that response is answered.
func TestTickingTheConsentBoxAfterAnUntickedResponseSubscribes(t *testing.T) {
	structure := map[string]any{"fields": []map[string]any{
		{"id": "f_email", "kind": "email", "label": "Email", "required": true},
		{"id": "f_consent", "kind": "checkbox", "label": "Send me the newsletter", "required": false},
	}}
	for _, tc := range []struct {
		mode      OptInMode
		state     string
		status    SubmissionStatus
		consented bool
		emails    int
	}{
		{mode: OptInSingle, state: "subscribed", status: SubmissionConfirmed, consented: true},
		{mode: OptInDouble, state: "pending-confirmation", status: SubmissionPending, emails: 1},
	} {
		t.Run(string(tc.mode), func(t *testing.T) {
			h := newSignupHarness(t, harnessForm{optIn: tc.mode, structure: structure, settings: map[string]any{"targetListId": 7}})
			h.engine.AddList(7, "Launch", "single")
			listID := h.mapList(7)

			bot := h.post(`{"email":"bot@example.com","website":"https://spam.example"}`)
			unticked := h.post(`{"email":"ticks@example.com"}`)
			if unticked.Body.String() != `{"ok":true,"state":"received"}`+"\n" || bot.Body.String() != unticked.Body.String() {
				t.Fatalf("unticked = %s, honeypot = %s; want both answered as a received response", unticked.Body.String(), bot.Body.String())
			}
			ticked := h.post(`{"email":"ticks@example.com","consent":"yes"}`)
			if !strings.Contains(ticked.Body.String(), `"state":"`+tc.state+`"`) {
				t.Fatalf("ticked = %d %s, want state %s", ticked.Code, ticked.Body.String(), tc.state)
			}
			h.drain()

			statuses := map[string]int{}
			h.eachRow(`SELECT status FROM form_submissions WHERE form_id = $1::uuid ORDER BY submitted_at`, h.formID, func(status string) { statuses[status]++ })
			if want := map[string]int{string(SubmissionReceived): 1, string(tc.status): 1}; !reflect.DeepEqual(statuses, want) {
				t.Fatalf("submissions by status = %v, want %v", statuses, want)
			}
			signups := h.audience.recorded()
			last := signups[len(signups)-1]
			if tc.consented && (last.Consent == nil || !reflect.DeepEqual(last.ListIDs, []string{listID})) {
				t.Fatalf("the ticked signup's audience write = %+v, want consent and the form's list", last)
			}
			if n := len(h.mailer.messages()); n != tc.emails {
				t.Fatalf("confirmation emails = %d, want %d", n, tc.emails)
			}
		})
	}
}

// A double-click is answered like the first click — "check your inbox" on a
// double opt-in form — with one submission and one email.
func TestADoubleClickIsAnsweredLikeTheFirstClick(t *testing.T) {
	h := newSignupHarness(t, harnessForm{optIn: OptInDouble})
	first := h.post(body(consentedBody, "twice@example.com"))
	second := h.post(body(consentedBody, "twice@example.com"))
	if first.Code != http.StatusOK || first.Body.String() != second.Body.String() {
		t.Fatalf("first = %d %s, second = %d %s; want identical answers", first.Code, first.Body.String(), second.Code, second.Body.String())
	}
	if !strings.Contains(second.Body.String(), `"pending-confirmation"`) {
		t.Fatalf("double-click answer = %s, want pending-confirmation", second.Body.String())
	}
	if n := h.count(`SELECT count(*) FROM form_submissions WHERE form_id = $1::uuid`, h.formID); n != 1 {
		t.Fatalf("submissions = %d, want 1", n)
	}
	h.drain()
	if n := len(h.mailer.messages()); n != 1 {
		t.Fatalf("emails = %d, want 1", n)
	}
}

func TestASubmissionFromAnotherSiteIsRecordedAsAnEmbeddedForm(t *testing.T) {
	h := newSignupHarness(t, harnessForm{optIn: OptInSingle})
	h.post(body(consentedBody, "hosted@example.com"), "Origin", "https://forms.example.test")
	h.post(body(consentedBody, "embed@example.com"), "Origin", "https://shop.example.com")
	h.post(body(consentedBody, "referer@example.com"), "Referer", "https://blog.example.org/post")
	for email, want := range map[string]string{
		"hosted@example.com":  signupSourceHostedPage,
		"embed@example.com":   signupSourceEmbeddedForm,
		"referer@example.com": signupSourceEmbeddedForm,
	} {
		if got := h.submission(email).SignupSource; got != want {
			t.Errorf("%s signup_source = %q, want %q", email, got, want)
		}
	}
}

// A confirmation event queued before migration 2049 names the address, not
// the submission; it must still subscribe the visitor.
func TestAConfirmationEventWrittenBeforeTheSubmissionIDStillDrains(t *testing.T) {
	h := newSignupHarness(t, harnessForm{optIn: OptInDouble, settings: map[string]any{"targetListId": 7}})
	h.engine.AddList(7, "Launch", "single")
	listID := h.mapList(7)
	h.post(body(consentedBody, "legacy@example.com"))
	h.drain()
	stored := h.submission("legacy@example.com")
	h.exec(`UPDATE form_submissions SET status = 'confirmed', confirmed_at = now() WHERE id = $1::uuid`, stored.ID)

	legacy := []byte(`{"tenant_id":"` + h.tenantID + `","form_id":"` + h.formID + `","email":"legacy@example.com"}`)
	if err := h.handler.RecordConfirmed(t.Context(), h.tenantID, legacy); err != nil {
		t.Fatalf("legacy confirmation: %v", err)
	}
	signups := h.audience.recorded()
	last := signups[len(signups)-1]
	if last.SubmissionID != stored.ID || last.Consent == nil || !last.Consent.MailboxVerified ||
		!reflect.DeepEqual(last.ListIDs, []string{listID}) {
		t.Fatalf("legacy confirmation audience write = %+v", last)
	}
}

// An address the audience refuses (erased under a privacy request) is never
// written to Listmonk, and the refusal is final rather than retried.
func TestARefusedSignupNeverReachesListmonk(t *testing.T) {
	h := newSignupHarness(t, harnessForm{optIn: OptInSingle})
	h.audience.err = errors.Join(ErrAudienceRefused, errors.New("previously erased"))
	h.post(body(consentedBody, "erased@example.com"))
	if err := h.tryDrain(); err != nil {
		t.Fatalf("a refusal must complete the event, got %v", err)
	}
	if n := len(h.engine.Requests()); n != 0 {
		t.Fatalf("%d Listmonk requests for a refused address", n)
	}
	if !strings.Contains(h.logs.String(), "the audience refused a signup") {
		t.Fatalf("refusal not logged:\n%s", h.logs.String())
	}
}

// An address no subscriber can have ("a..b@…" passed the old check) used to
// be recorded and answered "subscribed", and its audience event could only
// fail until it was dead-lettered. The visitor is now asked to fix it, and
// nothing is recorded.
func TestAnAddressNoSubscriberCanHaveIsRefusedAtSubmit(t *testing.T) {
	h := newSignupHarness(t, harnessForm{optIn: OptInSingle})
	rec := h.post(body(consentedBody, "a..b@example.com"))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), `"bad_email"`) ||
		!strings.Contains(rec.Body.String(), "Enter a valid email address and try again.") {
		t.Fatalf("submit = %d %s, want 422 bad_email", rec.Code, rec.Body.String())
	}
	if n := h.count(`SELECT count(*) FROM form_submissions WHERE form_id = $1::uuid`, h.formID); n != 0 {
		t.Fatalf("%d submissions recorded for an address the subscriber store refuses", n)
	}
	if n := len(h.appendsOf(OutboxKindRecordSignup)); n != 0 {
		t.Fatalf("%d audience intents for an address the subscriber store refuses", n)
	}
}

// A transient Listmonk failure is returned so the outbox retries, and the
// retry converges without a second audience subscription.
func TestAListmonkOutageIsRetriedNotDropped(t *testing.T) {
	h := newSignupHarness(t, harnessForm{optIn: OptInSingle, settings: map[string]any{"targetListId": 7}})
	h.engine.AddList(7, "Launch", "single")
	h.mapList(7)
	h.engine.FailNext(http.MethodPost, "/api/subscribers", http.StatusBadGateway)

	h.post(body(consentedBody, "retry@example.com"))
	if err := h.tryDrain(); err == nil {
		t.Fatal("a Listmonk outage was swallowed; the event would never be retried")
	}
	h.drain()
	engineSub, ok := h.engine.Subscriber("retry@example.com")
	if !ok || engineSub.Lists[7] != listmonkv6.SubscriptionConfirmed {
		t.Fatalf("after the retry Listmonk holds %+v, want list 7 confirmed", engineSub)
	}
}
