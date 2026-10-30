// SPDX-License-Identifier: AGPL-3.0-only
package reputationalerts

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/notifyfanout"
)

func strptr(s string) *string { return &s }
func intptr(i int) *int       { return &i }

func TestDetect(t *testing.T) {
	w := &Worker{} // dropThreshold defaults to 10
	cases := []struct {
		name    string
		row     scanRow
		wantOK  bool
		wantSub string // substring expected in body when ok
	}{
		{
			name: "first snapshot has no prior → no alert",
			row:  scanRow{curAvail: true, hasPrev: false, curSender: 40},
		},
		{
			name: "unavailable reading → no alert",
			row:  scanRow{curAvail: false, hasPrev: true, prevSender: intptr(90), curSender: 10},
		},
		{
			name:   "new blocklist hit",
			row:    scanRow{curAvail: true, hasPrev: true, prevBlacklist: intptr(0), curBlacklist: 2, prevSender: intptr(90), curSender: 90},
			wantOK: true, wantSub: "blocklist",
		},
		{
			name:   "senderscore fell past threshold",
			row:    scanRow{curAvail: true, hasPrev: true, prevSender: intptr(92), curSender: 78, prevBlacklist: intptr(0), curBlacklist: 0},
			wantOK: true, wantSub: "SenderScore",
		},
		{
			name: "small senderscore wobble → no alert",
			row:  scanRow{curAvail: true, hasPrev: true, prevSender: intptr(92), curSender: 88, prevBlacklist: intptr(0), curBlacklist: 0},
		},
		{
			name:   "google dropped to low",
			row:    scanRow{curAvail: true, hasPrev: true, prevGoogle: strptr("high"), curGoogle: "low", prevSender: intptr(90), curSender: 90, prevBlacklist: intptr(0), curBlacklist: 0},
			wantOK: true, wantSub: "Google",
		},
		{
			name: "google unknown→low is not a drop",
			row:  scanRow{curAvail: true, hasPrev: true, prevGoogle: strptr(""), curGoogle: "low", prevSender: intptr(90), curSender: 90, prevBlacklist: intptr(0), curBlacklist: 0},
		},
		{
			name: "unavailable senderscore sentinels ignored",
			// prev -1 (unavailable) and cur -1: a -1→-1 is not a real drop.
			row: scanRow{curAvail: true, hasPrev: true, prevSender: intptr(-1), curSender: -1, prevBlacklist: intptr(0), curBlacklist: 0},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, body, ok := w.detect(tc.row)
			if ok != tc.wantOK {
				t.Fatalf("detect ok = %v, want %v (body=%q)", ok, tc.wantOK, body)
			}
			if ok && tc.wantSub != "" && !contains(body, tc.wantSub) {
				t.Fatalf("body %q missing %q", body, tc.wantSub)
			}
		})
	}
}

func contains(s, sub string) bool {
	return len(sub) == 0 || (len(s) >= len(sub) && indexOf(s, sub) >= 0)
}
func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

// --- DB integration ---

type fakeFanout struct {
	calls []struct {
		tenant string
		users  []string
		ev     notifyfanout.Event
	}
}

func (f *fakeFanout) Dispatch(_ context.Context, tenantID string, userIDs []string, ev notifyfanout.Event) []notifyfanout.Delivery {
	f.calls = append(f.calls, struct {
		tenant string
		users  []string
		ev     notifyfanout.Event
	}{tenantID, userIDs, ev})
	return nil
}

func openPool(t *testing.T, url string) *pgxpool.Pool {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Fatalf("ping: %v", err)
	}
	return pool
}

func dbForIntegration(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping integration test")
	}
	pool := openPool(t, url)
	// Closed by t.Cleanup, never by a deferred Close in the test: Go runs a
	// test's defers before its t.Cleanup callbacks, and the tenant teardown
	// runs from t.Cleanup on this pool. With `defer pool.Close()` the
	// teardown's WithTenant failed on the closed pool, the error was dropped,
	// and every run left the fixture tenant in the shared database.
	t.Cleanup(pool.Close)
	return pool
}

// appPoolFor returns the pool the worker under test runs on, and fails the test
// unless that pool's role is subject to row-level security. The pool is
// POSTWAVE_APP_DATABASE_URL's when that is set (for a local DATABASE_URL that
// is a superuser), and otherwise seed itself: CI's DATABASE_URL connects as
// postwave_app.
//
// The worker's RLS-scoped reads and its alerted_at UPDATE have to run under
// the kind of role production uses. That is what catches a missing GRANT or
// an un-scoped users query, and a superuser connection passes both. Whether
// RLS applies is read from the connection's role. The old fallback to seed
// was described as logic-only coverage, but nothing checked which role seed
// had, so a superuser DATABASE_URL made the test pass without proving either.
func appPoolFor(t *testing.T, seed *pgxpool.Pool) *pgxpool.Pool {
	t.Helper()
	pool := seed
	if url := os.Getenv("POSTWAVE_APP_DATABASE_URL"); url != "" {
		pool = openPool(t, url)
		t.Cleanup(pool.Close)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var role string
	var bypassesRLS bool
	if err := pool.QueryRow(ctx, `
SELECT current_user::text, rolsuper OR rolbypassrls
  FROM pg_roles
 WHERE rolname = current_user`).Scan(&role, &bypassesRLS); err != nil {
		t.Fatalf("reading the worker pool's role: %v", err)
	}
	if bypassesRLS {
		t.Fatalf("the worker pool connects as %q, which bypasses row-level security, so the "+
			"worker's grants and tenant scoping go untested; point POSTWAVE_APP_DATABASE_URL (or "+
			"DATABASE_URL) at an RLS-bound role such as postwave_app", role)
	}
	return pool
}

// RunOnce dispatches exactly one alert for a real reputation drop, notifies the
// tenant's owner, stamps alerted_at, and is idempotent on a second pass.
func TestRunOnce_DetectsDropDispatchesAndMarksDB(t *testing.T) {
	pool := dbForIntegration(t)
	ctx := context.Background()

	tenantID := "00000000-0000-4000-8000-00a1e6700001"
	ownerID := "00000000-0000-4000-8000-00a1e670000a"

	// Seed tenant + an owner user under worker scope.
	seedTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("worker scope: %v", err)
	}
	_, _ = seedTx.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	if _, err := seedTx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier) VALUES ($1::uuid, 'rep-alert-test', 'rep-alert-test', 'studio')`, tenantID); err != nil {
		_ = seedTx.Rollback(ctx)
		t.Fatalf("seed tenant (needs pre-seeded DB): %v", err)
	}
	if _, err := seedTx.Exec(ctx, `
