// SPDX-License-Identifier: AGPL-3.0-only
package reply_analytics

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestReplyIdentityRequiresCurrentTenantAdminSession(t *testing.T) {
	const tenantID = "00000000-0000-0000-0000-000000000001"
	for _, tc := range []struct {
		name string
		user *middleware.User
		want bool
	}{
		{name: "api key or missing session"},
		{name: "foreign tenant owner", user: &middleware.User{TenantID: "00000000-0000-0000-0000-000000000002", Role: "owner"}},
		{name: "viewer", user: &middleware.User{TenantID: tenantID, Role: "viewer"}},
		{name: "editor", user: &middleware.User{TenantID: tenantID, Role: "editor"}},
		{name: "view as viewer", user: &middleware.User{TenantID: tenantID, Role: "owner", EffectiveRole: "viewer"}},
		{name: "admin", user: &middleware.User{TenantID: tenantID, Role: "admin"}, want: true},
		{name: "owner", user: &middleware.User{TenantID: tenantID, Role: "owner"}, want: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/", nil)
			if tc.user != nil {
				r = r.WithContext(middleware.WithUser(r.Context(), tc.user))
			}
			if got := canReadReplyIdentity(r, tenantID); got != tc.want {
				t.Fatalf("canReadReplyIdentity=%v, want %v", got, tc.want)
			}
		})
	}
}

func TestTopSendersDeniesWithoutAdminBeforeDataAccess(t *testing.T) {
	const tenantID = "00000000-0000-0000-0000-000000000001"
	r := httptest.NewRequest(http.MethodGet, "/api/v1/replies/top-senders", nil)
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: tenantID}))
	w := httptest.NewRecorder()
	(&Deps{}).TopSenders(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("status=%d, want 403 before database access", w.Code)
	}
}
