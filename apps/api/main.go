// Package main is the entrypoint for the Moosewave API gateway.
//
// This AGPL application gateway fronts a separately running upstream Listmonk
// process (AGPL) and Moosewave services such as migration, deliverability,
// voice, and automation. It communicates with Listmonk only over HTTP; see
// LICENSE-BOUNDARY.md for the source and release boundary.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/postwave/postwave/packages/runtime/tenantengine"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/cors"
	"github.com/jackc/pgx/v5"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/postwave/postwave/apps/api/internal/abtests"
	"github.com/postwave/postwave/apps/api/internal/accountdeletion"
	"github.com/postwave/postwave/apps/api/internal/admin"
	"github.com/postwave/postwave/apps/api/internal/admin_ip"
	"github.com/postwave/postwave/apps/api/internal/aeo"
	"github.com/postwave/postwave/apps/api/internal/agent_routines"
	"github.com/postwave/postwave/apps/api/internal/agentgov"
	"github.com/postwave/postwave/apps/api/internal/agenttools"
	"github.com/postwave/postwave/apps/api/internal/ai/profile_summary"
	"github.com/postwave/postwave/apps/api/internal/ai_agent"
	"github.com/postwave/postwave/apps/api/internal/ai_regression"
	"github.com/postwave/postwave/apps/api/internal/ai_subject_lines"
	"github.com/postwave/postwave/apps/api/internal/aichat"
	"github.com/postwave/postwave/apps/api/internal/aicompose"
	"github.com/postwave/postwave/apps/api/internal/analytics"
	"github.com/postwave/postwave/apps/api/internal/apidocs"
	"github.com/postwave/postwave/apps/api/internal/apikeycalls"
	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/approvals"
	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/auditsink"
	"github.com/postwave/postwave/apps/api/internal/auth"
	"github.com/postwave/postwave/apps/api/internal/billing"
	"github.com/postwave/postwave/apps/api/internal/billing/webhook_retry"
	"github.com/postwave/postwave/apps/api/internal/blocklist"
	apiboot "github.com/postwave/postwave/apps/api/internal/boot"
	"github.com/postwave/postwave/apps/api/internal/brand_voice"
	"github.com/postwave/postwave/apps/api/internal/budgets"
	"github.com/postwave/postwave/apps/api/internal/byok"
	"github.com/postwave/postwave/apps/api/internal/campaign_replies"
	"github.com/postwave/postwave/apps/api/internal/campaign_summary"
	"github.com/postwave/postwave/apps/api/internal/campaign_translations"
	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/campaigns"
	"github.com/postwave/postwave/apps/api/internal/campaigntemplates"
	"github.com/postwave/postwave/apps/api/internal/coderedemption"
	"github.com/postwave/postwave/apps/api/internal/compat"
	"github.com/postwave/postwave/apps/api/internal/config"
	"github.com/postwave/postwave/apps/api/internal/consent"
	"github.com/postwave/postwave/apps/api/internal/contentreports"
	"github.com/postwave/postwave/apps/api/internal/control_group"
	"github.com/postwave/postwave/apps/api/internal/conversions"
	"github.com/postwave/postwave/apps/api/internal/cost"
	"github.com/postwave/postwave/apps/api/internal/customfields"
	"github.com/postwave/postwave/apps/api/internal/dashboardnotify"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/deliverability_control"
	"github.com/postwave/postwave/apps/api/internal/deliverability_hub"
	"github.com/postwave/postwave/apps/api/internal/demographics"
	"github.com/postwave/postwave/apps/api/internal/developer_marketplace"
	"github.com/postwave/postwave/apps/api/internal/discordint"
	"github.com/postwave/postwave/apps/api/internal/dispatchcontrol"
	"github.com/postwave/postwave/apps/api/internal/email_blocks"
	"github.com/postwave/postwave/apps/api/internal/emailpreview"
	"github.com/postwave/postwave/apps/api/internal/engagementclassification"
	"github.com/postwave/postwave/apps/api/internal/engagementhoneypot"
	"github.com/postwave/postwave/apps/api/internal/eqscore"
	"github.com/postwave/postwave/apps/api/internal/events"
	"github.com/postwave/postwave/apps/api/internal/experiments"
	"github.com/postwave/postwave/apps/api/internal/exports"
	"github.com/postwave/postwave/apps/api/internal/feed_ingest"
	"github.com/postwave/postwave/apps/api/internal/feedback"
	"github.com/postwave/postwave/apps/api/internal/flow_approvals"
	"github.com/postwave/postwave/apps/api/internal/flowabtests"
	"github.com/postwave/postwave/apps/api/internal/flowbuilder"
	"github.com/postwave/postwave/apps/api/internal/flowsteps"
	"github.com/postwave/postwave/apps/api/internal/forms"
	"github.com/postwave/postwave/apps/api/internal/frequency"
	"github.com/postwave/postwave/apps/api/internal/geolocation"
	"github.com/postwave/postwave/apps/api/internal/handlers"
	"github.com/postwave/postwave/apps/api/internal/health"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/idempotency"
	"github.com/postwave/postwave/apps/api/internal/impersonate"
	"github.com/postwave/postwave/apps/api/internal/intelligent_retry"
	"github.com/postwave/postwave/apps/api/internal/lifecycle"
	"github.com/postwave/postwave/apps/api/internal/limits"
	"github.com/postwave/postwave/apps/api/internal/list_health"
	"github.com/postwave/postwave/apps/api/internal/listmonk"
	"github.com/postwave/postwave/apps/api/internal/listmonk_events"
	"github.com/postwave/postwave/apps/api/internal/mailchimpv3"
	"github.com/postwave/postwave/apps/api/internal/mailer"
	"github.com/postwave/postwave/apps/api/internal/maintenance"
	"github.com/postwave/postwave/apps/api/internal/mcp"
	"github.com/postwave/postwave/apps/api/internal/merge_fields"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/mobilepush"
	"github.com/postwave/postwave/apps/api/internal/nbp"
	"github.com/postwave/postwave/apps/api/internal/newsletter_feed"
	"github.com/postwave/postwave/apps/api/internal/notification_feed"
	"github.com/postwave/postwave/apps/api/internal/notifications"
	"github.com/postwave/postwave/apps/api/internal/notifywebhook"
	"github.com/postwave/postwave/apps/api/internal/observability"
	"github.com/postwave/postwave/apps/api/internal/offers"
	"github.com/postwave/postwave/apps/api/internal/omnichannel"
	"github.com/postwave/postwave/apps/api/internal/onboarding"
	"github.com/postwave/postwave/apps/api/internal/onsite_growth"
	"github.com/postwave/postwave/apps/api/internal/ops"
	"github.com/postwave/postwave/apps/api/internal/ops/checks"
	"github.com/postwave/postwave/apps/api/internal/ops/views"
	"github.com/postwave/postwave/apps/api/internal/outbound_webhooks"
	"github.com/postwave/postwave/apps/api/internal/outbox"
	"github.com/postwave/postwave/apps/api/internal/partition_rotator"
	"github.com/postwave/postwave/apps/api/internal/paywall"
	"github.com/postwave/postwave/apps/api/internal/pii_gateway"
	"github.com/postwave/postwave/apps/api/internal/pii_scanner"
	"github.com/postwave/postwave/apps/api/internal/podcast"
	"github.com/postwave/postwave/apps/api/internal/polls"
	"github.com/postwave/postwave/apps/api/internal/predictenrich"
	"github.com/postwave/postwave/apps/api/internal/predictive"
	"github.com/postwave/postwave/apps/api/internal/preferences"
	"github.com/postwave/postwave/apps/api/internal/presend"
	"github.com/postwave/postwave/apps/api/internal/prioritization"
	"github.com/postwave/postwave/apps/api/internal/privacy"
	"github.com/postwave/postwave/apps/api/internal/publictrack"
	"github.com/postwave/postwave/apps/api/internal/pushsend"
	"github.com/postwave/postwave/apps/api/internal/pushsuppressions"
	"github.com/postwave/postwave/apps/api/internal/readiness"
	"github.com/postwave/postwave/apps/api/internal/regions"
	"github.com/postwave/postwave/apps/api/internal/reputationalerts"
	"github.com/postwave/postwave/apps/api/internal/retention"
	"github.com/postwave/postwave/apps/api/internal/retention_offers"
	"github.com/postwave/postwave/apps/api/internal/reviews"
	"github.com/postwave/postwave/apps/api/internal/routeauth"
	"github.com/postwave/postwave/apps/api/internal/safego"
	"github.com/postwave/postwave/apps/api/internal/safety"
	"github.com/postwave/postwave/apps/api/internal/sandbox"
	"github.com/postwave/postwave/apps/api/internal/scheduled_reports"
	"github.com/postwave/postwave/apps/api/internal/scim"
	"github.com/postwave/postwave/apps/api/internal/segments"
	"github.com/postwave/postwave/apps/api/internal/sendallowance"
	"github.com/postwave/postwave/apps/api/internal/sending"
	apiserver "github.com/postwave/postwave/apps/api/internal/server"
	"github.com/postwave/postwave/apps/api/internal/service_suite"
	"github.com/postwave/postwave/apps/api/internal/serviceproxy"
	"github.com/postwave/postwave/apps/api/internal/slackint"
	"github.com/postwave/postwave/apps/api/internal/sms"
	"github.com/postwave/postwave/apps/api/internal/smtprelay"
	"github.com/postwave/postwave/apps/api/internal/social_capture"
	"github.com/postwave/postwave/apps/api/internal/socialads"
	"github.com/postwave/postwave/apps/api/internal/status"
	"github.com/postwave/postwave/apps/api/internal/sto_content_optimizer"
	"github.com/postwave/postwave/apps/api/internal/sto_predictive_clv"
	"github.com/postwave/postwave/apps/api/internal/streaming_export"
	"github.com/postwave/postwave/apps/api/internal/subject_lab"
	"github.com/postwave/postwave/apps/api/internal/subscribers"
	"github.com/postwave/postwave/apps/api/internal/subscriberscore"
	"github.com/postwave/postwave/apps/api/internal/support_integrations"
	"github.com/postwave/postwave/apps/api/internal/teamsint"
	"github.com/postwave/postwave/apps/api/internal/uploads"
	"github.com/postwave/postwave/apps/api/internal/usagegate"
	"github.com/postwave/postwave/apps/api/internal/warehouse"
	"github.com/postwave/postwave/apps/api/internal/webhooks"
	"github.com/postwave/postwave/apps/api/internal/webpush"
	apiworkers "github.com/postwave/postwave/apps/api/internal/workers"
	"github.com/postwave/postwave/apps/api/internal/zerocopy_triggers"
	sharedusage "github.com/postwave/postwave/packages/runtime/commercialusage"
	runtimeobs "github.com/postwave/postwave/packages/runtime/observability"

	// X1+X2+X3 internal packages — net-new since 2026-05-03 fork point.
	"github.com/postwave/postwave/apps/api/internal/actionticket"
	"github.com/postwave/postwave/apps/api/internal/agency"
	"github.com/postwave/postwave/apps/api/internal/archive"
	"github.com/postwave/postwave/apps/api/internal/archive_bar"
	"github.com/postwave/postwave/apps/api/internal/archive_comments"
	"github.com/postwave/postwave/apps/api/internal/assets"
	"github.com/postwave/postwave/apps/api/internal/discounts"
	"github.com/postwave/postwave/apps/api/internal/inbound_email"
	"github.com/postwave/postwave/apps/api/internal/inbound_webhooks"
	"github.com/postwave/postwave/apps/api/internal/lists"
	"github.com/postwave/postwave/apps/api/internal/paid_tiers"
	"github.com/postwave/postwave/apps/api/internal/referrals"
	"github.com/postwave/postwave/apps/api/internal/replies"
	"github.com/postwave/postwave/apps/api/internal/send_time_opt"
	"github.com/postwave/postwave/apps/api/internal/sendingsettings"
	"github.com/postwave/postwave/apps/api/internal/settings"
	"github.com/postwave/postwave/apps/api/internal/stepup"
	"github.com/postwave/postwave/apps/api/internal/sunset"
	"github.com/postwave/postwave/apps/api/internal/suppressions"
	"github.com/postwave/postwave/apps/api/internal/tags"
	"github.com/postwave/postwave/apps/api/internal/tenants"
	"github.com/postwave/postwave/apps/api/internal/track"
	"github.com/postwave/postwave/apps/api/internal/transactional"
	"github.com/postwave/postwave/apps/api/internal/trigger_delay"
	"github.com/postwave/postwave/apps/api/internal/webvitals"
)

var browserExposedResponseHeaders = []string{
	idempotency.ReplayedHeaderName,
	idempotency.LegacyReplayedHeaderName,
	idempotency.InternalReplayHeaderName,
	"ETag",
	"Location",
	"Retry-After",
	"Link",
	// Browser clients must be able to recover the evidence-export filename and
	// verify both the RFC 9530 digest and Moosewave's payload digest. CORS hides
	// all three response fields unless they are explicitly exposed here.
	"Content-Disposition",
	"Content-Digest",
	"X-Postwave-Artifact-SHA256",
	"X-Request-ID",
	"X-Postwave-Consent-Receipt-ID",
	"X-Postwave-Export-Limit",
	"X-Postwave-Truncated",
	// Exposed so a CROSS-ORIGIN caller can read it. Same-origin callers (the
	// web app behind its Next proxy) never needed this; the desktop shell
	// fetches from `tauri://localhost`, where CORS strips every response header
	// not named here — so without this the epoch is invisible to the surface
	// that holds queued writes the longest.
	middleware.ContextEpochHeader,
	// The step-up hint written by internal/stepup's writeChallenge alongside the
	// 401 body. Same reason as the epoch above: the desktop shell fetches from
	// `tauri://localhost`, and CORS strips every response header not named here,
	// so without this the machine-readable marker is invisible on exactly the
	// surface that most needs to tell a re-authentication prompt apart from a
	// dead session.
	//
	// Safe to expose while the gate is unmounted — the header is only ever
	// written on a challenge, and nothing issues one yet. Listing it now means
	// the mount is one decision rather than two, and clients already read the
	// body code as a fallback so neither half is load-bearing alone.
	"X-Postwave-Step-Up",
	"X-Postwave-Sending-Cap-Outcome",
	agency.MutationOutcomeHeader,
}

var browserAllowedRequestHeaders = []string{
	"Accept", "Authorization", "Content-Type", "Content-Range",
	"Idempotency-Key", "If-Match", "X-Request-Id", "X-Tenant-ID",
	"X-Tenant-Slug", "X-Postwave-Role", "X-Postwave-Client",
	"X-Postwave-Version", "X-Postwave-Event-Seq", "X-Postwave-Site-Key",
	"X-Postwave-Subject-Proof", "Moosewave-Signature", "Postwave-Signature", "X-Postwave-Signature",
	"X-Postwave-Timestamp", "X-Postwave-Event-Id",
	"X-Postwave-Inbound-Signature", "X-Postwave-Inbound-Timestamp",
	"X-Postwave-Inbound-Event-Id",
}

// apiWriteTimeout is deliberately finite and only long enough to contain the
// bounded synchronous verification envelope. Verification cancels its own
// cache/local/provider work at 80 seconds, leaving ten seconds for response
// encoding and exact-idempotency middleware persistence. Larger verification
// batches use durable jobs instead of extending this process-wide deadline.
const apiWriteTimeout = 90 * time.Second

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "fatal: %v\n", err)
		os.Exit(1)
	}
}

// useRootMiddleware composes the middleware every request to the API passes
// through, outermost first. It is the one definition of that chain: run()
// calls it on the production router, and the streaming contract test calls it
// on its own, so a wrapper added here that stops a Server-Sent Events flush or
// hides the write deadline fails that test instead of shipping.
func useRootMiddleware(r chi.Router, logger *slog.Logger, cfg config.Config, webVitalsOrigins []string) {
	r.Use(middleware.RequestID)
	// Transport-layer compression (gzip / deflate / brotli). Mounted
	// before SlogLogger so the byte counts in access logs reflect
	// what actually went on the wire. SSE (text/event-stream) and
	// already-compressed binaries are skipped by content-type
	// allowlist inside middleware.Compress; see compress.go.
	r.Use(middleware.Compress())
	r.Use(middleware.SlogLogger(logger))
	// Signed-ingest key responses include a reveal-once credential on issue and
	// private lifecycle metadata on list/revoke. This guard must be OUTSIDE panic
	// recovery so the recovery writer still receives the protected response
	// wrapper; otherwise a recovered 500 would bypass the all-outcome no-store
	// boundary. Authentication, authorization, client-version, routing, and body
	// refusals remain inside it too. Handlers repeat the policy for standalone
	// composition.
	r.Use(conversions.ProtectIngestSecretResponses)
	r.Use(jsonRecoverer(logger))
	// OpenTelemetry HTTP middleware. Opens a span per request and continues
	// any incoming W3C traceparent so cross-service flows stitch end-to-end.
	// No-op when OTEL_EXPORTER_OTLP_ENDPOINT is unset (dev / local).
	r.Use(runtimeobs.HTTPMiddleware("postwave-api"))
	// Sentry HTTP middleware. Repanic=true so jsonRecoverer (one above)
	// still produces the 500 envelope; this just captures the event before
	// it bubbles. No-op when SENTRY_DSN_API is unset.
	r.Use(observability.SentryHTTPMiddleware())
	// Global Prometheus HTTP request metrics (chi route pattern, NOT raw path →
	// bounded cardinality) behind the 5xx-rate / latency alerts, below
	// jsonRecoverer so a recovered panic still counts as 5xx, and outside
	// ClientClosedRequests so the 499 it substitutes is what gets counted.
	r.Use(observability.HTTPRequestMetrics)
	r.Use(middleware.ClientClosedRequests)
	// Route42 registries contain recipient and private business-policy data.
	// Stamp their path families before every root refusal (invalid URL, body
	// limit, CSRF, client-version, and router 404/405), then repeat the guard at
	// the authenticated boundary as defense in depth.
	r.Use(sms.ProtectRoute42Responses)
	// Route43 carries raw-token-derived authority evidence. Stamp this path
	// family at the root before URL, body, CORS/CSRF, client-version, and
	// authenticated-group middleware can reject a request.
	r.Use(pushsuppressions.ProtectRoute43Responses)
	// Webhook simulator responses carry request and receiver evidence. Stamp
	// the private boundary at the root so oversized bodies, CSRF/client-version
	// refusals, and router-level 404/405 responses cannot be cached.
	r.Use(outbound_webhooks.ProtectPlaygroundResponses)
	// Deliverability evidence and cap-repair outcomes are tenant-private even
	// when an upstream middleware or the router rejects the request.
	r.Use(deliverability_hub.ProtectResponses)
	// Tenant-wide throttle and quiet-hours settings remain private across every
	// outcome, including upstream auth/client-version refusals and 404/405s.
	r.Use(sendingsettings.ProtectResponses)
	// Agency roster, branding, and billing-state responses are tenant-private.
	// Apply this before URL/body/CORS/auth/step-up/idempotency processing so an
	// early refusal cannot escape with a cacheable policy.
	r.Use(agency.ProtectResponses)
	r.Use(frequency.ProtectResponses)
	r.Use(intelligent_retry.ProtectResponses)
	// Reject path components containing control bytes (NUL etc.) BEFORE
	// they reach handlers — otherwise they reach SQL queries and surface
	// as 500s with leaked Postgres SQLSTATE in the response body.
	r.Use(rejectControlBytesInPath)
	// Enforce a conservative gateway-wide body ceiling before auth, parsing,
	// or allocation. The small audited exception table covers only the upload
	// upload, attachment, and bulk-import routes whose valid wire format exceeds 8 MiB; every
	// handler still applies its tighter JSON/file/attachment/row quota. This also caps
	// chunked requests, where Content-Length cannot be trusted.
	r.Use(httpbody.LimitRequests(httpbody.DefaultRequestMaxBodyBytes, httpbody.ProductionRouteLimits))
	// Stamp web-vitals responses before API-wide CORS can terminate OPTIONS
	// preflights and before the router can produce method/not-found refusals.
	// The guard also answers real preflights with this endpoint's narrower
	// exact-origin policy, independently of the gateway-wide CORS list.
	r.Use(webvitals.ProtectResponses(webVitalsOrigins))
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   cfg.CORSAllowedOrigins,
		AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   browserAllowedRequestHeaders,
		ExposedHeaders:   browserExposedResponseHeaders,
		AllowCredentials: !hasWildcardOrigin(cfg.CORSAllowedOrigins),
		MaxAge:           300,
		// NOTE: go-chi/cors v1.2.1 hardcodes 200 on preflight; the spec
		// prefers 204 but every browser accepts 200. To override we'd
		// need a wrapper middleware that intercepts the OPTIONS response;
		// not worth the complexity until a customer hits a tooling
		// strict-checker.
	}))
	// CSRF defense-in-depth: pw_session is SameSite=Lax (primary
	// control). This adds an Origin allow-list check for any
	// state-changing request that carries a session cookie. Bearer
	// (API key) requests and webhook ingest paths are exempt. See
	// internal/middleware/origin_csrf.go for the full contract.
	r.Use(middleware.AllowedOriginsCSRF(cfg.CORSAllowedOrigins))
	// Helpdesk and support-integration responses are tenant/content sensitive.
	// Stamp their cache/MIME boundary at the outer router so authentication,
	// route-authorization, and not-found refusals cannot return weaker headers.
	r.Use(service_suite.ProtectSensitiveResponses)

	// Client-version fabric (dim 10): a stale first-party build below its
	// configured floor gets a 426 upgrade-required. Mounted AFTER cors.Handler
	// so the 426 carries CORS headers a browser can read; no-op when
	// POSTWAVE_MIN_CLIENT_VERSIONS is unset (the default). Callers without an
	// X-Postwave-Version (external SDK/API-key) pass through untouched.
	r.Use(middleware.ClientVersion(cfg.MinClientVersions))
}