INSERT INTO users (id, tenant_id, external_user_id, email, role)
VALUES ($1::uuid, $2::uuid, 'rep-alert-owner', 'owner@rep-alert.test', 'owner')`, ownerID, tenantID); err != nil {
		_ = seedTx.Rollback(ctx)
		t.Fatalf("seed user: %v", err)
	}
	if err := seedTx.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}
	t.Cleanup(func() { deleteRepAlertTestTenant(t, pool, tenantID) })

	insertSnap := func(score int, blacklist int, checkedAt time.Time) {
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatalf("begin: %v", err)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
			t.Fatalf("set tenant: %v", err)
		}
		if _, err := tx.Exec(ctx, `
INSERT INTO reputation_snapshots
    (tenant_id, domain, ip, sender_score, google_score, microsoft_score, blacklist_hit_count, data_available, checked_at)
VALUES ($1::uuid, 'send.example', '203.0.113.7', $2, 'high', 'high', $3, true, $4)`,
			tenantID, score, blacklist, checkedAt); err != nil {
			t.Fatalf("insert snapshot: %v", err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatalf("commit snap: %v", err)
		}
	}

	base := time.Now().UTC().Add(-2 * time.Hour)
	insertSnap(92, 0, base)                     // healthy baseline
	insertSnap(70, 0, base.Add(30*time.Minute)) // 22-pt drop → alert

	fake := &fakeFanout{}
	// Run the worker under an RLS-bound role so its RLS-scoped reads and the
	// alerted_at UPDATE exercise the real runtime role.
	w := &Worker{Pool: appPoolFor(t, pool), Fanout: fake}

	// The scan is cross-tenant (worker scope) and the shared test DB may hold
	// other tenants' pending snapshots, so assert on THIS tenant only.
	if _, err := w.RunOnce(ctx); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	mine := callsFor(fake, tenantID)
	if len(mine) != 1 {
		t.Fatalf("dispatched %d alerts for tenant, want 1 (only the drop)", len(mine))
	}
	call := mine[0]
	if len(call.users) != 1 || call.users[0] != ownerID {
		t.Fatalf("alert recipients = %v, want [%s]", call.users, ownerID)
	}
	if call.ev.Pref == "" || call.ev.DedupeKey == "" {
		t.Fatalf("alert missing pref/dedupe: %+v", call.ev)
	}

	// Both of this tenant's snapshots must now be stamped.
	if pending := pendingCount(t, pool, tenantID); pending != 0 {
		t.Fatalf("tenant still has %d un-alerted snapshots after run", pending)
	}

	// Second pass: this tenant is fully stamped → no new dispatch for it.
	fake.calls = nil
	if _, err := w.RunOnce(ctx); err != nil {
		t.Fatalf("RunOnce#2: %v", err)
	}
	if again := callsFor(fake, tenantID); len(again) != 0 {
		t.Fatalf("second pass not idempotent: %d dispatches for tenant", len(again))
	}
}

func callsFor(f *fakeFanout, tenantID string) []struct {
	tenant string
	users  []string
	ev     notifyfanout.Event
} {
	var out []struct {
		tenant string
		users  []string
		ev     notifyfanout.Event
	}
	for _, c := range f.calls {
		if c.tenant == tenantID {
			out = append(out, c)
		}
	}
	return out
}

func pendingCount(t *testing.T, pool *pgxpool.Pool, tenantID string) int {
	t.Helper()
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin count: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		t.Fatalf("set tenant: %v", err)
	}
	var n int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM reputation_snapshots WHERE tenant_id = $1::uuid AND alerted_at IS NULL`,
		tenantID).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	return n
}

// deleteRepAlertTestTenant removes a tenant the test created, and everything
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
func deleteRepAlertTestTenant(t *testing.T, pool *db.Pool, tenantID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	for wait := 50 * time.Millisecond; ; wait = min(2*wait, 2*time.Second) {
		removed, err := deleteRepAlertTestTenantOnce(ctx, pool, tenantID)
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

func deleteRepAlertTestTenantOnce(ctx context.Context, pool *db.Pool, tenantID string) (int64, error) {
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
