// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/archive"
	"github.com/postwave/postwave/apps/api/internal/budgets"
	"github.com/postwave/postwave/apps/api/internal/config"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/developer_marketplace"
	"github.com/postwave/postwave/apps/api/internal/engagementhoneypot"
	"github.com/postwave/postwave/apps/api/internal/handlers"
	"github.com/postwave/postwave/apps/api/internal/idempotency"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/outbound_webhooks"
	"github.com/postwave/postwave/apps/api/internal/preferences"
	"github.com/postwave/postwave/apps/api/internal/regions"
	"github.com/postwave/postwave/apps/api/internal/safego"
	"github.com/postwave/postwave/apps/api/internal/sms"
	"github.com/postwave/postwave/apps/api/internal/uploads"
)

// buildPublicArchiveDepsResult bundles the values buildPublicArchiveDeps hands back to run().
type buildPublicArchiveDepsResult struct {
	archiveRepoPublic       *archive.Repo
	archivePublicBase       string
	archiveWallResolverRepo *preferences.Repo
	archivePublicDeps       *archive.Deps
}

// buildPublicArchiveDeps builds the public archive dependencies, view
// recorder and subscribe-wall resolver. Moved verbatim from run().
func buildPublicArchiveDeps(pool *db.Pool, logger *slog.Logger, cfg config.Config) buildPublicArchiveDepsResult {
	// Public archive (SEO-friendly campaign archive + sitemap) +
	// referral redirect endpoint. Read-only except referral redirect
	// which sets a tracking cookie.
	//
	// Declared out here, ahead of the legacy public group, because the
	// read-only render routes are mounted OUTSIDE that group's shared
	// 10/min/IP bucket (see the archive render limiter below) while the
	// unlock POST stays inside it.
	//
	// The pixel handler uses an async write-behind ViewRecorder
	// (see archive/view_recorder.go) so a transient DB hiccup no
	// longer silently drops the view. The recorder's worker pool
	// outlives this closure — we hand it to the Deps so it stays
	// alive for the lifetime of the chi router / process. There's
	// no explicit Close() here because shutdown of the API server
	// terminates the process; the bounded shutdown timeout inside
	// ViewRecorder makes a future graceful-stop wiring trivial.
	archiveRepoPublic := &archive.Repo{Pool: pool}
	archivePublicBase := os.Getenv("ARCHIVE_PUBLIC_BASE_URL")
	archiveRecorder := archive.NewViewRecorder(archiveRepoPublic, logger)
	// Subscribe-wall resolver: hand the archive package a callback
	// that exchanges a preference-token for its (tenantID, email)
	// pair. Wired here rather than in subscribe_wall.go so the
	// archive package doesn't take a package-level dep on
	// preferences (they're sibling features). Returns a non-nil
	// error on lookup miss / expiry; the handler maps any error
	// to 401. See gap feature `archive-subscription-wall-without-stripe`.
	archiveWallResolverRepo := &preferences.Repo{Pool: pool}
	archivePublicDeps := &archive.Deps{
		Repo:                    archiveRepoPublic,
		PublicBaseURL:           archivePublicBase,
		Recorder:                archiveRecorder,
		TrustForwardedIPHeaders: cfg.TrustForwardedIPHeaders,
		SubscribeWallUnlockResolver: func(ctx context.Context, token string) (string, string, error) {
			pt, err := archiveWallResolverRepo.LookupToken(ctx, token)
			if err != nil {
				return "", "", err
			}
			return pt.TenantID, pt.SubscriberEmail, nil
		},
	}

	return buildPublicArchiveDepsResult{
		archiveRepoPublic:       archiveRepoPublic,
		archivePublicBase:       archivePublicBase,
		archiveWallResolverRepo: archiveWallResolverRepo,
		archivePublicDeps:       archivePublicDeps,
	}
}

