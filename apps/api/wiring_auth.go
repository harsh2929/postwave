// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/auth"
	"github.com/postwave/postwave/apps/api/internal/config"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/mailer"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/mobilepush"
	"github.com/postwave/postwave/apps/api/internal/notifyfanout"
	"github.com/postwave/postwave/apps/api/internal/outbox"
	"github.com/postwave/postwave/apps/api/internal/safego"
	"github.com/postwave/postwave/apps/api/internal/sending"
	"github.com/postwave/postwave/apps/api/internal/telemetry"
)

// newSessionResolverFn adapts auth.ResolvedSession into the middleware
// tenant/user pair. Moved verbatim from run().
func newSessionResolverFn(authResolver *auth.Resolver) func(r *http.Request) (*middleware.Tenant, *middleware.User, error) {
	// Adapter exposed to middleware: shape-shifts auth.ResolvedSession
	// into middleware.{Tenant,User} pointers + clears the cookie on
	// expired/revoked.
	sessionResolverFn := func(r *http.Request) (*middleware.Tenant, *middleware.User, error) {
		resolved, err := authResolver.ResolveSession(r)
		if err != nil {
			// Stale cookie — clear it. We don't have ResponseWriter
			// here but the caller in tenant middleware doesn't either;
			// the next request will fail in the same place. To clear
			// proactively we'd need a richer middleware contract.
			return nil, nil, err
		}
		if resolved == nil {
			return nil, nil, nil
		}
		return &middleware.Tenant{
				ID: resolved.TenantID, Slug: resolved.TenantSlug,
				Name: resolved.TenantName, Tier: resolved.TenantTier,
			}, &middleware.User{
				ID: resolved.UserID, TenantID: resolved.TenantID,
				SessionID: resolved.SessionID,
				Email:     resolved.UserEmail, Role: resolved.UserRole,
				// SUB-091: carry the per-session effective role (View-as-Viewer
				// preview). Equals Role unless a down-only role_override is set.
				EffectiveRole:  resolved.EffectiveRole,
				MFASatisfied:   resolved.MFAOK,
				MFASatisfiedAt: resolved.MFAAt,
			}, nil
	}

	return sessionResolverFn
}

// newAuthResolver builds the session resolver bridge that reads tenant +
// user under both resolver GUCs. Moved verbatim from run().
func newAuthResolver(authRepo *auth.Repo, pool *db.Pool) *auth.Resolver {
	// Session resolver bridge — fetches the cosmetic tenant fields +
	// user role given (tenant_id, user_id), which Repo's pre-tenant
	// lookups don't read.
	authResolver := &auth.Resolver{
		Repo: authRepo,
		LookupTenantAndUser: func(ctx context.Context, tenantID, userID string) (
			tenantSlug, tenantName, tenantTier, userEmail, userRole string, err error) {
			// This JOIN reads two RLS-protected tables and must satisfy
			// BOTH policies or the row vanishes and a valid session 401s:
			//   - `users`   permits the resolver via `app.auth_resolver=true`
			//     (users_auth_resolver_read).
			//   - `tenants` permits it via a SEPARATE GUC
			//     `app.tenant_resolver=true` (tenant_resolver_select).
			// Setting only app.auth_resolver leaves the tenants side
			// RLS-filtered → the JOIN returns 0 rows → ErrNoRows → the
			// resolver thinks the user vanished and 401s EVERY cookie-based
			// session (web/desktop/mobile). Set both bypass GUCs.
			tx, terr := pool.BeginTx(ctx, pgx.TxOptions{})
			if terr != nil {
				err = terr
				return
			}
			defer func() { _ = tx.Rollback(ctx) }()
			if _, terr := tx.Exec(ctx, `SELECT set_config('app.auth_resolver', 'true', true), set_config('app.tenant_resolver', 'true', true)`); terr != nil {
				err = terr
				return
			}
			err = tx.QueryRow(ctx, `
SELECT t.slug, t.name, t.tier, u.email, u.role
  FROM tenants t JOIN users u ON u.tenant_id = t.id
 WHERE t.id = $1::uuid AND u.id = $2::uuid AND u.status = 'active'`, tenantID, userID).
				Scan(&tenantSlug, &tenantName, &tenantTier, &userEmail, &userRole)
			if err == nil {
				err = tx.Commit(ctx)
			}
			return
		},
	}

	return authResolver
}

// platformSenderEnv names the platform sender: the From address of the mail
// the platform itself sends through the auth mailer, from sign-in links and
// billing dunning to the operator notifications (segment decay alerts,
// dashboard digests, webhook health alerts).
const platformSenderEnv = "POSTWAVE_AUTH_FROM_ADDRESS"

