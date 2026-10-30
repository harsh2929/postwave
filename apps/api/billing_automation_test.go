package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/billing"
)

func TestBillingAutomationEmitterPreservesBasePathAndHeaders(t *testing.T) {
	var gotPath string
	var gotAuth string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	emitter := &billingAutomationEmitter{
		BaseURL:          srv.URL + "/automation/",
		InternalAPIToken: "secret-token",
	}
	err := emitter.EmitBillingAutomationEvent(context.Background(), billing.AutomationEvent{
		TenantID:        "tenant_1",
		SubscriberEmail: "a@example.com",
		At:              time.Date(2026, 5, 20, 12, 0, 0, 0, time.UTC),
		Payload:         map[string]any{"plan": "pro"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/automation/v1/automations/event" {
		t.Fatalf("path = %q", gotPath)
	}
	if gotAuth != "Bearer secret-token" {
		t.Fatalf("auth = %q", gotAuth)
	}
	if gotBody["event_type"] != "product_event" || gotBody["tenant_id"] != "tenant_1" {
		t.Fatalf("unexpected body: %#v", gotBody)
	}
}

func TestBillingAutomationURLRejectsUnsafeInputs(t *testing.T) {
	for _, tc := range []struct {
		name string
		base string
		path string
		want string
	}{
		{name: "credentials", base: "https://u:p@example.test", path: "/v1/automations/event", want: "unsafe automation base URL"},
		{name: "query", base: "https://example.test?token=x", path: "/v1/automations/event", want: "unsafe automation base URL"},
		{name: "fragment", base: "https://example.test#frag", path: "/v1/automations/event", want: "unsafe automation base URL"},
		{name: "scheme", base: "file:///tmp/api", path: "/v1/automations/event", want: "invalid automation base URL"},
		{name: "encoded traversal", base: "https://example.test", path: "/v1/%2e%2e/event", want: "unsafe automation request path"},
		{name: "backslash", base: "https://example.test", path: "/v1\\event", want: "unsafe automation request path"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := billingAutomationURL(tc.base, tc.path)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want %q", err, tc.want)
			}
		})
	}
}
