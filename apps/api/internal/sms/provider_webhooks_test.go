package sms

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

func TestPublicProviderCallbacksAreSourceHeldBeforeBodyOrSideEffects(t *testing.T) {
	var mirrorCalls, notifyCalls int
	d := &Deps{
		Mirror: func(context.Context, string, string, string, string) { mirrorCalls++ },
		Notify: func(context.Context, string, InboundNotice) { notifyCalls++ },
	}
	tests := []struct {
		name    string
		handler http.HandlerFunc
	}{
		{name: "twilio inbound", handler: d.TwilioInbound},
		{name: "twilio status", handler: d.TwilioStatus},
		{name: "telnyx", handler: d.TelnyxWebhook},
		{name: "bandwidth", handler: d.BandwidthWebhook},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/api/public/sms/provider/tenant", strings.NewReader(`{"poison":"must not be read"}`))
			rec := httptest.NewRecorder()
			tc.handler(rec, req)
			if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "sms_provider_callback_release_held") {
				t.Fatalf("response = %d %s", rec.Code, rec.Body.String())
			}
		})
	}
	if mirrorCalls != 0 || notifyCalls != 0 {
		t.Fatalf("release-held callbacks invoked mirror=%d notify=%d", mirrorCalls, notifyCalls)
	}
}

