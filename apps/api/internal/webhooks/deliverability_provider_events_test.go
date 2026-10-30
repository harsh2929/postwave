// SPDX-License-Identifier: AGPL-3.0-only
package webhooks

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func providerPayload(t *testing.T, raw string) map[string]any {
	t.Helper()
	var payload map[string]any
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&payload); err != nil {
		t.Fatalf("decode provider payload: %v", err)
	}
	return payload
}

func TestProviderDeliveryClassifiersSeparateEventAndMessageIdentity(t *testing.T) {
	tests := []struct {
		name        string
		outcome     classifyOutcome
		wantMessage string
		wantEvent   string
		wantEmail   string
	}{
		{
			name: "postmark",
			outcome: classifyPostmark(postmarkPayload{
				RecordType: "Delivery", MessageID: "pm-message-1",
				Recipient: "pm@example.test", DeliveredAt: "2026-09-07T10:00:00Z",
			}, nil, "pm-event-1"),
			wantMessage: "pm-message-1", wantEvent: "pm-event-1", wantEmail: "pm@example.test",
		},
		{
			name: "sendgrid",
			outcome: classifySendGrid(providerPayload(t, `{
				"event":"delivered","email":"sg@example.test",
				"sg_message_id":"sg-message-1","sg_event_id":"sg-event-1",
				"timestamp":1788775200
			}`), nil),
			wantMessage: "sg-message-1", wantEvent: "sg-event-1", wantEmail: "sg@example.test",
		},
		{
			name: "resend",
			outcome: classifyResend(providerPayload(t, `{
				"type":"email.delivered","id":"rs-event-1",
				"created_at":"2026-09-07T10:00:00Z",
				"data":{"email_id":"rs-message-1","to":["rs@example.test"]}
			}`), nil),
			wantMessage: "rs-message-1", wantEvent: "rs-event-1", wantEmail: "rs@example.test",
		},
		{
			name: "sparkpost",
			outcome: classifySparkPost(providerPayload(t, `{
				"type":"delivery","rcpt_to":"sp@example.test",
				"message_id":"sp-message-1","transmission_id":"sp-transmission-1",
				"event_id":"sp-event-1","timestamp":"2026-09-07T10:00:00.000Z"
			}`), nil),
			wantMessage: "sp-message-1", wantEvent: "sp-event-1", wantEmail: "sp@example.test",
		},
		{
			name: "mailersend v2",
			outcome: classifyMailerSend(providerPayload(t, `{
				"type":"activity.delivered","created_at":"2026-09-07 10:00:00.000000Z",
				"data":{"id":"ms-event-1","message_id":"ms-message-1","email":"ms@example.test"}
			}`), nil),
			wantMessage: "ms-message-1", wantEvent: "ms-event-1", wantEmail: "ms@example.test",
		},
	}

	var mailgun mailgunPayload
	mailgun.EventData.Event = "delivered"
	mailgun.EventData.ID = "mg-event-1"
	mailgun.EventData.Recipient = "mg@example.test"
	mailgun.EventData.Message.Headers.MessageID = "mg-message-1"
	mailgun.EventData.Timestamp = 1788775200
	tests = append(tests, struct {
		name        string
		outcome     classifyOutcome
		wantMessage string
		wantEvent   string
		wantEmail   string
	}{
		name: "mailgun", outcome: classifyMailgun(mailgun, nil),
		wantMessage: "mg-message-1", wantEvent: "mg-event-1", wantEmail: "mg@example.test",
	})

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if test.outcome.EventType != "delivered" {
				t.Fatalf("event type = %q, want delivered", test.outcome.EventType)
			}
			if test.outcome.MessageID != test.wantMessage {
				t.Errorf("message identity = %q, want %q", test.outcome.MessageID, test.wantMessage)
			}
			if test.outcome.ProviderID != test.wantEvent {
				t.Errorf("event identity = %q, want %q", test.outcome.ProviderID, test.wantEvent)
			}
			if test.outcome.Email != test.wantEmail {
				t.Errorf("recipient = %q, want %q", test.outcome.Email, test.wantEmail)
			}
			if test.outcome.OccurredAt.IsZero() {
				t.Error("provider occurrence time was discarded")
			}
		})
	}
}

