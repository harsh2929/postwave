// SPDX-License-Identifier: AGPL-3.0-only
//
// OAuth provider configuration for Google.
//
// Why this lives here (and not in a standalone library):
//
//   - The provider we ship with is fixed (Google). Its UserInfo contract
//     includes a boolean email_verified claim, which the callback requires.
//   - The redirect base URL must come from env so dev (localhost) and
//     prod (api.moosewave.com) share the same binary. Env source:
//     POSTWAVE_OAUTH_REDIRECT_BASE; the providers' callback URLs are
//     `<base>/api/v1/auth/oauth/{provider}/callback`.
//   - Client id + secret come from env. In production the ECS task
//     definition pulls it from Secrets Manager. LoadOAuthConfig silently
//     skips Google unless client id, secret, and redirect base are all set.
//   - Microsoft native sign-in is intentionally disabled. Microsoft's fixed
//     Graph UserInfo response does not provide trustworthy verified-email
//     evidence. Re-enable only with validated ID-token issuer, audience,
//     signature, nonce, and a secure explicit-link/reauthentication contract.
//
// AWS-readiness:
//
//   - Secret material (POSTWAVE_OAUTH_*_SECRET) is intended to be
//     sourced from Secrets Manager via the task definition's `secrets:`
//     block. Same pattern as POSTWAVE_AUTH_HMAC_PEPPER in session.go.
//   - The redirect base URL is a public input — fine to ship via
//     plain env (POSTWAVE_OAUTH_REDIRECT_BASE) on the task definition.
package auth

import (
	"os"
	"strings"
)

// OAuthProvider is the static configuration for one upstream IdP.
// All five URL/scope fields are populated at construction time;
// nothing is fetched from a discovery doc at runtime.
type OAuthProvider struct {
	ClientID     string
	ClientSecret string
	RedirectURI  string
	AuthURL      string
	TokenURL     string
	UserinfoURL  string
	Scopes       []string
}

// OAuthConfig maps the provider key (currently only "google") to its
// resolved configuration. A provider absent from the map is one whose
// complete configuration was not available at boot — handlers must treat that as
// "this provider is disabled" and return a clean 404, not a 500.
type OAuthConfig map[string]*OAuthProvider

// LoadOAuthConfig reads provider configuration from the process env.
//
// Required env (both or none):
//
//   - POSTWAVE_OAUTH_GOOGLE_CLIENT_ID, POSTWAVE_OAUTH_GOOGLE_CLIENT_SECRET
//
// Required env (shared):
//
//   - POSTWAVE_OAUTH_REDIRECT_BASE  e.g. "https://api.moosewave.com" in prod,
//     "http://localhost:8080" in dev.
//
// Returns an empty (but non-nil) map when Google is not configured. Callers
// should not panic: it's a valid runtime state to
// have OAuth disabled and only password auth available.
func LoadOAuthConfig() OAuthConfig {
	cfg := OAuthConfig{}
	base := strings.TrimRight(strings.TrimSpace(os.Getenv("POSTWAVE_OAUTH_REDIRECT_BASE")), "/")
	id := strings.TrimSpace(os.Getenv("POSTWAVE_OAUTH_GOOGLE_CLIENT_ID"))
	secret := strings.TrimSpace(os.Getenv("POSTWAVE_OAUTH_GOOGLE_CLIENT_SECRET"))

	// A partial configuration must remain disabled. Otherwise clients discover
	// a working /start redirect but every callback fails at token exchange.
	if id != "" && secret != "" && base != "" {
		cfg["google"] = &OAuthProvider{ // #nosec G101 -- values come from operator environment; adjacent literals are public provider endpoints
			ClientID:     id,
			ClientSecret: secret,
			RedirectURI:  base + "/api/v1/auth/oauth/google/callback",
			AuthURL:      "https://accounts.google.com/o/oauth2/v2/auth",
			TokenURL:     "https://oauth2.googleapis.com/token",
			UserinfoURL:  "https://openidconnect.googleapis.com/v1/userinfo",
			Scopes:       []string{"openid", "email", "profile"},
		}
	}
	return cfg
}
