package sms

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestNormalizePhoneUSCA(t *testing.T) {
	got, err := NormalizePhoneUSCA("(415) 555-1212")
	if err != nil {
		t.Fatal(err)
	}
	if got != "+14155551212" {
		t.Fatalf("unexpected phone: %s", got)
	}
	if _, err := NormalizePhoneUSCA("+442071838750"); err == nil {
		t.Fatal("expected non-US/Canada number to fail for launch scope")
	}
	for _, invalid := range []string{"+10155551212", "+11155551212", "0155551212", "1155551212", "+14150551212", "+14151551212"} {
		if _, err := NormalizePhoneUSCA(invalid); err == nil {
			t.Fatalf("expected invalid NANP area code to fail: %q", invalid)
		}
	}
	for _, spoof := range []string{
		"evil4155551212", "+ +14155551212", "+1+4155551212",
		"+14155551212\u202e", "４１５５５５１２１２", "+14155551212\n",
	} {
		if _, err := NormalizePhoneUSCA(spoof); err == nil {
			t.Fatalf("expected spoofed phone %q to fail", spoof)
		}
	}
}

func TestProviderRouterConfiguredForSenderRequiresCredentialsAndSenderIdentity(t *testing.T) {
	sender := SenderProfile{Provider: ProviderTwilio, PhoneNumber: "+14155551212"}
	empty := &ProviderRouter{Default: ProviderTwilio, Providers: map[string]Provider{
		ProviderTwilio: &TwilioProvider{},
	}}
	if empty.ConfiguredForSender(sender) {
		t.Fatal("non-nil empty router must not advertise dispatch readiness")
	}
	configured := &ProviderRouter{Default: ProviderTwilio, Providers: map[string]Provider{
		ProviderTwilio: &TwilioProvider{AccountSID: "AC_test", AuthToken: "secret"},
	}}
	if !configured.ConfiguredForSender(sender) {
		t.Fatal("credentialed router with selected sender origin should be ready")
	}
	sender.Provider = ProviderTelnyx
	if configured.ConfiguredForSender(sender) {
		t.Fatal("credentials for a different provider must not authorize the selected sender")
	}
}

func TestLegacyDispatchReplayBypassSelectsOnlyHeldEffects(t *testing.T) {
	tests := []struct {
		method string
		path   string
		want   bool
	}{
		{http.MethodPost, "/api/v1/sms/test-send", true},
		{http.MethodPost, "/api/v1/sms/campaigns/11111111-1111-4111-8111-111111111111/send", true},
		{http.MethodPost, "/api/v1/sms/campaigns/11111111-1111-4111-8111-111111111111/retry-failed", true},
		{http.MethodPost, "/api/v1/sms/broadcasts/11111111-1111-4111-8111-111111111111/send", true},
		{http.MethodGet, "/api/v1/sms/test-send", false},
		{http.MethodPost, "/api/v1/sms/campaigns/id/send/extra", false},
	}
	for _, test := range tests {
		req := httptest.NewRequest(test.method, test.path, nil)
		if got := LegacyDispatchReplayBypass(req, nil); got != test.want {
			t.Fatalf("%s %s bypass=%v want %v", test.method, test.path, got, test.want)
		}
	}
}

func TestClassifyInboundKeywords(t *testing.T) {
	cases := map[string]string{
		"STOP":                ConsentRevoked,
		"stop":                ConsentRevoked,
		"QUIT":                ConsentRevoked,
		"REVOKE":              ConsentRevoked,
		"OPTOUT":              ConsentRevoked,
		"START":               ConsentGranted,
		"UNSTOP":              ConsentGranted,
		"HELP":                ConsentHelpRequested,
		"unsubscribe now":     "message",
		"STOP PLEASE":         "message",
		"STOP!":               "message",
		"please stop texting": "message",
		"unstoppable":         "message",
		"thanks for this":     "message",
		"STOP\u2003PLEASE":    "message",
		"":                    "message",
	}
	for body, want := range cases {
		if got := ClassifyInbound(body); got != want {
			t.Fatalf("ClassifyInbound(%q)=%q want %q", body, got, want)
		}
	}
}

func TestSegmentCountUsesSMSCodeUnits(t *testing.T) {
	tests := []struct {
		name string
		body string
		want int
	}{
		{name: "gsm single", body: strings.Repeat("a", 160), want: 1},
		{name: "gsm concatenated", body: strings.Repeat("a", 161), want: 2},
		{name: "gsm extension consumes two", body: strings.Repeat("^", 81), want: 2},
		{name: "ucs2 single", body: strings.Repeat("界", 70), want: 1},
		{name: "ucs2 concatenated", body: strings.Repeat("界", 71), want: 2},
		{name: "astral consumes surrogate pair", body: strings.Repeat("😀", 36), want: 2},
		{name: "crlf are gsm units", body: strings.Repeat("\r\n", 80), want: 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := SegmentCount(tt.body); got != tt.want {
				t.Fatalf("SegmentCount()=%d want %d", got, tt.want)
			}
		})
	}
}