// configuredPlatformSender returns the configured platform sender, or "" when
// none is configured. It is the only reader of platformSenderEnv, so the auth
// mail and every notification worker agree on what "configured" means.
//
// A worker handed "" keeps its own default From, so an unconfigured
// deployment sends exactly what it always sent; a configured one sends every
// platform notification from the one address its SES identity and IAM policy
// admit. Those defaults are @moosewave.com addresses, which SES rejects on any
// other identity.
func configuredPlatformSender() string {
	return firstEnv(platformSenderEnv)
}

// buildAuthDepsDeps carries the dependencies buildAuthDeps needs.
type buildAuthDepsDeps struct {
	cfg            config.Config
	logger         *slog.Logger
	authRepo       *auth.Repo
	authMailer     mailer.Mailer
	authPepper     []byte
	envCipher      sending.EnvelopeEncryptor
	tracker        telemetry.Tracker
	pool           *db.Pool
	apiKeyResolver *apikeys.Repo
	notifyFanout   *notifyfanout.Fanout
	mobilePushDeps *mobilepush.Deps
}

// buildAuthDeps builds the session cookie options, WebAuthn relying party and
// the auth handler dependencies. Moved verbatim from run().
func buildAuthDeps(d buildAuthDepsDeps) (string, *auth.Deps) {
	cfg := d.cfg
	logger := d.logger
	authRepo := d.authRepo
	authMailer := d.authMailer
	authPepper := d.authPepper
	envCipher := d.envCipher
	tracker := d.tracker
	pool := d.pool
	apiKeyResolver := d.apiKeyResolver
	notifyFanout := d.notifyFanout
	mobilePushDeps := d.mobilePushDeps
	// One guarded decision — see auth.CookieOptionsFor. A Secure cookie issued
	// over plaintext http is discarded by any client on a routable host, and
	// the resulting 401 on the NEXT request is indistinguishable from a wrong
	// password.
	authCookieOpts := auth.CookieOptionsFor(auth.SessionCookieSettings{
		DevTenantSlugHeader: cfg.AllowDevTenantSlugHeader,
		Insecure:            cfg.SessionCookieInsecure,
		Domain:              os.Getenv("POSTWAVE_COOKIE_DOMAIN"),
	})
	if !authCookieOpts.Secure {
		logger.Warn("session cookie Secure attribute disabled",
			"detail", "plaintext-http local development only; never set this in production")
	}
	authFromAddress := cmpOr(configuredPlatformSender(), "Moosewave <noreply@moosewave.com>")
	// AUTH-023: build the WebAuthn relying party once. A bad base URL leaves it
	// nil, which disables the passkey routes (they return webauthn_unwired)
	// rather than failing startup. The RPID is derived from this host, so it
	// MUST use the same public origin the rest of the app advertises
	// (POSTWAVE_PUBLIC_BASE_URL) — a localhost default in prod would silently
	// break every passkey with an origin mismatch.
	authPublicBaseURL := cmpOr(
		cmpOr(os.Getenv("POSTWAVE_PUBLIC_BASE_URL"), os.Getenv("PUBLIC_BASE_URL")),
		"http://localhost:3000",
	)
	webAuthnRP, webAuthnErr := auth.NewWebAuthn(authPublicBaseURL)
	if webAuthnErr != nil {
		logger.Warn("webauthn: passkeys disabled", "err", webAuthnErr.Error())
	}
	authDeps := &auth.Deps{
		Repo:               authRepo,
		Mailer:             authMailer,
		Logger:             logger,
		CookieOptions:      authCookieOpts,
		FromAddress:        authFromAddress,
		PublicBaseURL:      authPublicBaseURL,
		AuthLinkSigningKey: authPepper,
		WebAuthn:           webAuthnRP,
		// SecretCipher: encrypts the TOTP shared secret at rest.
		// Reuses the existing sending-domain envelope cipher so a
		// single KEK rotation surface covers everything secrets-at-rest.
		SecretCipher: envCipher,
		Telemetry:    tracker,
		MeContextLookup: func(r *http.Request) (auth.MeContext, bool) {
			t, ok := middleware.TenantFromContext(r.Context())
			if !ok {
				return auth.MeContext{}, false
			}
			u, _ := middleware.UserFromContext(r.Context())
			mc := auth.MeContext{
				TenantID:   t.ID,
				TenantSlug: t.Slug,
				TenantName: t.Name,
			}
			if u != nil {
				mc.UserID = u.ID
				mc.SessionID = u.SessionID
				mc.UserEmail = u.Email
				mc.UserRole = u.Role
				// SUB-091: surface the per-session effective role so /me
				// returns effective_role + viewer_mode. Falls back to the
				// durable role inside Me when empty.
				mc.EffectiveRole = u.EffectiveRoleOrDurable()
				mc.MFASatisfied = u.MFASatisfied
			}
			return mc, true
		},
		MFARequirementLookup: func(ctx context.Context, tenantID, role string) (bool, bool) {
			return middleware.MFARequiredForUser(ctx, pool, tenantID, role)
		},
		// CLI login (cli_auth.go) mints a scoped key after PKCE exchange.
		// Wired to the apikeys repo here so the auth package needn't import it.
		MintCLIKey: func(ctx context.Context, tenantID, label string, scopes []string) (string, error) {
			plaintext, _, err := apikeys.NewKey()
			if err != nil {
				return "", err
			}
			sc := make([]apikeys.Scope, 0, len(scopes))
			for _, s := range scopes {
				sc = append(sc, apikeys.Scope(s))
			}
			if _, err := apiKeyResolver.Create(ctx, tenantID, label, plaintext, sc); err != nil {
				return "", err
			}
			return plaintext, nil
		},
		// AUTH#47: a sign-in from a device this user has not been seen on
		// becomes a notification with a one-tap revoke. The auth package
		// decides WHETHER to notify (see signin_alert.go); this closure only
		// delivers, through the same notifyfanout chokepoint every other
		// notification uses, so the alert gets one identity across mobile
		// push, web push, the in-app feed, and SSE.
		//
		// The hand-off to a goroutine happens HERE, not in auth, because the
		// SignInNotifier contract forbids blocking: this runs on the login
		// path, and a slow Expo call must never delay a sign-in. safego.Go
		// also contains a panic so a push-provider bug cannot crash the
		// process from inside a login request.
		//
		// context.WithoutCancel keeps the trace/tenant values attached while
		// surviving the request's cancellation — the request is already
		// finished by the time delivery runs, so a plain r.Context() would
		// be cancelled before the first send.
		SignInNotifier: func(ctx context.Context, ev auth.NewDeviceSignIn) {
			deliverCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 20*time.Second)
			safego.Go(logger, "signin-alert", func() {
				defer cancel()
				if err := dispatchNewDeviceSignInAlert(deliverCtx, notifyFanout, mobilePushDeps, ev); err != nil {
					logger.Warn("auth: new-device notification dispatch failed",
						"event", auth.SignInEventType, "tenant_id", ev.TenantID,
						"user_id", ev.UserID, "session_id", ev.SessionID,
						"err", err.Error())
				}
			})
		},
	}

	return authFromAddress, authDeps
}

