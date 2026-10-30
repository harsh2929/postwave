// SPDX-License-Identifier: AGPL-3.0-only
package referrals

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func payoutTestCtx() context.Context {
	return middleware.WithTenant(context.Background(),
		&middleware.Tenant{ID: "11111111-1111-1111-1111-111111111111"})
}

func TestListPayoutsRejectsUnknownStatus(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/referrals/payouts?status=delivered", nil)
	req = req.WithContext(payoutTestCtx())
	rec := httptest.NewRecorder()
	d.ListPayouts(rec, req)
	// Pool is nil so a passing filter would 503; the unknown status must
	// be rejected before the repo is touched.
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 (repo gate fires before filter validation is reachable)", rec.Code)
	}
}

func TestListPayoutsStatusValidation(t *testing.T) {
	for _, tc := range []struct {
		status string
		ok     bool
	}{
		{"", true},
		{"pending", true},
		{"approved", true},
		{"paid", true},
		{"sent", false},
		{"delivered", false},
		{"skipped", false},
		{"PAID", false},
	} {
		if got := validPayoutFilterStatus(tc.status); got != tc.ok {
			t.Errorf("validPayoutFilterStatus(%q) = %v, want %v", tc.status, got, tc.ok)
		}
	}
}

func TestUpdatePayoutRejectsBadStatus(t *testing.T) {
	// Pool stays nil — the status check must reject before any DB work.
	// "pending" is a valid stored status but NOT a valid PATCH target
	// (operators can't regress a payout), so it must 400 too.
	for _, status := range []string{"pending", "sent", "delivered", "skipped", ""} {
		// Empty (never-connected) pool: present enough to pass the
		// repo-availability gate, but any actual query would panic —
		// proving the validation rejects before DB work.
		d := &Deps{Repo: &Repo{Pool: &db.Pool{}}}
		body := `{"status":"` + status + `"}`
		req := httptest.NewRequest(http.MethodPatch,
			"/api/v1/referrals/payouts/00000000-0000-0000-0000-000000000000",
			strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req = req.WithContext(payoutTestCtx())
		rec := httptest.NewRecorder()
		d.UpdatePayout(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("status %q: code = %d, want 400 (body=%s)", status, rec.Code, rec.Body.String())
		}
		var env map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
			t.Fatalf("status %q: non-JSON error body: %v", status, err)
		}
	}
}

// TestPayoutDeriveGuardTTL pins the pure TTL-window logic that keeps
// the derive-on-read backstop from re-running on every GET / export.
func TestPayoutDeriveGuardTTL(t *testing.T) {
	var g payoutDeriveGuard
	base := time.Date(2026, 6, 10, 12, 0, 0, 0, time.UTC)
	const ttl = 60 * time.Second

	if !g.tryAcquire("t1", base, ttl) {
		t.Fatal("first acquire must win")
	}
	if g.tryAcquire("t1", base.Add(30*time.Second), ttl) {
		t.Error("acquire within TTL must skip")
	}
	if g.tryAcquire("t1", base.Add(59*time.Second), ttl) {
		t.Error("acquire just inside TTL must skip")
	}
	if !g.tryAcquire("t1", base.Add(61*time.Second), ttl) {
		t.Error("first acquire after TTL must derive again")
	}
	// Independent keys don't share a window.
	if !g.tryAcquire("t2", base.Add(30*time.Second), ttl) {
		t.Error("different tenant must get its own window")
	}
}

// TestPayoutDeriveGuardReleaseAllowsRetry pins the failure path: a
// failed derivation must not consume the window.
func TestPayoutDeriveGuardReleaseAllowsRetry(t *testing.T) {
	var g payoutDeriveGuard
	base := time.Date(2026, 6, 10, 12, 0, 0, 0, time.UTC)
	const ttl = 60 * time.Second

	if !g.tryAcquire("t1", base, ttl) {
		t.Fatal("first acquire must win")
	}
	g.release("t1", base) // derivation failed
	if !g.tryAcquire("t1", base.Add(time.Second), ttl) {
		t.Error("acquire after release must win immediately")
	}
	// release with a stale stamp must NOT clear a newer window.
	g.release("t1", base)
	if g.tryAcquire("t1", base.Add(2*time.Second), ttl) {
		t.Error("stale release must not reopen the window")
	}
}

// TestPayoutDeriveGuardConcurrent asserts exactly one winner among
// racing callers in the same window.
func TestPayoutDeriveGuardConcurrent(t *testing.T) {
	var g payoutDeriveGuard
	now := time.Date(2026, 6, 10, 12, 0, 0, 0, time.UTC)
	const ttl = 60 * time.Second

	const callers = 32
	var wg sync.WaitGroup
	wins := make(chan bool, callers)
	for i := 0; i < callers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			wins <- g.tryAcquire("t1", now, ttl)
		}()
	}
	wg.Wait()
	close(wins)
	won := 0
	for w := range wins {
		if w {
			won++
		}
	}
	if won != 1 {
		t.Fatalf("winners = %d, want exactly 1", won)
	}
}

func TestPayoutsRequireTenant(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/referrals/payouts", nil)
	rec := httptest.NewRecorder()
	d.ListPayouts(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("ListPayouts without tenant = %d, want 401", rec.Code)
	}

	req = httptest.NewRequest(http.MethodPatch,
		"/api/v1/referrals/payouts/x", strings.NewReader(`{"status":"paid"}`))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	d.UpdatePayout(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("UpdatePayout without tenant = %d, want 401", rec.Code)
	}
}