func run() error {
	cfg := config.Load()

	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: parseLogLevel(cfg.LogLevel),
	}))
	slog.SetDefault(logger)

	logger.Info("starting postwave api",
		"version", handlers.Version,
		"port", cfg.Port,
		"listmonk_url", cfg.ListmonkURL,
	)

	if err := configureClientIPTrust(cfg); err != nil {
		return err
	}
	if err := validateCampaignAssuranceStartupConfiguration(cfg); err != nil {
		return err
	}
	pollRuntimeConfiguration, err := loadPollRuntimeConfiguration(cfg)
	if err != nil {
		return err
	}
	defer installWorkerDrain()()
	defer observability.InitSentry("api", sentryEnvironment())()
	defer initializeAPITracing(logger)()
	if err := validateProductionStartupConfiguration(cfg); err != nil {
		return err
	}
	apiboot.LogAPIKeyPepperConfiguration(cfg.APIKeyPepper, logger)

	databaseDependencies, dbErr := apiboot.InitializeDatabase(cfg.DatabaseURL)
	if dbErr != nil {
		return dbErr
	}
	pool := databaseDependencies.Pool
	defer databaseDependencies.Close()
	campaignPollRepo, campaignPollLinkMinter, err := buildPollRepo(pollRuntimeConfiguration, pool)
	if err != nil {
		return err
	}
	engagementStartupCtx, engagementStartupCancel := context.WithTimeout(
		context.Background(), 10*time.Second,
	)
	engagementClassifierRuntime, err := initializeEngagementClassificationRuntime(
		engagementStartupCtx, pool, os.Getenv,
	)
	engagementStartupCancel()
	if err != nil {
		return err
	}
	if engagementClassifierRuntime != nil && engagementClassifierRuntime.Enabled() {
		logger.Info("engagement classifier v2 enabled",
			"rollout_mode", "shadow",
			"classifier_version", "postwave.engagement-classifier.v2")
	} else {
		logger.Info("engagement classifier v2 disabled",
			"enable_env", "POSTWAVE_ENABLE_ENGAGEMENT_CLASSIFIER_V2")
	}
	var campaignPollClassifier polls.RequestClassifier
	if pollRuntimeConfiguration.Enabled {
		campaignPollClassifier, err = pollRequestClassifierForDeps(
			engagementClassifierRuntime,
			cfg.TrustForwardedIPHeaders,
			pollRuntimeConfiguration.PublicBaseURL,
		)
		if err != nil {
			return fmt.Errorf("campaign polls classifier composition: %w", err)
		}
		if campaignPollClassifier == nil {
			return fmt.Errorf(
				"campaign polls startup configuration: %s=true requires %s=true and a ready classifier runtime",
				polls.RuntimeFeatureEnvironmentKey,
				engagementclassification.RuntimeFeatureEnvironmentKey,
			)
		}
	}
	campaignReportProjectionStartupCtx, campaignReportProjectionStartupCancel := context.WithTimeout(
		context.Background(), 10*time.Second,
	)
	campaignReportProjectionRuntime, err := initializeCampaignReportProjectionRuntime(
		campaignReportProjectionStartupCtx, pool, os.Getenv,
	)
	campaignReportProjectionStartupCancel()
	if err != nil {
		return err
	}
	if campaignReportProjectionRuntime != nil && campaignReportProjectionRuntime.Enabled() {
		logger.Info("canonical campaign report writer projection enabled",
			"projection_version", "postwave.campaign-report-projection.v1",
			"cutover_status", "dual_run_not_authoritative")
	} else {
		logger.Info("canonical campaign report writer projection disabled",
			"enable_env", "POSTWAVE_ENABLE_CAMPAIGN_REPORT_PROJECTION")
	}
	// One canonical reply store is shared by provider webhooks and the signed
	// tenant-slug inbound path. Constructing it before route groups prevents the
	// two ingress surfaces from silently composing different engagement or
	// compatibility-projection behavior.
	canonicalRepliesStore := &replies.Store{
		Pool: pool,
		EngagementClassifier: replyEngagementClassifierForDeps(
			engagementClassifierRuntime,
		),
		CampaignReportProjector: replyCampaignReportProjectorForDeps(
			campaignReportProjectionRuntime,
		),
	}

	// G-48: make persisted role→scope grants (roles_permissions) enforceable at
	// request time. Additive + fail-closed; see rbac_enforcement_wiring.go.
	wireStoredScopeResolver(pool)

	telemetryDependencies := apiboot.InitializeTelemetry(logger)
	tracker := telemetryDependencies.Tracker
	defer telemetryDependencies.Close()

	h := &handlers.Handlers{Pool: pool}

	// Agent-identity primitives (Phase 5): per-key budgets, idempotency
	// replay cache, cost ledger. Each owns its own pgx repo; main.go is just
	// the wiring point. RLS + FORCE RLS on every new table means a missing
	// tenant context is fail-closed by Postgres rather than by middleware.
	budgetRepo := &budgets.Repo{Pool: pool}
	idempotencyRepo := &idempotency.Repo{Pool: pool}
	costRepo := &cost.Repo{Pool: pool}
	costHandlers := &cost.Handlers{Repo: costRepo}
	billingRepo := billing.NewRepo(pool)
	billingHandlers := &billing.Handlers{Repo: billingRepo, Logger: logger}
	planLimits := &limits.Enforcer{Pool: pool}
	managedSendAllowance := sendallowance.New(pool)
	limitsHandlers := &limits.Handlers{Pool: pool}
	auditHandlers := &handlers.AuditHandlers{Pool: pool, Logger: logger}
	// natural-language-query feature: optional NLQ pipeline.
	// LLM wired in further down once the safety-anthropic key is
	// inspected (same env fallback). Cache + cost tracker are
	// always-on so tests pass even with no LLM configured.
	auditHandlers.NLQCache = audit.NewNLQCache(audit.NLQCacheTTL)
	auditHandlers.NLQTracker = audit.NewDailyCostTracker(audit.DefaultDailyTokenCap)
	securityHandlers := &handlers.SecurityHandlers{Pool: pool}
	// sto-strategy-persistence (P2): tenant-level send defaults
	// (default_sto_strategy, newsletters_force_per_recipient). Backed
	// by tenant_send_settings (migration 0299). The GET/PUT routes are
	// mounted alongside the security settings routes below.
	sendSettingsHandlers := &handlers.SendSettingsHandlers{Pool: pool}
	paywallDeps := &paywall.Deps{Repo: &paywall.Repo{Pool: pool}, Logger: logger}
	privacyDeps := &privacy.Deps{Pool: pool, Logger: logger}
	privacyIncidentsDeps := &privacy.IncidentsDeps{Pool: pool, Logger: logger}
	var privacyTagHistory privacy.TagHistoryRedactor

	// Janitor: sweep expired idempotency rows hourly. Lives for the
	// process's lifetime; ctx.Done() on shutdown is enough to stop it.
	janitorCtx, janitorCancel := context.WithCancel(context.Background())
	defer janitorCancel()
	idempotencyRepo.StartJanitor(janitorCtx, time.Hour, logger)

	initializeSendingPersistenceAndAWSOut, err := initializeSendingPersistenceAndAWS(pool, cfg, logger)
	if err != nil {
		return err
	}
	stateRepo := initializeSendingPersistenceAndAWSOut.stateRepo
	warmupTracker := initializeSendingPersistenceAndAWSOut.warmupTracker
	tenantControlsRepo := initializeSendingPersistenceAndAWSOut.tenantControlsRepo
	awsCfg := initializeSendingPersistenceAndAWSOut.awsCfg
	kmsKeyID := initializeSendingPersistenceAndAWSOut.kmsKeyID
	envCipher := initializeSendingPersistenceAndAWSOut.envCipher
	secretsResolver := initializeSendingPersistenceAndAWSOut.secretsResolver
	provisioner := initializeSendingPersistenceAndAWSOut.provisioner
	sendingHandlers := initializeSendingPersistenceAndAWSOut.sendingHandlers

	// signed-export-replay (Compliance, P0): wire the export-manifest
	// writer. Reuses the same audit-sink Deps shape so signing-key
	// lookup + decryptSecret are shared with the delivery worker.
	// nil-safe — when no signing keys exist for the tenant, the writer
	// still emits a manifest (just unsigned), and the audit handler
	// records the row in audit_export_manifests either way.
	auditHandlers.ManifestWriter = &auditsink.ExportManifestWriter{
		Deps: &auditsink.Deps{
			Pool:      pool,
			Cipher:    envCipher,
			Encrypter: envCipher,
			Logger:    logger,
		},
	}

	// pii-redaction (Compliance, P0): wire the audit redactor. Every
	// db.Audit() insert now runs the tenant's policy first, masking
	// sensitive fields + (optionally) encrypting them into the
	// metadata_encrypted side-blob. The cipher is the same envelope
	// service used for export manifests + Slack secrets. The "Reveal
	// PII" endpoint on AuditHandlers uses it to decrypt on read with
	// audit:read_pii scope.
	auditHandlers.Cipher = envCipher
	safetyService := wireAuditRedactionAndSafety(pool, auditHandlers, logger)
	// Listmonk client + Forms handlers. Per LICENSE-BOUNDARY.md the gateway
	// only ever talks to Listmonk over HTTP; the client lives in
	// internal/listmonk and never imports any github.com/.../listmonk Go pkg.
	tenantRoutes, err := tenantengine.FromEnv()
	if err != nil {
		return fmt.Errorf("email destination routing: %w", err)
	}
	var resolveEmailDestination func(context.Context, string) (listmonk.Config, error)
	if tenantRoutes != nil {
		resolveEmailDestination = func(ctx context.Context, tenantID string) (listmonk.Config, error) {
			route, err := tenantRoutes.Resolve(tenantID)
			if err != nil {
				return listmonk.Config{}, err
			}
			if err := tenantengine.VerifyPGX(ctx, pool, route); err != nil {
				return listmonk.Config{}, err
			}
			return listmonk.Config{BaseURL: route.BaseURL, Username: route.AdminUser, Password: route.AdminPassword}, nil
		}
	}
	listmonkClient := listmonk.New(listmonk.Config{
		ResolveDestination: resolveEmailDestination,
		DestinationGuard: func(ctx context.Context) error {
			return tenantengine.CheckLegacyPGX(ctx, pool, tenantengine.Tenant(ctx))
		},
		BaseURL:  cfg.ListmonkURL,
		Username: cfg.ListmonkUser,
		Password: cfg.ListmonkPassword,
	})
	buildOutboxPlaneOut := buildOutboxPlane(pool)
	customFieldsRepo := buildOutboxPlaneOut.customFieldsRepo
	customFieldsValidator := buildOutboxPlaneOut.customFieldsValidator
	outboxRepo := buildOutboxPlaneOut.outboxRepo
	dlqDeps := buildOutboxPlaneOut.dlqDeps
	canonicalWebhookFanout := buildOutboxPlaneOut.canonicalWebhookFanout
	listMembershipWebhooks := buildOutboxPlaneOut.listMembershipWebhooks
	webhooksDispatcher := buildOutboxPlaneOut.webhooksDispatcher
	// Slack integration: parallel dispatcher that watches the same event
	// stream as webhooks but writes slack.deliver outbox rows. The
	// SlackHandler decrypts the URL + formats the payload + POSTs.
	slackRepo := &slackint.Repo{Pool: pool, Cipher: envCipher}
	slackDispatcher := &slackint.Dispatcher{Outbox: outboxRepo, Repo: slackRepo}
	// Discord + Teams: same pattern, different wire formats.
	discordRepo := &discordint.Repo{Pool: pool, Cipher: envCipher}
	discordDispatcher := &discordint.Dispatcher{Outbox: outboxRepo, Repo: discordRepo}
	teamsRepo := &teamsint.Repo{Pool: pool, Cipher: envCipher}
	teamsDispatcher := &teamsint.Dispatcher{Outbox: outboxRepo, Repo: teamsRepo}
	eventBusDependencies := apiboot.InitializeEventBus(logger)
	eventsBus := eventBusDependencies.Bus
	// Persistent event log: every Publish() lands in event_log
	// (migration 0119) so SSE consumers can replay from a cursor
	// after disconnect. Best-effort — a log write failure does NOT
	// fail the live publish.
	eventLogReplay := events.NewLogReplay(pool)
	eventsBus.AddPublishHook(events.NewLogWriter(pool))
	// audit.created delivery intent must live in the same transaction as the
	wireAuditEventEmitters(canonicalWebhookFanout, eventsBus)
	subscriberDeps := &subscribers.Deps{
		Repo: &subscribers.Repo{
			Pool:             pool,
			CustomFields:     customFieldsValidator,
			EngineSyncOutbox: newSubscribersEngineSyncOutboxAdapter(outboxRepo),
			Webhooks:         newSubscribersWebhookAdapter(webhooksDispatcher, slackDispatcher, discordDispatcher, teamsDispatcher),
			// Same guarded conversion: a nil *Runtime must not become a non-nil
			// interface. This composes RecordSubscriberEvent (including identified
			// publictrack events) and anonymous-event attribution. MCP custom events
			// and lifecycle stage transitions are separate fixed non-engagement
			// writers; neither delegates through this repository.
			EngagementClassifier: subscriberEngagementClassifierForDeps(engagementClassifierRuntime),
			CampaignReportProjector: subscriberCampaignReportProjectorForDeps(
				campaignReportProjectionRuntime,
			),
		},
		Engine:          listmonkClient,
		Limits:          planLimits,
		Bus:             eventsBus,
		Logger:          logger,
		TriggerReplayer: newSubscribersTriggerReplayer(pool),
	}
	liveCampaignDispatch := dispatchcontrol.StaticGate{Enabled: cfg.CampaignLiveDispatchEnabled}
	campaignAssuranceRolloutMode, campaignAssuranceRolloutErr := resolveCampaignAssuranceGateRollout(cfg)
	if campaignAssuranceRolloutErr != nil {
		return campaignAssuranceRolloutErr
	}
	campaignAssuranceGateConvergence, campaignAssuranceGateErr := initializeCampaignAssuranceGateConvergence(
		pool,
		string(campaignAssuranceRolloutMode),
		prometheus.DefaultRegisterer,
	)
	if campaignAssuranceGateErr != nil {
		return fmt.Errorf("initialize Campaign Assurance gate convergence: %w", campaignAssuranceGateErr)
	}
	campaignDeps := &campaigns.Deps{
		Repo: &campaigns.Repo{
			Pool:            pool,
			Webhooks:        newCampaignsWebhookAdapter(webhooksDispatcher, slackDispatcher, discordDispatcher, teamsDispatcher),
			AudienceCounter: newAudienceCounter(pool),
			ListNamer:       newCampaignListNamer(pool, listmonkClient),
		},
		Artifacts:        campaignartifact.NewRepo(pool),
		Sender:           newCampaignTransactionalSender(listmonkClient, logger),
		Safety:           safetyService,
		Limits:           planLimits,
		Allowance:        managedSendAllowance,
		RequireAllowance: true,
		// KindSend cost recording — the ledger recorded 0¢ for everything.
		CostSink: costRepo,
		// Global control-group holdout at send time — control_group.IsInControl
		// used to be called from nowhere, so "control" members received every
		// campaign and the lift report was noise. This drops active-control
		// members from the audience so program-lift measurement is real.
		ControlGroups: func(ctx context.Context, tenantID string, emails []string) ([]string, int, error) {
			cgRepo := &control_group.Repo{Pool: pool}
			groups, err := cgRepo.ActiveForTenant(ctx, tenantID)
			if err != nil {
				return emails, 0, err
			}
			kept, excluded := control_group.PartitionControl(groups, emails)
			return kept, len(excluded), nil
		},
		Bus:                             eventsBus,
		EmailControls:                   tenantControlsRepo,
		LiveDispatch:                    liveCampaignDispatch,
		ScheduledMaterializationEnabled: cfg.CampaignLiveDispatchEnabled && cfg.CampaignSchedulerEnabled,
	}
	campaignAssuranceGateConvergence.applyCampaignQueue(campaignDeps)
	// Logger was previously unwired on the queue path, so best-effort warnings
	// (e.g. a BILL-052 overage-touch failure) were silently dropped.
	campaignDeps.Logger = logger
	intelligentRetryQueue := &intelligent_retry.Queue{
		Pool: pool,
		Frequency: func(ctx context.Context, tenantID, channel string, candidates []string) ([]string, error) {
			res, err := frequency.FilterAudienceForChannel(ctx, pool, tenantID, channel, candidates)
			return res.Kept, err
		},
		SubscriberPreference: func(ctx context.Context, tenantID string, candidates []string) ([]string, error) {
			res, err := frequency.FilterBySubscriberPreference(ctx, pool, tenantID, candidates)
			return res.Kept, err
		},
	}
	campaignDeps.RetryQueue = campaignRetryQueueAdapter{Queue: intelligentRetryQueue}
	triggerDelayRepo := &trigger_delay.Repo{Pool: pool}
	wireCampaignQueueFilters(campaignDeps, pool, logger)
	campaignDeps.Prioritization = func(ctx context.Context, tenantID, campaignID string, candidates []string) ([]string, int, error) {
		res, err := prioritization.FilterAudience(ctx, pool, tenantID, campaignID, candidates)
		if err != nil {
			return candidates, 0, err
		}
		return res.Kept, res.Skipped, nil
	}
	compatDeps := &compat.Deps{Repo: &compat.Repo{Pool: pool}, Subscribers: subscriberDeps.Repo, Limits: planLimits, Logger: logger, LandingVariantSignKey: cfg.SendingKEK}
	providerIntegrationsSurface := apiserver.NewProviderIntegrationsSurface(apiserver.ProviderIntegrationsDeps{
		Pool:               pool,
		Cipher:             envCipher,
		SubscriberProfiles: subscriberDeps.Repo,
		ListMemberships:    listMembershipWebhooks,
		Secrets:            secretsResolver,
		Config:             cfg,
		Getenv:             os.Getenv,
		Logger:             logger,
	})
	commerceRepo := providerIntegrationsSurface.CommerceRepository
	commerceDeps := providerIntegrationsSurface.CommerceDependencies
	crmIntegrationsRepo := providerIntegrationsSurface.CRMRepository
	crmIntegrationsDeps := providerIntegrationsSurface.CRMDependencies
	leadIntegrationsRepo := providerIntegrationsSurface.LeadRepository
	leadIntegrationsDeps := providerIntegrationsSurface.LeadDependencies
	marketingIntegrationsRepo := providerIntegrationsSurface.MarketingRepository
	marketingIntegrationsDeps := providerIntegrationsSurface.MarketingDependencies
	mailchimpV3Deps := &mailchimpv3.Deps{
		// The compatibility surface updates the campaign BODY and is reachable
		// by anyone holding an API key, so it belongs under the same
		// single-writer rule as the first-party PATCH — without this it is the
		// way around the lease.
		EditLease: campaignDeps,
		Store: &mailchimpv3.Repo{
			Pool:         pool,
			SecretCipher: envCipher,
			LegacyKEK:    cfg.SendingKEK,
			SocialAds: socialads.NewRegistry(socialads.Config{
				MetaGraphBaseURL:               cfg.MetaGraphBaseURL,
				MetaGraphVersion:               cfg.MetaGraphVersion,
				MetaPageID:                     cfg.MetaPageID,
				MetaPageAccessToken:            cfg.MetaPageAccessToken,
				MetaInstagramBusinessAccountID: cfg.MetaInstagramBusinessAccountID,
				MetaAdAccountID:                cfg.MetaAdAccountID,
				MetaAdsAccessToken:             cfg.MetaAdsAccessToken,
				GoogleAdsAPIBaseURL:            cfg.GoogleAdsAPIBaseURL,
				GoogleAdsAPIVersion:            cfg.GoogleAdsAPIVersion,
				GoogleAdsDeveloperToken:        cfg.GoogleAdsDeveloperToken,
				GoogleAdsClientID:              cfg.GoogleAdsClientID,
				GoogleAdsClientSecret:          cfg.GoogleAdsClientSecret,
				GoogleAdsRefreshToken:          cfg.GoogleAdsRefreshToken,
				GoogleAdsLoginCustomerID:       cfg.GoogleAdsLoginCustomerID,
				GoogleAdsCustomerID:            cfg.GoogleAdsCustomerID,
				GoogleOAuthTokenURL:            cfg.GoogleOAuthTokenURL,
			}, nil),
		},
		MergeFields: &merge_fields.Repo{Pool: pool},
	}
	smsDeps := buildSMSDeps(cfg, pool, logger)
	// Deliberately do not wire smsDeps.Mirror. The legacy Twilio-only hook
	// copied raw phone/body data into service_suite's weaker read:reports plane
	// without an atomic outbox, equivalent retention/SAR coverage, or exact SMS
	// content authorization. The canonical SMS inbox remains the sole history.
	socialCaptureDeps := &social_capture.Deps{
		Repo:         &social_capture.Repo{Pool: pool},
		SMS:          smsDeps.Store,
		PublicBase:   os.Getenv("POSTWAVE_PUBLIC_BASE_URL"),
		TikTokSecret: os.Getenv("POSTWAVE_TIKTOK_CLIENT_SECRET"),
	}
	lifecycleForwarder := &lifecycle.HTTPAutomationForwarder{
		BaseURL:          cfg.AutomationServiceURL,
		InternalAPIToken: cfg.InternalAPIToken,
		NotDeployed:      cfg.AutomationServiceURL == "",
	}
	lifecycleRepo := &lifecycle.Repo{Pool: pool, AutomationOutbox: outboxRepo}
	registerCoreOutboxHandlersOut := registerCoreOutboxHandlers(registerCoreOutboxHandlersDeps{
		listmonkClient:     listmonkClient,
		logger:             logger,
		subscriberDeps:     subscriberDeps,
		pool:               pool,
		lifecycleRepo:      lifecycleRepo,
		lifecycleForwarder: lifecycleForwarder,
		envCipher:          envCipher,
		webhooksDispatcher: webhooksDispatcher,
		slackDispatcher:    slackDispatcher,
		discordDispatcher:  discordDispatcher,
		teamsDispatcher:    teamsDispatcher,
	})
	outboxRegistry := registerCoreOutboxHandlersOut.outboxRegistry
	webhooksRepo := registerCoreOutboxHandlersOut.webhooksRepo
	webhooksFanoutHandler := registerCoreOutboxHandlersOut.webhooksFanoutHandler
	// Per-integration outbox handlers: each pulls its own kind, decrypts
	// the URL, formats the payload in its native wire shape, POSTs.
	// Same lease/retry semantics as webhooks.deliver — they all ride
	// the shared outbox worker.
	slackHandler := &slackint.SlackHandler{Repo: slackRepo}
	outboxRegistry.Register(slackint.OutboxKind, slackHandler.Handle)
	discordHandler := &discordint.DiscordHandler{Repo: discordRepo}
	outboxRegistry.Register(discordint.OutboxKind, discordHandler.Handle)
	teamsHandler := &teamsint.TeamsHandler{Repo: teamsRepo}
	outboxRegistry.Register(teamsint.OutboxKind, teamsHandler.Handle)
	registerAutomationMessageHandlers(smsDeps, outboxRegistry, pool, listmonkClient, tenantControlsRepo, managedSendAllowance, listMembershipWebhooks, logger)

	// Coupon entitlement allocation is release-contained. While the gate is
	// false, no handler with inventory authority is registered; any legacy
	// queued row is preserved in the DLQ rather than allocating a code.
	if discounts.CouponAllocationAvailable {
		automationCouponHandler := &discounts.AutomationCouponHandler{Repo: &discounts.Repo{Pool: pool}, Logger: logger}
		outboxRegistry.Register(discounts.AutomationCouponKind, automationCouponHandler.Handle)
	}
	// Startup invariant: every outbox kind that callers write MUST have
	// a registered handler. Without this check, a wiring drop would
	// silently DLQ every event of the dropped kind — the forms-confirm
	// DOI flow would look "saved" but the Listmonk subscriber would
	// stay disabled forever (the exact bug the outbox refactor closed).
	requiredOutboxKinds := []string{
		forms.OutboxKindEnableListmonk, forms.OutboxKindRecordSignup, forms.OutboxKindSendConfirmation,
		subscribers.OutboxKindListmonkSync,
		subscribers.OutboxKindListmonkDelete,
		lifecycle.AutomationOutboxKind,
		webhooks.OutboxKind,
		webhooks.FanoutKind,
		slackint.OutboxKind,
		discordint.OutboxKind,
		teamsint.OutboxKind,
		auth.DeviceSignInOutboxKind,
	}
	if discounts.CouponAllocationAvailable {
		requiredOutboxKinds = append(requiredOutboxKinds, discounts.AutomationCouponKind)
	}
	// ----- unified notification fanout (Apple-level integration, fix-now #2/#3) -----
	// One chokepoint gives every notification a shared cross-channel identity
	// (the notification_feed row id), per-user dedup, preference gating, and
	// best-effort fanout to mobile push + web push + the SSE bus. Constructed
	// BEFORE the worker block so the flow-run drainer and the webhook ingest
	// path can notify operators; the route mounts and approvals wire-up
	// further down share these same channel instances.
	//
	// Web Push is disabled (all sends no-op) unless the VAPID keypair is in
	// the environment. Generate with webpush.GenerateVAPIDKeys().
	webpushDeps := &webpush.Deps{
		Pool:       pool,
		PublicKey:  os.Getenv("VAPID_PUBLIC_KEY"),
		PrivateKey: os.Getenv("VAPID_PRIVATE_KEY"),
		Subject:    os.Getenv("VAPID_SUBJECT"),
		Logger:     logger,
	}
	// First-party native push uses a session-scoped device resource. Tokens are
	// envelope-encrypted in Postgres and sent only in the HTTPS request body to
	// Expo; they are never embedded in generic webhook URLs or list responses.
	mobilePushDeps := &mobilepush.Deps{
		Pool:   pool,
		Cipher: envCipher,
		HTTPClient: &http.Client{
			Transport: runtimeobs.HTTPTransport(nil),
			Timeout:   10 * time.Second,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				// Do not forward the Expo access token to a redirect target.
				return http.ErrUseLastResponse
			},
		},
		ExpoAccessToken:    os.Getenv("EXPO_PUSH_ACCESS_TOKEN"),
		RequireAccessToken: isProductionEnv(),
		Logger:             logger,
	}
	notificationFeedRepo := &notification_feed.Repo{Pool: pool}
	canonicalOffersRepo := &offers.Repo{Pool: pool}
	actionTicketLinker := &actionticket.Linker{
		Repo: &actionticket.Repo{
			Pool: pool, Binder: canonicalOffersRepo,
		},
		BaseURL: os.Getenv("POSTWAVE_PUBLIC_BASE_URL"),
	}
	if isProductionEnv() && strings.TrimSpace(actionTicketLinker.BaseURL) == "" {
		return errors.New("POSTWAVE_PUBLIC_BASE_URL is required in production for HTTPS action-ticket links")
	}
	if err := actionTicketLinker.Validate(); err != nil {
		return fmt.Errorf("action-ticket public origin: %w", err)
	}
	notifyFanout, operatorNotifier, err := wireNotifyFanout(wireNotifyFanoutDeps{
		notificationFeedRepo:  notificationFeedRepo,
		webpushDeps:           webpushDeps,
		mobilePushDeps:        mobilePushDeps,
		pool:                  pool,
		logger:                logger,
		actionTicketLinker:    actionTicketLinker,
		eventsBus:             eventsBus,
		outboxRegistry:        outboxRegistry,
		requiredOutboxKinds:   requiredOutboxKinds,
		smsDeps:               smsDeps,
		webhooksFanoutHandler: webhooksFanoutHandler,
	})
	if err != nil {
		return err
	}
	// INBOX-036: scan the reputation trend (reputation_snapshots) for
	// blocklist-hit / reputation-drop transitions and fan an alert out to the
	// tenant's operators via the same notifyfanout chokepoint. Read-only over a
	// table the deliverability service already writes; no-ops until snapshots
	// accrue.
	reputationAlertWorker := &reputationalerts.Worker{
		Pool:   pool,
		Fanout: notifyFanout,
		Logger: logger,
	}

	// The background-worker census. Installed HERE, immediately before the
	// first safego.Go call in this file, because the observer only sees
	// workers spawned after it: anything started earlier would be recorded as
	// never-started and render RED forever.
	//
	// It is in-memory and needs no database, so it deliberately does not wait
	// for the ops pool that is built much further down. The check that reads
	// it (checks.RegisterWorkerFleet) is registered with the rest of the ops
	// wiring once that pool exists.
	opsFleet := ops.NewFleet()
	for _, spec := range checks.DeclaredWorkers {
		opsFleet.Declare(spec)
	}
	safego.SetObserver(opsFleet)

	outboxWorker := outbox.NewWorker(outboxRepo, outboxRegistry)
	outboxWorker.Logger = logger
	outboxCtx, outboxCancel := context.WithCancel(context.Background())
	defer outboxCancel()
	if engagementClassifierRuntime != nil && engagementClassifierRuntime.Enabled() {
		safego.Go(logger, "engagement-observation-retention", func() {
			if err := engagementClassifierRuntime.RunRetention(outboxCtx, logger); err != nil &&
				!errors.Is(err, context.Canceled) {
				logger.Warn("engagement observation retention worker exited", "err", err)
			}
		})
		// Stage 2 (PRD F01). Stage 1 classifies on arrival; Stage 2 re-evaluates
		// 60s after a message's FIRST event and again at conversion-window close,
		// once the SHAPE of the traffic is visible. A single open looks human
		// until you see forty identical ones 200ms apart.
		//
		// Without this drain the schedule is written and never read, which is the
		// worst of the three states: the rows accumulate, the verdicts never
		// improve, and nothing reports that Stage 2 is not running.
		safego.Go(logger, "engagement-stage-two-evaluator", func() {
			if err := engagementClassifierRuntime.RunStageTwo(outboxCtx, logger); err != nil &&
				!errors.Is(err, context.Canceled) {
				logger.Warn("engagement stage two evaluator exited", "err", err)
			}
		})
	}
	startOutboxDrainWorkers(logger, outboxWorker, outboxCtx, reputationAlertWorker, billingRepo)
	apiworkers.StartMarketingIntegrationBackfills(outboxCtx, apiworkers.MarketingIntegrationBackfillDeps{
		Dependencies: marketingIntegrationsDeps,
		Store:        marketingIntegrationsRepo,
		Logger:       logger,
	})
	apiworkers.StartIntelligentRetryWorker(outboxCtx, logger, intelligentRetryQueue)
	// The sweep half of the web push delivery ledger (migrations 1883/1886).
	// Without it a rejected notification is recorded and never re-sent, which is
	// a more detailed way of losing it than the log line it replaced.
	apiworkers.StartWebPushRetryWorker(outboxCtx, webpushDeps, logger)
	// ...and the notification webhook's, the only channel that had neither a
	// retry nor a way to ask for one: Dispatch returns no error, so a failed post
	// could not reach whatever queued it (migrations 1885/1889).
	apiworkers.StartNotificationWebhookRetryWorker(outboxCtx,
		notifywebhook.NewRecorder(pool), notifywebhook.New(), logger)
	apiworkers.StartCommerceProviderBackfills(outboxCtx, apiworkers.CommerceProviderBackfillDeps{
		Pool:                 pool,
		Dependencies:         commerceDeps,
		Store:                commerceRepo,
		AutomationServiceURL: cfg.AutomationServiceURL,
		RunFailureNotify:     operatorNotifier,
		Logger:               logger,
	})
	apiworkers.StartCRMProviderBackfills(outboxCtx, apiworkers.CRMProviderBackfillDeps{
		Dependencies:             crmIntegrationsDeps,
		Store:                    crmIntegrationsRepo,
		ReconcileHubSpotWebhooks: strings.TrimSpace(os.Getenv("HUBSPOT_DEVELOPER_API_KEY")) != "" && strings.TrimSpace(os.Getenv("HUBSPOT_APP_ID")) != "",
		Logger:                   logger,
	})
	apiworkers.StartLeadProviderBackfills(outboxCtx, apiworkers.LeadProviderBackfillDeps{
		Dependencies: leadIntegrationsDeps,
		Store:        leadIntegrationsRepo,
		Logger:       logger,
	})
	startSendingMaintenanceWorkers(logger, outboxCtx, provisioner, pool)
	// The legacy campaign scheduler is compile-time locked until durable claim
	// recovery is qualified. The two configuration flags are additional future
	// interlocks; setting them today cannot arm the worker.
	if campaignSchedulerStartupEnabled(cfg) {
		scheduler := &campaigns.Scheduler{
			Base: campaignDeps,
			SendDeps: &campaigns.SendDeps{
				Sender:      listmonkClient,
				Warmup:      newWarmupGate(warmupTracker),
				Audience:    newAudienceCounter(pool),
				DefaultFrom: os.Getenv("POSTWAVE_DEFAULT_FROM_EMAIL"),
			},
			Pool:     campaignDeps.Repo,
			Interval: 30 * time.Second,
		}
		safego.Go(logger, "campaign-scheduler", func() { scheduler.Run(outboxCtx) })
	} else {
		logger.Info("campaign scheduler disabled",
			"scheduler_opt_in", cfg.CampaignSchedulerEnabled,
			"live_dispatch_opt_in", cfg.CampaignLiveDispatchEnabled)
	}

	// G-11: the weekly predictive-CLV worker drives per-tenant recompute
	// through internal/predictive's (now BG/NBD-backed) path, via an injected
	// seam so sto_predictive_clv stays decoupled from that package.
	stoPredictiveWorker := &sto_predictive_clv.Worker{
		Pool:   pool,
		Logger: logger,
		Recompute: func(ctx context.Context, tenantID string) error {
			_, rerr := (&predictive.Repo{Pool: pool}).Recompute(ctx, tenantID, 365)
			return rerr
		},
	}
	safego.Go(logger, "sto-predictive-clv-worker", func() { stoPredictiveWorker.Loop(outboxCtx) })
	startSMSWorker(smsDeps, cfg, logger, outboxCtx)
	suppressionsStore, sendSuppressionConverger := buildSendSuppressionConverger(pool, logger, campaignDeps)
	tieredSendRateLimiter, closeSendRateLimiter, err := buildTieredSendRateLimiter(logger, pool)
	defer closeSendRateLimiter()
	if err != nil {
		return err
	}
	recipientHealthGateEnabled := os.Getenv("POSTWAVE_DISABLE_RECIPIENT_HEALTH_GATE") != "1"
	sendRecipientSafety := sending.RecipientSafetyGateForRollout(
		pool,
		sending.NewSuppressionConvergerAdapter(sendSuppressionConverger),
		recipientHealthGateEnabled,
	)
	if !recipientHealthGateEnabled {
		// The canonical consent/suppression boundary remains active. This switch
		// disables only the additive verification-health lookup so operators can
		// contain a rollout/query regression without allowing unsubscribed users.
		logger.Warn("sending: recipient verification-health gate disabled by emergency kill switch")
	}
	sendGuard := &sending.Guard{
		Pool:             pool,
		Listmonk:         newListmonkSender(listmonkClient, os.Getenv("POSTWAVE_DEFAULT_FROM_EMAIL")),
		Allowance:        managedSendAllowance,
		RequireAllowance: true,
		RateLimit:        tieredSendRateLimiter,
		QuietHours:       &sending.QuietHoursChecker{Pool: pool},
		Controls:         tenantControlsRepo,
		// Compose the canonical three-table suppression boundary with terminal
		// verifier verdicts and recent D-grade evidence. The wrapper implements
		// both the batch preflight and scalar last-moment recheck; it can only
		// add a block and therefore cannot weaken consent/suppression decisions.
		Suppressions: sendRecipientSafety,
		// Warmup cap enforcement at drain time (audit send-loop CRITICAL #2).
		// Previously the cap was only consulted at /send dispatch; the
		// drain loop would burn through a 50K-row day-1 campaign at
		// full throttle, blowing the warming IP's reputation.
		Warmup: warmupTracker,
		// Dedicated-IP routing (audit send-pipeline HIGH): the drain
		// loop now consults this per batch to resolve which Listmonk
		// `messenger` (= SMTP backend) the tenant's sends should
		// route through. Without it, "dedicated" assignments were
		// decorative — all sends went through the default pool.
		DedicatedIP: &sending.DedicatedIPRepo{Pool: pool},
		// Record a per-campaign untracked-link scan at body-fetch time (KLV-14).
		UntrackedLinks: &deliverability_control.Repo{Pool: pool},
		// Per-recipient List-Unsubscribe + RFC 8058 one-click headers
		// attached on every commercial send. Required for Gmail/Yahoo
		// bulk-sender compliance (>= 5000 messages/day).
		ListUnsubscribe: &sending.ListUnsubscribeBuilder{
			Pool:          pool,
			PublicBaseURL: os.Getenv("POSTWAVE_PUBLIC_BASE_URL"),
		},
		// Reply correlation is deliberately absent from the legacy Listmonk
		// guard. The assurance-bound raw runtime mints and persists the opaque
		// address because it can prove the final MIME; Listmonk cannot expose
		// that proof and therefore remains non-qualifying.
		// Per-recipient open/click tracking opt-out lookup. Reads
		// subscriber_tracking_prefs at send time and attaches the
		// X-Postwave-No-{Open,Click}-Track headers when set, with a
		// metric counter so the consent surface is observable.
		TrackingFilter: &consent.SendTrackingFilter{Pool: pool},
		// Archive-bar / View-in-browser token renderer. Substitutes
		// the {{ archive_bar }}, {{ view_in_browser_url }}, and
		// {{ archive_url }} tokens in the campaign body once per
		// batch using tenant_public_settings defaults plus per-campaign
		// delivery_settings overrides. Nil-safe; leaving it off keeps
		// the legacy behaviour where tokens stay literal in-body.
		// Gap feature `archive-mailchimpv3-archive-bar`.
		ArchiveBar:        &sending.ArchiveBarRenderer{Repo: &archive_bar.Repo{Pool: pool}, PublicBaseURL: os.Getenv("POSTWAVE_PUBLIC_BASE_URL")},
		PurposeConsent:    purposeConsentLookupFromEnv(pool),
		PurposeConsentKey: os.Getenv("POSTWAVE_PURPOSE_CONSENT_GATE"),
		Logger:            logger,
		BatchSize:         50,
		LoopInterval:      5 * time.Second,
	}
	// Worker startup is intentionally deferred until the shared object store,
	// outbound receipt mailer, assurance-bound raw runtime, and send-complete
	// notifier have all been assigned. Starting here would race those late
	// composition writes and could drain a bound row through an incomplete
	// process graph.
	// A/B test auto-promote scheduler. Polls campaign_ab_settings rows
	// where the evaluation_window_hours has elapsed since the campaign's
	// 'sent' flip and winner_decided_at IS NULL; runs EvaluateWinner +
	// MarkWinner on each. Closes the V1 gap where winners only landed
	// when an operator clicked the Evaluate button.
	abRepo, abWinnerDeps := startCampaignSchedulers(startCampaignSchedulersDeps{
		pool:               pool,
		campaignDeps:       campaignDeps,
		cfg:                cfg,
		logger:             logger,
		outboxCtx:          outboxCtx,
		outboxRepo:         outboxRepo,
		webhooksDispatcher: webhooksDispatcher,
		slackDispatcher:    slackDispatcher,
		discordDispatcher:  discordDispatcher,
		teamsDispatcher:    teamsDispatcher,
	})
	buildFormsDepsOut := buildFormsDeps(pool, logger, secretsResolver, cfg, outboxRepo)
	formsRepo := buildFormsDepsOut.formsRepo
	discountsRepo := buildFormsDepsOut.discountsRepo
	onsiteGrowthRepo := buildFormsDepsOut.onsiteGrowthRepo
	verificationStore := buildFormsDepsOut.verificationStore
	formsDeps := buildFormsDepsOut.formsDeps
	publicFormEmbed := buildFormsDepsOut.publicFormEmbed
	// File-upload store. POSTWAVE_UPLOADS_BUCKET + AWS_REGION → S3
	// (SSE-KMS forced via POSTWAVE_S3_KMS_KEY_ID). Local/dev may use the
	// local /tmp store; production fails closed if S3 is not configured.
	// LocalUploadStore is dev-only and exposes a PUT endpoint
	// the browser hits with the presigned URL — see local_upload_store.go.
	// (The dev PUT route is registered later, after the chi router is
	// created.)
	uploadStorage, uploadStorageErr := apiboot.InitializeUploadStorage(
		awsCfg,
		cfg.FormsPublicHost,
		logger,
		apiboot.UploadStoragePolicy{IsProduction: isProductionEnv},
		apiboot.UploadStorageBindings{
			AdaptS3ForForms: func(store *uploads.S3UploadStore) forms.UploadStore {
				return &s3FormsAdapter{store: store}
			},
			SetFormsPresignClient: func(client *s3.PresignClient) {
				formsPresignClient = client
			},
		},
	)
	if uploadStorageErr != nil {
		return uploadStorageErr
	}
	uploadStore := uploadStorage.FormUploadStore
	warehouseObjectStore := uploadStorage.WarehouseObjectStore
	localUploadStore := uploadStorage.LocalUploadStore
	objectS3Client := uploadStorage.ObjectS3Client
	s3KMSKeyID := uploadStorage.S3KMSKeyID
	campaignAssuranceRuntime, campaignAssuranceRuntimeErr := initializeCampaignAssuranceRuntime(
		outboxCtx,
		cfg.CampaignAssuranceRuntimeEnabled,
		pool,
		warehouseObjectStore,
		logger,
	)
	if campaignAssuranceRuntimeErr != nil {
		return campaignAssuranceRuntimeErr
	}
	if campaignAssuranceRuntime.enabled() {
		logger.Info("campaign assurance control plane enabled",
			"execution_boundary", "dedicated-campaign-assurance-worker",
			"measurement", "Predicted Agent Comprehension")
	} else {
		logger.Info("campaign assurance runtime disabled; API remains fail-closed",
			"enable_env", "POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_RUNTIME")
	}
	// G-18: activate the CDC→Iceberg lakehouse consumer when POSTWAVE_CDC_ENABLED
	// is set (no-op otherwise). Runs under the background worker context.
	startCDCConsumer(outboxCtx, logger, pool, objectS3Client, s3KMSKeyID)
	formsUploads, err := buildFormUploads(pool, formsRepo, uploadStore, logger, cfg, formsDeps, outboxCtx)
	if err != nil {
		return err
	}
	rateLimitOptions, distributedRateLimitStore, publicRateLimit, err := buildDistributedRateLimitStore(cfg, logger)
	if err != nil {
		return err
	}
	actionTicketRateLimitOptions := rateLimitOptions
	actionTicketRateLimitOptions.Namespace = "ip:action-ticket"
	actionTicketRateLimit := middleware.NewRateLimitWithOptions(
		actionTicketRequestsPerMinute,
		time.Minute,
		actionTicketRateLimitOptions,
	)
	publicFormsLimits, inboundWebhookRateLimit, archivePixelRateLimit, billingWebhookRateLimit := buildPublicRouteLimits(rateLimitOptions)

	approvalsService, approvalsDeps := buildApprovalsService(buildApprovalsServiceDeps{
		pool:                   pool,
		canonicalWebhookFanout: canonicalWebhookFanout,
		webhooksDispatcher:     webhooksDispatcher,
		cfg:                    cfg,
		eventsBus:              eventsBus,
		logger:                 logger,
		notifyFanout:           notifyFanout,
		outboxCtx:              outboxCtx,
		mobilePushDeps:         mobilePushDeps,
	})
	// Slack approval-bot wiring. The OAuth handlers, slash-command
	// handler, and interactions handler all share the same envCipher +
	// pool. The bot-token HMAC key reuses the SendingKEK — same
	// rationale as the approval signed-link key above.
	slackOAuthDeps := slackint.NewOAuthDepsFromEnv(pool, envCipher, cfg.SendingKEK)
	slackApprovalDeps := &slackint.ApprovalDeps{
		Pool:    pool,
		Cipher:  envCipher,
		HMACKey: cfg.SendingKEK,
		HTTPClient: &http.Client{
			Transport: runtimeobs.HTTPTransport(nil),
			Timeout:   10 * time.Second,
		},
		SummaryFn: func(ctx context.Context, tenantID, resourceType, resourceID string) string {
			// Best-effort one-line summary lookup. Currently a no-op
			// (returns empty so the renderer falls back to
			// `<resource_type> · <resource_id>`); extend per resource
			// as a follow-up.
			return ""
		},
	}
	approvalsDeps.SlackPoster = approvalSlackBridge{Deps: slackApprovalDeps}
	campaignDeps.Approvals = campaignApprovalGate{
		Service:     approvalsService,
		SlackPoster: approvalsDeps.SlackPoster,
	}
	approvedHook := approvals.ApprovedHook(func(ctx context.Context, tenantID string, resourceType approvals.ResourceType, resourceID string) error {
		if resourceType != approvals.ResourceCampaign {
			return nil
		}
		_, err := campaignDeps.QueueApprovedCampaign(ctx, tenantID, resourceID)
		return err
	})
	approvalsDeps.OnApproved = approvedHook
	slackInteractionsDeps := slackint.NewInteractionsDeps(pool, envCipher, cfg.SendingKEK,
		approvalDeciderAdapter{Service: approvalsService, OnApproved: approvedHook})
	slackSlashDeps := &slackint.SlashCommandDeps{
		Pool:          pool,
		Cipher:        envCipher,
		SigningSecret: os.Getenv(slackint.SlackSigningSecretEnv),
		HMACKey:       cfg.SendingKEK,
		Approvals:     approvalCreatorAdapter{Service: approvalsService, SlackPoster: approvalsDeps.SlackPoster},
		PostApproval:  slackApprovalDeps.PostApprovalRequest,
	}

	safetyDeps := &safety.Deps{Service: safetyService, Logger: logger}
	readinessDeps := &readiness.Deps{Config: cfg, DB: pool}

	// Sandbox flusher: promotes due sandbox_events into subscriber_events.
	sandboxFlusher := &sandbox.Flusher{
		Pool:     pool,
		Interval: 5 * time.Second,
		Logger:   logger,
	}
	// outboxCtx (not Background) so SIGTERM cancels cleanly; safego
	// for panic recovery. Worker audit HIGH #7.
	safego.Go(logger, "sandbox-flusher", func() { sandboxFlusher.Run(outboxCtx) })
	// Approval expiry sweeper: sweeps pending rows past their TTL into
	// `expired` once a minute. Cheap; a single UPDATE per tick.
	safego.Go(logger, "approvals-expiry-sweeper", func() {
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		for range t.C {
			if _, err := approvalsService.SweepExpired(context.Background()); err != nil {
				logger.Warn("approvals sweep failed", "err", err.Error())
			}
		}
	})

	r := chi.NewRouter()

	// sharedRetentionSweeper is constructed once here so both the
	// route-mount block (POST /api/v1/retention/run) and the
	// background worker goroutine (see retentionSweeper wire-up
	// later in this file) reuse the same instance. Interval/logger
	// are filled in below where the env-var lookup happens.
	sharedRetentionSweeper := &retention.Sweeper{
		Pool:    pool,
		Privacy: &settings.PrivacyRepo{Pool: pool},
		Logger:  logger,
		// ExportStore is wired below where assetStorage is selected
		// (line ~1547). Until then it stays nil and sweep_exports
		// falls back to row-only deletion (safe — expires_at on the
		// row is already past so the signed URL is dead).
	}

	// Custom NotFound + MethodNotAllowed handlers so framework-level
	// responses use the same {"error":{"code","message"}} envelope as
	// every application-level error. Without these, chi falls back to
	// `text/plain "404 page not found"` and an empty 405 body — both
	// break SDK clients that always JSON-parse non-2xx.
	r.NotFound(sms.ProtectRoute42Responses(pushsuppressions.ProtectRoute43Responses(outbound_webhooks.ProtectPlaygroundResponses(jsonError(http.StatusNotFound, "not_found",
		"The requested resource does not exist.")))).ServeHTTP)
	r.MethodNotAllowed(sms.ProtectRoute42Responses(pushsuppressions.ProtectRoute43Responses(outbound_webhooks.ProtectPlaygroundResponses(jsonError(http.StatusMethodNotAllowed, "method_not_allowed",
		"This route does not support that HTTP method.")))).ServeHTTP)

	webVitalsOrigins := parseWebVitalsOrigins()
	useRootMiddleware(r, logger, cfg, webVitalsOrigins)

	// Public routes — no tenant context required.
	r.Get("/api/health", handlers.Health)
	r.Get("/api/v1/healthz", handlers.Health)
	r.Get("/api/ready", readinessDeps.Ready)
	// Route41: every support-provider callback is root-mounted as a zero-side-
	// effect 503 hold. It intentionally runs before tenant/session middleware;
	// mounting these machine callbacks in the authenticated stack produced a
	// misleading 401 and never exercised provider credentials.
	support_integrations.MountPublicRoutes(r, nil)
	auditPortalDeps, err := buildAuditPortalHandlers(pool, cfg, logger)
	if err != nil {
		return err
	}
	r.Get("/portal/audit", auditPortalDeps.ServeSPA)
	r.Get("/portal/audit/", auditPortalDeps.ServeSPA)
	r.Get("/portal/audit/assets/*", auditPortalDeps.ServeAsset)
	r.Post("/api/v1/audit/portal/exchange", auditPortalDeps.Exchange)
	r.With(auditPortalDeps.RequirePortalSession).Get("/api/v1/audit/portal/branding", auditPortalDeps.Branding)
	// Portal evidence is a release-held capability. Keep both literal routes
	// behind the dedicated cookie boundary, but do not delegate to the internal
	// raw-event or proof handlers: those contracts expose fields that have not
	// yet been qualified for an external-auditor projection.
	r.With(auditPortalDeps.RequirePortalSession).
		Get("/api/v1/audit/portal/events", auditPortalDeps.EvidenceReleaseHold)
	r.With(auditPortalDeps.RequirePortalSession).
		Get("/api/v1/audit/portal/ai-session/{session_id}/aivs-bundle", auditPortalDeps.EvidenceReleaseHold)

	// Prometheus metrics endpoint. We deliberately gate this on either
	// (a) loopback origin (127.0.0.1 / ::1) — typical for an in-cluster
	// Prometheus sidecar that scrapes via localhost — OR (b) a shared
	// internal token (METRICS_TOKEN env var; absent ⇒ token gate is
	// disabled and we fall back to loopback-only).
	//
	// Why no auth middleware: chi's tenant middleware would 401 on a
	// scraper that has no Moosewave session. Prometheus exposition is by
	// definition tenant-less.
	//
	// Why not panic on no metrics recorded yet: promauto registers the
	// collectors at init() (so /metrics emits empty series rather than
	// 500'ing) and promhttp.Handler is goroutine-safe.
	metricsToken := os.Getenv("METRICS_TOKEN")
	metricsHandler := runtimeobs.ProtectMetrics(metricsToken, promhttp.Handler())
	r.Get("/metrics", metricsHandler.ServeHTTP)

	// Dev-only direct-upload PUT endpoint, reached through the presigned URL
	// HandlePresignRequest returns when no S3 bucket is configured. It is
	// mounted in every configuration so route authorization's reverse check
	// holds in production, where it answers 404 (see localUploadPutHandler).
	// p4d-recordsurface-wire-others: same forms surface as public submit.
	r.Put("/api/internal/uploads/{key:.+}", observability.RecordSurfaceFunc("forms", "upload_put", localUploadPutHandler(localUploadStore)))
	r.Get("/api/listmonk/health", handlers.ListmonkProxy(cfg.ListmonkURL, "/api/health", cfg.ListmonkUser, cfg.ListmonkPassword))

	budgetIncrementer, resolveTenantID, resolveIdempotencyReplayScope := buildRequestScopeResolvers(budgetRepo)
	privacyIncidentIdempotency := idempotency.ProcessWithReplayBypass(
		idempotencyRepo,
		resolveTenantID,
		privacy.BypassIncidentReleaseHoldReplay,
		resolveIdempotencyReplayScope,
	)

	apiKeyResolver := &apikeys.Repo{Pool: pool, Pepper: cfg.APIKeyPepper}
	// apiKeyAuthCache wraps the resolver with a 45s LRU + singleflight +
	// batched TouchLastUsed. Used by the bearer-token Middleware so the
	// hot path collapses 3 Pg tx (LookupByHash + tenant + touch) into
	// zero on cache hit. Admin CRUD paths keep using the raw resolver so
	// reads/writes still hit Postgres directly.
	apiKeyAuthCache := apikeys.NewAuthCache(apiKeyResolver, pool, apikeys.AuthCacheOptions{})
	marketplaceOAuthBearerResolver := developer_marketplace.NewOAuthBearerResolver(pool)
	streamTokenSecret := cfg.APIKeyPepper
	if len(streamTokenSecret) == 0 {
		streamTokenSecret = []byte("postwave-dev-stream-token-secret-only-for-local")
	}

	// ESP feedback-loop deps (used by both the internal HMAC routes
	// further down and the admin GET inside the tenant-scoped group).
	feedbackRepo := &feedback.Repo{Pool: pool}
	feedbackDeps := &feedback.Deps{
		Pool:                   pool,
		Repo:                   feedbackRepo,
		PostmarkSecret:         os.Getenv("POSTWAVE_POSTMARK_HMAC_SECRET"),
		SendGridSecret:         os.Getenv("POSTWAVE_SENDGRID_HMAC_SECRET"),
		ARFSecret:              os.Getenv("POSTWAVE_ARF_HMAC_SECRET"),
		AllowUnsignedDevBypass: cfg.AllowDevListmonkWebhookBypass,
		Logger:                 logger,
	}

	regionsHandlers, regionLookup := buildRegionLookup(pool)
	// Deliverability entitlement meter — gates inbox-reality tests + email
	// render-previews on the tenant's monthly quota (deliverability_entitlements).
	deliverabilityQuota := deliverabilityQuotaAdapter{repo: &deliverability_control.Repo{Pool: pool}}
	inboxRealityRuntime, honeypotMinter, err := initializeInboxRealityRuntime(outboxCtx, cfg, pool, warehouseObjectStore, deliverabilityQuota, logger)
	if err != nil {
		return err
	}

	emailPreviewDeps := &emailpreview.Deps{
		Logger: logger,
		// A31: plain-HTML previews render through the engine's
		// /api/templates/preview (the campaign-send template pipeline).
		// NewEngineRenderer returns nil for an empty URL, in which case
		// the handler labels previews "fallback" instead.
		Engine: emailpreview.NewTenantEngineRenderer(listmonkClient.Destination),
		Quota:  deliverabilityQuota,
	}

	authPepper, authRepo, err := initializeAuthRepo(cfg, logger, pool, outboxRepo, janitorCtx)
	if err != nil {
		return err
	}
	// Mailer: SES in production (POSTWAVE_MAILER=ses), dev-spool otherwise.
	var authMailer mailer.Mailer
	switch os.Getenv("POSTWAVE_MAILER") {
	case "ses":
		// SES production access is granted per REGION, not per account, and it
		// need not be the region the task runs in. AWS_SES_REGION (the value the
		// ECS task definition and the readiness report key off) wins; AWS_REGION
		// is only the fallback for deployments that send from their own region.
		sesRegion := strings.TrimSpace(os.Getenv("AWS_SES_REGION"))
		if sesRegion == "" {
			sesRegion = strings.TrimSpace(os.Getenv("AWS_REGION"))
		}
		sesMailer, mErr := mailer.NewSESMailer(context.Background(),
			sesRegion,
			os.Getenv("POSTWAVE_SES_CONFIGURATION_SET"))
		if mErr != nil {
			logger.Error("init ses mailer", "err", mErr)
			return fmt.Errorf("init ses mailer: %w", mErr)
		}
		authMailer = sesMailer
	default:
		devMailer, mErr := mailer.NewDevMailer(logger, os.Getenv("POSTWAVE_DEV_MAIL_SPOOL"))
		if mErr != nil {
			logger.Error("init dev mailer", "err", mErr)
			return fmt.Errorf("init dev mailer: %w", mErr)
		}
		authMailer = devMailer
	}
	campaignBoundSend, campaignBoundSendErr := initializeCampaignBoundSendRuntime(
		outboxCtx,
		campaignAssuranceGateConvergence.blocksDispatch(),
		pool,
		warehouseObjectStore,
		authMailer,
		campaignAssuranceGateConvergence.Rollout,
		campaignPollLinkMinter,
		campaignHoneypotMinter(honeypotMinter, cfg.EngagementHoneypotBaseURL, logger),
	)
	if campaignBoundSendErr != nil {
		return campaignBoundSendErr
	}
	sendGuard.AssuranceBound = campaignBoundSend.Dispatcher
	sendGuard.RequireAssuranceBinding = campaignAssuranceGateConvergence.blocksDispatch()
	if campaignBoundSend.enabled() {
		logger.Info("campaign assurance-bound raw send runtime enabled",
			"transport", campaignBoundSend.Transport,
			"lease_owner", campaignBoundSend.LeaseOwner,
			"provider_idempotency", false,
			"dedicated_messenger", false)
	} else {
		logger.Info("campaign assurance-bound raw send runtime disabled",
			"enable_env", "POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_SEND_GATE")
	}
	authFromAddress, authDeps := buildAuthDeps(buildAuthDepsDeps{
		cfg:            cfg,
		logger:         logger,
		authRepo:       authRepo,
		authMailer:     authMailer,
		authPepper:     authPepper,
		envCipher:      envCipher,
		tracker:        tracker,
		pool:           pool,
		apiKeyResolver: apiKeyResolver,
		notifyFanout:   notifyFanout,
		mobilePushDeps: mobilePushDeps,
	})
	wireFormsConfirmations(formsDeps, registerCoreOutboxHandlersOut.formsConfirmation, authMailer, cfg, pool, subscriberDeps.Repo, logger)
	accountDeletionRepo := &accountdeletion.Repo{Pool: pool}
	accountDeletionDeps := &accountdeletion.Deps{
		Store: accountDeletionRepo,
		Reauth: &accountdeletion.SessionReauth{
			Repo:      authRepo,
			Cipher:    envCipher,
			Freshness: 5 * time.Minute,
		},
		Logger:            logger,
		ExecutionDelay:    time.Hour,
		CertificateRetain: 6 * 365 * 24 * time.Hour,
	}
	authResolver := newAuthResolver(authRepo, pool)
	// Public auth routes. Signup/login/verify-email are unauthenticated
	// (they're how you GET a session). Logout is idempotent — calling
	// without a session just clears the cookie + returns 204.
	//
	// All write-side auth endpoints (login, signup, magic-link start,
	// password-reset start) sit behind authBruteforceLimiter — per-
	// IP rate limit + temporary lockout that protects against
	// credential-stuffing rotating-username attacks. The existing
	// per-USER lockout (users.failed_attempts) is independent and
	// still applies for targeted attacks.
	authBruteforceLimiter := middleware.NewAuthBruteforceLimiterWithOptions(middleware.AuthBruteforceOptions{
		TrustForwardedIPHeaders: cfg.TrustForwardedIPHeaders,
		Store:                   distributedRateLimitStore,
		Namespace:               "auth",
	})
	authDeps.ClientIP = func(r *http.Request) string {
		return middleware.ResolveClientIPString(r, cfg.TrustForwardedIPHeaders)
	}
	// Clear only the in-process IP fallback after success. Production's shared
	// Redis windows continue to count every auth request, including successful
	// ones, and retain the independent account/user budgets.
	authDeps.OnLoginSuccess = authBruteforceLimiter.RecordSuccess
	apiserver.MountPublicAuthRoutes(apiserver.Deps{
		Router:                   r,
		Auth:                     authDeps,
		AuthBruteforceMiddleware: authBruteforceLimiter.Middleware,
	})
	// OAuth (Google only for this release). Microsoft is intentionally disabled
	// until a validated ID-token issuer/audience/signature/nonce contract exists.
	// Skipped silently when the Google env vars aren't set.
	oauthCfg := auth.LoadOAuthConfig()
	if len(oauthCfg) > 0 {
		oauthDeps := &auth.OAuthDeps{
			Deps:        authDeps,
			OAuthConfig: oauthCfg,
			StateRepo:   &auth.OAuthStateRepo{Pool: pool},
		}
		apiserver.MountOAuthRoutes(apiserver.Deps{Router: r, OAuth: oauthDeps, AuthBruteforceMiddleware: authBruteforceLimiter.Middleware})
	} else {
		logger.Info("OAuth disabled: no POSTWAVE_OAUTH_*_CLIENT_ID set")
	}

	sessionResolverFn := newSessionResolverFn(authResolver)
	// The approval confirmation GET stays in the rate-limited public group,
	// while its POST resolves the normal browser cookie and requires that
	// session to match the recipient bound into the signed link. The public
	// router has no tenant middleware, so this explicit seam is authoritative.
	approvalsDeps.PublicSessionResolver = sessionResolverFn

	// ----- ops console: platform-operator board -----
	//
	// OPS_DATABASE_URL connects as postwave_ops: INSERT/UPDATE on the ops
	// tables, EXECUTE on the SECURITY DEFINER aggregate functions, and no
	// access to any base table. The app's own pool cannot read the fleet, and
	// this pool cannot read a subscriber. That separation is the boundary —
	// "aggregates, not rows" enforced by GRANT, not by good intentions.
	opsDSN := strings.TrimSpace(os.Getenv("OPS_DATABASE_URL"))
	if opsDSN == "" {
		if isProductionEnv() {
			// Refuse to boot rather than skip the mount: a feature that
			// silently disables itself on a missing env var is the single
			// most common failure shape in the 2026-07 audit; the ops
			// console must not be the next one.
			logger.Error("OPS_DATABASE_URL is unset; the ops console would be silently disabled")
			return errors.New("OPS_DATABASE_URL is required in production")
		}
		logger.Warn("OPS_DATABASE_URL unset — ops console disabled (dev only)")
	} else {
		opsDBCtx, opsDBCancel := context.WithTimeout(context.Background(), 10*time.Second)
		opsPool, err := db.New(opsDBCtx, opsDSN)
		opsDBCancel()
		if err != nil {
			logger.Error("could not open the ops pool", "err", err)
			return fmt.Errorf("open ops database pool: %w", err)
		}
		defer opsPool.Close()

		// The ops-console session resolver: project the existing cookie-
		// session machinery down to the two facts the operator gate needs —
		// who is this, and was TOTP satisfied for THIS session
		// (auth_sessions.mfa_satisfied, flipped by /api/v1/auth/totp/verify).
		//
		// POSTWAVE_DEV_OPS_OPERATOR_EMAIL is a dev-only shortcut past the
		// session+TOTP resolution (the IP allowlist still applies). The
		// production boot gate above refuses to start with it set.
		opsSessionResolver := newOpsSessionResolver(authResolver)
		opsStore, opsEnv := buildOpsStoreAndEnv(opsPool)
		opsAuditSink := newOpsAuditSink(opsPool)
		opsExecutor := &ops.ActionExecutor{Pool: opsPool, Audit: opsAuditSink, Logger: logger}

		// Ops data views — read-only, cross-tenant, sharing the board's
		// operator gate. The Reader holds the platform-scoped ops pool (no
		// per-tenant RLS), the same way the check probes read cross-tenant.
		opsViews := &views.Reader{Pool: opsPool}
		assuranceSLOCollector, err := views.NewCampaignAssuranceSLOCollector(opsPool)
		if err != nil {
			return fmt.Errorf("initialize Campaign Assurance SLO metrics: %w", err)
		}
		if err := prometheus.Register(assuranceSLOCollector); err != nil {
			return fmt.Errorf("register Campaign Assurance SLO metrics: %w", err)
		}
		defer prometheus.Unregister(assuranceSLOCollector)

		mountOpsRoutes(
			r,
			pool,
			opsPool,
			opsSessionResolver,
			opsStore,
			opsAuditSink,
			opsExecutor,
			opsViews,
			readinessDeps.Production,
			distributedRateLimitStore,
			cfg.TrustForwardedIPHeaders,
		)

		// ----- push & digest: the alerting layer on top of the board -----
		//
		// Channels come from env. Zero channels never stops the boot — the
		// board still works read-only — but in production it is loud: an
		// error here at startup plus a red ops.push-canary row, because an
		// alert pipeline with nowhere to deliver is otherwise
		// indistinguishable from a healthy-quiet one.
		if err := startOpsConsoleWorkers(startOpsConsoleWorkersDeps{
			logger:       logger,
			authMailer:   authMailer,
			opsPool:      opsPool,
			opsFleet:     opsFleet,
			opsStore:     opsStore,
			cfg:          cfg,
			opsEnv:       opsEnv,
			outboxWorker: outboxWorker,
			outboxCtx:    outboxCtx,
		}); err != nil {
			return err
		}
	}
	// ----- end ops console -----

	assetBucket := strings.TrimSpace(os.Getenv("POSTWAVE_ASSETS_BUCKET"))
	var assetStorage assets.Storage
	if assetBucket != "" {
		if objectS3Client == nil || awsCfg.Region == "" {
			return fmt.Errorf("POSTWAVE_ASSETS_BUCKET requires AWS_REGION and an initialized AWS S3 client")
		}
		if s3KMSKeyID == "" {
			return fmt.Errorf("POSTWAVE_S3_KMS_KEY_ID is required when POSTWAVE_ASSETS_BUCKET is set")
		}
		publicBase := strings.TrimSpace(os.Getenv("POSTWAVE_ASSETS_PUBLIC_BASE_URL"))
		s3Assets, storageErr := assets.NewS3Storage(objectS3Client, assetBucket, s3KMSKeyID, publicBase)
		if storageErr != nil {
			return storageErr
		}
		assetStorage = s3Assets
		logger.Info("aws: S3 asset store active", "bucket", assetBucket, "public_base", publicBase, "sse_kms", true)
	} else {
		selectedStorage, selectErr := assets.SelectStorage()
		if selectErr != nil {
			return selectErr
		}
		assetStorage = selectedStorage
	}

	// Tenant exports contain the workspace's complete portable dataset and must
	// not share the public asset/CDN delivery path. Production therefore
	// requires a separate private bucket; development uses a mode-0600 local
	// tree. Downloads are streamed only through the authenticated export route.
	var exportStorage exports.Storage
	exportsEnabled := os.Getenv("POSTWAVE_DISABLE_EXPORTS") != "1"
	if exportsEnabled {
		exportBucket := strings.TrimSpace(os.Getenv("POSTWAVE_EXPORTS_BUCKET"))
		if exportBucket != "" {
			if objectS3Client == nil || awsCfg.Region == "" {
				return fmt.Errorf("POSTWAVE_EXPORTS_BUCKET requires AWS_REGION and an initialized AWS S3 client")
			}
			if s3KMSKeyID == "" {
				return fmt.Errorf("POSTWAVE_S3_KMS_KEY_ID is required when POSTWAVE_EXPORTS_BUCKET is set")
			}
			privateExports, storageErr := exports.NewS3Storage(objectS3Client, exportBucket, s3KMSKeyID)
			if storageErr != nil {
				return storageErr
			}
			exportStorage = privateExports
			logger.Info("aws: private S3 tenant-export store active", "bucket", exportBucket, "sse_kms", true)
		} else if isProductionEnv() {
			return fmt.Errorf("POSTWAVE_EXPORTS_BUCKET is required in production unless POSTWAVE_DISABLE_EXPORTS=1")
		} else {
			dataRoot := strings.TrimSpace(os.Getenv("POSTWAVE_DATA_DIR"))
			if dataRoot == "" {
				dataRoot = "./data"
			}
			privateExports, storageErr := exports.NewLocalStorage(filepath.Join(dataRoot, "private-exports"))
			if storageErr != nil {
				return storageErr
			}
			exportStorage = privateExports
		}
	}
	// Late-bind the private export purger onto the shared retention sweeper so
	// expiry deletes the object before unlinking its database row. The legacy
	// asset store remains delete-only here so pre-migration public/CDN exports
	// can be revoked; no new worker writes through it.
	sharedRetentionSweeper.ExportStore = exportStorage
	sharedRetentionSweeper.LegacyExportStore = assetStorage

	expensiveTenantLimit, veryExpensiveTenantLimit, webhookPlaygroundTenantLimit, webhookPlaygroundAPIKeyLimit, webhookPlaygroundConcurrency := buildTenantAndPlaygroundLimits(distributedRateLimitStore)
	// The authenticated OpenAPI document is a multi-megabyte, deliberately
	// no-store response. Cookie sessions share a tenant bucket. Every verified API
	// key also receives a route-local per-key fallback cap because configured
	// global key limits are optional; the existing keyRateLimit remains an
	// additional, possibly stricter outer boundary.
	apiDocsSessionLimit := middleware.NewTenantRateLimitWithOptions(apidocs.SessionRateLimitPerMinute, time.Minute, middleware.TenantRateLimitOptions{
		Store:     distributedRateLimitStore,
		Namespace: "tenant:api-docs-session",
	})
	apiDocsAPIKeyLimit := middleware.NewKeyRateLimitWithOptions(
		func(context.Context, string) (perMin, perDay, burst int, err error) {
			return apidocs.APIKeyRateLimitPerMinute, 0, 0, nil
		},
		middleware.KeyRateLimitOptions{
			Store:     distributedRateLimitStore,
			Namespace: "api-docs:key",
		},
	)

	// Per-call observability for API-key traffic. Declared at outer
	// scope so the graceful-shutdown path can Close() the recorder to
	// drain the bounded buffer before pool.Close fires. The recorder
	// replaces the pre-2026 per-request goroutine fan-out — a slow
	// Postgres no longer pins one goroutine + one connection per
	// inbound request (p4e-recorder-middleware-bounded).
	apiKeyCallsRepoOuter := &apikeycalls.Repo{Pool: pool}
	apiKeyCallsRecorderOuter := apikeycalls.NewRecorder(apiKeyCallsRepoOuter, logger)
	commercialUsageMeter := &sharedusage.Meter{Pool: pool}
	inboundWebhookRepo := &inbound_webhooks.Repo{Pool: pool, Cipher: envCipher, LegacyKEK: cfg.SendingKEK}
	inboundWebhookExecutor := &inbound_webhooks.ProductActionExecutor{
		Pool:                 pool,
		AutomationServiceURL: cfg.AutomationServiceURL,
		InternalAPIToken:     cfg.InternalAPIToken,
	}
	inboundWebhookDeps := &inbound_webhooks.Deps{
		Repo:                       inboundWebhookRepo,
		AutomationServiceURL:       cfg.AutomationServiceURL,
		InternalAPIToken:           cfg.InternalAPIToken,
		Executor:                   inboundWebhookExecutor,
		SafeLogger:                 logger,
		AllowLegacySignatureV1:     cfg.AllowLegacyInboundWebhookSignatureV1,
		LegacySignatureV1ExpiresAt: cfg.LegacyInboundWebhookSignatureV1ExpiresAt,
		EndpointRateLimitStore:     distributedRateLimitStore,
		EndpointRateLimit:          600,
		EndpointRateWindow:         time.Minute,
		Logger: func(match inbound_webhooks.Match) {
			logger.Info("inbound webhook trigger evaluated",
				"trigger_id", match.TriggerID,
				"action", match.ActionType,
				"executed", match.Executed,
				"error", match.Error)
		},
	}
	apiworkers.StartInboundWebhookSecretMaintenanceWorker(
		outboxCtx,
		inboundWebhookRepo,
		logger,
	)
	apiworkers.StartInboundWebhookActionWorker(outboxCtx, apiworkers.InboundWebhookActionWorkerDeps{
		Repo:                 inboundWebhookRepo,
		Executor:             inboundWebhookExecutor,
		AutomationServiceURL: cfg.AutomationServiceURL,
		InternalAPIToken:     cfg.InternalAPIToken,
		HTTPClient:           inboundWebhookDeps.HTTPClient,
		Logger:               logger,
		MatchLogger:          inboundWebhookDeps.Logger,
	})

	adminIPGate := middleware.AdminIPAllowlistWithOptions(admin_ip.LookupForTenant(pool), middleware.AdminIPAllowlistOptions{
		TrustForwardedIPHeaders: cfg.TrustForwardedIPHeaders,
		Applies: func(ctx context.Context) bool {
			if middleware.IsAPIKeyAuth(ctx) {
				return apikeys.HasScope(ctx, apikeys.ScopeAdmin)
			}
			u, ok := middleware.UserFromContext(ctx)
			if !ok {
				return false
			}
			role := strings.ToLower(strings.TrimSpace(u.EffectiveRoleOrDurable()))
			return role == "owner" || role == "admin"
		},
	})
	apiKeyAuthentication, tenantAuthentication, keyRateLimit := buildAuthenticationMiddlewares(buildAuthenticationMiddlewaresDeps{
		pool:                           pool,
		apiKeyAuthCache:                apiKeyAuthCache,
		streamTokenSecret:              streamTokenSecret,
		cfg:                            cfg,
		marketplaceOAuthBearerResolver: marketplaceOAuthBearerResolver,
		sessionResolverFn:              sessionResolverFn,
		apiKeyResolver:                 apiKeyResolver,
		distributedRateLimitStore:      distributedRateLimitStore,
	})
	authenticatedRoutes := authenticatedRouteStack{
		authenticateAPIKey: apiKeyAuthentication,
		meterAPIKey:        keyRateLimit.Middleware,
		resolveTenant:      tenantAuthentication,
		recordAPIKeyCalls: []routeMiddleware{
			// Legacy quota middleware remains mounted but structurally
			// observation-only. Caller-selected labels + asynchronous rows
			// are not an enforceable cost or availability boundary.
			apikeycalls.QuotaMiddleware(apiKeyCallsRepoOuter),
			apikeycalls.RecorderMiddleware(apiKeyCallsRecorderOuter),
		},
		stampContextEpoch: middleware.ContextEpochMiddleware(func(r *http.Request) []string {
			// Injected: the scopes live in internal/apikeys, which imports
			// middleware, so reading them there directly would be a cycle.
			scopes := apikeys.ScopesFromContext(r.Context())
			out := make([]string, 0, len(scopes))
			for _, sc := range scopes {
				out = append(out, string(sc))
			}
			return out
		}),
		authorizeRoute:      routeauth.Middleware,
		applyImpersonation:  impersonate.Middleware(pool),
		enforceAdminIP:      adminIPGate,
		resolveAuditScopes:  auditRBACSessionScopes(pool),
		requireMFA:          middleware.RequireMFAIfPolicy(pool),
		enforceTenantRegion: regions.EnforceRegion(regionLookup),
		// Last in the shared security stack: every identity, policy, MFA, IP,
		// and region control must pass before paid API allowance is consumed.
		meterCommercialUsage: usagegate.APIOperationMiddleware(commercialUsageMeter),
	}
	var partitionRotator *partition_rotator.Worker
	mountAuthenticatedRoutesBehindAgentHold(r, func(r chi.Router) {
		// The OpenAPI document exposes the build-wide route surface. Stamp its
		// private boundary before credential parsing, per-key metering, tenant
		// resolution, and route authorization so early 401/403/429 responses cannot
		// acquire weaker cache metadata than the successful artifact response.
		r.Use(apidocs.ProtectResponses)
		// Short-lived URL credentials and API-key self-introspection sit outside
		// /mcp but are equally non-cacheable. Protect before authentication so
		// malformed/missing-auth responses cannot acquire shared cache metadata.
		r.Use(apikeys.ProtectCredentialResponses)
		// MCP telemetry, native preview responses, and every auth refusal are
		// credential-sensitive. Apply before authentication so early 401/403
		// paths receive the same private no-store boundary as successful reads.
		r.Use(apikeycalls.ProtectMCPResponses)
		// Privacy-incident payloads and refusals are sensitive even when API-key
		// parsing or tenant resolution returns before route-local middleware.
		// This path-conditional guard must remain the outermost middleware in the
		// authenticated group; the incident mount repeats it inside admin/replay
		// as defense in depth for standalone composition.
		r.Use(privacy.ProtectIncidentResponses)
		// Route42 suppression and policy registries expose recipient and private
		// business-policy data. Protect the whole path families before API-key
		// parsing, tenant resolution, and authorization so early refusals carry
		// the same non-cacheable response boundary as successful handlers.
		r.Use(sms.ProtectRoute42Responses)
		// Route43 authority rows and refusals are private. Apply the
		// path-conditional boundary before credential parsing, tenant resolution,
		// client-version, idempotency, body limits, and exact-admin authorization.
		r.Use(pushsuppressions.ProtectRoute43Responses)
		// Webhook simulator receipts contain submitted payloads, receiver output,
		// and a request-bound signature. Protect successes, replays, and every
		// early auth/rate/body refusal before credential parsing can return.
		r.Use(outbound_webhooks.ProtectPlaygroundResponses)
		// Consent evidence and recipient tracking preferences are equally
		// sensitive. Stamp their cache boundary before API-key parsing, tenant
		// resolution, or authorization can return an early refusal; the consent
		// mount repeats the guard immediately outside each route-local scope gate.
		r.Use(consent.ProtectSensitiveResponses)
		// Authenticated group 1/2: reads and non-idempotent mutations.
		authenticatedRoutes.apply(r)
		// Admit live simulator fires to their authenticated tenant/key budget
		// before step-up or idempotency reads and hashes the request body. The
		// handler owns a context-marked fallback for standalone composition and
		// keeps its local concurrency gate immediately around execution.
		r.Use(outbound_webhooks.PlaygroundRateGovernor(
			webhookPlaygroundTenantLimit.Middleware,
			webhookPlaygroundAPIKeyLimit.Middleware,
		))
		// Retention uses the same bounded recorder the stack mounts above.
		apiKeyCallsRepo := apiKeyCallsRepoOuter
		// Retention sweeper — trims api_key_calls rows older than the
		// configured retention (default 90d, override with
		// POSTWAVE_API_KEY_CALLS_RETENTION_DAYS). Setting the env to "0"
		// disables GC entirely; NewSweeperFromEnv returns nil and we
		// skip the goroutine launch. Ticks hourly + once at startup.
		if apiKeyCallsSweeper := apikeycalls.NewSweeperFromEnv(apiKeyCallsRepo); apiKeyCallsSweeper != nil {
			safego.Go(logger, "apikeycalls-retention-sweeper", func() {
				apiKeyCallsSweeper.Run(outboxCtx)
			})
		}
		// Step-up re-authentication on the sensitive routes.
		//
		// BEFORE idempotency.Process on purpose: that middleware caches 4xx
		// responses against the Idempotency-Key, so a challenge issued after it
		// would be replayed to the client even once the user had proven
		// themselves — the retry would return the stale 401 instead of doing the
		// work.
		//
		// The enrolment checker is what makes mounting safe. `mfa_satisfied` is
		// written true only by TOTP verification, so an un-enrolled user has it
		// false permanently and an unexempted gate would 401 them out of these
		// routes forever. The checker reads the confirmed-factor state, and the
		// middleware waives the requirement for anybody who has none — strictly
		// stronger than the previous state, which was unmounted and therefore
		// asked nobody.
		r.Use(stepup.Middleware(func(ctx context.Context, userID string) (bool, error) {
			_, confirmed, err := authRepo.TOTPSecretState(ctx, userID)
			return confirmed, err
		}))
		// Generalized Idempotency-Key dedup. Mounted on the entire
		// authenticated mutation surface so every write inherits the
		// 24h Redis-backed replay contract (Stripe parity). No-op for
		// requests without the Idempotency-Key header, so GETs and any
		// caller that doesn't opt in pays zero overhead. The dedicated
		// idempotency-protected group below stays intact for routes
		// that live in their own scope-gated sibling group.
		r.Use(idempotency.ProcessWithReplayBypassAndHandlerOwnedReplayAndBodyLimit(
			idempotencyRepo,
			resolveTenantID,
			func(req *http.Request, body []byte) bool {
				return conversions.BypassIngestSecretIssueGlobalReplay(req, body) ||
					agency.MutationGlobalReplayBypass(req, body) ||
					deliverability_hub.RepairOverrideGlobalReplayBypass(req, body) ||
					sendingsettings.MutationGlobalReplayBypass(req, body) ||
					privacy.BypassIncidentGlobalReplay(req, body) ||
					sms.SuppressionExactQueryReplayBypass(req, body) ||
					service_suite.MutationReplayBypass(req, body) ||
					support_integrations.EffectReplayBypass(req, body)
			},
			func(req *http.Request, body []byte) bool {
				return service_suite.HandlerOwnedInternalNoteReplay(req, body) ||
					outbound_webhooks.HandlerOwnedPlaygroundFireReplay(req, body)
			},
			func(req *http.Request) int64 {
				if limit := outbound_webhooks.PlaygroundReplayBodyLimit(req); limit > 0 {
					return limit
				}
				if limit := campaigns.FactContractReplayBodyLimit(req); limit > 0 {
					return limit
				}
				if limit := coderedemption.ReplayBodyLimit(req); limit > 0 {
					return limit
				}
				return service_suite.InternalNoteReplayBodyLimit(req)
			},
			resolveIdempotencyReplayScope,
		))
		r.Use(middleware.AuditMiddleware(pool))
		// Cost header + dollar-budget tally. Must run AFTER tenant
		// resolution so the running-total cell can be attributed.
		r.Use(middleware.CostHeaderMiddleware(
			cost.WithRunningTotal,
			cost.RunningTotalCents,
			budgetIncrementer,
		))
		// Send-budget gate. Inspects the route, calls Check on routes that
		// consume a send budget, and returns 429 when the configured cap is
		// exhausted. This is an API-key safety budget, not billable overage.
		r.Use(budgets.Middleware(budgetRepo))
		// Conditional GET: buffer GET/HEAD responses, synthesise a weak
		// ETag when the handler didn't set one, and rewrite to 304 when
		// If-None-Match matches. Mounted INSIDE the auth/tenant group
		// so per-tenant payloads hash to per-tenant ETags — leaking a
		// shared tag across tenants would let one tenant short-circuit
		// another tenant's request. Handlers that already emit ETag
		// (newsletter_feed, podcast) are honoured as-is.
		r.Use(httpcache.Conditional())
		// Baseline Cache-Control + Vary for every authenticated read.
		// AuthRead makes every reuse revalidate (Conditional answers 304
		// when unchanged), so a read right after the reader's own write
		// sees it, and errors are never stored. Its `Vary: Authorization,
		// Cookie, Accept-Encoding` is the cross-tenant cache-leak guard the
		// strategy doc calls out: without it a CDN fronting the API could
		// hand tenant A's payload to tenant B. HeavyRead (dashboard and
		// analytics routes) grants no longer freshness; see AuthRead's doc.
		r.Use(httpcache.WithPolicy(httpcache.AuthRead()))

		// Per-run node attempts — the read half of the run inspector. Mounted
		// here rather than in flowbuilder because that package is behind
		// `flowRuntimeQualified = false`, and reading what a run already did is
		// not execution: an inspector should be available exactly while the
		// runtime it inspects is being qualified.
		//
		// Registered AFTER every r.Use above, not before them. `r` is a chi
		// inline mux, and MountRoutes composes with r.With(...), which FREEZES
		// the parent middleware list at call time. Mounted earlier the route
		// silently missed step-up, idempotency, audit, cost, budgets and — the
		// one that matters most — the AuthRead cache policy, so its 200 carried
		// no Cache-Control and no `Vary: Authorization, Cookie`, which is
		// exactly the cross-tenant CDN leak the policy exists to prevent.
		(&flowsteps.Deps{
			Repo:   &flowsteps.Repo{Pool: pool},
			Logger: logger,
		}).MountRoutes(r)

		r.Get("/api/v1/me", h.Me)
		// Auth (session-bearing): the typed /auth/me + send-verification
		// resend. The legacy /me above stays for backward compat with
		// the SDK; new web code calls /auth/me.
		apiserver.MountAuthenticatedAuthMeRoute(apiserver.Deps{Router: r, Auth: authDeps})
		// Self-service account deletion is session-only and acts exclusively on
		// the authenticated user. It is deliberately separate from the
		// owner/admin workspace-deletion review flow.
		r.Group(func(ar chi.Router) {
			ar.Use(apikeys.RequireAuthMethod(apikeys.AuthMethodSession))
			ar.Get("/api/v1/account/deletion", accountDeletionDeps.Status)
			ar.With(authBruteforceLimiter.Middleware).Delete("/api/v1/account", accountDeletionDeps.DeleteSelf)
		})
		// Notice and action for hosted and displayed content (DSA Art. 16/17,
		// Apple Guideline 1.2, Google Play UGC + generative-AI policies). The
		// in-app report control is open to any signed-in principal — the person
		// looking at the content is the one who can see it is wrong — while the
		// queue and the statement of reasons are admin-scoped.
		contentreports.MountAuthenticatedRoutes(r, &contentreports.Deps{
			Repo:   &contentreports.Repo{Pool: pool, Logger: logger},
			Logger: logger,
		})
		apiserver.MountAuthenticatedAuthRoutes(apiserver.Deps{
			Router:                   r,
			Auth:                     authDeps,
			AuthBruteforceMiddleware: authBruteforceLimiter.Middleware,
		})
		apiserver.MountUserNotificationRoutes(apiserver.UserNotificationRouteDeps{
			Router: r, Logger: logger, NotificationRepo: notificationFeedRepo,
			WebPush: webpushDeps, MobilePush: mobilePushDeps,
		})
		// Cross-device "resume where you left off": the cursor (which entity)
		// and the draft checkpoint (what was typed into it). Phase 1 — Continuity.
		apiserver.MountContinuityRoutes(r, pool, logger)
		// One list of every long-running operation, across the twenty families
		// that each already have their own page.
		apiserver.MountOperationsRoutes(r, pool, logger)
		// Bounded agent authority (migration 1896). The grant surface is
		// session-only: an agent that could mint its own mandate is not bounded
		// by one.
		apiserver.MountAgentMandateRoutes(r, pool, logger)
		// The single-use action-link surface (migrations 1893-1895).
		//
		// Mounted WITH an executor. Mounting it without one would spend a
		// ticket and then report failure, which is louder than pretending it
		// worked but still a link that cannot do its job.
		//
		// `Decide` re-checks the approval's own state — pending, unexpired, not
		// self-approval — so the ticket proves WHO is acting and the service
		// still decides whether the action is allowed. A ticket is not a
		// permission.
		// Per-tenant admin IP allowlist. Operators opt in via
		// PUT /api/v1/admin/ip-allowlist; the middleware below
		// (wrapped onto specific admin routes via With) refuses
		// requests from non-allowlisted IPs. Empty list = pass.
		apiserver.MountAdminIPRoutes(apiserver.Deps{Router: r, Pool: pool})

		apiserver.MountSendingDiscoveryRoutes(apiserver.SendingDiscoveryRouteDeps{
			Router: r, Pool: pool, Logger: logger, Sending: sendingHandlers,
			EnableDirectProvision: directSendingProvisionRouteEnabled(),
			IntelligentRetry:      intelligentRetryQueue, TriggerDelay: triggerDelayRepo, Audit: auditHandlers,
		})

		apiserver.MountFormAdminRoutes(apiserver.FormAdminRouteDeps{
			Router: r, Pool: pool, Forms: formsDeps, PublicBaseURL: os.Getenv("POSTWAVE_PUBLIC_BASE_URL"), FormsPublicHost: cfg.FormsPublicHost,
		})

		// Saved subscriber segments + live-count preview.
		// SUB-064/SUB-027: when the Anthropic NLQ client is wired
		// (same env as audit-nlq), we re-use it as the AI fallback
		// for the natural-language segment compiler. The desktop
		// retries `compile-from-text?engine=ai` when the rules
		// compiler returns 422; without a configured key the AI
		// branch responds with 503 ai_unavailable.
		segmentsDeps := &segments.Deps{
			Repo:                &segments.Repo{Pool: pool},
			AICompileMiddleware: veryExpensiveTenantLimit.Middleware,
			Logger:              logger,
		}
		if auditHandlers.NLQLLM != nil {
			segmentsDeps.AIProvider = segmentsNLQAdapter{c: auditHandlers.NLQLLM}
		}
		apiserver.MountSegmentRoutes(apiserver.Deps{Router: r, Segments: segmentsDeps})

		apiserver.MountLookalikeAudienceRoutes(apiserver.Deps{Router: r, Pool: pool, Logger: logger})

		// Segment Decay Radar (feature #5) HTTP surface: decay-event
		// history, exit-set member diffing, dismiss, on-demand AI narrate,
		// and the definition-change journal. AIProvider mirrors
		// segmentsDeps.AIProvider so /narrate works only when AI is wired.
		decayStore := &segments.DecayRepo{Pool: pool}
		apiserver.MountSegmentDecayRoutes(apiserver.Deps{
			Router: r, Segments: segmentsDeps, SegmentDecayStore: decayStore, Logger: logger,
		})
		// Daily segment-size snapshots (migration 0392) backing
		// /segments/{id}/growth and /size-history. Hourly tick,
		// idempotent per UTC day. Opt-out via
		// POSTWAVE_DISABLE_SEGMENT_SNAPSHOTS=1.
		if os.Getenv("POSTWAVE_DISABLE_SEGMENT_SNAPSHOTS") != "1" {
			segmentSnapshotWorker := &segments.SnapshotWorker{
				Pool:   pool,
				Repo:   segmentsDeps.Repo,
				Logger: logger,
			}
			safego.Go(logger, "segment-snapshot-worker", func() {
				if err := segmentSnapshotWorker.Run(outboxCtx); err != nil && !errors.Is(err, context.Canceled) {
					logger.Warn("segment snapshot worker exited", "err", err.Error())
				}
			})
		}

		startAudienceSnapshotWorkers(startAudienceSnapshotWorkersDeps{
			pool:           pool,
			subscriberDeps: subscriberDeps,
			logger:         logger,
			outboxCtx:      outboxCtx,
		})

		// Subject-line / content optimizer trainer (combinatorial bandit,
		// migration 0346): per tick recomputes each running run's Beta
		// posteriors + Thompson-resamples traffic. Opt-out via
		// POSTWAVE_DISABLE_STO_TRAINER=1.
		if os.Getenv("POSTWAVE_DISABLE_STO_TRAINER") != "1" {
			stoContentWorker := &sto_content_optimizer.Worker{
				Repo: &sto_content_optimizer.Repo{Pool: pool}, Pool: pool, Interval: 5 * time.Minute,
			}
			safego.Go(logger, "sto-content-optimizer-trainer", func() {
				if err := stoContentWorker.Run(outboxCtx); err != nil && !errors.Is(err, context.Canceled) {
					logger.Warn("sto content optimizer trainer exited", "err", err.Error())
				}
			})
		}

		// Segment Decay Radar (feature #5): detects membership anomalies
		// after each snapshot cycle, emits segment.decay audit rows (feeds
		// the audit_alerts pipeline), and sends gated direct email.
		// Opt-out via POSTWAVE_DISABLE_SEGMENT_DECAY=1. Thresholds via
		// POSTWAVE_DECAY_CLIFF_PCT / POSTWAVE_DECAY_CLIFF_ABS (D2).
		if os.Getenv("POSTWAVE_DISABLE_SEGMENT_DECAY") != "1" {
			decayWorker := &segments.DecayWorker{
				Pool:       pool,
				Store:      decayStore,
				Repo:       segmentsDeps.Repo,
				Logger:     logger,
				Dispatcher: &notifications.PgDispatcher{Pool: pool, Logger: logger},
				Mailer:     authMailer, FromAddress: configuredPlatformSender(),
			}
			if v := os.Getenv("POSTWAVE_DECAY_CLIFF_PCT"); v != "" {
				if f, err := strconv.ParseFloat(v, 64); err == nil {
					decayWorker.CliffPctThreshold = f
				}
			}
			if v := os.Getenv("POSTWAVE_DECAY_CLIFF_ABS"); v != "" {
				if n, err := strconv.Atoi(v); err == nil {
					decayWorker.CliffAbsThreshold = n
				}
			}
			safego.Go(logger, "segment-decay-worker", func() {
				if err := decayWorker.Run(outboxCtx); err != nil && !errors.Is(err, context.Canceled) {
					logger.Warn("segment decay worker exited", "err", err.Error())
				}
			})
		}
		// Mailchimp-parity merge-fields editor: per-tenant schema
		// catalog (FNAME, LNAME, BIRTHDAY …) plus per-subscriber
		// values. See apps/api/internal/merge_fields.
		apiserver.MountMergeFieldRoutes(apiserver.Deps{Router: r, Pool: pool})
		apiserver.MountSubscriberPersonalizationRoutes(apiserver.SubscriberPersonalizationRouteDeps{
			Router: r, Pool: pool, Logger: logger,
		})
		// Flow-builder graph contract: visual node/action catalog plus
		// pure validation before drafts are sent to the automation service.
		// Hoist tag history + subscriber-tag repo here so the flow
		// runtime's tag_add/tag_remove executor shares the same emitter
		// (Feature 3 history rows carry source='flow:<run_id>').
		flowBuilderRepo := &flowbuilder.Repo{Pool: pool}
		flowTagsHistory := &tags.History{
			Pool:         pool,
			Webhooks:     tagsWebhookAdapter{d: webhooksDispatcher},
			FlowTriggers: tagsFlowTriggerAdapter{repo: flowBuilderRepo},
		}
		privacyTagHistory = flowTagsHistory
		subscriberDeps.Repo.TagHistory = flowTagsHistory
		// SUB-008: dual-write per-field before/after attribute snapshots
		// into subscriber_attribute_history (migration 0425) on every
		// Upsert/Update, alongside the tag_history emit above.
		subscriberDeps.Repo.AttributeHistory = true
		// SUB-055: wire the IP→jurisdiction detector so Upsert detects a
		// jurisdiction drift from signup_ip and flips the re-confirmation
		// flag (migration 0538). The static detector ships built-in
		// demonstration ranges; a MaxMind-backed detector implementing the
		// same interface can be swapped in without touching the repo.
		subscriberDeps.Repo.Jurisdiction = geolocation.DriftAdapter{Detector: geolocation.NewStaticDetector()}
		// SUB-063: wire the demographic-inference predictor so Upsert infers
		// gender / age group / interests with confidence labels from the
		// subject's name and stamps the inferred_* computed traits. The static
		// predictor ships a small curated name table; a model-backed predictor
		// implementing the same interface can be swapped in without touching the
		// repo. The adapter maps demographics.Prediction → the package-local
		// subscribers.PredictedDemographics so subscribers stays import-free.
		subscriberDeps.Repo.Demographics = demographicsAdapter{predictor: demographics.NewStaticPredictor()}
		// SUB-072: PII gateway control plane (field-sensitivity config + the
		// ephemeral token reversal store, migrations 0560/0561). Backs
		// GET/PATCH /api/v1/settings/pii-config + POST /internal/pii-gateway/tokens.
		subscriberDeps.PIIGateway = &pii_gateway.Repo{Pool: pool}
		// SUB-071: build the detector/repository once for the durable database-
		// enforced coverage worker and the admin HTTP control plane below.
		piiScannerDeps := startPIICoverageWorker(pool, cfg, logger, eventsBus, outboxCtx)
		// Do not also wire the legacy post-commit repository hook: canonical writers
		// are already covered by the same transaction as the subscriber mutation,
		// and running both paths would duplicate detector work.
		flowSubscriberTagsRepo := &tags.SubscriberTagsRepo{Pool: pool, History: flowTagsHistory}
		flowbuilder.MountRoutes(r, &flowbuilder.Deps{
			Repo:        flowBuilderRepo,
			TagExecutor: flowSubscriberTagsRepo,
		})
		// In-flow A/B tests: CRUD + winner evaluation over automation_flow_ab_tests
		// (the automation engine records per-variant outcomes; migration 1631).
		(&flowabtests.Deps{Repo: &flowabtests.Repo{Pool: pool}, Logger: logger}).MountRoutes(r)
		// Manual-review approvals: list + approve/reject the per-node gates the
		// automation engine parks on (automation_message_approvals).
		(&flow_approvals.Deps{Repo: &flow_approvals.Repo{Pool: pool}, Logger: logger}).MountRoutes(r)
		omniRepo := &omnichannel.Repo{Pool: pool}
		omnichannelDeps := &omnichannel.Deps{
			Repo:   omniRepo,
			Logger: logger,
			// G-09: live email delivery. G-14/15/16: push/whatsapp/rcs adapters
			// now chain after email (inert until their provider creds land).
			Sender: newOmnichannelSender(authMailer, omniRepo,
				cmpOr(os.Getenv("POSTWAVE_DEFAULT_FROM_EMAIL"), "Moosewave <noreply@moosewave.com>"), pool),
		}
		omnichannel.MountRoutes(r, omnichannelDeps)
		// Keep authenticated execution routes mounted for compatibility, but their
		// handlers return a stable 503 until explicit-audience enforcement, durable
		// dispatch recovery, and live provider certification are complete. Reports
		// remain readable for existing history.
		omnichannelDeps.MountRuntimeRoutes(r)
		// Per-tenant sender readiness + Smart-Sending policy management (the
		// tables the dispatch gates read).
		omnichannelDeps.MountSettingsRoutes(r)
		// Onsite targeting and experiments remain available, but coupon-bearing
		// spin rewards have no inventory allocator while Discounts is contained.
		onsiteGrowthDeps := &onsite_growth.Deps{Repo: onsiteGrowthRepo}
		if discounts.CouponAllocationAvailable {
			onsiteGrowthDeps.CouponAssigner = onsiteCouponAssigner{Repo: discountsRepo}
		}
		onsite_growth.MountRoutes(r, onsiteGrowthDeps)
		apiserver.MountSubscriberReadRoutes(apiserver.Deps{Router: r, Subscribers: subscriberDeps})

		// Admin-only affiliate program: intentionally NOT mounted, gated with the
		// public affiliate offer until the commercial and legal release gate is
		// approved (commission, payout, tax, privacy, program terms). The gate is
		// recorded in route-reachability.json (forbidden_composition_calls:
		// affiliatesDeps.MountAdminRoutes). To remount once cleared, restore the
		// MountAdminRoutes call, drop that entry, and register its routes in the
		// gateway manifest in the same change (the route-authz validator refuses
		// boot otherwise). requireAdmin + tenant middleware wrap it when mounted.

		// Canonical campaign read surface.
		apiserver.MountCampaignReadRoutes(apiserver.Deps{Router: r, Campaigns: campaignDeps})
		if pollRuntimeConfiguration.Enabled {
			pollDeps := &polls.Deps{
				Repo: campaignPollRepo, Logger: logger, Classifier: campaignPollClassifier,
			}
			if mountErr := polls.MountAdminRoutes(polls.AdminRouters{
				ReadCampaigns:  r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)),
				WriteCampaigns: r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)),
				ReadReports:    r.With(apikeys.RequireScope(apikeys.ScopeReadReports)),
			}, pollDeps); mountErr != nil {
				logger.Error("campaign polls: refusing to mount authoring routes", "err", mountErr.Error())
			}
		}
		// Predicted Agent Comprehension reads inherit the same complete
		// authenticated tenant boundary. The default-off runtime keeps these
		// exact routes mounted but returns a stable fail-closed 503.
		campaignAssuranceRuntime.MountRead(r)
		analyticsRealtime := apiserver.MountAnalyticsRealtimeAndLandingRoutes(apiserver.AnalyticsRealtimeRouteDeps{
			Router: r, Pool: pool, Events: eventsBus, EventReplay: eventLogReplay, StreamTokenSecret: streamTokenSecret,
			HumanEngagementEnabled: os.Getenv("POSTWAVE_HUMAN_ENGAGEMENT") == "true",
		})
		analyticsRepo := analyticsRealtime.Repo

		// Campaign template library: platform-shared seeds + tenant-saved
		// templates a tenant can drop into a fresh campaign draft.
		campaignTemplateDesigns := &campaigntemplates.DesignDraftRepo{Pool: pool}
		campaignTemplatePreviews := &campaigntemplates.PreviewAssetRepo{Pool: pool}
		ctplDeps := &campaigntemplates.Deps{
			Repo:       &campaigntemplates.Repo{Pool: pool},
			ReviewPool: pool,
			Designs:    campaignTemplateDesigns,
			Previews:   campaignTemplatePreviews,
			Campaigns:  campaignDeps.Repo,
			Generator:  campaigntemplates.NewHTTPTemplateGenerator(cfg.VoiceServiceURL, cfg.InternalAPIToken),
			Logger:     logger,
		}
		apiserver.MountCampaignTemplateRoutes(apiserver.Deps{Router: r, CampaignTemplates: ctplDeps})
		startCampaignTemplateWorkers(startCampaignTemplateWorkersDeps{
			logger:                   logger,
			campaignTemplateDesigns:  campaignTemplateDesigns,
			ctplDeps:                 ctplDeps,
			outboxCtx:                outboxCtx,
			assetStorage:             assetStorage,
			campaignTemplatePreviews: campaignTemplatePreviews,
		})
		apiserver.MountConversionAdminRoutes(r, pool)
		apiserver.MountConversionSigningKeyRoutes(r, pool, envCipher)
		apiserver.MountCollaborationIntegrations(apiserver.CollaborationIntegrationDeps{
			Router: r, SlackRepo: slackRepo, SlackOAuth: slackOAuthDeps, DiscordRepo: discordRepo, TeamsRepo: teamsRepo,
		})
		// WinnerDeps.ReplyCounter is wired in the // ----- replies -----
		// block below; the *WinnerDeps pointer is captured here so the
		// later assignment is visible to handlers invoked at request
		// time. handlers.Evaluate reads d.WinnerDeps each call, so
		// late-binding is safe.
		// EditLease: the variants route writes DELIVERED A/B content, so it
		// belongs under the same single-writer rule as editing the campaign
		// body. Wired from the campaigns deps so "who is asking" has one
		// definition rather than one per package.
		abDeps := &abtests.Deps{Repo: abRepo, WinnerDeps: abWinnerDeps, EditLease: campaignDeps}
		apiserver.MountCampaignABTestRoutes(apiserver.Deps{Router: r, CampaignABTests: abDeps})
		compat.Mount(r, compatDeps)
		apiserver.MountAuthenticatedProviderIntegrationRoutes(r, providerIntegrationsSurface)
		analyticsIntegrationsSurface := apiserver.NewAnalyticsIntegrationsSurface(apiserver.AnalyticsIntegrationsDeps{
			Pool: pool, Logger: logger, SubscriberProfiles: subscriberDeps.Repo, Secrets: secretsResolver,
		})
		apiserver.MountAuthenticatedAnalyticsIntegrationRoutes(r, analyticsIntegrationsSurface)
		apiworkers.StartAnalyticsIntegrationBackfills(outboxCtx, logger, analyticsIntegrationsSurface)
		apiserver.MountPublicAnalyticsIntegrationRoutes(r, analyticsIntegrationsSurface)
		mailchimpv3.Mount(r, mailchimpV3Deps)
		privacyCursorSigningKey := append([]byte(nil), cfg.ConsentCursorSigningKey...)
		if len(privacyCursorSigningKey) == 0 && !isProductionEnv() {
			// Local-only continuity. Production startup rejects an absent or short
			// dedicated secret before privacy-sensitive cursor routes are reached.
			privacyCursorSigningKey = []byte("postwave-local-consent-cursor-signing-key-v1")
		}
		apiserver.MountMessagingEngagementRoutes(apiserver.MessagingEngagementRouteDeps{
			Router: r, Pool: pool, Logger: logger, SMS: smsDeps, SocialCapture: socialCaptureDeps,
			PushSuppressionCursorSigningKey: privacyCursorSigningKey,
		})

		/* ===== X1+X2+X3 admin route registrations =====
		 * 17 net-new internal packages cover audience (lists/tags/
		 * suppressions), sending (sendingsettings, plus campaign-side
		 * features wired via existing campaigns pkg), platform (assets/
		 * inbound_webhooks/track/inbound_email/dmarc), forms+web
		 * (email_template/custom_domains/link_checker/archive/referrals),
		 * and paid+automation (discounts/paid_tiers/send_time_opt). All
		 * use a Deps + MountRoutes(r) shape; public ingest paths are
		 * mounted in the public route group below.
		 */
		// One canonical outbound-webhook transport is shared by list-scoped
		// webhooks and the global outbound-webhooks surface. Development keeps
		// ordinary HTTP/localhost callbacks; every other environment enforces
		// HTTPS plus dial-time private/reserved-IP and redirect validation.
		requireOutboundWebhookHTTPS := strings.ToLower(os.Getenv("POSTWAVE_ENV")) != "dev" &&
			strings.ToLower(os.Getenv("POSTWAVE_ENV")) != "development"
		defaultOutboundTransport := http.DefaultTransport.(*http.Transport).Clone()
		outboundWebhookHTTPClient := &http.Client{
			Transport: outbound_webhooks.NewClientCertificateCapableTransport(
				defaultOutboundTransport,
				runtimeobs.HTTPTransport,
			),
			Timeout:       10 * time.Second,
			CheckRedirect: outbound_webhooks.RejectWebhookRedirects,
		}
		if requireOutboundWebhookHTTPS {
			outboundWebhookHTTPClient = outbound_webhooks.NewSecureHTTPClient(
				outbound_webhooks.NewClientCertificateCapableTransport(
					outbound_webhooks.NewSecureTransport(),
					runtimeobs.HTTPTransport,
				),
			)
		}
		outboundWebhooksStore := &outbound_webhooks.Store{
			Pool:         pool,
			Cipher:       envCipher,
			LegacyKEK:    cfg.SendingKEK,
			RequireHTTPS: requireOutboundWebhookHTTPS,
		}
		subscriberDeps.PlaygroundSubjectAccess = outboundWebhooksStore

		// Make the consent-sync ledger LIVE.
		//
		// `subscribers.ConsentSyncLedger` shipped complete — writer, retry sweep,
		// idempotency, migration 0563 — and is guarded at seven call sites by
		// `if ... ConsentSyncLedger != nil`. Nothing ever assigned it, so every
		// one of those guards was permanently false: a subscriber unsubscribed,
		// the local row updated, and nothing reached the destinations their data
		// had been pushed to. That is the question a data-protection officer asks
		// — "you were told to stop; who else holds this and were they told?" —
		// and the answer was a silent no with the code already written.
		//
		// Assigned here rather than at the repo literal because the webhook store
		// it needs is constructed in this block, well after subscriberDeps.
		consentSyncLedger := &subscribers.ConsentSyncLedger{
			Pool:         pool,
			Destinations: subscribers.ConsentSyncWebhookDestinations{},
			Deliverer:    consentSyncWebhookDeliverer{store: outboundWebhooksStore},
		}
		subscriberDeps.Repo.ConsentSyncLedger = consentSyncLedger
		// ...and something has to drain it. `RunRetrySweep` was as complete and
		// as callerless as the ledger itself, so the first delivery attempt was
		// the only one that ever happened: a destination briefly down kept the
		// consent change forever, in `retrying`, behind a `next_attempt_at` no
		// worker read. "We tried once and nobody looked again" is not a
		// materially better answer to a DPO than never having tried.
		safego.Go(logger, "consent-sync-sweeper", func() {
			(&subscribers.ConsentSyncSweeper{
				Pool:   pool,
				Ledger: consentSyncLedger,
				Logger: logger,
			}).Run(outboxCtx)
		})
		listsDeps := lists.New(cfg.ListmonkURL, cfg.ListmonkUser, cfg.ListmonkPassword)
		listsDeps.Destination = listmonkClient.Destination
		// Attach the local Repo: it holds the list identities (list_id_map)
		// every list route resolves through — the catalogue's postwave_uuid
		// and member counts, CountListAudience, the Members endpoint, and the
		// identity a list delete retires. Without it those routes fail closed.
		// The POST is mounted separately inside the idempotency-protected
		// group further below — see GAP-LS-134.
		listsDeps.Repo = &lists.Repo{
			Pool:               pool,
			OutboundWebhooks:   outboundWebhooksStore,
			MembershipWebhooks: listMembershipWebhooks,
		}
		listsDeps.Logger = logger
		listsDeps.WebhookHTTPClient = outboundWebhookHTTPClient
		listsDeps.RequireWebhookHTTPS = requireOutboundWebhookHTTPS
		apiserver.MountListRoutes(apiserver.Deps{Router: r, Lists: listsDeps})
		tagsHistory := flowTagsHistory
		tagsRepo := &tags.Repo{Pool: pool, History: tagsHistory}
		(&tags.Deps{
			Repo:               tagsRepo,
			SubscriberTagsRepo: flowSubscriberTagsRepo,
			GroupRepo:          &tags.GroupRepo{Pool: pool},
			Logger:             logger,
		}).MountRoutes(r)
		(&tags.HistoryDeps{History: tagsHistory, Logger: logger}).MountRoutes(r)
		suppressionsDeps := &suppressions.Deps{
			Repo:           &suppressions.Repo{Pool: pool},
			Logger:         logger,
			CanonicalStore: suppressionsStore,
			Audit:          &suppressions.AuditLogger{Pool: pool},
		}
		// The subscriber package is the sole owner of canonical
		// POST /api/v1/suppressions. This mount retains only the scoped legacy
		// bulk adapter, so route behavior cannot depend on registration order.
		suppressionsDeps.MountLegacyRoutes(r)
		// CSV bulk import + export for the suppression list. Every
		// customer brings/leaves with their bounce/complaint list.
		suppressionsDeps.MountImportExportRoutes(r)
		// IPs powers the read-only ip_pool projection on GET
		// /api/v1/settings/sending (desktop-audit gap A25): shared
		// platform pool unless dedicated_ip_assignments has active
		// rows for the tenant.
		(&sendingsettings.Deps{
			Repo:     &sendingsettings.Repo{Pool: pool},
			IPs:      &sending.DedicatedIPRepo{Pool: pool},
			CapCache: tieredSendRateLimiter,
			Logger:   logger,
		}).MountRoutes(r)

		// NB: campaign queue and SMS send/test-send routes are mounted in
		// the idempotent group further down — both insert real recipient
		// rows / dispatch real outbound traffic, so a retried POST without
		// idempotency would double-queue or double-send. Mounting here
		// would bypass the idempotency middleware.

		// Campaigns send-domain extensions: resend-to-non-openers,
		// pause/resume/cancel mid-flight, recurrence config. Reuses the
		// existing campaignDeps so the new endpoints share the same Repo
		// (which is a superset Repo with the new send-domain methods).
		apiserver.MountCampaignSendDomainRoutes(apiserver.Deps{Router: r, Campaigns: campaignDeps})

		// Subscribers extensions: merge/dedup, engagement score,
		// per-subscriber activity log, CSV export. Reuses subscriberDeps
		// so the new endpoints share the same Repo + Engine + Limits.
		apiserver.MountSubscriberMergeRoutes(apiserver.Deps{Router: r, Subscribers: subscriberDeps})
		// Engagement-score read surface over the stored
		// subscribers.engagement_score column (written by the
		// internal/scoring worker): per-subscriber score, decile
		// distribution, score-banded subscriber list. Routes are
		// read:subscribers-scoped inside the package's MountRoutes.
		subscriberscore.MountRoutes(r, &subscriberscore.HTTPDeps{Pool: pool, Logger: logger})
		// G-14: push device-token registration (POST /api/v1/push/devices).
		(&pushsend.Deps{Store: &pushsend.Repo{Pool: pool}, Logger: logger}).MountRoutes(r)

		// Complete subscriber drill-down, privacy, bulk, import, identity,
		// consent, and audience-refinement surface. Lifecycle and PII scanner
		// mounts deliberately remain adjacent below.
		apiserver.MountSubscriberProfileRoutes(apiserver.Deps{Router: r, Subscribers: subscriberDeps})
		// SUB-136: lifecycle transitions append a retryable automation intent in
		// the same transaction as the stage, audit row, and parent revision.
		lifecycle.MountRoutes(r, &lifecycle.Deps{
			Repo:   lifecycleRepo,
			Bus:    eventsBus,
			Logger: logger,
		})
		// SUB-071: shadow-PII discovery. Continuous regex+heuristic scan of
		// subscriber free-text fields flags undeclared PII for DPO review.
		// GET /api/v1/pii-findings (+ per-subscriber), PATCH to review/dismiss,
		// and GET/POST /api/v1/pii-scan-config to gate the scanner per tenant.
		// Reuses the same Deps wired into the subscriber write path above
		// (piiScannerDeps) so the HTTP surface and the auto-scan share one
		// detector + repo + event bus.
		pii_scanner.MountRoutes(r, piiScannerDeps)
		// SUB-124: audience growth report — daily lifecycle series
		// (subscriber_growth_history, migration 1000) read by
		// GET /api/v1/subscribers/growth, plus the manual snapshot trigger.
		apiserver.MountSubscriberGrowthRoutes(apiserver.Deps{Router: r, Subscribers: subscriberDeps})
		// ----- end subscriber-drilldown -----

		// X1+X2 analytics expansion: per-link click report, geography,
		// device, bounce categorization, cohorts, revenue attribution,
		// CSV export, side-by-side compare. Lives alongside main's
		// existing CampaignReport / SequenceFunnel / DashboardStats
		// handlers (separate Deps struct via NewExtended() to avoid
		// the name collision with the legacy Deps).
		//
		// Wrapped in a HeavyRead subgroup so /analytics/* GETs inherit
		// the 30s freshness + 5min SWR budget. Mutations inside the
		// group (if any) are no-ops under WithPolicy — the middleware
		// only stamps GET/HEAD.
		apiserver.MountAnalyticsReportingRoutes(apiserver.AnalyticsReportingRouteDeps{
			Router: r, Pool: pool, Logger: logger,
			HumanEngagementEnabled: os.Getenv("POSTWAVE_HUMAN_ENGAGEMENT") == "true",
		})

		// Platform domain — admin endpoints. Public ingest paths for
		// inbound_webhooks/inbound_email are wired in the public group.
		assetsDeps := apiserver.MountAssetLibraryRoutes(apiserver.AssetLibraryRouteDeps{
			Router: r, Pool: pool, Storage: assetStorage, Logger: logger,
		})
		// Mailchimp-parity asset folders remain a separate package mount
		// inside the helper, preserving their additive registration order.
		// Refined Library (PR 1): tiny goroutine keeps references_count
		// + last_used_at fresh on each tenant's assets table. Cheap —
		// one batch UPDATE per tenant per 5 min.
		assetsRefresher := &assets.Refresher{
			Repo:    assetsDeps.Repo,
			Tenants: assetsTenantLister{pool: pool},
			Logger:  logger,
		}
		safego.Go(logger, "assets-references-refresher", func() {
			assetsRefresher.Run(outboxCtx)
		})

		// Refined Dashboard PR 3 follow-up: digest sender. Hourly
		// tick; per-recipient gating is the SQL window in dueRecipients.
		digestSender := &analytics.DigestSender{
			Pool:   pool,
			Repo:   analyticsRepo,
			Mailer: authMailer, From: configuredPlatformSender(),
			Logger: logger,
		}
		safego.Go(logger, "dashboard-digest-sender", func() {
			digestSender.Run(outboxCtx)
		})

		// Refined Dashboard PR 4 follow-up: anonymous platform-wide
		// benchmark aggregator. Runs daily, caches into
		// dashboard_benchmark_cache; /benchmarks reads from cache.
		benchmarkAgg := &analytics.BenchmarkAggregator{
			Pool:   pool,
			Logger: logger,
		}
		safego.Go(logger, "dashboard-benchmark-aggregator", func() {
			benchmarkAgg.Run(outboxCtx)
		})

		// DASHBOARD#44: the dashboard signal emitter. Anomalies were being
		// persisted and milestones were never computed at all, so the only
		// way either reached a person was the desktop app polling while a
		// laptop happened to be open. This sweeps every tenant and fans both
		// through the same notifyfanout chokepoint as every other
		// notification (feed identity -> dedupe -> channels), which is what
		// finally puts them on a phone. Idempotency is the feed dedupe key,
		// so the sweep is safe to restart, duplicate, or re-schedule.
		dashboardSignals := &dashboardnotify.Emitter{
			Pool:   pool,
			Fanout: notifyFanout,
			Logger: logger,
		}
		safego.Go(logger, "dashboard-signal-emitter", func() {
			dashboardSignals.Run(outboxCtx)
		})
		inboundWebhookDeps.MountAdminRoutes(r)
		(&track.Deps{
			Repo:                 &track.Repo{Pool: pool},
			UsageMeter:           commercialUsageMeter,
			RequireUsageMeter:    true,
			AutomationServiceURL: cfg.AutomationServiceURL,
			InternalAPIToken:     cfg.InternalAPIToken,
			FlowRuns:             &flowbuilder.Repo{Pool: pool},
			DelayResolver:        triggerDelayRepo,
			// G-49d: bridge order-shaped track events into the revenue store
			// so a tracked "Placed Order" produces attributed revenue.
			Revenue: newTrackRevenueRecorder(&conversions.Repo{Pool: pool}),
		}).MountRoutes(r)
		// The DECLARED half of the event contract. Mounted in the same block as
		// the collector it governs: a validator with no way to declare a schema
		// validates nothing, and would leave the table empty while the code read
		// as though a contract were being enforced.
		(&track.Deps{Repo: &track.Repo{Pool: pool}, Slog: logger}).MountSchemaRoutes(r)
		// The experiment identity every variant system registers into. Mounted
		// with the collectors rather than under one system's routes: it belongs
		// to none of the nine and is the only place hypothesis, owner and
		// stopping policy are recorded at all.
		// The redemption webhook (PRD F04). Authenticated server-to-server: the
		// caller is the customer's commerce system, not a browser.
		coderedemption.MountRoutes(r, &coderedemption.Deps{
			Repo:   &coderedemption.Repo{Pool: pool},
			Logger: logger,
		})
		// Vanity-path authoring and the conversion report (PRD F04). Authenticated
		// and tenant-scoped: minting a path that credits a campaign is an
		// authoring act, even though the path it produces is public.
		coderedemption.MountVanityAdminRoutes(r, &coderedemption.VanityDeps{
			Repo:   &coderedemption.VanityRepo{Pool: pool},
			Logger: logger,
		})
		(&experiments.IdentityDeps{
			Repo:   &experiments.IdentityRepo{Pool: pool},
			Logger: logger,
		}).MountRoutes(r)
		// Inbound-route action executor. Same Listmonk sender the
		// campaign send guard uses — `forward` actions flow through
		// the tenant's rate limit + quiet hours that way. nil-safe in
		// dev when listmonkClient is unset.
		inboundEmailDeps := buildInboundEmailDeps(listmonkClient, pool, cfg, logger, envCipher)
		inboundEmailDeps.MountAdminRoutes(r)
		// Mailgun-Routes-killer CRUD: list/create/patch/delete routing
		// rules that match recipient + subject + from-domain.
		inboundEmailDeps.MountRouteAdminRoutes(r)
		// The bulk pair belongs with the CRUD above: same Deps, same router,
		// same admin scope. It had a mount function and NO CALLER, so both
		// routes sat in the routeauth manifest unmounted -- the same shape as
		// `activitycursor`, which was unreachable on main for 17 days because
		// the symptom was written off as manifest drift.
		inboundEmailDeps.MountBulkRouteAdminRoutes(r)
		// The authenticated tenant offer read remains available for inspection.
		// Its unauthenticated agent/person sibling is separately release-held:
		// canonical row existence alone is not public eligibility.
		offers.MountAdminRoutes(
			r.With(apikeys.RequireScope(apikeys.ScopeReadReports)),
			&offers.Deps{Repo: canonicalOffersRepo, Logger: logger},
		)
		apiserver.MountWebDomainToolRoutes(apiserver.WebDomainToolRouteDeps{
			Router: r,
			Pool:   pool,
			Logger: logger,
		})
		archiveAdminRepo := &archive.Repo{Pool: pool}
		archiveAdminDeps := &archive.Deps{
			Repo:                    archiveAdminRepo,
			PublicBaseURL:           os.Getenv("ARCHIVE_PUBLIC_BASE_URL"),
			TrustForwardedIPHeaders: cfg.TrustForwardedIPHeaders,
		}
		archiveAdminDeps.MountAdminRoutes(r)
		archiveAdminDeps.MountCustomDomainRoutes(r)
		archiveAdminDeps.MountMeteredPaywallAdminRoutes(r)
		archiveAdminDeps.MountRecommendationsAdminRoutes(r)
		archiveAdminRead := r.With(apikeys.RequireScope(apikeys.ScopeReadReports, apikeys.ScopeAdmin))
		archiveAdminWrite := r.With(apikeys.RequireScope(apikeys.ScopeAdmin))
		archiveAdminRead.Get("/api/v1/campaigns/{id}/archive/related", archiveAdminDeps.AdminRelatedPreview)
		archiveAdminRead.Get("/api/v1/campaigns/{id}/archive/related/overrides", archiveAdminDeps.AdminRelatedGetOverrides)
		archiveAdminWrite.Put("/api/v1/campaigns/{id}/archive/related/overrides", archiveAdminDeps.AdminRelatedSetOverrides)
		archiveTipsDeps := &archive.TipsDeps{
			Repo:          archiveAdminRepo,
			Stripe:        archive.NewTipsStripeAdapter(os.Getenv("STRIPE_SECRET_KEY")),
			PublicBaseURL: os.Getenv("ARCHIVE_PUBLIC_BASE_URL"),
			Logger:        logger,
			Verify:        billing.VerifySignature,
		}
		archiveTipsDeps.MountAdminTipsRoutes(r)
		(&archive_comments.Deps{
			Repo:   &archive_comments.Repo{Pool: pool},
			Logger: logger,
		}).MountAdminRoutes(r.With(apikeys.RequireScope(apikeys.ScopeAdmin)))
		(&podcast.Deps{
			Repo:          &podcast.Repo{Pool: pool},
			PublicBaseURL: os.Getenv("ARCHIVE_PUBLIC_BASE_URL"),
		}).MountAdminRoutes(r)
		// AEO Sensor: per-tenant answer-engine telemetry (settings, prompts,
		// probes, rollups, competitors, run-now). MountRoutes applies its own
		// per-route scope gates (read:reports for reads, admin for writes and
		// run-now), so it is mounted on the plain authenticated router.
		//
		// The Runner is composed WITHOUT engine clients: RunOnce records a
		// status='skipped' probe per enabled engine and still materialises the
		// daily rollups with sample_size=0. That is the contract the desktop
		// AEO page codes against (apps/desktop/src/pages/AEOSensor.tsx:230 —
		// "unmeasured" toast + credentials banner). No background scheduler is
		// started; POST /api/v1/aeo/run-now is the only trigger until real
		// EngineClient drivers land (internal/aeo/runner.go, MIGRATION.md #4).
		//
		// The public industry-wide Sensor (aeo.MountSensorRoutes) stays
		// unmounted: it is a forbidden composition call and its source file is
		// excluded in packages/openapi/route-reachability.json.
		aeoRepo := &aeo.Repo{Pool: pool}
		aeo.MountRoutes(r, &aeo.Deps{
			Repo:   aeoRepo,
			Runner: aeo.NewRunner(aeoRepo, nil),
			Logger: logger,
		})
		retentionOfferDeps := &retention_offers.Deps{Repo: &retention_offers.Repo{Pool: pool}, Logger: logger}
		retentionOfferDeps.MountRoutes(r.With(apikeys.RequireExactTenantAdmin))
		referralsRepo, referralCookieSecret, referralEvents := buildReferralsRuntime(pool, cfg, eventsBus)
		(&referrals.Deps{
			Repo:               referralsRepo,
			ShareBaseURL:       os.Getenv("REFERRAL_SHARE_BASE_URL"),
			PublicRedirectBase: cfg.FormsPublicHost,
			CookieSecret:       referralCookieSecret,
			Events:             referralEvents,
		}).MountAdminRoutes(r)

		startReferralWorkers(startReferralWorkersDeps{
			pool:           pool,
			referralsRepo:  referralsRepo,
			authMailer:     authMailer,
			logger:         logger,
			referralEvents: referralEvents,
			outboxCtx:      outboxCtx,
		})
		// Sanitized historical discount reporting only. Codes, subscriber PII,
		// provider checks/mutations, exports, coupon-pool inventory, and coupon
		// allocation remain outside the mounted release boundary.
		discountsDeps := &discounts.Deps{Repo: discountsRepo}
		discountsDeps.MountRoutes(r)
		paidTiersRepo := &paid_tiers.Repo{
			Pool: pool,
		}
		paidTiersDeps := &paid_tiers.Deps{Repo: paidTiersRepo}
		// Historical gift records are exposed only through sanitized, bounded
		// read projections. Attribution, mutations, provider handoffs and
		// public redemption remain outside the mounted release boundary.
		paidTiersDeps.MountRoutes(r)
		giftHandlers := &paid_tiers.GiftHandlers{Repo: paidTiersRepo}
		giftHandlers.MountGiftRoutes(r)
		// sto-click-reply-signal (P1): per-tenant STO signal weight
		// reader, backed by tenant_send_settings (migration 0301).
		// Wired onto stoRepo so Compute() / LoadOpenPattern() /
		// LoadSegmentPattern() consult the tenant's tuned weights
		// when folding clicks + replies into the modal-hour pick.
		// A nil reader is safe (the worker falls back to
		// DefaultSignalWeights), but wiring it gives operators a knob
		// to tune signal mix per-tenant from the settings surface.
		stoSignalWeights := campaigns.NewSTOSignalWeightsStore(pool)
		stoRepo := &send_time_opt.Repo{Pool: pool, Weights: stoSignalWeights}
		// Wire the campaigns-side rescheduler so
		// POST /api/v1/campaigns/{id}/schedule-by-best-time actually
		// persists the per-recipient schedule into
		// campaign_recipient_send_at (the materialized table from
		// migration 0262). Without this wiring the endpoint returned
		// 200 with a recipient count but the dispatch loop never saw
		// the schedule — the desktop toast was misleading.
		stoDeps := &send_time_opt.Deps{
			Repo:         stoRepo,
			Campaigns:    &campaigns.CampaignsRescheduler{Pool: pool},
			LiveDispatch: liveCampaignDispatch,
			// sto-recipient-distribution-preview (P1): the dry-run
			// preview endpoint reads today's warmup cap to flag
			// warmup_cap_breach when the schedule's peak-day count
			// would exceed it. campaigns.WarmupGate already exposes
			// the exact narrow contract (CapForToday); we reuse the
			// existing adapter rather than introducing a parallel one.
			Warmup: newWarmupGate(warmupTracker),
			// p5-prom-send-time-opt: logger receives 5xx context
			// for httperror.WriteInternal calls inside STO handlers.
			Logger: logger,
		}
		apiserver.MountSendTimeOptimizationRoutes(apiserver.Deps{Router: r, SendTimeOptimization: stoDeps})
		// STO compute worker — ticks every 6h, batches of 1000.
		// Without this loop subscribers.best_send_hour stays
		// permanently NULL and the entire STO surface is dead.
		// One-shot backfill on first boot is gated by
		// STO_BACKFILL_ON_BOOT=1 so cold-start latency is opt-in.
		stoWorker := send_time_opt.NewWorker(stoRepo)
		stoWorker.Logger = logger
		if os.Getenv("STO_BACKFILL_ON_BOOT") == "1" {
			safego.Go(logger, "sto-compute-backfill", func() {
				stoWorker.Backfill(outboxCtx, 0)
			})
		}
		safego.Go(logger, "sto-compute-worker",
			func() { stoWorker.Run(outboxCtx) })

		// sto-segment-subscribers-materialized (P0): refresh the
		// segment_subscribers cache every 5 min. Without this the
		// cache stays empty and every GET /api/v1/send-time-opt +
		// /heatmap request falls through to the inline-AST compile
		// path (still correct, just slower).
		// Both cache workers forward "Entered segment" entrants through one
		// forwarder; an empty AutomationServiceURL makes it a no-op.
		segmentJoinForwarder := &segments.HTTPSegmentJoinForwarder{
			BaseURL: cfg.AutomationServiceURL, InternalAPIToken: cfg.InternalAPIToken,
		}
		stoMaterializer := send_time_opt.NewSegmentMaterializer(stoRepo)
		stoMaterializer.Logger = logger
		stoMaterializer.Forwarder = segmentJoinForwarder
		safego.Go(logger, "sto-segment-materializer",
			func() { stoMaterializer.Run(outboxCtx) })

		// SUB-029: live segment recompute on every event. Drains
		// segment_event_queue (enqueued by subscribers.RecordSubscriberEvent)
		// every ~1s and rewrites segment_subscribers for the affected
		// segments, so membership flips within seconds of event arrival
		// rather than at the 5-minute materialiser tick above. Opt-out
		// via POSTWAVE_DISABLE_SEGMENT_EVENT_WORKER=1.
		if os.Getenv("POSTWAVE_DISABLE_SEGMENT_EVENT_WORKER") != "1" {
			segmentEventWorker := &segments.SegmentEventWorker{
				Pool:      pool,
				Repo:      segmentsDeps.Repo,
				Logger:    logger,
				Forwarder: segmentJoinForwarder,
			}
			safego.Go(logger, "segment-event-worker",
				func() { segmentEventWorker.Run(outboxCtx) })
		}
		/* ===== end X1+X2+X3 ===== */

		// ----- engagement: a-b-reader + drip-triggers -----
		// A/B results reader (operator-facing variant scores +
		// significance) is wired through MountCampaignABTestRoutes above — the
		// new GET /api/v1/campaigns/{id}/ab-results endpoint is added
		// inside abtests.Deps.MountRoutes alongside the existing
		// /ab + /variants + /evaluate handlers.
		//
		// Drip-trigger CRUD lives on the existing
		// inbound_webhooks.Deps.MountAdminRoutes call above; the
		// trigger evaluator is invoked from the public /api/public/
		// inbound/{slug} receive path AFTER persistence, in a
		// goroutine. We re-bind the admin Deps here ONLY to attach
		// the Logger hook (no behavioral change vs. the registration
		// at line ~1271; the Repo is the same DB-backed instance).
		// The shared deps mounted above carry the production executor and
		// structured trigger logger used by the public receive path.
		// ----- end engagement: a-b-reader + drip-triggers -----

		apiserver.MountWorkspaceDataUtilities(apiserver.WorkspaceDataUtilitiesDeps{
			Router: r, Pool: pool, Logger: logger, RetentionSweeper: sharedRetentionSweeper, VoiceServiceURL: cfg.VoiceServiceURL,
			InternalAPIToken: cfg.InternalAPIToken,
			Mailer:           authMailer, FromAddress: authFromAddress,
		})

		engagementWebhooks := apiserver.MountEngagementPreferencesAndWebhooks(apiserver.EngagementPreferencesWebhookDeps{
			Router: r, Pool: pool, Logger: logger, WebhookRepo: webhooksRepo, EnvelopeCipher: envCipher, Outbox: outboxRepo,
		})

		apiworkers.StartWebhookAlertSender(outboxCtx, apiworkers.WebhookAlertSenderDeps{
			Pool: pool, Repo: engagementWebhooks.Webhooks.Repo, Mailer: authMailer, From: configuredPlatformSender(), Logger: logger,
		})
		apiserver.MountLegacyWebhookReplayRoute(r, engagementWebhooks)

		// ----- outbound-webhooks: customer-facing event subscriptions -----
		// Public outbound webhooks API: customers (and Zapier via the
		// platform-cli app in packages/zapier) configure URLs + event
		// types. Domain mutations enqueue delivery intent in their owning
		// database transaction; the retry worker drains committed intent with
		// exponential backoff (30s → 5m → 30m → 2h → 8h → 1d → 1d, then
		// exhausted).
		// Signing secret is envelope-encrypted at rest using the same
		// EnvelopeCipher Slack tokens use, so a DB dump alone is worthless.
		// See apps/api/internal/outbound_webhooks/outbound_webhooks.go for
		// the full Stripe-style signature header rationale.
		// HTTPS required in non-dev so a tenant can't accidentally
		// post their signing-secret-bearing payloads over plaintext.
		outboundWebhooksDeps := &outbound_webhooks.Deps{
			Store:                      outboundWebhooksStore,
			HTTPClient:                 outboundWebhookHTTPClient,
			RequireHTTPS:               requireOutboundWebhookHTTPS,
			PlaygroundAPIKeyRateLimit:  webhookPlaygroundAPIKeyLimit.Middleware,
			PlaygroundTenantRateLimit:  webhookPlaygroundTenantLimit.Middleware,
			PlaygroundConcurrencyLimit: webhookPlaygroundConcurrency.Middleware,
		}
		// p0-outbound-webhooks-rbac: scope wrap now lives inside
		// MountRoutes so the caller can't forget it. We pass
		// ScopeAdmin because every route here is either a mutator
		// (Create / Update / Delete / Test / RotateSecret /
		// ReplayDelivery / ReEnable) or reads delivery payloads that
		// may carry tenant PII (List / Deliveries / AllDeliveries /
		// Health).
		outboundWebhooksDeps.MountRoutes(r, apikeys.ScopeAdmin)
		// Playground — richer "fire a synthetic event of any type
		// with a custom payload" surface. Returns a credential-redacted
		// request/response envelope so developers can inspect delivery
		// shape without exposing configured auth or echoed secrets.
		outboundWebhooksDeps.MountPlaygroundRoutes(r)
		// Cross-webhook unified dashboard — "show me every failure
		// across every webhook in the last hour" + 24h aggregate
		// stats per (webhook, event_type).
		outboundWebhooksDeps.MountUnifiedDeliveriesRoutes(r)

		apiworkers.StartOutboundWebhookWorkers(outboxCtx, apiworkers.OutboundWebhookWorkerDeps{
			Pool:          pool,
			Store:         outboundWebhooksStore,
			Mailer:        authMailer,
			From:          authFromAddress,
			PublicBaseURL: cmpOr(os.Getenv("PUBLIC_BASE_URL"), "https://app.moosewave.com"),
			// COMMERCE#3 — an auto-disabled endpoint means the tenant's own
			// systems have stopped receiving data, and until now the only way
			// to find out was an email. Route it through the same fanout
			// chokepoint as every other operator alert so it reaches the feed,
			// the browser, and the phone.
			Fanout: notifyFanout,
			Logger: logger,
		})
		// ----- end outbound-webhooks -----

		// ----- audience syncs (A13) -----
		// The returned identities are shared with the schedulers below and the
		// zero-copy activation worker later in this authenticated route group.
		audienceActivation := apiserver.MountAudienceActivationSurface(apiserver.Deps{
			Router: r,
			Pool:   pool,
			Logger: logger,
			AudienceActivation: &apiserver.AudienceActivationDeps{
				Suppressions:   suppressionsStore,
				Secrets:        secretsResolver,
				HTTPClient:     outboundWebhookHTTPClient,
				KlaviyoStore:   marketingIntegrationsRepo,
				RequireHTTPS:   requireOutboundWebhookHTTPS,
				ReceiptSignKey: os.Getenv("POSTWAVE_RECEIPT_SIGNING_KEY"),
			},
		})
		apiworkers.StartAudienceActivationWorkers(outboxCtx, apiworkers.AudienceActivationWorkerDeps{
			Pool: pool, Surface: audienceActivation, Secrets: secretsResolver, Logger: logger,
		})
		// ----- end audience syncs -----

		// ----- agent routines (platform-2026 #1) -----
		// Standing agent instructions with approval gates: tenant
		// briefs the agent drafts campaigns/sequences from on a
		// schedule, via the voice service's existing drafting
		// endpoints. SAFETY: runs only ever create DRAFT artifacts;
		// when require_approval (default true) each run opens a
		// pending approvals row gating human promotion. Tables 0386 +
		// 0387. Scheduler candidate scans use the read-only cross-tenant worker
		// policy; each actual claim re-enters tenant RLS and atomically writes the
		// running receipt + attempt timestamp. Stale receipts are failed without
		// automatic replay, avoiding duplicate drafts after an ambiguous crash.
		agentRoutinesRepo := &agent_routines.Repo{Pool: pool}
		agentRoutinesPIIRepo := &pii_gateway.Repo{Pool: pool}
		agentRoutinesRunner := &agent_routines.Runner{
			Store: agentRoutinesRepo,
			Voice: agent_routines.NewHTTPVoiceClient(
				cfg.VoiceServiceURL,
				cfg.InternalAPIToken,
				agent_routines.StrictTextSanitizerFactoryFunc(func(
					ctx context.Context,
					tenantID, salt, prompt, contextText string,
				) (pii_gateway.Sanitizer, error) {
					return agentRoutinesPIIRepo.StrictTextSanitizerForTenant(
						ctx,
						tenantID,
						salt,
						prompt,
						contextText,
					)
				}),
			),
			Approvals: agent_routines.ApprovalRequesterFunc(func(ctx context.Context, tenantID, resourceType, resourceID, actorLabel string) (string, error) {
				row, err := approvalsService.Request(ctx, tenantID,
					approvals.Resource{Type: approvals.ResourceType(resourceType), ID: resourceID},
					approvals.Actor{Type: "agent", Label: actorLabel})
				if err != nil {
					return "", err
				}
				return row.ID, nil
			}),
			Logger: logger,
		}
		agent_routines.MountRoutes(r, &agent_routines.Deps{
			Store:  agentRoutinesRepo,
			Runner: agentRoutinesRunner,
			Logger: logger,
		})
		// ----- AI-output regression harness (#1) -----
		// Per-tenant golden-set capture + replay-and-score. Tables
		// 0402-0405. The replay itself runs in the voice service
		// (internalauth POST /v1/voice/regression/replay-batch); this
		// package owns the four harness tables + the trigger/list/settings
		// API. The GoldenCapturer adapter snapshots approved campaign
		// drafts into the golden set on approve (best-effort, fired by
		// approvals.Service.Decide).
		buildAIRegressionRunnerOut := buildAIRegressionRunner(pool, cfg, logger)
		aiRegressionStore := buildAIRegressionRunnerOut.aiRegressionStore
		aiRegressionRuntime := buildAIRegressionRunnerOut.aiRegressionRuntime
		aiRegressionExecutorReady := buildAIRegressionRunnerOut.aiRegressionExecutorReady
		aiRegressionRunner := buildAIRegressionRunnerOut.aiRegressionRunner
		ai_regression.MountRoutes(r, &ai_regression.Deps{
			Store:          aiRegressionStore,
			Logger:         logger,
			Runtime:        aiRegressionRuntime,
			ExecutionReady: aiRegressionExecutorReady,
		})
		approvalsService.GoldenCapture = &ai_regression.GoldenAdapter{
			Store:    aiRegressionStore,
			Resolver: &ai_regression.CampaignResolver{Pool: pool},
		}
		startAIRegressionScheduler(aiRegressionExecutorReady, aiRegressionStore, aiRegressionRunner, logger, outboxCtx)
		// ----- end AI-output regression harness -----
		agentRoutinesScheduler := &agent_routines.Scheduler{
			Pool:   pool,
			Repo:   agentRoutinesRepo,
			Runner: agentRoutinesRunner,
			Logger: logger,
		}
		safego.Go(logger, "agent-routines-scheduler", func() {
			if err := agentRoutinesScheduler.Run(outboxCtx); err != nil &&
				!errors.Is(err, context.Canceled) {
				logger.Warn("agent_routines: scheduler exited", "err", err.Error())
			}
		})
		// ----- end agent routines -----

		// ----- feed ingest (RSS/recurring campaigns) -----
		// FEATURE-ROADMAP-2026-06 "Recurring / RSS-to-email campaigns":
		// RSS 2.0 / Atom feeds polled on a schedule; new items become
		// DRAFT digest campaigns only (never auto-sent). Fetches go
		// through the SSRF-safe outbound-webhooks HTTP client. Drafts
		// are minted through campaigns.Repo.Create (status draft,
		// campaign_type 'rss') + SetABTestAudience to stamp the
		// audience_list_id / audience_segment_id columns Create leaves
		// untouched — the same follow-up the A/B path uses.
		feedIngestRepo, feedIngestPoller := buildFeedIngestPoller(pool, outboundWebhookHTTPClient, logger, campaignDeps)
		feed_ingest.MountRoutes(r, &feed_ingest.Deps{
			Repo:         feedIngestRepo,
			Poller:       feedIngestPoller,
			Logger:       logger,
			RequireHTTPS: requireOutboundWebhookHTTPS,
		})
		// Minute tick that polls due daily/weekly sources (cross-tenant
		// enumeration under the feed_sources_worker_select policy from
		// migration 0384; each poll re-binds tenant scope).
		startFeedIngestScheduler(pool, feedIngestPoller, logger, outboxCtx)
		// ----- end feed ingest -----

		// ----- suppressions + deliverability webhooks -----
		// X1 deliverability surface against subscriber_suppressions
		// (migration 0081). These admin routes target the NEW
		// deliverability table; the legacy /api/v1/suppressions
		// routes (subscribers.MountRead/Write + the explicitly scoped legacy
		// bulk/export adapters) still use the older tables. CSV imports above
		// share this canonical store so uploaded holds appear in this roster.
		// Mirror credentials resolve per-tenant from a write-only runtime
		// secret named by tenant_deliverability_providers.config.credential_ref,
		// with a POSTWAVE_MIRROR_<PROVIDER>_API_KEY env fallback (desktop
		// audit A6). All five providers now have real pull clients — Mailchimp
		// + SendGrid, plus SES (AWS suppression list), Mailgun, and Postmark;
		// each degrades to a typed not-configured error until its credentials
		// (or Mailgun sending domain) are set, and their webhook receivers keep
		// the table current in the meantime.
		suppressionsHandlers := buildSuppressionsHandlers(pool, secretsResolver, logger, suppressionsStore)
		r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).Get(
			"/api/v1/deliverability/suppressions", suppressionsHandlers.List)
		r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post(
			"/api/v1/deliverability/suppressions", suppressionsHandlers.Add)
		r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Delete(
			"/api/v1/deliverability/suppressions/{email}", suppressionsHandlers.Remove)
		// Read-shaped X1 routes (desktop audit A3 + A5): trend chart,
		// per-row timeline, per-address audit trail.
		r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).Group(func(r chi.Router) {
			suppressionsHandlers.MountX1ReadRoutes(r)
		})
		// Destructive X1 routes (desktop audit A4 + A6): bulk delete /
		// bulk action (delete | change_reason | export), expires_at
		// PATCH, and the ESP mirror pull.
		r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Group(func(r chi.Router) {
			suppressionsHandlers.MountX1BulkRoutes(r)
			suppressionsHandlers.MountX1MirrorRoutes(r)
		})
		r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Group(func(r chi.Router) {
			(&webhooks.DeliverabilityDeps{Pool: pool}).MountProviderConfigRoutes(r)
		})
		// ----- end suppressions + deliverability webhooks -----

		// EQ-Score grader. Mounted inside the protected/tenant-scoped
		// router so every grade can persist its outcome to
		// eq_score_history (the rolling 30-day window read by
		// predictenrich + the dashboard EQ-trend chart).
		(&eqscore.Deps{
			Pool:      pool,
			RateLimit: expensiveTenantLimit.Middleware,
		}).MountRoutes(r)

		// API keys admin (hashed-at-rest, plaintext shown once).
		akDeps := &apikeys.Deps{Repo: apiKeyResolver, Cache: apiKeyAuthCache}
		apiserver.MountAPIKeyRoutes(apiserver.Deps{Router: r, APIKeys: akDeps})

		auditOperations := &apiserver.AuditOperationsDeps{
			Handlers: auditHandlers,
			Portal:   auditPortalDeps,
		}
		apiserver.MountAuditOperationsSurface(apiserver.Deps{
			Router: r, Pool: pool, Logger: logger, AuditOperations: auditOperations,
		})

		// SHELL#14 — the people half of Settings > Team. The roles routes
		// above return role DEFINITIONS; this returns the humans those
		// definitions apply to, and lets an admin change a teammate's tier
		// or suspend them. Mounted here rather than inside
		// MountAuditOperationsSurface because that function's route list is
		// pinned by an equality test against a legacy reference mount and
		// the roster is not part of the audit sub-tree.
		handlers.MountWorkspaceMembers(r, &handlers.WorkspaceMembersHandlers{
			Pool: pool, Logger: logger,
		})
		// SETC-010 — copy-link team invitations (sibling of the roster).
		handlers.MountWorkspaceInvites(r, &handlers.WorkspaceInvitesHandlers{
			Pool: pool, Logger: logger,
		})

		// MCP evidence page (desktop sidebar → "MCP"). Surfaces:
		//   • API-build candidate catalogue bundled via go:embed; it is not
		//     proof of the separately published npm artifact or a deployment
		//   • best-effort execution telemetry filtered to a strict, but still
		//     caller-asserted, MCP user-agent classifier
		//   • aggregated stats (last-7d count, success rate, top tools)
		// Same admin gate as the audit endpoints — operators only.
		// See apps/api/internal/apikeycalls/ + migration 0174.
		mcpDeps := &apikeycalls.Deps{Repo: apiKeyCallsRepo}
		apiserver.MountAPIKeyCallRoutes(apiserver.Deps{Router: r, APIKeyCalls: mcpDeps})
		// Native MCP read-only preview. The RPC route performs per-tool scope
		// checks inside the custom JSON-RPC frame; all write tools and any read
		// without a reviewed LLM-safe output projection are structurally held.
		//
		// p0-mcp-rbac: gate the RPC entry on
		// RequireAuthMethod(AuthMethodAPIKey) + RequireScope(ScopeMCP).
		// The auth-method gate rejects dashboard session cookies
		// outright — MCP is for programmatic agents, not browser
		// users — and ScopeMCP makes "this key can drive the MCP
		// server" an explicit, narrow permission rather than something
		// implied by ScopeAdmin alone. Per-tool scope checks inside
		// HandleRPC are unchanged.
		// One scrub-capable governor instance is shared by every LLM-facing
		// agent surface. Quota rows are advisory and write-tier is held before
		// quota, budget, approval, audit, or handler side effects. Atomic,
		// server-attributed reservation and transaction-coupled audit remain
		// mandatory release gates before write-tier can be enabled.
		agentGovernor := agentgov.New(agentgov.Deps{
			Budgets:   budgetRepo,
			Quotas:    apiKeyCallsRepoOuter,
			Approvals: approvalsService,
			Pool:      pool,
		})
		nativeMCPDeps := &mcp.Deps{
			Pool: pool,
			Gov:  agentGovernor,
			// Lets the whoami tool / api-keys/me report remaining budget.
			Budgets: budgetRepo,
			// Delegation seams for the native write tools (1.3b): call the
			// domain service funcs directly (no router → single governance
			// pass) while reusing the REST validation/compliance/suppression/
			// approval logic. campaignDeps.Repo provides create; campaignDeps
			// provides the approval-enforced QueueCampaignForAgent.
			CampaignCreate:           campaignDeps.Repo,
			CampaignTemplates:        ctplDeps.Repo,
			TemplateGenerator:        ctplDeps.Generator,
			CampaignTemplateWorkflow: ctplDeps,
			CampaignSend:             campaignDeps,
			TagCreate:                &tags.Repo{Pool: pool},
			SubTagApply:              &tags.SubscriberTagsRepo{Pool: pool, History: tagsHistory},
			AssetUpload:              assetsDeps,
			ListCreate:               listsDeps,
			SubscriberRepo:           subscriberDeps.Repo,
		}
		nativeMCPDeps.MountRoutes(r)
		r.With(apikeycalls.ProtectMCPResponses, apikeys.RequireAuthMethod(apikeys.AuthMethodAPIKey)).
			With(apikeys.RequireScope(apikeys.ScopeMCP)).
			Post("/api/v1/mcp/rpc", nativeMCPDeps.HandleRPC)
		// Agent self-introspection: any authenticated API key can read its
		// own identity + limits (scopes, sandbox flag, write-tier, remaining
		// send/cost budget) so an autonomous agent can self-limit. Reuses
		// the same SelfInfo implementation as the whoami MCP tool.
		r.With(apikeys.ProtectCredentialResponses, apikeys.RequireAuthMethod(apikeys.AuthMethodAPIKey)).
			Get("/api/v1/api-keys/me", func(w http.ResponseWriter, req *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Cache-Control", "private, no-store")
				w.Header().Set("Pragma", "no-cache")
				_ = json.NewEncoder(w).Encode(nativeMCPDeps.SelfInfo(req.Context()))
			})
		// Future in-app AI agent implementation over the shared registry and
		// governor. MountAgentRoutes currently places the entire route family
		// behind agent_interactive_release_held before authentication, session
		// storage, BYOK resolution, provider calls, or tool execution.
		var agentLLM ai_agent.LLMClient
		if key := strings.TrimSpace(firstEnv("AI_AGENT_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY")); key != "" {
			agentLLM = ai_agent.NewAnthropicLLM(ai_agent.AnthropicConfig{
				APIKey:  key,
				Model:   os.Getenv("AI_AGENT_MODEL"),
				BaseURL: os.Getenv("ANTHROPIC_BASE_URL"),
			})
			logger.Info("ai-agent: provider configured; interactive route remains release-held")
		}
		// Future BYOK LLM storage (3.3b): per-tenant provider key, encrypted at rest via a
		// byok Composite cipher (same primitive as the integration vault; a
		// dedicated instance is built here because the vault's cipher is
		// constructed later in startup). Feeds LLMFor + the
		// GET/PUT /api/v1/ai-agent/config routes.
		agentLLMConfig := &ai_agent.LLMConfigRepo{
			Pool: pool,
			Cipher: byok.NewComposite(
				byok.NewTenantCipher(&byok.Repo{Pool: pool}, byok.BuildRegistry(byokAWSClient(awsCfg, kmsKeyID))),
				envCipher, cfg.SendingKEK,
			),
		}
		agentChat := &ai_agent.ChatHandler{
			Registry: nativeMCPDeps.Registry(),
			Governor: agentGovernor,
			LLM:      agentLLM,
			// Per-tenant BYOK provider key; resolveLLM falls back to the
			// platform LLM when a tenant hasn't configured one.
			LLMFor: ai_agent.NewBYOKResolver(agentLLMConfig),
			// Attribute each run's token usage to the tenant in the shared cost
			// ledger, priced in microcents from the model + token counts. This
			// replaces the hardcoded cents=0 that made /api/v1/costs report $0
			// for every tenant and dollar budgets impossible to trip. The agent
			// default model is claude-sonnet-4-6 (anthropic.go:40); raw tokens
			// still ride in metadata for exact re-pricing.
			CostRecorder: func(ctx context.Context, _ agenttools.Caller, u ai_agent.TokenUsage) {
				_ = cost.RecordTokensFromContext(ctx, costRepo, cost.KindAIGeneration,
					cost.DefaultPricing(), "claude-sonnet-4-6", u.InputTokens, u.OutputTokens, map[string]any{})
			},
			// Durable, resumable agent conversations (supersedes the legacy
			// campaign.go plan stub, which is now dead/unmounted).
			Sessions: &ai_agent.Repo{Pool: pool},
			// Backs the BYOK config routes (set/get the per-tenant key).
			LLMConfig: agentLLMConfig,
		}
		// Mounts one method-agnostic 503 hold over /api/v1/ai-agent/*.
		// Future handlers stay composed below that boundary for review only.
		if ai_agent.AgentInteractiveReleased {
			ai_agent.MountAgentRoutes(r, agentChat)
		}
		// OpenAPI spec for the in-app API playground. Tenant-gated so
		// the spec doesn't leak from unauthenticated probes (it
		// reveals every endpoint the build supports). Any logged-in
		// member can read it — the spec itself has no per-tenant data.
		apiDocsDeps := &apidocs.Deps{
			APIKeyRateLimit:  apiDocsAPIKeyLimit.Middleware,
			SessionRateLimit: apiDocsSessionLimit.Middleware,
		}
		apiserver.MountAPIDocRoutes(apiserver.Deps{Router: r, APIDocs: apiDocsDeps})
		// Plan-limit usage: per-resource current/limit/percent for
		// the dashboard usage bars + billing portal's "you're at
		// 87% of monthly sends" surface.
		limitsHandlers.MountRoutes(r)
		// GDPR Article 20 / SOC 2 data portability — async tenant
		// data export. The handler queues a row in tenant_exports;
		// the worker (started below) walks subscribers + campaigns
		// + audit_log + ... into a zip and uploads to object
		// storage. A tenant-bound authenticated download route is returned once
		// status='ready'; the object key never leaves the service boundary.
		exports.MountRoutes(r, &exports.Deps{
			Pool:    pool,
			Storage: exportStorage,
		})
		warehouseRepo := &warehouse.Repo{Pool: pool}
		configureSnowflakeExecutor(secretsResolver, warehouseRepo, logger)
		warehouse.MountRoutes(r, &warehouse.Deps{
			Repo:    warehouseRepo,
			Storage: warehouseObjectStore,
			Logger:  logger,
		})
		// SUB-112 reverse-ETL: warehouse columns → subscriber custom fields.
		// Mounted on the same warehouse Repo so it shares connection +
		// credential machinery (migration 1101).
		warehouse.MountReverseETLRoutes(r, &warehouse.Deps{
			Repo:   warehouseRepo,
			Logger: logger,
		})
		// SUB-111 streaming export (Currents-style): hourly subscriber.*
		// event batches shipped to S3/Snowflake/BigQuery as Parquet/Avro.
		// Reuses warehouse_connections (provider=streaming_export, migration
		// 1100) + the warehouse object store. The worker's manual ship path
		// is wired; the scheduled tick is gated on a TenantLister supplied
		// here so enumeration stays cross-tenant safe.
		streamingExportRepo := &streaming_export.Repo{Pool: pool}
		streamingExportWorker := &streaming_export.Worker{
			Repo:    streamingExportRepo,
			Storage: warehouseObjectStore,
			Logger:  logger,
		}
		streaming_export.MountRoutes(r, &streaming_export.Deps{
			Repo:    streamingExportRepo,
			Storage: warehouseObjectStore,
			Worker:  streamingExportWorker,
			Logger:  logger,
		})
		// Scheduled hourly tick: the repo is the TenantLister (cross-tenant
		// enumeration under the warehouse_connections worker_select gate,
		// migration 1117); each due window ships under per-tenant RLS.
		// Manual ShipNow stays available regardless.
		startStreamingExportWorker(logger, streamingExportWorker, outboxCtx, streamingExportRepo)
		zeroCopyRepo := &zerocopy_triggers.Repo{Pool: pool}
		zeroCopyEnqueuer := zeroCopyFlowEnqueuer{repo: &flowbuilder.Repo{Pool: pool}}
		// Native warehouse drivers: postgres + redshift
		// (Postgres-wire) + snowflake via database/sql, and bigquery via its
		// REST jobs.query API. Each looks up the trigger's warehouse connection
		// and resolves its credentials_ref through the shared secrets backend.
		// References are tenant-local labels; the resolver derives
		// postwave/tenants/<tenant>/warehouse/read-only/<label>, preventing a
		// tenant from naming another workspace's process-wide credential.
		zeroCopyConnLookup := zeroCopyConnectionLookup{repo: warehouseRepo}
		zeroCopyCredResolver := zerocopy_triggers.NewTenantSecretsCredentialResolver(secretsResolver)
		zeroCopySQLDriver := &zerocopy_triggers.SQLDriver{Lookup: zeroCopyConnLookup, Resolver: zeroCopyCredResolver}
		zeroCopyAlertRepo := &zerocopy_triggers.AlertRepo{Pool: pool}
		zeroCopyDLQRepo := &zerocopy_triggers.DLQRepo{Pool: pool}
		zerocopy_triggers.RegisterDriver("postgres", zeroCopySQLDriver)
		zerocopy_triggers.RegisterDriver("redshift", zeroCopySQLDriver)
		zerocopy_triggers.RegisterDriver("snowflake", zeroCopySQLDriver)
		zerocopy_triggers.RegisterDriver("bigquery", &zerocopy_triggers.BigQueryDriver{Lookup: zeroCopyConnLookup, Resolver: zeroCopyCredResolver})
		// Build the consent seam for completeness, but do not start the legacy
		// in-process poller: it has no distributed lease and would poll/enqueue
		// concurrently in every API replica. Runtime handlers fail closed until a
		// durable, single-owner drainer is certified.
		zeroCopyConsentGate := (&zerocopy_triggers.Worker{
			Logger:         logger,
			Firewall:       audienceActivation.Filter,
			ReceiptStore:   audienceActivation.ReceiptStore,
			ReceiptSignKey: audienceActivation.ReceiptKey,
		}).ConsentGate()
		zerocopy_triggers.MountRoutes(r, &zerocopy_triggers.Deps{
			Repo:        zeroCopyRepo,
			Enqueuer:    zeroCopyEnqueuer,
			AlertRepo:   zeroCopyAlertRepo,
			DLQRepo:     zeroCopyDLQRepo,
			ConsentGate: zeroCopyConsentGate,
			Logger:      logger,
		})
		logger.Info("zero-copy trigger execution disabled",
			"runtime_status", "unavailable",
			"reason", "distributed trigger leasing is not certified")
		customerLifecycleSurface := apiserver.NewCustomerLifecycleIntegrationsSurface(apiserver.Deps{
			Pool:   pool,
			Logger: logger,
			CustomerLifecycleIntegrations: &apiserver.CustomerLifecycleIntegrationsDeps{
				ReviewStorage:      warehouseObjectStore,
				ReviewFlowEvents:   reviewsFlowEventAdapter{track: &track.Repo{Pool: pool, FlowRuns: &flowbuilder.Repo{Pool: pool}}},
				SubscriberProfiles: subscriberDeps.Repo,
				Secrets:            secretsResolver,
				PublicBaseURL:      os.Getenv("POSTWAVE_PUBLIC_BASE_URL"),
			},
		})
		apiserver.MountReviewLifecycleRoutes(r, customerLifecycleSurface)
		apiworkers.StartReviewIntegrationBackfills(outboxCtx, logger, customerLifecycleSurface)
		apiserver.MountLoyaltyLifecycleRoutes(r, customerLifecycleSurface)
		apiworkers.StartLoyaltyIntegrationBackfills(outboxCtx, logger, customerLifecycleSurface)
		apiserver.MountSubscriptionLifecycleRoutes(r, customerLifecycleSurface)
		apiworkers.StartSubscriptionIntegrationBackfills(outboxCtx, logger, customerLifecycleSurface)
		// DKIM/SPF/DMARC setup wizard for sending domains. Generates
		// a DKIM keypair, surfaces the three DNS records, polls each
		// via the system resolver on every verify call.
		apiserver.MountSendingIdentityRoutes(apiserver.Deps{Router: r, Pool: pool})
		importExecutionVerification := apiserver.NewImportExecutionVerifier(verificationStore)
		apiserver.MountImportAuditAlertRoutes(apiserver.ImportAuditAlertRouteDeps{
			Router: r, Pool: pool, Logger: logger, Storage: assetStorage,
			Verification:          apiserver.NewImportVerificationProjector(verificationStore),
			ExecutionVerification: importExecutionVerification,
		})
		var editorCouponResolver email_blocks.CouponResolver
		if discounts.CouponAllocationAvailable {
			editorCouponResolver = discountCouponResolver{Repo: discountsRepo}
		}
		editorQueue := apiserver.MountEditorQueueRoutes(apiserver.EditorQueueRouteDeps{
			Router: r, Pool: pool, Logger: logger,
			ProductResolver:   commerceProductFeedResolver{Repo: commerceRepo},
			CouponResolver:    editorCouponResolver,
			CampaignTemplates: ctplDeps, Commerce: commerceRepo,
		})
		if os.Getenv("POSTWAVE_DISABLE_NBP_BUILDER") != "1" {
			nbpBuilder := nbp.NewBuilder(editorQueue.NBPRepo)
			safego.Go(logger, "nbp-builder", func() {
				runNBPBuilder(outboxCtx, logger, nbpBuilder)
			})
		}
		partitionRotator = &partition_rotator.Worker{Pool: pool, Logger: logger}
		apiserver.MountReportingComplianceTools(apiserver.ReportingComplianceToolsDeps{
			Router: r, Pool: pool, Logger: logger, Storage: exportStorage, PartitionRotator: partitionRotator,
			ConsentCursorSigningKey: privacyCursorSigningKey,
			PlaygroundSubjectAccess: outboundWebhooksStore,
		})
		// GAP-LS-119: daily snapshot of per-list health into
		// list_health_history. The worker iterates every tenant's
		// active lists, computes the score via the list_subscribers
		// JOIN, and upserts under (tenant, list, day).
		listHealthHistoryWorker := &list_health.HistoryWorker{
			Pool:    pool,
			Tenants: assetsTenantLister{pool: pool},
			ListsForTenant: func(ctx context.Context, tenantID string) ([]string, error) {
				return listsForTenant(ctx, pool, tenantID)
			},
			Logger: logger,
		}
		safego.Go(logger, "list-health-history", func() {
			listHealthHistoryWorker.Run(outboxCtx)
		})
		apiserver.MountPlatformCatalogRoutes(apiserver.PlatformCatalogRouteDeps{
			Router: r, Pool: pool, Logger: logger,
			ReviewSecret: os.Getenv("DEVELOPER_MARKETPLACE_REVIEW_SECRET"),
		})
		// Customer Hub, support-provider routes, credentialed callbacks, and
		// native backfill clients share one typed composition graph.
		helpdeskCursorKey := append([]byte(nil), cfg.HelpdeskCursorKey...)
		if len(helpdeskCursorKey) == 0 && !isProductionEnv() {
			helpdeskCursorKey = []byte("postwave-local-helpdesk-cursor-key-v1")
		}
		supportIntegrationsSurface := apiserver.MountSupportIntegrationsSurface(apiserver.Deps{
			Router: r,
			Pool:   pool,
			Logger: logger,
			SupportIntegrations: &apiserver.SupportIntegrationsDeps{
				SubscriberProfiles:        subscriberDeps.Repo,
				Secrets:                   secretsResolver,
				SalesforceCredentialStore: salesforceServiceCloudCredentialStoreAdapter{store: crmIntegrationsRepo},
				PublicBaseURL:             os.Getenv("POSTWAVE_PUBLIC_BASE_URL"),
				HubSpotClientSecret:       os.Getenv("HUBSPOT_OAUTH_CLIENT_SECRET"),
				SalesforceOAuthLoginURL:   os.Getenv("SALESFORCE_OAUTH_LOGIN_URL"),
				HelpdeskCursorKey:         helpdeskCursorKey,
			},
		})
		apiworkers.StartSupportIntegrationBackfills(outboxCtx, logger, supportIntegrationsSurface)
		subscriberProtection := apiserver.MountSubscriberProtectionUtilities(apiserver.SubscriberCampaignUtilitiesDeps{
			Router: r, Pool: pool, Logger: logger, Suppressions: suppressionsStore,
		})
		apiworkers.StartSpamTrapGuard(outboxCtx, logger, subscriberProtection.SpamTrapWorker)
		// Email-verification connector layer. Sits alongside the other
		// list-protection surfaces because that is what it is: the
		// pre-send half of the same job spam_trap_guard does after the
		// fact. Secrets is the BYO vendor-key resolver; without it the
		// free local tier still runs.
		verificationSurface := apiserver.MountVerificationSurface(apiserver.VerificationSurfaceDeps{
			Router: r, Pool: pool, Logger: logger, Secrets: secretsResolver,
			Store: verificationStore,
			// Durable item leases, request-start receipts, tenant-scoped
			// idempotency, and terminal ambiguity handling make creation safe by
			// default. Keep an emergency release kill-switch for operators.
			BulkJobCreationEnabled: os.Getenv("POSTWAVE_DISABLE_VERIFICATION_BULK_JOBS") != "1",
		})
		if os.Getenv("POSTWAVE_DISABLE_VERIFICATION_JOB_RUNNER") != "1" {
			apiworkers.StartVerificationRunner(outboxCtx, logger, verificationSurface.Runner)
		} else {
			// Creation has a separate switch. Stopping only execution preserves
			// durable pending work and lets imports remain safely queued while an
			// operator contains provider billing or reconciliation incidents.
			logger.Warn("verification: durable job runner disabled by emergency kill switch")
		}
		apiworkers.StartVerificationCachePurge(outboxCtx, logger, verificationSurface.Store)
		apiserver.MountCampaignDeliveryUtilities(apiserver.SubscriberCampaignUtilitiesDeps{
			Router: r, Pool: pool, CampaignLiveDispatch: liveCampaignDispatch,
		})
		// Complete deliverability surface. It receives this authenticated
		// sub-router so the existing API-key, tenant, authorization, audit,
		// MFA, and residency middleware order remains unchanged.
		deliverabilitySurface := apiserver.MountDeliverabilitySurface(apiserver.Deps{
			Router: r, Pool: pool, Bus: eventsBus, Logger: logger,
			TagHistory: tagsHistory,
		})
		// DELIVERABILITY#15 — the hub worker has always scored the account,
		// fired the list_health.degraded WEBHOOK on a downward crossing, and
		// halved max_sends_per_hour when the score stayed low. None of it ever
		// reached a person: a webhook arrives only for a tenant who built an
		// integration to receive one, and the throttle was discoverable exactly
		// as often as somebody opened the Deliverability Hub screen. Wired on
		// the returned pointer rather than through server.Deps because only the
		// WORKER half needs it — the HTTP handlers never notify.
		if deliverabilitySurface.Hub != nil {
			deliverabilitySurface.Hub.HealthNotifier = operatorNotifier
			deliverabilitySurface.Hub.CapCoordinator = tieredSendRateLimiter
		}
		apiworkers.StartDeliverabilityHub(outboxCtx, logger, deliverabilitySurface.Hub)
		apiserver.MountSubscriberCampaignInsightRoutes(apiserver.SubscriberCampaignInsightRouteDeps{
			Router: r, Pool: pool, Logger: logger, Store: warehouseObjectStore,
			CampaignLiveDispatch: liveCampaignDispatch,
		})
		tenantGovernance := &apiserver.TenantGovernanceDeps{
			Security:                   securityHandlers,
			SendSettings:               sendSettingsHandlers,
			Paywall:                    paywallDeps,
			OutboxDLQ:                  dlqDeps,
			Feedback:                   feedbackDeps,
			Regions:                    regionsHandlers,
			EmailPreview:               emailPreviewDeps,
			Privacy:                    privacyDeps,
			PrivacyIncidents:           privacyIncidentsDeps,
			PrivacyIncidentIdempotency: privacyIncidentIdempotency,
			Cost:                       costHandlers,
			Billing:                    billingHandlers,
		}
		tenantGovernanceServerDeps := apiserver.Deps{Router: r, Pool: pool, Logger: logger, TenantGovernance: tenantGovernance}
		apiserver.MountTenantPolicyRoutes(tenantGovernanceServerDeps)
		apiserver.MountPrivacyComplianceRoutes(tenantGovernanceServerDeps)
		// Audit sinks retain their independent read/configure/execute scopes and
		// exact position between compliance and commercial administration.
		auditAdminDeps := apiserver.NewAuditSinkAdminDeps(pool, envCipher, envCipher, logger)
		apiserver.MountAuditSinkRoutes(apiserver.Deps{Router: r, AuditSinkAdmin: auditAdminDeps})
		apiserver.MountCommercialAdminRoutes(tenantGovernanceServerDeps)

		// Approvals: human-in-the-loop gate for agent-driven sends. Admin
		// gate enforced inside handler bodies via the resolved User.Role.
		r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Group(func(r chi.Router) {
			approvalsDeps.Mount(r)
		})
		// G20 (campaigns 2026): multi-stage ordered approval chain.
		// Self-scoped routes (admin to define the chain, write_campaigns
		// to decide a stage). The final-stage approval reuses the same
		// resource-unlock hook as the single gate.
		(&approvals.ChainDeps{
			Pool:       pool,
			Logger:     logger,
			OnComplete: approvedHook,
		}).MountChain(r)

		// Pre-send safety check exposed as POST /api/v1/safety/check so SDK
		// clients can run it independently of the embedded send-time hook.
		r.With(apikeys.RequireAllScopes(apikeys.ScopeWriteCampaigns, apikeys.ScopeSendTransactional)).Post("/api/v1/safety/check", safetyDeps.Check)

		// Sandbox campaign status — declared in OpenAPI spec, called by
		// SDK + MCP server. Reads aggregate state from sandbox_events.
		sandboxHandlers := &sandbox.Handlers{Pool: pool, Logger: logger}
		r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get("/api/v1/sandbox/campaigns/{id}/status", sandboxHandlers.Status)

		// Custom Fields registry — declared in OpenAPI spec, called by
		// SDK + MCP server. Reads/writes tenant_custom_fields (RLS).
		customFieldsDeps := &customfields.Deps{Repo: customFieldsRepo}
		r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).Get("/api/v1/custom-fields", customFieldsDeps.List)
		r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Post("/api/v1/custom-fields", customFieldsDeps.Create)
		// Per-tenant validator-mode policy (strict/auto/off). Static "/mode"
		// is registered before the "/{id}" param routes; chi prefers the
		// static segment so these don't collide with Update/Delete by id.
		// READ is open to any member (rendering the settings page); WRITE is
		// admin-only — the mode is a tenant-wide governance policy that gates
		// EVERY subscriber write, so it carries the same ScopeAdmin gate as
		// the sibling workspace/settings governance writes (a WriteSubscribers
		// holder must not be able to flip the whole tenant's validation policy).
		r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).Get("/api/v1/custom-fields/mode", customFieldsDeps.GetMode)
		r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Patch("/api/v1/custom-fields/mode", customFieldsDeps.UpdateMode)
		r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Patch("/api/v1/custom-fields/{id}", customFieldsDeps.Update)
		r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Delete("/api/v1/custom-fields/{id}", customFieldsDeps.Delete)
		// SETC-032: where-used lookup powering the delete dialog's downstream warning.
		r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).Get("/api/v1/custom-fields/{id}/references", customFieldsDeps.References)
		// SUB-015: custom-field soft-limit governance surface. GET reads
		// the resolved limits + live usage; PUT (admin-scoped) overrides the
		// per-tenant caps. Soft-limit enforcement on create lives in the
		// customfields repo (returns 422 on breach).
		customfields.MountSettingsRoutes(r, customFieldsDeps)

		apiserver.MountCRMReferenceRoutes(apiserver.CRMReferenceRouteDeps{Router: r, Pool: pool, Logger: logger})

		tenantHeaders := func(ctx context.Context, h http.Header) {
			if t, ok := middleware.TenantFromContext(ctx); ok {
				h.Set("X-Tenant-ID", t.ID)
				h.Set("X-Postwave-Tenant-ID", t.ID)
			}
		}
		deliverabilityHeaders := newDeliverabilityHeaderWriter(tenantHeaders, stateRepo)
		migrationProxy, voiceProxy, automationProxy, automationAdminProxy := buildServiceProxies(cfg, tenantHeaders)
		automationProxyWithLimits := newAutomationProxyWithLimits(planLimits, automationProxy)
		deliverabilityProxy := func(publicPrefix, upstreamPrefix string) http.Handler {
			return serviceproxy.New(serviceproxy.Options{
				Target:           cfg.DeliverabilityServiceURL,
				PublicPrefix:     publicPrefix,
				UpstreamPrefix:   upstreamPrefix,
				InternalAPIToken: cfg.InternalAPIToken,
				AddHeaders:       deliverabilityHeaders,
			})
		}
		r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Handle("/api/v1/migrations", migrationProxy)
		r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Handle("/api/v1/migrations/*", migrationProxy)
		r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Handle("/api/v1/automations", automationProxyWithLimits)
		r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Handle("/api/v1/automations/*", automationProxy)
		// Admin: trigger one recurrence scan immediately. Useful for
		// testing without waiting for the 24h interval. Returns
		// {processed: <count>}.
		r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).
			Post("/api/v1/admin/automation/recurrence/run", automationAdminProxy.ServeHTTP)
		r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get("/api/v1/voice/sources", voiceProxy.ServeHTTP)
		r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get("/api/v1/voice/profile", voiceProxy.ServeHTTP)
		// G10 (campaigns 2026): operator-authored brand voice profile.
		// Distinct from /voice/profile (auto-extracted corpus) — this
		// row carries operator-curated descriptors, writing rules, and
		// sample snippets that the AI compose endpoints will condition
		// on once the binding refactor lands (G10 follow-up).
		apiserver.MountBrandVoiceRoutes(apiserver.BrandVoiceRouteDeps{Router: r, Pool: pool})
		r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get("/api/v1/voice/templates", voiceProxy.ServeHTTP)
		r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get("/api/v1/voice/templates/{id}", voiceProxy.ServeHTTP)
		r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get("/api/v1/voice/sequences", voiceProxy.ServeHTTP)
		r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get("/api/v1/voice/sequences/{id}", voiceProxy.ServeHTTP)
		r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get("/api/v1/voice/sequences/jobs/{job_id}", voiceProxy.ServeHTTP)
		// Participant projections include subscriber IDs and email addresses,
		// so campaign visibility alone is insufficient: callers must also hold
		// subscriber-read authority.
		r.With(apikeys.RequireAllScopes(apikeys.ScopeReadCampaigns, apikeys.ScopeReadSubscribers)).Get("/api/v1/voice/sequences/{id}/participants", voiceProxy.ServeHTTP)
		// Sequence send performance (SEQ-009): aggregate reached/opened/clicked
		// per email position + a distinct-subscriber rollup. No subscriber IDs
		// or emails are exposed — only counts — so campaign-read authority
		// alone is sufficient (unlike /participants).
		r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get("/api/v1/voice/sequences/{id}/performance", voiceProxy.ServeHTTP)
		// Stuck-participant report (FEATURE-ROADMAP-2026-06): derived
		// read like /participants — items + threshold_days.
		r.With(apikeys.RequireAllScopes(apikeys.ScopeReadCampaigns, apikeys.ScopeReadSubscribers)).Get("/api/v1/voice/sequences/{id}/stuck", voiceProxy.ServeHTTP)
		// Deterministic A/B variant resolution accepts an opaque subscriber ID
		// only in a POST body, keeping identity material out of URLs/referrers.
		// It reads both campaign content and subscriber identity, so both scopes
		// are mandatory for API-key callers.
		r.With(apikeys.RequireAllScopes(apikeys.ScopeReadCampaigns, apikeys.ScopeReadSubscribers)).Post("/api/v1/voice/sequences/{id}/steps/{position}/variant", voiceProxy.ServeHTTP)
		// Whole-sequence draft from a brief — LLM-backed, so it shares the
		// expensive-route limiter with /generate and /regenerate.
		r.With(expensiveTenantLimit.Middleware, apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post("/api/v1/voice/sequences/draft", voiceProxy.ServeHTTP)
		// Corpus membership, remote-source ingestion, and profile rebuilds change
		// the tenant-wide model identity and may trigger external fetch/model cost.
		// Keep these governance operations admin-only; editors can still consume
		// the resulting profile while authoring campaigns.
		r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/voice/sources", voiceProxy.ServeHTTP)
		r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/voice/sources/{id}/ingest", voiceProxy.ServeHTTP)
		r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get("/api/v1/voice/sources/{id}/ingest/{job_id}", voiceProxy.ServeHTTP)
		r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Delete("/api/v1/voice/sources/{id}", voiceProxy.ServeHTTP)
		// Voice profile build + AI generation hit the upstream LLM /
		// voice service per call — capped per-tenant via
		// expensiveTenantLimit so a scripted cookie-session caller
		// can't burn unlimited inference credits.
		r.With(expensiveTenantLimit.Middleware, apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/voice/profile/build", voiceProxy.ServeHTTP)
		r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post("/api/v1/voice/sequences", voiceProxy.ServeHTTP)
		r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Patch("/api/v1/voice/sequences/{id}", voiceProxy.ServeHTTP)
		r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Delete("/api/v1/voice/sequences/{id}", voiceProxy.ServeHTTP)
		r.With(expensiveTenantLimit.Middleware, apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post("/api/v1/voice/sequences/{id}/regenerate/{position}", voiceProxy.ServeHTTP)
		// POST /api/v1/voice/generate is mounted below through aichat's
		// fail-closed PII gateway. It must not use this raw service proxy.
		// Voice drift pre-send check. POST a candidate body + the
		// tenant's voice profile id; receive a 0..100 fidelity score
		// + warn/critical severity. Wired here so the desktop editor
		// can call it before send to surface drift warnings inline.
		// write_campaigns scope because the operator is implicitly
		// in a compose flow.
		// G10 follow-up: enrich the drift request with the tenant's
		// authored brand-voice profile (descriptors + banned terms derived
		// from writing rules) before proxying, so the voice service's
		// authored-rule overlay has real rules to score against. Also maps
		// the desktop's html/text fields onto the body the scorer reads.
		voiceDriftHandler := newVoiceDriftHandler(pool, voiceProxy)
		r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post("/api/v1/voice/drift", voiceDriftHandler)
		r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/voice/templates", voiceProxy.ServeHTTP)
		// On-brand AI template generator — LLM-backed like /sequences/
		// draft, so it sits behind the same expensive-route limiter.
		// write_campaigns (not admin): nothing is persisted; saving the
		// result via POST /templates still requires admin.
		r.With(expensiveTenantLimit.Middleware, apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post("/api/v1/voice/templates/generate", voiceProxy.ServeHTTP)
		r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Patch("/api/v1/voice/templates/{id}", voiceProxy.ServeHTTP)
		r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Delete("/api/v1/voice/templates/{id}", voiceProxy.ServeHTTP)
		// Voice profile labels — operator tone-axis labeling that feeds the
		// trainer corpus. Fully implemented upstream (services/voice
		// internal/labels, Postgres-backed, migration 0092) and mounted at
		// /v1/voice/labels there, but the gateway previously never registered
		// the public proxy routes, so /api/v1/voice/labels 404'd (mobile +
		// desktop label sections fell back to an "unavailable" state). Wire
		// them here so the existing client wrappers reach the upstream.
		// Scopes mirror the rest of the voice surface: read for list,
		// write for create, admin for delete (the upstream also role-gates
		// delete via X-Postwave-Role).
		r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get("/api/v1/voice/labels", voiceProxy.ServeHTTP)
		r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get("/api/v1/voice/labels/export.json", voiceProxy.ServeHTTP)
		r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post("/api/v1/voice/labels", voiceProxy.ServeHTTP)
		r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Delete("/api/v1/voice/labels/{id}", voiceProxy.ServeHTTP)
		// Inbox Reality split into two surfaces as of migration 0108:
		//   • /api/v1/inbox-reality/campaigns/{id}  → proxied to the
		//     deliverability service (read-only campaign report).
		//   • /api/v1/inbox-reality/{tests,providers}  → handled in-process
		//     by apps/api/internal/inboxreality (on-demand tests, mounted
		//     below the proxy line). Narrowing the proxy prefix from the
		//     previous wildcard prevents the proxy from swallowing the
		//     new in-process routes.
		r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Handle("/api/v1/inbox-reality/campaigns/*", deliverabilityProxy("/api/v1/inbox-reality", "/v1/inbox-reality"))
		{
			irDeps := inboxRealityRuntime.Deps
			if irDeps != nil {
				r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get("/api/v1/inbox-reality/providers", irDeps.ListProviders)
				// Inbox-reality CreateTest fires real outbound mail to
				// seed mailboxes — per-tenant rate cap protects the
				// shared seed quota (audit finding H5).
				r.With(veryExpensiveTenantLimit.Middleware, apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post("/api/v1/inbox-reality/tests", irDeps.CreateTest)
				r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get("/api/v1/inbox-reality/tests", irDeps.ListTests)
				r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get("/api/v1/inbox-reality/tests/{id}", irDeps.GetTest)
				r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post("/api/v1/inbox-reality/tests/{id}/cancel", irDeps.CancelTest)
			}
		}
		// Sunset policies. The detector uses Postgres-backed subscriber,
		// engagement, suppression, and tag data; the in-memory store is only
		// a boot-time fallback if the pool is unavailable. The reengagement
		// preview endpoint is a pure-function template generator.
		{
			polStore, err := sunset.NewPostgresPolicyStore(pool)
			if err != nil {
				logger.Warn("sunset: policy store unavailable", "err", err.Error())
			} else {
				// SubscriberStore: Postgres impl joining subscribers ←
				// subscriber_events (last engagement) and filtering on
				// excluded tags + existing suppressions. Falls back to the
				// in-memory fake only if the pool is unavailable.
				var subs sunset.SubscriberStore
				if pgSubs, serr := sunset.NewPostgresSubscriberStore(pool); serr == nil {
					subs = pgSubs
				} else {
					logger.Warn("sunset: pg subscriber store unavailable; using memory fake", "err", serr.Error())
					subs = sunset.NewMemorySubscriberStore()
				}
				sunEngine := sunset.NewEngine(polStore, subs)
				sunEngine.History = tagsHistory
				sunDeps := &sunset.Deps{
					Engine:   sunEngine,
					Policies: polStore,
				}
				r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Get("/api/v1/sunset/policies", sunDeps.ListPolicies)
				r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/sunset/policies", sunDeps.CreatePolicy)
				r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Get("/api/v1/sunset/policies/{id}", sunDeps.GetPolicy)
				r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Put("/api/v1/sunset/policies/{id}", sunDeps.UpdatePolicy)
				r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Delete("/api/v1/sunset/policies/{id}", sunDeps.DeletePolicy)
				r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/sunset/policies/{id}/run", sunDeps.RunPolicy)
				r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get("/api/v1/sunset/policies/{id}/executions", sunDeps.ListExecutions)
				r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Post("/api/v1/sunset/reengagement/preview", sunDeps.PreviewReengagement)
			}
		}
		r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Handle("/api/v1/reputation", deliverabilityProxy("/api/v1/reputation", "/v1/reputation"))
		// INBOX-031: reputation trend. Distinct exact path (the /reputation
		// route above matches only the collection root, not sub-paths), so
		// the history series needs its own registration. Same read scope as
		// the point-in-time reputation read it charts.
		r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Handle("/api/v1/reputation/history", deliverabilityProxy("/api/v1/reputation/history", "/v1/reputation/history"))
		r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Handle("/api/v1/auth-checks", deliverabilityProxy("/api/v1/auth-checks", "/v1/auth-checks"))
		// DMARC aggregate-report monitoring (INBOX-032). The upstream serves
		// the list/detail/stats under /v1/dmarc/reports, /v1/dmarc/reports/{id},
		// and /v1/dmarc/stats — all sub-paths — so a single /* glob covers
		// them. There is deliberately no bare /api/v1/dmarc collection route
		// (the upstream has no /v1/dmarc handler); the real list is
		// /api/v1/dmarc/reports.
		r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Handle("/api/v1/dmarc/*", deliverabilityProxy("/api/v1/dmarc", "/v1/dmarc"))
		r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Handle("/api/v1/diagnose/*", deliverabilityProxy("/api/v1/diagnose", "/v1/diagnose"))
		// /api/v1/predict goes through the EQ-history enrichment
		// handler instead of the raw proxy. The handler injects the
		// tenant's rolling-30-day EQ-Score average into the request
		// body so the deliverability service's placement predictor
		// can weight engagement risk by discipline pattern.
		predictEnrichDeps := &predictenrich.Deps{
			Pool:            pool,
			UpstreamBaseURL: cfg.DeliverabilityServiceURL,
			UpstreamPath:    "/v1/predict",
			InternalToken:   cfg.InternalAPIToken,
		}
		r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Post("/api/v1/predict", predictEnrichDeps.Handler())

		// AI Compose v2: unified pre-send verdict. Fans out to EQ
		// Score (in-process) + voice drift + placement predictor in
		// parallel and returns a single verdict { ok | warn |
		// critical } the editor's send-confirmation banner gates on.
		preSendDeps := &presend.Deps{
			Pool:                pool,
			VoiceServiceURL:     cfg.VoiceServiceURL,
			PredictorServiceURL: cfg.DeliverabilityServiceURL,
			InternalToken:       cfg.InternalAPIToken,
		}
		campaignAssuranceGateConvergence.applyPreSend(preSendDeps)
		presend.MountRoutes(r, preSendDeps)
		r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Handle("/api/v1/render", deliverabilityProxy("/api/v1/render", "/v1/render"))

		// Campaign sends are mounted below through server-owned send and queue
		// helpers. Both run compliance, approval, sandbox,
		// warmup, and idempotency controls before live dispatch.
	})

	// Idempotency-protected mutating routes. The middleware is applied
	// per-route (not globally) so GETs are never accidentally cached. Routes
	// whose handlers live in restricted packages register their handler in
	// the relevant Mount call above; we re-bind them here through a
	// dedicated Group + per-method With-chain so the wrapper actually fires.
	idempotentRoutes := buildIdempotentRoutesMiddleware(idempotencyRepo, resolveTenantID, resolveIdempotencyReplayScope)
	var idempotentMountErr error
	r.Group(func(r chi.Router) {
		// Path-conditional SMS PII guard must run before auth/idempotency/rate/
		// budget middleware so early refusals carry the same no-store/nosniff
		// contract as successful inbox/broadcast responses.
		r.Use(consent.ProtectSensitiveResponses)
		// Authenticated group 2/2: the idempotency-protected write surface.
		authenticatedRoutes.apply(r)
		// Step-up re-authentication, same construction as the first
		// authenticated group. This group carries routes that stepup/policy.go
		// declares (POST /api/v1/scim/tokens mints a bearer that can create and
		// delete workspace people), so leaving the middleware off here meant the
		// declared requirement was never consulted for them. Mounted BEFORE
		// idempotentRoutes for the reason recorded at the first mount: the
		// idempotency layer caches 4xx against the Idempotency-Key, so a
		// challenge issued after it would be replayed even once the user proved
		// themselves.
		r.Use(stepup.Middleware(func(ctx context.Context, userID string) (bool, error) {
			_, confirmed, err := authRepo.TOTPSecretState(ctx, userID)
			return confirmed, err
		}))
		r.Use(middleware.CostHeaderMiddleware(
			cost.WithRunningTotal,
			cost.RunningTotalCents,
			budgetIncrementer,
		))
		r.Use(idempotentRoutes)
		r.Use(middleware.AuditMiddleware(pool))
		r.Use(budgets.Middleware(budgetRepo))
		// p4d-recordsurface-wire-others: idempotency-protected form creation is a
		// content-authoring operation, aligned with form updates and the editor role.
		r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post("/api/v1/forms", observability.RecordSurfaceFunc("forms", "create", formsDeps.Create))
		// GAP-LS-134: POST /api/v1/lists belongs inside the idempotency
		// group. A retried Create without dedup mints a second list
		// upstream (Listmonk has no per-tenant unique name constraint),
		// leaving orphaned bigint ids in audience_list_id columns.
		// Reconstructed here because the outer Deps lives in a sibling
		// r.Group scope — same pattern paid_tiers uses below.
		idemListsDeps := lists.New(cfg.ListmonkURL, cfg.ListmonkUser, cfg.ListmonkPassword)
		idemListsDeps.Destination = listmonkClient.Destination
		idemListsDeps.Repo = &lists.Repo{
			Pool:               pool,
			MembershipWebhooks: listMembershipWebhooks,
		}
		idemListsDeps.Logger = logger
		apiserver.MountIdempotentListRoutes(apiserver.Deps{Router: r, IdempotentLists: idemListsDeps})
		// Idempotency inspector + replay surface. Read-only endpoints
		// for browsing the cache, plus an admin-only DELETE for purging
		// stuck-pending claims. Replay returns the cached response to
		// the operator (does NOT re-execute the upstream handler).
		idempotency.MountInspectorRoutes(r, &idempotency.InspectorDeps{Pool: pool})
		// Campaign Assurance mutations require the shared durable HTTP
		// idempotency boundary in addition to request_id replay fences in the
		// assurance repository and exact command queue.
		campaignAssuranceRuntime.MountWrite(r)
		// Complete campaign mutation and pre-send preview block. The adjacent
		// reply/translation/summary routes intentionally remain after it.
		apiserver.MountCampaignMutationRoutes(apiserver.Deps{
			Router:    r,
			Campaigns: campaignDeps,
			CampaignAudienceCount: &campaigns.AudienceCountDeps{
				Audience: newAudienceCounter(pool),
				Logger:   logger,
			},
			CampaignSendPreview: &campaigns.SendPreviewDeps{
				Repo:         campaignDeps.Repo,
				Audience:     newAudienceCounter(pool),
				Warmup:       newWarmupGate(warmupTracker),
				Suppressions: suppressionsStore,
			},
		})
		// G3 (campaigns 2026): per-campaign reply list. Reads
		// inbound_emails by campaign_id (already populated by the
		// inbound MX route when In-Reply-To matches an outgoing
		// campaign's Message-ID). Intent classification + Quote-a-
		// reply editor block live in G3 follow-ups.
		campaign_replies.MountRoutes(r, &campaign_replies.Deps{
			Pool:             pool,
			IntentClassifier: campaign_replies.NewAIIntentClassifier(aicompose.NewHTTPVoiceClient(cfg.VoiceServiceURL, cfg.InternalAPIToken)),
			Logger:           logger,
		})
		// F05 manual reply adapter. campaign_replies.source has accepted
		// 'manual' since 0087 with nothing writing it, so a reply that reached
		// the team out of band — forwarded, or read in a shared inbox — was
		// invisible to every reply surface. It writes through the SAME canonical
		// store as the provider webhooks, so classification, quote stripping and
		// the evidence receipt all apply; it is recorded as an operator
		// ASSERTION and cannot emit canonical engagement.
		replies.MountManualRoutes(r, canonicalRepliesStore, logger)
		// ASSURE#8 — the tenant-facing half of the F05 IMAP registry. Migration
		// 1975's table, its RLS and the poller all shipped and no route did, so
		// connecting a reply mailbox meant writing SQL by hand. The migration's
		// tenant policy comment says it exists "to permit the tenant INSERT" —
		// a policy written for a caller that did not exist until now. Reads are
		// read:reports; every write is admin. No credential transits it: the two
		// secret fields are REFERENCES resolved at poll time.
		replies.MountMailboxAdminRoutes(r, &replies.MailboxAdminDeps{
			Store:  &replies.MailboxStore{Pool: pool},
			Logger: logger,
		})
		// G19 (campaigns 2026): per-campaign multi-language variant matrix
		// (operator-authored subject+body per locale). CRUD only; queue-
		// fill routing + per-locale report are follow-ups.
		campaign_translations.MountRoutes(r, &campaign_translations.Deps{
			Pool:   pool,
			Logger: logger,
		})
		// G17 (campaigns 2026): persistent AI post-send summary.
		// Deterministic template renderer in v1 — voice-service round
		// trip is a G17 follow-up that flips source=voice when
		// configured. The persisted row makes reopening the slideover
		// cheap and gives the operator an audit trail.
		campaign_summary.MountRoutes(r, &campaign_summary.Deps{
			Pool:   pool,
			Voice:  aicompose.NewHTTPVoiceClient(cfg.VoiceServiceURL, cfg.InternalAPIToken),
			Logger: logger,
		}, expensiveTenantLimit.Middleware)
		// SUB-058: per-subscriber LLM profile summary with explainability +
		// 24h cache. GET /api/v1/subscribers/{id}/ai-summary collects 30d
		// signals from the timeline + predictive tables, checks the 24h
		// cache, generates a narrative via the voice/LLM gateway (or falls
		// back to a deterministic template when unavailable), writes an
		// explainability audit row, and upserts the cache. Gen is left nil
		// here so the surface ships on the deterministic renderer until the
		// voice round-trip is wired (identical wire shape, source differs).
		profile_summary.MountRoutes(r, &profile_summary.Deps{
			Pool:   pool,
			Logger: logger,
		})
		apiserver.MountCampaignComposeRoutes(apiserver.Deps{Router: r, Campaigns: campaignDeps})
		// AI broadcast composer. Fans out to the voice service to turn a
		// 1-line brief into a draft + N subject variants ready for A/B
		// testing. Mounted in the write-scope block because the canonical
		// downstream action is "create a campaign draft". Returns 503 if
		// the voice service is unreachable.
		// Per-tenant rate cap on AI compose: each call fans out to the
		// voice / LLM service (real $$ per request). Audit finding H6.
		r.Group(func(r chi.Router) {
			r.Use(expensiveTenantLimit.Middleware)
			// SUB-072: every production AI authoring call shares one fail-closed
			// privacy boundary. The request-scoped sanitizer loads the tenant's PII
			// policy, detects high-confidence identifiers in the actual bounded
			// prompt/context, tokenizes them before model egress, and restores the
			// response. Policy reads or detection failures block the upstream call;
			// there is no unwrapped retry. This client backs Chat, Compose, Subject
			// Lab, and the subject-line assistant.
			aiVoiceGatewayRepo := &pii_gateway.Repo{Pool: pool}
			aiVoiceClient := aicompose.NewStrictTextGatewayVoiceClient(
				aicompose.NewHTTPVoiceClient(cfg.VoiceServiceURL, cfg.InternalAPIToken),
				aicompose.StrictTextSanitizerFactoryFunc(func(
					ctx context.Context,
					tenantID, salt, prompt, contextText string,
				) (pii_gateway.Sanitizer, error) {
					return aiVoiceGatewayRepo.StrictTextSanitizerForTenant(
						ctx,
						tenantID,
						salt,
						prompt,
						contextText,
					)
				}),
			)
			aichat.Mount(r, &aichat.Deps{Voice: aiVoiceClient, Logger: logger, VoiceNotDeployed: cfg.VoiceServiceURL == ""})
			aiComposer := aicompose.New(aiVoiceClient)
			aiComposer.BrandVoice = aicompose.BrandVoiceLoaderFunc(func(ctx context.Context, tenantID string) (*aicompose.BrandVoiceProfile, error) {
				p, err := brand_voice.LoadActive(ctx, pool, tenantID)
				if err != nil || p == nil {
					return nil, err
				}
				return &aicompose.BrandVoiceProfile{
					ID:             p.ID,
					Descriptors:    p.Descriptors,
					WritingRules:   p.WritingRules,
					SampleSnippets: p.SampleSnippets,
				}, nil
			})
			aicompose.MountRoutes(r, &aicompose.Deps{Composer: aiComposer})
			// G11 (campaigns 2026): Subject Lab — axis-conditioned variant
			// generation + tenant-baseline scoring. Shares the same
			// expensive-LLM rate-limit middleware as aicompose since
			// /variants delegates to the same composer.
			subject_lab.MountRoutes(r, &subject_lab.Deps{Pool: pool, Composer: aiComposer})
			// sto-ai-copywriter-subject-lines: Klaviyo-style "brief →
			// 3 candidates" assistant + per-tenant top-performers
			// panel. Mounted under the same expensive-LLM rate-limit
			// middleware as the other LLM fan-out endpoints since
			// each generate call is N concurrent voice-service calls.
			ai_subject_lines.MountRoutes(r, &ai_subject_lines.Deps{
				Pool:     pool,
				Composer: aiComposer,
			})
		})
		// BYOK (Bring-Your-Own-Key) tenant KMS registry. The registry
		// is wired with the platform's AWS KMS client when one is
		// available so tenants can immediately HealthCheck + activate
		// aws-backed keys against the same AWS account the platform
		// already authenticates to. Deployments that don't run AWS get
		// an empty registry — HealthCheck will return "unknown
		// provider 'aws'", which is the correct surface for an
		// operator who hasn't wired credentials. GCP/Vault/Tink follow
		// the same pattern (build pwkms.Provider → reg.Register); see
		// byok/awsadapter.go for the shape.
		byokRegistry := byok.BuildRegistry(byokAWSClient(awsCfg, kmsKeyID))
		byokRepo := &byok.Repo{Pool: pool}
		// Background re-encryption sweep. Re-wraps existing v=0x03
		// blobs from any tenant's old (inactive) KEK to its current
		// active KEK so the operator can eventually retire the old
		// key in their provider. The sweep is column-driven: it ONLY
		// touches (table, blob_column) pairs explicitly registered
		// via Reencryptor.RegisterColumn. The encrypted tenant LLM
		// credential is registered below, and deletion is blocked while
		// any blob still embeds an inactive key's id.
		byokReencryptor := &byok.Reencryptor{
			Pool: pool,
			Repo: byokRepo,
			Cipher: byok.NewComposite(
				byok.NewTenantCipher(byokRepo, byokRegistry),
				nil, nil, // platform cipher + legacy KEK not needed: v=0x03 only
			),
		}
		if err := byokReencryptor.RegisterColumn(byok.EncryptedColumn{
			Table:     "ai_llm_provider_config",
			IDCol:     "tenant_id",
			BlobCol:   "api_key_ciphertext",
			TenantCol: "tenant_id",
		}); err != nil {
			idempotentMountErr = fmt.Errorf("register BYOK encrypted column: %w", err)
			return
		}
		byok.MountRoutes(r, &byok.Deps{
			Repo:       byokRepo,
			Registry:   byokRegistry,
			Retirement: byokReencryptor,
		})
		safego.Go(logger, "byok-reencrypt-sweeper", func() {
			byokReencryptor.Run(outboxCtx)
		})
		// Blocklist monitor read API. The continuous writer runs in
		// services/deliverability (see blacklist.Worker); apps/api
		// surfaces the per-tenant view + the manual "suppress now"
		// affordance. Automatic action is opted into per workspace through
		// blocklist_settings and defaults to off.
		blocklist.MountRoutes(r, &blocklist.Deps{
			Pool:   pool,
			Logger: logger,
		})
		// SCIM admin surfaces (token mint/revoke + role mapping CRUD).
		// The SCIM provisioning endpoints themselves are mounted on
		// the unauthenticated outer router — they carry their own
		// Bearer auth.
		apiserver.MountSCIMAdminRoutes(apiserver.Deps{
			Router:    r,
			SCIMAdmin: &scim.Deps{Pool: pool},
		})
		// Dedicated IP assignments + per-pool reputation snapshots.
		// Pro/Reputation-tier customers list their assigned IPs and
		// inspect health via /api/v1/sending/dedicated-ips. The
		// snapshot worker below refreshes ip_reputation_snapshots on
		// a 10min cadence and auto-rotates halted IPs to 'draining'.
		apiserver.MountDedicatedIPRoutes(apiserver.Deps{Router: r, Pool: pool})
		// A/B test create endpoint — desktop SubjectLineSuggestions
		// "A/B test all three" CTA posts here. Creates a parent
		// `ab_test` campaign in draft + N child campaigns sharing the
		// audience/body but with distinct subjects. See
		// internal/campaigns/ab_test.go for the metadata shape.
		apiserver.MountCampaignABCreateRoutes(apiserver.Deps{Router: r, Campaigns: campaignDeps})
		// Real send orchestrator: hands the campaign off to Listmonk's
		// /api/campaigns + flips its status to running. Local row goes
		// to "sending"; the listmonk-events webhook drives the final
		// "sent" flip when Listmonk reports completion.
		apiserver.MountCampaignSendRoutes(apiserver.Deps{
			Router:    r,
			Campaigns: campaignDeps,
			CampaignSend: &campaigns.SendDeps{
				Sender:      listmonkClient,
				Warmup:      newWarmupGate(warmupTracker),
				Audience:    newAudienceCounter(pool),
				DefaultFrom: os.Getenv("POSTWAVE_DEFAULT_FROM_EMAIL"),
			},
		})
		// Public transactional email API (Resend parity): POST /api/v1/emails
		// (+ /batch) fire a single message via the SES mailer with cc/bcc/
		// reply-to/headers/tags/attachments/scheduled_at; suppression is checked
		// per recipient. Idempotency-Key replays (inside this group). GET status
		// routes are mounted read-scoped just below.
		txEmailDeps := &transactional.Deps{
			Mailer:      authMailer,
			Repo:        &transactional.Repo{Pool: pool},
			Suppression: txSuppressionChecker{conv: suppressions.NewConverger(suppressionsStore, logger)},
			// Anti cross-tenant From-spoofing: the From domain must be a verified
			// sending identity of the tenant (mirrors the campaigns gate).
			FromVerify:       &transactional.SendingIdentityVerifier{Pool: pool},
			DefaultFrom:      os.Getenv("POSTWAVE_DEFAULT_FROM_EMAIL"),
			Logger:           logger,
			Allowance:        managedSendAllowance,
			RequireAllowance: true,
		}
		r.With(apikeys.RequireScope(apikeys.ScopeSendTransactional)).Group(func(r chi.Router) {
			transactional.MountSendRoutes(r, txEmailDeps)
		})
		r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Group(func(r chi.Router) {
			transactional.MountReadRoutes(r, txEmailDeps)
		})
		if os.Getenv("POSTWAVE_DISABLE_TRANSACTIONAL_SCHEDULE_WORKER") != "1" {
			txEmailWorker := &transactional.Worker{Deps: txEmailDeps, Logger: logger}
			safego.Go(logger, "transactional-schedule-worker", func() { txEmailWorker.Run(outboxCtx) })
		}
		// SMTP submission relay (Resend-style drop-in): a customer points their
		// app's SMTP client here and AUTHs with their API key as the password.
		// Off unless POSTWAVE_SMTP_RELAY_ADDR is set (it needs an NLB, not the
		// HTTP ALB). AUTH requires TLS unless ALLOW_INSECURE=1 (TLS-terminating NLB).
		if smtpAddr := strings.TrimSpace(os.Getenv("POSTWAVE_SMTP_RELAY_ADDR")); smtpAddr != "" {
			smtpRelay := smtprelay.New(&smtprelay.Backend{
				Verify: smtpKeyVerifier{resolver: apiKeyResolver, cache: apiKeyAuthCache},
				Sender: txEmailDeps,
				Logger: logger,
			}, smtprelay.Config{
				Addr:          smtpAddr,
				Domain:        os.Getenv("POSTWAVE_SMTP_RELAY_DOMAIN"),
				AllowInsecure: os.Getenv("POSTWAVE_SMTP_RELAY_ALLOW_INSECURE") == "1",
				Logger:        logger,
			})
			safego.Go(logger, "smtp-relay", func() { smtpRelay.Run(outboxCtx) })
		}
		// Mounted inside the idempotent group: retried POSTs would
		// otherwise double-enqueue audience rows or fire real outbound
		// SMS twice. With Idempotency-Key, the second call replays the
		// first response byte-for-byte.
		apiserver.MountCampaignQueueRoutes(apiserver.Deps{Router: r, Campaigns: campaignDeps})
		// Pass the per-tenant rate-limit middleware through so SMS
		// test-send can't be spammed by a cookie-session caller
		// (budgets middleware bypasses cookie auth — audit H8).
		smsDeps.MountIdempotentRoutes(r, veryExpensiveTenantLimit.Middleware)
		apiserver.MountSubscriberWriteRoutes(apiserver.Deps{Router: r, Subscribers: subscriberDeps})

		// ----- onboarding -----
		// Sample-data seed/remove endpoints. Visible to admin-role only
		// at the UI layer (Settings page guards with useCanAdmin); the
		// API itself is tenant-scoped via TenantMiddleware so
		// cross-tenant seeding is impossible. Idempotent — re-running
		// against an already-seeded tenant returns the cached counts
		// without inserting duplicates. The Remove counterpart deletes
		// rows by sentinel marker (custom_fields.sample = 'true' /
		// delivery_settings.sample = 'true') so it never touches the
		// operator's real data.
		onboardingDeps := &onboarding.Deps{Seeder: onboarding.NewSeeder(pool), Logger: logger}
		// Status read (desktop-audit gap A29): replaces the desktop's
		// per-device localStorage "sample data loaded" flag with the
		// workspace marker in tenants.metadata. Read-only, so it is
		// open to any authenticated tenant principal — no admin gate.
		r.Get("/api/v1/onboarding/sample-data", onboardingDeps.Status)
		r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).
			Post("/api/v1/onboarding/sample-data", onboardingDeps.Seed)
		r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).
			Delete("/api/v1/onboarding/sample-data", onboardingDeps.Remove)
	})
	if idempotentMountErr != nil {
		return idempotentMountErr
	}

	// Public form definitions are read-only and are fetched server-side by the
	// hosted web renderer, so many legitimate visitors can share one API-visible
	// egress IP. Keep renders in a bounded, distributed namespace that cannot
	// consume (or replenish) the anti-abuse budgets on submit, confirm, or upload.
	r.With(publicFormsLimits.render.Middleware, httpcache.Conditional()).
		Get("/api/public/forms/{slug}", observability.RecordSurfaceFunc("forms", "public_get", formsDeps.PublicGet))
	r.With(publicFormsLimits.render.Middleware, httpcache.Conditional()).
		Get("/api/public/forms/{slug}/embed", observability.RecordSurfaceFunc("forms", "public_embed", publicFormEmbed.PublicEmbed))
	r.With(publicFormsLimits.submit.Middleware).
		Post("/api/public/forms/{slug}/submit", observability.RecordSurfaceFunc("forms", "ingest", formsDeps.PublicSubmit))
	r.With(publicFormsLimits.confirm.Middleware).
		Get("/api/public/forms/confirm/{token}", observability.RecordSurfaceFunc("forms", "public_confirm", formsDeps.PublicConfirm))
	r.With(publicFormsLimits.upload.Middleware).
		Post("/api/public/forms/{slug}/upload-url", observability.RecordSurfaceFunc("forms", "public_upload_url", formsUploads.HandlePresignRequest))

	// HMAC-authenticated machine ingest uses a dedicated rate-limit namespace;
	// mounting it outside the shared public group prevents a busy public page,
	// OAuth callback, or form from consuming the sender's delivery budget.
	inboundWebhookDeps.MountPublicRoutes(r.With(inboundWebhookRateLimit.Middleware))

	// Signed server-to-server conversion ingest resolves its tenant from the
	// key-bound HMAC, not from a dashboard session or caller-supplied tenant
	// header. Root-mount it so the legacy public group's conditional-cache
	// middleware can never cache a revenue receipt. It still receives the
	// configured public abuse limiter, and uses the same production envelope
	// cipher / legacy-KEK fallback as the rest of the secret-at-rest surface.
	conversions.MountSignedIngestRoutes(
		r.With(
			httpcache.WithPolicy(httpcache.Mutation()),
			publicRateLimit.Middleware,
		),
		&conversions.SignedIngestDeps{
			Repo: &conversions.Repo{
				Pool:      pool,
				Cipher:    envCipher,
				LegacyKEK: cfg.SendingKEK,
			},
			Logger: logger,
		},
	)

	// Vanity campaign paths (PRD F04). /go/{slug} is a public redirect that
	// records campaign-level request/linkage evidence for a shared path. A request
	// may be crawled, prefetched, or forwarded; it proves neither recipient
	// identity, direct navigation, human attention, nor readership.
	//
	// Its OWN group, deliberately outside the conditional-cache group below. A
	// 302 that a cache may revalidate swallows the second request, and the
	// campaign is then credited once for two requests. The request receipt is the
	// entire point of the route, so caching it defeats the feature rather than
	// merely making it stale.
	r.Group(func(r chi.Router) {
		r.Use(publicRateLimit.Middleware)
		coderedemption.MountPublicVanityRoutes(r, &coderedemption.VanityDeps{
			Repo:   &coderedemption.VanityRepo{Pool: pool},
			Logger: logger,
		})
	})

	// Single-use action links are bearer-authenticated, not session/API-key
	// authenticated. Keep them outside authenticatedRoutes so a recipient can
	// preview and redeem from email, Slack, or push. The response guard runs
	// before the abuse limiter so every outcome, including 429, is no-store.
	r.Group(func(r chi.Router) {
		r.Use(actionticket.ProtectResponses)
		r.Use(actionTicketRateLimit.Middleware)
		apiserver.MountActionTicketRoutes(r, pool, logger,
			productionActionTicketExecutor{
				Approvals: approvalsDeps.Service,
				Offers:    canonicalOffersRepo,
			}.Perform)
	})

	// Preference tokens are high-entropy, recipient-bound capabilities. Keep the
	// entire hosted preference family outside the shared 10/min/IP public bucket:
	// RFC 8058 providers legitimately fan out through a small egress pool, while
	// human GET/POST traffic is proxied by the web tier and can collapse onto one
	// NAT address. One indexed capability lookup bounds invalid traffic; request
	// body caps bound mutations, and platform-wide WAF/concurrency controls still
	// apply. Every outcome is private/no-store and bypasses Conditional.
	prefPublic := &preferences.Deps{
		Repo: &preferences.Repo{Pool: pool},
		// RFC 8058 suppression and subscriber.unsubscribed delivery intent
		// commit atomically. A successful public response therefore cannot
		// lose the customer webhook during a process crash.
		OneClickSuppressor: oneClickSuppressorAdapter{
			pool: pool, fanout: canonicalWebhookFanout,
		},
	}
	r.Group(func(r chi.Router) {
		r.Use(consent.ProtectSensitiveResponses)
		r.With(httpcache.WithPolicy(httpcache.Mutation())).
			Post("/api/public/preferences/{token}/one-click", prefPublic.PublicOneClickUnsubscribe)
		r.With(httpcache.WithPolicy(httpcache.Mutation())).
			Get("/api/public/preferences/{token}", prefPublic.PublicLookup)
		r.With(httpcache.WithPolicy(httpcache.Mutation())).
			Post("/api/public/preferences/{token}", prefPublic.PublicUpdate)
		r.With(httpcache.WithPolicy(httpcache.Mutation())).
			Post("/api/public/preferences/{token}/frequency", prefPublic.PublicSmartUnsubscribe)
	})

	// DSA Art. 16 notice and action. Unauthenticated on purpose: the
	// Regulation requires the mechanism to be usable by "any individual or
	// entity", so a session gate here would exclude exactly the people it
	// exists for. It shares the public abuse limiter, caps its body, and is
	// write-plus-own-receipt-read only — the status lookup returns one
	// notifier's own outcome and nothing about any other report.
	r.Group(func(r chi.Router) {
		r.Use(publicRateLimit.Middleware)
		r.Use(httpcache.WithPolicy(httpcache.Mutation()))
		contentreports.MountPublicRoutes(r, &contentreports.Deps{
			Repo:   &contentreports.Repo{Pool: pool, Logger: logger},
			Logger: logger,
		})
	})

	buildPublicArchiveDepsOut := buildPublicArchiveDeps(pool, logger, cfg)
	archiveRepoPublic := buildPublicArchiveDepsOut.archiveRepoPublic
	archivePublicBase := buildPublicArchiveDepsOut.archivePublicBase
	archiveWallResolverRepo := buildPublicArchiveDepsOut.archiveWallResolverRepo
	archivePublicDeps := buildPublicArchiveDepsOut.archivePublicDeps
	// Public archive READS are fetched server-side by the hosted web
	// renderer (apps/web/src/lib/archive-api.ts), so every visitor of every
	// tenant's archive arrives at the API from the web tier's single egress
	// IP. Charging them to the shared 10/min/IP public bucket lets ~11
	// requests a minute from one anonymous client 429 the archive of every
	// tenant on the platform — the same egress-collapse the forms render
	// surface already carves out (publicFormRenderRequestsPerMinute). Give
	// the render routes the same traffic-shaped budget in their own
	// namespace, mounted outside the legacy group, and keep the
	// credential-bearing unlock POST on the human-shaped budget inside it.
	archiveRenderRateLimitOptions := rateLimitOptions
	archiveRenderRateLimitOptions.Namespace = "ip:archive-render"
	archiveRenderRateLimit := middleware.NewRateLimitWithOptions(
		archiveRenderRequestsPerMinute,
		time.Minute,
		archiveRenderRateLimitOptions,
	)
	archivePublicDeps.MountPublicRenderRoutes(r.With(
		consent.ProtectSensitiveResponses,
		archiveRenderRateLimit.Middleware,
		httpcache.Conditional(),
		httpcache.WithPolicy(httpcache.PublicArchive()),
	))

	// Remaining public routes — no auth and no tenant context. These retain the
	// legacy shared 10 req/min budget; Forms owns dedicated route-shaped budgets
	// above because its render and ingest traffic have different threat models.
	r.Group(func(r chi.Router) {
		// Public consent refusals (including rate-limit responses) carry the same
		// no-store/Vary contract as successful decisions. Keep this route-scoped
		// guard outside the shared limiter and conditional-cache middleware.
		r.Use(consent.ProtectSensitiveResponses)
		r.Use(publicRateLimit.Middleware)
		// Conditional GET for public surfaces (archive, podcast feed,
		// status). archive/podcast handlers emit
		// their own ETag; Conditional honours those and synthesises a
		// weak tag for the rest. No tenant context here — these
		// payloads are public-shared so a cross-tenant cache hit is by
		// design (every response is built from public-visible data).
		r.Use(httpcache.Conditional())
		publicOnsiteGrowthDeps := &onsite_growth.Deps{Repo: onsiteGrowthRepo}
		if discounts.CouponAllocationAvailable {
			publicOnsiteGrowthDeps.CouponAssigner = onsiteCouponAssigner{Repo: discountsRepo}
		}
		onsite_growth.MountPublicRoutes(r, publicOnsiteGrowthDeps)
		compat.MountPublic(r, compatDeps)

		// Polls and RSVP (PRD F14). GET previews, POST records — the split IS the
		// prefetch mitigation, so it only exists once these two routes do.
		// Unauthenticated by design: a recipient clicking from an email has no
		// session, and the per-(recipient, option) token is the credential.
		// Offers (PRD F15). The public path is always explicit: while release is
		// held it returns a stable no-store 503, and only the package-owned
		// PublicResolutionAvailable gate can replace that hold with the
		// content-negotiated resolver. UUID uniqueness is lookup identity, not
		// authorization to disclose a tenant-authored row.
		offers.MountPublicRoutes(r, &offers.Deps{
			Repo:           canonicalOffersRepo,
			Logger:         logger,
			TenantResolver: newOfferTenantResolver(pool),
		})
		if pollRuntimeConfiguration.Enabled {
			if mountErr := polls.MountPublicRoutes(r, &polls.Deps{
				Repo: campaignPollRepo, Logger: logger, Classifier: campaignPollClassifier,
			}); mountErr != nil {
				// Configuration was validated before dependencies were created. If
				// that invariant ever drifts, leave the public surface absent.
				logger.Error("campaign polls: refusing to mount", "err", mountErr.Error())
			}
		}
		// Public consent ingest (cookie-banner POST target). Writes a
		// visitor-scoped row to consent_events for every essential /
		// analytics / marketing category in the submitted prefs and
		// stamps the Sec-GPC header into preferences.gpc. IP rate-
		// limited via the public group. Tenant identity is resolved from a
		// public pwk_ site key; subscriber email/proof fields are rejected.
		consentSiteRepo := &conversions.Repo{Pool: pool}
		consentPolicyVersion := cmpOr(strings.TrimSpace(os.Getenv("POSTWAVE_CONSENT_POLICY_VERSION")), "v1")
		consent.MountPublicRoutes(r, &consent.Deps{
			Pool:                    pool,
			Logger:                  logger,
			TrustForwardedIPHeaders: cfg.TrustForwardedIPHeaders,
			ResolveSiteKey: func(ctx context.Context, siteKey string) (string, string, error) {
				tenantID, err := consentSiteRepo.ResolveTenantByKey(ctx, siteKey)
				return tenantID, consentPolicyVersion, err
			},
		})

		// The public affiliate offer is intentionally not mounted. Commission,
		// attribution, payout, tax, and legal terms are not approved, so source
		// presence must not create an application or tracking surface. The
		// platform-global admin tree and billing attribution/reversal adapters
		// are also detached until a reviewed operator and reconciliation model
		// exists.

		// Conversion tracking ingestion — pixel + JSON.
		// Auth via per-tenant tracking key (see conversions package).
		// Shares the public 10/min IP limiter; the tracking key handles
		// the per-tenant correctness, the IP limiter handles abuse.
		publicConvDeps := &conversions.Deps{Repo: &conversions.Repo{Pool: pool}}
		r.Get("/api/public/track/conversion", publicConvDeps.PublicTrack)
		r.Post("/api/public/track/conversion", publicConvDeps.PublicTrack)

		// First-party server-side event ingestion (SUB-122). Tenant is
		// resolved from the request Host (a verified custom domain / CNAME),
		// not a cookie; shares the public 10/min IP limiter above. Events
		// land in subscriber_events via the shared subscribers repo, with
		// ON CONFLICT dedup on a client-supplied source_event_id.
		// TrustForwardedIPHeaders carries the SAME configuration decision the IP
		// middleware already makes, so the ASN and the client IP can never
		// disagree about whether the edge is trusted. Reusing the flag rather
		// than adding a second one is the point: two switches for one trust
		// boundary is how a deployment ends up trusting a header for one purpose
		// and not the other.
		publicTrackDeps := &publictrack.Deps{
			Pool: pool, Subs: subscriberDeps.Repo, Logger: logger,
			UsageMeter: commercialUsageMeter, RequireUsageMeter: true,
			TrustForwardedIPHeaders: cfg.TrustForwardedIPHeaders,
		}
		publictrack.MountPublicTrackRoutes(r, publicTrackDeps)
		// G-20b: public anonymous-visitor event ingestion (CNAME-gated, rate-limited
		// via the same public group). Records under an anonymous_id; identify() later
		// stitches it to a known subscriber.
		anonTrackDeps := &publictrack.AnonDeps{Pool: pool, Recorder: &publictrack.AnonymousRepo{Pool: pool}, Logger: logger, UsageMeter: commercialUsageMeter, RequireUsageMeter: true}
		publictrack.MountPublicTrackAnonymousRoutes(r, anonTrackDeps)

		// F01 honeypot decoy sink. A fetch here is machine ground truth on a
		// REAL recipient, which is the only evidence that can certify machine
		// recall: the calibration harness demotes seed-derived machine labels to
		// diagnostic because seed identity is an absolute classifier input, so
		// measuring against seeds asks the classifier to agree with something it
		// was told.
		//
		// Mounted here to inherit the public IP rate limit, but deliberately NOT
		// on the tracked-click path: a honeypot fetch must never become a
		// `clicked` event, or the instrument would inflate the click-through rate
		// it exists to measure and feed a machine action into lead scoring.
		//
		// Silently absent when unconfigured. Issuance and ingestion share one
		// switch, so a deployment can never be collecting fetches for decoys it
		// is not sending, or sending decoys nothing is listening for.
		if honeypotMinter != nil {
			engagementhoneypot.MountPublicHoneypotRoutes(r, &engagementhoneypot.Deps{
				Minter:   honeypotMinter,
				Recorder: &engagementhoneypot.Repo{Pool: pool},
				// The SAME trust decision the IP middleware already makes. A
				// second switch for one trust boundary is how a deployment ends
				// up trusting a header for one purpose and not the other.
				TrustForwardedIPHeaders: cfg.TrustForwardedIPHeaders,
			})
		}

		// One-click approve/reject endpoint. Token in the URL is the
		// credential (HMAC + TTL); shares the public IP rate-limit.
		approvalsDeps.MountPublic(r)

		// CRM OAuth provider redirects cannot carry a Moosewave session. Their
		// one-time state token binds the callback to a tenant, while this public
		// group supplies the browser-facing abuse limit and conditional-cache
		// wrapper (the callback explicitly responds Cache-Control: no-store).
		apiserver.MountProviderOAuthCallbackRoutes(r, providerIntegrationsSurface)

		// Slack approval-bot inbound surface. None of these need
		// tenant auth — Slack signs every request with the workspace
		// signing secret (verified inside each handler). The OAuth
		// callback's auth is the signed state token we issued at
		// start time.
		r.Get("/api/v1/slack/oauth/callback", slackOAuthDeps.OAuthCallbackHandler)
		r.Post("/api/v1/slack/interactions", slackInteractionsDeps.InteractionsHandler)
		r.Post("/api/v1/slack/commands", slackSlashDeps.SlashCommandsHandler)

		// Public provider Checkout session creator — invoked by the
		// marketing site /pricing CTAs. Unauthenticated; rate-limited
		// by the same 10/min/IP limiter as the rest of the public
		// group. Dodo Payments is canonical; the signed post-payment
		// route is wired below at /api/public/dodo/webhook.
		r.Post("/api/public/billing/checkout", billingHandlers.PublicCheckout)

		/* ===== X1+X2+X3 public ingest routes =====
		 * Per-tenant inbound-email payload sinks retain the shared public
		 * limiter. HMAC-authenticated inbound webhooks are mounted immediately
		 * above with their own machine-traffic budget.
		 */
		inboundIngestDeps := &inbound_email.Deps{
			Repo: &inbound_email.Repo{
				Pool:                 pool,
				Cipher:               envCipher,
				LegacyKEK:            cfg.SendingKEK,
				CanonicalReplyWriter: canonicalInboundReplyWriter{Store: canonicalRepliesStore},
			},
			AutomationServiceURL: cfg.AutomationServiceURL,
			InternalAPIToken:     cfg.InternalAPIToken,
			Logger:               logger,
		}
		wireInboundReplyClassifier(cfg, inboundIngestDeps, pool, logger)
		// Route41 privacy hold: inbound email carries raw customer content under
		// a different authority and lifecycle from Helpdesk. Keep Mirror nil
		// until a durable, equivalently authorised bridge with SAR/erasure and
		// retention evidence exists. The Helpdesk catalog exposes this hold.
		inboundIngestDeps.MountPublicRoutes(r)

		// Public archive / podcast / feed reads share a single
		// PublicArchive policy: max-age=300, s-maxage=600, SWR=3600,
		// Vary: Accept-Encoding. Replaces the per-handler
		// `w.Header().Set("Cache-Control", "public, max-age=300")`
		// drift that had crept into archive/podcast/status — the
		// middleware stamps before the handler runs so any handler
		// that needs no-store (POST /comments, paywall checkout) can
		// still override on the way out. Tips POST handlers + comment
		// POSTs are inside this group too; WithPolicy is a no-op for
		// non-GET methods so their Set-Cookie / 302 paths stay safe.
		r.Group(func(r chi.Router) {
			r.Use(httpcache.WithPolicy(httpcache.PublicArchive()))
			// Render routes are mounted above, outside this group, on the
			// archive render limiter. Only the unlock POST belongs here.
			archivePublicDeps.MountPublicWriteRoutes(r)
			archivePublicDeps.MountRecommendationsPublicRoutes(r)
			(&archive.TipsDeps{
				Repo:          archiveRepoPublic,
				Stripe:        archive.NewTipsStripeAdapter(os.Getenv("STRIPE_SECRET_KEY")),
				PublicBaseURL: archivePublicBase,
				Logger:        logger,
			}).MountPublicTipsRoutes(r)
			(&archive_comments.Deps{
				Repo:               &archive_comments.Repo{Pool: pool},
				Logger:             logger,
				TenantResolver:     archiveRepoPublic.TenantBySlug,
				CampaignResolver:   archiveCampaignResolver(archiveRepoPublic),
				SubscriberResolver: archiveCommentSubscriberResolver(pool, archiveWallResolverRepo),
			}).MountPublicRoutes(r)
			(&podcast.Deps{
				Repo:          &podcast.Repo{Pool: pool},
				PublicBaseURL: archivePublicBase,
			}).MountPublicRoutes(r)
			// RSS + JSON Feed atop the archive — same source of truth
			// (campaigns.archive_public). Etag-cached.
			(&newsletter_feed.Deps{
				ArchiveRepo:   archiveRepoPublic,
				PublicBaseURL: archivePublicBase,
			}).MountRoutes(r)
		})
		publicReferralCookieSecret := strings.TrimSpace(os.Getenv("POSTWAVE_REFERRAL_COOKIE_SECRET"))
		if publicReferralCookieSecret == "" && !isProductionEnv() {
			publicReferralCookieSecret = strings.TrimSpace(cfg.InternalAPIToken)
		}
		(&referrals.Deps{
			Repo:               &referrals.Repo{Pool: pool},
			PublicRedirectBase: cfg.FormsPublicHost,
			ShareBaseURL:       os.Getenv("REFERRAL_SHARE_BASE_URL"),
			CookieSecret:       publicReferralCookieSecret,
		}).MountPublicRoutes(r)
		/* ===== end X1+X2+X3 ===== */
	})
	// Signed provider lead webhooks can retry/burst outside human form-submit
	// traffic, so keep them outside the shared public 10/min/IP limiter.
	apiserver.MountPublicProviderIntegrationRoutes(r, providerIntegrationsSurface)
	// Archive view-count pixel — explicitly mounted OUTSIDE the public
	// 10/min/IP group above and wrapped in its own 600/min/IP limiter
	// (archive-pixel-rate-limit-bypass). The pixel fires on every page
	// view of a published archive issue, so the shared human-form
	// limiter silently 429-throttled corporate-NAT viewers after the
	// 10th hit, depressing campaign view counts proportional to the
	// share of subscribers behind the same egress IP. The dedicated
	// limiter (matching Ghost / beehiiv open-pixel budgets) handles
	// abuse mitigation without dropping legitimate signal.
	//
	// We construct a fresh archive.Deps here rather than closing over
	// `archiveRepoPublic` inside the public group, mirroring the
	// `publicGiftHandlers` precedent above: Go's scope rules don't let
	// us reach the in-group instance, and both Deps are stateless +
	// equivalent (same Pool, same PublicBaseURL, same Recorder).
	archivePixelRepo := &archive.Repo{Pool: pool}
	(&archive.Deps{
		Repo:                    archivePixelRepo,
		PublicBaseURL:           os.Getenv("ARCHIVE_PUBLIC_BASE_URL"),
		Recorder:                archive.NewViewRecorder(archivePixelRepo, logger),
		TrustForwardedIPHeaders: cfg.TrustForwardedIPHeaders,
	}).MountPixelRoute(r.With(archivePixelRateLimit.Middleware))

	// Twilio retries and delivery receipts can burst during sends, so SMS
	// callbacks stay outside the human-form 10/min limiter. Signature
	// verification happens in the sms package when TWILIO_WEBHOOK_AUTH_TOKEN
	// is configured.
	smsDeps.MountPublicRoutes(r)
	socialCaptureDeps.MountPublicRoutes(r)
	reviewsDepsPublic := &reviews.Deps{
		Repo:       &reviews.Repo{Pool: pool},
		Storage:    warehouseObjectStore,
		PublicBase: os.Getenv("POSTWAVE_PUBLIC_BASE_URL"),
		// Storefront review submissions trigger flows the same way.
		FlowEvents: reviewsFlowEventAdapter{track: &track.Repo{Pool: pool, FlowRuns: &flowbuilder.Repo{Pool: pool}}},
	}
	// Throttle ONLY the unauthenticated submit (it fans out to flow enrollment);
	// the GET widget routes stay unthrottled for storefront page loads.
	reviewsDepsPublic.MountPublicRoutes(r, publicRateLimit.Middleware)
	// Possession-bound, non-enumerating cleanup retry for an installation that
	// signed out while offline. Registration and status remain session-only.
	mobilePushDeps.MountPublicRoutes(r.With(publicRateLimit.Middleware))

	mountRegionRoutes(r, pool, cfg.InternalAPIToken)

	// SCIM v2 provisioning. Endpoints are tenant-scoped via Bearer
	// token (per-tenant scim_token); the bearer auth lives inside
	// the SCIM package itself, not the gateway's API-key chain.
	//
	// Per-tenant data-region enforcement runs INSIDE scim.bearerAuth
	// (multi-region audit HIGH #5): the tenant id is only known
	// after the bearer is matched against scim_tokens, so a
	// router-level regions.EnforceRegion can't see it. Passing
	// regionLookup into scim.Deps gives the SCIM middleware its own
	// 421-on-mismatch gate. Without this, an EU IdP landing on the
	// US replica (DNS failover, misconfiguration) would write EU
	// tenant rows to the US cluster.
	apiserver.MountSCIMPublicRoutes(apiserver.Deps{
		Router:     r,
		SCIMPublic: &scim.Deps{Pool: pool, RegionLookup: regionLookup},
	})

	// Shopify OAuth callback + webhooks are authenticated by signed state or
	// Shopify HMAC rather than the tenant middleware. They stay outside the
	// human-form public limiter so Shopify retries are not throttled.
	apiserver.MountCommercePublicRoutes(r, providerIntegrationsSurface)

	billingWebhook := buildBillingWebhook(buildBillingWebhookDeps{
		billingRepo:      billingRepo,
		provisioner:      provisioner,
		pool:             pool,
		logger:           logger,
		authMailer:       authMailer,
		authFromAddress:  authFromAddress,
		operatorNotifier: operatorNotifier,
		authDeps:         authDeps,
		cfg:              cfg,
	})
	// Dodo Payments is Moosewave's canonical billing ingress. The Stripe route
	// remains mounted for self-hosted and migration compatibility; canonical
	// production does not inject its signing secret.
	dodoBillingWebhook := &billing.DodoWebhookHandler{
		Secret:          os.Getenv("DODO_PAYMENTS_WEBHOOK_KEY"),
		SecondarySecret: os.Getenv("DODO_PAYMENTS_WEBHOOK_KEY_SECONDARY"),
		Core:            billingWebhook,
	}
	r.With(billingWebhookRateLimit.Middleware).Method(http.MethodPost, "/api/public/dodo/webhook", dodoBillingWebhook)
	r.With(billingWebhookRateLimit.Middleware).Method(http.MethodPost, "/api/public/stripe/webhook", billingWebhook)
	archiveTipsWebhookDeps := &archive.TipsDeps{
		Repo:   &archive.Repo{Pool: pool},
		Logger: logger,
		Verify: billing.VerifySignature,
	}
	r.With(billingWebhookRateLimit.Middleware).Method(http.MethodPost, "/api/public/archive/tips/webhook", http.HandlerFunc(archiveTipsWebhookDeps.TipsWebhookHandler))

	// Internal Listmonk webhook ingester. No tenant middleware: the endpoint
	// is authenticated by HMAC (LISTMONK_WEBHOOK_SECRET) and the per-event
	// tenant id is carried in the payload. Lives under /api/internal so the
	// edge can refuse requests that arrive without our internal proxy auth.
	listmonkEventsDeps := &listmonk_events.Deps{
		Pool:                   pool,
		Secret:                 cfg.ListmonkWebhookSecret,
		AllowUnsignedDevBypass: cfg.AllowDevListmonkWebhookBypass,
		AutomationServiceURL:   cfg.AutomationServiceURL,
		InternalAPIToken:       cfg.InternalAPIToken,
		Logger:                 logger,
		SubscriberEvents: subscriberEventFanoutAdapter{
			Track:         &track.Repo{Pool: pool},
			FlowRuns:      &flowbuilder.Repo{Pool: pool},
			DelayResolver: triggerDelayRepo,
			Logger:        logger,
		},
		// SUB-119: bridge engagement webhooks onto the SSE Bus.
		Bus: listmonkEventBusAdapter{Bus: eventsBus},
		CanonicalWebhooks: func(
			ctx context.Context,
			tx pgx.Tx,
			event listmonk_events.TransactionalWebhookEvent,
		) (int, error) {
			return canonicalWebhookFanout.Fire(ctx, tx, outbound_webhooks.TransactionalEvent{
				TenantID:      event.TenantID,
				EventType:     event.EventType,
				SourceEventID: event.SourceEventID,
				Body:          event.Body,
				OccurredAt:    event.OccurredAt,
			})
		},
		// Guarded conversion: a nil *Runtime must not become a non-nil interface.
		// See engagementClassifierForDeps for what that cost.
		EngagementClassifier: engagementClassifierForDeps(engagementClassifierRuntime),
		CampaignReportProjector: listmonkCampaignReportProjectorForDeps(
			campaignReportProjectionRuntime,
		),
		// Hard bounces + spam complaints fan to the tenant's operators on
		// every registered device via the unified notification fanout.
		Notify: operatorNotifier,
		// SUB-096: live engagement counter on the subscriber slideover.
		// After a new open/click persists, the handler loads a fresh
		// rollup via the subscribers Repo and emits
		// subscriber.engagement_updated on the Bus.
		EngagementSnapshotter: listmonkEngagementSnapshotAdapter{repo: subscriberDeps.Repo},
	}
	r.Group(func(r chi.Router) {
		r.Post("/api/internal/listmonk/events",
			listmonkEventsDeps.HandleWithMemberships(&lists.Repo{Pool: pool}))
	})

	// ESP feedback-loop ingesters. Same auth shape as the listmonk
	// webhook (HMAC over `<timestamp>.<body>`) so operators only learn
	// one signature pattern. Hard bounces + complaints auto-suppress.
	// (feedbackDeps is constructed earlier so the admin POST route inside
	// the tenant-scoped group can reference it.)
	r.Group(func(r chi.Router) {
		r.Post("/api/internal/feedback/postmark", feedbackDeps.HandlePostmark)
		r.Post("/api/internal/feedback/sendgrid", feedbackDeps.HandleSendGrid)
		r.Post("/api/internal/feedback/arf", feedbackDeps.HandleARF)
	})
	tenantsAdminDeps := buildTenantsAdminDeps(pool, cfg)
	r.Group(func(r chi.Router) {
		tenants.MountAdmin(r, tenantsAdminDeps)
	})

	// Tenant impersonation for support. Mounted on the TOP-LEVEL
	// router (outside tenant middleware + outside EnforceRegion) so
	// a Moosewave employee can flip into any tenant regardless of the
	// employee's own region/tenant context. The handler itself is
	// guarded by InternalAPIToken (Cloudflare allowlisted at the
	// edge); the middleware that consumes the token is mounted on
	// the protected tenant router below.
	impersonate.MountInternalRoutes(r, &impersonate.Deps{
		Pool:             pool,
		InternalAPIToken: cfg.InternalAPIToken,
	})

	webVitalsHandler := webvitals.NewHandler(&webvitals.Deps{
		Pool:                    pool,
		Logger:                  logger,
		AllowedOrigins:          webVitalsOrigins,
		TrustForwardedIPHeaders: cfg.TrustForwardedIPHeaders,
	})
	r.Group(func(r chi.Router) {
		r.Method(http.MethodPost, "/api/internal/web-vitals", webVitalsHandler)
		r.Method(http.MethodOptions, "/api/internal/web-vitals", webVitalsHandler)
	})
	// ----- end testing-support -----

	// ----- smaller-fixes: notif-gating + audit-trim + kms-rewrap -----
	//
	// Three independent polish wires:
	//
	// 1. notifDispatcher: gates customer-facing emails on the per-user
	//    notification_preferences row. We set the field on the
	//    already-constructed billingWebhook + approvalsDeps because
	//    those structs predate this block; the alternative would be a
	//    code reordering that crosses sibling territory.
	//
	// 2. audit.Trimmer: a daily ticker that DELETEs audit_log rows
	//    older than the per-tenant retention window
	//    (settings.PrivacyRepo.AuditLogRetentionDays). Configured via
	//    POSTWAVE_AUDIT_TRIM_INTERVAL_SECONDS + POSTWAVE_AUDIT_TRIM_BATCH_SIZE.
	//
	// 3. admin.Deps: registers /api/internal/admin/kms/rewrap-* one-shot
	//    endpoints that re-encrypt v=0x01 ciphertexts under the
	//    KMS-backed envCipher. Idempotent (rows already at v=0x02 are
	//    skipped). Auth: same Bearer-token pattern as
	//    tenants.MountAdmin (cfg.InternalAPIToken).
	notifDispatcher := wireNotificationGating(pool, logger, billingWebhook, approvalsDeps, approvalsService, notifyFanout)
	// ----- end approvals: per-recipient gating wire-up -----

	// Send-complete notifier wiring. The send guard workers start only after
	// this assignment, so every field they read is immutable for their lifetime.
	sendCompleteFrom := os.Getenv("POSTWAVE_SEND_COMPLETE_FROM")
	if sendCompleteFrom == "" {
		sendCompleteFrom = "Moosewave <noreply@moosewave.com>"
	}
	sendGuard.SendCompleteNotifier = &sending.SendCompleteNotifier{
		Mailer:     &sendingMailerAdapter{Mailer: authMailer},
		Dispatcher: notifDispatcher,
		TenantRepo: &sendingTenantUserRepo{Pool: pool},
		BaseURL:    os.Getenv("PUBLIC_BASE_URL"),
		From:       sendCompleteFrom,
		Logger:     logger,
		Feed:       &sendingNotificationFeedAdapter{fanout: notifyFanout},
	}
	// Start only after AssuranceBound and SendCompleteNotifier are fully
	// composed. Bound rows branch on their immutable binding and therefore can
	// never fall through to Listmonk, including when the rollout is disabled or
	// a runtime dependency later returns an explicit unavailable result.
	safego.Go(logger, "send-guard-loop", func() {
		if err := sendGuard.Loop(outboxCtx); err != nil &&
			!errors.Is(err, context.Canceled) {
			logger.Error("send guard loop exited", "error", err)
		}
	})
	// Recovery sweep: any legacy row stuck in 'sending' for >10min is
	// returned to pending. Assurance-bound transport ambiguity is separately
	// terminalized in campaign_send_deliveries and the exact request replays
	// through that ledger rather than blindly crossing the provider boundary.
	startSendGuardStuckRecovery(logger, outboxCtx, sendGuard)

	apiworkers.StartDataRetentionWorkers(outboxCtx, apiworkers.DataRetentionWorkerDeps{
		Pool:                  pool,
		Logger:                logger,
		RetentionSweeper:      sharedRetentionSweeper,
		PartitionRotator:      partitionRotator,
		PrivacyTagHistory:     privacyTagHistory,
		AccountDeletionMailer: authMailer,
		AccountDeletionFrom:   authFromAddress,
		Getenv:                os.Getenv,
	})

	reportFrom := os.Getenv("POSTWAVE_REPORT_FROM_EMAIL")
	if reportFrom == "" {
		reportFrom = "Moosewave <reports@moosewave.com>"
	}
	var scheduledReportsMailer scheduled_reports.MailSender
	var auditScheduleMailer handlers.ScheduleMailSender
	if authMailer != nil {
		scheduledReportsMailer = &scheduledReportMailerAdapter{Mailer: authMailer, From: reportFrom}
		auditScheduleMailer = &scheduledReportMailerAdapter{Mailer: authMailer, From: reportFrom}
	}
	apiworkers.StartOperationalMaintenanceWorkers(outboxCtx, apiworkers.OperationalMaintenanceWorkerDeps{
		Pool:                         pool,
		Logger:                       logger,
		Storage:                      assetStorage,
		ExportStorage:                exportStorage,
		ScheduledReportsMailer:       scheduledReportsMailer,
		AuditScheduleMailer:          auditScheduleMailer,
		AuditPublicBaseURL:           strings.TrimSpace(os.Getenv("POSTWAVE_PUBLIC_API_BASE_URL")),
		AuditAlertsSlack:             slackDispatcher,
		Cipher:                       envCipher,
		SubscriberImportVerification: apiserver.NewImportExecutionVerifier(verificationStore),
		EnableScoring:                os.Getenv("POSTWAVE_DISABLE_LEAD_SCORING") != "1",
		EnableSubscriberImport:       os.Getenv("POSTWAVE_DISABLE_SUBSCRIBER_IMPORT_WORKER") != "1",
		EnablePredictive:             os.Getenv("POSTWAVE_DISABLE_PREDICTIVE_RECOMPUTE") != "1",
		EnableScheduledReports:       os.Getenv("POSTWAVE_DISABLE_SCHEDULED_REPORTS") != "1" && authMailer != nil,
		EnableAuditExport:            os.Getenv("POSTWAVE_DISABLE_AUDIT_EXPORT_WORKER") != "1",
		EnableAuditAlerts:            os.Getenv("POSTWAVE_DISABLE_AUDIT_ALERTS") != "1",
		EnableAuditUEBA:              os.Getenv("POSTWAVE_DISABLE_AUDIT_UEBA") != "1",
		EnableExports:                exportStorage != nil && exportsEnabled,
		EnableAuditSinks:             os.Getenv("POSTWAVE_DISABLE_AUDIT_SINKS") != "1",
		// GOVERNANCE#48 — an open breaker means the tenant's audit trail
		// stopped reaching their SIEM. Announce it through the same fanout
		// chokepoint as every other operator alert.
		AuditSinkCircuitNotifier: operatorNotifier,
		EnableLandingScheduler:   os.Getenv("POSTWAVE_DISABLE_LANDING_SCHEDULER") != "1",
	})

	// Admin KMS re-wrap endpoints. Mounted on the top-level router so
	// they sit next to /api/internal/tenants and inherit the same
	// internal-only Cloudflare allow-list.
	adminKMS := &admin.Deps{
		Pool:             pool,
		Cipher:           envCipher,
		LegacyKEK:        cfg.SendingKEK,
		InternalAPIToken: cfg.InternalAPIToken,
		AllowDevToken:    cfg.AllowDevTenantSlugHeader,
		Logger:           logger,
	}
	r.Group(func(r chi.Router) {
		apiserver.MountAdminKMSRoutes(apiserver.Deps{Router: r, AdminKMS: adminKMS})
	})
	// ----- end smaller-fixes -----

	// ----- admin: spam corpus export -----
	//
	// POST /api/internal/admin/spam-corpus/export
	//   Streams a labeled (text, isSpam) corpus extracted from
	//   email_events ⨝ seedlist_outcomes (and the soft signals on
	//   subscriber_suppressions + campaign_replies) for ops to feed
	//   into the deliverability scanner's calibration trainer.
	//
	// Auth: same Bearer-token pattern as the KMS rewrap endpoints
	// (cfg.InternalAPIToken). AllowDevToken mirrors the dev override
	// used everywhere else in this region.
	//
	// Exporter wiring: nil here so the route returns 503 until the
	// deliverability service exposes a proxy adapter or the
	// workspace-shared corpus.Exporter is wired in. Operators can
	// still hit the endpoint to verify auth + shape; the response
	// flips to 200 once Exporter is non-nil. The interface lives in
	// apps/api/internal/admin/spam_corpus.go to keep apps/api free of
	// services/deliverability/internal imports (different Go module).
	spamCorpusAdmin := &admin.SpamCorpusDeps{
		Exporter:         nil, // wire when deliverability proxy or shared exporter lands
		InternalAPIToken: cfg.InternalAPIToken,
		AllowDevToken:    cfg.AllowDevTenantSlugHeader,
		Logger:           logger,
	}
	r.Group(func(r chi.Router) {
		apiserver.MountSpamCorpusAdminRoutes(apiserver.Deps{Router: r, SpamCorpusAdmin: spamCorpusAdmin})
	})
	// ----- end admin: spam corpus export -----

	// ----- internal: send-domain lookup for cross-service use -----
	//
	// GET /api/internal/send-domains/lookup?domain=<fqdn>
	//   Resolves a domain to its owning tenant_id by hitting the
	//   send_domains table. Returns 200 {"tenant_id": "..."} on hit,
	//   404 {"error": "not_found"} on miss (including domains whose
	//   verified_at is NULL — unverified is not a tenant claim we
	//   trust). Auth: Bearer cfg.InternalAPIToken.
	//
	// Used by the deliverability sidecar's DMARC ingestion pipeline:
	// step 2 of DefaultTenantResolver.Resolve maps a report's
	// policy_published.domain to a tenant via this endpoint when the
	// envelope-To plus-addressing strategy didn't match.
	//
	// Mounted on the top-level router (no tenant middleware) so it
	// sits next to /api/internal/tenants and inherits the same
	// internal-only Cloudflare allow-list. The Bearer-token check is
	// inlined here so this region stays self-contained; it mirrors the
	// shape used by tenants.MountAdmin / admin.Deps elsewhere in this
	// file (constant-time compare against cfg.InternalAPIToken).
	sendomainLookupRepo := sending.SendDomainLookupRepo{Pool: pool}
	sendomainBearerGuard := newSendDomainLookupGuard(cfg)
	r.Group(func(r chi.Router) {
		r.Use(sendomainBearerGuard)
		r.Get("/api/internal/send-domains/lookup", sending.SendDomainLookupHandler(sendomainLookupRepo))
	})
	// ----- end internal: send-domain lookup -----

	// ----- replies -----
	// Reply tracking pipeline. Replaces the (clicks - unsubscribes)
	// proxy that used to back A/B reply_rate selection with real
	// reply counts from campaign_replies (migration 0087).
	//
	// Three inbound provider webhooks land here:
	//   - POST /api/internal/webhooks/inbound/postmark
	//       HMAC-SHA256(body, postmarkSecret) in
	//       X-Postmark-Webhook-Signature.
	//   - POST /api/internal/webhooks/inbound/mailgun
	//       HMAC-SHA256(timestamp+token, signingKey) embedded in the
	//       JSON body (or multipart form fields) — same shape as the
	//       deliverability receiver, replay-window-bounded at 5min.
	//   - POST /api/internal/webhooks/inbound/ses
	//       SNS-wrapped envelope; signature is a per-deployment
	//       shared secret in X-Postwave-SES-Inbound-Secret set by
	//       API Gateway. Full RSA-cert SNS verification lives in the
	//       deliverability path (deliverability_ses.go) and isn't
	//       duplicated here.
	//
	// New reply addresses are compact opaque commitments minted by the
	// assurance-bound raw runtime and resolved through the accepted delivery
	// ledger before their tenant/campaign/delivery MAC binding is verified.
	// The old stateless secret remains decoder-only for historical addresses;
	// no production dispatch path mints that over-budget format.
	repliesStore := canonicalRepliesStore
	repliesRepo := &replies.Repo{Pool: pool}
	repliesUnmappedCounter := promauto.NewCounter(prometheus.CounterOpts{
		Name: "inbound_replies_unmapped_total",
		Help: "Inbound replies dropped because no tenant could be resolved.",
	})
	// Bridge the prometheus counter to the atomic.Int64 the handler
	// expects: every Add increments both. The handler reads the
	// atomic for tests; prom scrapes the counter in production.
	var repliesUnmappedAtomic atomic.Int64
	repliesVERPSecret := []byte(os.Getenv("POSTWAVE_REPLIES_VERP_SECRET"))
	repliesMatcher := &replies.Matcher{
		Store:            repliesStore,
		VERPSecret:       repliesVERPSecret,
		ReplyCorrelation: campaignBoundSend.ReplyCorrelation,
	}
	// The inbound-reply topic is NOT the deliverability events topic: SES
	// receipt notifications and SES sending events are published to different
	// topics, so sharing one allow-list would either reject real replies or
	// admit a topic this endpoint has no business accepting.
	var repliesSESTopicARNs []string
	for _, raw := range strings.Split(os.Getenv("POSTWAVE_REPLIES_SES_TOPIC_ARNS"), ",") {
		if trimmed := strings.TrimSpace(raw); trimmed != "" {
			repliesSESTopicARNs = append(repliesSESTopicARNs, trimmed)
		}
	}
	repliesDeps := &replies.Deps{
		Store:                  repliesStore,
		Matcher:                repliesMatcher,
		PostmarkSecret:         os.Getenv("POSTWAVE_REPLIES_POSTMARK_SECRET"),
		MailgunSigningKey:      os.Getenv("POSTWAVE_REPLIES_MAILGUN_SIGNING_KEY"),
		SESSharedSecret:        os.Getenv("POSTWAVE_REPLIES_SES_SHARED_SECRET"),
		SESTopicARNs:           repliesSESTopicARNs,
		AllowUnsignedDevBypass: cfg.AllowDevListmonkWebhookBypass,
		EnvelopeDomainSuffix:   os.Getenv("POSTWAVE_REPLIES_ENVELOPE_DOMAIN"),
		TenantResolver:         repliesRepo,
		UnmappedCounter:        &repliesUnmappedAtomic,
		Logger:                 logger,
	}
	// Inbound reply OBJECTS written by the SES receipt rule
	// (infra/terraform/ses-inbound). Without this the receipt rule delivers to a
	// bucket nothing reads, and the whole reply taxonomy — the classifier, the
	// quoted-history stripper, the `replied` event four systems wait on — is
	// reachable only through the inline path, which SES does not use once a rule
	// writes to S3.
	//
	// The bucket name is an ALLOW-LIST, not a convenience. The bucket to read
	// arrives inside the SNS notification, so without pinning it here, anyone
	// who could reach the SES receiver could name any bucket this task role can
	// read and have its contents parsed as a customer's inbound mail.
	//
	// Unset leaves the receiver on its historical inline-only path.
	if err := wireReplyObjectWorkerAndIMAPPoller(repliesDeps, repliesStore, repliesMatcher, repliesRepo, pool, logger, outboxCtx); err != nil {
		return err
	}
	r.Group(func(r chi.Router) {
		repliesDeps.MountRoutes(r)
	})
	// Wire reply counts into the A/B winner picker. The Store
	// satisfies abtests.ReplyCounter via its CountForCampaign method;
	// the abDeps + abScheduler wired earlier captured the
	// abWinnerDeps pointer at construction time, so this assignment
	// is visible to every subsequent EvaluateWinnerWithDeps call.
	abWinnerDeps.ReplyCounter = repliesStore
	// Forward unmapped-counter atomic increments to the prom counter
	// so /metrics scrapes match the in-process atomic. We poll on a
	// short interval rather than instrumenting every drop site so the
	// handlers stay free of a prom dependency.
	safego.Go(logger, "replies-unmapped-metrics-ticker", func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		var seen int64
		for {
			select {
			case <-outboxCtx.Done():
				return
			case <-ticker.C:
				cur := repliesUnmappedAtomic.Load()
				if cur > seen {
					repliesUnmappedCounter.Add(float64(cur - seen))
					seen = cur
				}
			}
		}
	})
	// ----- end replies -----

	// ----- suppressions + deliverability webhooks -----
	// Inbound bounce + engagement webhook receivers for Postmark,
	// Mailgun, and SES. Each verifies its own signature shape
	// (Postmark: HMAC-SHA256 in X-Postmark-Webhook-Signature; Mailgun:
	// HMAC-SHA256 over timestamp+token in the body; SES: SNS envelope
	// with TopicArn allow-list). Hard bounces + complaints +
	// unsubscribes write to subscriber_suppressions; soft bounces and
	// engagement events write to subscriber_events; soft bounces over
	// the threshold (≥5 in 30d) auto-suppress.
	// Parse the SES TopicArn allow-list, dropping empty splits so an
	// unset POSTWAVE_SES_TOPIC_ARNS env doesn't accidentally match
	// the empty TopicArn string in a forged payload.
	var sesTopicARNs []string
	for _, raw := range strings.Split(os.Getenv("POSTWAVE_SES_TOPIC_ARNS"), ",") {
		if v := strings.TrimSpace(raw); v != "" {
			sesTopicARNs = append(sesTopicARNs, v)
		}
	}
	deliverabilityDeps := &webhooks.DeliverabilityDeps{
		Pool:                   pool,
		Suppressions:           suppressionsStore,
		PostmarkToken:          os.Getenv("POSTWAVE_POSTMARK_WEBHOOK_TOKEN"),
		MailgunKey:             os.Getenv("POSTWAVE_MAILGUN_WEBHOOK_KEY"),
		SESTopicARNs:           sesTopicARNs,
		SendGridToken:          os.Getenv("POSTWAVE_SENDGRID_WEBHOOK_TOKEN"),
		ResendToken:            os.Getenv("POSTWAVE_RESEND_WEBHOOK_TOKEN"),
		SparkPostToken:         os.Getenv("POSTWAVE_SPARKPOST_WEBHOOK_TOKEN"),
		MailerSendToken:        os.Getenv("POSTWAVE_MAILERSEND_WEBHOOK_TOKEN"),
		AllowUnsignedDevBypass: cfg.AllowDevListmonkWebhookBypass,
		TenantResolver:         feedbackRepo,
		Logger:                 logger,
		// Same guarded conversion as the Listmonk path: a nil *Runtime must not
		// become a non-nil interface. Wired here so the SEVEN ESP webhooks also
		// write observations — without it, reclassification rebuilt from one
		// writer's events and silently produced a partial corpus.
		EngagementClassifier: espEngagementClassifierForDeps(engagementClassifierRuntime),
		CampaignReportProjector: espCampaignReportProjectorForDeps(
			campaignReportProjectionRuntime,
		),
	}
	r.Group(func(r chi.Router) {
		r.Post("/api/internal/webhooks/deliverability/postmark", deliverabilityDeps.HandlePostmark)
		r.Post("/api/internal/webhooks/deliverability/mailgun", deliverabilityDeps.HandleMailgun)
		r.Post("/api/internal/webhooks/deliverability/ses", deliverabilityDeps.HandleSES)
		r.Post("/api/internal/webhooks/deliverability/sendgrid", deliverabilityDeps.HandleSendGrid)
		r.Post("/api/internal/webhooks/deliverability/resend", deliverabilityDeps.HandleResend)
		r.Post("/api/internal/webhooks/deliverability/sparkpost", deliverabilityDeps.HandleSparkPost)
		r.Post("/api/internal/webhooks/deliverability/mailersend", deliverabilityDeps.HandleMailerSend)
	})
	// ----- end suppressions + deliverability webhooks -----

	// Public status page backend.
	statusHandler := buildStatusHandler(pool, cfg)
	r.Get("/api/v1/status/public", statusHandler.Public)
	// Atom feed of published incidents — every reader (Feedly,
	// NetNewsWire, Slack RSS plugin) speaks Atom 1.0. Cached 5min.
	r.Get("/api/status/feed.atom", statusHandler.PublicFeed)
	// Anonymous subscribe / confirm / unsubscribe for incident
	// notifications. Channels: email + sms. Subscription rows live
	// in status_subscribers (migration 0116); a downstream notifier
	// worker (out of scope here) fans out incidents to confirmed
	// rows.
	r.Post("/api/status/subscribers", statusHandler.Subscribe)
	r.Get("/api/status/subscribers/{id}/confirm", statusHandler.Confirm)
	r.Post("/api/status/subscribers/{id}/unsubscribe", statusHandler.Unsubscribe)
	// Scheduled-maintenance windows public endpoint — read-only;
	// the status page banner pulls active + upcoming + recently
	// completed windows from here.
	maintenance.MountPublicRoutes(r, &maintenance.Deps{Pool: pool})
	statusPoller := status.NewPoller(pool, statusHandler, time.Minute)
	// Use outboxCtx (not Background) so SIGTERM cancels the poller
	// cleanly, and safego.Go so it participates in the shutdown WG.
	safego.Go(logger, "status-poller", func() { statusPoller.Run(outboxCtx) })

	// ----- trust-ops: status page + stripe retry -----
	//
	// Two cooperating goroutines:
	//
	//   1. health.Aggregator: pings each SERVICE_HEALTH_URLS target
	//      every 60s, persists the result to service_health_pings, and
	//      keeps a live snapshot for the public status JSON. Targets
	//      are parsed from the env var as `name=url,name=url`.
	//   2. webhook_retry.Worker: every 30s drains
	//      stripe_webhook_attempts where next_attempt_at <= now and
	//      re-runs each event through the inline billing webhook
	//      handler. Backoff: 30s/5m/30m/2h/8h/1d/7d → DLQ. The DLQ
	//      branch increments stripe_webhook_dead_lettered_total and
	//      emails STRIPE_DLQ_ALERT_EMAIL.
	//
	// Both share a context derived from the main shutdown signal so
	// SIGTERM cancels them cleanly before srv.Shutdown blocks.
	trustOpsCtx, trustOpsCancel := context.WithCancel(context.Background())
	defer trustOpsCancel()

	healthTargets := health.ParseTargets(os.Getenv("SERVICE_HEALTH_URLS"))
	healthAgg := health.NewAggregator(pool, healthTargets, logger)
	healthHandler := health.NewHandler(pool, healthAgg)
	r.Group(func(r chi.Router) {
		// Open CORS, no auth, no tenant binding — public status JSON
		// for status.moosewave.com and embedded status widgets.
		// PublicArchive policy (max-age=300, s-maxage=600, SWR=3600)
		// matches the cadence the aggregator refreshes upstream pings
		// at, lets CDN edges absorb spikes during incident reporting.
		r.Use(httpcache.WithPolicy(httpcache.PublicArchive()))
		r.Method(http.MethodGet, "/api/public/status", healthHandler)
		r.Method(http.MethodHead, "/api/public/status", healthHandler)
		r.Method(http.MethodOptions, "/api/public/status", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
			w.WriteHeader(http.StatusNoContent)
		}))
	})
	// safego.Go so the aggregator participates in the shutdown
	// WaitGroup drain — previously a bare `go` left this worker
	// running while deferred pool.Close() ran.
	safego.Go(logger, "trust-ops-health-aggregator", func() { healthAgg.Run(trustOpsCtx) })

	// Stripe retry queue + worker. Wire the queue back into the
	// billing webhook handler constructed earlier so failed dispatch
	// enqueues into stripe_webhook_attempts.
	retryStore := webhook_retry.NewPgStore(pool)
	billingWebhook.RetryQueue = retryStore

	if err := startStripeWebhookRetryWorker(retryStore, billingWebhook, logger, authMailer, trustOpsCtx); err != nil {
		return err
	}
	// Admin endpoints for the DLQ. Bearer-token guarded with the same
	// internal-API token used elsewhere; mounted under /api/internal
	// so the edge can refuse them without our internal-proxy auth.
	internalGuard := newInternalBearerGuard(cfg)
	r.Group(func(r chi.Router) {
		r.Use(internalGuard)
		if inboxRealityRuntime.Enabled() {
			// Keep these registrations literal so the fail-closed route-capability
			// generator and runtime chi inventory see the same trust boundary.
			r.Post("/api/internal/inbox-reality/pivot", inboxRealityRuntime.Deps.PivotResult)
			r.Post("/api/internal/inbox-reality/observations", inboxRealityRuntime.Deps.ObservationCallback)
		}
		listStripeWebhookAttempts := newStripeWebhookAttemptsListHandler(retryStore)
		r.Get("/api/internal/admin/stripe-webhook-attempts", listStripeWebhookAttempts)
		replayStripeWebhookAttempt := newStripeWebhookAttemptReplayHandler(retryStore)
		r.Post("/api/internal/admin/stripe-webhook-attempts/{id}/replay", replayStripeWebhookAttempt)
	})
	// ----- end trust-ops -----
	if err := routeauth.ValidateRouterExact(r); err != nil {
		if os.Getenv("POSTWAVE_SKIP_ROUTE_AUTHZ_VALIDATION") == "1" {
			slog.Warn("route authorization startup validation FAILED — continuing (POSTWAVE_SKIP_ROUTE_AUTHZ_VALIDATION=1)", "err", err.Error())
		} else {
			return fmt.Errorf("route authorization startup validation: %w", err)
		}
	}

	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           r,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      apiWriteTimeout,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    64 << 10,
	}

	return serveUntilShutdown(logger, srv, opsFleet, trustOpsCancel, outboxCancel, janitorCancel, apiKeyCallsRecorderOuter)
}

