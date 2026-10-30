// SPDX-License-Identifier: AGPL-3.0-only
//
// workspace_switch.go — POST /api/v1/auth/workspaces/switch (AUTH#6).
//
// GET /api/v1/auth/workspaces already answers "which workspaces does this
// email belong to", but the only way to ACT on that answer was to sign out and
// sign back in with `login(workspace_id)`. On a browser that is an annoyance;
// on a phone it is a wall — the agency operator who covers four client
// workspaces had to retype a password (and re-satisfy MFA) to answer a
// question in the other one, so the mobile app simply froze `tenantId` at
// sign-in and offered no switcher at all.
//
// This mints a session in a SIBLING workspace from an existing session,
// without a credential. That is the same class of operation as
// completeDeviceSessionGrant, so the security properties are spelled out here
// rather than left implicit:
//
//   - THE SOURCE SESSION MUST PROVE MAILBOX CONTROL. Signup issues a session
//     BEFORE the verification email is answered (handlers.go Signup returns
//     `email_verified: false` with a live cookie). Without this guard an
//     attacker could sign up a throwaway workspace using victim@corp.com,
//     receive a real session, and switch straight into the victim's existing
//     workspace — a full account takeover with no credential. So the switch is
//     refused unless the CURRENT session's user row is email-verified, or was
//     created by an identity provider that verified the mailbox for us
//     (google / microsoft / saml / magic_link). A password row that has never
//     answered its verification email can never leave its own workspace.
//
//   - AUTHORITY IS THE MEMBERSHIP, NOT THE REQUEST BODY. The target user id
//     and tenant id come from `users` joined on the SESSION's email; nothing
//     in the body except the workspace id is read, and a workspace the email
//     does not belong to is indistinguishable from one that does not exist.
//
//   - A REVOKED MEMBERSHIP CANNOT BE RE-ENTERED. users.status must be active
//     in the target: suspending a teammate in Settings > Team is the operator
//     action that means "this person is out", and a stale sibling session must
//     not route around it.
//
//   - THE NEW SESSION IS NOT MFA-SATISFIED. issueSessionWithLifetime writes
//     the zero value for mfa_satisfied, so the TARGET tenant's MFA policy
//     re-challenges exactly as it would a fresh password login. Workspace A's
//     MFA posture never speaks for workspace B's.
//
//   - THE OLD SESSION IS REVOKED FIRST. A switch is a move, not a fork: the
//     source cookie is dead before the new one is written, so a failure
//     between the two steps logs the user out (safe) instead of leaving two
//     live sessions (unsafe). The cookie name is shared, so the Set-Cookie
//     replaces it in place.
//
//   - IT IS ANNOUNCED. issueSessionWithLifetime runs the AUTH#47 new-device
//     check, so a switch performed on a device the user has not been seen on
//     still produces a "new device signed in" notification with a revoke
//     action.
package auth

import (
	"errors"
	"net/http"
	"strings"
)

// SwitchWorkspaceInput is the body of POST /api/v1/auth/workspaces/switch.
type SwitchWorkspaceInput struct {
	// WorkspaceID is the tenant id to switch into — one of the `id` values
	// returned by GET /api/v1/auth/workspaces.
	WorkspaceID string `json:"workspace_id"`
	// Remember mirrors LoginInput.Remember (AUTH-024): true keeps the
	// 30-day persistent session, false (the default) issues the short-lived
	// browser-session variant. Carried explicitly rather than inherited so
	// the switch cannot silently upgrade a deliberately short session.
	Remember bool `json:"remember"`
}

// mailboxProvenAuthProviders are the users.auth_provider values that only
// exist because an identity provider already proved the person controls the
// mailbox. A row created by one of them is treated as verified even when
// email_verified_at was never stamped locally.
var mailboxProvenAuthProviders = map[string]struct{}{
	"google":     {},
	"microsoft":  {},
	"saml":       {},
	"magic_link": {},
}

// mailboxProven reports whether this user row's holder has demonstrated
// control of the email address it carries.
func mailboxProven(u User) bool {
	if u.EmailVerifiedAt != nil {
		return true
	}
	_, ok := mailboxProvenAuthProviders[strings.ToLower(strings.TrimSpace(u.AuthProvider))]
	return ok
}