// buildIdempotentRoutesMiddleware builds the idempotency middleware for
// authenticated group 2/2. Moved verbatim from run().
func buildIdempotentRoutesMiddleware(idempotencyRepo *idempotency.Repo, resolveTenantID func(req *http.Request) (string, bool), resolveIdempotencyReplayScope func(req *http.Request) (string, bool)) func(http.Handler) http.Handler {
	idempotentRoutes := idempotency.ProcessWithReplayBypassAndHandlerOwnedReplayAndBodyLimit(
		idempotencyRepo,
		resolveTenantID,
		sms.LegacyDispatchReplayBypass,
		func(req *http.Request, _ []byte) bool {
			const prefix = "/api/v1/sms/conversations/"
			path := req.URL.EscapedPath()
			if req.Method != http.MethodPost || !strings.HasPrefix(path, prefix) {
				return false
			}
			parts := strings.Split(strings.TrimPrefix(path, prefix), "/")
			return len(parts) == 2 && parts[0] != "" && parts[1] == "reply"
		},
		func(req *http.Request) int64 {
			if sms.LegacyDispatchReplayBypass(req, nil) {
				return 64 << 10
			}
			const prefix = "/api/v1/sms/conversations/"
			path := req.URL.EscapedPath()
			parts := strings.Split(strings.TrimPrefix(path, prefix), "/")
			if req.Method == http.MethodPost && strings.HasPrefix(path, prefix) && len(parts) == 2 && parts[0] != "" && parts[1] == "reply" {
				return 64 << 10
			}
			return 0
		},
		resolveIdempotencyReplayScope,
	)

	return idempotentRoutes
}

// buildAuthenticationMiddlewaresDeps carries the dependencies buildAuthenticationMiddlewares needs.
type buildAuthenticationMiddlewaresDeps struct {
	pool                           *db.Pool
	apiKeyAuthCache                *apikeys.AuthCache
	streamTokenSecret              []byte
	cfg                            config.Config
	marketplaceOAuthBearerResolver *developer_marketplace.OAuthBearerResolver
	sessionResolverFn              func(r *http.Request) (*middleware.Tenant, *middleware.User, error)
	apiKeyResolver                 *apikeys.Repo
	distributedRateLimitStore      middleware.FixedWindowStore
}

// buildAuthenticationMiddlewares builds API-key authentication, tenant
// authentication and the per-key rate limit that the authenticated route
// stack composes. Moved verbatim from run().
func buildAuthenticationMiddlewares(d buildAuthenticationMiddlewaresDeps) (func(http.Handler) http.Handler, func(http.Handler) http.Handler, *middleware.KeyRateLimit) {
	pool := d.pool
	apiKeyAuthCache := d.apiKeyAuthCache
	streamTokenSecret := d.streamTokenSecret
	cfg := d.cfg
	marketplaceOAuthBearerResolver := d.marketplaceOAuthBearerResolver
	sessionResolverFn := d.sessionResolverFn
	apiKeyResolver := d.apiKeyResolver
	distributedRateLimitStore := d.distributedRateLimitStore
	apiKeyAuthentication := apikeys.MiddlewareWithOptions(pool, apiKeyAuthCache, apikeys.MiddlewareOptions{
		StreamTokenSecret:       streamTokenSecret,
		TrustForwardedIPHeaders: cfg.TrustForwardedIPHeaders,
		SupplementalBearerResolvers: []apikeys.SupplementalBearerResolver{
			marketplaceOAuthBearerResolver,
		},
	})
	tenantAuthentication := middleware.TenantMiddlewareWithOptions(pool, middleware.TenantOptions{
		AllowDevSlugHeader: cfg.AllowDevTenantSlugHeader,
		SessionResolver:    sessionResolverFn,
	})
	// Per-API-key rate limiting runs after bearer resolution and before tenant
	// resolution. Cookie-session requests and keys without configured limits are
	// no-ops. LookupByID uses the API-key-bound RLS policy because tenant context
	// intentionally does not exist at this point in the stack.
	//
	// Only ErrNotFound means "no limit configured". Every other error —
	// BeginTx on an exhausted pool, a reset connection, a statement timeout —
	// means the limits are unknown, and the limiter must refuse rather than
	// admit the request: failing open here handed an unlimited budget to
	// precisely the caller whose burst caused the failure. The request context
	// is used so a lookup inherits the caller's deadline instead of hanging on
	// a background one.
	keyRateLimit := middleware.NewKeyRateLimitWithOptions(func(ctx context.Context, keyID string) (perMin, perDay, burst int, err error) {
		key, err := apiKeyResolver.LookupByID(ctx, keyID)
		if err != nil {
			if errors.Is(err, apikeys.ErrNotFound) {
				return 0, 0, 0, nil
			}
			return 0, 0, 0, err
		}
		if key == nil {
			return 0, 0, 0, nil
		}
		return derefInt(key.RateLimitPerMin), derefInt(key.RateLimitPerDay), derefInt(key.RateLimitBurst), nil
	}, middleware.KeyRateLimitOptions{Store: distributedRateLimitStore, Namespace: "postwave:ratelimit:api-key"})

	// This is the single ordered security boundary for both authenticated route
	// groups. Keep optional rate-limit/observability concerns in named hooks so
	// the core MFA, impersonation, authorization, and residency sequence cannot
	// drift when another group is added.

	return apiKeyAuthentication, tenantAuthentication, keyRateLimit
}

