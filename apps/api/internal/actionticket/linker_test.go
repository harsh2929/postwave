// SPDX-License-Identifier: AGPL-3.0-only

package actionticket

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestActionTicketBaseOriginRequiresAnHTTPSOrigin(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name string
		raw  string
		want string
	}{
		{name: "empty disables links", raw: "", want: ""},
		{name: "origin", raw: "https://app.example.test", want: "https://app.example.test"},
		{name: "root slash", raw: " https://app.example.test/ ", want: "https://app.example.test"},
		{name: "explicit port", raw: "https://app.example.test:8443", want: "https://app.example.test:8443"},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := actionTicketBaseOrigin(test.raw)
			if err != nil {
				t.Fatalf("validate %q: %v", test.raw, err)
			}
			if got != test.want {
				t.Fatalf("origin = %q, want %q", got, test.want)
			}
		})
	}

	for _, raw := range []string{
		"http://app.example.test",
		"//app.example.test",
		"https://user:pass@app.example.test",
		"https://app.example.test/prefix",
		"https://app.example.test?next=https://evil.example",
		"https://app.example.test#fragment",
		"mailto:ops@example.test",
		"https://",
	} {
		t.Run("reject "+raw, func(t *testing.T) {
			if _, err := actionTicketBaseOrigin(raw); err == nil {
				t.Fatalf("unsafe public base %q was accepted", raw)
			}
		})
	}
}

func TestTicketResponseProtectionCoversEarlyRateLimitRefusals(t *testing.T) {
	t.Parallel()
	handler := ProtectResponses(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "limited", http.StatusTooManyRequests)
	}))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet,
		"/api/v1/actions/preview?ticket=secret", nil))
	if recorder.Code != http.StatusTooManyRequests {
		t.Fatalf("status=%d, want 429", recorder.Code)
	}
	for name, want := range map[string]string{
		"Cache-Control":   "no-store",
		"Referrer-Policy": "no-referrer",
		"X-Robots-Tag":    "noindex, nofollow, noarchive",
	} {
		if got := recorder.Header().Get(name); got != want {
			t.Errorf("%s=%q, want %q", name, got, want)
		}
	}
}

func TestActionHTMLNegotiationHonorsQualityAndExplicitRefusal(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		accept string
		want   bool
	}{
		{accept: "text/html", want: true},
		{accept: "text/html;q=0, application/json", want: false},
		{accept: "text/html;q=0.5, application/json;q=0.9", want: false},
		{accept: "application/json;q=0.5, text/html;q=0.9", want: true},
		{accept: "*/*", want: false},
	} {
		request := httptest.NewRequest(http.MethodGet, "/api/v1/actions/preview", nil)
		request.Header.Set("Accept", test.accept)
		if got := actionWantsHTML(request); got != test.want {
			t.Errorf("Accept %q: wantsHTML=%v, want %v", test.accept, got, test.want)
		}
	}
}

func TestLinkerRejectsAnUnsafeOriginBeforeMinting(t *testing.T) {
	t.Parallel()
	linker := &Linker{Repo: &Repo{}, BaseURL: "http://app.example.test"}
	_, err := linker.Mint(context.Background(), "tenant", "user", "approval.approve", "approval", "resource")
	if err == nil || !strings.Contains(err.Error(), "HTTPS origin") {
		t.Fatalf("Mint error = %v, want HTTPS-origin refusal before repository access", err)
	}
}
