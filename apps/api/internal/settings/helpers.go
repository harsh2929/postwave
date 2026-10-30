// SPDX-License-Identifier: AGPL-3.0-only
package settings

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const settingsJSONMaxBodyBytes int64 = 64 << 10 // 64 KiB

// writeJSON writes a JSON body with the given status. Shared across the
// three sub-handlers to keep the wire format consistent.
func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// errEnv builds the {error: {code, message}} envelope used everywhere
// else in the API.
func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

// emitSettingsAudit writes a typed, named audit row for a successful
// settings mutation. The generic middleware.AuditMiddleware also fires
// after every PATCH/PUT, but that path only records method + path; this
// helper adds the operator-readable action label + the post-write
// payload + before payload (when supplied) so a compliance review can
// reconstruct what changed.
//
// Best-effort: failures are logged and swallowed so a transient audit
// DB hiccup doesn't surface as a 500 on the settings write. The pool
// is required; pass `nil` to no-op.
//
// Conventions:
//
//	action       e.g. "settings.workspace.updated", "settings.privacy.updated"
//	resourceType "workspace_settings", "email_compliance_profile", …
//	resourceID   the tenant id (settings rows are tenant-scoped 1:1)
func emitSettingsAudit(
	ctx context.Context,
	pool *db.Pool,
	r *http.Request,
	tenantID string,
	action string,
	resourceType string,
	resourceID string,
	before any,
	after any,
) {
	if pool == nil || tenantID == "" {
		return
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		slog.Warn("settings audit: tx begin", "action", action, "err", err)
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	meta := middleware.AuditMetaFromRequest(r)
	metadata := map[string]any{
		// `after` is always present; `before` may be nil when the row
		// didn't exist (first write) — encode it explicitly so the
		// audit consumer can tell "first creation" from "update".
		"after": after,
	}
	if before != nil {
		metadata["before"] = before
	}
	if err := db.Audit(ctx, tx, meta, action, resourceType, resourceID, metadata); err != nil {
		slog.Warn("settings audit: write", "action", action, "err", err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		slog.Warn("settings audit: commit", "action", action, "err", err)
	}
}
