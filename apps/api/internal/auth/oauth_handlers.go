// SPDX-License-Identifier: AGPL-3.0-only
//
// HTTP handlers for the OAuth login round-trip (Google).
//
// Two endpoints, one /start + one /callback route for Google:
//
//	GET /api/v1/auth/oauth/{provider}/start?redirect_to=/app
//	GET /api/v1/auth/oauth/{provider}/start?redirect_to=moosewave://auth/magic?state=…
//	GET /api/v1/auth/oauth/{provider}/callback?code=…&state=…
//
// The flow:
//
//  1. /start → mint a PKCE code_verifier (64 random bytes, base64url),
//     SHA-256 it for the code_challenge. Insert a row in
//     auth_oauth_state keyed by a random `state` nonce, carrying the
//     provider, the optional redirect_to, and the PKCE verifier. Then
//     302 the user to the provider's authorize URL with the standard
//     OIDC query params + S256 PKCE.
//
//  2. /callback → ConsumeState (single-use, deleted on read). Verify
//     the state's provider matches the URL's provider. POST the
//     authorization_code + verifier to the provider's token endpoint.
//     GET userinfo with the access_token. Then triage:
//
//     a. (provider, subject) already in auth_idp_links → load that
//     user, issue session, redirect to redirect_to. If redirect_to
//     is the desktop magic deep-link, redirect with a one-time
//     magic_link token so the Tauri webview can set its own cookie.
//
//     b. No link, but the verified IdP email matches a local account →
//     return identity_link_required. Email equality alone never creates a
//     durable login path. The user must sign in locally and explicitly start
//     a session-bound link flow from Security settings.
//
//     c. No link, no user with that email → persist a short-lived verified
//     identity and send a browser capability cookie to workspace signup.
//     Completing signup creates the verified owner and Google link together,
//     without a password or a second linking step in Security settings.
//
// Each branch sets the cookie THEN issues a 302 — both work in the
// same response because cookies are headers, redirects are status +
// header, and we write headers before WriteHeader.
//
// AWS-readiness:
//
//   - The provider auth/token URLs are baked into oauth.go. No outbound
//     traffic during boot — the first hit happens when a user clicks
//     "Sign in with Google". ECS task egress must permit outbound
//     HTTPS to Google's OAuth and UserInfo hosts (or just 0.0.0.0/0 on 443
//     if egress isn't restricted).
//   - HTTP timeouts are conservative: a 10-second client total. A
//     wedged provider should fail the user's login fast rather than
//     tying up an ECS task.
package auth

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/mail"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httperror"
)

const oauthProviderMaxResponseBytes int64 = 1 << 20

// OAuthDeps wires the OAuth handlers onto the existing Deps surface.
// Embeds *Deps so handlers can call IssueSession + reach the Repo
// without a dedicated façade.
type OAuthDeps struct {
	*Deps
	OAuthConfig OAuthConfig
	StateRepo   OAuthStateStore

	// IdentityRepo is an optional narrow override for OAuth lifecycle tests.
	// Production falls back to Deps.Repo.
	IdentityRepo OAuthIdentityRepository
	SignupRepo   OAuthSignupRepository
	// SessionIssuer is test-injectable; production falls back to
	// Deps.IssueSession, which persists the verifier and writes the cookie.
	SessionIssuer func(w http.ResponseWriter, r *http.Request, tenantID, userID, method string) error

	// SignupRedirectURL, if set, is where /callback bounces a brand-new
	// IdP user (no existing local account). Default:
	// "<PublicBaseURL>/signup". Override in tests / staging.
	SignupRedirectURL string

	// HTTPClient is overridable for tests (httptest.NewServer). Nil
	// uses a sensibly-bounded default in oauthClient().
	HTTPClient *http.Client
}

// OAuthIdentityRepository is the persistence boundary used by OIDC login and
// explicit account linking. Existing accounts require an active session-bound
// link intent and verified matching email. New owners are linked atomically
// with workspace creation through OAuthSignupRepository.
type OAuthIdentityRepository interface {
	LookupSession(ctx context.Context, id, verifier string) (*Session, error)
	IsActiveIdentityLinkSession(ctx context.Context, sessionID, userID, tenantID string) (bool, error)
	LookupUserByIdP(ctx context.Context, provider, subject string) (*User, error)
	LookupUserByEmail(ctx context.Context, email string) ([]User, error)
	LinkIdP(ctx context.Context, userID, provider, subject, email string, rawClaims []byte) error
	IssueToken(ctx context.Context, tenantID, userID, purpose string, ttl time.Duration) (string, error)
}

