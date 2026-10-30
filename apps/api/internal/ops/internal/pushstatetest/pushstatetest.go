// SPDX-License-Identifier: AGPL-3.0-only

// Package pushstatetest serializes, across test binaries, every test that
// resets or asserts on ops_push_state.
//
// ops_push_state holds a deployment singleton: the '__push_loop__' heartbeat
// row. ops.Pusher.Tick stamps it and the push canary in internal/ops/checks
// reads it, and by design neither can be pointed at another row: one
// deployment has one push loop, and the canary must read the row that loop
// writes. The push tests in internal/ops reset the table and assert on that
// row (one asserts the whole table stays empty), and the canary tests in
// internal/ops/checks clear the row and assert on it too. `go test ./...` runs
// the two packages as separate processes against one database, so without a
// shared lock each package wipes and rewrites state the other is asserting
// on: a canary test reads a heartbeat it never wrote, and a push test loses
// the damping streak it persisted a tick earlier.
//
// The rule: every test, in any package, that writes, clears or asserts on
// ops_push_state calls Lock before touching it. One helper in one package,
// so there is exactly one key and one way of taking it.
//
// Only test files import this package. It lives under internal/ops/internal,
// so nothing outside internal/ops can import it at all.
package pushstatetest

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// lockKey names the session-level advisory lock, keyed by
// hashtextextended(lockKey, 0). That is a different key from the production
// push loop's hashtext('ops_push_tick'), which TestPush_TickSkipsWhenLockHeld
// takes while holding this one; a collision would fail that test at once.
const lockKey = "postwave-test:ops_push_state"

// lockWait bounds the wait for another holder. Each holder is one test that
// takes milliseconds, so the bound only matters when a holder leaks the lock:
// the waiter then fails naming the holder, rather than hanging until
// `go test -timeout` kills the whole binary without saying why.
const lockWait = 2 * time.Minute

// holderPrefix starts the application_name of every holder's session, so a
// timed-out waiter, or an operator looking at pg_stat_activity, can see which
// test holds the lock.
const holderPrefix = "ops_push_state test lock: "

// Lock blocks until t holds the cross-package ops_push_state lock, and
// releases it when t ends.
//
// The lock is taken on a dedicated connection opened from pool's
// configuration, outside the pool itself, so the pool under test keeps its
// full capacity and its own connections never hold the lock. The release is
// registered as a cleanup here. Cleanups run last-in first-out, so every
// cleanup the caller registers after Lock returns (removing the rows the test
// wrote, for example) still runs while the lock is held.
func Lock(t testing.TB, pool *pgxpool.Pool) {
	t.Helper()

	// pool.Config returns a deep copy, so this does not rename the pool's
	// own sessions.
	cfg := pool.Config().ConnConfig
	if cfg.RuntimeParams == nil {
		cfg.RuntimeParams = map[string]string{}
	}
	cfg.RuntimeParams["application_name"] = holderPrefix + t.Name()

	ctx, cancel := context.WithTimeout(context.Background(), lockWait)
	defer cancel()
	conn, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("connecting for the ops_push_state test lock: %v", err)
	}
	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock(hashtextextended($1, 0))`, lockKey); err != nil {
		_ = conn.Close(context.Background())
		t.Fatalf("waiting %s for the ops_push_state test lock: %v (held by: %s)",
			lockWait, err, describeHolders(pool))
	}
	t.Cleanup(func() {
		var released bool
		unlockErr := conn.QueryRow(context.Background(),
			`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, lockKey).Scan(&released)
		closeErr := conn.Close(context.Background())
		if unlockErr != nil || !released || closeErr != nil {
			t.Errorf("releasing the ops_push_state test lock: released=%v unlock err=%v close err=%v",
				released, unlockErr, closeErr)
		}
	})
}

// describeHolders names the sessions that hold the lock right now, for the
// timeout message. It reports what it can: this runs only on a path that is
// already failing.
func describeHolders(pool *pgxpool.Pool) string {
	var holders string
	if err := pool.QueryRow(context.Background(), `
		SELECT coalesce(string_agg(a.pid::text || ' ' || a.application_name, '; '), 'nobody')
		  FROM pg_locks AS l
		  JOIN pg_stat_activity AS a USING (pid)
		 WHERE `+heldKeyPredicate, lockKey).Scan(&holders); err != nil {
		return "unknown (" + err.Error() + ")"
	}
	return holders
}

// heldKeyPredicate matches the pg_locks row of a granted session lock on
// hashtextextended($1, 0) in the current database. PostgreSQL shows a bigint
// advisory key split in two: the high half in classid, the low half in objid,
// with objsubid 1.
//
// Advisory locks are per database, but pg_locks lists the whole server's. On
// a server that hosts several copies of the test database, the same tests
// running against another copy hold the same key there, and that session
// neither blocks Lock nor is blocked by it. Without the database filter it
// would still be named as this lock's holder.
const heldKeyPredicate = `l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
		   AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
		   AND ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended($1, 0)`