// buildTenantAndPlaygroundLimits builds the expensive-route tenant limiters
// and the webhook playground limiters shared across route groups. Moved
// verbatim from run().
func buildTenantAndPlaygroundLimits(distributedRateLimitStore middleware.FixedWindowStore) (*middleware.TenantRateLimit, *middleware.TenantRateLimit, *middleware.TenantRateLimit, *middleware.KeyRateLimit, *outbound_webhooks.PlaygroundConcurrencyLimit) {
	// Per-tenant rate limits for expensive routes (LLM/voice/AI
	// compose, inbox-reality placement tests, SMS test-send via
	// cookie-session). The budgets middleware short-circuits when
	// keyID == "" (cookie auth), leaving dashboard sessions with
	// no cost cap. Declared at outer scope so both the authenticated
	// non-idempotent group (voice routes) and the idempotent group
	// (aicompose) share the same buckets. Audit findings H5-H8.
	expensiveTenantLimit := middleware.NewTenantRateLimitWithOptions(60, time.Minute, middleware.TenantRateLimitOptions{
		Store:     distributedRateLimitStore,
		Namespace: "tenant:expensive",
	})
	veryExpensiveTenantLimit := middleware.NewTenantRateLimitWithOptions(10, time.Minute, middleware.TenantRateLimitOptions{
		Store:     distributedRateLimitStore,
		Namespace: "tenant:very-expensive",
	})
	webhookPlaygroundTenantLimit := middleware.NewTenantRateLimitWithOptions(outbound_webhooks.PlaygroundTenantRateLimitPerMinute, time.Minute, middleware.TenantRateLimitOptions{
		Store:     distributedRateLimitStore,
		Namespace: "tenant:webhook-playground",
	})
	webhookPlaygroundAPIKeyLimit := middleware.NewKeyRateLimitWithOptions(
		func(context.Context, string) (perMin, perDay, burst int, err error) {
			return outbound_webhooks.PlaygroundAPIKeyRateLimitPerMinute, 0, 0, nil
		},
		middleware.KeyRateLimitOptions{
			Store:     distributedRateLimitStore,
			Namespace: "webhook-playground:key",
		},
	)
	webhookPlaygroundConcurrency := outbound_webhooks.NewPlaygroundConcurrencyLimit(
		outbound_webhooks.PlaygroundMaxConcurrentPerTenant,
	)

	return expensiveTenantLimit, veryExpensiveTenantLimit, webhookPlaygroundTenantLimit, webhookPlaygroundAPIKeyLimit, webhookPlaygroundConcurrency
}

