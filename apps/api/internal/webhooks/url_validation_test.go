package webhooks

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type fakeResolver struct {
	addrs []net.IPAddr
	err   error
}

func (f fakeResolver) LookupIPAddr(context.Context, string) ([]net.IPAddr, error) {
	return f.addrs, f.err
}

func TestValidateWebhookDestinationRejectsUnsafeURLs(t *testing.T) {
	tests := []string{
		"http://example.com/hook",
		"https://user:pass@example.com/hook",
		"https://localhost/hook",
		"https://app.localhost/hook",
		"https://127.0.0.1/hook",
		"https://10.0.0.7/hook",
		"https://[::1]/hook",
		"https://[fc00::1]/hook",
	}
	for _, raw := range tests {
		t.Run(raw, func(t *testing.T) {
			if _, err := validateWebhookDestinationWithResolver(context.Background(), raw, fakeResolver{}); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
}

func TestValidateWebhookDestinationRejectsPrivateDNSResult(t *testing.T) {
	_, err := validateWebhookDestinationWithResolver(context.Background(), "https://hooks.example/hook", fakeResolver{
		addrs: []net.IPAddr{{IP: net.ParseIP("192.168.1.4")}},
	})
	if err == nil || !strings.Contains(err.Error(), "private or reserved") {
		t.Fatalf("expected private address error, got %v", err)
	}
}

func TestValidateWebhookDestinationAllowsPublicDNSResult(t *testing.T) {
	_, err := validateWebhookDestinationWithResolver(context.Background(), "https://hooks.example/hook", fakeResolver{
		addrs: []net.IPAddr{{IP: net.ParseIP("93.184.216.34")}},
	})
	if err != nil {
		t.Fatalf("expected public destination to pass, got %v", err)
	}
}

func TestValidateWebhookDestinationRejectsLookupFailures(t *testing.T) {
	_, err := validateWebhookDestinationWithResolver(context.Background(), "https://hooks.example/hook", fakeResolver{
		err: errors.New("dns down"),
	})
	if err == nil || !strings.Contains(err.Error(), "resolve host") {
		t.Fatalf("expected resolver error, got %v", err)
	}
}

func TestCreateRejectsOversizedBody(t *testing.T) {
	deps := &Deps{}
	body := `{"url":"https://hooks.example/hook","events":["subscriber.created"],"description":"` +
		strings.Repeat("x", int(webhookJSONMaxBodyBytes)) + `"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/webhooks", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant_test"}))
	rec := httptest.NewRecorder()

	deps.Create(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "payload_too_large") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}