func TestMountedPublicSMSCallbacksArePrivateNoStoreOnReleaseHold(t *testing.T) {
	router := chi.NewRouter()
	(&Deps{}).MountPublicRoutes(router)
	for _, path := range []string{
		"/api/public/sms/twilio/00000000-0000-4000-8000-000000000001",
		"/api/public/sms/twilio/00000000-0000-4000-8000-000000000001/status",
		"/api/public/sms/telnyx/00000000-0000-4000-8000-000000000001",
		"/api/public/sms/telnyx/00000000-0000-4000-8000-000000000001/status",
		"/api/public/sms/bandwidth/00000000-0000-4000-8000-000000000001",
		"/api/public/sms/bandwidth/00000000-0000-4000-8000-000000000001/status",
	} {
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{"ignored":true}`))
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Cache-Control") != "private, no-store, max-age=0" ||
			rec.Header().Get("Pragma") != "no-cache" || rec.Header().Get("X-Content-Type-Options") != "nosniff" ||
			rec.Header().Get("ETag") != "" {
			t.Fatalf("%s response=%d headers=%v body=%s", path, rec.Code, rec.Header(), rec.Body.String())
		}
	}
}

func TestParseTelnyxWebhookInboundAndFinalized(t *testing.T) {
	inbound, err := parseTelnyxWebhook([]byte(`{
		"data": {
			"event_type": "message.received",
			"id": "evt-1",
			"occurred_at": "2026-05-12T10:00:00Z",
			"payload": {
				"id": "msg-1",
				"from": {"phone_number": "+14155551212"},
				"to": [{"phone_number": "+14155550100", "status": "webhook_delivered"}],
				"text": "STOP",
				"media": []
			}
		}
	}`))
	if err != nil {
		t.Fatal(err)
	}
	if inbound.Provider != ProviderTelnyx || inbound.Direction != "inbound" || inbound.From != "+14155551212" || inbound.Body != "STOP" {
		t.Fatalf("bad inbound event: %+v", inbound)
	}
	metadata, err := json.Marshal(inbound.Metadata)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"+14155551212", "+14155550100", "STOP", "occurred_at"} {
		if strings.Contains(string(metadata), forbidden) {
			t.Fatalf("provider evidence retained webhook payload value %q: %s", forbidden, metadata)
		}
	}

	finalized, err := parseTelnyxWebhook([]byte(`{
		"data": {
			"event_type": "message.finalized",
			"id": "evt-2",
			"payload": {
				"id": "msg-2",
				"to": [{"phone_number": "+14155551212", "status": "delivery_failed"}],
				"errors": [{"code": "40001", "detail": "carrier rejected"}]
			}
		}
	}`))
	if err != nil {
		t.Fatal(err)
	}
	if finalized.Direction != "outbound" || finalized.Status != "failed" || finalized.ErrorCode != "40001" {
		t.Fatalf("bad finalized event: %+v", finalized)
	}

	ignored, err := parseTelnyxWebhook([]byte(`{"data":{"event_type":"message.updated","id":"evt-3","payload":{"id":"msg-3"}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if ignored.Direction != "ignored" {
		t.Fatalf("expected unsupported Telnyx event to be ignored: %+v", ignored)
	}
}

func TestInboundProviderEvidenceIsBoundedAllowlist(t *testing.T) {
	got := inboundProviderEvidence(ProviderTwilio, map[string]any{
		"Body":                  "secret body",
		"From":                  "+14155551212",
		"To":                    "+14155550100",
		"AccountSid":            "AC-secret",
		"Authorization":         "Bearer secret-token",
		"provider_event_id":     "evt-123",
		"provider_event_type":   "message.received",
		"provider_opt_out_type": "stop",
		"provider_media_count":  "2",
		"arbitrary_future_key":  strings.Repeat("x", 100_000),
	})
	want := map[string]any{
		"provider_event_id":     "evt-123",
		"provider_event_type":   "message.received",
		"provider_opt_out_type": "STOP",
		"provider_media_count":  2,
	}
	gotJSON, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	wantJSON, err := json.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	if string(gotJSON) != string(wantJSON) {
		t.Fatalf("provider evidence = %s, want %s", gotJSON, wantJSON)
	}
	for _, forbidden := range []string{"secret body", "+14155551212", "AC-secret", "secret-token", "arbitrary_future_key"} {
		if strings.Contains(string(gotJSON), forbidden) {
			t.Fatalf("provider evidence contains %q: %s", forbidden, gotJSON)
		}
	}
}

func TestWriteTwimlReplyOmitsInternalMessageID(t *testing.T) {
	recorder := httptest.NewRecorder()
	writeTwimlReply(recorder, "Reply STOP to unsubscribe.")
	body := recorder.Body.String()
	if strings.Contains(body, "00000000-0000-4000-8000-000000000001") || strings.Contains(body, "<!--") {
		t.Fatalf("TwiML exposed internal correlation data: %s", body)
	}
	if body != `<Response><Message>Reply STOP to unsubscribe.</Message></Response>` {
		t.Fatalf("unexpected TwiML: %s", body)
	}
}

func TestParseBandwidthWebhooks(t *testing.T) {
	events, err := parseBandwidthWebhooks([]byte(`[
		{
			"type": "message-received",
			"time": "2026-05-12T10:00:00Z",
			"message": {
				"id": "bw-in",
				"direction": "in",
				"to": ["+14155550100"],
				"from": "+14155551212",
				"text": "HELP"
			}
		},
		{
			"type": "message-failed",
			"description": "carrier rejected",
			"errorCode": 9902,
			"message": {
				"id": "bw-out",
				"direction": "out",
				"to": ["+14155551212"],
				"from": "+14155550100"
			}
		}
	]`))
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 {
		t.Fatalf("events len = %d", len(events))
	}
	if events[0].Provider != ProviderBandwidth || events[0].Direction != "inbound" || events[0].Body != "HELP" {
		t.Fatalf("bad inbound event: %+v", events[0])
	}
	if events[1].Direction != "outbound" || events[1].Status != "failed" || events[1].ErrorCode != "9902" {
		t.Fatalf("bad failed event: %+v", events[1])
	}
}

func TestParseBandwidthWebhooksRejectsTooManyCallbacks(t *testing.T) {
	var b strings.Builder
	b.WriteByte('[')
	for i := 0; i < maxBandwidthWebhookEvents+1; i++ {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(`{"type":"message-sent","message":{"id":"bw-out","direction":"out","to":["+14155551212"],"from":"+14155550100"}}`)
	}
	b.WriteByte(']')

	events, err := parseBandwidthWebhooks([]byte(b.String()))
	if err == nil {
		t.Fatal("expected too many callbacks error")
	}
	if events != nil {
		t.Fatalf("events = %d, want nil", len(events))
	}
}

func TestPlanProviderAutoReplyTelnyxUsesSenderProfile(t *testing.T) {
	plan := planProviderAutoReply(
		normalizedProviderWebhook{
			Provider:          ProviderTelnyx,
			EventID:           "evt-1",
			EventType:         "message.received",
			From:              "+14155551212",
			To:                "+14155550100",
			ProviderMessageID: "msg-in",
			SenderProfileID:   "sender-query",
		},
		InboundAutoReply{
			Matched: true,
			Keyword: "SAVE10",
			Action:  KeywordActionReplyOnly,
			Body:    "Use SAVE10 today.",
		},
		Message{ID: "inbound-row"},
		&SenderProfile{
			ID:                  "sender-row",
			Provider:            ProviderTelnyx,
			PhoneNumber:         "+14155550999",
			MessagingServiceSID: "profile-123",
		},
		"https://example.com/api/public/sms/telnyx/t1/status?sender_profile_id=sender-query",
	)

	if !plan.Dispatch {
		t.Fatal("expected Telnyx keyword auto-reply to dispatch")
	}
	if plan.Outbound.Provider != ProviderTelnyx || plan.Outbound.To != "+14155551212" || plan.Outbound.FromNumber != "+14155550999" || plan.Outbound.MessagingServiceSID != "profile-123" {
		t.Fatalf("bad outbound: %+v", plan.Outbound)
	}
	if plan.Record.SenderProfileID != "sender-row" || plan.Record.Body != "Use SAVE10 today." {
		t.Fatalf("bad record input: %+v", plan.Record)
	}
	if got := plan.Record.Metadata["source"]; got != "keyword_auto_reply" {
		t.Fatalf("metadata source = %v", got)
	}
	if got := plan.Record.Metadata["keyword"]; got != "SAVE10" {
		t.Fatalf("metadata keyword = %v", got)
	}
}

func TestPlanProviderAutoReplyFallbackAndGuards(t *testing.T) {
	reply := InboundAutoReply{Matched: true, Keyword: "JOIN", Action: KeywordActionReplyOnly, Body: "Welcome."}

	fallback := planProviderAutoReply(
		normalizedProviderWebhook{Provider: ProviderBandwidth, From: "+14155551212", To: "+14155550100"},
		reply,
		Message{ID: "inbound-row"},
		nil,
		"",
	)
	if !fallback.Dispatch {
		t.Fatal("expected Bandwidth keyword auto-reply to dispatch without sender profile")
	}
	if fallback.Outbound.FromNumber != "+14155550100" || fallback.Outbound.Provider != ProviderBandwidth {
		t.Fatalf("bad fallback outbound: %+v", fallback.Outbound)
	}

	if plan := planProviderAutoReply(
		normalizedProviderWebhook{Provider: ProviderTwilio, From: "+14155551212", To: "+14155550100"},
		reply,
		Message{},
		nil,
		"",
	); plan.Dispatch {
		t.Fatal("Twilio auto-replies should stay on the TwiML path")
	}
	if plan := planProviderAutoReply(
		normalizedProviderWebhook{Provider: ProviderTelnyx, From: "+14155551212", To: "+14155550100"},
		InboundAutoReply{Matched: true, Body: ""},
		Message{},
		nil,
		"",
	); plan.Dispatch {
		t.Fatal("empty auto-reply body should not dispatch")
	}
	if plan := planProviderAutoReply(
		normalizedProviderWebhook{Provider: ProviderTelnyx, From: "+14155551212", To: "+14155550100"},
		reply,
		Message{},
		&SenderProfile{ID: "sender-paused", Metadata: map[string]any{"paused": true}},
		"",
	); plan.Dispatch {
		t.Fatal("paused sender should not auto-reply")
	}
}

func TestCustomProviderAutoReplyDispatchIsStructurallyHeld(t *testing.T) {
	provider := &countingWebhookProvider{}
	deps := &Deps{Provider: provider}
	for _, name := range []string{ProviderTwilio, ProviderTelnyx, ProviderBandwidth} {
		err := deps.sendProviderAutoReply(context.Background(), "tenant", normalizedProviderWebhook{
			Provider: name,
			From:     "+14155551212",
			To:       "+14155550100",
		}, Message{ID: "inbound-message"}, InboundAutoReply{
			Matched: true,
			Keyword: "DEAL",
			Action:  KeywordActionReplyOnly,
			Body:    "Promotional body",
		})
		if err != nil {
			t.Fatalf("%s held auto-reply returned error: %v", name, err)
		}
	}
	if provider.calls != 0 {
		t.Fatalf("held custom auto-reply called provider %d times", provider.calls)
	}
	recorder := httptest.NewRecorder()
	writeTwiml(recorder, "message")
	if recorder.Body.String() != `<Response></Response>` {
		t.Fatalf("custom keyword produced TwiML dispatch: %s", recorder.Body.String())
	}
	helpRecorder := httptest.NewRecorder()
	writeTwiml(helpRecorder, ConsentHelpRequested)
	if helpRecorder.Body.String() != `<Response></Response>` {
		t.Fatalf("release-held HELP produced TwiML dispatch: %s", helpRecorder.Body.String())
	}
}

func TestNormalizeProviderStatuses(t *testing.T) {
	cases := map[string]string{
		"message-delivered":    "delivered",
		"message-sent":         "sent",
		"message-failed":       "failed",
		"delivery_failed":      "failed",
		"delivery_unconfirmed": "undelivered",
		"accepted":             "accepted",
		"scheduled":            "scheduled",
		"read":                 "read",
		"partially_delivered":  "partially_delivered",
		"cancelled":            "canceled",
	}
	for in, want := range cases {
		if got := normalizeStatus(in); got != want {
			t.Fatalf("normalizeStatus(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestClassifyTelnyxStatusUsesCanonicalDeliveryStates(t *testing.T) {
	cases := map[string]string{
		"delivered":            "delivered",
		"delivery_failed":      "failed",
		"delivery_unconfirmed": "undelivered",
	}
	for in, want := range cases {
		got, ok := classifyProviderDeliveryStatus(in)
		if !ok || got != want {
			t.Fatalf("classifyProviderDeliveryStatus(%q) = %q,%v, want %q,true", in, got, ok, want)
		}
	}
	for _, raw := range []string{"", "provider-invented-state"} {
		if got, ok := classifyProviderDeliveryStatus(raw); ok || got != "" {
			t.Fatalf("unknown status %q classified as %q,%v", raw, got, ok)
		}
	}
}

func TestReadProviderWebhookBodyRejectsOversizedPayload(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/public/sms/telnyx/t1",
		strings.NewReader(strings.Repeat("x", int(smsProviderWebhookMaxBodyBytes)+1)))
	req.Header.Set("Content-Type", "application/json")

	body, err := readProviderWebhookBody(req, smsProviderWebhookMaxBodyBytes)

	if err == nil || !errors.Is(err, errSMSProviderWebhookBodyTooLarge) {
		t.Fatalf("err = %v, want errSMSProviderWebhookBodyTooLarge", err)
	}
	if body != nil {
		t.Fatalf("body = %d bytes, want nil", len(body))
	}
}

func TestApplyProviderWebhookRequiresStableInboundIdentity(t *testing.T) {
	d := &Deps{}
	req := httptest.NewRequest(http.MethodPost, "/api/public/sms/telnyx/tenant", nil)
	err := d.applyProviderWebhook(req, "tenant", normalizedProviderWebhook{
		Provider:  ProviderTelnyx,
		Direction: "inbound",
		From:      "+15551230001",
		Body:      "hello",
	})
	if !errors.Is(err, errSMSProviderReplayIdentityMissing) {
		t.Fatalf("missing identity error = %v, want errSMSProviderReplayIdentityMissing", err)
	}
}

func TestValidTelnyxRequestEd25519(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	body := []byte(`{"data":{"event_type":"message.received"}}`)
	timestamp := "1778594400"
	msg := append([]byte(timestamp+"|"), body...)
	signature := base64.StdEncoding.EncodeToString(ed25519.Sign(priv, msg))
	now := time.Unix(1778594400, 0)
	if !validTelnyxRequest(hex.EncodeToString(pub), timestamp, body, signature, now) {
		t.Fatal("expected valid Telnyx signature")
	}
	if validTelnyxRequest(hex.EncodeToString(pub), timestamp, body, "bad", now) {
		t.Fatal("expected bad Telnyx signature to fail")
	}
	if validTelnyxRequest(hex.EncodeToString(pub), timestamp, body, signature, now.Add(10*time.Minute)) {
		t.Fatal("expected stale Telnyx signature to fail")
	}
}

func TestProviderWebhooksFailClosedInProductionWithoutCredentials(t *testing.T) {
	t.Setenv("POSTWAVE_ENV", "production")
	t.Setenv("POSTWAVE_ALLOW_UNSIGNED_SMS_WEBHOOKS", "")
	t.Setenv("TELNYX_PUBLIC_KEY", "")
	t.Setenv("BANDWIDTH_WEBHOOK_TOKEN", "")
	t.Setenv("BANDWIDTH_WEBHOOK_USERNAME", "")
	t.Setenv("BANDWIDTH_WEBHOOK_PASSWORD", "")
	t.Setenv("TWILIO_WEBHOOK_AUTH_TOKEN", "")

	req := httptest.NewRequest(http.MethodPost, "/api/public/sms/bandwidth/t1", nil)
	if validTelnyxRequest("", "", []byte(`{}`), "", time.Now()) {
		t.Fatal("unsigned Telnyx request accepted in production")
	}
	if validBandwidthRequest(req) {
		t.Fatal("unsigned Bandwidth request accepted in production")
	}
	if (&Deps{}).validTwilioRequest(req) {
		t.Fatal("unsigned Twilio request accepted in production")
	}
}

func TestValidBandwidthRequestCredentials(t *testing.T) {
	t.Setenv("POSTWAVE_ENV", "production")
	t.Setenv("POSTWAVE_ALLOW_UNSIGNED_SMS_WEBHOOKS", "")
	t.Setenv("BANDWIDTH_WEBHOOK_TOKEN", "bandwidth-token")
	t.Setenv("BANDWIDTH_WEBHOOK_USERNAME", "")
	t.Setenv("BANDWIDTH_WEBHOOK_PASSWORD", "")

	req := httptest.NewRequest(http.MethodPost, "/api/public/sms/bandwidth/t1", nil)
	req.Header.Set("X-Postwave-Webhook-Token", "bandwidth-token")
	if !validBandwidthRequest(req) {
		t.Fatal("expected configured Bandwidth token to be accepted")
	}

	req = httptest.NewRequest(http.MethodPost, "/api/public/sms/bandwidth/t1?token=bad", nil)
	if validBandwidthRequest(req) {
		t.Fatal("expected bad Bandwidth token to be rejected")
	}
	req = httptest.NewRequest(http.MethodPost, "/api/public/sms/bandwidth/t1?token=bandwidth-token", nil)
	if validBandwidthRequest(req) {
		t.Fatal("query-string Bandwidth credentials must never be accepted or logged")
	}

	t.Setenv("BANDWIDTH_WEBHOOK_TOKEN", "")
	t.Setenv("BANDWIDTH_WEBHOOK_USERNAME", "bandwidth-user")
	t.Setenv("BANDWIDTH_WEBHOOK_PASSWORD", "bandwidth-pass")

	req = httptest.NewRequest(http.MethodPost, "/api/public/sms/bandwidth/t1", nil)
	req.SetBasicAuth("bandwidth-user", "bandwidth-pass")
	if !validBandwidthRequest(req) {
		t.Fatal("expected configured Bandwidth basic auth to be accepted")
	}

	req = httptest.NewRequest(http.MethodPost, "/api/public/sms/bandwidth/t1", nil)
	req.SetBasicAuth("bandwidth-user", "wrong")
	if validBandwidthRequest(req) {
		t.Fatal("expected bad Bandwidth basic auth to be rejected")
	}
}

type countingWebhookProvider struct{ calls int }

func (p *countingWebhookProvider) Send(context.Context, ProviderOutbound) (ProviderResult, error) {
	p.calls++
	return ProviderResult{Provider: ProviderTelnyx, MessageID: "should-not-send"}, nil
}

func TestValidBandwidthRequestSupportsBoundedTokenRotation(t *testing.T) {
	t.Setenv("POSTWAVE_ENV", "production")
	t.Setenv("POSTWAVE_ALLOW_UNSIGNED_SMS_WEBHOOKS", "")
	t.Setenv("BANDWIDTH_WEBHOOK_TOKEN", "new-primary-token")
	t.Setenv("BANDWIDTH_WEBHOOK_TOKEN_SECONDARY", "old-grace-token")
	t.Setenv("BANDWIDTH_WEBHOOK_USERNAME", "")
	t.Setenv("BANDWIDTH_WEBHOOK_PASSWORD", "")

	requestWith := func(token string) *http.Request {
		req := httptest.NewRequest(http.MethodPost, "/api/public/sms/bandwidth/t1", nil)
		req.Header.Set("X-Postwave-Webhook-Token", token)
		return req
	}
	if !validBandwidthRequest(requestWith("new-primary-token")) {
		t.Fatal("new primary token rejected during rotation")
	}
	if !validBandwidthRequest(requestWith("old-grace-token")) {
		t.Fatal("bounded secondary token rejected during rotation")
	}
	if validBandwidthRequest(requestWith("unrelated-token")) {
		t.Fatal("unrelated token accepted during rotation")
	}

	// Clearing the secondary ends the grace window immediately.
	t.Setenv("BANDWIDTH_WEBHOOK_TOKEN_SECONDARY", "")
	if validBandwidthRequest(requestWith("old-grace-token")) {
		t.Fatal("retired secondary token remained valid after grace removal")
	}
}

func TestProviderWebhooksRejectExplicitUnsignedBypassInProduction(t *testing.T) {
	t.Setenv("POSTWAVE_ENV", "production")
	t.Setenv("POSTWAVE_ALLOW_UNSIGNED_SMS_WEBHOOKS", "true")
	t.Setenv("BANDWIDTH_WEBHOOK_TOKEN", "")
	t.Setenv("BANDWIDTH_WEBHOOK_USERNAME", "")
	t.Setenv("BANDWIDTH_WEBHOOK_PASSWORD", "")

	req := httptest.NewRequest(http.MethodPost, "/api/public/sms/bandwidth/t1", nil)
	if validTelnyxRequest("", "", []byte(`{}`), "", time.Now()) {
		t.Fatal("production accepted unsigned Telnyx webhook")
	}
	if validBandwidthRequest(req) {
		t.Fatal("production accepted unsigned Bandwidth webhook")
	}
	if err := ValidateProviderWebhookSecurityConfig(nil); err == nil {
		t.Fatal("production startup validation accepted unsigned webhook bypass")
	}
}

func TestProviderWebhooksAllowExplicitUnsignedLocalBypass(t *testing.T) {
	t.Setenv("POSTWAVE_ENV", "development")
	t.Setenv("APP_ENV", "")
	t.Setenv("GO_ENV", "")
	t.Setenv("ENVIRONMENT", "")
	t.Setenv("NODE_ENV", "")
	t.Setenv("POSTWAVE_ALLOW_UNSIGNED_SMS_WEBHOOKS", "true")
	t.Setenv("BANDWIDTH_WEBHOOK_TOKEN", "")
	t.Setenv("BANDWIDTH_WEBHOOK_USERNAME", "")
	t.Setenv("BANDWIDTH_WEBHOOK_PASSWORD", "")

	req := httptest.NewRequest(http.MethodPost, "/api/public/sms/bandwidth/t1", nil)
	if !validTelnyxRequest("", "", []byte(`{}`), "", time.Now()) {
		t.Fatal("explicit local unsigned Telnyx bypass was ignored")
	}
	if !validBandwidthRequest(req) {
		t.Fatal("explicit local unsigned Bandwidth bypass was ignored")
	}
	if err := ValidateProviderWebhookSecurityConfig(nil); err != nil {
		t.Fatalf("local startup validation rejected explicit bypass: %v", err)
	}
}

func TestProviderWebhooksUnsignedBypassFailsClosedWithoutEnvironment(t *testing.T) {
	for _, key := range []string{"POSTWAVE_ENV", "APP_ENV", "GO_ENV", "ENVIRONMENT", "NODE_ENV"} {
		t.Setenv(key, "")
	}
	t.Setenv("POSTWAVE_ALLOW_UNSIGNED_SMS_WEBHOOKS", "1")
	if allowUnsignedProviderWebhooks() {
		t.Fatal("unspecified runtime accepted unsigned provider webhooks")
	}
}
