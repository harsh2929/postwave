package middleware

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/postwave/postwave/packages/runtime/tenantengine"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"

	"time"
)

// Tenant is the request-scoped tenant identity attached to ctx by
// TenantMiddleware. It is the minimum surface needed by handlers; richer
// projections live in their own packages.
type Tenant struct {
	ID   string
	Slug string
	Name string
	Tier string
}

// User is the request-scoped acting user. May be nil-valued in dev mode
// where only X-Tenant-Slug is provided and no session/API key identity exists.
type User struct {
	ID             string
	TenantID       string
	SessionID      string
	ExternalUserID string
	Email          string
	// Role is the durable, immutable role from users.role. It is the
	// authoritative role for escalation decisions and audit attribution.
	// The SUB-091 View-as-Viewer preview NEVER changes this.
	Role string
	// EffectiveRole is the role the UI gates on for THIS session (SUB-091).
	// It equals Role unless the session has an active, strictly-down-only
	// role_override (View-as-Viewer preview). Empty string means "no
	// override resolved" — callers should treat it as equal to Role. Use
	// EffectiveRoleOrDurable() to read the coalesced value.
	EffectiveRole string
	// MFASatisfied reports whether the current session has passed
	// per-session TOTP step-up. False until the user submits a valid
	// TOTP code via /api/v1/auth/totp/challenge. RequireMFAIfPolicy
	// reads this against the tenant's require_2fa_for_* settings.
	MFASatisfied bool
	// MFASatisfiedAt is WHEN that proof was given. The boolean answers "ever",
	// which is all a session gate needs; a step-up gate needs "recently", and
	// without this it cannot be asked. Zero means no record — treated as stale.
	MFASatisfiedAt time.Time
}

// EffectiveRoleOrDurable returns the SUB-091 effective role when one was
// resolved for the session, falling back to the durable Role otherwise.
// Permission gating that should honor the View-as-Viewer preview reads
// this; escalation checks keep reading the durable Role directly.
func (u *User) EffectiveRoleOrDurable() string {
	if u == nil {
		return ""
	}
	if u.EffectiveRole != "" {
		return u.EffectiveRole
	}
	return u.Role
}

type ctxKey int

const (
	ctxKeyTenant ctxKey = iota + 1
	ctxKeyUser
)

// TenantFromContext returns the tenant attached to ctx by TenantMiddleware.
func TenantFromContext(ctx context.Context) (*Tenant, bool) {
	t, ok := ctx.Value(ctxKeyTenant).(*Tenant)
	return t, ok && t != nil
}

// WithTenant attaches a resolved tenant identity to ctx for downstream
// handlers and middleware.
func WithTenant(ctx context.Context, t *Tenant) context.Context {
	if t != nil {
		ctx = tenantengine.WithTenant(ctx, t.ID)
	}
	return context.WithValue(ctx, ctxKeyTenant, t)
}

// UserFromContext returns the user attached to ctx by TenantMiddleware. May
// be missing in dev mode where only X-Tenant-Slug is supplied.
func UserFromContext(ctx context.Context) (*User, bool) {
	u, ok := ctx.Value(ctxKeyUser).(*User)
	return u, ok && u != nil
}

// TenantOptions controls auth resolution behavior. AllowDevSlugHeader
// is the legacy unsafe shortcut (kept gated on env for local CI);
// SessionResolver is the browser/webview session-cookie path and
// APIKeyTenantBound is the first-party/SDK API-key path.
type TenantOptions struct {
	AllowDevSlugHeader bool

	// SessionResolver, when non-nil, is consulted FIRST. It receives
	// the request and returns the resolved (Tenant, User) pair when
	// a valid session cookie is present. A nil return means "no
	// session" — fall through to the legacy paths.
	//
	// The auth package owns the cookie + DB lookup; this interface
	// stays narrow to avoid the auth-↔-middleware import cycle.
	SessionResolver func(r *http.Request) (*Tenant, *User, error)

	// APIKeyTenantBound, when non-nil, returns the tenant+user already
	// resolved by the api-keys middleware (which runs before this one
	// in the chi chain). When set we skip session + dev paths.
	APIKeyTenantBound func(r *http.Request) (*Tenant, *User, bool)
}

