// SPDX-License-Identifier: AGPL-3.0-only
package apikeys

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestCreateRejectsOversizedBody(t *testing.T) {
	deps := &Deps{Repo: &Repo{Pool: nil}}
	body := `{"label":"` + strings.Repeat("x", int(apiKeyJSONMaxBodyBytes)) + `","scopes":["admin"]}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/api-keys", strings.NewReader(body))
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
