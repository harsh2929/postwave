// SPDX-License-Identifier: AGPL-3.0-only

package activitycursor

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestValidRef(t *testing.T) {
	cases := []struct {
		key, id string
		want    bool
	}{
		{"campaign", "cam_123", true},
		{"subscriber", "sub_42", true},
		{"", "x", false},                                          // empty key
		{"campaign", "", false},                                   // empty id
		{"campaign", "id with space", false},                      // whitespace smuggled
		{"campaign", "id\nwith\nnewline", false},                  // control char
		{strings.Repeat("k", 65), "x", false},                     // key too long
		{"campaign", strings.Repeat("i", 257), false},             // id too long
		{strings.Repeat("k", 64), strings.Repeat("i", 256), true}, // at the bounds
	}
	for _, c := range cases {
		if got := validRef(c.key, c.id); got != c.want {
			t.Errorf("validRef(%q,%q)=%v want %v", c.key, c.id, got, c.want)
		}
	}
}

// TestHandlersRequireSession asserts both handlers 401 without a session user —
// the per-user cursor must never be reachable by a userless (API-key) caller.
func TestHandlersRequireSession(t *testing.T) {
	d := &Deps{}
	for _, tc := range []struct {
		name string
		fn   http.HandlerFunc
		m    string
	}{
		{"get", d.Get, http.MethodGet},
		{"put", d.Put, http.MethodPut},
	} {
		req := httptest.NewRequest(tc.m, "/api/v1/activity/last-viewed", nil)
		// tenant present but NO user in context (API-key style).
		ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "t-1"})
		rec := httptest.NewRecorder()
		tc.fn(rec, req.WithContext(ctx))
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s: want 401 without a session user, got %d", tc.name, rec.Code)
		}
	}
}
