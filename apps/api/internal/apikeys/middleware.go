// SPDX-License-Identifier: AGPL-3.0-only
package apikeys

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/sandbox"
)

// Resolver is the subset of *Repo this middleware needs.
//
// HashKey is part of the interface so the middleware never has to know
// which hashing scheme (peppered HMAC vs. legacy SHA-256) the deployment
// is running. *Repo holds the pepper; tests can supply a fake.
type Resolver interface {
	HashKey(plaintext string) string
	LookupByHash(ctx context.Context, hash string) (*APIKey, error)
	TouchLastUsed(ctx context.Context, id string) error
}

// AuthResolver is an optional fast-path interface implemented by
// AuthCache. When the resolver satisfies it, the middleware uses
// ResolveAuth to fetch the api_key + tenant in one cached call
// instead of two separate DB round trips.
type AuthResolver interface {
	ResolveAuth(ctx context.Context, hash string) (*APIKey, *middleware.Tenant, error)
}

type scopesCtxKey struct{}

// MiddlewareOptions controls optional authentication paths layered onto the
// standard API-key resolver.
type MiddlewareOptions struct {
	// StreamTokenSecret verifies short-lived pws_ tokens used only for SSE
	// endpoints where EventSource cannot send Authorization headers.
	StreamTokenSecret []byte
	// SupplementalBearerResolvers resolve non-api-key bearer tokens that
	// should still enter the same tenant + scope authorization path as API
	// keys. Marketplace OAuth access tokens use this hook.
	SupplementalBearerResolvers []SupplementalBearerResolver
	// TrustForwardedIPHeaders allows the canonical client-IP resolver to use
	// forwarded headers, but only when the untouched TCP peer belongs to the
	// configured trusted-proxy CIDR set. It never enables leftmost-header trust.
	TrustForwardedIPHeaders bool
}

// SupplementalBearerResolver authenticates a non-api-key bearer token.
// Implementations should return true from SupportsBearerToken only for
// token prefixes they own so normal API keys don't fan out to every resolver.
type SupplementalBearerResolver interface {
	SupportsBearerToken(plaintext string) bool
	ResolveBearerToken(ctx context.Context, plaintext string) (*SupplementalBearerAuth, error)
}

// SupplementalBearerAuth is the tenant/scope context produced by a
// SupplementalBearerResolver. APIKeyID is optional; leave it empty when the
// credential is not an api_keys row so downstream FK-backed observability
// does not try to cast it as api_keys.id.
type SupplementalBearerAuth struct {
	Tenant      *middleware.Tenant
	Scopes      []Scope
	ActorType   string
	ActorLabel  string
	APIKeyID    string
	SandboxOnly bool
}

// WithScopes attaches API key scopes to ctx. The slice is copied so callers can
// safely reuse or mutate their original key model.
func WithScopes(ctx context.Context, scopes []Scope) context.Context {
	cp := append([]Scope(nil), scopes...)
	return context.WithValue(ctx, scopesCtxKey{}, cp)
}

// ScopesFromContext returns the API key scopes attached by Middleware.
func ScopesFromContext(ctx context.Context) []Scope {
	scopes, _ := ctx.Value(scopesCtxKey{}).([]Scope)
	return append([]Scope(nil), scopes...)
}

type streamTokenExpiryCtxKey struct{}

func withStreamTokenExpiry(ctx context.Context, expiresAt time.Time) context.Context {
	return context.WithValue(ctx, streamTokenExpiryCtxKey{}, expiresAt.UTC())
}

// StreamTokenExpiryFromContext returns the hard credential deadline for a
// request admitted by a pws_ URL token. SSE handlers use it to prevent an
// already-admitted connection from outliving the credential that authorized it.
func StreamTokenExpiryFromContext(ctx context.Context) (time.Time, bool) {
	expiresAt, ok := ctx.Value(streamTokenExpiryCtxKey{}).(time.Time)
	return expiresAt, ok && !expiresAt.IsZero()
}

// HasScope reports whether ctx carries any required scope. ScopeAdmin grants
// all permissions.
func HasScope(ctx context.Context, required ...Scope) bool {
	scopes, _ := ctx.Value(scopesCtxKey{}).([]Scope)
	for _, s := range scopes {
		if s == ScopeAdmin {
			return true
		}
		for _, req := range required {
			if s == req {
				return true
			}
		}
	}
	return false
}