// TenantMiddleware resolves the active tenant for a request and attaches
// (*Tenant, *User) to the context. It is intentionally NOT registered
// globally — mount it on a sub-router that fronts protected routes:
//
//	r.Group(func(r chi.Router) {
//	    r.Use(middleware.TenantMiddleware(pool))
//	    r.Get("/api/v1/me", handlers.Me)
//	})
//
// Resolution order:
//
//  1. Tenant-bound API key identity resolved by api-keys middleware.
//  2. Native auth session cookie resolved by apps/api/internal/auth.
//  3. X-Tenant-Slug header — opt-in dev-mode fallback. Looks up the tenant
//     by slug. No user is attached (the slug alone doesn't identify a
//     person).
//
// On miss, responds 401 with a JSON error envelope.
func TenantMiddleware(pool *db.Pool) func(http.Handler) http.Handler {
	return TenantMiddlewareWithOptions(pool, TenantOptions{})
}

// TenantMiddlewareWithOptions is TenantMiddleware with explicit runtime
// switches for dev-only fallback behavior.
func TenantMiddlewareWithOptions(pool *db.Pool, opts TenantOptions) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := r.Context()

			if _, ok := TenantFromContext(ctx); ok {
				next.ServeHTTP(w, r)
				return
			}

			// (0) API key path — the apikey middleware runs before this
			// in the chi chain and binds the tenant via WithTenant. If
			// it didn't fire (cookie-session client), fall through.
			if opts.APIKeyTenantBound != nil {
				if t, u, ok := opts.APIKeyTenantBound(r); ok {
					ctx = WithTenant(ctx, t)
					if u != nil {
						ctx = withUserOnContext(ctx, u)
					}
					next.ServeHTTP(w, r.WithContext(ctx))
					return
				}
			}

			// (1) Session-cookie path — the production auth flow. The
			// auth package owns the cookie + DB lookup; we hold a
			// callback here to dodge the import cycle.
			if opts.SessionResolver != nil {
				tenant, user, err := opts.SessionResolver(r)
				if err == nil && tenant != nil {
					ctx = WithTenant(ctx, tenant)
					if user != nil {
						ctx = withUserOnContext(ctx, user)
					}
					next.ServeHTTP(w, r.WithContext(ctx))
					return
				}
				// Resolver returned no session — fall through to dev
				// header (if enabled) or the 401 below.
			}

			// (2) Dev-mode tenant slug header.
			if !opts.AllowDevSlugHeader {
				writeJSONError(w, http.StatusUnauthorized, "missing_tenant",
					"no session cookie or API key provided")
				return
			}

			slug := strings.TrimSpace(r.Header.Get("X-Tenant-Slug"))
			if slug == "" {
				writeJSONError(w, http.StatusUnauthorized, "missing_tenant",
					"no session cookie, API key, or X-Tenant-Slug provided")
				return
			}

			tenant, err := lookupTenantBySlug(ctx, pool, slug)
			if err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					writeJSONError(w, http.StatusUnauthorized, "tenant_not_found",
						"no tenant with that slug")
					return
				}
				writeJSONError(w, http.StatusInternalServerError, "tenant_lookup_failed",
					"failed to resolve tenant")
				return
			}

			ctx = WithTenant(ctx, tenant)
			// Resolve-or-create a synthetic dev user so endpoints that
			// require `UserFromContext` (e.g. settings/notifications,
			// privacy requests, subscriber notes author attribution)
			// behave correctly under the dev slug-header bypass.
			//
			// We only do this when the slug-header path is active —
			// production session/API-key paths set their own user
			// identity above. If the lookup-or-create fails we still
			// proceed; handlers that need a user will surface 401.
			if u := lookupOrCreateDevUser(ctx, pool, tenant.ID); u != nil {
				ctx = withUserOnContext(ctx, u)
			}

			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func lookupTenantBySlug(ctx context.Context, pool *db.Pool, slug string) (*Tenant, error) {
	// Bootstrap lookup: app.tenant_id is not yet bound, so we open a
	// short tenant-resolver tx that sets app.tenant_resolver = 'true'.
	// Migration 0333 narrowed the SELECT policy on `tenants` to the
	// (resolver OR own-tenant) gate — outside this resolver scope a
	// raw `SELECT FROM tenants` returns zero rows for postwave_app.
	tx, err := db.WithTenantResolver(ctx, pool)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // read-only tx; rollback is the close

	const q = `SELECT id::text, slug, name, tier FROM tenants WHERE slug = $1`
	row := tx.QueryRow(ctx, q, slug)
	var t Tenant
	if err := row.Scan(&t.ID, &t.Slug, &t.Name, &t.Tier); err != nil {
		return nil, err
	}
	return &t, nil
}

