package campaigns

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func campaignTenantRequest(method, path, body string) *http.Request {
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "t1"})
	req := httptest.NewRequestWithContext(ctx, method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	return req
}

func TestCreateRejectsOversizedBody(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	body := `{"name":"Demo","subject":"Hi","body_html":"` + strings.Repeat("a", int(campaignJSONMaxBodyBytes)+1) + `"}`
	rec := httptest.NewRecorder()
	d.Create(rec, campaignTenantRequest(http.MethodPost, "/api/v1/campaigns", body))
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", rec.Code)
	}
}

func TestSetRecurrenceRejectsOversizedBody(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	body := `{"recurrence_cron":"* * * * *","padding":"` + strings.Repeat("a", int(campaignJSONMaxBodyBytes)+1) + `"}`
	rec := httptest.NewRecorder()
	d.SetRecurrence(rec, campaignTenantRequest(http.MethodPost, "/api/v1/campaigns/c1/recurrence", body))
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", rec.Code)
	}
}
