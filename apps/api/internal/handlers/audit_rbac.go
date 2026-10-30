// SPDX-License-Identifier: AGPL-3.0-only
//
// audit_rbac.go — read + mutate endpoints for the audit RBAC model.
//
//	GET  /api/v1/audit/my-scopes        — actor's effective audit scopes
//	GET  /api/v1/roles                  — tenant's roles + assigned scopes
//	PUT  /api/v1/roles/{id}/scopes      — set scopes on a role (admin)
//
// Roles are tenant-scoped and persisted in two tables seeded by
// migration 0262_audit_rbac.sql:
//
//	roles                (id, tenant_id, name, description, …)
//	roles_permissions    (role_id, scope)                     -- join
//
// The audit emitter writes audit.rbac.role_updated on scope changes
// so the meta-trail records who escalated a role and when. Compliance
// gap-doc category: Compliance, P0.
package handlers

import (
	"context"

	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// AuditRBACHandlers serves the audit-RBAC surface. Tenant-scoped via
// the standard tenant-RLS pattern (every tx opened with WithTenant).
type AuditRBACHandlers struct {
	Pool *db.Pool
	// Logger is used by httperror.WriteInternal for structured server-side
	// logging of unexpected failures. nil-safe — when nil, internal errors
	// are still returned to the client as the generic envelope but no log
	// line is emitted. main.go wires the process-wide *slog.Logger here.
	Logger *slog.Logger
}

// MyScopesResponse is the wire shape for GET /api/v1/audit/my-scopes.
type MyScopesResponse struct {
	Scopes      []string `json:"scopes"`
	AuditScopes []string `json:"auditScopes"`
	IsAdmin     bool     `json:"isAdmin"`
}

// MyScopes returns the calling actor's effective scopes. For
// API-key auth this is the key's scope set; for session-cookie
// auth this is the resolved role's grants (looked up via the
// roles_permissions join).
//
// The frontend reads this on Audit-page mount to gate UI features
// (mask the PII columns when audit:read_pii is missing, disable
// the retention editor when audit:configure_retention is missing,
// hide the "Restricted" lock on the nav item, …).
func (h *AuditRBACHandlers) MyScopes(w http.ResponseWriter, r *http.Request) {
	scopes := apikeys.ScopesFromContext(r.Context())
	out := MyScopesResponse{
		Scopes:      make([]string, 0, len(scopes)),
		AuditScopes: make([]string, 0),
	}
	for _, s := range scopes {
		out.Scopes = append(out.Scopes, string(s))
		if strings.HasPrefix(string(s), "audit:") {
			out.AuditScopes = append(out.AuditScopes, string(s))
		}
		if s == apikeys.ScopeAdmin {
			out.IsAdmin = true
		}
	}
	if !middleware.IsAPIKeyAuth(r.Context()) {
		if u, ok := middleware.UserFromContext(r.Context()); ok {
			// UI capabilities describe this session, not the user's durable
			// escalation identity. Honour View-as-Viewer exactly as the route
			// authorization middleware does.
			lower := strings.ToLower(strings.TrimSpace(u.EffectiveRoleOrDurable()))
			out.IsAdmin = lower == "owner" || lower == "admin"
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// RoleWithScopes is one tenant role + its assigned audit scopes.
type RoleWithScopes struct {
	ID             string    `json:"id"`
	Name           string    `json:"name"`
	Description    string    `json:"description"`
	AssignedScopes []string  `json:"assignedScopes"`
	CreatedAt      time.Time `json:"createdAt"`
	UpdatedAt      time.Time `json:"updatedAt"`
}

// ListRoles GET /api/v1/roles.
//
// Returns every role the tenant has defined, with the audit scopes
// currently granted to each. The list is the source-of-truth for
// the Settings > Team > Roles matrix.
func (h *AuditRBACHandlers) ListRoles(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	tx, err := db.WithTenant(r.Context(), h.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	if err := ensureBuiltinAuditRoles(r.Context(), tx, t.ID); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}

	rows, err := tx.Query(r.Context(), `
SELECT r.id::text, r.name, COALESCE(r.description, ''),
       r.created_at, r.updated_at,
       COALESCE(
         (SELECT array_agg(scope ORDER BY scope)
          FROM roles_permissions rp
          WHERE rp.role_id = r.id),
         '{}'::text[]) AS scopes
  FROM roles r
 WHERE r.tenant_id = $1::uuid
 ORDER BY r.name ASC`, t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	out := []RoleWithScopes{}
	for rows.Next() {
		var rw RoleWithScopes
		var scopes []string
		if err := rows.Scan(&rw.ID, &rw.Name, &rw.Description,
			&rw.CreatedAt, &rw.UpdatedAt, &scopes); err != nil {
			continue
		}
		if scopes == nil {
			scopes = []string{}
		}
		rw.AssignedScopes = scopes
		out = append(out, rw)
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"roles":           out,
		"availableScopes": AllScopeStrings(),
	})
}

func ensureBuiltinAuditRoles(ctx context.Context, tx pgx.Tx, tenantID string) error {
	for _, role := range []string{"owner", "admin", "editor", "viewer"} {
		tag, err := tx.Exec(ctx, `
INSERT INTO roles (tenant_id, name, description)
VALUES ($1::uuid, $2, 'Built-in Moosewave role')
ON CONFLICT (tenant_id, name) DO NOTHING`, tenantID, role)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			continue
		}
		roleScopes := []string{string(apikeys.ScopeAuditRead)}
		if role == "owner" || role == "admin" {
			roleScopes = AuditScopeStrings()
		}
		for _, scope := range roleScopes {
			if _, err := tx.Exec(ctx, `
INSERT INTO roles_permissions (role_id, scope)
SELECT id, $3 FROM roles WHERE tenant_id=$1::uuid AND lower(name)=lower($2)
ON CONFLICT (role_id, scope) DO NOTHING`, tenantID, role, scope); err != nil {
				return err
			}
		}
	}
	return nil
}

// updateRoleScopesInput is the body of PUT /api/v1/roles/{id}/scopes.
type updateRoleScopesInput struct {
	Scopes []string `json:"scopes"`
}

// UpdateRoleScopes PUT /api/v1/roles/{id}/scopes.
//
// Replaces (not merges) the role's assigned audit scopes. Unknown
// scope strings are rejected up-front so a typo doesn't silently
// drop a grant. The mutation is wrapped in a single tenant-scoped
// tx that delete-then-inserts the row set; the audit emitter
// writes audit.rbac.role_updated alongside so the meta-trail
// captures the old + new scope set.
func (h *AuditRBACHandlers) UpdateRoleScopes(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	if id == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_id", "role id is required")
		return
	}
	var in updateRoleScopesInput
	if err := httpbody.DecodeJSON(w, r, 16<<10, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	// Validate + dedupe so the audit row records exactly what landed
	// in roles_permissions, not the raw request bag.
	seen := map[string]struct{}{}
	clean := make([]string, 0, len(in.Scopes))
	for _, s := range in.Scopes {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		// G-48: general scopes (write:campaigns, read:reports, …), not only
		// audit:*, may now be granted to a role — the roles matrix is where
		// custom-role permissions live. Still reject anything outside the
		// canonical apikeys catalog.
		if !apikeys.IsValidScope(s) {
			httperror.WriteValidation(w, "validation_failed",
				"unknown scope: "+s)
			return
		}
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		clean = append(clean, s)
	}

	tx, err := db.WithTenant(r.Context(), h.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// Snapshot the previous scope set so audit metadata can record
	// the diff. RLS scopes the read to this tenant's role; a
	// cross-tenant id silently returns no rows and the subsequent
	// UPDATE/DELETE simply no-ops.
	var roleName string
	prev := []string{}
	prevRows, err := tx.Query(r.Context(),
		`SELECT scope FROM roles_permissions WHERE role_id = $1::uuid`, id)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	for prevRows.Next() {
		var s string
		if err := prevRows.Scan(&s); err == nil {
			prev = append(prev, s)
		}
	}
	prevRows.Close()
	if err := tx.QueryRow(r.Context(),
		`SELECT name FROM roles WHERE id = $1::uuid AND tenant_id = $2::uuid`,
		id, t.ID,
	).Scan(&roleName); err != nil {
		httperror.Write(w, http.StatusNotFound, "role_not_found", "role not found")
		return
	}

	// Delete-then-insert. roles_permissions has a UNIQUE(role_id, scope)
	// constraint so duplicates are impossible.
	if _, err := tx.Exec(r.Context(),
		`DELETE FROM roles_permissions WHERE role_id = $1::uuid`, id,
	); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	for _, s := range clean {
		if _, err := tx.Exec(r.Context(),
			`INSERT INTO roles_permissions (role_id, scope) VALUES ($1::uuid, $2)`,
			id, s,
		); err != nil {
			httperror.WriteInternal(w, h.Logger, err, r.Context())
			return
		}
	}

	// Mark roles.updated_at so the matrix UI sees the change.
	if _, err := tx.Exec(r.Context(),
		`UPDATE roles SET updated_at = now() WHERE id = $1::uuid AND tenant_id = $2::uuid`,
		id, t.ID,
	); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}

	// audit.rbac.role_updated meta-trail row. Records the role and
	// the before/after scope sets so an auditor can answer
	// "who escalated <role> and when?" without scanning DB snapshots.
	auditMeta := middleware.AuditMetaFromRequest(r)
	if err := db.Audit(r.Context(), tx, auditMeta,
		"audit.rbac.role_updated", "role", id,
		map[string]any{
			"role_name":       roleName,
			"previous_scopes": prev,
			"new_scopes":      clean,
		},
	); err != nil {
		// Mutation already happened — log via JSON err but still
		// commit so the user-visible PUT doesn't 500 after the
		// row set was actually rewritten.
		_ = err
	}

	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":             true,
		"id":             id,
		"assignedScopes": clean,
	})
}

// IsAuditScope reports whether s is one of the audit:* scopes. We
// disallow assigning non-audit scopes here so the matrix UI cannot
// accidentally grant admin / write:* via the same endpoint.
func IsAuditScope(s string) bool {
	for _, sc := range apikeys.AllAuditScopes {
		if string(sc) == s {
			return true
		}
	}
	return false
}

// AuditScopeStrings returns AllAuditScopes as strings for JSON
// surfaces that don't import the apikeys package.
func AuditScopeStrings() []string {
	out := make([]string, 0, len(apikeys.AllAuditScopes))
	for _, s := range apikeys.AllAuditScopes {
		out = append(out, string(s))
	}
	return out
}

// AllScopeStrings returns the full canonical scope catalog (audit + general) as
// strings — the set the roles matrix now offers as grantable to a role (G-48).
func AllScopeStrings() []string {
	out := make([]string, 0, len(apikeys.AllScopes))
	for _, s := range apikeys.AllScopes {
		out = append(out, string(s))
	}
	return out
}