func (od *OAuthDeps) identityRepository() OAuthIdentityRepository {
	if od.IdentityRepo != nil {
		return od.IdentityRepo
	}
	if od.Deps != nil && od.Repo != nil {
		return od.Repo
	}
	return nil
}

func (od *OAuthDeps) issueOAuthSession(
	w http.ResponseWriter,
	r *http.Request,
	tenantID, userID, method string,
) error {
	if od.SessionIssuer != nil {
		return od.SessionIssuer(w, r, tenantID, userID, method)
	}
	if od.Deps == nil {
		return errors.New("oauth session issuer is unavailable")
	}
	return od.IssueSession(w, r, tenantID, userID, method)
}

// oauthClient returns the HTTP client used for token + userinfo
// fetches. Bounded so a wedged provider can't pin an ECS task.
func (od *OAuthDeps) oauthClient() *http.Client {
	if od.HTTPClient != nil {
		return od.HTTPClient
	}
	return &http.Client{Timeout: 10 * time.Second}
}

// idpClaims is the subset of the OIDC userinfo response we care about.
// Google UserInfo supplies these fields; everything else is stored in
// rawClaims for audit/debugging (auth_idp_links.raw_claims).
type idpClaims struct {
	Sub           string `json:"sub"`
	Email         string `json:"email"`
	EmailVerified bool   `json:"email_verified"`
	Name          string `json:"name"`
}

const oauthStateContextPrefix = "postwave-oauth-state-v1:"

type oauthLinkIntent struct {
	UserID    string `json:"user_id"`
	TenantID  string `json:"tenant_id"`
	SessionID string `json:"session_id"`
}

type oauthStateContext struct {
	RedirectTo     string           `json:"redirect_to,omitempty"`
	Link           *oauthLinkIntent `json:"link,omitempty"`
	BrowserBinding string           `json:"browser_binding,omitempty"`
}

// Start kicks off the OAuth round-trip: mint PKCE + state, redirect
// to the provider's authorize URL.
func (od *OAuthDeps) Start(w http.ResponseWriter, r *http.Request) {
	provider := chi.URLParam(r, "provider")
	if provider != "google" {
		writeErr(w, http.StatusNotFound, "provider_disabled",
			"this OAuth provider is not supported in this release")
		return
	}
	p, ok := od.OAuthConfig[provider]
	if !ok {
		writeErr(w, http.StatusNotFound, "provider_disabled",
			"this OAuth provider is not configured on this deployment")
		return
	}

	verifier, challenge, pkceErr := generatePKCEPair()
	if pkceErr != nil {
		httperror.WriteInternal(w, od.Logger, pkceErr, r.Context())
		return
	}

	stateContext := oauthStateContext{
		RedirectTo: sanitizeOAuthRedirect(r.URL.Query().Get("redirect_to")),
	}
	browserToken, err := randomToken(32)
	if err != nil {
		httperror.WriteInternal(w, od.Logger, err, r.Context())
		return
	}
	stateContext.BrowserBinding = oauthSignupTokenHash(browserToken)
	if r.URL.Query().Get("link") == "true" {
		repo := od.identityRepository()
		if repo == nil {
			writeErr(w, http.StatusInternalServerError, "oauth_unavailable", "")
			return
		}
		tok, err := ParseSessionCookie(r)
		if err != nil {
			writeErr(w, http.StatusUnauthorized, "reauthentication_required",
				"sign in before linking an identity provider")
			return
		}
		session, err := repo.LookupSession(r.Context(), tok.ID, tok.Verifier)
		if err != nil {
			writeErr(w, http.StatusUnauthorized, "reauthentication_required",
				"sign in before linking an identity provider")
			return
		}
		stateContext.Link = &oauthLinkIntent{
			UserID:    session.UserID,
			TenantID:  session.TenantID,
			SessionID: session.ID,
		}
	}
	encodedStateContext, pkceErr := encodeOAuthStateContext(stateContext)
	if pkceErr != nil {
		httperror.WriteInternal(w, od.Logger, pkceErr, r.Context())
		return
	}

	if od.StateRepo == nil {
		writeErr(w, http.StatusInternalServerError, "oauth_unavailable", "")
		return
	}
	state, pkceErr := od.StateRepo.IssueState(r.Context(), provider, encodedStateContext, verifier)
	if pkceErr != nil {
		httperror.WriteInternal(w, od.Logger, pkceErr, r.Context())
		return
	}

	q := url.Values{}
	q.Set("response_type", "code")
	q.Set("client_id", p.ClientID)
	q.Set("redirect_uri", p.RedirectURI)
	q.Set("scope", strings.Join(p.Scopes, " "))
	q.Set("state", state)
	q.Set("code_challenge", challenge)
	q.Set("code_challenge_method", "S256")

	// access_type=offline lets us mint refresh tokens later if we ever want
	// offline access (we don't today, but it's idempotent to ask).
	// prompt=select_account makes the picker show even when one Google session
	// is active — useful UX on shared machines.
	q.Set("access_type", "offline")
	q.Set("prompt", "select_account")

	od.setOAuthFlowCookie(w, oauthBrowserCookie, browserToken, http.SameSiteLaxMode, int(OAuthStateTTL.Seconds()))
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, p.AuthURL+"?"+q.Encode(), http.StatusFound)
}

