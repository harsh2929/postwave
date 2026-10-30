// SPDX-License-Identifier: AGPL-3.0-only
package preferences

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestCreateTopicRejectsOversizedBody(t *testing.T) {
	deps := &Deps{}
	body := `{"slug":"news","name":"` + strings.Repeat("x", int(preferenceJSONMaxBodyBytes)) + `"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/topics", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant_test"}))
	rec := httptest.NewRecorder()

	deps.CreateTopic(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "payload_too_large") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}