// HasAllScopes reports whether ctx carries every required scope. ScopeAdmin
// grants all permissions.
func HasAllScopes(ctx context.Context, required ...Scope) bool {
	if len(required) == 0 {
		return true
	}
	scopes, _ := ctx.Value(scopesCtxKey{}).([]Scope)
	have := map[Scope]struct{}{}
	for _, s := range scopes {
		if s == ScopeAdmin {
			return true
		}
		have[s] = struct{}{}
	}
	for _, req := range required {
		if _, ok := have[req]; !ok {
			return false
		}
	}
	return true
}

// RequireAPIKeyScope is an alias for RequireScope kept for callers
// that want to be explicit about which auth path the gate covers.
// The session-cookie role-check overlap inside RequireScope makes the
// historical name misleading; new code should prefer this alias.
func RequireAPIKeyScope(required ...Scope) func(http.Handler) http.Handler {
	return RequireScope(required...)
}

// RequireRole enforces a session-cookie role check (owner/admin) on a
// route. API-key requests bypass the check (they should use
// RequireAPIKeyScope instead). Use this on routes where you want to
// require a specific dashboard role without coupling to the API-key
// scope enum.
func RequireRole(roles ...string) func(http.Handler) http.Handler {
	allowed := make(map[string]struct{}, len(roles))
	for _, r := range roles {
		allowed[strings.ToLower(strings.TrimSpace(r))] = struct{}{}
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if middleware.IsAPIKeyAuth(r.Context()) {
				// API-key path: trust the upstream scope check.
				next.ServeHTTP(w, r)
				return
			}
			u, ok := middleware.UserFromContext(r.Context())
			if !ok {
				writeInsufficientRoleDenial(w, "this route requires an authenticated dashboard user")
				return
			}
			if _, in := allowed[strings.ToLower(strings.TrimSpace(u.Role))]; !in {
				writeInsufficientRoleDenial(w, "this route requires a higher role")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// RequireExactTenantAdmin protects tenant control-plane and raw telemetry
// routes whose contents must not be delegated through custom-role grants. API
// keys require the exact admin scope; dashboard sessions require the effective
// (view-as aware) owner/admin role. This intentionally does not consult stored
// additive grants.
func RequireExactTenantAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if middleware.IsAPIKeyAuth(r.Context()) {
			if HasScope(r.Context(), ScopeAdmin) {
				next.ServeHTTP(w, r)
				return
			}
			writeInsufficientScopeDenial(w, "an admin-scoped API key is required for this route")
			return
		}
		user, ok := middleware.UserFromContext(r.Context())
		if !ok || user == nil {
			writeJSON(w, http.StatusUnauthorized, errEnv("missing_principal",
				"an authenticated API key or dashboard user is required"))
			return
		}
		if !isAdminOrOwner(user.EffectiveRoleOrDurable()) {
			writeInsufficientRoleDenial(w, "an effective owner or admin role is required for this route")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RequireScope enforces scopes for API-key-authenticated requests AND
// enforces a role check for session-cookie-authenticated requests when
// any of the required scopes is admin-tier.
//
// Background (PRODUCTION_READINESS.md "RequireScope is a no-op for
// dashboard"): the original behaviour only checked the scope when
// `IsAPIKeyAuth(ctx)` returned true. For session-cookie requests, the
// middleware was a no-op — every dashboard route gated with
// `RequireScope(ScopeAdmin)` was reachable by member/viewer roles.
// That's a privilege-escalation surface.
//
// New behaviour:
//   - API-key auth: check scopes (unchanged).
//   - Session-cookie auth: if any required scope is admin-tier
//     (anything NOT in readOnlyScopes), the user's role MUST be
//     owner or admin. Read-only scopes admit any authenticated dashboard
//     user. A missing verified principal always returns 401.
func RequireScope(required ...Scope) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if middleware.IsAPIKeyAuth(r.Context()) {
				if HasScope(r.Context(), required...) {
					next.ServeHTTP(w, r)
					return
				}
				writeInsufficientScopeDenial(w, "api key does not have permission for this route")
				return
			}
			u, ok := middleware.UserFromContext(r.Context())
			if !ok {
				writeJSON(w, http.StatusUnauthorized, errEnv("missing_principal",
					"an authenticated API key or dashboard user is required"))
				return
			}
			if !sessionAuditScopesAllowed(r.Context(), required, false) {
				writeInsufficientScopeDenial(w, "your role does not have permission for this audit route")
				return
			}
			// Session-cookie path: enforce role when a scope is not
			// read-only. Editors may exercise the content-write scopes
			// (write:subscribers / write:campaigns) so the desktop's editor
			// tier actually functions (D04#2); everything else stays
			// owner/admin-only.
			if requireAdminRoleForScopes(required) {
				if !sessionRoleAllowsScopes(u.EffectiveRoleOrDurable(), required) &&
					// G-48: a custom role may have been granted these scopes in
					// roles_permissions. Additive + fail-closed — only ever allows
					// more, so it cannot loosen or break the hardcoded tiers above.
					!storedGrantsCoverScopes(r.Context(), u.EffectiveRoleOrDurable(), required) {
					writeInsufficientRoleDenial(w, "your role does not have permission for this route")
					return
				}
			}
			next.ServeHTTP(w, r)
		})
	}
}