// initializeInboxRealityAndPreview composes the Inbox Reality gateway runtime,
// the F01 honeypot minter, and the email preview dependencies. Moved verbatim
// from run().
func initializeInboxRealityRuntime(outboxCtx context.Context, cfg config.Config, pool *db.Pool, warehouseObjectStore uploads.Store, deliverabilityQuota deliverabilityQuotaAdapter, logger *slog.Logger) (inboxRealityGatewayRuntime, *engagementhoneypot.Minter, error) {
	var err error
	inboxRealityRuntime, err := initializeInboxRealityGatewayRuntime(outboxCtx, inboxRealityGatewayDependencies{
		Enabled:           cfg.InboxRealityLifecycleEnabled,
		Pool:              pool,
		Objects:           warehouseObjectStore,
		DeliverabilityURL: cfg.DeliverabilityServiceURL,
		BearerToken:       cfg.InternalAPIToken,
		SigningSecrets:    cfg.InboxRealitySigningSecrets,
		Quota:             deliverabilityQuota,
		Production:        isProductionEnv(),
		Logger:            logger,
	})
	if err != nil {
		return inboxRealityGatewayRuntime{}, nil, err
	}
	// F01 honeypot signing. Built here rather than at the route so a malformed
	// secret stops the boot: the alternative is a process that comes up healthy
	// and quietly collects no ground truth, which is discovered a quarter later
	// when someone asks why machine recall still has no certifying evidence.
	//
	// An EMPTY secret is not an error — it means this deployment has not opted
	// into embedding decoys in customer mail, and a binary upgrade must not
	// start doing that on its own.
	var honeypotMinter *engagementhoneypot.Minter
	if secret := strings.TrimSpace(cfg.EngagementHoneypotSigningSecret); secret != "" {
		honeypotMinter, err = engagementhoneypot.NewMinter([]byte(secret), "primary")
		if err != nil {
			return inboxRealityGatewayRuntime{}, nil, fmt.Errorf("engagement honeypot signing: %w", err)
		}
	}
	if inboxRealityRuntime.Enabled() {
		safego.Go(logger, "inbox-reality-dispatch-worker", func() {
			if err := inboxRealityRuntime.Run(outboxCtx); err != nil && !errors.Is(err, context.Canceled) {
				logger.Warn("Inbox Reality dispatch worker exited", "err", err)
			}
		})
	}

	return inboxRealityRuntime, honeypotMinter, nil
}

// buildRegionLookup builds the tenant data-region handlers and the resolver
// escape-hatch region lookup used by EnforceRegion. Moved verbatim from run().
func buildRegionLookup(pool *db.Pool) (*regions.Handlers, func(tenantID string) (regions.Region, error)) {
	// Tenant data-region surface. The middleware below enforces that
	// requests for tenant X only land on the API instance whose
	// POSTWAVE_DEPLOYMENT_REGION matches tenant X's data_region.
	regionsHandlers := &regions.Handlers{Pool: pool}
	regionLookup := func(tenantID string) (regions.Region, error) {
		// The tenants SELECT policy was narrowed to (resolver OR own-tenant) by
		// migration 0333, so this cross-tenant region lookup — which runs in the
		// EnforceRegion middleware outside any bound app.tenant_id scope — must
		// use the resolver escape hatch (app.tenant_resolver='true') or RLS
		// returns zero rows for postwave_app, surfacing as a spurious
		// region_lookup_failed 500 on EVERY authenticated request. Mirrors
		// middleware.lookupTenantBySlug.
		ctx := context.Background()
		tx, err := db.WithTenantResolver(ctx, pool)
		if err != nil {
			return "", err
		}
		defer tx.Rollback(ctx) //nolint:errcheck // read-only tx; rollback is the close
		var s string
		if err := tx.QueryRow(ctx,
			`SELECT data_region FROM tenants WHERE id = $1::uuid`, tenantID,
		).Scan(&s); err != nil {
			return "", err
		}
		return regions.Region(s), nil
	}

	return regionsHandlers, regionLookup
}

