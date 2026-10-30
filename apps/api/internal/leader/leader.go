// SPDX-License-Identifier: AGPL-3.0-only

// Package leader gives a scheduled worker single-flight execution across
// horizontally-scaled API instances using a Postgres session advisory lock.
// Without it, every replica runs every ticker — harmless for SKIP-LOCKED drain
// loops, but a real race for singleton DDL work (e.g. the partition rotator).
// Run wraps a unit of work: exactly one instance that wins the lock executes it;
// the others skip this tick.
package leader

import (
	"context"
	"hash/fnv"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// key derives a stable bigint advisory-lock key from a worker name.
func key(name string) int64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte(name))
	return int64(h.Sum64())
}

// Run executes fn iff this instance wins the advisory lock for name; otherwise
// it returns ran=false and the caller skips the tick. The lock is a session lock
// held on a dedicated pooled connection for the duration of fn and released
// afterwards, so a crash mid-fn frees it when the backend connection drops.
func Run(ctx context.Context, pool *db.Pool, name string, fn func(context.Context) error) (ran bool, err error) {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return false, err
	}
	defer conn.Release()

	k := key(name)
	var got bool
	if err := conn.QueryRow(ctx, "SELECT pg_try_advisory_lock($1)", k).Scan(&got); err != nil {
		return false, err
	}
	if !got {
		return false, nil // another instance holds it
	}
	// Best-effort unlock on the same connection; a dropped connection releases
	// it automatically, so ignore the unlock error.
	defer func() { _, _ = conn.Exec(context.Background(), "SELECT pg_advisory_unlock($1)", k) }()

	return true, fn(ctx)
}