func TestSESDeliveryClassificationIsRecipientScopedAndReplayStable(t *testing.T) {
	var msg sesMessage
	msg.Mail.MessageID = "ses-message-1"
	msg.Mail.Destination = []string{"fallback@example.test"}
	msg.Delivery.Recipients = []string{
		" First@Example.test ", "first@example.test", "second@example.test",
	}
	msg.Delivery.Timestamp = "2026-09-07T10:00:00.125Z"
	msg.Delivery.SMTPResponse = "250 2.0.0 accepted"
	env := snsEnvelope{MessageID: "sns-event-1"}

	first := classifySESDeliveries(env, msg, "")
	retry := classifySESDeliveries(env, msg, "")
	if len(first) != 2 || len(retry) != 2 {
		t.Fatalf("classified recipients = %d/%d, want 2/2", len(first), len(retry))
	}
	for i := range first {
		if first[i].EventType != "delivered" || first[i].MessageID != "ses-message-1" {
			t.Fatalf("delivery %d = %+v", i, first[i])
		}
		if first[i].ProviderID != retry[i].ProviderID {
			t.Fatalf("retry changed event identity: %q != %q", first[i].ProviderID, retry[i].ProviderID)
		}
		if first[i].DeliveredAt == nil || first[i].OccurredAt.IsZero() {
			t.Errorf("delivery %d lost its delivery time", i)
		}
	}
	if first[0].ProviderID == first[1].ProviderID {
		t.Fatal("two recipients in one SES notification shared a dedup identity")
	}
}

func TestSESEngagementRequiresOneSignedRecipientAndKeepsClassifierEvidence(t *testing.T) {
	var msg sesMessage
	msg.EventType = "Click"
	msg.Mail.MessageID = "ses-message-1"
	msg.Mail.Destination = []string{" Reader@Example.test ", "reader@example.test"}
	msg.Click.Timestamp = "2026-09-07T10:00:00.125Z"
	msg.Click.Link = "https://example.test/private/path"
	msg.Click.UserAgent = "MailboxProxy/1.0"
	msg.Click.IPAddress = "192.0.2.30"
	env := snsEnvelope{MessageID: "sns-event-1"}

	ev, ok := classifySESEngagement(env, msg, "")
	if !ok {
		t.Fatal("case-only duplicate recipient should remain unambiguous")
	}
	if ev.EventType != "clicked" || ev.Email != "Reader@Example.test" ||
		ev.MessageID != "ses-message-1" || ev.ProviderID == "" {
		t.Fatalf("SES click identity lost: %+v", ev)
	}
	if ev.LinkIdentity != "https://example.test/private/path" ||
		ev.UserAgent != "MailboxProxy/1.0" || ev.IP != "192.0.2.30" ||
		ev.OccurredAt.IsZero() {
		t.Fatalf("SES classifier evidence lost: %+v", ev)
	}

	msg.Mail.Destination = append(msg.Mail.Destination, "other@example.test")
	if _, ok := classifySESEngagement(env, msg, ""); ok {
		t.Fatal("multi-recipient engagement must not be attributed to every destination")
	}
}

func TestResendUsesSvixMessageIDAsWebhookIdentity(t *testing.T) {
	payload := providerPayload(t, `{"type":"email.delivered","data":{"email_id":"email-1"}}`)
	if got := resendEventID(payload, " msg_svix_1 "); got != "msg_svix_1" {
		t.Fatalf("resend event identity = %q, want Svix id", got)
	}
	payload["id"] = "body-event-1"
	if got := resendEventID(payload, "msg_svix_1"); got != "body-event-1" {
		t.Fatalf("compatible body event identity = %q, want body-event-1", got)
	}
}

