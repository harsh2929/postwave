// SPDX-License-Identifier: AGPL-3.0-only
//
// workspace_members.go — the people half of the Team surface.
//
//	GET   /api/v1/workspace/members       — who is in this workspace
//	PATCH /api/v1/workspace/members/{id}  — change a person's role / status
//
// SHELL#14. audit_rbac.go already exposes GET /api/v1/roles, but that
// returns ROLE DEFINITIONS — the four built-ins plus any custom role and the
// scopes attached to each. It cannot answer "who is in this workspace and
// what can they do", because no route ever read the users table. The result
// was that an operator could inspect the permission model but not the people
// it applies to, and could not revoke a departing teammate's access from any
// client at all.
//
// This file closes that. It is deliberately narrow: read the roster, change
// a role, suspend/reactivate. It does NOT invite, delete, or reset
// credentials — invitation is an email-delivery flow and hard deletion is
// owned by internal/accountdeletion, which has its own grace period and
// erasure ledger. Setting status='deleted' through here is rejected for
// exactly that reason.
//
// Tables: users (migration 0001, extended by 0058 auth_provider /
// email_verified_at and 0122 status). No new table is required, so this
// feature ships without a migration. RLS on users is the canonical
// tenant_id = NULLIF(current_setting('app.tenant_id', true), ”)::uuid
// policy from 0001, and every statement here runs inside db.WithTenant, so
// a cross-tenant member id simply matches no rows rather than leaking.
//
// Effective scopes are derived, not stored: a member's role name is joined
// to roles/roles_permissions (the same tables the roles matrix writes), so
// what the roster reports is exactly what apikeys' storedGrantsCoverScopes
// will honour at request time. ensureBuiltinAuditRoles seeds the four
// built-ins first so a workspace that has never opened the roles matrix
// still reports real scopes instead of an empty set.
package handlers

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// WorkspaceMembersHandlers serves the workspace roster. Same shape as
// AuditRBACHandlers (Pool + nil-safe Logger) because it is the sibling half
// of the same Settings > Team screen.
type WorkspaceMembersHandlers struct {
	Pool   *db.Pool
	Logger *slog.Logger
}

// AssignableMemberRoles is the set a caller may assign through this surface.
// It mirrors the users_role_check constraint from migration 0001 — kept in
// Go as well so an unknown value is a 400 with a specific code rather than a
// 500 carrying a raw Postgres constraint name.
var AssignableMemberRoles = []string{"owner", "admin", "editor", "viewer"}

// AssignableMemberStatuses is the lifecycle subset this surface owns.
// 'deleted' is deliberately absent: hard deletion belongs to
// internal/accountdeletion, which runs a grace period and an erasure ledger
// this endpoint would silently bypass.
var AssignableMemberStatuses = []string{"active", "suspended"}

const (
	memberListDefaultLimit = 100
	memberListMaxLimit     = 500
)

// WorkspaceMember is one row of the roster.
type WorkspaceMember struct {
	ID            string    `json:"id"`
	Email         string    `json:"email"`
	Role          string    `json:"role"`
	Status        string    `json:"status"`
	AuthProvider  string    `json:"authProvider"`
	EmailVerified bool      `json:"emailVerified"`
	CreatedAt     time.Time `json:"createdAt"`
	UpdatedAt     time.Time `json:"updatedAt"`
	// EffectiveScopes is what this member's role currently grants, read
	// from roles_permissions. Always non-nil so clients can render an
	// empty state without a null check.
	EffectiveScopes []string `json:"effectiveScopes"`
	// IsSelf marks the calling session's own row so a client can render
	// "you" and disable the controls that would lock the operator out.
	// Always false on the API-key path, which has no user identity.
	IsSelf bool `json:"isSelf"`
}

// parseOptionalBool parses an optional boolean query param. An empty string
// means "absent" and yields false with no error; anything unparseable is an
// error so a typo (?include_deleted=ture) surfaces as a 400 rather than
// silently meaning false.
func parseOptionalBool(raw string) (bool, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return false, nil
	}
	return strconv.ParseBool(raw)
}

// parseBoundedInt parses an optional integer query param, returning def when
// absent and an error when the value is unparseable or outside [min, max].
// Clamping silently would let a client believe it asked for 10000 rows and
// got them.
func parseBoundedInt(raw string, def, min, max int) (int, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return def, nil
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil {
		return 0, err
	}
	if parsed < min || parsed > max {
		return 0, fmt.Errorf("value %d outside [%d, %d]", parsed, min, max)
	}
	return parsed, nil
}

