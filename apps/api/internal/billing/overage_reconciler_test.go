// SPDX-License-Identifier: AGPL-3.0-only
package billing

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/limits"
)

type overageLedgerSave struct {
	tenantID    string
	period      time.Time
	billable    int
	reportedQty int
	status      string
	reportedAt  *time.Time
}

type overageLedgerFixture struct {
	state     *BillingState
	delivered int
	saves     []overageLedgerSave
}

func (f *overageLedgerFixture) overageTouchedTenants(context.Context, time.Time) ([]overageLedgerRow, error) {
	return nil, nil
}

func (f *overageLedgerFixture) GetState(context.Context, string) (*BillingState, error) {
	return f.state, nil
}

func (f *overageLedgerFixture) MonthlyDeliveredSends(context.Context, string, time.Time) (int, error) {
	return f.delivered, nil
}

func (f *overageLedgerFixture) saveOverageLedger(_ context.Context, tenantID string, period time.Time, billable, reportedQty int, status string, reportedAt *time.Time) error {
	f.saves = append(f.saves, overageLedgerSave{
		tenantID: tenantID, period: period, billable: billable,
		reportedQty: reportedQty, status: status, reportedAt: reportedAt,
	})
	return nil
}

// The metered usage POST must hit /usage_records with action=set, the cumulative
// quantity, and an Idempotency-Key — the properties that make webhook redelivery
// / retry / re-tick safe against double-charging.
func TestReportOverageUsage_RequestShape(t *testing.T) {
	var gotPath, gotAction, gotQty, gotIdem, gotAuth, gotTimestamp string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		gotPath = r.URL.Path
		gotAction = r.FormValue("action")
		gotQty = r.FormValue("quantity")
		gotIdem = r.Header.Get("Idempotency-Key")
		gotAuth = r.Header.Get("Authorization")
		gotTimestamp = r.FormValue("timestamp")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"mbur_1","quantity":1250}`))
	}))
	defer srv.Close()
	prev := stripeAPIBase
	stripeAPIBase = srv.URL
	defer func() { stripeAPIBase = prev }()

	err := reportOverageUsage(context.Background(), "sk_test_x", "si_abc", 1250, "overage:t:2026-08:1250")
	if err != nil {
		t.Fatalf("reportOverageUsage: %v", err)
	}
	if gotPath != "/v1/subscription_items/si_abc/usage_records" {
		t.Fatalf("path = %q", gotPath)
	}
	// No explicit timestamp — Stripe records at now() (always in-period).
	if gotTimestamp != "" {
		t.Fatalf("timestamp should be unset, got %q", gotTimestamp)
	}
	if gotAction != "set" || gotQty != "1250" {
		t.Fatalf("action=%q quantity=%q, want set/1250", gotAction, gotQty)
	}
	if gotIdem != "overage:t:2026-08:1250" {
		t.Fatalf("idempotency-key = %q", gotIdem)
	}
	if gotAuth != "Bearer sk_test_x" {
		t.Fatalf("auth = %q", gotAuth)
	}
}

// A Stripe 4xx surfaces as an error (so the ledger records 'error', not a
// false 'reported').
func TestReportOverageUsage_StripeError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":{"message":"No such subscription item"}}`))
	}))
	defer srv.Close()
	prev := stripeAPIBase
	stripeAPIBase = srv.URL
	defer func() { stripeAPIBase = prev }()

	if err := reportOverageUsage(context.Background(), "sk_test_x", "si_missing", 10, "k"); err == nil {
		t.Fatal("a Stripe 4xx must return an error")
	}
}

func TestOverageReportingReleaseHoldAccruesWithoutProviderOrCheckpoint(t *testing.T) {
	var providerCalls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		providerCalls.Add(1)
		http.Error(w, "provider must remain unreachable", http.StatusInternalServerError)
	}))
	defer srv.Close()
	previousBase := stripeAPIBase
	stripeAPIBase = srv.URL
	defer func() { stripeAPIBase = previousBase }()

	overageCap := 10_000
	monthlyCap := limits.MonthlySendCap(string(TierSending))
	repo := &overageLedgerFixture{
		state: &BillingState{
			Tier: TierSending, OverageEnabled: true, OverageCap: &overageCap,
			StripeOverageItemID: "si_unqualified",
		},
		delivered: monthlyCap + 1_250,
	}
	rec := &OverageReconciler{Repo: repo}
	period := time.Date(2026, time.August, 1, 0, 0, 0, 0, time.UTC)
	if err := rec.reconcileTenant(context.Background(), overageLedgerRow{
		TenantID: "tenant-held", ReportedQuantity: 37,
	}, period, "sk_live_present"); err != nil {
		t.Fatalf("reconcile held overage: %v", err)
	}

	if got := providerCalls.Load(); got != 0 {
		t.Fatalf("release-held overage made %d Stripe call(s), want zero", got)
	}
	if len(repo.saves) != 1 {
		t.Fatalf("ledger saves = %d, want one local accrual", len(repo.saves))
	}
	saved := repo.saves[0]
	if saved.billable != 1_250 || saved.status != "local_only" {
		t.Fatalf("local accrual = %+v, want billable=1250 status=local_only", saved)
	}
	if saved.reportedQty != 37 || saved.reportedAt != nil {
		t.Fatalf("held reporting advanced success checkpoint: %+v", saved)
	}
}

