// SPDX-License-Identifier: AGPL-3.0-only

package checks

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/ops"
)

// ops_billing_dlq_depth(), and the probe that reads it, count the dead-lettered
// rows of the whole stripe_webhook_attempts table: it is a platform table, and
// the dead-letter queue is one queue. Every API test package shares one
// database in CI, so these tests cannot own that table's contents, and they no
// longer try to by emptying it. A TRUNCATE takes an ACCESS EXCLUSIVE lock,
// deletes rows other tests own, and still leaves an exact count exposed to any
// row committed between it and the read.
//
// Each test reads inside a REPEATABLE READ transaction of its own instead. The
// transaction deletes every dead-lettered row it can see, adds the test's
// rows, reads, and is rolled back. The deletes are never committed, so no other
// session sees them, and the single snapshot makes the counts exact.

// deadRow is one dead-lettered stripe_webhook_attempts row, dated relative to
// the transaction's now().
type deadRow struct {
	updatedAgo string // an interval
	// deadLetteredAgo is an interval, or "" for a legacy row that reached
	// status 'dead_lettered' before dead_lettered_at was recorded.
	deadLetteredAgo string
}

// queryExecer is what isolateDLQ needs from a transaction or a connection.
type queryExecer interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// isolateDLQ makes the dead-letter queue, as the open transaction on q sees
// it, hold exactly rows: it deletes every other dead-lettered row (uncommitted)
// and inserts rows under event ids of their own. It then checks that the queue
// holds exactly those rows, so a test cannot pass over a queue it failed to
// set up.
func isolateDLQ(ctx context.Context, q queryExecer, rows []deadRow) error {
	if _, err := q.Exec(ctx, `DELETE FROM stripe_webhook_attempts WHERE status = 'dead_lettered'`); err != nil {
		return fmt.Errorf("hide the other dead-lettered rows: %w", err)
	}
	for _, row := range rows {
		var suffix [8]byte
		if _, err := rand.Read(suffix[:]); err != nil {
			return err
		}
		if _, err := q.Exec(ctx, `
INSERT INTO stripe_webhook_attempts
       (event_id, payload_json, status, updated_at, dead_lettered_at)
VALUES ($1, '{}'::jsonb, 'dead_lettered',
        now() - $2::interval, now() - NULLIF($3, '')::interval)`,
			"evt_test_ops_checks_"+hex.EncodeToString(suffix[:]), row.updatedAgo, row.deadLetteredAgo); err != nil {
			return fmt.Errorf("insert dead-lettered row: %w", err)
		}
	}
	var dead int
	if err := q.QueryRow(ctx,
		`SELECT count(*) FROM stripe_webhook_attempts WHERE status = 'dead_lettered'`).Scan(&dead); err != nil {
		return fmt.Errorf("count dead-lettered rows: %w", err)
	}
	if dead != len(rows) {
		return fmt.Errorf("the isolated queue holds %d dead-lettered rows, want exactly %d", dead, len(rows))
	}
	return nil
}

// dlqTx returns a REPEATABLE READ transaction in which the dead-letter queue
// holds exactly rows. It is rolled back when the test ends.
func dlqTx(t *testing.T, pool *pgxpool.Pool, rows ...deadRow) pgx.Tx {
	t.Helper()
	ctx := context.Background()
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	if err := isolateDLQ(ctx, tx, rows); err != nil {
		t.Fatal(err)
	}
	return tx
}

// probeEnv returns an ops.Env for a probe that must see a dead-letter queue
// holding exactly rows. probeBillingDLQ takes a pool, not a transaction, so the
// pool does the isolating: before it hands out a connection it opens a
// REPEATABLE READ transaction on it and runs isolateDLQ. The probe's query
// runs in that transaction, and pgxpool destroys a connection that is released
// inside a transaction, which rolls it back. isolated counts the connections
// handed out this way, so a test can prove its probe read through one.
func probeEnv(t *testing.T, rows ...deadRow) (env *ops.Env, isolated *atomic.Int32) {
	t.Helper()
	cfg := testPool(t).Config()
	cfg.MaxConns = 1
	isolated = new(atomic.Int32)
	cfg.PrepareConn = func(ctx context.Context, conn *pgx.Conn) (bool, error) {
		if _, err := conn.Exec(ctx, "BEGIN ISOLATION LEVEL REPEATABLE READ"); err != nil {
			return false, err
		}
		if err := isolateDLQ(ctx, conn, rows); err != nil {
			return false, err // false: destroy the connection with its transaction
		}
		isolated.Add(1)
		return true, nil
	}
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatalf("pgxpool.NewWithConfig: %v", err)
	}
	t.Cleanup(pool.Close)
	return &ops.Env{Pool: pool}, isolated
}

// requireOneIsolatedRead fails the test unless the probe's single query ran on
// a connection probeEnv had isolated; otherwise the probe read the shared queue
// and its result says nothing about the fixture.
func requireOneIsolatedRead(t *testing.T, isolated *atomic.Int32) {
	t.Helper()
	if n := isolated.Load(); n != 1 {
		t.Fatalf("the probe read through %d isolated connections, want exactly 1", n)
	}
}