// Callback completes the round-trip.
func (od *OAuthDeps) Callback(w http.ResponseWriter, r *http.Request) {
	provider := chi.URLParam(r, "provider")
	if provider != "google" {
		writeErr(w, http.StatusNotFound, "provider_disabled",
			"this OAuth provider is not supported in this release")
		return
	}
	p, ok := od.OAuthConfig[provider]
	if !ok {
		writeErr(w, http.StatusNotFound, "provider_disabled", "")
		return
	}
	q := r.URL.Query()

	// IdPs return errors as ?error=... (and optionally ?error_description=...).
	// Surface them as 400 rather than 500 so the UI can render a
	// proper message instead of a generic failure.
	if oerr := q.Get("error"); oerr != "" {
		writeErr(w, http.StatusBadRequest, "oauth_error", parseOAuthError(oerr, q.Get("error_description")))
		return
	}
	code := q.Get("code")
	state := q.Get("state")
	if code == "" || state == "" {
		writeErr(w, http.StatusBadRequest, "missing_code_or_state", "")
		return
	}

	if od.StateRepo == nil {
		writeErr(w, http.StatusInternalServerError, "oauth_unavailable", "")
		return
	}
	gotProv, encodedStateContext, verifier, stateErr := od.StateRepo.ConsumeState(r.Context(), state)
	if stateErr != nil {
		writeErr(w, http.StatusBadRequest, "invalid_state", "")
		return
	}
	if gotProv != provider {
		// State was issued for a different provider — treat as forgery.
		writeErr(w, http.StatusBadRequest, "provider_mismatch", "")
		return
	}
	stateContext, stateErr := decodeOAuthStateContext(encodedStateContext)
	if stateErr != nil {
		writeErr(w, http.StatusBadRequest, "invalid_state", "")
		return
	}
	if stateContext.BrowserBinding != "" && !oauthBrowserMatches(r, stateContext.BrowserBinding) {
		writeErr(w, http.StatusBadRequest, "invalid_state", "restart Google sign-in in this browser")
		return
	}

	tokenResp, stateErr := exchangeCode(r.Context(), od.oauthClient(), p, code, verifier)
	if stateErr != nil {
		writeErr(w, http.StatusBadGateway, "token_exchange_failed", "provider token exchange failed")
		return
	}

	claims, rawClaimsJSON, stateErr := fetchUserinfo(r.Context(), od.oauthClient(), p, tokenResp.AccessToken)
	if stateErr != nil {
		writeErr(w, http.StatusBadGateway, "userinfo_failed", "provider userinfo fetch failed")
		return
	}
	if err := normalizeOIDCClaims(&claims); err != nil {
		writeErr(w, http.StatusBadGateway, "incomplete_claims",
			"provider returned an invalid subject or email")
		return
	}
	if !claims.EmailVerified {
		writeProviderUnverifiedEmailDenial(w)
		return
	}
	repo := od.identityRepository()
	if repo == nil {
		writeErr(w, http.StatusInternalServerError, "oauth_unavailable", "")
		return
	}

	if stateContext.Link != nil {
		od.completeIdentityLink(w, r, repo, provider, stateContext, claims, rawClaimsJSON)
		return
	}

	// 1. Already linked? Issue a session straight away.
	if user, identityErr := repo.LookupUserByIdP(r.Context(), provider, claims.Sub); identityErr == nil {
		// Refresh the link row with the latest claims so
		// auth_idp_links.raw_claims reflects the current IdP state.
		if err := repo.LinkIdP(r.Context(), user.ID, provider, claims.Sub, claims.Email, rawClaimsJSON); err != nil {
			httperror.WriteInternal(w, od.Logger, err, r.Context())
			return
		}
		if err := od.issueOAuthSession(w, r, user.TenantID, user.ID, provider); err != nil {
			httperror.WriteInternal(w, od.Logger, err, r.Context())
			return
		}
		od.bounceBack(w, r, stateContext.RedirectTo, user.TenantID, user.ID)
		return
	} else if !errors.Is(identityErr, ErrNotFound) {
		httperror.WriteInternal(w, od.Logger, identityErr, r.Context())
		return
	}

	// 2. Not linked — does the email exist locally?
	_, stateErr = repo.LookupUserByEmail(r.Context(), claims.Email)
	switch {
	case stateErr != nil && errors.Is(stateErr, ErrNotFound):
		// Only a round trip started by this browser can authorize signup.
		if stateContext.BrowserBinding == "" {
			writeErr(w, http.StatusBadRequest, "invalid_state", "restart Google sign-in in this browser")
			return
		}
		od.bounceToSignup(w, r, provider, claims)
		return
	case stateErr != nil:
		httperror.WriteInternal(w, od.Logger, stateErr, r.Context())
		return
	default:
		// A verified matching email proves control of that mailbox, but not
		// consent to create a new durable login method for a local account.
		// Require the authenticated, session-bound link flow instead.
		writeErr(w, http.StatusConflict, "identity_link_required",
			"sign in locally, then connect this provider from Settings > Security")
		return
	}
}