// isAssignableRole reports whether role is one of AssignableMemberRoles,
// case-insensitively. The DB stores lowercase; we normalise before compare
// so "Admin" from a hand-written client is accepted rather than 500ing on
// the CHECK constraint.
func isAssignableRole(role string) bool {
	lower := strings.ToLower(strings.TrimSpace(role))
	for _, candidate := range AssignableMemberRoles {
		if lower == candidate {
			return true
		}
	}
	return false
}

func isAssignableStatus(status string) bool {
	lower := strings.ToLower(strings.TrimSpace(status))
	for _, candidate := range AssignableMemberStatuses {
		if lower == candidate {
			return true
		}
	}
	return false
}

// actorIsOwner reports whether the caller is a session user holding the
// owner role. Fail-closed by construction: an API key — even an
// admin-scoped one — is never an owner, because a key carries scopes and no
// person. Owner is the top of the ladder and granting it is the one
// operation we require a human owner for.
//
// Reads the DURABLE Role, not EffectiveRoleOrDurable(): per the convention
// documented on middleware.User, View-as-Viewer preview downgrades the
// effective role for display gating, while escalation checks stay on the
// durable value so a preview session neither gains nor loses real authority.
func actorIsOwner(r *http.Request) bool {
	if middleware.IsAPIKeyAuth(r.Context()) {
		return false
	}
	u, ok := middleware.UserFromContext(r.Context())
	if !ok || u == nil {
		return false
	}
	return strings.EqualFold(strings.TrimSpace(u.Role), "owner")
}

// callerUserID returns the session user's id, or "" on the API-key path.
func callerUserID(r *http.Request) string {
	if middleware.IsAPIKeyAuth(r.Context()) {
		return ""
	}
	if u, ok := middleware.UserFromContext(r.Context()); ok {
		return u.ID
	}
	return ""
}

// ListMembers GET /api/v1/workspace/members.
//
// Query params:
//
//	q                 case-insensitive email substring
//	status            exact status filter (active | suspended | deleted)
//	include_deleted   true to include soft-deleted rows (default false)
//	limit / offset    bounded page window
//
// Soft-deleted members are hidden by default because the common question is
// "who has access right now"; include_deleted=true is there for the access
// audit that has to explain a historical actor id.
func (h *WorkspaceMembersHandlers) ListMembers(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}

	q := strings.TrimSpace(r.URL.Query().Get("q"))
	status := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("status")))
	if status != "" && status != "active" && status != "suspended" && status != "deleted" {
		httperror.Write(w, http.StatusBadRequest, "invalid_status",
			"status must be active, suspended or deleted")
		return
	}
	includeDeleted, err := parseOptionalBool(r.URL.Query().Get("include_deleted"))
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_include_deleted",
			"include_deleted must be true or false")
		return
	}
	// Asking for status=deleted implies wanting deleted rows. Without this
	// the two filters contradict each other and the endpoint returns an
	// always-empty list — a silently wrong answer, which is worse than an
	// error, so resolve it in the caller's favour.
	if status == "deleted" {
		includeDeleted = true
	}
	limit, err := parseBoundedInt(r.URL.Query().Get("limit"), memberListDefaultLimit, 1, memberListMaxLimit)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_limit",
			"limit must be an integer between 1 and 500")
		return
	}
	offset, err := parseBoundedInt(r.URL.Query().Get("offset"), 0, 0, 1<<20)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_offset",
			"offset must be a non-negative integer")
		return
	}

	tx, err := db.WithTenant(r.Context(), h.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// Seed the built-in roles so effectiveScopes reflects the real grant
	// set on a workspace that has never opened the roles matrix.
	if err := ensureBuiltinAuditRoles(r.Context(), tx, t.ID); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}

	var total int64
	if err := tx.QueryRow(r.Context(), `
SELECT count(*)
  FROM users u
 WHERE u.tenant_id = $1::uuid
   AND ($2 = '' OR u.status = $2)
   AND ($3::boolean OR u.status <> 'deleted')
   AND ($4 = '' OR u.email ILIKE '%' || $4 || '%')`,
		t.ID, status, includeDeleted, q,
	).Scan(&total); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}

	rows, err := tx.Query(r.Context(), `
SELECT u.id::text, u.email, u.role, u.status, u.auth_provider,
       (u.email_verified_at IS NOT NULL) AS email_verified,
       u.created_at, u.updated_at,
       COALESCE(
         (SELECT array_agg(rp.scope ORDER BY rp.scope)
            FROM roles r
            JOIN roles_permissions rp ON rp.role_id = r.id
           WHERE r.tenant_id = u.tenant_id
             AND lower(r.name) = lower(u.role)),
         '{}'::text[]) AS effective_scopes
  FROM users u
 WHERE u.tenant_id = $1::uuid
   AND ($2 = '' OR u.status = $2)
   AND ($3::boolean OR u.status <> 'deleted')
   AND ($4 = '' OR u.email ILIKE '%' || $4 || '%')
 ORDER BY CASE lower(u.role)
            WHEN 'owner'  THEN 0
            WHEN 'admin'  THEN 1
            WHEN 'editor' THEN 2
            ELSE 3
          END,
          lower(u.email), u.id
 LIMIT $5 OFFSET $6`,
		t.ID, status, includeDeleted, q, limit, offset)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer rows.Close()

	self := callerUserID(r)
	members := []WorkspaceMember{}
	for rows.Next() {
		var m WorkspaceMember
		var scopes []string
		if err := rows.Scan(&m.ID, &m.Email, &m.Role, &m.Status, &m.AuthProvider,
			&m.EmailVerified, &m.CreatedAt, &m.UpdatedAt, &scopes); err != nil {
			httperror.WriteInternal(w, h.Logger, err, r.Context())
			return
		}
		if scopes == nil {
			scopes = []string{}
		}
		m.EffectiveScopes = scopes
		m.IsSelf = self != "" && self == m.ID
		members = append(members, m)
	}
	if err := rows.Err(); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	rows.Close()

	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"members":          members,
		"total":            total,
		"limit":            limit,
		"offset":           offset,
		"assignableRoles":  AssignableMemberRoles,
		"assignableStatus": AssignableMemberStatuses,
		// callerIsOwner tells the client up-front that the "make owner"
		// control will be refused, so it can disable it instead of
		// surfacing a 403 after the fact.
		"callerIsOwner": actorIsOwner(r),
	})
}

