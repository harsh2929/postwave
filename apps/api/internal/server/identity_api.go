// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"github.com/postwave/postwave/apps/api/internal/admin_ip"
	"github.com/postwave/postwave/apps/api/internal/apikeycalls"
	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/scim"
	"github.com/postwave/postwave/apps/api/internal/scoring"
)

// MountPublicAuthRoutes registers the unauthenticated password, email-token,
// PKCE, and device-grant endpoints. The shared brute-force middleware remains
// attached only to credential and short-code verification routes; logout, the
// PKCE token exchange, and the high-entropy device poll remain unthrottled.
func MountPublicAuthRoutes(deps Deps) {
	if deps.Router == nil || deps.Auth == nil || deps.AuthBruteforceMiddleware == nil {
		return
	}

	limited := deps.AuthBruteforceMiddleware
	deps.Router.With(limited).Post("/api/v1/auth/signup", deps.Auth.Signup)
	// SETC-010 — copy-link team-invite acceptance. Public + brute-force
	// limited like signup, since it consumes a bearer token to create an
	// account in the invited workspace.
	deps.Router.With(limited).Post("/api/v1/auth/accept-invite", deps.Auth.AcceptInvite)
	deps.Router.With(limited).Get("/api/v1/auth/slug-available", deps.Auth.SlugAvailable)
	deps.Router.With(limited).Post("/api/v1/auth/login", deps.Auth.Login)
	deps.Router.Post("/api/v1/auth/logout", deps.Auth.Logout)
	deps.Router.With(limited).Post("/api/v1/auth/verify-email", deps.Auth.VerifyEmail)
	deps.Router.With(limited).Post("/api/v1/auth/magic-link/start", deps.Auth.MagicLinkStart)
	deps.Router.With(limited).Post("/api/v1/auth/magic-link/consume", deps.Auth.MagicLinkConsume)
	deps.Router.With(limited).Post("/api/v1/auth/password-reset/start", deps.Auth.PasswordResetStart)
	deps.Router.With(limited).Post("/api/v1/auth/password-reset/confirm", deps.Auth.PasswordResetConfirm)
	// AUTH-023: passwordless passkey login is a PUBLIC, tenant-independent
	// ceremony (the user is logged out; identity is resolved from the credential
	// itself). It MUST live on the public router alongside password login — the
	// authenticated group is tenant-gated and would 401 a logged-out caller
	// before the handler runs. Brute-force limited like every other credential
	// verification endpoint.
	deps.Router.With(limited).Post("/api/v1/auth/webauthn/login/begin", deps.Auth.WebauthnLoginBegin)
	deps.Router.With(limited).Post("/api/v1/auth/webauthn/login/finish", deps.Auth.WebauthnLoginFinish)
	deps.Auth.MountCLITokenRoute(deps.Router)
	deps.Auth.MountCLIDeviceStartRoute(deps.Router.With(limited))
	deps.Auth.MountCLIDeviceTokenRoute(deps.Router)
}

// MountOAuthRoutes registers the optional provider redirect, callback and signup.
// A nil OAuth graph is the supported password-only deployment mode.
func MountOAuthRoutes(deps Deps) {
	if deps.Router == nil || deps.OAuth == nil || deps.AuthBruteforceMiddleware == nil {
		return
	}

	deps.Router.Get("/api/v1/auth/oauth/{provider}/start", deps.OAuth.Start)
	deps.Router.Get("/api/v1/auth/oauth/{provider}/callback", deps.OAuth.Callback)
	deps.Router.With(deps.AuthBruteforceMiddleware).Get("/api/v1/auth/oauth/{provider}/signup", deps.OAuth.SignupInfo)
	deps.Router.With(deps.AuthBruteforceMiddleware).Post("/api/v1/auth/oauth/{provider}/signup", deps.OAuth.CompleteSignup)
}

// MountAuthenticatedAuthMeRoute retains the typed identity endpoint at its
// original point immediately after the legacy /api/v1/me route.
func MountAuthenticatedAuthMeRoute(deps Deps) {
	if deps.Router == nil || deps.Auth == nil {
		return
	}

	deps.Router.Get("/api/v1/auth/me", deps.Auth.Me)
}