func (od *OAuthDeps) completeIdentityLink(
	w http.ResponseWriter,
	r *http.Request,
	repo OAuthIdentityRepository,
	provider string,
	stateContext oauthStateContext,
	claims idpClaims,
	rawClaims []byte,
) {
	intent := stateContext.Link
	active, err := repo.IsActiveIdentityLinkSession(
		r.Context(), intent.SessionID, intent.UserID, intent.TenantID)
	if err != nil {
		httperror.WriteInternal(w, od.Logger, err, r.Context())
		return
	}
	if !active {
		writeErr(w, http.StatusUnauthorized, "reauthentication_required",
			"the session that started identity linking is no longer active")
		return
	}

	users, err := repo.LookupUserByEmail(r.Context(), claims.Email)
	if err != nil && !errors.Is(err, ErrNotFound) {
		httperror.WriteInternal(w, od.Logger, err, r.Context())
		return
	}
	var target *User
	for i := range users {
		if users[i].ID == intent.UserID && users[i].TenantID == intent.TenantID {
			target = &users[i]
			break
		}
	}
	if target == nil {
		writeProviderEmailMismatchDenial(w)
		return
	}

	if linked, err := repo.LookupUserByIdP(r.Context(), provider, claims.Sub); err == nil {
		if linked.ID != target.ID || linked.TenantID != target.TenantID {
			writeErr(w, http.StatusConflict, "identity_already_linked",
				"this provider identity is already linked to another account")
			return
		}
	} else if !errors.Is(err, ErrNotFound) {
		httperror.WriteInternal(w, od.Logger, err, r.Context())
		return
	}

	if err := repo.LinkIdP(r.Context(), target.ID, provider, claims.Sub, claims.Email, rawClaims); err != nil {
		if errors.Is(err, ErrIdentityAlreadyLinked) {
			writeErr(w, http.StatusConflict, "identity_already_linked",
				"this provider identity is already linked to another account")
			return
		}
		httperror.WriteInternal(w, od.Logger, err, r.Context())
		return
	}
	if err := od.issueOAuthSession(w, r, target.TenantID, target.ID, provider); err != nil {
		httperror.WriteInternal(w, od.Logger, err, r.Context())
		return
	}
	od.bounceBack(w, r, stateContext.RedirectTo, target.TenantID, target.ID)
}

