// SPDX-License-Identifier: AGPL-3.0-only

package notification_feed

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// withSession returns a request carrying a tenant + acting user.
func withSession(method, target string) *http.Request {
	req := httptest.NewRequest(method, target, nil)
	ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "t-1"})
	ctx = middleware.WithUser(ctx, &middleware.User{ID: "u-1", TenantID: "t-1"})
	return req.WithContext(ctx)
}

// TestHandlers_RequireSession asserts every handler 401s without a session
// user — the per-user feed must never be reachable by a userless (API-key)
// caller. These return before any DB access, so no pool is needed.
func TestHandlers_RequireSession(t *testing.T) {
	d := &Deps{}
	handlers := []struct {
		name string
		fn   http.HandlerFunc
		m    string
	}{
		{"list", d.List, http.MethodGet},
		{"seen", d.MarkSeen, http.MethodPost},
		{"read-all", d.MarkReadAll, http.MethodPost},
		{"read-one", d.MarkRead, http.MethodPost},
	}
	for _, h := range handlers {
		rec := httptest.NewRecorder()
		// No tenant/user in context.
		req := httptest.NewRequest(h.m, "/api/v1/notifications", nil)
		h.fn(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s: want 401 without session, got %d", h.name, rec.Code)
		}
	}
}

// TestActor_ResolvesSessionIdentity confirms the actor helper passes through a
// valid tenant + user (the precondition every handler relies on).
func TestActor_ResolvesSessionIdentity(t *testing.T) {
	d := &Deps{}
	rec := httptest.NewRecorder()
	tenantID, userID, ok := d.actor(rec, withSession(http.MethodGet, "/api/v1/notifications"))
	if !ok || tenantID != "t-1" || userID != "u-1" {
		t.Fatalf("actor = (%q,%q,%v), want (t-1,u-1,true)", tenantID, userID, ok)
	}
}