// RequireAllScopes is the strict variant for high-risk routes that need a
// conjunction of permissions, such as write + send. Same dashboard
// role-check rules as RequireScope.
func RequireAllScopes(required ...Scope) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if middleware.IsAPIKeyAuth(r.Context()) {
				if HasAllScopes(r.Context(), required...) {
					next.ServeHTTP(w, r)
					return
				}
				writeInsufficientScopeDenial(w, "api key does not have permission for this route")
				return
			}
			u, ok := middleware.UserFromContext(r.Context())
			if !ok {
				writeJSON(w, http.StatusUnauthorized, errEnv("missing_principal",
					"an authenticated API key or dashboard user is required"))
				return
			}
			if !sessionAuditScopesAllowed(r.Context(), required, true) {
				writeInsufficientScopeDenial(w, "your role does not have every permission required for this audit route")
				return
			}
			if requireAdminRoleForScopes(required) {
				if !sessionRoleAllowsScopes(u.EffectiveRoleOrDurable(), required) &&
					// G-48: a custom role may have been granted these scopes in
					// roles_permissions. Additive + fail-closed — only ever allows
					// more, so it cannot loosen or break the hardcoded tiers above.
					!storedGrantsCoverScopes(r.Context(), u.EffectiveRoleOrDurable(), required) {
					writeInsufficientRoleDenial(w, "your role does not have permission for this route")
					return
				}
			}
			next.ServeHTTP(w, r)
		})
	}
}

func sessionAuditScopesAllowed(ctx context.Context, required []Scope, requireAll bool) bool {
	auditRequired := make([]Scope, 0, len(required))
	for _, scope := range required {
		if strings.HasPrefix(string(scope), "audit:") {
			auditRequired = append(auditRequired, scope)
		}
	}
	if len(auditRequired) == 0 {
		return true
	}
	if requireAll {
		return HasAllScopes(ctx, auditRequired...)
	}
	return HasScope(ctx, auditRequired...)
}

// editorWriteScopes are the content-mutation scopes the "editor" role may
// exercise on the session-cookie path (D04#2). Deliberately narrow: the
// desktop's editor tier edits audience + campaign content (write:subscribers
// covers subscribers/tags/saved-segments; write:campaigns covers campaign
// drafts), but billing, api-keys, audit configuration, transactional send,
// and domain/DNS stay owner/admin-only.
var editorWriteScopes = map[Scope]struct{}{
	ScopeWriteSubscribers: {},
	ScopeWriteCampaigns:   {},
}

// sessionRoleAllowsScopes reports whether a dashboard (session-cookie)
// user with the given durable role may satisfy every required scope.
// Read-only scopes pass for any role; content-write scopes additionally
// pass for editor; every other (admin-tier) scope requires owner/admin.
func sessionRoleAllowsScopes(role string, scopes []Scope) bool {
	isAdmin := isAdminOrOwner(role)
	isEditor := strings.EqualFold(strings.TrimSpace(role), "editor")
	for _, s := range scopes {
		if _, ok := readOnlyScopes[s]; ok {
			continue
		}
		if isAdmin {
			continue
		}
		if isEditor {
			if _, ok := editorWriteScopes[s]; ok {
				continue
			}
		}
		return false
	}
	return true
}

