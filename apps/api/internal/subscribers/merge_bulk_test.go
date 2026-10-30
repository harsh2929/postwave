package subscribers

// Unit tests for the bulk merge handler. We can't exercise the full DB
// merge path without postgres, but the handler's input-validation +
// per-pair isolation can be tested cheaply by feeding malformed pairs
// (same primary == duplicate) and verifying the response carries
// per-pair status with no panic.

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestBulkMergeHandler_RequiresTenant(t *testing.T) {
	d := &Deps{}
	r := httptest.NewRequest("POST", "/api/v1/subscribers/merge/bulk",
		strings.NewReader(`{"pairs":[{"primary_id":"a","duplicate_id":"b"}]}`))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	d.BulkMergeHandler(w, r)
	if w.Code != 401 {
		t.Errorf("status = %d, want 401 without tenant", w.Code)
	}
}

func TestBulkMergeHandler_RejectsEmptyPairs(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("POST", "/api/v1/subscribers/merge/bulk",
		strings.NewReader(`{"pairs":[]}`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.BulkMergeHandler(w, r)
	if w.Code != 400 {
		t.Errorf("status = %d, want 400 for empty pairs", w.Code)
	}
	if !strings.Contains(w.Body.String(), "empty_pairs") {
		t.Errorf("body = %q, want empty_pairs error", w.Body.String())
	}
}

// TestBulkMergeHandler_PartialFailure_SameSubscriber — when a pair has
// primary==duplicate, Repo.Merge returns ErrSameSubscriber before any
// pool access. The bulk handler must isolate that failure into its
// per-item slot and keep processing. We can't easily simulate a "good"
// merge without a DB, but we can verify the failing pair surfaces
// status="failed" and the response shape is the right wire contract.
func TestBulkMergeHandler_PartialFailure_SameSubscriber(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	body := `{"pairs":[{"primary_id":"x","duplicate_id":"x"}]}`
	r := httptest.NewRequest("POST", "/api/v1/subscribers/merge/bulk",
		strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.BulkMergeHandler(w, r)
	if w.Code != 200 {
		t.Errorf("status = %d, want 200 (handler returns per-item statuses)", w.Code)
	}
	var got BulkMergeResult
	if err := json.NewDecoder(w.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Merged != 0 {
		t.Errorf("merged = %d, want 0", got.Merged)
	}
	if got.Failed != 1 {
		t.Errorf("failed = %d, want 1", got.Failed)
	}
	if len(got.Items) != 1 {
		t.Fatalf("len(items) = %d, want 1", len(got.Items))
	}
	if got.Items[0].Status != "failed" {
		t.Errorf("item.status = %q, want 'failed'", got.Items[0].Status)
	}
	if got.Items[0].Error != "same_subscriber" {
		t.Errorf("item.error = %q, want 'same_subscriber'", got.Items[0].Error)
	}
}

// TestBulkMergeHandler_RejectsTooMany — guard against accidental
// runaway bulks (MaxBulkMergePairs=500).
func TestBulkMergeHandler_RejectsTooMany(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	var sb strings.Builder
	sb.WriteString(`{"pairs":[`)
	for i := 0; i < MaxBulkMergePairs+1; i++ {
		if i > 0 {
			sb.WriteString(",")
		}
		sb.WriteString(`{"primary_id":"a","duplicate_id":"b"}`)
	}
	sb.WriteString(`]}`)
	r := httptest.NewRequest("POST", "/api/v1/subscribers/merge/bulk",
		strings.NewReader(sb.String()))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.BulkMergeHandler(w, r)
	if w.Code != 400 {
		t.Errorf("status = %d, want 400", w.Code)
	}
	if !strings.Contains(w.Body.String(), "too_many_pairs") {
		t.Errorf("body = %q, want too_many_pairs", w.Body.String())
	}
}