// buildRequestScopeResolvers builds the budget incrementer and the tenant /
// idempotency-replay-scope resolvers. Moved verbatim from run().
func buildRequestScopeResolvers(budgetRepo *budgets.Repo) (func(ctx context.Context, cents int64, at time.Time), func(req *http.Request) (string, bool), func(req *http.Request) (string, bool)) {
	// Tenant-scoped routes. The tenant middleware resolves the active
	// tenant from API key, native auth session cookie, or the gated local
	// X-Tenant-Slug fallback, and refuses the request with 401 if it cannot.
	// The audit middleware then writes a best-effort fallback row for mutating verbs.
	// budgetIncrementer hooks the cost middleware into the dollar-budget
	// repo: any cents recorded during a request are reflected in the
	// per-API-key monthly counter so dollar caps actually clamp.
	budgetIncrementer := func(ctx context.Context, cents int64, at time.Time) {
		keyID := middleware.APIKeyIDFromContext(ctx)
		if keyID == "" {
			return
		}
		b, err := budgetRepo.LoadBudget(ctx, keyID)
		if err != nil || b == nil {
			return
		}
		_ = budgetRepo.IncrementUsage(ctx, b, budgets.ResourceCost, int(cents), at)
	}

	// resolveTenantID is the bridge from middleware.TenantFromContext to
	// idempotency's TenantResolver. Defining it inline keeps idempotency
	// independent of the middleware package.
	resolveTenantID := func(req *http.Request) (string, bool) {
		if t, ok := middleware.TenantFromContext(req.Context()); ok {
			return t.ID, true
		}
		return "", false
	}
	resolveIdempotencyReplayScope := func(
		req *http.Request,
	) (string, bool) {
		const designPath = "/api/v1/campaign-template-designs"
		path := req.URL.Path
		isDesign := path == designPath || strings.HasPrefix(path, designPath+"/")
		isSMSSend := (strings.HasPrefix(path, "/api/v1/sms/conversations/") && strings.HasSuffix(path, "/reply")) ||
			(strings.HasPrefix(path, "/api/v1/sms/broadcasts/") && strings.HasSuffix(path, "/send"))
		isHelpdeskNote := strings.HasPrefix(path, "/api/v1/service-suite/conversations/") && strings.HasSuffix(path, "/internal-notes")
		isWebhookPlaygroundFire := strings.HasPrefix(path, "/api/v1/outbound-webhooks/") && strings.HasSuffix(path, "/playground/fire")
		if !isDesign && !isSMSSend && !isHelpdeskNote && !isWebhookPlaygroundFire {
			return "", false
		}
		scopePrefix := "campaign-template-design:"
		if isSMSSend {
			scopePrefix = "sms-send:"
		} else if isHelpdeskNote {
			scopePrefix = "helpdesk-note:"
		} else if isWebhookPlaygroundFire {
			scopePrefix = "webhook-playground-fire:"
		}
		if middleware.IsAPIKeyAuth(req.Context()) {
			actorType, label := middleware.ActorFromContext(req.Context())
			actorID := strings.TrimSpace(
				middleware.APIKeyIDFromContext(req.Context()),
			)
			if actorID == "" {
				actorID = strings.TrimSpace(label)
			}
			kind := "api_key"
			if strings.EqualFold(strings.TrimSpace(actorType), "service") {
				kind = "service"
			}
			if actorID != "" {
				return scopePrefix + kind + ":" + actorID, true
			}
		}
		if user, ok := middleware.UserFromContext(req.Context()); ok &&
			user != nil && strings.TrimSpace(user.ID) != "" {
			return scopePrefix + "user:" +
				strings.TrimSpace(user.ID), true
		}
		// Keep actor-less failures away from any historical tenant-wide
		// replay record. The handler still returns design_actor_required.
		return scopePrefix + "missing-actor", true
	}

	return budgetIncrementer, resolveTenantID, resolveIdempotencyReplayScope
}