// readOnlyScopes is the allowlist of scopes that do NOT require an
// owner/admin role on the session-cookie path. Anything outside this
// set is considered admin-tier and triggers the dashboard role check.
//
// Inverted (allowlist) rather than denylist because the original
// `strings.HasPrefix("write:")` check silently let through several
// privileged scopes that aren't named `write:*` — namely
// `send:transactional`, the destructive `audit:configure_*` /
// `audit:execute_actions` levers, and the privileged
// `audit:read_pii` / `audit:read_all_tenants` reads. New scopes
// added to the catalog will default to admin-tier unless explicitly
// listed here, which fails closed.
var readOnlyScopes = map[Scope]struct{}{
	ScopeReadSubscribers: {},
	ScopeReadCampaigns:   {},
	ScopeReadReports:     {},
	ScopeAuditRead:       {},
}

// requireAdminRoleForScopes returns true when any of the scopes is
// admin-tier — i.e. is NOT in the readOnlyScopes allowlist.
// Read-only routes don't trigger the role check.
func requireAdminRoleForScopes(scopes []Scope) bool {
	for _, s := range scopes {
		if _, ok := readOnlyScopes[s]; !ok {
			return true
		}
	}
	return false
}

// isAdminOrOwner returns true when role is owner or admin (case-insensitive,
// trimmed). Treat unknown / empty role as non-admin to fail closed.
func isAdminOrOwner(role string) bool {
	r := strings.ToLower(strings.TrimSpace(role))
	return r == "owner" || r == "admin"
}

// Middleware accepts `Authorization: Bearer pw_*` for SDK/API callers,
// resolves the hashed key to its owning tenant, and attaches the tenant and
// actor metadata to the shared request context.
func Middleware(pool *db.Pool, resolver Resolver) func(http.Handler) http.Handler {
	return MiddlewareWithOptions(pool, resolver, MiddlewareOptions{})
}

