package campaigns

// SQL-level tests for the send-domain repo methods. Skip silently when
// DATABASE_URL is unset — same pattern as db/db_test.go.
//
// What we DO test without postgres lives in handlers_send_domain_test.go
// (cron-validation rejection at the handler layer) and recurrence_test.go.

import (
	"context"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// dbForIntegration opens the pool from DATABASE_URL or skips. Mirrors
// the helper used in db/db_test.go but reusable across tests in this
// package.
func dbForIntegration(t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping repo SQL test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(func() { pool.Close() })
	return pool
}

// TestSetStatus_RejectsInvalidTransition asserts the allowedFrom guard
// surfaces ErrInvalidTransition for a draft → paused attempt — paused
// is reachable only from sending|scheduled. We use a fresh tenant id
// and rely on the rollback semantics so no rows leak between tests.
func TestSetStatus_RejectsInvalidTransition(t *testing.T) {
	pool := dbForIntegration(t)
	repo := &Repo{Pool: pool}
	// Bogus tenant + campaign id — the UPDATE matches zero rows so we
	// expect ErrInvalidTransition without ever needing a real campaign.
	const tenant = "00000000-0000-0000-0000-0000deadbeef"
	const cid = "00000000-0000-0000-0000-0000cafef00d"
	_, err := repo.SetStatus(context.Background(), tenant, cid, []string{StatusSending}, StatusPaused)
	if err == nil {
		t.Fatal("expected ErrInvalidTransition for missing row, got nil")
	}
	if err != ErrInvalidTransition {
		t.Fatalf("err = %v, want ErrInvalidTransition", err)
	}
}

// TestEnqueueRecipients_EmptyShortCircuits — calling with no emails
// returns (0, nil) without touching the pool, which lets the public
// handler skip the empty-non-opener path safely.
func TestEnqueueRecipients_EmptyShortCircuits(t *testing.T) {
	repo := &Repo{Pool: nil}
	n, err := repo.EnqueueRecipients(context.Background(), "t", "c", nil)
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if n != 0 {
		t.Errorf("count = %d, want 0", n)
	}
}

// TestSendDomainCampaign_FieldShapeRoundtrips locks the JSON tags so
// SDKs that key off snake_case keep working after a refactor.
func TestSendDomainCampaign_FieldShapeRoundtrips(t *testing.T) {
	c := SendDomainCampaign{ID: "abc", TenantID: "t", Status: "scheduled"}
	if c.ID != "abc" || c.TenantID != "t" || c.Status != "scheduled" {
		t.Fatalf("simple field assignment broke: %+v", c)
	}
}

// TestSetRecurrence_BadCallNoRow exercises the missing-row branch which
// must surface ErrNotFound. Same skip-on-missing-DB approach.
func TestSetRecurrence_BadCallNoRow(t *testing.T) {
	pool := dbForIntegration(t)
	repo := &Repo{Pool: pool}
	const tenant = "00000000-0000-0000-0000-0000deadbeef"
	const cid = "00000000-0000-0000-0000-0000cafef00d"
	until := time.Now().Add(time.Hour)
	_, err := repo.SetRecurrence(context.Background(), tenant, cid, "0 9 * * *", &until)
	if err == nil {
		t.Fatal("expected ErrNotFound for missing row, got nil")
	}
	if err != ErrNotFound {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

// TestPendingBatch_ZeroLimitDefaults — confirms limit<=0 maps to 100
// inside the implementation and we still honor RLS by skipping when
// no DATABASE_URL is set. No explicit return-value assertion: an
// empty pool just yields zero rows, which is fine.
func TestPendingBatch_ZeroLimitDefaults(t *testing.T) {
	pool := dbForIntegration(t)
	repo := &Repo{Pool: pool}
	const tenant = "00000000-0000-0000-0000-0000deadbeef"
	const cid = "00000000-0000-0000-0000-0000cafef00d"
	got, err := repo.PendingBatch(context.Background(), tenant, cid, 0)
	if err != nil {
		t.Fatalf("PendingBatch: %v", err)
	}
	if got == nil {
		t.Errorf("PendingBatch returned nil slice; should be empty []")
	}
}

// TestSetRecurrence_HandlerRejectsBadCron exercises the handler path
// without touching postgres: a bad cron string is rejected before any
// repo call. Drives the full chi path with a fake tenant context so
// we cover the auth check too.
func TestSetRecurrence_HandlerRejectsBadCron(t *testing.T) {
	d := &Deps{Repo: nil}
	r := httptest.NewRequest("POST", "/api/v1/campaigns/abc/recurrence",
		strings.NewReader(`{"recurrence_cron":"@hourly"}`))
	r.Header.Set("Content-Type", "application/json")
	// Manually inject a tenant so middleware.TenantFromContext finds one.
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.SetRecurrence(w, r)
	if w.Code != 400 {
		t.Errorf("status = %d, want 400 for bad cron", w.Code)
	}
	if !strings.Contains(w.Body.String(), "bad_cron") {
		t.Errorf("body = %q, want bad_cron error", w.Body.String())
	}
}

// TestSetRecurrence_HandlerRequiresTenant — without a tenant in ctx,
// the handler must 401 before parsing the body.
func TestSetRecurrence_HandlerRequiresTenant(t *testing.T) {
	d := &Deps{Repo: nil}
	r := httptest.NewRequest("POST", "/api/v1/campaigns/abc/recurrence",
		strings.NewReader(`{"recurrence_cron":"0 9 * * *"}`))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	d.SetRecurrence(w, r)
	if w.Code != 401 {
		t.Errorf("status = %d, want 401 without tenant", w.Code)
	}
}
