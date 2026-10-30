// SPDX-License-Identifier: AGPL-3.0-only
package deliverability_hub

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWebhookEvidenceProjectionNeverSerializesSecretsOrControls(t *testing.T) {
	t.Parallel()
	const (
		pathSecret  = "path-secret-canary"
		querySecret = "query-secret-canary"
		errorSecret = "error-secret-canary"
	)
	rawURL := "https://live-user:live-password@hooks.example.test/" + pathSecret +
		"?access_token=" + querySecret + "#fragment-secret"
	rawError := "HTTP 502: Authorization: Bearer " + errorSecret + "\r\nX-Injected: yes"
	status := parseStatusCode(rawError)
	projected := map[string]any{
		"url":         projectWebhookOrigin(rawURL),
		"error":       projectWebhookFailure(rawError, status),
		"status_code": status,
	}
	encoded, err := json.Marshal(projected)
	if err != nil {
		t.Fatal(err)
	}
	if got := projected["url"]; got != "https://hooks.example.test" {
		t.Fatalf("projected origin = %q", got)
	}
	for _, forbidden := range []string{
		"live-user", "live-password", pathSecret, querySecret, errorSecret,
		"fragment-secret", "X-Injected", "\\r", "\\n",
	} {
		if strings.Contains(string(encoded), forbidden) {
			t.Errorf("projected JSON leaked %q: %s", forbidden, encoded)
		}
	}
}

func TestWebhookEvidenceProjectionFailsClosed(t *testing.T) {
	t.Parallel()
	if got := projectWebhookOrigin("https://hooks.example.test/path\r\nX-Secret: canary"); got != "" {
		t.Fatalf("control-bearing URL projected as %q", got)
	}
	if got := projectWebhookOrigin("file:///tmp/secret"); got != "" {
		t.Fatalf("non-HTTP URL projected as %q", got)
	}
	if got := projectWebhookFailure("Bearer opaque-secret", 0); got != "Delivery failed" {
		t.Fatalf("generic error projection = %q", got)
	}
	if got := projectVerificationFailure("lookup token=opaque-secret failed"); got != "Verification failed" {
		t.Fatalf("verification projection = %q", got)
	}
}

func TestSensitiveEvidenceResponsesAreNoStore(t *testing.T) {
	t.Parallel()
	res := httptest.NewRecorder()
	setSensitiveEvidenceNoStoreHeaders(res)
	if got := res.Header().Get("Cache-Control"); !strings.Contains(got, "no-store") {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
}

func TestDNSHealthUnauthorizedResponseIsNoStore(t *testing.T) {
	t.Parallel()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/deliverability/hub/dns-health", nil)
	res := httptest.NewRecorder()
	(&Deps{}).getDNSHealth(res, req)
	if res.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", res.Code)
	}
	if got := res.Header().Get("Cache-Control"); !strings.Contains(got, "no-store") {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
}