// buildAuditPortalHandlers validates the audit portal configuration (fail-fast
// in production) and builds its handlers. Moved verbatim from run().
func buildAuditPortalHandlers(pool *db.Pool, cfg config.Config, logger *slog.Logger) (*handlers.AuditPortalHandlers, error) {
	// Audit portal capability boundary. Bootstrap credentials live only in a
	// URL fragment, are exchanged once, and thereafter remain in an HttpOnly
	// cookie. These routes intentionally sit outside TenantMiddleware; the
	// portal middleware resolves a tenant only on its two read-only endpoints.
	portalOrigin := strings.TrimSpace(os.Getenv("POSTWAVE_PORTAL_ORIGIN"))
	portalSPADir := strings.TrimSpace(os.Getenv("POSTWAVE_PORTAL_SPA_DIR"))
	portalSecret := []byte(strings.TrimSpace(os.Getenv("POSTWAVE_PORTAL_JWT_SECRET")))
	portalFrameAncestors := strings.TrimSpace(os.Getenv("POSTWAVE_PORTAL_FRAME_ANCESTORS"))
	if isProductionEnv() {
		parsed, parseErr := url.Parse(portalOrigin)
		if parseErr != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil ||
			strings.Contains(parsed.Host, "*") || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
			return nil, fmt.Errorf("POSTWAVE_PORTAL_ORIGIN must be an exact HTTPS origin in production")
		}
		if err := handlers.ValidatePortalFrameAncestors(portalFrameAncestors); err != nil {
			return nil, fmt.Errorf("POSTWAVE_PORTAL_FRAME_ANCESTORS is invalid: %w", err)
		}
		if len(portalSecret) < 32 {
			return nil, fmt.Errorf("POSTWAVE_PORTAL_JWT_SECRET must contain at least 32 bytes in production")
		}
		if portalSPADir == "" {
			return nil, fmt.Errorf("POSTWAVE_PORTAL_SPA_DIR is required in production")
		}
		if info, statErr := os.Stat(filepath.Join(portalSPADir, "index.html")); statErr != nil || info.IsDir() {
			return nil, fmt.Errorf("POSTWAVE_PORTAL_SPA_DIR must contain index.html in production")
		}
	}
	auditPortalDeps := &handlers.AuditPortalHandlers{
		Pool:                    pool,
		HMACSecret:              portalSecret,
		PortalOrigin:            portalOrigin,
		FrameAncestors:          portalFrameAncestors,
		TrustForwardedIPHeaders: cfg.TrustForwardedIPHeaders,
		SPADir:                  portalSPADir,
		Logger:                  logger,
	}

	return auditPortalDeps, nil
}

// parseWebVitalsOrigins parses POSTWAVE_WEB_VITALS_ALLOWED_ORIGINS. Moved
// verbatim from run().
func parseWebVitalsOrigins() []string {
	var webVitalsOrigins []string
	for _, raw := range strings.Split(os.Getenv("POSTWAVE_WEB_VITALS_ALLOWED_ORIGINS"), ",") {
		if v := strings.TrimSpace(raw); v != "" {
			webVitalsOrigins = append(webVitalsOrigins, v)
		}
	}

	return webVitalsOrigins
}

