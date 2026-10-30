// SPDX-License-Identifier: AGPL-3.0-only
//
// workspace_invites.go — the invite half of the Team surface (SETC-010).
//
//	POST   /api/v1/workspace/invites       — mint a copy-link invitation
//	GET    /api/v1/workspace/invites       — list pending invitations
//	DELETE /api/v1/workspace/invites/{id}  — revoke a pending invitation
//
// The copy-link model: no email is sent from here. CreateInvite returns a
// single-use token EXACTLY ONCE (only its SHA-256 is stored, mirroring
// auth_tokens); the admin shares the resulting link, and the invitee redeems
// it at POST /api/v1/auth/accept-invite (auth package), which creates their
// users row in THIS tenant with the invited role. Acceptance is single-use
// and expiring; see migration 1821 and auth.Repo.AcceptInvitation.
//
// Reuses the sibling workspace_members.go helpers (actorIsOwner / callerUserID
// / isAssignableRole) and RLS discipline: every statement runs inside
// db.WithTenant, so a cross-tenant id simply matches no rows.
package handlers

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/limits"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// inviteTTL is how long a copy-link invitation stays redeemable. Short enough
// that a leaked link ages out quickly; long enough for a human hand-off.
const inviteTTL = 7 * 24 * time.Hour

// WorkspaceInvitesHandlers serves the pending-invitation surface. Same shape
// as WorkspaceMembersHandlers — the two halves of Settings > Team.
type WorkspaceInvitesHandlers struct {
	Pool   *db.Pool
	Logger *slog.Logger
}

// WorkspaceInvite is one pending-invitation row. token_hash is NEVER exposed.
type WorkspaceInvite struct {
	ID        string    `json:"id"`
	Email     string    `json:"email"`
	Role      string    `json:"role"`
	CreatedAt time.Time `json:"createdAt"`
	ExpiresAt time.Time `json:"expiresAt"`
}

type createInviteInput struct {
	Email string `json:"email"`
	Role  string `json:"role"`
}

// newInviteToken returns a URL-safe plaintext token plus its SHA-256 digest.
// Only the digest is stored; the plaintext is returned to the caller once.
func newInviteToken() (plain string, hash []byte, err error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", nil, err
	}
	plain = hex.EncodeToString(buf)
	sum := sha256.Sum256([]byte(plain))
	return plain, sum[:], nil
}

