// SPDX-License-Identifier: AGPL-3.0-only
//
// audit_rbac_crud.go — create + delete endpoints for tenant custom roles.
//
//	POST   /api/v1/roles       — define a new tenant role
//	DELETE /api/v1/roles/{id}  — remove a tenant role
//
// audit_rbac.go already covers list (GET /api/v1/roles) and scope
// assignment (PUT /api/v1/roles/{id}/scopes); this file is the other
// half of G-48 — without it a tenant is permanently stuck with the
// four built-in roles seeded by ensureBuiltinAuditRoles (owner, admin,
// editor, viewer) and cannot define e.g. a "campaigns-only" role to
// grant write:campaigns to without also granting admin.
//
// Both handlers reuse the AuditRBACHandlers receiver from
// audit_rbac.go — same Pool, same Logger, same tenant-RLS + audit-
// trail conventions.
package handlers

import (
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// builtinRoleNames mirrors the four names ensureBuiltinAuditRoles
// seeds for every tenant (audit_rbac.go). Kept as its own slice
// (rather than importing that literal) so this file doesn't need to
// touch audit_rbac.go — case-insensitive comparison is what actually
// matters since Postgres UNIQUE(tenant_id, name) is case-sensitive
// but we don't want "Admin" shadowing the built-in "admin".
var builtinRoleNames = []string{"owner", "admin", "editor", "viewer"}

// isBuiltinRoleName reports whether name collides with one of the
// seeded built-in roles, case-insensitively.
func isBuiltinRoleName(name string) bool {
	lower := strings.ToLower(strings.TrimSpace(name))
	for _, b := range builtinRoleNames {
		if lower == b {
			return true
		}
	}
	return false
}

const (
	roleNameMaxLen = 100
	roleDescMaxLen = 500
)

// createRoleInput is the body of POST /api/v1/roles.
type createRoleInput struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

// CreateRole POST /api/v1/roles.
//
// Defines a new tenant-scoped custom role with zero scopes assigned;
// the caller follows up with PUT /api/v1/roles/{id}/scopes (already
// shipped in audit_rbac.go) to grant it permissions. Rejects names
// that collide with a built-in role (case-insensitively) so a tenant
// can't shadow "admin" with a role that starts out empty.
func (h *AuditRBACHandlers) CreateRole(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}

	var in createRoleInput
	if err := httpbody.DecodeJSON(w, r, 4<<10, &in); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	name := strings.TrimSpace(in.Name)
	desc := strings.TrimSpace(in.Description)
	if name == "" {
		httperror.WriteValidation(w, "validation_failed", "name is required")
		return
	}
	if len(name) > roleNameMaxLen {
		httperror.WriteValidation(w, "validation_failed", "name is too long")
		return
	}
	if len(desc) > roleDescMaxLen {
		httperror.WriteValidation(w, "validation_failed", "description is too long")
		return
	}
	if isBuiltinRoleName(name) {
		httperror.Write(w, http.StatusConflict, "reserved_role_name",
			"a built-in role with that name already exists")
		return
	}

	tx, err := db.WithTenant(r.Context(), h.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// ensureBuiltinAuditRoles is idempotent (ON CONFLICT DO NOTHING) and
	// cheap; run it here too so a tenant that has never opened the
	// roles list still gets its built-ins seeded before we check for a
	// name collision against them at the DB level (belt-and-braces —
	// the case-insensitive check above already covers the common case,
	// this covers exact-case collisions the UNIQUE(tenant_id, name)
	// constraint would otherwise surface as an opaque 500).
	if err := ensureBuiltinAuditRoles(r.Context(), tx, t.ID); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}

	role := RoleWithScopes{
		Name:           name,
		Description:    desc,
		AssignedScopes: []string{},
	}
	err = tx.QueryRow(r.Context(), `
INSERT INTO roles (tenant_id, name, description)
VALUES ($1::uuid, $2, NULLIF($3, ''))
RETURNING id::text, created_at, updated_at`,
		t.ID, name, desc,
	).Scan(&role.ID, &role.CreatedAt, &role.UpdatedAt)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			httperror.Write(w, http.StatusConflict, "role_exists",
				"a role with that name already exists")
			return
		}
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}

	// audit.rbac.role_created meta-trail row, mirroring the pattern in
	// UpdateRoleScopes: a role's lifecycle (create/grant/revoke/delete)
	// should be fully reconstructable from audit_log alone.
	auditMeta := middleware.AuditMetaFromRequest(r)
	if err := db.Audit(r.Context(), tx, auditMeta,
		"audit.rbac.role_created", "role", role.ID,
		map[string]any{
			"role_name":   role.Name,
			"description": role.Description,
		},
	); err != nil {
		// Same tradeoff as UpdateRoleScopes: the row already exists,
		// don't fail the user-visible create over an audit-write hiccup.
		_ = err
	}

	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusCreated, role)
}