func encodeOAuthStateContext(stateContext oauthStateContext) (string, error) {
	if stateContext.RedirectTo != sanitizeOAuthRedirect(stateContext.RedirectTo) {
		return "", errors.New("invalid OAuth redirect in state context")
	}
	if err := validateOAuthLinkIntent(stateContext.Link); err != nil {
		return "", err
	}
	body, err := json.Marshal(stateContext)
	if err != nil {
		return "", fmt.Errorf("encode OAuth state context: %w", err)
	}
	return oauthStateContextPrefix + base64.RawURLEncoding.EncodeToString(body), nil
}

func decodeOAuthStateContext(encoded string) (oauthStateContext, error) {
	// Accept state rows minted immediately before a rolling deployment. Older
	// versions stored only the already-sanitized redirect_to string.
	if !strings.HasPrefix(encoded, oauthStateContextPrefix) {
		if encoded != sanitizeOAuthRedirect(encoded) {
			return oauthStateContext{}, errors.New("invalid legacy OAuth redirect")
		}
		return oauthStateContext{RedirectTo: encoded}, nil
	}
	body, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(encoded, oauthStateContextPrefix))
	if err != nil {
		return oauthStateContext{}, fmt.Errorf("decode OAuth state context: %w", err)
	}
	var stateContext oauthStateContext
	if err := json.Unmarshal(body, &stateContext); err != nil {
		return oauthStateContext{}, fmt.Errorf("parse OAuth state context: %w", err)
	}
	if stateContext.RedirectTo != sanitizeOAuthRedirect(stateContext.RedirectTo) {
		return oauthStateContext{}, errors.New("invalid OAuth redirect in state context")
	}
	if err := validateOAuthLinkIntent(stateContext.Link); err != nil {
		return oauthStateContext{}, err
	}
	return stateContext, nil
}

func validateOAuthLinkIntent(intent *oauthLinkIntent) error {
	if intent == nil {
		return nil
	}
	if strings.TrimSpace(intent.UserID) == "" ||
		strings.TrimSpace(intent.TenantID) == "" ||
		strings.TrimSpace(intent.SessionID) == "" {
		return errors.New("incomplete OAuth link intent")
	}
	if _, err := base64.RawURLEncoding.DecodeString(intent.SessionID); err != nil {
		return errors.New("invalid OAuth link session")
	}
	return nil
}

func normalizeOIDCClaims(claims *idpClaims) error {
	claims.Sub = strings.TrimSpace(claims.Sub)
	claims.Email = strings.TrimSpace(claims.Email)
	if claims.Sub == "" || len(claims.Sub) > 1024 || claims.Email == "" || len(claims.Email) > 320 {
		return errors.New("missing or oversized OIDC identity claims")
	}
	address, err := mail.ParseAddress(claims.Email)
	if err != nil || !strings.EqualFold(address.Address, claims.Email) {
		return errors.New("invalid OIDC email claim")
	}
	return nil
}

// sanitizeOAuthRedirect accepts either a same-site relative redirect or the
// narrow desktop callback used by the Tauri shell. Everything else is dropped
// so OAuth cannot become an open-redirect helper.
func sanitizeOAuthRedirect(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" || containsUnsafeOAuthRedirectBytes(raw) {
		return ""
	}
	if strings.HasPrefix(raw, "/") && !strings.HasPrefix(raw, "//") {
		u, err := url.Parse(raw)
		if err != nil || u.Fragment != "" || u.User != nil {
			return ""
		}
		return u.String()
	}
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	if u.Scheme != "moosewave" || u.Host != "auth" {
		return ""
	}
	if strings.TrimRight(u.Path, "/") != "/magic" {
		return ""
	}
	if u.User != nil || u.Fragment != "" {
		return ""
	}
	dest := url.URL{Scheme: "moosewave", Host: "auth", Path: "/magic"}
	values, ok := u.Query()["state"]
	if !ok || len(values) != 1 {
		return ""
	}
	state, valid := sanitizeAuthLinkState(values[0])
	if !valid || state == "" {
		return ""
	}
	q := url.Values{}
	q.Set("state", state)
	dest.RawQuery = q.Encode()
	// Preserve only the narrow desktop CSRF state. The callback owns the
	// sign-in token query and ignores any other redirect_to parameters.
	return dest.String()
}

