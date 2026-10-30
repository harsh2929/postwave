package forms

// Tests for A23 (form visit tracking): the wire field the desktop
// codes against, the RecordVisit scope guard, and the best-effort
// contract of the public-route hook (a nil form must be a no-op — the
// counter can never break a public render).

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestFormListItem_Visits30dJSONShape(t *testing.T) {
	item := FormListItem{
		Form:           Form{ID: "f1", Slug: "join", Name: "Join"},
		Submissions30d: 12,
		ConversionRate: 40,
		Visits30d:      30,
	}
	b, err := json.Marshal(item)
	if err != nil {
		t.Fatal(err)
	}
	got := string(b)
	// The desktop FormsStatStrip computes the visit-weighted rate from
	// exactly these three names.
	for _, w := range []string{
		`"submissions30d":12`,
		`"conversionRate":40`,
		`"visits30d":30`,
	} {
		if !strings.Contains(got, w) {
			t.Errorf("missing %s in %s", w, got)
		}
	}
}

func TestFormConversionRateUsesVisits(t *testing.T) {
	for _, tc := range []struct {
		name               string
		submissions, views int64
		want               int
	}{
		{name: "visit weighted", submissions: 12, views: 30, want: 40},
		{name: "no visits", submissions: 12, views: 0, want: 0},
		{name: "no submissions", submissions: 0, views: 30, want: 0},
		{name: "counter lag clamps", submissions: 31, views: 30, want: 100},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := formConversionRate(tc.submissions, tc.views); got != tc.want {
				t.Fatalf("formConversionRate(%d, %d) = %d, want %d", tc.submissions, tc.views, got, tc.want)
			}
		})
	}
}

func TestRecordVisit_RequiresScope(t *testing.T) {
	r := &Repo{} // never reaches the pool: scope check is first
	if err := r.RecordVisit(context.Background(), "", "form-1"); err == nil {
		t.Fatal("expected error for empty tenant id")
	}
	if err := r.RecordVisit(context.Background(), "tenant-1", ""); err == nil {
		t.Fatal("expected error for empty form id")
	}
}

func TestRecordVisit_NilFormIsNoOp(t *testing.T) {
	// recordVisit is called from public GET handlers; a nil form (or a
	// failed counter write) must never panic or affect the response.
	d := &Deps{Repo: &Repo{}}
	d.recordVisit(context.Background(), nil) // must not panic
}

func TestFillVisitDays(t *testing.T) {
	now := time.Date(2026, 6, 10, 12, 0, 0, 0, time.UTC)
	got := fillVisitDays(now, 3, map[string]int{
		"2026-06-08": 4,
		"2026-06-10": 1,
		"2026-05-01": 99, // outside the window: ignored
	})
	want := []VisitPoint{
		{Date: "2026-06-08", Count: 4},
		{Date: "2026-06-09", Count: 0},
		{Date: "2026-06-10", Count: 1},
	}
	if len(got) != len(want) {
		t.Fatalf("len = %d, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("points[%d] = %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestAnalytics_RequiresTenant(t *testing.T) {
	d := &Deps{Repo: &Repo{}}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/forms/f1/analytics", nil)
	rec := httptest.NewRecorder()
	d.Analytics(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestAnalytics_RejectsBadDays(t *testing.T) {
	d := &Deps{Repo: &Repo{}}
	for _, days := range []string{"0", "-2", "soon"} {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/forms/f1/analytics?days="+days, nil)
		req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{
			ID: "00000000-0000-0000-0000-000000000001",
		}))
		rec := httptest.NewRecorder()
		d.Analytics(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("days=%s: status = %d, want 400 (body=%s)", days, rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), "bad_days") {
			t.Fatalf("days=%s: body = %s", days, rec.Body.String())
		}
	}
}
