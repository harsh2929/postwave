// SPDX-License-Identifier: AGPL-3.0-only
//
// Unit tests for the template leaderboard: pure helpers + handler
// validation. The DB-backed attribution test lives in
// followup_surfaces_db_test.go (skip without DATABASE_URL).

package analytics

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestSafeRate(t *testing.T) {
	for _, tc := range []struct {
		n, d int
		want float64
	}{
		{0, 0, 0},      // zero denominator
		{5, 0, 0},      // zero denominator with numerator
		{3, -1, 0},     // negative denominator clamps to 0
		{-1, 3, 0},     // negative numerator clamps to 0
		{0, 10, 0},     // zero numerator
		{1, 2, 0.5},    // exact
		{10, 10, 1},    // 100%
		{12, 10, 1},    // malformed upstream counts cannot exceed 100%
		{1, 3, 0.3333}, // rounds to 4 dp
		{2, 3, 0.6667}, // rounds up at the 5th dp
		{1, 10000, 0.0001},
	} {
		if got := safeRate(tc.n, tc.d); got != tc.want {
			t.Errorf("safeRate(%d, %d) = %v, want %v", tc.n, tc.d, got, tc.want)
		}
	}
}

func TestTemplateLeaderboardQueryDeduplicatesSameWindowDeliveryEngagement(t *testing.T) {
	for _, fragment := range []string{
		"NULLIF(BTRIM(message_id), '')",
		"LOWER(BTRIM(subscriber_email::text))",
		"COALESCE(NULLIF(BTRIM(provider_event_id), ''), id::text)",
		"event_type IN ('sent', 'opened', 'clicked')",
		"BOOL_OR(event_type = 'sent')",
		"COUNT(*) FILTER (WHERE was_sent AND was_opened)",
		"COUNT(*) FILTER (WHERE was_sent AND was_clicked)",
		"HAVING BOOL_OR(was_sent)",
		"tpl.id = c.source_template_id",
		"c.source_template_id IS NULL",
		"tpl.review_status <> 'rejected'",
	} {
		if !strings.Contains(templateLeaderboardQuery, fragment) {
			t.Errorf("leaderboard query is missing safety contract %q", fragment)
		}
	}
}

func TestTemplateLeaderboardHandler_RequiresTenant(t *testing.T) {
	d := &ExtendedDeps{Service: &Service{}}
	r := httptest.NewRequest(http.MethodGet, "/api/v1/analytics/template-leaderboard", nil)
	w := httptest.NewRecorder()
	d.TemplateLeaderboardHandler(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}

func TestTemplateLeaderboardHandler_RejectsBadDays(t *testing.T) {
	d := &ExtendedDeps{Service: &Service{}}
	for _, q := range []string{"days=ninety", "days=0", "days=-1", "days=366", "days=999999"} {
		r := httptest.NewRequest(http.MethodGet, "/api/v1/analytics/template-leaderboard?"+q, nil)
		r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
		w := httptest.NewRecorder()
		d.TemplateLeaderboardHandler(w, r)
		if w.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400; body=%s", q, w.Code, w.Body.String())
			continue
		}
		if !strings.Contains(w.Body.String(), "bad_days") {
			t.Errorf("%s: body = %s, want bad_days", q, w.Body.String())
		}
	}
}

func TestTemplateLeaderboardServiceRejectsOutOfRangeDaysBeforeDatabase(t *testing.T) {
	svc := &Service{}
	for _, days := range []int{-1, 0, 366, 999999} {
		items, err := svc.TemplateLeaderboard(context.Background(), "tenant-1", days)
		if items != nil || !errors.Is(err, errInvalidTemplateLeaderboardDays) {
			t.Errorf("days=%d: items=%v err=%v, want nil/%v", days, items, err, errInvalidTemplateLeaderboardDays)
		}
	}
}