// verpReplyToPolicyFromEnv reads POSTWAVE_SENDING_VERP_REPLY_TO and REFUSES an
// unrecognised value instead of accepting it.
//
// Guard.verpPolicy() maps anything it does not recognise to VERPReplyToOff,
// which is the right default INSIDE the guard — it will not guess at intent
// mid-send. But applied to a configuration string it means a typo
// ("allways", "Always ") silently disables signed reply identity on a
// deployment whose operator believes they enabled it. The feature then looks
// present in the config and absent in the mail, which is the single hardest
// class of failure to diagnose and precisely the one this PRD is about.
//
// So the typo is caught HERE, at the boundary where the operator's intent is
// still legible, rather than becoming a silent steady state.
func verpReplyToPolicyFromEnv(logger *slog.Logger) sending.VERPReplyToPolicy {
	raw := strings.TrimSpace(os.Getenv("POSTWAVE_SENDING_VERP_REPLY_TO"))
	switch sending.VERPReplyToPolicy(raw) {
	case "":
		return sending.VERPReplyToWhenAbsent
	case sending.VERPReplyToWhenAbsent, sending.VERPReplyToAlways, sending.VERPReplyToOff:
		return sending.VERPReplyToPolicy(raw)
	default:
		logger.Error("POSTWAVE_SENDING_VERP_REPLY_TO is not a recognised policy; "+
			"signed reply identity is DISABLED until it is corrected",
			"value", raw,
			"allowed", "when_absent|always|off")
		return sending.VERPReplyToOff
	}
}
