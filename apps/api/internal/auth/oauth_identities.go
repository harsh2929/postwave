// SPDX-License-Identifier: AGPL-3.0-only
//
// SETC-021 — session-owner endpoints to see and disconnect linked social
// identities. Distinct from the OAuth login/link ceremony (oauth_handlers.go):
// these need no provider config, only the authenticated session + the repo.
package auth

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
)

// validUnlinkProviders bounds the {provider} path param to the CHECK set on
// auth_idp_links so a bad value is a clean 400, not a silent no-op.
var validUnlinkProviders = map[string]bool{"google": true, "microsoft": true, "saml": true}

type oauthIdentitiesResponse struct {
	Identities []IdPLink `json:"identities"`
	// HasPassword / HasPasskey let the UI tell the user whether disconnecting
	// their last social login is safe (they can still sign in another way)
	// BEFORE they try — the server still enforces it.
	HasPassword bool `json:"has_password"`
	HasPasskey  bool `json:"has_passkey"`
}

// ListOAuthIdentities GET /api/v1/auth/oauth/identities (authenticated).
func (d *Deps) ListOAuthIdentities(w http.ResponseWriter, r *http.Request) {
	mc, ok := d.lookupMe(w, r)
	if !ok {
		return
	}
	links, err := d.Repo.ListIdPLinks(r.Context(), mc.TenantID, mc.UserID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "idp_list_failed", "could not read linked identities")
		return
	}
	hasPassword, err := d.Repo.UserHasPassword(r.Context(), mc.TenantID, mc.UserID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "idp_list_failed", "could not read linked identities")
		return
	}
	hasPasskey, err := d.Repo.UserHasPasskey(r.Context(), mc.TenantID, mc.UserID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "idp_list_failed", "could not read linked identities")
		return
	}
	writeJSON(w, http.StatusOK, oauthIdentitiesResponse{
		Identities: links, HasPassword: hasPassword, HasPasskey: hasPasskey,
	})
}

// UnlinkOAuthIdentity DELETE /api/v1/auth/oauth/{provider}/link (authenticated).
// Refuses to remove the account's only login method (409 last_login_method).
func (d *Deps) UnlinkOAuthIdentity(w http.ResponseWriter, r *http.Request) {
	mc, ok := d.lookupMe(w, r)
	if !ok {
		return
	}
	provider := chi.URLParam(r, "provider")
	if !validUnlinkProviders[provider] {
		writeErr(w, http.StatusBadRequest, "invalid_provider", "unknown identity provider")
		return
	}
	unlinked, err := d.Repo.UnlinkIdP(r.Context(), mc.TenantID, mc.UserID, provider)
	if err != nil {
		if errors.Is(err, ErrLastLoginMethod) {
			writeErr(w, http.StatusConflict, "last_login_method",
				"set a password before disconnecting your only sign-in method")
			return
		}
		writeErr(w, http.StatusInternalServerError, "idp_unlink_failed", "could not disconnect this identity")
		return
	}
	if !unlinked {
		writeErr(w, http.StatusNotFound, "not_linked", "this identity is not connected")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
