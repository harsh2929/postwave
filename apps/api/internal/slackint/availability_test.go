// SPDX-License-Identifier: AGPL-3.0-only
//
// Tests for GET /api/v1/integrations/slack/availability (desktop-audit
// gap A16). The probe must (a) require tenant auth, (b) always report
// requires_session=true — the OAuth start route is intentionally never
// reachable by URL-carried stream tokens — and (c) reflect whether the
// deployment has SLACK_CLIENT_ID set.
package slackint

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestAvailabilityRequiresTenant(t *testing.T) {
	d := &OAuthDeps{ClientID: "client-id"}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/integrations/slack/availability", nil)
	rec := httptest.NewRecorder()
	d.AvailabilityHandler(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401; body=%s", rec.Code, rec.Body.String())
	}
}

func TestAvailabilityReportsSessionRequirementAndConfiguration(t *testing.T) {
	cases := []struct {
		name       string
		clientID   string
		configured bool
	}{
		{"configured", "client-id", true},
		{"unconfigured", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := &OAuthDeps{ClientID: tc.clientID}
			ctx := middleware.WithTenant(context.Background(),
				&middleware.Tenant{ID: "00000000-0000-0000-0000-000000000001"})
			req := httptest.NewRequestWithContext(ctx, http.MethodGet,
				"/api/v1/integrations/slack/availability", nil)
			rec := httptest.NewRecorder()
			d.AvailabilityHandler(rec, req)

			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
			}
			var body struct {
				RequiresSession bool `json:"requires_session"`
				Configured      bool `json:"configured"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatalf("unmarshal: %v; body=%s", err, rec.Body.String())
			}
			if !body.RequiresSession {
				t.Errorf("requires_session = false, want true (start route is session-only)")
			}
			if body.Configured != tc.configured {
				t.Errorf("configured = %v, want %v", body.Configured, tc.configured)
			}
		})
	}
}
