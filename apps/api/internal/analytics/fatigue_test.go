// SPDX-License-Identifier: AGPL-3.0-only
//
// Unit tests for the fatigue curve: pure helpers + handler
// validation. The DB-backed decile math test lives in
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

func TestSendsBucketLabel(t *testing.T) {
	for _, tc := range []struct {
		lo, hi int
		want   string
	}{
		{4, 4, "4"},
		{0, 0, "0"},
		{3, 5, "3-5"},
		{1, 20, "1-20"},
	} {
		if got := sendsBucketLabel(tc.lo, tc.hi); got != tc.want {
			t.Errorf("sendsBucketLabel(%d, %d) = %q, want %q", tc.lo, tc.hi, got, tc.want)
		}
	}
}

func TestFatigueHandler_RequiresTenant(t *testing.T) {
	d := &ExtendedDeps{Service: &Service{}}
	r := httptest.NewRequest(http.MethodGet, "/api/v1/analytics/fatigue", nil)
	w := httptest.NewRecorder()
	d.FatigueHandler(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}

func TestFatigueHandler_RejectsBadDays(t *testing.T) {
	d := &ExtendedDeps{Service: &Service{}}
	for _, q := range []string{
		"days=abc",
		"days=0",
		"days=-7",
		"days=366",
		"days=999999",
	} {
		r := httptest.NewRequest(http.MethodGet, "/api/v1/analytics/fatigue?"+q, nil)
		r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
		w := httptest.NewRecorder()
		d.FatigueHandler(w, r)
		if w.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400; body=%s", q, w.Code, w.Body.String())
			continue
		}
		if !strings.Contains(w.Body.String(), "bad_days") {
			t.Errorf("%s: body = %s, want bad_days", q, w.Body.String())
		}
	}
}

func TestFatigueServiceRejectsUnboundedWindowsBeforeDatabaseAccess(t *testing.T) {
	service := &Service{}
	for _, days := range []int{-1, 0, 366, 999999} {
		items, err := service.Fatigue(
			context.Background(),
			"tenant-1",
			days,
		)
		if !errors.Is(err, errInvalidFatigueDays) || items != nil {
			t.Fatalf(
				"days=%d: items=%v err=%v, want nil/%v",
				days,
				items,
				err,
				errInvalidFatigueDays,
			)
		}
	}
}