// bounceBack redirects to the post-login destination. Defaults to
// PublicBaseURL when redirectTo is empty/unsafe. For the desktop callback we
// mint a one-time magic_link token and attach it to the deep link; the desktop
// then consumes that token from inside its own webview so the session cookie is
// scoped to the app, not just the user's external browser.
func (od *OAuthDeps) bounceBack(
	w http.ResponseWriter,
	r *http.Request,
	redirectTo string,
	tenantID string,
	userID string,
) {
	if strings.HasPrefix(redirectTo, "moosewave://auth/magic") && tenantID != "" && userID != "" {
		repo := od.identityRepository()
		if repo == nil {
			writeErr(w, http.StatusInternalServerError, "repo_unwired", "")
			return
		}
		plain, err := repo.IssueToken(r.Context(), tenantID, userID, "magic_link", magicLinkTTL)
		if err != nil {
			httperror.WriteInternal(w, od.Logger, err, r.Context())
			return
		}
		dest, _ := url.Parse(redirectTo)
		q := dest.Query()
		state, valid := sanitizeAuthLinkState(q.Get("state"))
		if !valid || state == "" {
			writeErr(w, http.StatusBadRequest, "invalid_redirect", "")
			return
		}
		signature, err := signAuthLink(od.AuthLinkSigningKey, plain, authLinkBinding{
			Version:  authLinkVersion,
			Flow:     authLinkFlowMagic,
			Audience: authLinkAudienceMobile,
			State:    state,
		})
		if err != nil {
			httperror.WriteInternal(w, od.Logger, err, r.Context())
			return
		}
		q.Set("token", plain)
		q.Set("v", strconv.Itoa(authLinkVersion))
		q.Set("flow", authLinkFlowMagic)
		q.Set("aud", authLinkAudienceMobile)
		q.Set("sig", signature)
		dest.RawQuery = q.Encode()
		w.Header().Set("Cache-Control", "no-store")
		http.Redirect(w, r, dest.String(), http.StatusFound)
		return
	}

	dest := redirectTo
	if dest == "" || strings.Contains(dest, "://") {
		dest = safeOAuthWebRedirect(od.PublicBaseURL, "/")
	}
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, dest, http.StatusFound)
}

// bounceToSignup keeps verified identity server-side until workspace creation.
// The browser receives only a short-lived, HttpOnly capability cookie.
func (od *OAuthDeps) bounceToSignup(
	w http.ResponseWriter, r *http.Request,
	provider string, claims idpClaims,
) {
	repo := od.signupRepository()
	if repo == nil {
		writeErr(w, http.StatusServiceUnavailable, "oauth_unavailable", "")
		return
	}
	token, err := repo.IssueOAuthSignup(r.Context(), claims)
	if err != nil {
		httperror.WriteInternal(w, od.Logger, err, r.Context())
		return
	}
	base := od.SignupRedirectURL
	if base == "" {
		if od.PublicBaseURL != "" {
			base = strings.TrimRight(safeOAuthWebRedirect(od.PublicBaseURL, ""), "/") + "/signup"
		} else {
			base = "/signup"
		}
	}
	base = safeOAuthWebRedirect(base, "/signup")
	q := url.Values{}
	q.Set("from", "oauth")
	q.Set("provider", provider)
	od.setOAuthFlowCookie(w, oauthSignupCookie, token, http.SameSiteStrictMode, int(OAuthStateTTL.Seconds()))
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, base+"?"+q.Encode(), http.StatusFound)
}

func safeOAuthWebRedirect(raw, fallback string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" || containsUnsafeOAuthRedirectBytes(raw) {
		return fallback
	}
	if strings.HasPrefix(raw, "/") && !strings.HasPrefix(raw, "//") {
		u, err := url.Parse(raw)
		if err != nil || u.Fragment != "" || u.User != nil {
			return fallback
		}
		return u.String()
	}
	u, err := url.Parse(raw)
	if err != nil || !u.IsAbs() || u.Host == "" || u.User != nil {
		return fallback
	}
	u.Scheme = strings.ToLower(u.Scheme)
	if u.Scheme == "http" {
		if !isLocalOAuthRedirectHost(u.Hostname()) {
			return fallback
		}
	} else if u.Scheme != "https" {
		return fallback
	}
	u.RawQuery = ""
	u.Fragment = ""
	return strings.TrimRight(u.String(), "/")
}