func MiddlewareWithOptions(pool *db.Pool, resolver Resolver, opts MiddlewareOptions) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := r.Context()
			plaintext, credentialPresent, credentialErr := bearerCredentialFromRequest(r)
			if credentialErr != nil {
				writeJSON(w, http.StatusUnauthorized, errEnv("invalid_authorization",
					"the Authorization credential is malformed or unsupported"))
				return
			}

			if _, ok := middleware.TenantFromContext(ctx); ok {
				if credentialPresent {
					writeJSON(w, http.StatusUnauthorized, errEnv("conflicting_credentials",
						"a tenant context and a second bearer credential cannot be combined"))
					return
				}
				next.ServeHTTP(w, r)
				return
			}

			if token := streamTokenFromRequest(r); token != "" {
				if credentialPresent {
					writeJSON(w, http.StatusUnauthorized, errEnv("conflicting_credentials",
						"use exactly one authentication credential per request"))
					return
				}
				if !streamTokenAllowedPath(r.URL.Path) {
					writeJSON(w, http.StatusUnauthorized, errEnv("invalid_stream_token",
						"stream token is only accepted on realtime stream routes"))
					return
				}
				claims, err := ParseStreamToken(opts.StreamTokenSecret, token, time.Now().UTC())
				if err != nil {
					writeJSON(w, http.StatusUnauthorized, errEnv("invalid_stream_token",
						"the supplied stream token is invalid or expired"))
					return
				}
				ctx = middleware.WithTenant(ctx, &middleware.Tenant{
					ID: claims.TenantID,
				})
				// A stream token carries the actor that minted it. Older or
				// incomplete tokens may omit that claim; the canonical audit_log
				// vocabulary has no transport-specific "stream" actor, so fall
				// back to the ordinary human principal rather than writing a value
				// rejected by the database constraint.
				ctx = middleware.WithActor(ctx, firstNonEmpty(claims.ActorType, "human"),
					firstNonEmpty(claims.PrincipalID, claims.ActorLabel))
				ctx = middleware.WithAPIKeyAuth(ctx)
				ctx = WithScopes(ctx, claims.Scopes)
				ctx = withStreamTokenExpiry(ctx, time.Unix(claims.ExpiresAt, 0))
				next.ServeHTTP(w, r.WithContext(ctx))
				return
			}

			// Long-lived pw_ API keys are accepted only in the Authorization
			// header. Browser/EventSource callers must mint a two-minute pws_
			// token; URL query strings are retained by edge access logs.
			if plaintext == "" {
				next.ServeHTTP(w, r)
				return
			}

			if auth, handled, err := resolveSupplementalBearer(ctx, plaintext, opts.SupplementalBearerResolvers); handled {
				if err != nil || auth == nil || auth.Tenant == nil || auth.Tenant.ID == "" {
					writeJSON(w, http.StatusUnauthorized, errEnv("invalid_api_key",
						"the supplied bearer token is not recognized"))
					return
				}
				ctx = middleware.WithTenant(ctx, auth.Tenant)
				// Supplemental bearer credentials represent software agents.
				// Their app/install identity belongs in actor_label; actor_type is
				// deliberately limited to the canonical audit_log vocabulary.
				ctx = middleware.WithActor(ctx, firstNonEmpty(auth.ActorType, "agent"), auth.ActorLabel)
				if auth.APIKeyID != "" {
					ctx = middleware.WithAPIKeyID(ctx, auth.APIKeyID)
				}
				ctx = middleware.WithAPIKeyAuth(ctx)
				ctx = WithScopes(ctx, auth.Scopes)
				if auth.SandboxOnly {
					ctx = sandbox.WithFlag(ctx)
				}
				next.ServeHTTP(w, r.WithContext(ctx))
				return
			}

			hash := resolver.HashKey(plaintext)

			// Fast path: when the resolver is an AuthCache, fetch
			// the api_key AND tenant in one cached call. This
			// collapses the three Pg tx that used to fire per
			// request (LookupByHash + lookupTenantByID +
			// TouchLastUsed) into zero on the cache-hit case.
			var key *APIKey
			var tenant *middleware.Tenant
			if cached, ok := resolver.(AuthResolver); ok {
				var err error
				key, tenant, err = cached.ResolveAuth(ctx, hash)
				if err != nil {
					writeJSON(w, http.StatusUnauthorized, errEnv("invalid_api_key",
						"the supplied bearer token is not recognized"))
					return
				}
				// IP allowlist still runs per request — see
				// note below.
				if !ipAllowed(key.AllowedIPs, requestIP(r, opts.TrustForwardedIPHeaders)) {
					writeJSON(w, http.StatusUnauthorized, errEnv("invalid_api_key",
						"the supplied bearer token is not recognized"))
					return
				}
			} else {
				var err error
				key, err = resolver.LookupByHash(ctx, hash)
				if err != nil {
					writeJSON(w, http.StatusUnauthorized, errEnv("invalid_api_key",
						"the supplied bearer token is not recognized"))
					return
				}

				// IP allowlist: per-key list. Empty/nil = unrestricted.
				// Failure to parse the request IP fails closed when an
				// allowlist is set (better to reject a legitimate request
				// than allow one we can't authenticate the source of).
				// We return the same 401 + invalid_api_key code so a
				// dragnet attacker can't distinguish "wrong key" from
				// "right key, wrong IP" — same rationale as Stripe's
				// IP-restricted keys.
				if !ipAllowed(key.AllowedIPs, requestIP(r, opts.TrustForwardedIPHeaders)) {
					writeJSON(w, http.StatusUnauthorized, errEnv("invalid_api_key",
						"the supplied bearer token is not recognized"))
					return
				}

				tenant, err = lookupTenantByID(ctx, pool, key.TenantID)
				if err != nil {
					writeJSON(w, http.StatusUnauthorized, errEnv("tenant_not_found",
						"api key references a missing tenant"))
					return
				}
			}
			// Cache entries are allowed to outlive the wall-clock expiry by no
			// amount: re-check the immutable expiry on every hit. Revocation and
			// scope reductions require cache invalidation because a cached object
			// cannot infer a later database mutation.
			if key == nil || (key.ExpiresAt != nil && !time.Now().UTC().Before(*key.ExpiresAt)) {
				if invalidator, ok := resolver.(interface{ Invalidate(string) }); ok {
					invalidator.Invalidate(hash)
				}
				writeJSON(w, http.StatusUnauthorized, errEnv("invalid_api_key",
					"the supplied bearer token is not recognized"))
				return
			}

			// TouchLastUsed: when the resolver is an AuthCache,
			// this is a non-blocking map insert that's drained by
			// the batched touch flusher every 5 s. Otherwise we
			// keep the legacy "fire-and-forget goroutine" so each
			// touch still opens its own tx.
			if _, cached := resolver.(AuthResolver); cached {
				_ = resolver.TouchLastUsed(ctx, key.ID)
			} else {
				go touchLastUsed(resolver, key.ID)
			}

			ctx = middleware.WithTenant(ctx, tenant)
			if strings.TrimSpace(key.UserID) != "" {
				ctx = middleware.WithUser(ctx, &middleware.User{
					ID:       key.UserID,
					TenantID: key.TenantID,
				})
			}
			ctx = middleware.WithActor(ctx, key.ActorType, key.ActorLabel)
			ctx = middleware.WithAPIKeyID(ctx, key.ID)
			ctx = middleware.WithAPIKeyAuth(ctx)
			ctx = WithScopes(ctx, key.Scopes)
			if key.SandboxOnly {
				ctx = sandbox.WithFlag(ctx)
			}
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// bearerCredentialFromRequest parses credentials before any session fallback.
// HTTP auth schemes are case-insensitive, but the shape is deliberately strict:
// exactly one Bearer token, owned by Moosewave's pw_ namespace. Long-lived API
// keys are never accepted in a query string because edge access logs retain the
// URL; EventSource/download callers use short-lived pws_ stream tokens instead.
// A malformed, foreign, or ambiguous credential is rejected instead of being
// ignored and then accidentally authenticated by an ambient session cookie.
func bearerCredentialFromRequest(r *http.Request) (token string, present bool, err error) {
	if r == nil {
		return "", false, nil
	}
	authValues := r.Header.Values("Authorization")
	queryValues := r.URL.Query()["api_key"]
	if len(authValues) > 1 || len(queryValues) > 0 {
		return "", true, errMalformedAuthorization
	}
	authHeader := ""
	if len(authValues) == 1 {
		authHeader = strings.TrimSpace(authValues[0])
	}
	if authHeader != "" {
		parts := strings.Fields(authHeader)
		if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || !strings.HasPrefix(parts[1], "pw_") {
			return "", true, errMalformedAuthorization
		}
		return parts[1], true, nil
	}
	return "", false, nil
}