func TestDeliveryStatusTransitionIsMonotonic(t *testing.T) {
	tests := []struct {
		from, to string
		want     bool
	}{
		{"queued", "sent", true},
		{"accepted", "queued", true},
		{"queued", "accepted", false},
		{"sent", "delivered", true},
		{"delivered", "read", true},
		{"delivered", "queued", false},
		{"delivered", "failed", false},
		{"failed", "queued", false},
		{"failed", "delivered", false},
		{"sent", "queued", false},
		{"delivered", "delivered", true},
	}
	for _, tt := range tests {
		if got := deliveryStatusTransitionAllowed(tt.from, tt.to); got != tt.want {
			t.Errorf("%s -> %s allowed=%v want %v", tt.from, tt.to, got, tt.want)
		}
	}
}

func TestInboxProjectionSanitizesProviderCodes(t *testing.T) {
	if got := safeInboxProviderCode(" 30007 "); got != "30007" {
		t.Fatalf("safe code=%q", got)
	}
	for _, poison := range []string{"secret=abc", "30007\u202e", strings.Repeat("a", 65), "+14155551212 body"} {
		if got := safeInboxProviderCode(poison); got != "" {
			t.Errorf("poison %q projected as %q", poison, got)
		}
	}
}

func TestEscapeInboxSearchTreatsWildcardsLiterally(t *testing.T) {
	if got, want := escapeInboxSearch(`50%_off\today`), `50\%\_off\\today`; got != want {
		t.Fatalf("escaped search=%q want %q", got, want)
	}
}

func TestEvaluateGate(t *testing.T) {
	ok := EvaluateGate(GateSnapshot{
		RegistrationStatus:   RegistrationApproved,
		SubscriptionStatus:   SubscriptionOptedIn,
		TenantLimitRemaining: -1,
		Body:                 "Launch at 9.",
	})
	if !ok.Allowed || ok.Segments != 1 {
		t.Fatalf("expected allowed gate, got %+v", ok)
	}
	blocked := EvaluateGate(GateSnapshot{
		RegistrationStatus:   RegistrationApproved,
		SubscriptionStatus:   SubscriptionOptedIn,
		Suppressed:           true,
		TenantLimitRemaining: -1,
		Body:                 "Launch at 9.",
	})
	if blocked.Allowed || blocked.Reason != "recipient_suppressed" {
		t.Fatalf("expected suppression block, got %+v", blocked)
	}
}

func TestQuietHoursActiveOvernight(t *testing.T) {
	meta := map[string]any{"quiet_hours": map[string]any{
		"timezone": "America/New_York",
		"start":    "20:00",
		"end":      "08:00",
	}}
	now := time.Date(2026, 5, 12, 2, 30, 0, 0, time.FixedZone("UTC", 0))
	if !QuietHoursActive(now, meta) {
		t.Fatal("expected 22:30 New York to be inside quiet hours")
	}
	later := time.Date(2026, 5, 12, 15, 0, 0, 0, time.FixedZone("UTC", 0))
	if QuietHoursActive(later, meta) {
		t.Fatal("expected 11:00 New York outside quiet hours")
	}
}

func TestValidateSenderInputAcceptsAndNormalizesQuietHours(t *testing.T) {
	input := SenderInput{
		Provider:            "TWILIO",
		Country:             "us",
		SenderType:          "10DLC",
		PhoneNumber:         "(415) 555-1212",
		RegistrationStatus:  "approved",
		MessagingServiceSID: "  MG123  ",
		Metadata: map[string]any{"quiet_hours": map[string]any{
			"timezone": " America/New_York ",
			"start":    " 20:00 ",
			"end":      " 08:00 ",
		}},
	}

	if err := validateSenderInput(&input); err != nil {
		t.Fatalf("validateSenderInput: %v", err)
	}
	if input.Provider != ProviderTwilio || input.Country != "US" || input.SenderType != "10dlc" {
		t.Fatalf("input not normalized: %+v", input)
	}
	if input.PhoneNumber != "+14155551212" || input.MessagingServiceSID != "MG123" {
		t.Fatalf("sender identity not normalized: %+v", input)
	}
	qh, ok := input.Metadata["quiet_hours"].(map[string]any)
	if !ok {
		t.Fatalf("quiet_hours missing after validation: %#v", input.Metadata)
	}
	if qh["timezone"] != "America/New_York" || qh["start"] != "20:00" || qh["end"] != "08:00" {
		t.Fatalf("quiet hours not normalized: %#v", qh)
	}
}

