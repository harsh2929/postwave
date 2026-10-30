package inbound_webhooks

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func inboundTenantRequest(method, path, body string) *http.Request {
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "t1"})
	req := httptest.NewRequestWithContext(ctx, method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	return req
}

func TestCreateRejectsOversizedBody(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	body := `{"name":"` + strings.Repeat("a", int(inboundWebhookAdminJSONMaxBodyBytes)+1) + `"}`
	rec := httptest.NewRecorder()
	d.Create(rec, inboundTenantRequest(http.MethodPost, "/api/v1/inbound-webhooks", body))
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", rec.Code)
	}
}

func TestCreateTriggerRejectsOversizedBody(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	body := `{"name":"Trigger","match_jsonpath":"$.email","email_jsonpath":"$.email","match_operator":"exists","action_type":"add_tag","action_target_id":"` + strings.Repeat("a", int(inboundWebhookAdminJSONMaxBodyBytes)+1) + `"}`
	rec := httptest.NewRecorder()
	d.CreateTrigger(rec, inboundTenantRequest(http.MethodPost, "/api/v1/inbound-webhooks/wh1/triggers", body))
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", rec.Code)
	}
}