// MountAuthenticatedAuthRoutes registers session-bound viewer preview, email
// verification, TOTP, session management, and CLI approval routes. The caller
// supplies the already authenticated, tenant-resolved router; only online-code
// guessing endpoints receive the additional brute-force limiter.
func MountAuthenticatedAuthRoutes(deps Deps) {
	if deps.Router == nil || deps.Auth == nil || deps.AuthBruteforceMiddleware == nil {
		return
	}

	limited := deps.AuthBruteforceMiddleware
	deps.Auth.MountViewerModeRoutes(deps.Router)
	deps.Router.Get("/api/v1/auth/workspaces", deps.Auth.Workspaces)
	// AUTH#6 in-app workspace switch. Not brute-force limited: the body
	// carries no guessable secret — workspace_id is a uuid the caller
	// already received from the GET above, and authority comes from the
	// session's own membership rows, not from the body.
	deps.Router.Post("/api/v1/auth/workspaces/switch", deps.Auth.SwitchWorkspace)
	deps.Router.Post("/api/v1/auth/send-verification", deps.Auth.SendVerification)
	deps.Router.Post("/api/v1/auth/totp/enroll", deps.Auth.TOTPEnroll)
	deps.Router.With(limited).Post("/api/v1/auth/totp/verify", deps.Auth.TOTPVerify)
	deps.Router.With(limited).Post("/api/v1/auth/totp/challenge", deps.Auth.TOTPChallenge)
	deps.Router.Delete("/api/v1/auth/totp", deps.Auth.TOTPDisable)
	// AUTH-023: WebAuthn / passkey enrollment + management run under the
	// session. The two PUBLIC login ceremonies live in MountPublicAuthRoutes —
	// they must be reachable while logged out.
	deps.Router.Post("/api/v1/auth/webauthn/register/begin", deps.Auth.WebauthnRegisterBegin)
	deps.Router.Post("/api/v1/auth/webauthn/register/finish", deps.Auth.WebauthnRegisterFinish)
	deps.Router.Get("/api/v1/auth/webauthn/credentials", deps.Auth.WebauthnListPasskeys)
	deps.Router.Patch("/api/v1/auth/webauthn/credentials/{id}", deps.Auth.WebauthnRenamePasskey)
	deps.Router.Delete("/api/v1/auth/webauthn/credentials/{id}", deps.Auth.WebauthnDeletePasskey)
	// SETC-021: view + disconnect linked social identities (session-owner).
	// The unlink refuses to remove the account's only sign-in method.
	deps.Router.Get("/api/v1/auth/oauth/identities", deps.Auth.ListOAuthIdentities)
	deps.Router.Delete("/api/v1/auth/oauth/{provider}/link", deps.Auth.UnlinkOAuthIdentity)
	// Recovery-code status + regeneration (AUTH#49). Not brute-force
	// limited: neither route accepts a guessable secret — the GET returns a
	// count and the POST is gated on an MFA-satisfied session.
	deps.Auth.MountRecoveryCodeRoutes(deps.Router)
	deps.Auth.MountSessionRoutes(deps.Router)
	// AUTH#48 trusted devices. Session-only + viewer minimum role in the
	// routeauth manifest, exactly like /auth/sessions: these are the caller's
	// OWN MFA-bypass credentials, so no API key may enumerate or revoke them
	// and no role gate may stop a viewer from killing their own. Not
	// brute-force limited — none of the three accepts a guessable secret; the
	// id in the DELETE is one the caller was already shown.
	deps.Auth.MountTrustedDeviceRoutes(deps.Router)
	deps.Auth.MountCLIAuthorizeRoute(deps.Router)
	deps.Auth.MountCLIDeviceApproveRoute(deps.Router.With(limited))
}

// MountAdminIPRoutes registers the tenant-admin allowlist surface using the
// shared pool and the package's existing admin-scope gate.
func MountAdminIPRoutes(deps Deps) {
	if deps.Router == nil || deps.Pool == nil {
		return
	}

	admin_ip.MountRoutes(deps.Router, &admin_ip.Deps{Pool: deps.Pool})
}

// MountAPIKeyRoutes registers API-key lifecycle operations with the already
// assembled repository dependency. Every route retains its explicit admin gate.
func MountAPIKeyRoutes(deps Deps) {
	if deps.Router == nil || deps.APIKeys == nil {
		return
	}

	admin := apikeys.RequireExactTenantAdmin
	deps.Router.With(admin).Get("/api/v1/api-keys", deps.APIKeys.List)
	deps.Router.With(admin).Get("/api/v1/api-keys/{id}", deps.APIKeys.Get)
	deps.Router.With(admin).Post("/api/v1/api-keys", deps.APIKeys.Create)
	deps.Router.With(admin).Post("/api/v1/api-keys/{id}/rotate", deps.APIKeys.Rotate)
	deps.Router.With(admin).Patch("/api/v1/api-keys/{id}", deps.APIKeys.Update)
	deps.Router.With(admin).Delete("/api/v1/api-keys/{id}", deps.APIKeys.Delete)
}