// buildPublicRouteLimits builds the public forms, inbound webhook, archive
// pixel and signed billing webhook limiters. Moved verbatim from run().
func buildPublicRouteLimits(rateLimitOptions middleware.RateLimitOptions) (publicFormsRateLimits, *middleware.RateLimit, *middleware.RateLimit, *middleware.RateLimit) {
	publicFormsLimits := newPublicFormsRateLimits(rateLimitOptions)
	// Signed inbound webhook delivery is machine traffic and commonly arrives
	// in retry bursts. Give it an isolated distributed bucket so unrelated
	// public-page traffic cannot starve a source and the legacy 10/min human
	// budget cannot cause data loss. HMAC, timestamp and stable event-id checks
	// still authenticate and deduplicate every accepted request.
	inboundWebhookRateLimitOptions := rateLimitOptions
	inboundWebhookRateLimitOptions.Namespace = "ip:inbound-webhook"
	inboundWebhookRateLimit := middleware.NewRateLimitWithOptions(
		10_000,
		60*time.Second,
		inboundWebhookRateLimitOptions,
	)
	// Archive view-count pixel limiter. The pixel inherits one hit per
	// page view, so corporate-NAT egress IPs (e.g. a company loading a
	// popular new issue from behind a single egress) blow through the
	// shared 10/min public limiter within seconds and silently drop the
	// remaining view-count signal — see archive-pixel-rate-limit-bypass.
	// 600/min/IP matches the per-IP open-counting budget Ghost and
	// beehiiv apply to their open pixels; the insert is a single
	// indexed row so the limit is bounded by storage cost, not CPU.
	// Uses a distinct namespace so its bucket counters don't collide
	// with the shared "ip" namespace's keys in Redis-backed mode.
	archivePixelRateLimitOptions := rateLimitOptions
	archivePixelRateLimitOptions.Namespace = "ip:archive-pixel"
	archivePixelRateLimit := middleware.NewRateLimitWithOptions(600, 60*time.Second, archivePixelRateLimitOptions)
	_ = archivePixelRateLimit

	// Shared budget for signed payment-provider webhook traffic. The legacy
	// affiliate-specific endpoint is intentionally not mounted. Provider
	// deliveries share egress IPs and can burst during retries, so isolate them
	// from human traffic; signatures, timestamp windows, and durable event IDs
	// remain the authorization and replay controls.
	billingWebhookRateLimitOptions := rateLimitOptions
	billingWebhookRateLimitOptions.Namespace = "ip:billing-webhook"
	billingWebhookRateLimit := middleware.NewRateLimitWithOptions(10_000, time.Minute, billingWebhookRateLimitOptions)

	return publicFormsLimits, inboundWebhookRateLimit, archivePixelRateLimit, billingWebhookRateLimit
}

// buildDistributedRateLimitStore builds the shared rate-limit options, the
// Redis-backed fixed-window store (fail-closed in production) and the shared
// public limiter. Moved verbatim from run().
func buildDistributedRateLimitStore(cfg config.Config, logger *slog.Logger) (middleware.RateLimitOptions, middleware.FixedWindowStore, *middleware.RateLimit, error) {
	rateLimitOptions := middleware.RateLimitOptions{
		TrustForwardedIPHeaders: cfg.TrustForwardedIPHeaders,
	}
	var distributedRateLimitStore middleware.FixedWindowStore
	if redisURL := strings.TrimSpace(os.Getenv("REDIS_URL")); redisURL != "" {
		store, err := middleware.NewRedisFixedWindowStore(redisURL, "postwave:ratelimit")
		if err != nil {
			logger.Warn("ratelimit: REDIS_URL set but limiter store unavailable; using in-process limiter", "err", err.Error())
		} else {
			distributedRateLimitStore = store
			rateLimitOptions.Store = store
			logger.Info("ratelimit: Redis-backed fixed-window limiter active")
		}
	}
	if isProductionEnv() && distributedRateLimitStore == nil && !allowMemoryFallback() {
		return middleware.RateLimitOptions{}, nil, nil, fmt.Errorf("REDIS_URL with a reachable Redis service is required in production for distributed auth, tenant, API-key, and public rate limits")
	}
	publicRateLimit := middleware.NewRateLimitWithOptions(10, 60*time.Second, rateLimitOptions)

	return rateLimitOptions, distributedRateLimitStore, publicRateLimit, nil
}