func writeJSONError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]any{
			"code":    code,
			"message": message,
		},
	})
}

// withTenantOnContext is exposed for tests that want to inject a Tenant
// without going through HTTP.
func withTenantOnContext(ctx context.Context, t *Tenant) context.Context {
	return WithTenant(ctx, t)
}

// withUserOnContext mirrors withTenantOnContext for *User.
func withUserOnContext(ctx context.Context, u *User) context.Context {
	return context.WithValue(ctx, ctxKeyUser, u)
}

// WithUser is the exported test/seam variant of withUserOnContext.
// Production code paths reach the user via TenantMiddleware; tests
// (and the rare in-process composition seam) use this to attach a
// User to a synthetic ctx without spinning up the full middleware
// chain.
func WithUser(ctx context.Context, u *User) context.Context {
	return withUserOnContext(ctx, u)
}

// devUserEmail is the synthetic identity used by lookupOrCreateDevUser.
// One row per tenant; the email is stable so subsequent dev requests
// resolve to the same user_id without churn.
const devUserEmail = "dev@postwave.local"

// lookupOrCreateDevUser ensures a single canonical synthetic user
// exists for the tenant when the dev slug-header bypass is the only
// identity. Returns nil on any error — callers treat that as "no user
// attached" and pass through to the existing 401 path for handlers
// that strictly require a user.
//
// Runs inside a tenant-scoped transaction because `set_config(...,
// true)` is transaction-local; pgx pool connections persist across
// statements but the GUC would be unset between Exec calls without
// the tx boundary.
func lookupOrCreateDevUser(ctx context.Context, pool *db.Pool, tenantID string) *User {
	if pool == nil || tenantID == "" {
		return nil
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return nil
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var u User
	u.TenantID = tenantID
	err = tx.QueryRow(ctx, `
SELECT id::text, COALESCE(external_user_id, ''), email, role
  FROM users
 WHERE tenant_id = $1::uuid AND email = $2`, tenantID, devUserEmail).Scan(
		&u.ID, &u.ExternalUserID, &u.Email, &u.Role)
	if err == nil {
		_ = tx.Commit(ctx)
		return &u
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	// Create the dev user. role='owner' so dev requests can act
	// admin-equivalently; matches the AllowDevAdminRoleHeader pattern.
	// The unique index is on (tenant_id, lower(email)), so the
	// ON CONFLICT target must use the expression form.
	err = tx.QueryRow(ctx, `
INSERT INTO users (tenant_id, email, role)
VALUES ($1::uuid, $2, 'owner')
ON CONFLICT (tenant_id, lower(email)) DO UPDATE SET role = 'owner'
RETURNING id::text, COALESCE(external_user_id, ''), email, role`,
		tenantID, devUserEmail).Scan(
		&u.ID, &u.ExternalUserID, &u.Email, &u.Role)
	if err != nil {
		return nil
	}
	if err := tx.Commit(ctx); err != nil {
		return nil
	}
	return &u
}
