package middleware

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRedactQueryRedactsCredentialNames(t *testing.T) {
	cases := []struct {
		raw              string
		mustHaveRedacted []string // sensitive keys whose values must be REDACTED
		mustHaveLiteral  []string // safe values that must survive
	}{
		{
			raw:              "token=abc123&status=draft",
			mustHaveRedacted: []string{"token"},
			mustHaveLiteral:  []string{"status=draft"},
		},
		{
			raw:              "ticket=one-time-bearer&status=pending",
			mustHaveRedacted: []string{"ticket"},
			mustHaveLiteral:  []string{"status=pending"},
		},
		{
			raw:              "X-Api-Key=secret&page=2",
			mustHaveRedacted: []string{"X-Api-Key"},
			mustHaveLiteral:  []string{"page=2"},
		},
		{
			raw:              "hmac=deadbeef&signature=abc&shop=foo.myshopify.com",
			mustHaveRedacted: []string{"hmac", "signature"},
			mustHaveLiteral:  []string{"shop=foo.myshopify.com"},
		},
		{
			raw:              "code=oauth_grant&state=xyz",
			mustHaveRedacted: []string{"code", "state"},
		},
		{
			raw:              "cursor=payload.signature&limit=25",
			mustHaveRedacted: []string{"cursor"},
			mustHaveLiteral:  []string{"limit=25"},
		},
		{
			raw:              "email=ada@example.com&recipient_email=bob@example.com&event=conversion",
			mustHaveRedacted: []string{"email", "recipient_email"},
			mustHaveLiteral:  []string{"event=conversion"},
		},
		{
			raw:             "limit=20&order=desc",
			mustHaveLiteral: []string{"limit=20", "order=desc"},
		},
	}

	for _, tc := range cases {
		got := redactQuery(tc.raw)
		for _, key := range tc.mustHaveRedacted {
			if !strings.Contains(got, key+"=%5BREDACTED%5D") &&
				!strings.Contains(got, strings.ToLower(key)+"=%5BREDACTED%5D") {
				t.Errorf("input %q: expected key %q value to be REDACTED, got %q", tc.raw, key, got)
			}
		}
		for _, lit := range tc.mustHaveLiteral {
			if !strings.Contains(got, lit) {
				t.Errorf("input %q: expected %q to survive redaction, got %q", tc.raw, lit, got)
			}
		}
	}
}

func TestRedactQueryEmptyAndMalformed(t *testing.T) {
	if redactQuery("") != "" {
		t.Errorf("empty query should round-trip empty")
	}
	// Malformed: a stray % is not a valid escape; net/url returns an error.
	got := redactQuery("token=abc&%zz")
	if got != "[unparseable]" {
		t.Errorf("malformed query should produce [unparseable], got %q", got)
	}
}

func TestRedactQueryOmitsSMSSearchDimensions(t *testing.T) {
	got := redactQuery("q=message+text&tag=vip&phone=%2B14155551212&limit=50&cursor=opaque")
	for _, secret := range []string{"message", "vip", "14155551212", "opaque"} {
		if strings.Contains(got, secret) {
			t.Fatalf("redacted query contains %q: %q", secret, got)
		}
	}
	if !strings.Contains(got, "limit=50") {
		t.Fatalf("safe limit was removed: %q", got)
	}
}

func TestSlogLoggerRedactsPreferenceCapabilityPath(t *testing.T) {
	t.Parallel()
	const token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	var output bytes.Buffer
	handler := SlogLogger(slog.New(slog.NewJSONHandler(&output, nil)))(
		http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		}),
	)
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/public/preferences/"+token+"/one-click",
		nil,
	)
	handler.ServeHTTP(httptest.NewRecorder(), request)
	logged := output.String()
	if strings.Contains(logged, token) {
		t.Fatalf("preference capability leaked in request log: %s", logged)
	}
	if !strings.Contains(logged, "/api/public/preferences/[redacted]/one-click") {
		t.Fatalf("request log lost safe route shape: %s", logged)
	}
}

func TestSlogLoggerMinimizesHeldSupportIngressFamily(t *testing.T) {
	t.Parallel()
	const account = "short-account"
	const querySecret = "ordinary-looking-secret"
	var output bytes.Buffer
	handler := SlogLogger(slog.New(slog.NewJSONHandler(&output, nil)))(
		http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusServiceUnavailable)
		}),
	)
	request := httptest.NewRequest(http.MethodPut,
		"/api/public/support-integrations/zendesk/"+account+"/future?anything="+querySecret,
		strings.NewReader("raw-customer-body"),
	)
	handler.ServeHTTP(httptest.NewRecorder(), request)
	logged := output.String()
	for _, secret := range []string{account, querySecret, "raw-customer-body"} {
		if strings.Contains(logged, secret) {
			t.Fatalf("held support ingress disclosed %q: %s", secret, logged)
		}
	}
	if !strings.Contains(logged, "/api/public/support-integrations/zendesk/[redacted]/[redacted]") {
		t.Fatalf("log lost minimized provider family shape: %s", logged)
	}
}

func TestSlogLoggerDropsActionTicketPreviewQuery(t *testing.T) {
	t.Parallel()
	const secret = "ordinary-looking-action-ticket-bearer"
	for _, rawQuery := range []string{
		"ticket=" + secret,
		"t=" + secret,
		"ticket=" + secret + "&%zz",
		"t=" + secret + "&duplicate=" + secret,
	} {
		t.Run(rawQuery, func(t *testing.T) {
			var output bytes.Buffer
			handler := SlogLogger(slog.New(slog.NewJSONHandler(&output, nil)))(
				http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
					w.WriteHeader(http.StatusGone)
				}),
			)
			request := httptest.NewRequest(http.MethodGet, "/api/v1/actions/preview", nil)
			request.URL.RawQuery = rawQuery
			handler.ServeHTTP(httptest.NewRecorder(), request)
			logged := output.String()
			if strings.Contains(logged, secret) || strings.Contains(logged, rawQuery) {
				t.Fatalf("action-ticket bearer leaked in request log: %s", logged)
			}
			if !strings.Contains(logged, `"query":""`) {
				t.Fatalf("action-ticket query was not fully minimized: %s", logged)
			}
		})
	}
}