func TestMessageLevelDeliveryExpandsRecipientsButEngagementDoesNot(t *testing.T) {
	delivery := classifyOutcome{
		EventType: "delivered", ProviderID: "provider-event-1",
		Recipients: []string{" First@Example.test ", "first@example.test", "second@example.test"},
	}
	first, ok := recipientScopedProviderOutcomes(delivery)
	retry, retryOK := recipientScopedProviderOutcomes(delivery)
	if !ok || !retryOK || len(first) != 2 || len(retry) != 2 {
		t.Fatalf("delivery expansion = %d/%d ok=%v/%v, want 2/2 true/true",
			len(first), len(retry), ok, retryOK)
	}
	if first[0].ProviderID == first[1].ProviderID {
		t.Fatal("multi-recipient delivery facts share one replay identity")
	}
	for i := range first {
		if first[i].ProviderID != retry[i].ProviderID {
			t.Fatalf("recipient %d replay identity changed", i)
		}
		if len(first[i].Recipients) != 0 {
			t.Fatalf("recipient %d retained message-wide recipient list", i)
		}
	}

	engagement := delivery
	engagement.EventType = "opened"
	if events, ok := recipientScopedProviderOutcomes(engagement); ok || events != nil {
		t.Fatalf("ambiguous engagement expanded to %#v", events)
	}
}

func TestResendAmbiguousEngagementIsAnalyticsOnlyAndTerminalOutcomeIsRejected(t *testing.T) {
	for _, test := range []struct {
		name       string
		eventType  string
		wantStatus int
		wantBody   string
	}{
		{name: "raw open", eventType: "email.opened", wantStatus: http.StatusOK, wantBody: "recipient_ambiguous"},
		{name: "bounce", eventType: "email.bounced", wantStatus: http.StatusBadRequest, wantBody: "provider_recipient_ambiguous"},
	} {
		t.Run(test.name, func(t *testing.T) {
			body := `{"type":"` + test.eventType + `","id":"event-1","data":{` +
				`"email_id":"message-1","to":["first@example.test","second@example.test"]}}`
			req := httptest.NewRequest(http.MethodPost, "/deliverability/resend", strings.NewReader(body))
			req.Header.Set(providerTokenHeader, "secret")
			recorder := httptest.NewRecorder()
			(&DeliverabilityDeps{ResendToken: "secret"}).HandleResend(recorder, req)
			if recorder.Code != test.wantStatus || !strings.Contains(recorder.Body.String(), test.wantBody) {
				t.Fatalf("response = %d %s", recorder.Code, recorder.Body.String())
			}
		})
	}
}

func TestSparkPostTransmissionIsNotTreatedAsOneMessage(t *testing.T) {
	payload := providerPayload(t, `{
		"type":"delivery","transmission_id":"batch-containing-many-messages",
		"event_id":"event-1","rcpt_to":"one@example.test"
	}`)
	if got := sparkPostMessageID(payload); got != "" {
		t.Fatalf("message identity = %q; a transmission may contain many messages", got)
	}
	if got := classifySparkPost(payload, nil).MessageID; got != "" {
		t.Fatalf("classifier correlated transmission as message %q", got)
	}
}

func TestEngagementParsersPreserveClassifiableEvidence(t *testing.T) {
	sendGrid := classifySendGrid(providerPayload(t, `{
		"event":"open","email":"reader@example.test","sg_message_id":"message-1",
		"sg_event_id":"event-1","timestamp":1788775200,
		"useragent":"MailboxProxy/1.0","ip":"192.0.2.10","sg_machine_open":true
	}`), nil)
	if sendGrid.UserAgent != "MailboxProxy/1.0" || sendGrid.IP != "192.0.2.10" ||
		sendGrid.ProviderSignals["sg_machine_open"] != true {
		t.Fatalf("SendGrid machine-open evidence lost: %+v", sendGrid)
	}

	resend := classifyResend(providerPayload(t, `{
		"type":"email.clicked","created_at":"2026-09-07T10:00:01Z",
		"data":{"email_id":"message-2","to":["reader@example.test"],"click":{
			"link":"https://example.test/private/path","timestamp":"2026-09-07T10:00:00Z",
			"userAgent":"Browser/1.0","ipAddress":"192.0.2.20"
		}}
	}`), nil)
	if resend.LinkIdentity != "https://example.test/private/path" ||
		resend.UserAgent != "Browser/1.0" || resend.IP != "192.0.2.20" {
		t.Fatalf("Resend click evidence lost: %+v", resend)
	}
	wantAt, _ := time.Parse(time.RFC3339, "2026-09-07T10:00:00Z")
	if !resend.OccurredAt.Equal(wantAt) {
		t.Fatalf("click occurrence = %v, want event-specific %v", resend.OccurredAt, wantAt)
	}
}

