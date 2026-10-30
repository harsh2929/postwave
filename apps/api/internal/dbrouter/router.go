// SPDX-License-Identifier: AGPL-3.0-only
//
// router.go — read-replica routing layer (G-33).
//
// There is (today) no read replica: MaxConns=50 is shared by both the
// dispatch/send loop and every read-heavy handler and dashboard query, and
// they compete for the same pool. This package is the routing LAYER for
// when a replica exists — pure logic, no infra provisioning. It holds a
// primary pool plus an optional replica pool and exposes:
//
//	r.ForWrite(ctx)  -> always the primary pool
//	r.ForRead(ctx)   -> the replica pool, unless none is configured or the
//	                    context is marked "has written" (see StickyAfterWrite)
//	r.Route(ctx, sql) -> classifies sql via IsReadOnlyQuery and dispatches
//
// When Replica is nil (the current, unconfigured state), ForRead returns
// Primary — this package is inert-safe: wiring it in with no replica pool
// reproduces exactly today's behavior.
package dbrouter

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Router routes read and write traffic between a primary pool and an
// optional replica pool.
type Router struct {
	// Primary is the pool every write goes to, and every read falls back to
	// when no replica is configured or the request is sticky. Must not be
	// nil for a Router to be usable.
	Primary *pgxpool.Pool

	// Replica is the read-replica pool. nil means "no replica configured" —
	// the safe default that reproduces current (single-pool) behavior.
	Replica *pgxpool.Pool

	// StickyAfterWrite, when true, makes ForRead return Primary for any
	// context that has been marked via MarkWrote — i.e. once a request (or
	// transaction scope) has issued a write, its subsequent reads stay on
	// Primary rather than risking observing a replica that hasn't caught up
	// with the write it just made ("read your own write"). NewRouter sets
	// this true by default; flip it off only if the caller has an
	// out-of-band reason to accept replica lag after a write (e.g. reads
	// that are known not to depend on the just-written row).
	StickyAfterWrite bool
}

// NewRouter constructs a Router with StickyAfterWrite enabled. primary must
// not be nil. replica may be nil (no replica configured).
func NewRouter(primary, replica *pgxpool.Pool) *Router {
	return &Router{
		Primary:          primary,
		Replica:          replica,
		StickyAfterWrite: true,
	}
}

// HasReplica reports whether a replica pool is configured.
func (r *Router) HasReplica() bool {
	return r != nil && r.Replica != nil
}

// ForWrite returns the pool every write must use: always Primary. A replica
// (physical streaming replication) cannot accept writes, so there is no
// alternative to consider here — this method exists mainly so call sites
// read symmetrically with ForRead and so a Router is a drop-in place to add
// write-side concerns later (e.g. write fencing) without changing callers.
func (r *Router) ForWrite(ctx context.Context) *pgxpool.Pool {
	if r == nil {
		return nil
	}
	return r.Primary
}

// ForRead returns the pool a read should use: Replica when one is
// configured and the context isn't sticky, Primary otherwise (no replica
// configured, StickyAfterWrite disabled-or-triggered).
func (r *Router) ForRead(ctx context.Context) *pgxpool.Pool {
	if r == nil {
		return nil
	}
	if r.Replica == nil {
		return r.Primary
	}
	if r.StickyAfterWrite && HasWritten(ctx) {
		return r.Primary
	}
	return r.Replica
}

// Route classifies sql with IsReadOnlyQuery and returns ForWrite's pool for
// writes, ForRead's pool otherwise. This is the single call site most
// callers want: pass the query text, get back the right pool.
func (r *Router) Route(ctx context.Context, sql string) *pgxpool.Pool {
	if !IsReadOnlyQuery(sql) {
		return r.ForWrite(ctx)
	}
	return r.ForRead(ctx)
}

// ctxKey is an unexported type so keys set by this package can never
// collide with keys set by other packages using context.WithValue.
type ctxKey struct{ name string }

var wroteKey = ctxKey{"dbrouter.wrote"}

// MarkWrote returns a context derived from ctx that records "a write has
// happened in this request/transaction scope". Callers should thread the
// returned context into subsequent ForRead/Route calls (directly or via
// anything derived from it) so StickyAfterWrite, if enabled, keeps those
// reads on Primary.
func MarkWrote(ctx context.Context) context.Context {
	return context.WithValue(ctx, wroteKey, true)
}

// HasWritten reports whether MarkWrote has been applied to ctx or any of
// its ancestors.
func HasWritten(ctx context.Context) bool {
	v, _ := ctx.Value(wroteKey).(bool)
	return v
}
