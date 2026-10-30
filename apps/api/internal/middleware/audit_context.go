// SPDX-License-Identifier: AGPL-3.0-only
//
// audit_context.go — context-stash for db.AuditMeta + per-request
// "audit aspect" payload so handlers can defer the audit_log write to
// a chi-route middleware (see audit_aspect.go) instead of repeating
// the WithTenant / db.Audit boilerplate themselves.
//
// Phase 1a cross-cutting (audit-emit-helper, P1):
//
//	Before this file every handler that wanted a typed audit row had to
//	1. middleware.AuditMetaFromRequest(r)
//	2. db.WithTenant(...)
//	3. db.Audit(...)
//	4. tx.Commit(...)
//	    on every mutation, with subtle drift across packages (some
//	    forgot Commit, some used the request ctx and lost the row when
//	    the client disconnected mid-200). audit.Emit centralises that;
//	    this file gives Emit the context plumbing it needs.
//
// Two independent stashes:
//
//	auditMetaCtxKey   — pre-computed db.AuditMeta. Populated by the
//	                    apikey / session middleware once per request so
//	                    audit.Emit doesn't need r at call sites that
//	                    only have ctx (workers, queue consumers, deeply
//	                    nested service code).
//	auditAspectCtxKey — mutable "what just changed" payload populated
//	                    by handlers via AuditAttach; harvested by
//	                    MutatingAspect on the way out.
package middleware

import (
	"context"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// auditCtxKey is a private context-key type so we don't collide with
// anything else in this package's iota chain.
type auditCtxKey int

const (
	ctxKeyAuditMeta auditCtxKey = iota + 1
	ctxKeyAuditAspect
)

// WithAuditMeta stashes a pre-computed db.AuditMeta on ctx so downstream
// code (handlers, the MutatingAspect post-response emit, background
// workers spawned mid-request) can read it without re-deriving from r.
//
// Safe to call with an empty meta; AuditMetaFromContext will still
// report ok=false when TenantID is unset so callers can short-circuit.
func WithAuditMeta(ctx context.Context, meta db.AuditMeta) context.Context {
	return context.WithValue(ctx, ctxKeyAuditMeta, meta)
}

// AuditMetaFromContext returns the meta previously attached by
// WithAuditMeta. ok=false when nothing was attached OR when the
// attached meta has no tenant (an empty struct is effectively useless
// for an audit_log row — RLS would reject it anyway).
func AuditMetaFromContext(ctx context.Context) (db.AuditMeta, bool) {
	v, ok := ctx.Value(ctxKeyAuditMeta).(db.AuditMeta)
	if !ok {
		return db.AuditMeta{}, false
	}
	if v.TenantID == "" {
		return v, false
	}
	return v, true
}

// AuditAspect is the mutable payload a handler hands back to the
// MutatingAspect middleware describing what resource it touched and
// what the before/after state looked like. Captured on the way out so
// the middleware can emit a single canonical audit_log row instead of
// each handler repeating the WithTenant / db.Audit dance.
//
// All fields are optional except ResourceID — handlers that don't yet
// know which row they're mutating (e.g. POST /resource where the id is
// generated server-side) should call AuditAttach after the row is
// inserted, before returning. Aspect emits with ResourceID="" if the
// handler never attached anything — a forensics row tagged
// "<action>.unattached" so the gap is visible.
type AuditAspect struct {
	ResourceID string
	Before     any
	After      any
	// Metadata is merged into the final audit_log.metadata under a
	// "context" sub-key so callers can attach arbitrary fields (e.g.
	// "diff_field_count": 3, "soft_delete": true) without colliding
	// with the canonical before/after.
	Metadata map[string]any
	// Skip, when true, instructs MutatingAspect to NOT emit a row even
	// on a 2xx response. Use this for handlers that already wrote a
	// more precise audit row themselves (e.g. bulk operations that
	// emit one row per item) so we don't double-log.
	Skip bool
}

// AuditAttach lets a handler populate the AuditAspect payload. Safe to
// call multiple times — the last call wins. Safe to call with an
// unstashed ctx (no MutatingAspect wrapping the route) — becomes a
// no-op so handlers can be hoisted in/out of the aspect without
// guarding every call site.
//
// Returns the ctx so the call composes nicely:
//
//	ctx = middleware.AuditAttach(ctx, sub.ID, before, after, nil)
func AuditAttach(ctx context.Context, resourceID string, before, after any, metadata map[string]any) context.Context {
	holder, ok := ctx.Value(ctxKeyAuditAspect).(*AuditAspect)
	if !ok || holder == nil {
		// No aspect wrapper on this route — silently no-op.
		return ctx
	}
	holder.ResourceID = resourceID
	holder.Before = before
	holder.After = after
	if metadata != nil {
		holder.Metadata = metadata
	}
	return ctx
}

// AuditSkip marks the current aspect as "do not emit". Use from a
// handler that already wrote one or more precise audit rows itself
// (bulk import, fan-out actions).
func AuditSkip(ctx context.Context) {
	if holder, ok := ctx.Value(ctxKeyAuditAspect).(*AuditAspect); ok && holder != nil {
		holder.Skip = true
	}
}

// withAuditAspect attaches a fresh AuditAspect holder. Called by
// MutatingAspect at the top of the chain; handlers downstream mutate
// the holder via AuditAttach.
//
// Internal — exposed as MutatingAspect's behavior, not for direct use.
func withAuditAspect(ctx context.Context, h *AuditAspect) context.Context {
	return context.WithValue(ctx, ctxKeyAuditAspect, h)
}

// auditAspectFromContext returns the holder previously attached by
// withAuditAspect. Internal — MutatingAspect harvests on the way out.
func auditAspectFromContext(ctx context.Context) (*AuditAspect, bool) {
	v, ok := ctx.Value(ctxKeyAuditAspect).(*AuditAspect)
	return v, ok && v != nil
}
