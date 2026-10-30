// SPDX-License-Identifier: AGPL-3.0-only
package budgets

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// stubChecker is an in-memory Checker for unit-testing Check + Middleware
// without touching pgx.
type stubChecker struct {
	budget *Budget
	usage  map[string]*Usage // key = period RFC3339
}

func (s *stubChecker) LoadBudget(_ context.Context, _ string) (*Budget, error) {
	return s.budget, nil
}

func (s *stubChecker) LoadUsage(_ context.Context, _ string, period time.Time) (*Usage, error) {
	if u, ok := s.usage[period.Format(time.RFC3339)]; ok {
		return u, nil
	}
	return &Usage{Period: period}, nil
}

func (s *stubChecker) IncrementUsage(_ context.Context, _ *Budget, resource Resource, inc int, at time.Time) error {
	period := PeriodFor(resource, at)
	k := period.Format(time.RFC3339)
	u, ok := s.usage[k]
	if !ok {
		u = &Usage{Period: period}
		s.usage[k] = u
	}
	if resource == ResourceSends {
		u.Sends += inc
	} else {
		u.CostCents += inc
	}
	return nil
}

func TestCheckPassesUnderLimit(t *testing.T) {
	limit := 10
	c := &stubChecker{budget: &Budget{APIKeyID: "k", SendsPerDay: &limit}, usage: map[string]*Usage{}}
	if err := Check(context.Background(), c, "k", ResourceSends, 1); err != nil {
		t.Fatalf("expected nil, got %v", err)
	}
}

func TestCheckBlocksOverLimit(t *testing.T) {
	limit := 5
	period := PeriodFor(ResourceSends, time.Now())
	c := &stubChecker{
		budget: &Budget{APIKeyID: "k", SendsPerDay: &limit},
		usage:  map[string]*Usage{period.Format(time.RFC3339): {Period: period, Sends: 5}},
	}
	err := Check(context.Background(), c, "k", ResourceSends, 1)
	if err == nil {
		t.Fatal("expected BudgetExceededError")
	}
	be, ok := IsBudgetExceeded(err)
	if !ok {
		t.Fatalf("expected *BudgetExceededError, got %T", err)
	}
	if be.Resource != "sends" {
		t.Errorf("Resource = %q, want sends", be.Resource)
	}
	// Retry-after must land at next UTC midnight.
	expect := time.Now().UTC().Truncate(24 * time.Hour).Add(24 * time.Hour)
	if !be.RetryAfter.Equal(expect) {
		t.Errorf("RetryAfter = %v, want %v", be.RetryAfter, expect)
	}
}

func TestPeriodRollover(t *testing.T) {
	// 23:59 UTC and 00:01 UTC the next day MUST land in different periods.
	a := time.Date(2026, 5, 1, 23, 59, 0, 0, time.UTC)
	b := time.Date(2026, 5, 2, 0, 1, 0, 0, time.UTC)
	if PeriodFor(ResourceSends, a).Equal(PeriodFor(ResourceSends, b)) {
		t.Fatal("expected daily period to roll at midnight UTC")
	}
}

func TestMiddleware429Body(t *testing.T) {
	limit := 1
	period := PeriodFor(ResourceSends, time.Now())
	c := &stubChecker{
		budget: &Budget{APIKeyID: "k", SendsPerDay: &limit},
		usage:  map[string]*Usage{period.Format(time.RFC3339): {Period: period, Sends: 1}},
	}
	mw := Middleware(c)
	called := false
	h := mw(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		called = true
	}))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/campaigns/abc/send", nil)
	req = req.WithContext(middleware.WithAPIKeyID(req.Context(), "k"))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", rec.Code)
	}
	if called {
		t.Fatal("downstream handler must not run on 429")
	}
	var body struct {
		Error map[string]any `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body decode: %v", err)
	}
	if body.Error["code"] != "budget_exhausted" || body.Error["reason"] != "quota" || body.Error["resource"] != "sends" {
		t.Fatalf("body = %v", body.Error)
	}
	if seconds, err := strconv.Atoi(rec.Header().Get("Retry-After")); err != nil || seconds < 1 {
		t.Errorf("Retry-After = %q, want positive seconds", rec.Header().Get("Retry-After"))
	}
}

func TestMiddlewareCountsCampaignTestSendRoute(t *testing.T) {
	limit := 1
	period := PeriodFor(ResourceSends, time.Now())
	c := &stubChecker{
		budget: &Budget{APIKeyID: "k", SendsPerDay: &limit},
		usage:  map[string]*Usage{period.Format(time.RFC3339): {Period: period, Sends: 1}},
	}
	mw := Middleware(c)
	called := false
	h := mw(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		called = true
	}))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/campaigns/camp_123/test-send", nil)
	req = req.WithContext(middleware.WithAPIKeyID(req.Context(), "k"))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", rec.Code)
	}
	if called {
		t.Fatal("downstream handler must not run on 429")
	}
}

func TestMiddlewareSkipsNonSendRoute(t *testing.T) {
	limit := 0
	c := &stubChecker{budget: &Budget{APIKeyID: "k", SendsPerDay: &limit}, usage: map[string]*Usage{}}
	mw := Middleware(c)
	called := false
	h := mw(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) { called = true }))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/campaigns", nil)
	req = req.WithContext(middleware.WithAPIKeyID(req.Context(), "k"))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if !called {
		t.Fatal("non-send route must pass through")
	}
}

func TestUnknownResourceErrors(t *testing.T) {
	c := &stubChecker{budget: &Budget{APIKeyID: "k"}, usage: map[string]*Usage{}}
	err := Check(context.Background(), c, "k", "bogus", 1)
	if err == nil || errors.Is(err, &BudgetExceededError{}) {
		t.Fatalf("expected plain error for unknown resource, got %v", err)
	}
}
