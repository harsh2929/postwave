// SPDX-License-Identifier: AGPL-3.0-only
package cost

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type stubRecorder struct{ entries []*Entry }

func (s *stubRecorder) Record(_ context.Context, e *Entry) error {
	s.entries = append(s.entries, e)
	return nil
}

func TestRunningTotalAccumulates(t *testing.T) {
	ctx := WithRunningTotal(context.Background())
	addRunningTotal(ctx, 50)
	addRunningTotal(ctx, 25)
	if got := RunningTotalCents(ctx); got != 75 {
		t.Fatalf("got %d, want 75", got)
	}
}

func TestCostHeaderMiddlewarePopulatesHeader(t *testing.T) {
	mw := middleware.CostHeaderMiddleware(
		WithRunningTotal,
		RunningTotalCents,
		nil,
	)
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		addRunningTotal(r.Context(), 42)
		w.WriteHeader(http.StatusOK)
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/x", nil))
	if got := rec.Header().Get("X-Postwave-Cost-Cents"); got != "42" {
		t.Fatalf("header = %q, want 42", got)
	}
}

func TestBudgetIncrementerReceivesRunningTotal(t *testing.T) {
	var observed int64
	mw := middleware.CostHeaderMiddleware(
		WithRunningTotal,
		RunningTotalCents,
		func(_ context.Context, cents int64, _ time.Time) {
			observed = cents
		},
	)
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		addRunningTotal(r.Context(), 17)
		addRunningTotal(r.Context(), 3)
		w.WriteHeader(http.StatusOK)
	}))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/x", nil))
	if observed != 20 {
		t.Fatalf("observed = %d, want 20", observed)
	}
}

func TestRecorderInterfaceCompiles(t *testing.T) {
	var _ Recorder = (*stubRecorder)(nil)
}