// updateMemberInput is the body of PATCH /api/v1/workspace/members/{id}.
// Pointers distinguish "omitted" from "explicitly set".
type updateMemberInput struct {
	Role   *string `json:"role"`
	Status *string `json:"status"`
}

// UpdateMember PATCH /api/v1/workspace/members/{id}.
//
// Changes a member's role and/or lifecycle status. Three invariants are
// enforced, all fail-closed:
//
//  1. LAST OWNER. A workspace must always retain at least one active owner.
//     Demoting or suspending the final one is a 409 last_owner, not a
//     silent lockout that needs support to unpick.
//  2. ONLY AN OWNER GRANTS OWNER. An admin cannot promote anyone (including
//     themselves) to owner — that would make admin and owner the same tier.
//  3. ONLY AN OWNER MODIFIES AN OWNER. An admin cannot demote or suspend a
//     sitting owner.
//
// Self-modification is otherwise allowed: an owner handing over and stepping
// down is a legitimate flow, and invariant 1 already prevents the version of
// it that locks everyone out.
func (h *WorkspaceMembersHandlers) UpdateMember(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if id == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_id", "member id is required")
		return
	}
	// Validate before the query: an unparseable uuid would otherwise reach
	// Postgres as a cast error and surface as an opaque 500.
	if _, err := uuid.Parse(id); err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_id", "member id must be a uuid")
		return
	}

	var in updateMemberInput
	if err := httpbody.DecodeJSON(w, r, 4<<10, &in); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	if in.Role == nil && in.Status == nil {
		httperror.WriteValidation(w, "validation_failed",
			"provide at least one of role or status")
		return
	}
	var newRole, newStatus string
	if in.Role != nil {
		newRole = strings.ToLower(strings.TrimSpace(*in.Role))
		if !isAssignableRole(newRole) {
			httperror.WriteValidation(w, "validation_failed",
				"role must be one of owner, admin, editor, viewer")
			return
		}
	}
	if in.Status != nil {
		newStatus = strings.ToLower(strings.TrimSpace(*in.Status))
		if !isAssignableStatus(newStatus) {
			// Name 'deleted' explicitly — a client that tried it deserves
			// to be pointed at the flow that actually does the job.
			httperror.WriteValidation(w, "validation_failed",
				"status must be active or suspended; deleting a member is handled by the account-deletion flow")
			return
		}
	}

	callerOwner := actorIsOwner(r)
	if in.Role != nil && newRole == "owner" && !callerOwner {
		writeOwnerRoleRequiredDenial(w, "only an owner can grant the owner role")
		return
	}

	tx, err := db.WithTenant(r.Context(), h.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// Lock the target row for the whole check-then-write so two concurrent
	// demotions cannot both observe "another owner exists" and between them
	// leave the workspace with none.
	var currentRole, currentStatus, email string
	err = tx.QueryRow(r.Context(), `
SELECT role, status, email
  FROM users
 WHERE tenant_id = $1::uuid AND id = $2::uuid
 FOR UPDATE`, t.ID, id).Scan(&currentRole, &currentStatus, &email)
	if errors.Is(err, pgx.ErrNoRows) {
		httperror.Write(w, http.StatusNotFound, "member_not_found", "member not found")
		return
	}
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}

	if strings.EqualFold(currentRole, "owner") && !callerOwner {
		writeOwnerRoleRequiredDenial(w, "only an owner can modify another owner")
		return
	}

	// A soft-deleted member belongs to internal/accountdeletion, which set
	// that status as part of a grace period and erasure ledger. Flipping the
	// row back to active from here would resurrect an identity that flow
	// believes it is retiring, so refuse rather than silently un-delete.
	if currentStatus == "deleted" {
		httperror.Write(w, http.StatusConflict, "member_deleted",
			"this member is being deleted; restoring access is handled by the account-deletion flow")
		return
	}

	effectiveRole := currentRole
	if in.Role != nil {
		effectiveRole = newRole
	}
	effectiveStatus := currentStatus
	if in.Status != nil {
		effectiveStatus = newStatus
	}

	// Invariant 1: the workspace keeps at least one active owner.
	losesOwnership := strings.EqualFold(currentRole, "owner") && currentStatus == "active" &&
		(!strings.EqualFold(effectiveRole, "owner") || effectiveStatus != "active")
	if losesOwnership {
		var otherOwners int64
		if err := tx.QueryRow(r.Context(), `
SELECT count(*)
  FROM users
 WHERE tenant_id = $1::uuid
   AND id <> $2::uuid
   AND lower(role) = 'owner'
   AND status = 'active'`, t.ID, id).Scan(&otherOwners); err != nil {
			httperror.WriteInternal(w, h.Logger, err, r.Context())
			return
		}
		if otherOwners == 0 {
			httperror.Write(w, http.StatusConflict, "last_owner",
				"this is the workspace's last active owner; promote another member to owner first")
			return
		}
	}

	var updated WorkspaceMember
	err = tx.QueryRow(r.Context(), `
UPDATE users
   SET role = $3, status = $4
 WHERE tenant_id = $1::uuid AND id = $2::uuid
RETURNING id::text, email, role, status, auth_provider,
          (email_verified_at IS NOT NULL), created_at, updated_at`,
		t.ID, id, effectiveRole, effectiveStatus,
	).Scan(&updated.ID, &updated.Email, &updated.Role, &updated.Status,
		&updated.AuthProvider, &updated.EmailVerified, &updated.CreatedAt, &updated.UpdatedAt)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}

	if err := ensureBuiltinAuditRoles(r.Context(), tx, t.ID); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	var scopes []string
	if err := tx.QueryRow(r.Context(), `
SELECT COALESCE(
         (SELECT array_agg(rp.scope ORDER BY rp.scope)
            FROM roles r
            JOIN roles_permissions rp ON rp.role_id = r.id
           WHERE r.tenant_id = $1::uuid
             AND lower(r.name) = lower($2)),
         '{}'::text[])`, t.ID, updated.Role).Scan(&scopes); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	if scopes == nil {
		scopes = []string{}
	}
	updated.EffectiveScopes = scopes
	updated.IsSelf = callerUserID(r) == updated.ID

	// Access changes are the meta-trail an auditor actually needs: who
	// changed whose tier, from what, to what. Emitted in the same tx as the
	// mutation so the row cannot exist without its audit entry.
	if err := db.Audit(r.Context(), tx, middleware.AuditMetaFromRequest(r),
		"workspace.member_updated", "user", id,
		map[string]any{
			"email":           email,
			"previous_role":   currentRole,
			"new_role":        updated.Role,
			"previous_status": currentStatus,
			"new_status":      updated.Status,
		},
	); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"member": updated})
}

// MountWorkspaceMembers registers the roster routes on r behind ScopeAdmin —
// the same gate the sibling roles routes use, because the roster exposes
// every teammate's email and permission tier. The routeauth manifest carries
// a matching admin row for each; both guards are required (see
// routeauth.ValidateRouterExact).
//
// Deliberately NOT registered from server.MountAuditOperationsSurface: that
// function is pinned route-for-route by an equality test against a legacy
// reference mount, and this surface is not part of the audit sub-tree.
func MountWorkspaceMembers(r chi.Router, h *WorkspaceMembersHandlers) {
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).
		Get("/api/v1/workspace/members", h.ListMembers)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).
		Patch("/api/v1/workspace/members/{id}", h.UpdateMember)
}
