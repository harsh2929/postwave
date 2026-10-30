// SPDX-License-Identifier: AGPL-3.0-only
package reputation

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/services/deliverability/internal/domain"
)

// dbForIntegration mirrors auth/dmarc_storage_test.go: skip when DATABASE_URL
// is unset so unit and integration runs share one target.
//
// The pool is closed by t.Cleanup, never by a deferred Close in the test body.
// Go runs a test's deferred calls before its t.Cleanup callbacks, and runs the
// callbacks last-registered-first, so registering Close here, before seedTenant
// registers its teardown, keeps the pool open until that teardown has run. The
// test used to `defer pool.Close()`, so its tenant cleanup ran on a closed pool
// and the error was discarded.
func dbForIntegration(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("ping: %v", err)
	}
	return pool
}

// seedTenant creates a tenant that belongs to the calling test alone, so
// reputation_snapshots' tenant FK is satisfied, and deletes it when the test
// ends.
//
// tenants is FORCE ROW LEVEL SECURITY. For the application role, which is what
// DATABASE_URL names in CI, its INSERT policy admits a row only when the row's
// id equals app.tenant_id, and its DELETE policy sees only that row. This
// helper used to insert with no tenant bound: the policy refused the row
// (SQLSTATE 42501), the helper called t.Skipf, and so the test skipped on every
// database the CI role can reach and SnapshotStore was never exercised. The
// insert now runs in a transaction bound to the new tenant, and a seed that
// fails fails the test. There is no ON CONFLICT: a clash would mean the id
// belongs to someone else, and the teardown must never delete a tenant this
// test did not create.
//
// The teardown runs under the same binding and cascades to the snapshots the
// test wrote (reputation_snapshots_tenant_id_fkey is ON DELETE CASCADE). The
// old teardown ran with no tenant bound, which under the DELETE policy matches
// nothing and reports no error, so it would have leaked the tenant even with an
// open pool. A teardown that removes anything but this one row now fails the
// test.
func seedTenant(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	tenantID := uuid.NewString()
	inSnapshotTenantTx(t, pool, tenantID, "seed tenant", func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'reputation-snapshot-test', $2, 'studio')`, tenantID, "rep-snap-"+tenantID)
		return err
	})
	t.Cleanup(func() {
		var removed int64
		inSnapshotTenantTx(t, pool, tenantID, "delete tenant", func(ctx context.Context, tx pgx.Tx) error {
			tag, err := tx.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
			removed = tag.RowsAffected()
			return err
		})
		if removed != 1 {
			t.Errorf("tenant teardown removed %d tenant rows, want 1; tenant %s and its "+
				"reputation_snapshots rows leaked", removed, tenantID)
		}
	})
	return tenantID
}

// inSnapshotTenantTx runs one fixture step (seed or teardown) in a transaction
// bound to tenantID and commits it. It builds its own bounded context, so it
// also works from t.Cleanup, after the test body has returned.
//
// It replays the step while Postgres reports its shared lock table full
// (SQLSTATE 53200, "out of shared memory"). Deleting a tenant cascades through
// every foreign key that references tenants(id), about 735 at migration head,
// and holds a lock on each of those tables and their indexes until commit:
// several thousand lock-table entries for one DELETE. The table holds about
// max_locks_per_transaction × max_connections entries, shared by every
// database on the server. At the image default of 64, which a shared local
// server may still run, a few tenant deletes from packages running at the same
// moment can fill it until one of them commits. CI raises the setting to 512
// (the service container in .github/workflows/test.yml and
// infra/aws/codebuild/ci-group.sh), which leaves room for several overlapping
// deletes, so there the retry is a backstop rather than the usual path. It
// also replays a step Postgres picked as a deadlock victim (40P01): a tenant
// delete can deadlock with another package's DDL on a shared table, such as
// the consent tracking test's CREATE/DROP TRIGGER on audit_log. Both are
// contention on the shared test database, not a defect in the code under
// test. Only fixture steps retry; the SnapshotStore calls under test run once.
func inSnapshotTenantTx(t *testing.T, pool *pgxpool.Pool, tenantID, what string, fn func(context.Context, pgx.Tx) error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	backoff := 50 * time.Millisecond
	for {
		err := runSnapshotTenantTx(ctx, pool, tenantID, fn)
		if err == nil {
			return
		}
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || (pgErr.Code != "53200" && pgErr.Code != "40P01") {
			t.Fatalf("%s: %v", what, err)
		}
		t.Logf("%s: transient %s, retrying in %v: %v", what, pgErr.Code, backoff, err)
		select {
		case <-ctx.Done():
			t.Fatalf("%s: still failing after retrying: %v", what, err)
		case <-time.After(backoff):
		}
		if backoff < 2*time.Second {
			backoff *= 2
		}
	}
}

func runSnapshotTenantTx(ctx context.Context, pool *pgxpool.Pool, tenantID string, fn func(context.Context, pgx.Tx) error) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return fmt.Errorf("bind tenant: %w", err)
	}
	if err := fn(ctx, tx); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}

// Record then History round-trips oldest-first, keys the -1 "unavailable"
// sentinel off the senderscore SOURCE (not the aggregate flag), dedups repeat
// captures at the same instant, returns the MOST-RECENT points under a limit,
// and a second tenant sees none of the first tenant's rows.
func TestSnapshotStore_RecordHistoryAndIsolationDB(t *testing.T) {
	pool := dbForIntegration(t)
	store, err := NewSnapshotStore(pool)
	if err != nil {
		t.Fatalf("NewSnapshotStore: %v", err)
	}
	ctx := context.Background()

	tenantA := seedTenant(t, pool)
	tenantB := uuid.NewString() // tenantB only reads, so needs no row.

	older := time.Now().UTC().Add(-3 * time.Hour).Truncate(time.Second)
	newer := time.Now().UTC().Add(-2 * time.Hour).Truncate(time.Second)
	newest := time.Now().UTC().Add(-1 * time.Hour).Truncate(time.Second)

	// Oldest reading: senderscore source succeeded -> score persisted as-is.
	if err := store.Record(ctx, tenantA, domain.Reputation{
		Domain:           "send.example",
		IP:               "203.0.113.9",
		GoogleScore:      domain.ReputationScore("high"),
		MicrosoftScore:   domain.ReputationScore("medium"),
		SenderScore:      88,
		BlacklistHits:    []string{"zen.spamhaus.org"},
		CheckedAt:        older,
		DataAvailable:    true,
		SourcesSucceeded: []string{"senderscore", "blacklist"},
	}); err != nil {
		t.Fatalf("Record(available): %v", err)
	}
	// Second reading: aggregate DataAvailable is true (blacklist succeeded) but
	// senderscore did NOT — so SenderScore must be stored as the -1 sentinel,
	// not the zero default, even though DataAvailable is true.
	if err := store.Record(ctx, tenantA, domain.Reputation{
		Domain:           "send.example",
		SenderScore:      0,
		CheckedAt:        newer,
		DataAvailable:    true,
		SourcesSucceeded: []string{"blacklist"},
	}); err != nil {
		t.Fatalf("Record(no senderscore): %v", err)
	}
	// Dedup: re-recording the same instant is a no-op (ON CONFLICT DO NOTHING).
	if err := store.Record(ctx, tenantA, domain.Reputation{
		Domain: "send.example", SenderScore: 91, CheckedAt: older,
		DataAvailable: true, SourcesSucceeded: []string{"senderscore"},
	}); err != nil {
		t.Fatalf("Record(dup instant): %v", err)
	}

	got, err := store.History(ctx, tenantA, time.Now().UTC().Add(-24*time.Hour), 100)
	if err != nil {
		t.Fatalf("History: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("History len = %d, want 2 (dup instant collapsed)", len(got))
	}
	if !got[0].CheckedAt.Before(got[1].CheckedAt) {
		t.Fatalf("History not oldest-first: %v then %v", got[0].CheckedAt, got[1].CheckedAt)
	}
	if got[0].SenderScore != 88 || !got[0].DataAvailable {
		t.Fatalf("first snapshot = %+v, want score 88 available (dup did not overwrite)", got[0])
	}
	if got[0].BlacklistHitCount != 1 {
		t.Fatalf("first snapshot blacklist_hit_count = %d, want 1", got[0].BlacklistHitCount)
	}
	if got[1].SenderScore != -1 {
		t.Fatalf("second snapshot SenderScore = %d, want -1 (senderscore source absent)", got[1].SenderScore)
	}

	// Most-recent-under-limit: a third point, then limit=2 must return the two
	// NEWEST (newer, newest) ascending — never the oldest two.
	if err := store.Record(ctx, tenantA, domain.Reputation{
		Domain: "send.example", SenderScore: 84, CheckedAt: newest,
		DataAvailable: true, SourcesSucceeded: []string{"senderscore"},
	}); err != nil {
		t.Fatalf("Record(newest): %v", err)
	}
	limited, err := store.History(ctx, tenantA, time.Now().UTC().Add(-24*time.Hour), 2)
	if err != nil {
		t.Fatalf("History(limit=2): %v", err)
	}
	if len(limited) != 2 {
		t.Fatalf("History(limit=2) len = %d, want 2", len(limited))
	}
	if !limited[0].CheckedAt.Equal(newer) || !limited[1].CheckedAt.Equal(newest) {
		t.Fatalf("History(limit=2) returned the wrong window: %v, %v (want newer,newest)",
			limited[0].CheckedAt, limited[1].CheckedAt)
	}

	// The `since` bound excludes older rows.
	recent, err := store.History(ctx, tenantA, newer.Add(-time.Minute), 100)
	if err != nil {
		t.Fatalf("History(since): %v", err)
	}
	if len(recent) != 2 {
		t.Fatalf("History(since) len = %d, want 2 (newer + newest)", len(recent))
	}

	// Tenant isolation: B recorded nothing, so it sees nothing of A's series.
	other, err := store.History(ctx, tenantB, time.Now().UTC().Add(-24*time.Hour), 100)
	if err != nil {
		t.Fatalf("History(tenantB): %v", err)
	}
	if len(other) != 0 {
		t.Fatalf("tenant B leaked %d of tenant A's snapshots", len(other))
	}
}
