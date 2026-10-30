// SPDX-License-Identifier: AGPL-3.0-only

package campaigns

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// patchPSTO validates the window pair before opening a tenant tx, so the
// rejection branches are exercisable with a nil Pool. We assert the 400
// error codes; the happy path needs a real DB and is covered by the
// integration suite.
func TestPatchPSTOValidation(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}

	cases := []struct {
		name     string
		body     string
		wantCode int
	}{
		{
			name:     "enable without window",
			body:     `{"per_recipient_optimize":true}`,
			wantCode: http.StatusBadRequest,
		},
		{
			name:     "end before start",
			body:     `{"per_recipient_optimize":true,"send_window_start":"2026-07-02T00:00:00Z","send_window_end":"2026-07-01T00:00:00Z"}`,
			wantCode: http.StatusBadRequest,
		},
		{
			name:     "window under one hour",
			body:     `{"per_recipient_optimize":true,"send_window_start":"2026-07-01T00:00:00Z","send_window_end":"2026-07-01T00:30:00Z"}`,
			wantCode: http.StatusBadRequest,
		},
		{
			name:     "window over thirty days",
			body:     `{"per_recipient_optimize":true,"send_window_start":"2026-07-01T00:00:00Z","send_window_end":"2026-08-15T00:00:00Z"}`,
			wantCode: http.StatusBadRequest,
		},
		{
			name:     "malformed json",
			body:     `{not json`,
			wantCode: http.StatusBadRequest,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			d.patchPSTO(rec, campaignTenantRequest(http.MethodPatch, "/api/v1/campaigns/c1/psto", tc.body))
			if rec.Code != tc.wantCode {
				t.Fatalf("status = %d, want %d (body: %s)", rec.Code, tc.wantCode, rec.Body.String())
			}
		})
	}
}

// A request with no tenant in context must be rejected before any work.
func TestPatchPSTORequiresTenant(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/campaigns/c1/psto", nil)
	d.patchPSTO(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}