// Ledger touch → worker-scope enumeration → save round-trips under the
// non-privileged app role (real RLS + grants + the worker escape). Run with:
//
//	DATABASE_URL=postgres://postwave_app:local-test-password-only@localhost/postwave_verify?sslmode=disable \
//	  go test ./internal/billing -run TestOverageLedger
func TestOverageLedgerRoundTrip_DB(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		url = os.Getenv("DATABASE_URL")
	}
	if url == "" {
		t.Skip("no DATABASE_URL; skipping overage-ledger DB test")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	// t.Cleanup, not defer: seedOverageTenant's teardown runs from t.Cleanup,
	// after this function's defers, and needs the pool (see seedOverageTenant).
	t.Cleanup(pool.Close)
	repo := NewRepo(pool)

	tenantID := seedOverageTenant(t, pool)
	period := periodStart(time.Now())

	if err := repo.RecordOverageTouch(ctx, tenantID); err != nil {
		t.Fatalf("RecordOverageTouch: %v", err)
	}
	// Idempotent — a second touch does not error or duplicate.
	if err := repo.RecordOverageTouch(ctx, tenantID); err != nil {
		t.Fatalf("second RecordOverageTouch: %v", err)
	}

	rows, err := repo.overageTouchedTenants(ctx, period)
	if err != nil {
		t.Fatalf("overageTouchedTenants: %v", err)
	}
	found := false
	for _, r := range rows {
		if r.TenantID == tenantID {
			found = true
			if r.ReportedQuantity != 0 {
				t.Fatalf("fresh ledger reported_quantity = %d, want 0", r.ReportedQuantity)
			}
		}
	}
	if !found {
		t.Fatal("touched tenant not enumerated under worker scope")
	}

	reportedAt := time.Now().UTC()
	if err := repo.saveOverageLedger(ctx, tenantID, period, 1250, 1250, "reported", &reportedAt); err != nil {
		t.Fatalf("saveOverageLedger: %v", err)
	}
	rows, _ = repo.overageTouchedTenants(ctx, period)
	for _, r := range rows {
		if r.TenantID == tenantID && r.ReportedQuantity != 1250 {
			t.Fatalf("after save reported_quantity = %d, want 1250", r.ReportedQuantity)
		}
	}
}

// The user's overage preference must survive a Stripe webhook projection write
// — a redelivered subscription.* event must never wipe the toggle, and it must
// capture the metered item id. Money-critical decoupling.
func TestOveragePreferenceSurvivesWebhook_DB(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		url = os.Getenv("DATABASE_URL")
	}
	if url == "" {
		t.Skip("no DATABASE_URL; skipping overage-preference DB test")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	// t.Cleanup, not defer: seedOverageTenant's teardown runs from t.Cleanup,
	// after this function's defers, and needs the pool (see seedOverageTenant).
	t.Cleanup(pool.Close)
	repo := NewRepo(pool)
	tenantID := seedOverageTenant(t, pool)

	cap := 5000
	if err := repo.SetOverage(ctx, tenantID, true, &cap); err != nil {
		t.Fatalf("SetOverage: %v", err)
	}
	// A subscription.updated projection write carrying the metered item id but
	// NOT the preference columns.
	if err := repo.UpsertState(ctx, BillingState{
		TenantID: tenantID, Tier: TierSending, StripeOverageItemID: "si_meter_1",
	}); err != nil {
		t.Fatalf("UpsertState: %v", err)
	}
	st, err := repo.GetState(ctx, tenantID)
	if err != nil || st == nil {
		t.Fatalf("GetState = %v, %v", st, err)
	}
	if !st.OverageEnabled || st.OverageCap == nil || *st.OverageCap != 5000 {
		t.Fatalf("preference clobbered by webhook: enabled=%v cap=%v", st.OverageEnabled, st.OverageCap)
	}
	if st.StripeOverageItemID != "si_meter_1" {
		t.Fatalf("metered item id not captured: %q", st.StripeOverageItemID)
	}
	pref := repo.OveragePreference(ctx, tenantID)
	if !pref.Enabled || pref.Cap == nil || *pref.Cap != 5000 {
		t.Fatalf("OveragePreference = %+v", pref)
	}

	// Turning the toggle off persists, and a later webrite still can't flip it on.
	if err := repo.SetOverage(ctx, tenantID, false, nil); err != nil {
		t.Fatalf("SetOverage off: %v", err)
	}
	_ = repo.UpsertState(ctx, BillingState{TenantID: tenantID, Tier: TierSending})
	if p := repo.OveragePreference(ctx, tenantID); p.Enabled || p.Cap != nil {
		t.Fatalf("preference should be off/uncapped, got %+v", p)
	}
}

