// SPDX-License-Identifier: AGPL-3.0-only

package pushstatetest

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func adminPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	if dsn == "" {
		t.Skip("POSTWAVE_TEST_ADMIN_DATABASE_URL not set")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// holderPID returns the backend that holds the lock in this database now, or
// 0 if none does.
func holderPID(t *testing.T, pool *pgxpool.Pool) int32 {
	t.Helper()
	var pid int32
	if err := pool.QueryRow(context.Background(), `
		SELECT coalesce(min(l.pid), 0) FROM pg_locks AS l WHERE `+heldKeyPredicate, lockKey).Scan(&pid); err != nil {
		t.Fatalf("reading the lock's holder from pg_locks: %v", err)
	}
	return pid
}

// appNameLimit is how much of an application_name pg_stat_activity keeps:
// NAMEDATALEN - 1 bytes.
const appNameLimit = 63

// lockSessionName is the application_name pg_stat_activity shows for the
// session Lock opened for t.
func lockSessionName(t testing.TB) string {
	name := holderPrefix + t.Name()
	if len(name) > appNameLimit {
		name = name[:appNameLimit]
	}
	return name
}

// requireOwnSessionHolds fails t unless the lock is held now, in this
// database, by the session Lock opened for t, and returns that session's pid.
// It matches the session's exact name, not holderPrefix: every test's Lock
// session carries the prefix, so a prefix match would accept another test's.
func requireOwnSessionHolds(t *testing.T, pool *pgxpool.Pool) int32 {
	t.Helper()
	pid := holderPID(t, pool)
	if pid == 0 {
		t.Fatal("pg_locks shows no holder for the ops_push_state test lock while this test holds it")
	}
	var app string
	if err := pool.QueryRow(context.Background(),
		`SELECT application_name FROM pg_stat_activity WHERE pid = $1`, pid).Scan(&app); err != nil {
		t.Fatalf("reading the holder's session: %v", err)
	}
	if want := lockSessionName(t); app != want {
		t.Fatalf("the lock is held by session %d (%q), not by the session Lock opened for this test (%q)",
			pid, app, want)
	}
	return pid
}

// The lock must belong to a session, not a transaction. A transaction-level
// lock (pg_advisory_xact_lock) is released when its own statement commits,
// so Lock would return holding nothing and the two packages would run
// unserialized again, with every test still passing on its own.
func TestLock_IsStillHeldAfterItReturns(t *testing.T) {
	pool := adminPool(t)
	ctx := context.Background()

	Lock(t, pool)

	other, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquiring a second session: %v", err)
	}
	defer other.Release()
	var got bool
	if err := other.QueryRow(ctx,
		`SELECT pg_try_advisory_lock(hashtextextended($1, 0))`, lockKey).Scan(&got); err != nil {
		t.Fatalf("pg_try_advisory_lock from a second session: %v", err)
	}
	if got {
		_, _ = other.Exec(ctx, `SELECT pg_advisory_unlock(hashtextextended($1, 0))`, lockKey)
		t.Fatal("a second session took the ops_push_state test lock while this test held it; " +
			"Lock returned without holding anything")
	}

	// The holder is the session Lock opened for this test, and not one of the
	// pool's: the pool under test must keep all of its connections.
	requireOwnSessionHolds(t, pool)
}

// The lock must end with the test that took it. Otherwise every test in the
// other package waits out lockWait and fails.
//
// Another binary may take the lock the moment it is released, so this checks
// the session that held it, not whether the lock is free.
func TestLock_IsReleasedWhenTheTestEnds(t *testing.T) {
	pool := adminPool(t)

	var pid int32
	t.Run("holder", func(t *testing.T) {
		Lock(t, pool)
		pid = requireOwnSessionHolds(t, pool)
	})
	if t.Failed() {
		return
	}

	var stillHeld bool
	if err := pool.QueryRow(context.Background(), `
		SELECT EXISTS (SELECT 1 FROM pg_locks AS l WHERE `+heldKeyPredicate+` AND l.pid = $2)`,
		lockKey, pid).Scan(&stillHeld); err != nil {
		t.Fatalf("reading pg_locks: %v", err)
	}
	if stillHeld {
		t.Fatalf("session %d still holds the ops_push_state test lock after the test that took it ended", pid)
	}
}