func TestOpenedAndClickedNeverBecomeTransactionalMailboxOutcomes(t *testing.T) {
	for _, eventType := range []string{"opened", "clicked", "unsubscribed"} {
		if got := transactionalOutcomeFor(classifyOutcome{EventType: eventType}); got != "" {
			t.Errorf("%s mapped to transactional outcome %q", eventType, got)
		}
	}
	for _, test := range []struct {
		eventType   string
		bounceClass string
		want        string
	}{
		{"delivered", "", "delivered"},
		{"complained", "", "complained"},
		{"bounced", "hard", "bounced"},
		{"bounced", "soft", "deferred"},
	} {
		if got := transactionalOutcomeFor(classifyOutcome{
			EventType: test.eventType, BounceClass: test.bounceClass,
		}); got != test.want {
			t.Errorf("%s/%s = %q, want %q", test.eventType, test.bounceClass, got, test.want)
		}
	}
}

func TestUnresolvedMailboxOutcomeIsRetryableButRawEngagementIsNot(t *testing.T) {
	for _, eventType := range []string{"delivered", "bounced", "complained"} {
		if !providerCorrelationNeedsRetry(classifyOutcome{
			EventType: eventType, MessageID: "provider-message-1",
			BounceClass: "hard",
		}) {
			t.Errorf("%s with a provider message id was not retryable", eventType)
		}
	}
	for _, ev := range []classifyOutcome{
		{EventType: "opened", MessageID: "provider-message-1"},
		{EventType: "clicked", MessageID: "provider-message-1"},
		{EventType: "delivered"},
	} {
		if providerCorrelationNeedsRetry(ev) {
			t.Errorf("event %+v was incorrectly treated as retryable correlation", ev)
		}
	}
	recorder := httptest.NewRecorder()
	writeRetryableProviderCorrelation(recorder)
	if recorder.Code != http.StatusServiceUnavailable || recorder.Header().Get("Retry-After") == "" {
		t.Fatalf("retry response status/header = %d/%q", recorder.Code, recorder.Header().Get("Retry-After"))
	}
	missing := httptest.NewRecorder()
	if !rejectDeliveryWithoutMessageID(missing, classifyOutcome{EventType: "delivered"}) ||
		missing.Code != http.StatusBadRequest {
		t.Fatalf("missing delivery identity status = %d", missing.Code)
	}
	if rejectDeliveryWithoutMessageID(httptest.NewRecorder(), classifyOutcome{EventType: "opened"}) {
		t.Fatal("raw open was subjected to terminal-delivery identity validation")
	}
}

func TestDerivedProviderEventIDIsStableWithoutLeakingRecipientOrLink(t *testing.T) {
	ev := classifyOutcome{
		Email: "Private.Person@Example.test", EventType: "clicked",
		MessageID: "provider-message-1", ProviderName: "postmark",
		OccurredAt:   time.Date(2026, 9, 7, 10, 0, 0, 123, time.UTC),
		LinkIdentity: "https://example.test/private/account/42",
	}
	retry := ev
	ensureProviderEventID(&ev)
	ensureProviderEventID(&retry)
	if ev.ProviderID == "" || ev.ProviderID != retry.ProviderID {
		t.Fatalf("derived replay ids = %q/%q", ev.ProviderID, retry.ProviderID)
	}
	if strings.Contains(strings.ToLower(ev.ProviderID), "private") ||
		strings.Contains(ev.ProviderID, "account") {
		t.Fatalf("derived id leaked direct identity: %q", ev.ProviderID)
	}
}