// CreateInvite POST /api/v1/workspace/invites.
//
// Mints a copy-link invitation. Only an owner may invite at the owner role
// (mirrors UpdateMember's owner-grants-owner invariant), so an admin cannot
// escalate the workspace by inviting a new owner.
func (h *WorkspaceInvitesHandlers) CreateInvite(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in createInviteInput
	if err := httpbody.DecodeJSON(w, r, 4<<10, &in); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	addr, err := mail.ParseAddress(strings.TrimSpace(in.Email))
	if err != nil {
		httperror.WriteValidation(w, "validation_failed", "a valid email is required")
		return
	}
	email := strings.ToLower(strings.TrimSpace(addr.Address))
	role := strings.ToLower(strings.TrimSpace(in.Role))
	if !isAssignableRole(role) {
		httperror.WriteValidation(w, "validation_failed",
			"role must be one of owner, admin, editor, viewer")
		return
	}
	if role == "owner" && !actorIsOwner(r) {
		writeOwnerRoleRequiredDenial(w, "only an owner can invite at the owner role")
		return
	}

	tx, err := db.WithTenant(r.Context(), h.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	// Serialize seat reservations for this workspace. A live invitation holds
	// one seat, so two concurrent admins cannot both observe the final slot as
	// available and oversubscribe the plan.
	if _, err := tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended($1, 9137))`, t.ID); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}

	// Reject inviting someone who is already an active/suspended member — the
	// roster is the place to change their role, not a second identity.
	var memberExists bool
	if err := tx.QueryRow(r.Context(), `
SELECT EXISTS (
  SELECT 1 FROM users
   WHERE tenant_id = $1::uuid AND lower(email) = $2 AND status <> 'deleted')`,
		t.ID, email).Scan(&memberExists); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	if memberExists {
		httperror.Write(w, http.StatusConflict, "already_member",
			"this email already belongs to a workspace member")
		return
	}

	// Reject a duplicate LIVE invite (unaccepted AND unexpired) for the same
	// email — the roster is where an existing member's role changes. Only a
	// still-live invite blocks re-issue; an expired one is superseded below.
	var invitePending bool
	if err := tx.QueryRow(r.Context(), `
SELECT EXISTS (
  SELECT 1 FROM team_invitations
   WHERE tenant_id = $1::uuid AND lower(email::text) = $2
     AND accepted_at IS NULL AND expires_at > now())`,
		t.ID, email).Scan(&invitePending); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	if invitePending {
		httperror.Write(w, http.StatusConflict, "invite_pending",
			"a pending invitation already exists for this email; revoke it first to re-issue")
		return
	}

	var rawTier string
	var occupied int
	if err := tx.QueryRow(r.Context(), `
SELECT lower(COALESCE(NULLIF(bs.tier, ''), NULLIF(t.tier, ''), 'sandbox')),
       (SELECT count(*) FROM users u
         WHERE u.tenant_id = t.id AND u.status <> 'deleted') +
       (SELECT count(*) FROM team_invitations ti
         WHERE ti.tenant_id = t.id AND ti.accepted_at IS NULL AND ti.expires_at > now())
  FROM tenants t
  LEFT JOIN billing_state bs ON bs.tenant_id = t.id
 WHERE t.id = $1::uuid`, t.ID).Scan(&rawTier, &occupied); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	tier, allowance := limits.WorkspaceSeatAllowance(rawTier)
	if occupied >= allowance {
		limits.WriteExceeded(w, &limits.Error{
			Resource: limits.ResourceSeats,
			Tier:     tier,
			Limit:    allowance,
			Current:  occupied,
		})
		return
	}

	// Clear a prior EXPIRED unaccepted invite so re-issue isn't permanently
	// blocked: ListInvites hides expired rows (so the admin can't revoke one),
	// yet the partial unique index (tenant_id, lower(email)) WHERE accepted_at
	// IS NULL would still collide on the leftover row. Superseding it here keeps
	// the single-live-invite invariant without a stranded lockout.
	if _, err := tx.Exec(r.Context(), `
DELETE FROM team_invitations
 WHERE tenant_id = $1::uuid AND lower(email::text) = $2
   AND accepted_at IS NULL AND expires_at <= now()`, t.ID, email); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}

	plain, hash, err := newInviteToken()
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	var invite WorkspaceInvite
	if err := tx.QueryRow(r.Context(), `
INSERT INTO team_invitations (tenant_id, email, role, token_hash, invited_by_user_id, expires_at)
VALUES ($1::uuid, $2, $3, $4, NULLIF($5, '')::uuid, now() + make_interval(secs => $6))
RETURNING id::text, email::text, role, created_at, expires_at`,
		t.ID, email, role, hash, callerUserID(r), int(inviteTTL.Seconds()),
	).Scan(&invite.ID, &invite.Email, &invite.Role, &invite.CreatedAt, &invite.ExpiresAt); err != nil {
		// Race backstop: two concurrent invites for the same fresh email both
		// pass the pre-check; the loser hits the partial unique index. Map that
		// to the same clean 409 the single-request path returns, not a 500.
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			httperror.Write(w, http.StatusConflict, "invite_pending",
				"a pending invitation already exists for this email; revoke it first to re-issue")
			return
		}
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}

	if err := db.Audit(r.Context(), tx, middleware.AuditMetaFromRequest(r),
		"workspace.invite_created", "team_invitation", invite.ID,
		map[string]any{"email": email, "role": role},
	); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	// The plaintext token is returned exactly once; the client composes the
	// accept link (…/accept-invite?token=…) and shows a copy control.
	writeJSON(w, http.StatusCreated, map[string]any{"invite": invite, "token": plain})
}

// ListInvites GET /api/v1/workspace/invites — pending (unaccepted, unexpired).
func (h *WorkspaceInvitesHandlers) ListInvites(w http.ResponseWriter, r *http.Request) {
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

	rows, err := tx.Query(r.Context(), `
SELECT id::text, email::text, role, created_at, expires_at
  FROM team_invitations
 WHERE tenant_id = $1::uuid
   AND accepted_at IS NULL
   AND expires_at > now()
 ORDER BY created_at DESC`, t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	invites := []WorkspaceInvite{}
	for rows.Next() {
		var iv WorkspaceInvite
		if err := rows.Scan(&iv.ID, &iv.Email, &iv.Role, &iv.CreatedAt, &iv.ExpiresAt); err != nil {
			httperror.WriteInternal(w, h.Logger, err, r.Context())
			return
		}
		invites = append(invites, iv)
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
	writeJSON(w, http.StatusOK, map[string]any{"invites": invites})
}

// RevokeInvite DELETE /api/v1/workspace/invites/{id}.
func (h *WorkspaceInvitesHandlers) RevokeInvite(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if _, err := uuid.Parse(id); err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_id", "invite id must be a uuid")
		return
	}
	tx, err := db.WithTenant(r.Context(), h.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	var email, role string
	err = tx.QueryRow(r.Context(), `
DELETE FROM team_invitations
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND accepted_at IS NULL
RETURNING email::text, role`, t.ID, id).Scan(&email, &role)
	if errors.Is(err, pgx.ErrNoRows) {
		httperror.Write(w, http.StatusNotFound, "invite_not_found", "invitation not found")
		return
	}
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	if err := db.Audit(r.Context(), tx, middleware.AuditMetaFromRequest(r),
		"workspace.invite_revoked", "team_invitation", id,
		map[string]any{"email": email, "role": role},
	); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// MountWorkspaceInvites registers the invite routes behind ScopeAdmin — the
// same gate as the roster; both are admin-only Team operations. Each route
// needs a matching routeauth manifest row (routeauth.ValidateRouterExact).
func MountWorkspaceInvites(r chi.Router, h *WorkspaceInvitesHandlers) {
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).
		Post("/api/v1/workspace/invites", h.CreateInvite)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).
		Get("/api/v1/workspace/invites", h.ListInvites)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).
		Delete("/api/v1/workspace/invites/{id}", h.RevokeInvite)
}
