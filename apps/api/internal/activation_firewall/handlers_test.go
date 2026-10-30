// SPDX-License-Identifier: AGPL-3.0-only
package activation_firewall

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// fakeStore is an in-memory Store for handler tests.
type fakeStore struct {
	listed     []ExclusionReceipt
	lastFilter ListFilter
	listErr    error

	written  []ExclusionRecord
	countByR map[string]int
	forRun   map[string][]ExclusionReceipt
}

func (f *fakeStore) WriteExclusions(_ context.Context, _, _, _ string, recs []ExclusionRecord, _ string) (int, error) {
	f.written = append(f.written, recs...)
	return len(recs), nil
}
func (f *fakeStore) CountExclusions(_ context.Context, _, runID string) (int, error) {
	return f.countByR[runID], nil
}
func (f *fakeStore) ListExclusionsForRun(_ context.Context, _, runID string) ([]ExclusionReceipt, error) {
	return f.forRun[runID], nil
}
func (f *fakeStore) ListExclusions(_ context.Context, _ string, fl ListFilter) ([]ExclusionReceipt, error) {
	f.lastFilter = fl
	if f.listErr != nil {
		return nil, f.listErr
	}
	return f.listed, nil
}

func tenantReq(method, target string) *http.Request {
	req := httptest.NewRequest(method, target, nil)
	ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tid, Slug: "t1"})
	return req.WithContext(ctx)
}

func TestListExclusions_OK(t *testing.T) {
	fs := &fakeStore{listed: []ExclusionReceipt{
		{ID: 1, SubscriberEmail: "a@x.com", RuleClass: RuleClassConsent, Purpose: "targeted_ads"},
		{ID: 2, SubscriberEmail: "b@x.com", RuleClass: RuleClassSuppression, Purpose: "targeted_ads"},
	}}
	d := &Deps{Store: fs}
	rec := httptest.NewRecorder()
	d.ListExclusions(rec, tenantReq(http.MethodGet, "/api/v1/activation-exclusions"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body.String())
	}
	var body struct {
		Items []ExclusionReceipt `json:"items"`
		Count int                `json:"count"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Count != 2 || len(body.Items) != 2 {
		t.Fatalf("want 2 items/count, got count=%d items=%d", body.Count, len(body.Items))
	}
}

func TestListExclusions_FilterParsing(t *testing.T) {
	fs := &fakeStore{}
	d := &Deps{Store: fs}
	rec := httptest.NewRecorder()
	d.ListExclusions(rec, tenantReq(http.MethodGet,
		"/api/v1/activation-exclusions?since=2026-01-01T00:00:00Z&limit=10&run_type=audience_sync&purpose=targeted_ads"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body.String())
	}
	if fs.lastFilter.RunType != RunTypeAudienceSync {
		t.Errorf("run_type not parsed: %q", fs.lastFilter.RunType)
	}
	if fs.lastFilter.Purpose != "targeted_ads" {
		t.Errorf("purpose not parsed: %q", fs.lastFilter.Purpose)
	}
	if fs.lastFilter.Limit != 10 {
		t.Errorf("limit not parsed: %d", fs.lastFilter.Limit)
	}
	if fs.lastFilter.Since == nil || !fs.lastFilter.Since.Equal(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)) {
		t.Errorf("since not parsed: %+v", fs.lastFilter.Since)
	}
}

func TestListExclusions_BadSince(t *testing.T) {
	d := &Deps{Store: &fakeStore{}}
	rec := httptest.NewRecorder()
	d.ListExclusions(rec, tenantReq(http.MethodGet, "/api/v1/activation-exclusions?since=not-a-date"))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestListExclusions_BadRunType(t *testing.T) {
	d := &Deps{Store: &fakeStore{}}
	rec := httptest.NewRecorder()
	d.ListExclusions(rec, tenantReq(http.MethodGet, "/api/v1/activation-exclusions?run_type=bogus"))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestListExclusions_NoTenant(t *testing.T) {
	d := &Deps{Store: &fakeStore{}}
	rec := httptest.NewRecorder()
	d.ListExclusions(rec, httptest.NewRequest(http.MethodGet, "/api/v1/activation-exclusions", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}