func TestProbeBillingDLQ_CleanQueueIsOK(t *testing.T) {
	env, isolated := probeEnv(t)

	st, detail, err := probeBillingDLQ(context.Background(), env)
	if err != nil {
		t.Fatal(err)
	}
	requireOneIsolatedRead(t, isolated)
	if st != ops.StatusOK {
		t.Fatalf("an empty DLQ is OK, got %q (%s)", st, detail)
	}
}

func TestProbeBillingDLQ_DeadEventIsRed(t *testing.T) {
	env, isolated := probeEnv(t, deadRow{updatedAgo: "8 days", deadLetteredAgo: "8 days"})

	st, detail, err := probeBillingDLQ(context.Background(), env)
	if err != nil {
		t.Fatal(err)
	}
	requireOneIsolatedRead(t, isolated)
	if st != ops.StatusRed {
		t.Fatalf("a dead-lettered event is RED, got %q", st)
	}
	if detail == "" {
		t.Fatal("a red check must carry a detail line an operator can act on")
	}
	if want := "1 dead-lettered event(s), oldest "; !strings.HasPrefix(detail, want) {
		t.Fatalf("detail %q, want it to start %q: the one dead event, counted and dated", detail, want)
	}
}

// dlqDepthPool fails (deterministically, no auto-migration — mirroring
// pushCanaryPool) when ops_billing_dlq_depth() has not been re-created by
// migration 1702, i.e. its body still computes oldest_dead_at from
// updated_at instead of dead_lettered_at.
func dlqDepthPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool := testPool(t)

	var src string
	if err := pool.QueryRow(context.Background(),
		`SELECT prosrc FROM pg_proc WHERE proname = 'ops_billing_dlq_depth'`).Scan(&src); err != nil {
		t.Fatalf("ops_billing_dlq_depth() missing: apply infra/migrations/1700_ops_console.sql (%v)", err)
	}
	if !strings.Contains(src, "dead_lettered_at") {
		t.Fatalf("ops_billing_dlq_depth() predates the oldest_dead_at fix: apply infra/migrations/1702_ops_billing_dlq_oldest_dead_at.sql")
	}
	return pool
}

// TestOpsBillingDLQDepth_OldestUsesDeadLetteredAtNotUpdatedAt pins the 1702
// fix. 1700 computed oldest_dead_at as min(updated_at); any later touch of a
// dead row (a replay attempt sets updated_at = now()) made the RED alert say
// "oldest 0s ago" for an event dead-lettered 8 days earlier — understating
// incident age by a week during exactly the incident it exists to describe.
func TestOpsBillingDLQDepth_OldestUsesDeadLetteredAtNotUpdatedAt(t *testing.T) {
	// A "replayed" dead row: dead-lettered 8 days ago, but touched just now.
	tx := dlqTx(t, dlqDepthPool(t), deadRow{updatedAgo: "0 seconds", deadLetteredAgo: "8 days"})

	var dead int64
	var oldest *time.Time
	if err := tx.QueryRow(context.Background(),
		`SELECT dead_count, oldest_dead_at FROM ops_billing_dlq_depth()`).Scan(&dead, &oldest); err != nil {
		t.Fatalf("ops_billing_dlq_depth(): %v", err)
	}

	if dead != 1 {
		t.Fatalf("dead_count = %d, want 1", dead)
	}
	if oldest == nil {
		t.Fatal("oldest_dead_at is NULL for a dead-lettered row")
	}
	age := time.Since(*oldest)
	if age < 7*24*time.Hour {
		t.Fatalf("oldest_dead_at must reflect dead_lettered_at (~8 days ago), not updated_at (now); got age %s", age)
	}
	if age > 9*24*time.Hour {
		t.Fatalf("oldest_dead_at implausibly old: got age %s, inserted 8 days ago", age)
	}
}

// TestOpsBillingDLQDepth_LegacyRowWithoutDeadLetteredAtStillCounts pins the
// coalesce fallback: a legacy row that reached status='dead_lettered' before
// dead_lettered_at was populated must still be counted and dated (by
// updated_at) rather than reporting oldest_dead_at = NULL.
func TestOpsBillingDLQDepth_LegacyRowWithoutDeadLetteredAtStillCounts(t *testing.T) {
	tx := dlqTx(t, dlqDepthPool(t), deadRow{updatedAgo: "3 days", deadLetteredAgo: ""})

	var dead int64
	var oldest *time.Time
	if err := tx.QueryRow(context.Background(),
		`SELECT dead_count, oldest_dead_at FROM ops_billing_dlq_depth()`).Scan(&dead, &oldest); err != nil {
		t.Fatalf("ops_billing_dlq_depth(): %v", err)
	}

	if dead != 1 {
		t.Fatalf("dead_count = %d, want 1", dead)
	}
	if oldest == nil {
		t.Fatal("oldest_dead_at must fall back to updated_at for a legacy row, got NULL")
	}
	if age := time.Since(*oldest); age < 2*24*time.Hour || age > 4*24*time.Hour {
		t.Fatalf("oldest_dead_at fallback should be ~3 days old (updated_at), got age %s", age)
	}
}
