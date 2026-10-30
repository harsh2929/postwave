// SPDX-License-Identifier: AGPL-3.0-only
package campaign_replies

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestReplyAdminAuthorization(t *testing.T) {
	const tenantID = "00000000-0000-0000-0000-000000000001"
	for _, tc := range []struct {
		name string
		user *middleware.User
		want bool
	}{
		{name: "missing principal"},
		{name: "foreign tenant", user: &middleware.User{TenantID: "00000000-0000-0000-0000-000000000002", Role: "owner"}},
		{name: "viewer", user: &middleware.User{TenantID: tenantID, Role: "viewer"}},
		{name: "editor", user: &middleware.User{TenantID: tenantID, Role: "editor"}},
		{name: "view as viewer", user: &middleware.User{TenantID: tenantID, Role: "owner", EffectiveRole: "viewer"}},
		{name: "admin", user: &middleware.User{TenantID: tenantID, Role: "admin"}, want: true},
		{name: "owner", user: &middleware.User{TenantID: tenantID, Role: "owner"}, want: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			if tc.user != nil {
				req = req.WithContext(middleware.WithUser(req.Context(), tc.user))
			}
			recorder := httptest.NewRecorder()
			got := requireReplyAdmin(recorder, req, tenantID)
			if got != tc.want {
				t.Fatalf("authorized=%v, want %v", got, tc.want)
			}
			if !got && recorder.Code != http.StatusForbidden {
				t.Fatalf("status=%d, want 403", recorder.Code)
			}
		})
	}
}
