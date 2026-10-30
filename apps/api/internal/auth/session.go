// SPDX-License-Identifier: AGPL-3.0-only
//
// Server-side session management.
//
// Cookie format: `pw_session=<id>.<verifier>` where:
//
//   - id is a 16-byte random value, base64url-encoded. Stored verbatim
//     in auth_sessions.id and used as the row PK for fast lookup.
//   - verifier is a 32-byte random value, base64url-encoded. NEVER
//     stored; only its HMAC-SHA256 (peppered) lives in
//     auth_sessions.verifier_hash.
//
// On each request the resolver does:
//
//  1. Parse cookie → split on '.' → (id, verifier).
//  2. SELECT verifier_hash, expires_at, revoked_at, user_id, tenant_id
//     FROM auth_sessions WHERE id = $1.
//  3. ConstantTimeCompare(verifier_hash, HMAC(verifier, pepper)).
//  4. Reject if expired or revoked.
//  5. UPDATE last_seen_at if it's been > 1 minute since the previous bump
//     (cheap rate-limited write to avoid tx churn on chatty clients).
//
// AWS-readiness:
//
//   - Pepper is loaded from POSTWAVE_AUTH_HMAC_PEPPER (sourced from
//     Secrets Manager via the ECS task definition). MUST be at least
//     32 bytes of cryptographic entropy. Rotation: stand up new
//     instances with both old + new pepper, verify either, write only
//     with new; bake-in time = max session lifetime (30d default).
//   - Cookie attributes default to Secure + HttpOnly + SameSite=Lax;
//     Domain is configurable so a single sign-on cookie can span
//     subdomains (.moosewave.com → app.moosewave.com + status.moosewave.com).
//   - DB-backed sessions are stateless at the app layer — any ECS task
//     can serve any request without sticky sessions. ALB/NLB target
//     groups need no special config.
package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// Default cookie name. Stable; clients (the web admin) read this on
// the marketing domain to detect "already signed in" state.
const SessionCookieName = "pw_session"

// DefaultSessionLifetime is how long a fresh session is valid. Refresh
// extends it by the same amount. Tunable per-tenant via security
// settings (session_max_minutes), capped here.
const DefaultSessionLifetime = 30 * 24 * time.Hour

// SessionShortLifetime is the lifetime for a login that did NOT opt into
// "keep me signed in" (AUTH-024). Paired with a MaxAge=0 (browser-session)
// cookie so the session ends when the browser closes, and expires server-side
// the same day even if the cookie somehow survives.
const SessionShortLifetime = 12 * time.Hour

// Errors surfaced to handlers. Resolver returns these so handlers
// can decide whether to redirect-to-login (NoSession) or 401
// (InvalidSession / Expired / Revoked).
var (
	ErrNoSession      = errors.New("no session cookie")
	ErrInvalidSession = errors.New("invalid session token")
	ErrSessionExpired = errors.New("session expired")
	ErrSessionRevoked = errors.New("session revoked")
)

// SessionToken is the (id, verifier) pair encoded into the cookie.
type SessionToken struct {
	ID       string // opaque PK
	Verifier string // base64url; never persisted
}

// String renders the cookie value: <id>.<verifier>. Inverse of
// ParseSessionCookie.
func (s SessionToken) String() string {
	return s.ID + "." + s.Verifier
}

// IssueSessionToken mints a fresh (id, verifier). The caller hashes
// the verifier and persists alongside id in auth_sessions, then sets
// the cookie via SetSessionCookie.
func IssueSessionToken() (SessionToken, error) {
	idBytes := make([]byte, 16)
	if _, err := rand.Read(idBytes); err != nil {
		return SessionToken{}, fmt.Errorf("session id: %w", err)
	}
	verifierBytes := make([]byte, 32)
	if _, err := rand.Read(verifierBytes); err != nil {
		return SessionToken{}, fmt.Errorf("session verifier: %w", err)
	}
	return SessionToken{
		ID:       base64.RawURLEncoding.EncodeToString(idBytes),
		Verifier: base64.RawURLEncoding.EncodeToString(verifierBytes),
	}, nil
}

// HashVerifier returns the HMAC-SHA256(verifier, pepper). This is what
// goes in auth_sessions.verifier_hash. Pepper MUST be high-entropy
// (≥32 bytes); we don't enforce here but main.go fails fast if unset.
func HashVerifier(verifier string, pepper []byte) []byte {
	h := hmac.New(sha256.New, pepper)
	h.Write([]byte(verifier))
	return h.Sum(nil)
}

