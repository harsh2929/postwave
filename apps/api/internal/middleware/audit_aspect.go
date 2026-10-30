// SPDX-License-Identifier: AGPL-3.0-only
//
// audit_aspect.go — chi middleware that wraps a mutating route and
// auto-emits a typed audit_log row on 2xx responses. Handlers populate
// the aspect's payload mid-flight via AuditAttach; the middleware
// harvests it on the way out and writes a single canonical row.
//
// Phase 1a cross-cutting (audit-emit-helper, P1). Companion to
// audit.Emit — Emit is the imperative API for handlers that need a
// row at an unusual point (mid-handler, in a worker); MutatingAspect
// is the declarative wrapper for the common "POST /resource succeeded,
// emit one row" case.
//
// Compare to AuditMiddleware (this file): AuditMiddleware emits a
// generic "http.<method>.<path>" row for EVERY mutation. MutatingAspect
// emits a typed "<action>" row for ONE route, with before/after captured
// inline. The two coexist: a route wrapped in MutatingAspect ends up
// with both a generic forensics row AND a typed product row, which is
// the desired audit-2026 behaviour.
package middleware

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// MutatingAspect returns a chi middleware that:
//
//  1. Attaches a fresh AuditAspect holder to ctx so handlers can call
//     AuditAttach(ctx, resourceID, before, after, metadata) at the
//     point they know the post-state.
//  2. Captures the response status via statusCapturingWriter (same
//     primitive AuditMetaMiddleware uses for the audit-read trail).
//  3. On 2xx — emits a single audit_log row tagged with `action`,
//     using the harvested holder's payload. Failures are logged and
//     swallowed so a transient audit DB hiccup never surfaces as a
//     500 on the underlying mutation.
//
// `action` is the operator-readable label (e.g. "subscriber.create",
// "campaign.send"). `resourceType` defaults to "" — handlers that
// touch a non-default resource type should override via
// AuditAttachWithResourceType (TODO if needed).
//
// pool may be nil in test wiring — the middleware degrades to a no-op
// emit but still attaches the holder so handler code calling
// AuditAttach doesn't NPE.
func MutatingAspect(pool *db.Pool, action, resourceType string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			holder := &AuditAspect{}
			ctx := withAuditAspect(r.Context(), holder)

			// Stash the request-derived AuditMeta on ctx too, so
			// downstream handlers (and audit.Emit called from inside
			// them) don't need to keep reaching for r.
			meta := AuditMetaFromRequest(r)
			ctx = WithAuditMeta(ctx, meta)

			sw := &statusCapturingWriter{ResponseWriter: w, status: http.StatusOK}
			next.ServeHTTP(sw, r.WithContext(ctx))

			// Skip emit for non-2xx — same rationale as
			// AuditMetaMiddleware: a 4xx already conveys "didn't
			// happen" and a 5xx means the mutation rolled back.
			if sw.status < 200 || sw.status >= 300 {
				return
			}
			if holder.Skip {
				return
			}
			if pool == nil {
				return
			}
			tenant, ok := TenantFromContext(r.Context())
			if !ok {
				// Public / unauthenticated mutation — nothing
				// to audit (RLS would reject the insert anyway).
				return
			}

			// Build the canonical metadata blob. We keep the same
			// shape across every aspect-emitted row so consumers
			// (Compliance UI, exports) can parse without knowing
			// the action label.
			metadata := map[string]any{}
			if holder.Before != nil {
				metadata["before"] = holder.Before
			}
			if holder.After != nil {
				metadata["after"] = holder.After
			}
			if len(holder.Metadata) > 0 {
				metadata["context"] = holder.Metadata
			}

			// Tag the action so an unattached handler is visible in
			// the audit trail — easier to spot than a silent gap.
			effectiveAction := action
			if holder.ResourceID == "" && holder.Before == nil && holder.After == nil {
				effectiveAction = action + ".unattached"
			}

			// Fresh ctx so a cancelled request ctx can't abort the
			// audit write (response is already flushed by here).
			bgCtx := context.Background()
			tx, err := db.WithTenant(bgCtx, pool, tenant.ID)
			if err != nil {
				slog.Warn("audit aspect: tx begin",
					"action", effectiveAction, "err", err)
				return
			}
			defer func() { _ = tx.Rollback(bgCtx) }()

			if err := db.Audit(
				bgCtx, tx, meta,
				effectiveAction, resourceType, holder.ResourceID, metadata,
			); err != nil {
				slog.Warn("audit aspect: write",
					"action", effectiveAction, "err", err)
				return
			}
			if err := tx.Commit(bgCtx); err != nil {
				slog.Warn("audit aspect: commit",
					"action", effectiveAction, "err", err)
			}
		})
	}
}
