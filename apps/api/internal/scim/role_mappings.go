// SPDX-License-Identifier: AGPL-3.0-only
//
// role_mappings.go — admin CRUD over scim_role_mappings, exposed to
// the tenant's admin dashboard so operators can configure
// "group-X → role-admin" rules without dropping into SQL. The
// SCIM bridge consumes these rules at JIT provisioning time
// (see handlers.go: resolveRoleForUser).
//
// SAML JIT bridge: when an SSO login succeeds and the IdP assertion
// carries a Groups claim (Okta + Entra + Google Workspace all
// support emitting groups via SAML attributes), the gateway can call
// ResolveRoleFromGroupNames() with the assertion-decoded group list
// and either link to an existing user row or provision one. This
// keeps the SAML path symmetric with the SCIM provisioning path —
// same rule set, same `role`, just a different trigger.

package scim

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/observability"
)

// RoleMapping is the wire shape.
type RoleMapping struct {
	ID         string    `json:"id"`
	GroupName  string    `json:"group_name"` // IdP group displayName, or '*'
	Role       string    `json:"role"`       // owner | admin | editor | viewer
	Precedence int       `json:"precedence"`
	CreatedAt  time.Time `json:"created_at"`
}

// MountAdminRoutes adds the operator-facing endpoints to the protected
// router group (mounted by the caller after the api-key + tenant
// middleware). Distinct from MountRoutes — those serve IdPs over
// Bearer tokens; these serve operators over the regular API key.
//
//	GET    /api/v1/scim/role-mappings
//	POST   /api/v1/scim/role-mappings
//	DELETE /api/v1/scim/role-mappings/{id}
//	POST   /api/v1/scim/tokens         — mint a new SCIM bearer token (one-shot reveal)
//	GET    /api/v1/scim/tokens         — list tokens (prefix-only view)
//	DELETE /api/v1/scim/tokens/{id}    — revoke
func (d *Deps) MountAdminRoutes(r chi.Router) {
	if d == nil || d.Pool == nil {
		return
	}
	admin := r.With(apikeys.RequireScope(apikeys.ScopeAdmin))
	admin.Get("/api/v1/scim/role-mappings", d.ListRoleMappings)
	// p4d-recordsurface-wire-others: admin-scoped role-mapping +
	// token-mint endpoints share the `scim` surface namespace.
	admin.Post("/api/v1/scim/role-mappings", observability.RecordSurfaceFunc("scim", "role_mapping_upsert", d.UpsertRoleMapping))
	admin.Delete("/api/v1/scim/role-mappings/{id}", observability.RecordSurfaceFunc("scim", "role_mapping_delete", d.DeleteRoleMapping))

	admin.Get("/api/v1/scim/tokens", d.ListTokens)
	admin.Post("/api/v1/scim/tokens", observability.RecordSurfaceFunc("scim", "token_create", d.CreateToken))
	admin.Delete("/api/v1/scim/tokens/{id}", observability.RecordSurfaceFunc("scim", "token_revoke", d.RevokeToken))
}

// ListRoleMappings GET /api/v1/scim/role-mappings.
func (d *Deps) ListRoleMappings(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeAdminErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), `
SELECT id::text, group_name, role, precedence, created_at
  FROM scim_role_mappings
 WHERE tenant_id = $1::uuid
 ORDER BY precedence ASC, group_name ASC`, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	out := []RoleMapping{}
	for rows.Next() {
		var m RoleMapping
		if err := rows.Scan(&m.ID, &m.GroupName, &m.Role, &m.Precedence, &m.CreatedAt); err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		out = append(out, m)
	}
	writeAdminJSON(w, http.StatusOK, map[string]any{"mappings": out})
}

