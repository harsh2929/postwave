// SPDX-License-Identifier: AGPL-3.0-only
//
// emit.go — single-call helper for writing a typed audit_log row from
// any package that already has a context. Standardises the historical
// 4-step boilerplate (WithTenant + AuditMetaFromRequest + db.Audit +
// tx.Commit) into one function so callers can't accidentally:
//
//   - forget Commit (audit row silently rolled back)
//   - use the request ctx (mid-200 client disconnects drop the row)
//   - skip the redaction hook (db.Audit runs it; ad-hoc inserts don't)
//   - format metadata differently per package (Compliance UI parses
//     a stable shape: {before, after, context})
//
// Phase 1a cross-cutting (audit-emit-helper, P1). See
// MIGRATION_RECIPE.md in this directory for how to port a handler off
// the boilerplate to Emit / MutatingAspect.
//
// Companion to middleware.MutatingAspect: Aspect is the declarative
// wrapper for "one route, one row on 2xx"; Emit is the imperative
// helper for mid-handler or worker emits where Aspect can't reach.
package audit

import (
	"context"
	"fmt"
	"log/slog"
	"sync/atomic"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// EmitHook is the test/recorder interception point. When installed via
// SetEmitHookForTest, every Emit / EmitOrLog call short-circuits into
// the hook with the resolved AuditMeta + payload, bypassing the DB
// write. Production never installs this hook; it exists so handler
// unit tests in the consumer packages can assert "one audit row per
// mutation" without spinning up Postgres.
//
// The hook receives:
//
//	tenantID   resolved from ctx (or fallback meta)
//	action     e.g. "tag.create"
//	resource   e.g. "tag"
//	resourceID domain id
//	payload    the canonical {before, after, context} map
//
// Return a non-nil error to make the Emit() return surface that
// error; production callers using EmitOrLog will see a slog.Warn.
type EmitHook func(
	ctx context.Context,
	tenantID string,
	action string,
	resource string,
	resourceID string,
	payload map[string]any,
) error

var emitHook atomic.Pointer[EmitHook]

// SetEmitHookForTest installs the test interception hook. Pass nil to
// clear. SAFE for parallel tests as long as each test cleans up via
// t.Cleanup; a global hook is the simplest contract that lets every
// consumer package run handler-level tests without a DB. Production
// must never call this (and there's no public path that does).
func SetEmitHookForTest(fn EmitHook) {
	if fn == nil {
		emitHook.Store(nil)
		return
	}
	emitHook.Store(&fn)
}

// Emit writes a typed audit_log row, resolving tenant + actor from
// ctx. The caller is responsible for having already populated ctx via
// middleware.WithAuditMeta (the apikey / session / aspect middlewares
// do this automatically) OR via a manual middleware.WithTenant +
// WithActor pair (workers, queue consumers).
//
// Signature aligned with the cross-cutting spec
// (p1-audit-emit-helper):
//
//	action       e.g. "subscriber.create", "campaign.send"
//	resource     e.g. "subscriber", "campaign"; "" -> NULL
//	resourceID   domain id; "" -> NULL (use for "no specific row" actions)
//	before       any  — JSON-encodable; nil omits the key
//	after        any  — JSON-encodable; nil omits the key
//	metadata     any  — merged under "context"; nil omits the key
//
// Returns an error when the underlying audit_log write fails so
// callers can choose to surface (test wiring) or swallow (production
// best-effort, see EmitOrLog). Production callers should prefer
// EmitOrLog — losing an audit row should never bubble up as a 500.
func Emit(
	ctx context.Context,
	pool *db.Pool,
	action string,
	resource string,
	resourceID string,
	before any,
	after any,
	metadata any,
) error {
	if action == "" {
		return fmt.Errorf("audit.Emit: action is required")
	}

	meta, ok := middleware.AuditMetaFromContext(ctx)
	if !ok {
		// Fallback: a worker may have set up only the bare
		// tenant + actor pieces without going through
		// AuditMetaFromRequest. Build a minimal meta from
		// whatever ctx does have.
		meta = buildFallbackMeta(ctx)
	}
	if meta.TenantID == "" {
		return fmt.Errorf("audit.Emit: no tenant_id on ctx")
	}

	payload := buildPayloadWithCorrelation(before, after, metadata, meta.RequestID)

	// Test interception: if a hook is installed, short-circuit BEFORE
	// the pool guard so handler-level tests can pass nil. Lets
	// consumers run handler tests without a Postgres fixture.
	// Production never sets this hook.
	if h := emitHook.Load(); h != nil && *h != nil {
		return (*h)(ctx, meta.TenantID, action, resource, resourceID, payload)
	}

	if pool == nil {
		return fmt.Errorf("audit.Emit: pool is required")
	}

	// Fresh ctx so a cancelled caller ctx doesn't roll back the
	// audit row mid-write. Same rationale used by the existing
	// AuditMiddleware / AuditMetaMiddleware emit paths.
	bgCtx := context.Background()
	tx, err := db.WithTenant(bgCtx, pool, meta.TenantID)
	if err != nil {
		return fmt.Errorf("audit.Emit: tx begin: %w", err)
	}
	defer func() { _ = tx.Rollback(bgCtx) }()

	if err := db.Audit(bgCtx, tx, meta, action, resource, resourceID, payload); err != nil {
		return fmt.Errorf("audit.Emit: write: %w", err)
	}
	if err := tx.Commit(bgCtx); err != nil {
		return fmt.Errorf("audit.Emit: commit: %w", err)
	}
	return nil
}

// EmitOrLog wraps Emit with the production failure mode: log a warning
// and return. Use this from handler bodies where a transient audit DB
// hiccup must never surface as a user-visible 500.
//
//	defer audit.EmitOrLog(ctx, pool, "subscriber.delete", "subscriber", id, before, nil, nil)
func EmitOrLog(
	ctx context.Context,
	pool *db.Pool,
	action string,
	resource string,
	resourceID string,
	before any,
	after any,
	metadata any,
) {
	if err := Emit(ctx, pool, action, resource, resourceID, before, after, metadata); err != nil {
		slog.Warn("audit.Emit failed",
			"action", action,
			"resource", resource,
			"resource_id", resourceID,
			"err", err,
		)
	}
}

// buildPayload assembles the canonical metadata blob handed to
// db.Audit. We never drop the keys silently — omitting them on nil
// makes the consumer's UI render a cleaner "no before-state" rather
// than {"before": null}.
//
// Any extra `metadata` argument is wrapped in a "context" sub-key so it
// can't collide with the canonical before/after keys even when callers
// pass a map containing those literal keys.
// buildPayload is buildPayloadWithCorrelation with no request id — kept for
// callers that legitimately have none.
func buildPayload(before, after, metadata any) map[string]any {
	return buildPayloadWithCorrelation(before, after, metadata, "")
}

// buildPayloadWithCorrelation assembles the audit payload and stamps the
// request id that ties this row to the others from the same request.
//
// The caller's own metadata wins on a key collision: an inbound webhook
// echoing an upstream correlation id is MORE specific than ours, and
// overwriting it would break the very chain this exists to build.
func buildPayloadWithCorrelation(before, after, metadata any, requestID string) map[string]any {
	out := buildPayloadInner(before, after, metadata)
	if requestID == "" {
		return out
	}
	ctxMap, _ := out["context"].(map[string]any)
	if ctxMap == nil {
		ctxMap = map[string]any{}
	} else {
		// Copy: the caller may be reusing the map it passed in, and mutating it
		// would stamp their object as a side effect of being audited.
		copied := make(map[string]any, len(ctxMap)+1)
		for k, v := range ctxMap {
			copied[k] = v
		}
		ctxMap = copied
	}
	if _, taken := ctxMap["correlation_id"]; !taken {
		ctxMap["correlation_id"] = requestID
	}
	out["context"] = ctxMap
	return out
}

func buildPayloadInner(before, after, metadata any) map[string]any {
	out := map[string]any{}
	if before != nil {
		out["before"] = before
	}
	if after != nil {
		out["after"] = after
	}
	if metadata != nil {
		// Prefer raw maps as-is so the consumer can index without
		// an extra wrapper level. Empty maps drop entirely
		// (otherwise the consumer renders an empty {} block that
		// looks like a bug). Anything else (struct, slice, string,
		// number) still goes under "context".
		if m, ok := metadata.(map[string]any); ok {
			if len(m) > 0 {
				out["context"] = m
			}
		} else {
			out["context"] = metadata
		}
	}
	return out
}

// buildFallbackMeta is the worker / queue-consumer escape hatch.
// Pulls whatever the ctx happens to expose (tenant via middleware.
// TenantFromContext, actor via middleware.ActorFromContext) and
// returns a minimal AuditMeta — no IP, no UserAgent, no session.
// That's intentional: a row written by the background worker
// genuinely has none of those.
func buildFallbackMeta(ctx context.Context) db.AuditMeta {
	var meta db.AuditMeta
	if t, ok := middleware.TenantFromContext(ctx); ok {
		meta.TenantID = t.ID
	}
	if u, ok := middleware.UserFromContext(ctx); ok {
		id := u.ID
		meta.UserID = &id
	}
	at, al := middleware.ActorFromContext(ctx)
	meta.ActorType = at
	meta.ActorLabel = al
	return meta
}