func TestValidateSenderInputRejectsBadQuietHours(t *testing.T) {
	cases := []map[string]any{
		{"quiet_hours": "20:00-08:00"},
		{"quiet_hours": map[string]any{"timezone": "Mars/Base", "start": "20:00", "end": "08:00"}},
		{"quiet_hours": map[string]any{"timezone": "America/New_York", "start": "8pm", "end": "08:00"}},
		{"quiet_hours": map[string]any{"timezone": "America/New_York", "start": "20:00"}},
	}
	for _, metadata := range cases {
		t.Run(stringFromAny(metadata["quiet_hours"]), func(t *testing.T) {
			input := SenderInput{
				Provider:            ProviderTwilio,
				Country:             "US",
				SenderType:          "10dlc",
				MessagingServiceSID: "MG123",
				RegistrationStatus:  RegistrationPending,
				Metadata:            metadata,
			}
			if err := validateSenderInput(&input); err == nil {
				t.Fatalf("expected validation error")
			}
		})
	}
}

func TestValidateSenderInputRejectsCallerControlledCapabilityAndMetadata(t *testing.T) {
	base := SenderInput{PhoneNumber: "+14155551212"}
	withCapability := base
	withCapability.Capabilities = map[string]any{"send": true}
	if err := validateSenderInput(&withCapability); err == nil || !strings.Contains(err.Error(), "provider-derived") {
		t.Fatalf("capability validation error = %v", err)
	}
	withSecret := base
	withSecret.Metadata = map[string]any{"api_key": "secret-canary"}
	if err := validateSenderInput(&withSecret); err == nil || !strings.Contains(err.Error(), "unsupported sender metadata") {
		t.Fatalf("metadata validation error = %v", err)
	}
}

func TestSenderMetadataProjectionDropsUnknownAndSensitiveHistoricalKeys(t *testing.T) {
	projected, err := decodeSenderMetadataProjection([]byte(`{
  "api_key":"secret-canary",
  "customer_address":"private-canary",
  "twilio_brand_registration":{"ein":"12-3456789"},
  "quiet_hours":{"timezone":"America/New_York","start":"20:00","end":"08:00"},
  "sending":{"paused":true,"pause_reason":"private-canary","messages_per_second":4}
}`))
	if err != nil {
		t.Fatalf("decode sender projection: %v", err)
	}
	encoded, err := json.Marshal(projected)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"secret-canary", "private-canary", "12-3456789", "api_key", "customer_address", "brand_registration", "pause_reason", "messages_per_second"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("sender projection leaked %q: %s", forbidden, encoded)
		}
	}
	if !truthyAny(mapFromAny(projected["sending"])["paused"]) {
		t.Fatalf("server pause state was not retained: %s", encoded)
	}
}