// MountAPIKeyCallRoutes registers MCP execution history, SSE, CSV, aggregates,
// catalogue, and quota administration in their original order.
func MountAPIKeyCallRoutes(deps Deps) {
	if deps.Router == nil || deps.APIKeyCalls == nil {
		return
	}

	admin := apikeys.RequireExactTenantAdmin
	deps.Router.With(apikeycalls.ProtectMCPResponses, admin).Get("/api/v1/mcp/executions", deps.APIKeyCalls.ListExecutions)
	deps.Router.With(apikeycalls.ProtectMCPResponses, admin).Get("/api/v1/mcp/executions/stream", deps.APIKeyCalls.StreamExecutions)
	deps.Router.With(apikeycalls.ProtectMCPResponses, admin).Get("/api/v1/mcp/executions.csv", deps.APIKeyCalls.ExportExecutionsCSV)
	deps.Router.With(apikeycalls.ProtectMCPResponses, admin).Get("/api/v1/mcp/stats", deps.APIKeyCalls.GetStats)
	deps.Router.With(apikeycalls.ProtectMCPResponses, admin).Get("/api/v1/mcp/trend", deps.APIKeyCalls.GetTrend)
	deps.Router.With(apikeycalls.ProtectMCPResponses, admin).Get("/api/v1/mcp/catalog", deps.APIKeyCalls.GetCatalog)
	deps.Router.With(apikeycalls.ProtectMCPResponses, admin).Get("/api/v1/mcp/quotas", deps.APIKeyCalls.ListQuotasHandler)
	deps.Router.With(apikeycalls.ProtectMCPResponses, admin).Put("/api/v1/mcp/quotas", deps.APIKeyCalls.UpsertQuotaHandler)
	deps.Router.With(apikeycalls.ProtectMCPResponses, admin).Delete("/api/v1/mcp/quotas/{tool}", deps.APIKeyCalls.DeleteQuotaHandler)
}

// MountAPIDocRoutes registers the authenticated in-app OpenAPI document.
func MountAPIDocRoutes(deps Deps) {
	if deps.Router == nil || deps.APIDocs == nil {
		return
	}

	deps.Router.Get("/api/v1/openapi.json", deps.APIDocs.GetSpec)
}

// MountScoringRoutes registers tenant lead-scoring rule and recompute routes.
func MountScoringRoutes(deps Deps) {
	if deps.Router == nil || deps.Pool == nil {
		return
	}

	scoring.MountRoutes(deps.Router, &scoring.Deps{Pool: deps.Pool})
}

// MountAuditSinkRoutes retains the four independently deployable audit-sink
// registration groups and their read/configure/execute scope distinctions.
func MountAuditSinkRoutes(deps Deps) {
	if deps.Router == nil || deps.AuditSinkAdmin == nil {
		return
	}

	deps.AuditSinkAdmin.MountAdminRoutes(deps.Router)
	deps.AuditSinkAdmin.MountDLQRoutes(deps.Router)
	deps.AuditSinkAdmin.MountTestRoutes(deps.Router)
	deps.AuditSinkAdmin.MountSigningKeyRoutes(deps.Router)
}

// MountSCIMAdminRoutes registers operator token and role-mapping management on
// the idempotency-protected authenticated router supplied by the caller.
func MountSCIMAdminRoutes(deps Deps) {
	if deps.Router == nil || deps.SCIMAdmin == nil {
		return
	}

	deps.SCIMAdmin.MountAdminRoutes(deps.Router)
}

// MountSCIMPublicRoutes registers the self-authenticating SCIM v2 surface on
// the root router. Region enforcement remains inside the promoted dependency.
func MountSCIMPublicRoutes(deps Deps) {
	if deps.Router == nil || deps.SCIMPublic == nil {
		return
	}

	scim.MountRoutes(deps.Router, deps.SCIMPublic)
}

// MountAdminKMSRoutes registers bearer-protected internal rewrap operations on
// the root router, outside tenant authentication.
func MountAdminKMSRoutes(deps Deps) {
	if deps.Router == nil || deps.AdminKMS == nil {
		return
	}

	deps.AdminKMS.MountRoutes(deps.Router)
}

// MountSpamCorpusAdminRoutes registers the internal corpus export endpoint.
func MountSpamCorpusAdminRoutes(deps Deps) {
	if deps.Router == nil || deps.SpamCorpusAdmin == nil {
		return
	}

	deps.SpamCorpusAdmin.MountRoutes(deps.Router)
}

// MountIdentityAPISurface assembles the complete migrated cohort for
// standalone server construction. main.go invokes the focused helpers at the
// original public, authenticated, idempotent, and internal interleaving points.
func MountIdentityAPISurface(deps Deps) {
	if deps.Router == nil || deps.Pool == nil || deps.Auth == nil ||
		deps.AuthBruteforceMiddleware == nil || deps.APIKeys == nil ||
		deps.APIKeyCalls == nil || deps.APIDocs == nil || deps.SCIMAdmin == nil ||
		deps.SCIMPublic == nil || deps.AuditSinkAdmin == nil || deps.AdminKMS == nil ||
		deps.SpamCorpusAdmin == nil {
		return
	}

	MountPublicAuthRoutes(deps)
	MountOAuthRoutes(deps)
	MountAuthenticatedAuthMeRoute(deps)
	MountAuthenticatedAuthRoutes(deps)
	MountAdminIPRoutes(deps)
	MountAPIKeyRoutes(deps)
	MountAPIKeyCallRoutes(deps)
	MountAPIDocRoutes(deps)
	MountScoringRoutes(deps)
	MountAuditSinkRoutes(deps)
	MountSCIMAdminRoutes(deps)
	MountSCIMPublicRoutes(deps)
	MountAdminKMSRoutes(deps)
	MountSpamCorpusAdminRoutes(deps)
}
