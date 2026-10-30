package settings

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func tenantRequest(method, path, body string) *http.Request {
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "t1"})
	req := httptest.NewRequestWithContext(ctx, method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	return req
}

func TestWorkspacePatchRejectsOversizedBody(t *testing.T) {
	d := &WorkspaceDeps{Repo: &WorkspaceRepo{Pool: nil}}
	body := `{"display_name":"` + strings.Repeat("a", int(settingsJSONMaxBodyBytes)+1) + `"}`
	rec := httptest.NewRecorder()
	d.Patch(rec, tenantRequest(http.MethodPatch, "/api/v1/settings/workspace", body))
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", rec.Code)
	}
}

func TestPrivacyPatchRejectsOversizedBody(t *testing.T) {
	d := &PrivacyDeps{Repo: &PrivacyRepo{Pool: nil}}
	body := `{"audit_log_retention_days":90,"padding":"` + strings.Repeat("a", int(settingsJSONMaxBodyBytes)+1) + `"}`
	rec := httptest.NewRecorder()
	d.Patch(rec, tenantRequest(http.MethodPatch, "/api/v1/settings/privacy", body))
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", rec.Code)
	}
}

func TestEmailCompliancePutRejectsOversizedBody(t *testing.T) {
	d := &EmailComplianceDeps{Repo: &EmailComplianceRepo{Pool: nil}}
	body := `{"legal_sender_name":"Acme","default_footer_text":"` + strings.Repeat("a", int(settingsJSONMaxBodyBytes)+1) + `"}`
	rec := httptest.NewRecorder()
	d.Put(rec, tenantRequest(http.MethodPut, "/api/v1/settings/email-compliance", body))
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", rec.Code)
	}
}
