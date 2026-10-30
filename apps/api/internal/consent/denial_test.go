// SPDX-License-Identifier: AGPL-3.0-only
package consent

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestAdminConsentRoleDenialUsesEntitlementContract(t *testing.T) {
	called := false
	handler := requireExactAdminConsentSessionRole(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		called = true
	}))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/consent", nil)
	req = req.WithContext(middleware.WithUser(req.Context(), &middleware.User{Role: "viewer"}))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if called || rec.Code != http.StatusForbidden {
		t.Fatalf("called=%v status=%d", called, rec.Code)
	}
	for _, want := range []string{`"reason":"role"`, `"code":"insufficient_role"`, `"required_role":"admin"`} {
		if !strings.Contains(rec.Body.String(), want) {
			t.Errorf("denial missing %s: %s", want, rec.Body.String())
		}
	}
}