// UpsertRoleMapping POST /api/v1/scim/role-mappings.
//
// Body: { group_name, role, precedence? }. Inserts or updates
// (group_name is unique per tenant). Validation enforces the role
// enum + a precedence range of [0, 1000].
func (d *Deps) UpsertRoleMapping(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeAdminErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in struct {
		GroupName  string `json:"group_name"`
		Role       string `json:"role"`
		Precedence int    `json:"precedence"`
	}
	if err := httpbody.DecodeJSON(w, r, 4<<10, &in); err != nil {
		writeAdminErr(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	in.GroupName = strings.TrimSpace(in.GroupName)
	if in.GroupName == "" {
		writeAdminErr(w, http.StatusBadRequest, "bad_group_name", "group_name is required")
		return
	}
	switch in.Role {
	case "owner", "admin", "editor", "viewer":
	default:
		writeAdminErr(w, http.StatusBadRequest, "bad_role", "role must be owner|admin|editor|viewer")
		return
	}
	if in.Precedence < 0 || in.Precedence > 1000 {
		in.Precedence = 100
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var m RoleMapping
	row := tx.QueryRow(r.Context(), `
INSERT INTO scim_role_mappings (tenant_id, group_name, role, precedence)
VALUES ($1::uuid, $2, $3, $4)
ON CONFLICT (tenant_id, group_name) DO UPDATE
   SET role = EXCLUDED.role,
       precedence = EXCLUDED.precedence
RETURNING id::text, group_name, role, precedence, created_at`,
		t.ID, in.GroupName, in.Role, in.Precedence)
	if err := row.Scan(&m.ID, &m.GroupName, &m.Role, &m.Precedence, &m.CreatedAt); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	audit.EmitOrLog(r.Context(), d.Pool,
		"scim.role_mapping.upsert", "scim_role_mapping", m.ID,
		nil, m, map[string]any{
			"group_name": m.GroupName,
			"role":       m.Role,
			"precedence": m.Precedence,
		})
	writeAdminJSON(w, http.StatusOK, m)
}

// DeleteRoleMapping DELETE /api/v1/scim/role-mappings/{id}.
func (d *Deps) DeleteRoleMapping(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeAdminErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	tag, err := tx.Exec(r.Context(), `
DELETE FROM scim_role_mappings
 WHERE tenant_id = $1::uuid AND id::text = $2`, t.ID, id)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if tag.RowsAffected() == 0 {
		writeAdminErr(w, http.StatusNotFound, "not_found", "mapping not found")
		return
	}
	_ = tx.Commit(r.Context())
	audit.EmitOrLog(r.Context(), d.Pool,
		"scim.role_mapping.delete", "scim_role_mapping", id,
		nil, nil, nil)
	w.WriteHeader(http.StatusNoContent)
}

// CreateToken POST /api/v1/scim/tokens.
//
// Body: { description? }. Returns { id, token (one-shot), prefix }.
// The plaintext token never appears in subsequent reads.
func (d *Deps) CreateToken(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeAdminErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in struct {
		Description string `json:"description"`
	}
	if err := httpbody.DecodeJSON(w, r, 4<<10, &in); err != nil {
		writeAdminErr(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	creator := ""
	if u, ok := middleware.UserFromContext(r.Context()); ok && u != nil {
		creator = u.ID
	}
	tokenPlaintext, prefix, err := MintToken(r.Context(), d.Pool, t.ID, creator, in.Description)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	// SECURITY: audit row stores prefix + description only — NEVER the
	// plaintext token or its sha256. Operators must be able to trace
	// who minted which token without leaking the credential into the
	// audit log (which has a broader read surface than scim_tokens).
	audit.EmitOrLog(r.Context(), d.Pool,
		"scim.token.mint", "scim_token", prefix,
		nil, map[string]any{
			"prefix":      prefix,
			"description": in.Description,
		}, nil)
	writeAdminJSON(w, http.StatusCreated, map[string]any{
		"token":   tokenPlaintext,
		"prefix":  prefix,
		"warning": "The full token is shown ONCE. Store it now — Moosewave only retains a hash.",
	})
}

// ListTokens GET /api/v1/scim/tokens — prefix-only view.
func (d *Deps) ListTokens(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeAdminErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), `
SELECT id::text, token_prefix, description, created_at, revoked_at, last_used_at
  FROM scim_tokens
 WHERE tenant_id = $1::uuid
 ORDER BY created_at DESC`, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, prefix, description string
		var createdAt time.Time
		var revokedAt, lastUsedAt *time.Time
		if err := rows.Scan(&id, &prefix, &description, &createdAt, &revokedAt, &lastUsedAt); err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		out = append(out, map[string]any{
			"id":           id,
			"prefix":       prefix,
			"description":  description,
			"created_at":   createdAt,
			"revoked_at":   revokedAt,
			"last_used_at": lastUsedAt,
		})
	}
	writeAdminJSON(w, http.StatusOK, map[string]any{"tokens": out})
}

// RevokeToken DELETE /api/v1/scim/tokens/{id}.
func (d *Deps) RevokeToken(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeAdminErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	tag, err := tx.Exec(r.Context(), `
UPDATE scim_tokens SET revoked_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2 AND revoked_at IS NULL`, t.ID, id)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if tag.RowsAffected() == 0 {
		writeAdminErr(w, http.StatusNotFound, "not_found", "token not found or already revoked")
		return
	}
	_ = tx.Commit(r.Context())
	audit.EmitOrLog(r.Context(), d.Pool,
		"scim.token.revoke", "scim_token", id,
		nil, nil, nil)
	w.WriteHeader(http.StatusNoContent)
}

// --- SAML JIT bridge ---

// ResolveRoleFromGroupNames is the public hook the SAML callback
// handler calls after assertion validation. Given the IdP-supplied
// group display names, walks scim_role_mappings (lowest precedence
// wins; '*' is the fallback) and returns the Moosewave role.
//
// Returns "viewer" if no mapping matches — strictest sensible
// default so a misconfigured IdP doesn't accidentally elevate
// unknown users to admin.
func ResolveRoleFromGroupNames(ctx context.Context, pool *db.Pool, tenantID string, groupNames []string) (string, error) {
	if len(groupNames) == 0 {
		return resolveWildcardRole(ctx, pool, tenantID), nil
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return "viewer", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
SELECT role FROM scim_role_mappings
 WHERE tenant_id = $1::uuid AND group_name = ANY($2)
 ORDER BY precedence ASC
 LIMIT 1`, tenantID, groupNames)
	var role string
	if err := row.Scan(&role); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return resolveWildcardRole(ctx, pool, tenantID), nil
		}
		return "viewer", err
	}
	return role, nil
}

func resolveWildcardRole(ctx context.Context, pool *db.Pool, tenantID string) string {
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return "viewer"
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var role string
	row := tx.QueryRow(ctx, `
SELECT role FROM scim_role_mappings
 WHERE tenant_id = $1::uuid AND group_name = '*'
 ORDER BY precedence ASC
 LIMIT 1`, tenantID)
	if err := row.Scan(&role); err != nil {
		return "viewer"
	}
	return role
}

// SAMLJITProvision lives at the SAML callback site (or wherever the
// caller assembles a verified assertion). Given a verified email +
// group set, it ensures a Moosewave user row exists with the resolved
// role, returning the user's id for the session-mint flow.
//
// Idempotent: re-running with the same email + groups produces the
// same user_id and updates role if the group set changed.
func SAMLJITProvision(ctx context.Context, pool *db.Pool, tenantID, email string, groupNames []string) (userID string, role string, err error) {
	email = strings.TrimSpace(strings.ToLower(email))
	if email == "" {
		return "", "", errors.New("scim jit: email required")
	}
	role, err = ResolveRoleFromGroupNames(ctx, pool, tenantID, groupNames)
	if err != nil {
		return "", "viewer", err
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return "", role, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Upsert: link or create.
	if err := tx.QueryRow(ctx, `
INSERT INTO users (tenant_id, email, role, status, auth_provider)
VALUES ($1::uuid, $2, $3, 'active', 'saml')
ON CONFLICT (tenant_id, email) DO UPDATE
   SET role = EXCLUDED.role,
       status = 'active',
       updated_at = now()
RETURNING id::text`, tenantID, email, role).Scan(&userID); err != nil {
		return "", role, err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", role, err
	}
	return userID, role, nil
}

// --- helpers ---

func writeAdminJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeAdminErr(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]string{"code": code, "message": msg},
	})
}
