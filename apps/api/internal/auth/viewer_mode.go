// SPDX-License-Identifier: AGPL-3.0-only
//
// viewer_mode.go — SUB-091 View-as-Viewer admin affordance.
//
// An admin/owner can preview the Viewer-gated (read-only) UI without
// logging out and back in as a separate viewer account. The preview is
// scoped to ONE session (browser tab / cookie): toggling it on one
// device never affects another session for the same user, and it never
// mutates the durable users.role.
//
// Endpoint:
//
//	PATCH /api/v1/auth/me/viewer-mode   { "enabled": true | false,
//	                                       "role": "viewer" (optional) }
//
// Semantics:
//   - enabled:true writes auth_sessions.role_override for the current
//     session to the requested preview role (default "viewer"). The
//     preview role MUST be a strict DOWNGRADE of the caller's durable
//     role — an admin can preview as editor or viewer, never escalate.
//   - enabled:false clears the override (exit preview).
//   - Only admin/owner durable roles may activate the preview; editor /
//     viewer get 403 (they have nothing to preview down to that matters,
//     and we refuse to let the affordance widen anything).
//
// The session resolver (middleware.go) reads role_override and surfaces
// it as the effective_role on /api/v1/auth/me; the frontend's
// useCanWrite / useCanAdmin hooks gate the UI on effective_role.
package auth

import (
	"net/http"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// ViewerModeInput is the body of PATCH /api/v1/auth/me/viewer-mode.
type ViewerModeInput struct {
	// Enabled toggles the preview on (true) or off (false).
	Enabled bool `json:"enabled"`
	// Role is the role to preview as. Optional; defaults to "viewer".
	// Must be a strict downgrade of the caller's durable role. Ignored
	// when Enabled is false.
	Role string `json:"role,omitempty"`
}

// ViewerModeResponse echoes the resulting state so the client can update
// its session context without a follow-up /me round-trip.
type ViewerModeResponse struct {
	ViewerMode    bool   `json:"viewer_mode"`
	EffectiveRole string `json:"effective_role"`
	Role          string `json:"role"`
}

// MountViewerModeRoutes registers the SUB-091 toggle. Caller wires this
// inside the protected tenant group so middleware.UserFromContext is
// populated and the session cookie is present.
func (d *Deps) MountViewerModeRoutes(r interface {
	Patch(pattern string, handler http.HandlerFunc)
}) {
	if d == nil || d.Repo == nil {
		return
	}
	r.Patch("/api/v1/auth/me/viewer-mode", d.ToggleViewerMode)
}

// ToggleViewerMode handles PATCH /api/v1/auth/me/viewer-mode. Admin-only
// (durable role). Writes/clears the per-session role_override.
func (d *Deps) ToggleViewerMode(w http.ResponseWriter, r *http.Request) {
	u, ok := middleware.UserFromContext(r.Context())
	if !ok || u == nil || u.ID == "" {
		writeAuthErr(w, http.StatusUnauthorized, "no_user",
			"endpoint requires a session-resolved user")
		return
	}
	// Only an admin/owner durable role may use the preview affordance.
	if !canActivateViewerMode(u.Role) {
		writeViewerModeRoleDenial(w)
		return
	}

	sessionID, err := currentSessionID(r)
	if err != nil || strings.TrimSpace(sessionID) == "" {
		// No resolvable session cookie — the override is meaningless
		// without a session to scope it to (e.g. dev slug-header path).
		writeAuthErr(w, http.StatusBadRequest, "no_session_cookie",
			"viewer mode requires a cookie-backed session")
		return
	}

	var in ViewerModeInput
	if err := decodeAuthJSON(w, r, &in); err != nil {
		writeAuthDecodeErr(w, err)
		return
	}

	if !in.Enabled {
		// Exit preview: clear the override.
		if _, err := d.Repo.SetSessionRoleOverride(r.Context(), sessionID, ""); err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		writeAuthJSON(w, http.StatusOK, ViewerModeResponse{
			ViewerMode:    false,
			EffectiveRole: u.Role,
			Role:          u.Role,
		})
		return
	}

	previewRole := strings.ToLower(strings.TrimSpace(in.Role))
	if previewRole == "" {
		previewRole = "viewer"
	}
	if !isKnownRole(previewRole) {
		writeAuthErr(w, http.StatusBadRequest, "invalid_role",
			"role must be one of owner, admin, editor, viewer")
		return
	}
	// Down-only: the preview role must be strictly LESS privileged than
	// the durable role. This is the security invariant — the affordance
	// can never escalate.
	if roleRank(previewRole) <= roleRank(u.Role) {
		writeViewerModeNotDowngradeDenial(w)
		return
	}

	if _, err := d.Repo.SetSessionRoleOverride(r.Context(), sessionID, previewRole); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeAuthJSON(w, http.StatusOK, ViewerModeResponse{
		ViewerMode:    true,
		EffectiveRole: previewRole,
		Role:          u.Role,
	})
}

// canActivateViewerMode reports whether a durable role may use the
// View-as-Viewer preview. Only owner + admin qualify — they're the roles
// with privileges to preview DOWN from.
func canActivateViewerMode(role string) bool {
	switch role {
	case "owner", "admin":
		return true
	default:
		return false
	}
}

// isKnownRole validates a role string against the auth_sessions
// role_override CHECK vocabulary (migration 1524).
func isKnownRole(role string) bool {
	switch role {
	case "owner", "admin", "editor", "viewer":
		return true
	default:
		return false
	}
}
