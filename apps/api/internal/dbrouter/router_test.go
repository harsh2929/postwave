// SPDX-License-Identifier: AGPL-3.0-only

package dbrouter

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// newTestPool returns a distinct, never-connected *pgxpool.Pool usable only
// for pointer-identity comparisons in these tests (nothing here issues a
// real query).
func newTestPool() *pgxpool.Pool {
	return &pgxpool.Pool{}
}

func TestForWrite_AlwaysPrimary(t *testing.T) {
	primary := newTestPool()
	replica := newTestPool()
	r := NewRouter(primary, replica)

	if got := r.ForWrite(context.Background()); got != primary {
		t.Errorf("ForWrite() = %p, want primary %p", got, primary)
	}

	// Even with a sticky/written context, writes still go to primary.
	ctx := MarkWrote(context.Background())
	if got := r.ForWrite(ctx); got != primary {
		t.Errorf("ForWrite(written ctx) = %p, want primary %p", got, primary)
	}
}

func TestForRead_NoReplicaConfigured(t *testing.T) {
	primary := newTestPool()
	r := NewRouter(primary, nil)

	if got := r.ForRead(context.Background()); got != primary {
		t.Errorf("ForRead() with no replica = %p, want primary %p", got, primary)
	}
	if r.HasReplica() {
		t.Error("HasReplica() = true, want false when Replica is nil")
	}
}

func TestForRead_WithReplica_RoutesToReplica(t *testing.T) {
	primary := newTestPool()
	replica := newTestPool()
	r := NewRouter(primary, replica)

	if !r.HasReplica() {
		t.Fatal("HasReplica() = false, want true")
	}
	if got := r.ForRead(context.Background()); got != replica {
		t.Errorf("ForRead() = %p, want replica %p", got, replica)
	}
}

func TestForRead_StickyAfterWrite_RoutesToPrimary(t *testing.T) {
	primary := newTestPool()
	replica := newTestPool()
	r := NewRouter(primary, replica) // StickyAfterWrite defaults true

	ctx := MarkWrote(context.Background())
	if got := r.ForRead(ctx); got != primary {
		t.Errorf("ForRead(written ctx) = %p, want primary %p (sticky)", got, primary)
	}

	// A derived child context keeps the sticky flag.
	child, cancel := context.WithCancel(ctx)
	defer cancel()
	if got := r.ForRead(child); got != primary {
		t.Errorf("ForRead(derived written ctx) = %p, want primary %p", got, primary)
	}

	// An unrelated, non-written context is unaffected.
	if got := r.ForRead(context.Background()); got != replica {
		t.Errorf("ForRead(fresh ctx) = %p, want replica %p", got, replica)
	}
}

func TestForRead_StickyAfterWriteDisabled_StaysOnReplica(t *testing.T) {
	primary := newTestPool()
	replica := newTestPool()
	r := NewRouter(primary, replica)
	r.StickyAfterWrite = false

	ctx := MarkWrote(context.Background())
	if got := r.ForRead(ctx); got != replica {
		t.Errorf("ForRead(written ctx, sticky disabled) = %p, want replica %p", got, replica)
	}
}

func TestHasWritten(t *testing.T) {
	if HasWritten(context.Background()) {
		t.Error("HasWritten(fresh context) = true, want false")
	}
	ctx := MarkWrote(context.Background())
	if !HasWritten(ctx) {
		t.Error("HasWritten(marked context) = false, want true")
	}
}

func TestRoute_ClassifiesAndDispatches(t *testing.T) {
	primary := newTestPool()
	replica := newTestPool()
	r := NewRouter(primary, replica)

	if got := r.Route(context.Background(), `SELECT id FROM subscribers`); got != replica {
		t.Errorf("Route(select) = %p, want replica %p", got, replica)
	}
	if got := r.Route(context.Background(), `UPDATE subscribers SET status = 'x'`); got != primary {
		t.Errorf("Route(update) = %p, want primary %p", got, primary)
	}

	// After a write is marked, even a SELECT stays on primary.
	ctx := MarkWrote(context.Background())
	if got := r.Route(ctx, `SELECT id FROM subscribers`); got != primary {
		t.Errorf("Route(select, written ctx) = %p, want primary %p", got, primary)
	}
}

func TestRouter_NilSafe(t *testing.T) {
	var r *Router
	if got := r.ForRead(context.Background()); got != nil {
		t.Errorf("nil Router.ForRead() = %p, want nil", got)
	}
	if got := r.ForWrite(context.Background()); got != nil {
		t.Errorf("nil Router.ForWrite() = %p, want nil", got)
	}
	if r.HasReplica() {
		t.Error("nil Router.HasReplica() = true, want false")
	}
}

func TestNewRouter_InertWithoutReplica(t *testing.T) {
	// Documents the "inert until a replica is configured" guarantee: a
	// Router built with no replica pool reproduces today's single-pool
	// behavior for every read and write.
	primary := newTestPool()
	r := NewRouter(primary, nil)

	queries := []string{
		`SELECT * FROM subscribers`,
		`INSERT INTO subscribers (email) VALUES ('a@b.com')`,
		`WITH x AS (SELECT 1) SELECT * FROM x`,
	}
	for _, q := range queries {
		if got := r.Route(context.Background(), q); got != primary {
			t.Errorf("Route(%q) with no replica = %p, want primary %p", q, got, primary)
		}
	}
}