// DeleteRole DELETE /api/v1/roles/{id}.
//
// Removes the role and its roles_permissions grants in one
// tenant-scoped tx (belt-and-braces alongside the ON DELETE CASCADE
// on roles_permissions.role_id — explicit here so the audit trail can
// still report the scope set that was revoked). Built-in roles
// (owner/admin/editor/viewer) can never be deleted: every tenant must
// always have at least the seeded roles available for the initial
// owner/admin accounts.
func (h *AuditRBACHandlers) DeleteRole(w http.ResponseWriter, r *http.Request) {
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

	tx, err := db.WithTenant(r.Context(), h.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	var roleName string
	err = tx.QueryRow(r.Context(),
		`SELECT name FROM roles WHERE id = $1::uuid AND tenant_id = $2::uuid`,
		id, t.ID,
	).Scan(&roleName)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httperror.Write(w, http.StatusNotFound, "role_not_found", "role not found")
			return
		}
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "22P02" {
			httperror.Write(w, http.StatusNotFound, "role_not_found", "role not found")
			return
		}
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	if isBuiltinRoleName(roleName) {
		writeBuiltInRoleDenial(w)
		return
	}

	// Snapshot the scopes being revoked so the audit row records what
	// was actually deleted, not just the role id.
	revoked := []string{}
	scopeRows, err := tx.Query(r.Context(),
		`SELECT scope FROM roles_permissions WHERE role_id = $1::uuid`, id)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	for scopeRows.Next() {
		var s string
		if err := scopeRows.Scan(&s); err == nil {
			revoked = append(revoked, s)
		}
	}
	scopeRows.Close()

	if _, err := tx.Exec(r.Context(),
		`DELETE FROM roles_permissions WHERE role_id = $1::uuid`, id,
	); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	tag, err := tx.Exec(r.Context(),
		`DELETE FROM roles WHERE id = $1::uuid AND tenant_id = $2::uuid`,
		id, t.ID,
	)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	if tag.RowsAffected() == 0 {
		httperror.Write(w, http.StatusNotFound, "role_not_found", "role not found")
		return
	}

	auditMeta := middleware.AuditMetaFromRequest(r)
	if err := db.Audit(r.Context(), tx, auditMeta,
		"audit.rbac.role_deleted", "role", id,
		map[string]any{
			"role_name":      roleName,
			"revoked_scopes": revoked,
		},
	); err != nil {
		_ = err
	}

	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true,
		"id": id,
	})
}

// MountRoleCRUD registers POST /api/v1/roles and DELETE
// /api/v1/roles/{id} on r, both gated behind ScopeAdmin — the same
// gate audit_rbac.go's ListRoles/UpdateRoleScopes already use. Call
// this alongside the existing mountAuditInvestigationRoutes wiring
// (see the 'wiring' notes returned with this feature) rather than
// editing internal/server/audit_operations.go directly.
func MountRoleCRUD(r chi.Router, h *AuditRBACHandlers) {
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/roles", h.CreateRole)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Delete("/api/v1/roles/{id}", h.DeleteRole)
}