var errMalformedAuthorization = &authorizationError{}

type authorizationError struct{}

func (*authorizationError) Error() string { return "malformed authorization" }

func resolveSupplementalBearer(ctx context.Context, plaintext string, resolvers []SupplementalBearerResolver) (*SupplementalBearerAuth, bool, error) {
	for _, resolver := range resolvers {
		if resolver == nil || !resolver.SupportsBearerToken(plaintext) {
			continue
		}
		auth, err := resolver.ResolveBearerToken(ctx, plaintext)
		return auth, true, err
	}
	return nil, false, nil
}

func firstNonEmpty(v, fallback string) string {
	if v != "" {
		return v
	}
	return fallback
}

func lookupTenantByID(ctx context.Context, pool *db.Pool, id string) (*middleware.Tenant, error) {
	// Bootstrap lookup: this runs *before* TenantMiddleware binds
	// app.tenant_id, so we open a short tenant-resolver tx so the
	// resolver-only SELECT policy on `tenants` (migration 0333) fires.
	// Without this the post-0333 narrow policy returns zero rows and
	// the API-key handshake fails with "tenant not found" for every
	// caller. We could equivalently filter the policy by `id =
	// app.tenant_id` here, but the API-key path hasn't bound that GUC
	// yet — the whole point of this lookup is to find the row that
	// lets us bind it.
	tx, err := db.WithTenantResolver(ctx, pool)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // read-only tx

	const q = `SELECT id::text, slug, name, tier FROM tenants WHERE id::text = $1`
	row := tx.QueryRow(ctx, q, id)
	var t middleware.Tenant
	if err := row.Scan(&t.ID, &t.Slug, &t.Name, &t.Tier); err != nil {
		return nil, err
	}
	return &t, nil
}

func touchLastUsed(resolver Resolver, id string) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = resolver.TouchLastUsed(ctx, id)
}