// Advisory locks are per database, but pg_locks lists the whole server's. When
// the same tests run against another copy of the database on a shared server,
// a session there holds the same key without blocking Lock here. It must not
// be reported as this lock's holder: the timeout message would name the wrong
// session, and the two tests above would fail naming it.
func TestLock_AHolderInAnotherDatabaseIsNotThisLocksHolder(t *testing.T) {
	pool := adminPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	// A scratch database beside this one. template0 accepts no connections,
	// so no other session can make CREATE DATABASE fail by using it.
	name := "postwave_pushstatetest_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	quoted := pgx.Identifier{name}.Sanitize()
	if _, err := pool.Exec(ctx, "CREATE DATABASE "+quoted+" TEMPLATE template0"); err != nil {
		t.Fatalf("creating a scratch database: %v", err)
	}
	// Registered after adminPool's Close, so it runs first: cleanups are
	// last-in first-out.
	t.Cleanup(func() {
		dropCtx, dropCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer dropCancel()
		if _, err := pool.Exec(dropCtx, "DROP DATABASE IF EXISTS "+quoted+" WITH (FORCE)"); err != nil {
			t.Errorf("dropping scratch database %s: %v", name, err)
		}
	})

	// A session in the scratch database takes the same key.
	const foreignName = "pushstatetest foreign holder"
	cfg := pool.Config().ConnConfig
	cfg.Database = name
	if cfg.RuntimeParams == nil {
		cfg.RuntimeParams = map[string]string{}
	}
	cfg.RuntimeParams["application_name"] = foreignName
	foreign, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("connecting to the scratch database: %v", err)
	}
	// Runs before the drop above.
	t.Cleanup(func() { _ = foreign.Close(context.Background()) })
	var foreignPID int32
	if err := foreign.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&foreignPID); err != nil {
		t.Fatalf("reading the scratch session's pid: %v", err)
	}
	if _, err := foreign.Exec(ctx, `SELECT pg_advisory_lock(hashtextextended($1, 0))`, lockKey); err != nil {
		t.Fatalf("taking the key in the scratch database: %v", err)
	}

	// Setup check: seen from here, pg_locks does list that session as holding
	// the key, so the assertions below are about the database filter and not
	// about a lock that was never taken or a key that decodes differently.
	var heldServerWide bool
	if err := pool.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM pg_locks AS l
		                WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
		                  AND ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended($1, 0)
		                  AND l.pid = $2)`, lockKey, foreignPID).Scan(&heldServerWide); err != nil {
		t.Fatalf("reading pg_locks: %v", err)
	}
	if !heldServerWide {
		t.Fatalf("pg_locks does not show scratch session %d holding the key", foreignPID)
	}

	var counted bool
	if err := pool.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM pg_locks AS l WHERE `+heldKeyPredicate+` AND l.pid = $2)`,
		lockKey, foreignPID).Scan(&counted); err != nil {
		t.Fatalf("reading pg_locks: %v", err)
	}
	if counted {
		t.Fatalf("session %d holds the key in database %s, and is counted as holding this database's lock",
			foreignPID, name)
	}
	if holders := describeHolders(pool); strings.Contains(holders, foreignName) {
		t.Fatalf("the timeout message would name the scratch database's session as the holder: %s", holders)
	}

	// Lock is not blocked by that session, and once it returns, the holder
	// reported here is Lock's own session even though the scratch session,
	// connected first, usually has the lower pid.
	Lock(t, pool)
	requireOwnSessionHolds(t, pool)
}