func containsUnsafeOAuthRedirectBytes(raw string) bool {
	lower := strings.ToLower(raw)
	if strings.Contains(lower, "%0d") || strings.Contains(lower, "%0a") {
		return true
	}
	return strings.ContainsAny(raw, "\x00\r\n")
}

func isLocalOAuthRedirectHost(host string) bool {
	host = strings.Trim(strings.ToLower(host), "[]")
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

// ---- HTTP plumbing -----------------------------------------------------

// tokenResponse is the standard OAuth 2.0 token endpoint body. We only
// pluck access_token; id_token + refresh_token are ignored by the
// userinfo path (we always fetch userinfo for the canonical email).
type tokenResponse struct {
	AccessToken string `json:"access_token"`
	TokenType   string `json:"token_type"`
	ExpiresIn   int    `json:"expires_in"`
	IDToken     string `json:"id_token,omitempty"`
	Error       string `json:"error,omitempty"`
	ErrorDesc   string `json:"error_description,omitempty"`
}

// exchangeCode POSTs the authorization_code to the provider's token
// endpoint and returns the parsed response.
func exchangeCode(
	ctx context.Context, client *http.Client,
	p *OAuthProvider, code, codeVerifier string,
) (*tokenResponse, error) {
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", code)
	form.Set("redirect_uri", p.RedirectURI)
	form.Set("client_id", p.ClientID)
	form.Set("client_secret", p.ClientSecret)
	form.Set("code_verifier", codeVerifier)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		p.TokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := readResponseBodyLimited(resp.Body, oauthProviderMaxResponseBytes)
	if err != nil {
		return nil, err
	}
	var tr tokenResponse
	if err := json.Unmarshal(body, &tr); err != nil {
		return nil, fmt.Errorf("decode token resp (status %d): %w", resp.StatusCode, err)
	}
	if tr.Error != "" {
		return nil, fmt.Errorf("token endpoint: %s", parseOAuthError(tr.Error, tr.ErrorDesc))
	}
	if tr.AccessToken == "" {
		return nil, fmt.Errorf("token endpoint returned no access_token (status %d)", resp.StatusCode)
	}
	return &tr, nil
}

// fetchUserinfo GETs the userinfo endpoint with the bearer token and
// returns parsed claims + the raw JSON body for storage in
// auth_idp_links.raw_claims.
func fetchUserinfo(
	ctx context.Context, client *http.Client,
	p *OAuthProvider, accessToken string,
) (idpClaims, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.UserinfoURL, nil)
	if err != nil {
		return idpClaims{}, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return idpClaims{}, nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := readResponseBodyLimited(resp.Body, oauthProviderMaxResponseBytes)
	if err != nil {
		return idpClaims{}, nil, err
	}
	if resp.StatusCode/100 != 2 {
		return idpClaims{}, nil, fmt.Errorf("userinfo status %d", resp.StatusCode)
	}
	var c idpClaims
	if err := json.Unmarshal(body, &c); err != nil {
		return idpClaims{}, nil, fmt.Errorf("decode userinfo: %w", err)
	}
	return c, body, nil
}

func readResponseBodyLimited(r io.Reader, maxBytes int64) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(r, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > maxBytes {
		return nil, fmt.Errorf("response body too large")
	}
	return body, nil
}

// generatePKCEPair returns (verifier, challenge) for an S256 PKCE
// flow. verifier is 64 random bytes base64url (88 chars after
// encoding); challenge is sha256(verifier) base64url.
func generatePKCEPair() (verifier, challenge string, err error) {
	verifier, err = randomToken(64)
	if err != nil {
		return "", "", err
	}
	sum := sha256.Sum256([]byte(verifier))
	challenge = base64.RawURLEncoding.EncodeToString(sum[:])
	return verifier, challenge, nil
}

// parseOAuthError formats provider-side errors for surfaced messages.
// We don't echo error_description to the client unverbatim because IdPs
// occasionally embed user-identifying detail; we keep enough that a
// developer reading the network tab can still figure out what went
// wrong.
func parseOAuthError(code, desc string) string {
	if desc == "" {
		return code
	}
	if len(desc) > 200 {
		desc = desc[:200]
	}
	return fmt.Sprintf("%s: %s", code, desc)
}
