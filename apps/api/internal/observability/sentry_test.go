package observability

import (
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/getsentry/sentry-go"
)

func TestEnvVarName(t *testing.T) {
	cases := map[string]string{
		"api":            "API",
		"voice":          "VOICE",
		"deliverability": "DELIVERABILITY",
		"migration":      "MIGRATION",
		"automation":     "AUTOMATION",
		"my-service":     "MY_SERVICE",
		" api ":          "API",
	}
	for in, want := range cases {
		if got := envVarName(in); got != want {
			t.Errorf("envVarName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestRedactSensitiveData_StripsAuthHeader(t *testing.T) {
	event := &sentry.Event{
		Request: &sentry.Request{
			Headers: map[string]string{
				"Authorization":    "Bearer sk_live_abc123",
				"Cookie":           "session=abc123",
				"X-Postwave-Token": "pwt_secret",
				"User-Agent":       "Moosewave/1.0",
				"Content-Type":     "application/json",
			},
		},
	}
	out := redactSensitiveData(event, nil)
	if out == nil {
		t.Fatal("redactSensitiveData returned nil")
	}
	if _, ok := out.Request.Headers["Authorization"]; ok {
		t.Error("Authorization header was not stripped")
	}
	if _, ok := out.Request.Headers["Cookie"]; ok {
		t.Error("Cookie header was not stripped")
	}
	if _, ok := out.Request.Headers["X-Postwave-Token"]; ok {
		t.Error("X-Postwave-Token header was not stripped")
	}
	if got := out.Request.Headers["User-Agent"]; got != "Moosewave/1.0" {
		t.Errorf("User-Agent should be preserved, got %q", got)
	}
	if got := out.Request.Headers["Content-Type"]; got != "application/json" {
		t.Errorf("Content-Type should be preserved, got %q", got)
	}
}

func TestRedactSensitiveData_StripsRequestBodyAndCookies(t *testing.T) {
	event := &sentry.Event{
		Request: &sentry.Request{
			Data:    `{"email":"alice@example.com","password":"hunter2"}`,
			Cookies: "session=abcdef; csrf=xyz",
		},
	}
	out := redactSensitiveData(event, nil)
	if out.Request.Data != "" {
		t.Errorf("Request.Data should be cleared, got %q", out.Request.Data)
	}
	if out.Request.Cookies != "" {
		t.Errorf("Request.Cookies should be cleared, got %q", out.Request.Cookies)
	}
}

func TestRedactSensitiveData_StripsSensitiveQueryParams(t *testing.T) {
	event := &sentry.Event{
		Request: &sentry.Request{
			URL: "https://api.moosewave.com/v1/things?api_key=sk_live_real&token=t1&secret=s1&cursor=payload.signature&keep=value",
		},
	}
	out := redactSensitiveData(event, nil)
	u, err := url.Parse(out.Request.URL)
	if err != nil {
		t.Fatalf("post-redact URL is malformed: %v", err)
	}
	q := u.Query()
	for _, k := range []string{"api_key", "token", "secret", "cursor"} {
		if got := q.Get(k); got != "[redacted]" {
			t.Errorf("query %s = %q, want [redacted]", k, got)
		}
	}
	if got := q.Get("keep"); got != "value" {
		t.Errorf("non-sensitive query param keep was modified: %q", got)
	}
	if !strings.HasPrefix(out.Request.URL, "https://api.moosewave.com/v1/things?") {
		t.Errorf("URL host/path should be preserved, got %q", out.Request.URL)
	}
}

func TestRedactSensitiveData_StripsPreferenceCapabilityPath(t *testing.T) {
	const token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	event := &sentry.Event{Request: &sentry.Request{
		URL: "https://api.moosewave.com/api/public/preferences/" + token + "/one-click?keep=value",
	}}
	out := redactSensitiveData(event, nil)
	if strings.Contains(out.Request.URL, token) {
		t.Fatalf("preference capability leaked in Sentry URL: %q", out.Request.URL)
	}
	u, err := url.Parse(out.Request.URL)
	if err != nil {
		t.Fatalf("post-redact URL is malformed: %v", err)
	}
	if u.Path != "/api/public/preferences/[redacted]/one-click" {
		t.Fatalf("redacted route shape=%q", u.Path)
	}
	if u.Query().Get("keep") != "value" {
		t.Fatalf("safe query changed: %q", u.RawQuery)
	}
}

func TestRedactSensitiveData_StripsPIIQueryParams(t *testing.T) {
	event := &sentry.Event{
		Request: &sentry.Request{
			URL: "https://api.moosewave.com/api/public/track/conversion?email=ada@example.com&recipient_email=bob@example.com&code=oauth&state=csrf&event=conversion",
		},
	}
	out := redactSensitiveData(event, nil)
	u, err := url.Parse(out.Request.URL)
	if err != nil {
		t.Fatalf("post-redact URL is malformed: %v", err)
	}
	q := u.Query()
	for _, k := range []string{"email", "recipient_email", "code", "state"} {
		if got := q.Get(k); got != "[redacted]" {
			t.Errorf("query %s = %q, want [redacted]", k, got)
		}
	}
	if got := q.Get("event"); got != "conversion" {
		t.Errorf("safe query event modified: %q", got)
	}
}

func TestRedactSensitiveData_NilSafe(t *testing.T) {
	if got := redactSensitiveData(nil, nil); got != nil {
		t.Errorf("redactSensitiveData(nil) = %v, want nil", got)
	}
	// Event without a Request must round-trip unchanged.
	e := &sentry.Event{Message: "boom"}
	if out := redactSensitiveData(e, nil); out != e {
		t.Errorf("redactSensitiveData should return same event when Request is nil")
	}
}

func TestInitSentry_NoDSNReturnsNoopFlush(t *testing.T) {
	t.Setenv("SENTRY_DSN_TESTSVC", "")
	flush := InitSentry("testsvc", "test")
	if flush == nil {
		t.Fatal("InitSentry returned nil flush func")
	}
	// Calling the no-op flush must not panic.
	flush()
}

func TestInitSentry_BadDSNReturnsNoopFlush(t *testing.T) {
	// A malformed DSN forces sentry.Init to error; the helper should
	// still return a usable flush func and never panic.
	prev := os.Getenv("SENTRY_DSN_TESTSVC2")
	t.Setenv("SENTRY_DSN_TESTSVC2", "not-a-valid-dsn")
	defer func() { _ = os.Setenv("SENTRY_DSN_TESTSVC2", prev) }()

	flush := InitSentry("testsvc2", "test")
	if flush == nil {
		t.Fatal("InitSentry returned nil flush func on bad DSN")
	}
	flush()
}

func TestSentryHTTPMiddleware_NotNil(t *testing.T) {
	mw := SentryHTTPMiddleware()
	if mw == nil {
		t.Fatal("SentryHTTPMiddleware returned nil")
	}
}