func TestDunningTransitionSurvivesSubscriptionProjection_DB(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		url = os.Getenv("DATABASE_URL")
	}
	if url == "" {
		t.Skip("no DATABASE_URL; skipping dunning-transition DB test")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	// t.Cleanup, not defer: seedOverageTenant's teardown runs from t.Cleanup,
	// after this function's defers, and needs the pool (see seedOverageTenant).
	t.Cleanup(pool.Close)
	repo := NewRepo(pool)
	tenantID := seedOverageTenant(t, pool)

	if err := repo.SetDunning(ctx, tenantID, true); err != nil {
		t.Fatalf("SetDunning: %v", err)
	}
	// A subscription projection does not own payment status and must not erase
	// the transition before invoice.payment_succeeded observes it.
	if err := repo.UpsertState(ctx, BillingState{TenantID: tenantID, Tier: TierSending}); err != nil {
		t.Fatalf("UpsertState: %v", err)
	}
	cleared, err := repo.ClearDunning(ctx, tenantID)
	if err != nil {
		t.Fatalf("ClearDunning: %v", err)
	}
	if !cleared {
		t.Fatal("first clear did not report the true -> false transition")
	}
	cleared, err = repo.ClearDunning(ctx, tenantID)
	if err != nil {
		t.Fatalf("second ClearDunning: %v", err)
	}
	if cleared {
		t.Fatal("idempotent clear reported a second reactivation")
	}
}

func seedOverageTenant(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	ctx := context.Background()
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("rand: %v", err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	s := hex.EncodeToString(b[:])
	tenantID := s[0:8] + "-" + s[8:12] + "-" + s[12:16] + "-" + s[16:20] + "-" + s[20:32]

	// tenants + billing_state are RLS WITH CHECK (id/tenant_id = the GUC), so
	// set the scope to the pre-generated id before inserting.
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id',$1,true)`, tenantID); err != nil {
		t.Fatalf("set scope: %v", err)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid,$2,$2,'sending')`,
		tenantID, "ovr-"+s[0:12]); err != nil {
		t.Fatalf("cannot seed tenant under this role: %v", err)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO billing_state (tenant_id, tier, overage_enabled) VALUES ($1::uuid,'sending',true)`,
		tenantID); err != nil {
		t.Fatalf("seed billing_state: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}
	// The teardown needs the pool, so callers close it with t.Cleanup, never
	// with defer: Go runs a test's defers before its t.Cleanup callbacks. The
	// three callers used `defer pool.Close()`, so this Begin always failed on
	// a closed pool, the error was discarded, and every run left its tenant
	// and billing_state row in the shared database. Failures are now reported.
	t.Cleanup(func() { deleteOverageTestTenant(t, pool, tenantID) })
	return tenantID
}

// deleteOverageTestTenant removes a tenant the test created, and everything
// that cascades from it, in a transaction bound to that tenant. The tenants
// DELETE policy sees only the row whose id equals app.tenant_id, so a DELETE
// issued without that binding matches nothing and reports no error.
//
// It retries the whole transaction when Postgres reports its shared lock table
// full (SQLSTATE 53200) or picks it as a deadlock victim (40P01). One tenant
// delete cascades through every foreign key that references tenants(id), about
// 735 at migration head, and holds a lock on each of those tables and their
// indexes until commit. So a few concurrent deletes from other packages sharing
// the database can briefly exhaust the lock table, and one can deadlock with
// another package's DDL on a shared table (the consent tracking test's
// CREATE/DROP TRIGGER on audit_log, for one). Both clear on their own. Any other
// failure, or a delete that removes no row, fails the test, so a leaked tenant
// cannot go unnoticed.
func deleteOverageTestTenant(t *testing.T, pool *db.Pool, tenantID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	for wait := 50 * time.Millisecond; ; wait = min(2*wait, 2*time.Second) {
		removed, err := deleteOverageTestTenantOnce(ctx, pool, tenantID)
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && (pgErr.Code == "53200" || pgErr.Code == "40P01") && ctx.Err() == nil {
			t.Logf("cleanup of tenant %s: %s (SQLSTATE %s), retrying in %v", tenantID, pgErr.Message, pgErr.Code, wait)
			time.Sleep(wait)
			continue
		}
		if err != nil {
			t.Errorf("cleanup of tenant %s: %v", tenantID, err)
		} else if removed != 1 {
			t.Errorf("cleanup of tenant %s removed %d tenant rows, want 1", tenantID, removed)
		}
		return
	}
}

func deleteOverageTestTenantOnce(ctx context.Context, pool *db.Pool, tenantID string) (int64, error) {
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), tx.Commit(ctx)
}