// initializeAuthRepoAndMailer validates the auth peppers, builds the auth repo
// and selects the platform mailer. Moved verbatim from run().
func initializeAuthRepo(cfg config.Config, logger *slog.Logger, pool *db.Pool, outboxRepo *outbox.Repo, janitorCtx context.Context) ([]byte, *auth.Repo, error) {
	// Auth backend: cookie-session resolver + signup/login/logout
	// handlers. Pepper is sourced from POSTWAVE_AUTH_HMAC_PEPPER
	// (Secrets Manager via the ECS task definition in production).
	// Fail fast if the pepper is unset OR shorter than 32 bytes —
	// running without it silently weakens session integrity.
	authPepper := []byte(os.Getenv("POSTWAVE_AUTH_HMAC_PEPPER"))
	if len(authPepper) < 32 {
		if cfg.AllowDevTenantSlugHeader {
			// Dev: synthesize a deterministic pepper so local boots
			// don't fail. Production never hits this branch because
			// AllowDevTenantSlugHeader is gated on env.
			authPepper = []byte("dev-only-pepper-not-for-production-use!")
			logger.Warn("POSTWAVE_AUTH_HMAC_PEPPER unset; using dev fallback")
		} else {
			logger.Error("POSTWAVE_AUTH_HMAC_PEPPER must be set to ≥32 bytes")
			return nil, nil, errors.New("POSTWAVE_AUTH_HMAC_PEPPER must be set to at least 32 bytes")
		}
	}
	// AUTH#48 device trust is a SECOND client credential with its own hash
	// space. POSTWAVE_AUTH_DEVICE_TRUST_PEPPER lets an operator rotate it
	// independently of sessions; when it is unset (or too short to be a
	// credible secret) the repo derives a domain-separated pepper from the
	// session one, which keeps the two spaces disjoint without demanding a new
	// secret from every existing deployment. It is deliberately NOT fatal:
	// unlike the session pepper, an absent value has a safe, equally strong
	// fallback, and failing the boot would be a downgrade dressed as rigour.
	trustPepper := []byte(os.Getenv("POSTWAVE_AUTH_DEVICE_TRUST_PEPPER"))
	if len(trustPepper) > 0 && len(trustPepper) < 32 {
		logger.Warn("POSTWAVE_AUTH_DEVICE_TRUST_PEPPER shorter than 32 bytes; deriving from the session pepper instead")
		trustPepper = nil
	}
	authRepo := &auth.Repo{
		Pool: pool, Pepper: authPepper, TrustPepper: trustPepper,
		DeviceSignInOutbox: outboxRepo,
	}
	authRepo.StartDeviceGrantJanitor(janitorCtx, time.Hour, logger)

	return authPepper, authRepo, nil
}