// memberActive reports whether a user row is a currently-valid membership.
// The empty string is treated as active so fakes and older projections that
// do not select users.status keep working.
func memberActive(u User) bool {
	s := strings.ToLower(strings.TrimSpace(u.Status))
	return s == "" || s == "active"
}

// SwitchWorkspace POST /api/v1/auth/workspaces/switch.
//
// Body: {"workspace_id": "<tenant uuid>", "remember": bool}
// 200:  {"tenant_id", "user_id", "workspace_name", "workspace_slug", "role", "switched"}
//
// Switching into the workspace the session is already in is a 200 no-op
// (`switched: false`) and does NOT rotate the session — a client that
// re-sends the current workspace must not be punished with a re-login.
func (d *Deps) SwitchWorkspace(w http.ResponseWriter, r *http.Request) {
	if d.MeContextLookup == nil {
		writeErr(w, http.StatusInternalServerError, "me_unwired", "")
		return
	}
	mc, ok := d.MeContextLookup(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_session", "")
		return
	}
	if d.Repo == nil {
		writeErr(w, http.StatusInternalServerError, "workspaces_unwired", "")
		return
	}

	var in SwitchWorkspaceInput
	if err := decodeAuthJSON(w, r, &in); err != nil {
		writeAuthDecodeErr(w, err)
		return
	}
	in.WorkspaceID = strings.TrimSpace(in.WorkspaceID)
	if in.WorkspaceID == "" {
		writeErr(w, http.StatusBadRequest, "missing_workspace_id", "")
		return
	}

	users, err := d.Repo.LookupUserByEmail(r.Context(), mc.UserEmail)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			// The session resolved but its email owns no user rows. Nothing
			// to switch into; do not distinguish it from an unknown target.
			writeErr(w, http.StatusNotFound, "workspace_not_found", "")
			return
		}
		writeErr(w, http.StatusInternalServerError, "workspaces_lookup_failed", "")
		return
	}

	var source, target User
	for _, u := range users {
		if u.ID == mc.UserID {
			source = u
		}
		if u.TenantID == in.WorkspaceID {
			target = u
		}
	}
	if source.ID == "" {
		// The session's user id is not among the rows for its own email —
		// the two disagree, so refuse rather than guess a principal.
		writeErr(w, http.StatusUnauthorized, "no_session", "")
		return
	}
	if !mailboxProven(source) {
		writeEmailNotVerifiedDenial(w)
		return
	}
	if target.ID == "" {
		writeErr(w, http.StatusNotFound, "workspace_not_found", "")
		return
	}
	if !memberActive(target) {
		writeWorkspaceAccessRevokedDenial(w)
		return
	}

	if target.TenantID == mc.TenantID && target.ID == mc.UserID {
		// Already here. Report the current workspace without rotating the
		// session so a redundant call is free rather than destructive.
		writeJSON(w, http.StatusOK, map[string]any{
			"tenant_id":      target.TenantID,
			"user_id":        target.ID,
			"workspace_name": target.TenantName,
			"workspace_slug": target.TenantSlug,
			"role":           target.Role,
			"switched":       false,
		})
		return
	}

	// Revoke BEFORE issuing: see the file header. A failure after this point
	// leaves the caller signed out, which is the safe direction.
	if tok, parseErr := ParseSessionCookie(r); parseErr == nil {
		if revokeErr := d.Repo.RevokeSession(r.Context(), tok.ID); revokeErr != nil {
			writeErr(w, http.StatusInternalServerError, "session_revoke_failed", "")
			return
		}
	}

	if err := d.issueSessionWithLifetime(
		w, r, target.TenantID, target.ID, "workspace_switch", in.Remember,
	); err != nil {
		writeErr(w, http.StatusInternalServerError, "session_failed", "")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"tenant_id":      target.TenantID,
		"user_id":        target.ID,
		"workspace_name": target.TenantName,
		"workspace_slug": target.TenantSlug,
		"role":           target.Role,
		"switched":       true,
	})
}
