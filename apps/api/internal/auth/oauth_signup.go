// SPDX-License-Identifier: AGPL-3.0-only
package auth

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

const (
	oauthBrowserCookie       = "pw_oauth_browser"
	oauthSignupCookie        = "pw_oauth_signup"
	oauthSignupStateProvider = "google-signup-v1"
)

// OAuthSignupIntent is a server-side verified identity, never a client assertion.
// The CSRF token is disclosed only by a same-origin, no-store metadata request.
type OAuthSignupIntent struct {
	Claims    idpClaims
	CSRFToken string
}

type OAuthSignupRepository interface {
	IssueOAuthSignup(context.Context, idpClaims) (string, error)
	GetOAuthSignup(context.Context, string) (*OAuthSignupIntent, error)
	CreateTenantWithGoogleOwner(context.Context, string, string, string, string) (string, string, error)
}

var ErrOAuthSignupAccountExists = errors.New("auth: Google signup account already exists")

func (od *OAuthDeps) signupRepository() OAuthSignupRepository {
	if od.SignupRepo != nil {
		return od.SignupRepo
	}
	if od.Deps != nil && od.Repo != nil {
		return od.Repo
	}
	return nil
}

func oauthSignupTokenHash(token string) string {
	h := sha256.Sum256([]byte(token))
	return base64.RawURLEncoding.EncodeToString(h[:])
}

func oauthBrowserMatches(r *http.Request, hash string) bool {
	cookie, err := r.Cookie(oauthBrowserCookie)
	return err == nil && subtle.ConstantTimeCompare([]byte(oauthSignupTokenHash(cookie.Value)), []byte(hash)) == 1
}

// Host-only cookies keep the capability off sibling domains. Lax permits the
// Google callback; the pending-signup cookie uses Strict for workspace creation.
func (od *OAuthDeps) setOAuthFlowCookie(w http.ResponseWriter, name, value string, sameSite http.SameSite, maxAge int) {
	http.SetCookie(w, &http.Cookie{
		Name: name, Value: value, Path: "/api/v1/auth/oauth/", HttpOnly: true,
		Secure: od.CookieOptions.Secure, SameSite: sameSite, MaxAge: maxAge,
	})
}

func (od *OAuthDeps) pendingSignup(w http.ResponseWriter, r *http.Request) (OAuthSignupRepository, string, bool) {
	w.Header().Set("Cache-Control", "no-store")
	if chi.URLParam(r, "provider") != "google" || od.OAuthConfig["google"] == nil {
		writeErr(w, http.StatusNotFound, "provider_disabled", "")
		return nil, "", false
	}
	repo := od.signupRepository()
	if repo == nil {
		writeErr(w, http.StatusServiceUnavailable, "oauth_unavailable", "")
		return nil, "", false
	}
	cookie, err := r.Cookie(oauthSignupCookie)
	if err != nil || len(cookie.Value) != 43 {
		writeErr(w, http.StatusUnauthorized, "oauth_signup_expired", "continue with Google again")
		return nil, "", false
	}
	return repo, cookie.Value, true
}

// SignupInfo returns the verified Google email and a CSRF token. Email/provider
// query parameters are presentation hints and confer no signup authority.
func (od *OAuthDeps) SignupInfo(w http.ResponseWriter, r *http.Request) {
	repo, token, ok := od.pendingSignup(w, r)
	if !ok {
		return
	}
	intent, err := repo.GetOAuthSignup(r.Context(), token)
	if errors.Is(err, ErrNotFound) {
		writeErr(w, http.StatusUnauthorized, "oauth_signup_expired", "continue with Google again")
		return
	}
	if err != nil {
		httperror.WriteInternal(w, od.Logger, err, r.Context())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"provider": "google", "email": intent.Claims.Email, "csrf_token": intent.CSRFToken})
}

// CompleteSignup atomically creates the tenant, verified owner and Google link,
// consuming the identity proof only on commit. Slug collisions can be retried.
func (od *OAuthDeps) CompleteSignup(w http.ResponseWriter, r *http.Request) {
	repo, token, ok := od.pendingSignup(w, r)
	if !ok {
		return
	}
	var in struct {
		WorkspaceName string `json:"workspace_name"`
		WorkspaceSlug string `json:"workspace_slug"`
		CSRFToken     string `json:"csrf_token"`
	}
	if err := decodeAuthJSON(w, r, &in); err != nil {
		writeAuthDecodeErr(w, err)
		return
	}
	in.WorkspaceName = strings.TrimSpace(in.WorkspaceName)
	in.WorkspaceSlug = strings.ToLower(strings.TrimSpace(in.WorkspaceSlug))
	if in.WorkspaceName == "" {
		writeErr(w, 400, "missing_workspace_name", "")
		return
	}
	if !slugRE.MatchString(in.WorkspaceSlug) {
		writeErr(w, 400, "invalid_workspace_slug", "")
		return
	}
	if len(in.CSRFToken) != 43 {
		writeErr(w, 403, "invalid_signup_proof", "continue with Google again")
		return
	}
	tenantID, userID, err := repo.CreateTenantWithGoogleOwner(r.Context(), token, in.CSRFToken, in.WorkspaceName, in.WorkspaceSlug)
	switch {
	case errors.Is(err, ErrNotFound):
		writeErr(w, 401, "oauth_signup_expired", "continue with Google again")
		return
	case errors.Is(err, ErrOAuthSignupAccountExists):
		writeErr(w, 409, "identity_link_required", "this account already exists; sign in to continue")
		return
	case isUniqueViolation(err):
		writeErr(w, 409, "workspace_slug_taken", "")
		return
	case err != nil:
		httperror.WriteInternal(w, od.Logger, err, r.Context())
		return
	}
	slog.Info("event:posthog:tenant_created", "event", "tenant_created", "tenant_id", tenantID, "user_id", userID)
	if od.Telemetry != nil {
		od.Telemetry.Track(r.Context(), "tenant_created", tenantID, map[string]any{"user_id": userID})
	}
	if err := od.issueOAuthSession(w, r, tenantID, userID, "google"); err != nil {
		httperror.WriteInternal(w, od.Logger, err, r.Context())
		return
	}
	od.setOAuthFlowCookie(w, oauthSignupCookie, "", http.SameSiteStrictMode, -1)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(map[string]any{"user_id": userID, "tenant_id": tenantID, "workspace_slug": in.WorkspaceSlug, "email_verified": true})
}