func TestCreateListRejectsOversizedBody(t *testing.T) {
	deps := &Deps{}
	body := `{"name":"` + strings.Repeat("x", int(smsJSONMaxBodyBytes)) + `"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/sms/lists", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant_test"}))
	rec := httptest.NewRecorder()

	deps.CreateList(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "payload_too_large") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestPublicSMSClickIsReleaseHeldBeforeTokenLookupForAllMethods(t *testing.T) {
	router := chi.NewRouter()
	(&Deps{}).MountPublicRoutes(router)
	const token = "super-secret-click-token-123456"
	for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodDelete} {
		req := httptest.NewRequest(method, "/api/public/sms/click/"+token, nil)
		req.RemoteAddr = "203.0.113.42:1234"
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, req)
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("%s status=%d body=%s", method, recorder.Code, recorder.Body.String())
		}
		if recorder.Header().Get("Cache-Control") != "private, no-store, max-age=0" || recorder.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Fatalf("%s missing private response headers: %v", method, recorder.Header())
		}
		if strings.Contains(recorder.Body.String(), token) || strings.Contains(recorder.Body.String(), "203.0.113.42") {
			t.Fatalf("%s held response leaked token/IP: %s", method, recorder.Body.String())
		}
	}
}

func TestValidateTwilioSignature(t *testing.T) {
	values := url.Values{"Body": {"HELP"}, "From": {"+14155551212"}, "MessageSid": {"SM123"}}
	requestURL := "https://api.example.com/api/public/sms/twilio/tenant"
	token := "super-secret"
	payload := requestURL + "BodyHELP" + "From+14155551212" + "MessageSidSM123"
	mac := hmac.New(sha1.New, []byte(token))
	_, _ = mac.Write([]byte(payload))
	signature := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	if !ValidateTwilioSignature(token, requestURL, values, signature) {
		t.Fatal("expected signature to validate")
	}
	if ValidateTwilioSignature(token, requestURL, values, "bad") {
		t.Fatal("expected bad signature to fail")
	}
}

func TestTwilioSignatureUsesPublicBaseAndExactRequestURI(t *testing.T) {
	token := "super-secret"
	form := url.Values{"Body": {"HELP"}, "From": {"+14155551212"}, "MessageSid": {"SM123"}}
	req := httptest.NewRequest(
		http.MethodPost,
		"http://internal.local/api/public/sms/twilio/tenant?sender_profile_id=sender%2B1&retry=1",
		strings.NewReader(form.Encode()),
	)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	deps := &Deps{PublicBaseURL: "https://hooks.example.com/base/", TwilioAuthToken: token}
	if err := req.ParseForm(); err != nil {
		t.Fatal(err)
	}
	signedURL := deps.webhookURL(req)
	if signedURL != "https://hooks.example.com/base/api/public/sms/twilio/tenant?sender_profile_id=sender%2B1&retry=1" {
		t.Fatalf("webhookURL = %q", signedURL)
	}
	payload := signedURL + "BodyHELP" + "From+14155551212" + "MessageSidSM123"
	mac := hmac.New(sha1.New, []byte(token))
	_, _ = mac.Write([]byte(payload))
	req.Header.Set("X-Twilio-Signature", base64.StdEncoding.EncodeToString(mac.Sum(nil)))
	if !deps.validTwilioRequest(req) {
		t.Fatal("expected exact public URL signature to validate")
	}

	req.URL.RawQuery = ""
	if deps.validTwilioRequest(req) {
		t.Fatal("signature validated after removing signed query string")
	}
}

func TestTwilioInboundReleaseHoldPrecedesBodyAndSignature(t *testing.T) {
	deps := &Deps{TwilioAuthToken: "secret"}
	r := chi.NewRouter()
	r.Post("/api/public/sms/twilio/{tenant_id}", deps.TwilioInbound)
	body := url.Values{
		"Body":       {strings.Repeat("x", int(smsWebhookMaxBodyBytes))},
		"From":       {"+14155551212"},
		"MessageSid": {"SM123"},
	}.Encode()
	req := httptest.NewRequest(http.MethodPost, "/api/public/sms/twilio/tenant_test", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "sms_provider_callback_release_held") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestPublicBaseURLFallsBackToSharedEnv(t *testing.T) {
	t.Setenv("POSTWAVE_PUBLIC_BASE_URL", "")
	t.Setenv("PUBLIC_BASE_URL", "https://app.example.com/")

	deps := &Deps{}
	if got := deps.publicBaseURL(); got != "https://app.example.com" {
		t.Fatalf("publicBaseURL = %q", got)
	}
	worker := &Worker{}
	if got := worker.publicBaseURL(); got != "https://app.example.com" {
		t.Fatalf("worker publicBaseURL = %q", got)
	}
}

func TestPublicBaseURLRejectsUnsafeConfig(t *testing.T) {
	for _, raw := range []string{
		"http://app.example.com",
		"https://user:pass@app.example.com",
		"https://app.example.com?tenant=one",
		"https://app.example.com#fragment",
		"https://app.example.com/%0d%0aLocation:%20https://evil.example",
		"javascript:alert(1)",
	} {
		if got := normalizePublicBaseURL(raw); got != "" {
			t.Fatalf("normalizePublicBaseURL(%q) = %q, want empty", raw, got)
		}
	}
	if got := normalizePublicBaseURL("http://127.0.0.1:8080/base/"); got != "http://127.0.0.1:8080/base" {
		t.Fatalf("localhost public base should be allowed for dev, got %q", got)
	}
}

func TestProviderURLPreservesBasePathAndRejectsUnsafeConfig(t *testing.T) {
	got, err := providerURL("https://sms.example.com/proxy/", "/v2/messages?limit=1")
	if err != nil {
		t.Fatal(err)
	}
	if got != "https://sms.example.com/proxy/v2/messages?limit=1" {
		t.Fatalf("providerURL = %q", got)
	}

	for _, base := range []string{
		"https://user:pass@sms.example.com",
		"https://sms.example.com?tenant=one",
		"https://sms.example.com#fragment",
		"file:///tmp/sms",
	} {
		if _, err := providerURL(base, "/v2/messages"); err == nil {
			t.Fatalf("expected unsafe base %q to fail", base)
		}
	}
	if _, err := providerURL("https://sms.example.com", "/../messages"); err == nil {
		t.Fatal("expected path traversal to fail")
	}
}

func TestTwilioProviderSend(t *testing.T) {
	var gotForm url.Values
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		user, pass, ok := r.BasicAuth()
		if !ok || user != "AC123" || pass != "secret" {
			t.Fatalf("bad auth user=%q ok=%v", user, ok)
		}
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		gotForm = r.PostForm
		_ = json.NewEncoder(w).Encode(map[string]any{"sid": "SM123", "status": "queued", "price": "-0.0075"})
	}))
	defer srv.Close()

	provider := &TwilioProvider{
		AccountSID:        "AC123",
		AuthToken:         "secret",
		DefaultServiceSID: "MG123",
		BaseURL:           srv.URL + "/twilio/",
		HTTPClient:        srv.Client(),
	}
	result, err := provider.Send(context.Background(), ProviderOutbound{To: "+14155551212", Body: "Hello"})
	if err != nil {
		t.Fatal(err)
	}
	if result.MessageID != "SM123" || result.Status != "queued" {
		t.Fatalf("unexpected result %+v", result)
	}
	if result.PriceMicros != 7500 {
		t.Fatalf("expected positive metered cost, got %d", result.PriceMicros)
	}
	if gotPath != "/twilio/2010-04-01/Accounts/AC123/Messages.json" {
		t.Fatalf("bad path: %s", gotPath)
	}
	if gotForm.Get("MessagingServiceSid") != "MG123" || gotForm.Get("To") != "+14155551212" || gotForm.Get("Body") != "Hello" {
		t.Fatalf("bad form: %s", strings.ReplaceAll(gotForm.Encode(), "&", " "))
	}
}

func TestTwilioProviderSendCapsSuccessResponseBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("{", int(smsProviderMaxResponseBytes)+1)))
	}))
	defer srv.Close()

	provider := &TwilioProvider{
		AccountSID:        "AC123",
		AuthToken:         "secret",
		DefaultFromNumber: "+14155550100",
		BaseURL:           srv.URL,
		HTTPClient:        srv.Client(),
	}
	_, err := provider.Send(context.Background(), ProviderOutbound{To: "+14155551212", FromNumber: "+14155550100", Body: "Hello"})
	if err == nil || err.Error() != "twilio send failed (http 200, code response_read)" {
		t.Fatalf("Send err = %v, want classified response-read failure", err)
	}
}

func TestProviderRetryAfterHeaderPropagatesToSendResult(t *testing.T) {
	t.Run("twilio", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Retry-After", "90")
			w.WriteHeader(http.StatusTooManyRequests)
			_ = json.NewEncoder(w).Encode(map[string]any{"code": 20429, "message": "Too many requests"})
		}))
		defer srv.Close()
		provider := &TwilioProvider{AccountSID: "AC123", AuthToken: "secret", DefaultFromNumber: "+14155550100", BaseURL: srv.URL, HTTPClient: srv.Client()}
		result, err := provider.Send(context.Background(), ProviderOutbound{To: "+14155551212", Body: "Hello"})
		if err == nil {
			t.Fatal("expected Twilio send error")
		}
		if result.RetryAfter != 90*time.Second {
			t.Fatalf("RetryAfter = %s, want 90s", result.RetryAfter)
		}
	})

	t.Run("telnyx", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Retry-After", "75")
			w.WriteHeader(http.StatusTooManyRequests)
			_ = json.NewEncoder(w).Encode(map[string]any{"errors": []any{map[string]any{"code": "rate_limited", "detail": "slow down"}}})
		}))
		defer srv.Close()
		provider := &TelnyxProvider{APIKey: "key_test", DefaultFromNumber: "+14155550100", BaseURL: srv.URL, HTTPClient: srv.Client()}
		result, err := provider.Send(context.Background(), ProviderOutbound{To: "+14155551212", Body: "Hello"})
		if err == nil {
			t.Fatal("expected Telnyx send error")
		}
		if result.RetryAfter != 75*time.Second {
			t.Fatalf("RetryAfter = %s, want 75s", result.RetryAfter)
		}
	})

	t.Run("bandwidth", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Retry-After", "60")
			w.WriteHeader(http.StatusTooManyRequests)
			_ = json.NewEncoder(w).Encode(map[string]any{"code": "rate_limited", "message": "slow down"})
		}))
		defer srv.Close()
		provider := &BandwidthProvider{
			AccountID:            "acct",
			Username:             "api-user",
			Password:             "api-pass",
			DefaultFromNumber:    "+14155550100",
			DefaultApplicationID: "93de2206-9669-4e07-948d-329f4b722ee2",
			BaseURL:              srv.URL,
			HTTPClient:           srv.Client(),
		}
		result, err := provider.Send(context.Background(), ProviderOutbound{To: "+14155551212", Body: "Hello"})
		if err == nil {
			t.Fatal("expected Bandwidth send error")
		}
		if result.RetryAfter != 60*time.Second {
			t.Fatalf("RetryAfter = %s, want 60s", result.RetryAfter)
		}
	})
}

func TestTelnyxProviderSend(t *testing.T) {
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer key_test" {
			t.Fatalf("bad authorization header")
		}
		if r.URL.Path != "/v2/messages" {
			t.Fatalf("bad path: %s", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": map[string]any{
				"id":   "40385f64",
				"to":   []any{map[string]any{"status": "queued"}},
				"cost": map[string]any{"amount": "0.0051"},
			},
		})
	}))
	defer srv.Close()

	provider := &TelnyxProvider{
		APIKey:     "key_test",
		BaseURL:    srv.URL,
		HTTPClient: srv.Client(),
	}
	result, err := provider.Send(context.Background(), ProviderOutbound{
		Provider:            ProviderTelnyx,
		To:                  "+14155551212",
		Body:                "Hello",
		MessagingServiceSID: "4000eba1-a0c0-4563-9925-b25e842a7cb6",
		StatusCallbackURL:   "https://example.com/sms/status",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Provider != ProviderTelnyx || result.MessageID != "40385f64" || result.Status != "queued" {
		t.Fatalf("unexpected result %+v", result)
	}
	if result.PriceMicros != 5100 {
		t.Fatalf("expected Telnyx cost in micros, got %d", result.PriceMicros)
	}
	if got["messaging_profile_id"] != "4000eba1-a0c0-4563-9925-b25e842a7cb6" || got["webhook_url"] != "https://example.com/sms/status" {
		t.Fatalf("bad payload: %#v", got)
	}
}

func TestTelnyxProviderSendCapsSuccessResponseBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("{", int(smsProviderMaxResponseBytes)+1)))
	}))
	defer srv.Close()

	provider := &TelnyxProvider{APIKey: "key_test", DefaultFromNumber: "+14155550100", BaseURL: srv.URL, HTTPClient: srv.Client()}
	_, err := provider.Send(context.Background(), ProviderOutbound{To: "+14155551212", Body: "Hello"})
	if err == nil || err.Error() != "telnyx request failed (http 200, code response_read)" {
		t.Fatalf("Send err = %v, want classified response-read failure", err)
	}
}

func TestBandwidthProviderSend(t *testing.T) {
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, pass, ok := r.BasicAuth()
		if !ok || user != "api-user" || pass != "api-pass" {
			t.Fatalf("bad auth user=%q ok=%v", user, ok)
		}
		if r.URL.Path != "/api/v2/users/acct/messages" {
			t.Fatalf("bad path: %s", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "14762070468292", "segmentCount": 1})
	}))
	defer srv.Close()

	provider := &BandwidthProvider{
		AccountID:            "acct",
		Username:             "api-user",
		Password:             "api-pass",
		DefaultFromNumber:    "+14155550100",
		DefaultApplicationID: "93de2206-9669-4e07-948d-329f4b722ee2",
		BaseURL:              srv.URL,
		HTTPClient:           srv.Client(),
	}
	result, err := provider.Send(context.Background(), ProviderOutbound{
		Provider:            ProviderBandwidth,
		To:                  "+14155551212",
		FromNumber:          "+14155550100",
		MessagingServiceSID: "93de2206-9669-4e07-948d-329f4b722ee2",
		Body:                "Hello",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Provider != ProviderBandwidth || result.MessageID != "14762070468292" || result.Status != "accepted" {
		t.Fatalf("unexpected result %+v", result)
	}
	if got["from"] != "+14155550100" || got["applicationId"] != "93de2206-9669-4e07-948d-329f4b722ee2" {
		t.Fatalf("bad payload: %#v", got)
	}
	to, _ := got["to"].([]any)
	if len(to) != 1 || to[0] != "+14155551212" {
		t.Fatalf("bad recipients: %#v", got["to"])
	}
}

func TestBandwidthProviderSendCapsSuccessResponseBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(strings.Repeat("{", int(smsProviderMaxResponseBytes)+1)))
	}))
	defer srv.Close()

	provider := &BandwidthProvider{
		AccountID:  "acct",
		Username:   "api-user",
		Password:   "api-pass",
		BaseURL:    srv.URL,
		HTTPClient: srv.Client(),
	}
	_, err := provider.Send(context.Background(), ProviderOutbound{
		To:                  "+14155551212",
		FromNumber:          "+14155550100",
		MessagingServiceSID: "93de2206-9669-4e07-948d-329f4b722ee2",
		Body:                "Hello",
	})
	if err == nil || err.Error() != "bandwidth send failed (http 202, code response_read)" {
		t.Fatalf("Send err = %v, want classified response-read failure", err)
	}
}

func TestProviderRouterSelectsProvider(t *testing.T) {
	router := &ProviderRouter{
		Default: ProviderTwilio,
		Providers: map[string]Provider{
			ProviderTelnyx: staticProvider{provider: ProviderTelnyx},
		},
	}
	result, err := router.Send(context.Background(), ProviderOutbound{Provider: ProviderTelnyx})
	if err != nil {
		t.Fatal(err)
	}
	if result.Provider != ProviderTelnyx || result.MessageID != "ok" {
		t.Fatalf("unexpected routed result %+v", result)
	}
	if _, err := router.Send(context.Background(), ProviderOutbound{Provider: ProviderBandwidth}); err == nil {
		t.Fatal("expected unconfigured provider error")
	}

	router.Providers[ProviderTwilio] = panicProvider{}
	result, err = router.Send(context.Background(), ProviderOutbound{Provider: ProviderTwilio})
	if err == nil {
		t.Fatal("expected provider panic through router to become an error")
	}
	if result.Provider != ProviderTwilio || result.ErrorCode != "provider_panic" {
		t.Fatalf("unexpected routed panic result %+v", result)
	}
}

func TestSafeProviderSendRecoversPanic(t *testing.T) {
	result, err := safeProviderSend(context.Background(), panicProvider{}, ProviderOutbound{Provider: ProviderTwilio})
	if err == nil {
		t.Fatal("expected provider panic to become an error")
	}
	if result.Provider != ProviderTwilio || result.ErrorCode != "provider_panic" {
		t.Fatalf("unexpected recovered result: %+v", result)
	}
	if strings.Contains(err.Error(), "boom") || err.Error() != "sms provider call failed" {
		t.Fatalf("provider panic detail must be sanitized, got %v", err)
	}
}

func TestSafeProviderSendRemovesProviderPayloadBeforeLogging(t *testing.T) {
	result, err := safeProviderSend(context.Background(), leakyProvider{}, ProviderOutbound{Provider: ProviderTelnyx})
	if err == nil || err.Error() != "sms provider call failed" {
		t.Fatalf("classified err = %v", err)
	}
	if result.Raw != nil || result.ErrorCode != "E123" || result.ErrorMessage != "SMS provider request failed (code E123)." {
		t.Fatalf("provider result was not minimized: %#v", result)
	}
	var output bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&output, nil))
	logger.Warn("sms provider send failed", "provider", result.Provider, "code", result.ErrorCode, "err", err.Error())
	for _, secret := range []string{"+14155551212", "customer body", "Bearer provider-secret"} {
		if strings.Contains(output.String(), secret) {
			t.Fatalf("provider payload leaked to log: %s", output.String())
		}
	}
}

func TestSanitizeProviderResultPreservesUnknownStatusForReconciliation(t *testing.T) {
	got := sanitizeProviderResult(ProviderResult{
		Provider:  ProviderTwilio,
		MessageID: "SM123",
		Status:    " Mystery_Status ",
	}, ProviderTwilio)
	if got.Status != "mystery_status" {
		t.Fatalf("status = %q, want unclassified provider token", got.Status)
	}
	if _, ok := classifyProviderDeliveryStatus(got.Status); ok {
		t.Fatalf("unknown provider status %q must require reconciliation", got.Status)
	}
}

func TestHistoricalBlankInboxBodiesProjectAsExplicitlyUnavailable(t *testing.T) {
	for _, raw := range []string{"", " \t\n", "\u00a0\u2003"} {
		summary := ConversationSummary{LastMessagePreview: raw}
		applyConversationPreviewContract(&summary)
		if summary.LastMessagePreview != "" || summary.LastMessagePreviewOmittedReason != "legacy_body_unavailable" {
			t.Fatalf("summary projection for %q = body %q reason %q", raw, summary.LastMessagePreview, summary.LastMessagePreviewOmittedReason)
		}

		message := Message{Body: raw}
		applyMessageBodyProjectionContract(&message)
		if message.Body != "" || message.BodyOmittedReason != "legacy_body_unavailable" {
			t.Fatalf("message projection for %q = body %q reason %q", raw, message.Body, message.BodyOmittedReason)
		}
	}
}

func TestOversizedInboxBodiesProjectAsExplicitlyUnavailable(t *testing.T) {
	raw := strings.Repeat("x", SMSInboxBodyMaxBytes+1)
	message := Message{Body: raw}
	applyMessageBodyProjectionContract(&message)
	if message.Body != "" || message.BodyOmittedReason != "body_exceeds_inbox_limit" {
		t.Fatalf("message projection = body bytes %d reason %q", len(message.Body), message.BodyOmittedReason)
	}
}

func TestSMSWorkerRunOnceNoopsWithoutStore(t *testing.T) {
	if err := (&Worker{}).RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce without store should noop, got %v", err)
	}
}

func TestSMSWorkerRunOnceSourceHoldPreventsDBAccess(t *testing.T) {
	// A nil DB pool would panic on the first discovery/claim query. Returning
	// nil proves the compile-time hold runs before worker identity and storage,
	// so enabling a dedicated identity cannot drain pre-hold queued rows.
	err := (&Worker{Store: &Store{SMSWorkerIdentityAvailable: true}}).RunOnce(context.Background())
	if err != nil {
		t.Fatalf("source-held worker should not access storage, got %v", err)
	}
}

func TestSafeSendScheduledCampaignIsReleaseHeldBeforeStoreOrProvider(t *testing.T) {
	_, err := (&Worker{}).safeSendScheduledCampaign(context.Background(), nil, Campaign{TenantID: "tenant", ID: "campaign"})
	if err == nil {
		t.Fatal("expected scheduled campaign dispatch hold")
	}
	if !strings.Contains(err.Error(), "dispatch release-held") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestCarrierSendDelayFromMetadata(t *testing.T) {
	if got := carrierSendDelay(nil); got != 0 {
		t.Fatalf("expected no delay, got %s", got)
	}
	if got := carrierSendDelay(map[string]any{"sending": map[string]any{"messages_per_second": "2"}}); got != 500*time.Millisecond {
		t.Fatalf("expected 500ms delay, got %s", got)
	}
	if got := carrierSendDelay(map[string]any{"carrier_mps": 200}); got != 10*time.Millisecond {
		t.Fatalf("expected cap at 100 mps, got %s", got)
	}
}

func TestProviderBackoffDelayClassifiesCarrierAndRecipientErrors(t *testing.T) {
	if got := providerBackoffDelay("21614", "not a mobile number", 5); got != 0 {
		t.Fatalf("recipient errors should not suspend sender, got %s", got)
	}
	if got := providerBackoffDelay("20429", "rate limited", 2); got != 2*time.Minute {
		t.Fatalf("expected rate-limit backoff, got %s", got)
	}
	if got := providerBackoffDelay("30007", "carrier filtering", 3); got != 90*time.Second {
		t.Fatalf("expected carrier filtering backoff, got %s", got)
	}
	if got := providerBackoffDelay("unknown", "temporary provider failure", 2); got != 0 {
		t.Fatalf("early unknown failures should not suspend sender, got %s", got)
	}
	if got := providerBackoffDelay("unknown", "temporary provider failure", 3); got != 90*time.Second {
		t.Fatalf("repeated unknown failures should back off, got %s", got)
	}
}

func TestStatusCallbackURLProviderSpecific(t *testing.T) {
	if got := statusCallbackURL("https://app.example/", ProviderTelnyx, "tenant", "sender"); got != "https://app.example/api/public/sms/telnyx/tenant/status" {
		t.Fatalf("bad Telnyx callback URL: %q", got)
	}
	got := statusCallbackURL("https://app.example/", ProviderTwilio, "tenant", "sender")
	if got != "https://app.example/api/public/sms/twilio/tenant/status" {
		t.Fatalf("bad callback URL: %q", got)
	}
	if got := statusCallbackURL("http://app.example/", ProviderTwilio, "tenant", "sender"); got != "" {
		t.Fatalf("unsafe callback base should fail closed, got %q", got)
	}
}

type staticProvider struct {
	provider string
}

func (p staticProvider) Send(context.Context, ProviderOutbound) (ProviderResult, error) {
	return ProviderResult{Provider: p.provider, MessageID: "ok", Status: "queued"}, nil
}

type panicProvider struct{}

func (panicProvider) Send(context.Context, ProviderOutbound) (ProviderResult, error) {
	panic("boom")
}

type leakyProvider struct{}

func (leakyProvider) Send(context.Context, ProviderOutbound) (ProviderResult, error) {
	return ProviderResult{
		Provider:     ProviderTelnyx,
		ErrorCode:    "E123",
		ErrorMessage: "recipient +14155551212 body customer body Bearer provider-secret",
		Raw: map[string]any{
			"authorization": "Bearer provider-secret",
			"to":            "+14155551212",
			"text":          "customer body",
		},
	}, errors.New("provider echoed +14155551212 customer body Bearer provider-secret")
}

func TestExtractAndRewriteLinks(t *testing.T) {
	body := "Open https://example.com/a, then https://example.com/b."
	links := ExtractLinks(body)
	if len(links) != 2 || links[0] != "https://example.com/a" || links[1] != "https://example.com/b" {
		t.Fatalf("unexpected links: %#v", links)
	}
	rewritten := RewriteLinks(body, map[string]string{
		"https://example.com/a": "https://p.test/api/public/sms/click/a",
	})
	if !strings.Contains(rewritten, "https://p.test/api/public/sms/click/a") {
		t.Fatalf("expected rewritten link: %s", rewritten)
	}
}

func TestSafeTrackedSMSLink(t *testing.T) {
	got, ok := safeTrackedSMSLink(" HTTPS://example.com/path?q=1#fragment ")
	if !ok {
		t.Fatal("expected valid tracked link")
	}
	if got != "https://example.com/path?q=1" {
		t.Fatalf("safeTrackedSMSLink normalized to %q", got)
	}
	for _, raw := range []string{
		"javascript:alert(1)",
		"https://user:pass@example.com/path",
		"https://example.com/%0d%0aLocation:%20https://evil.example",
		"https://example.com/\nLocation: https://evil.example",
		"mailto:team@example.com",
	} {
		if got, ok := safeTrackedSMSLink(raw); ok {
			t.Fatalf("safeTrackedSMSLink(%q) = %q, want rejection", raw, got)
		}
	}
}

func TestPublicClickURLRejectsUnsafeBase(t *testing.T) {
	if got := PublicClickURL("https://app.example.com/base/", "tok"); got != "https://app.example.com/base/api/public/sms/click/tok" {
		t.Fatalf("PublicClickURL valid base = %q", got)
	}
	if got := PublicClickURL("http://app.example.com", "tok"); got != "" {
		t.Fatalf("PublicClickURL unsafe base = %q, want empty", got)
	}
}