// VerifyVerifier compares a cookie-supplied verifier against the
// stored hash in constant time.
func VerifyVerifier(verifier string, storedHash, pepper []byte) bool {
	got := HashVerifier(verifier, pepper)
	return subtle.ConstantTimeCompare(got, storedHash) == 1
}

// ParseSessionCookie extracts (id, verifier) from a request. Returns
// ErrNoSession if the cookie is absent, ErrInvalidSession if it is
// present but malformed.
func ParseSessionCookie(r *http.Request) (SessionToken, error) {
	c, err := r.Cookie(SessionCookieName)
	if err != nil {
		return SessionToken{}, ErrNoSession
	}
	parts := strings.SplitN(c.Value, ".", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return SessionToken{}, ErrInvalidSession
	}
	// Sanity: both halves must be base64url-decodable. A malformed cookie
	// usually means tampering or a bad copy/paste — fail closed.
	if _, err := base64.RawURLEncoding.DecodeString(parts[0]); err != nil {
		return SessionToken{}, ErrInvalidSession
	}
	if _, err := base64.RawURLEncoding.DecodeString(parts[1]); err != nil {
		return SessionToken{}, ErrInvalidSession
	}
	return SessionToken{ID: parts[0], Verifier: parts[1]}, nil
}

// CookieOptions controls how SetSessionCookie writes the cookie. Defaults
// are production-safe; callers override Secure=false in dev/test.
type CookieOptions struct {
	Domain   string // e.g. ".moosewave.com"; "" for current host
	Secure   bool   // false only for localhost http
	SameSite http.SameSite
	MaxAge   time.Duration // 0 = browser session
}

// DefaultCookieOptions returns production-safe defaults.
func DefaultCookieOptions() CookieOptions {
	return CookieOptions{
		Domain:   "",
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   DefaultSessionLifetime,
	}
}

// SessionCookieSettings is a deployment's answer to "how is the session cookie
// written?". It exists so the decision lives in ONE guarded place: the
// equivalent logic previously sat inline in main.go, where no test could reach
// it, and deleting it changed behaviour while every test stayed green.
type SessionCookieSettings struct {
	// DevTenantSlugHeader mirrors POSTWAVE_DEV_TENANT_SLUG_HEADER. Historically
	// the ONLY way to drop Secure, which coupled "serve plaintext locally" to
	// "accept a client-supplied tenant slug". Kept so existing setups work.
	DevTenantSlugHeader bool
	// Insecure mirrors POSTWAVE_SESSION_COOKIE_INSECURE: the same effect
	// without the auth bypass riding along.
	Insecure bool
	// Domain mirrors POSTWAVE_COOKIE_DOMAIN; empty means the current host.
	Domain string
}

// CookieOptionsFor resolves settings into cookie attributes. Secure drops only
// on an explicit opt-in, so an empty Settings yields the production-safe
// default.
func CookieOptionsFor(s SessionCookieSettings) CookieOptions {
	opts := DefaultCookieOptions()
	if s.DevTenantSlugHeader || s.Insecure {
		opts.Secure = false
	}
	if s.Domain != "" {
		opts.Domain = s.Domain
	}
	return opts
}

// SetSessionCookie writes the cookie on the response. Pair with
// IssueSessionToken at login.
func SetSessionCookie(w http.ResponseWriter, tok SessionToken, opts CookieOptions) {
	http.SetCookie(w, &http.Cookie{ // #nosec G124 -- HttpOnly/SameSite are explicit; Secure defaults true and only drops under explicit local-dev settings
		Name:     SessionCookieName,
		Value:    tok.String(),
		Path:     "/",
		Domain:   opts.Domain,
		MaxAge:   int(opts.MaxAge.Seconds()),
		Secure:   opts.Secure,
		HttpOnly: true,
		SameSite: opts.SameSite,
	})
}

// ClearSessionCookie writes an immediate-expiry cookie with the same
// attributes so the browser drops the value. Used at logout AND when
// the resolver detects a stale/revoked session (so the next request
// doesn't keep retrying with a known-bad cookie).
func ClearSessionCookie(w http.ResponseWriter, opts CookieOptions) {
	http.SetCookie(w, &http.Cookie{ // #nosec G124 -- deletion mirrors the production-safe attributes of the cookie being cleared
		Name:     SessionCookieName,
		Value:    "",
		Path:     "/",
		Domain:   opts.Domain,
		MaxAge:   -1,
		Secure:   opts.Secure,
		HttpOnly: true,
		SameSite: opts.SameSite,
	})
}
