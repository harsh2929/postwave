// SPDX-License-Identifier: AGPL-3.0-only
//
// Unit tests for the cross-channel timeline: pure helpers + handler
// validation. The DB-backed merge/paging tests live in
// followup_surfaces_db_test.go (skip without DATABASE_URL).

package analytics

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestTimelineLabel(t *testing.T) {
	for _, tc := range []struct {
		channel, typ, want string
	}{
		{"email", "sent", "Email sent"},
		{"email", "clicked", "Email link clicked"},
		{"email", "unsubscribed", "Unsubscribed from email"},
		{"sms", "delivered", "SMS delivered"},
		{"sms", "received", "SMS reply received"},
		{"sms", "consent_granted", "SMS consent granted"},
		// Unmapped types degrade to "<Channel> <type words>".
		{"email", "snoozed", "Email snoozed"},
		{"sms", "carrier_filtered", "SMS carrier filtered"},
		{"push", "tapped", "push tapped"},
	} {
		if got := timelineLabel(tc.channel, tc.typ); got != tc.want {
			t.Errorf("timelineLabel(%q, %q) = %q, want %q", tc.channel, tc.typ, got, tc.want)
		}
	}
}

func TestClampTimelineLimit(t *testing.T) {
	for _, tc := range []struct{ in, want int }{
		{-1, defaultCrossTimelineLimit},
		{0, defaultCrossTimelineLimit},
		{1, 1},
		{maxCrossTimelineLimit, maxCrossTimelineLimit},
		{maxCrossTimelineLimit + 1, maxCrossTimelineLimit},
	} {
		if got := clampTimelineLimit(tc.in); got != tc.want {
			t.Errorf("clampTimelineLimit(%d) = %d, want %d", tc.in, got, tc.want)
		}
	}
}

func TestCrossChannelTimelineHandler_RequiresTenant(t *testing.T) {
	d := &ExtendedDeps{Service: &Service{}}
	r := httptest.NewRequest(http.MethodGet, "/api/v1/subscribers/x/cross-channel-timeline", nil)
	w := httptest.NewRecorder()
	d.CrossChannelTimelineHandler(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}

func TestCrossChannelTimelineHandler_Validation(t *testing.T) {
	d := &ExtendedDeps{Service: &Service{}}
	for name, tc := range map[string]struct {
		query, wantCode string
	}{
		"non-integer limit": {"limit=abc", "bad_limit"},
		"zero limit":        {"limit=0", "bad_limit"},
		"negative limit":    {"limit=-3", "bad_limit"},
		"bad before":        {"before=yesterday", "bad_before"},
	} {
		r := httptest.NewRequest(http.MethodGet,
			"/api/v1/subscribers/x/cross-channel-timeline?"+tc.query, nil)
		r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
		w := httptest.NewRecorder()
		d.CrossChannelTimelineHandler(w, r)
		if w.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400; body=%s", name, w.Code, w.Body.String())
			continue
		}
		if !strings.Contains(w.Body.String(), tc.wantCode) {
			t.Errorf("%s: body = %s, want code %q", name, w.Body.String(), tc.wantCode)
		}
	}
}
