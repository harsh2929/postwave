// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/ai_regression"
	"github.com/postwave/postwave/apps/api/internal/aicompose"
	"github.com/postwave/postwave/apps/api/internal/auth"
	"github.com/postwave/postwave/apps/api/internal/billing"
	"github.com/postwave/postwave/apps/api/internal/billing/webhook_retry"
	"github.com/postwave/postwave/apps/api/internal/brand_voice"
	"github.com/postwave/postwave/apps/api/internal/campaign_replies"
	"github.com/postwave/postwave/apps/api/internal/campaigns"
	"github.com/postwave/postwave/apps/api/internal/config"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/events"
	"github.com/postwave/postwave/apps/api/internal/feed_ingest"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/inbound_email"
	"github.com/postwave/postwave/apps/api/internal/limits"
	"github.com/postwave/postwave/apps/api/internal/listmonk"
	"github.com/postwave/postwave/apps/api/internal/mailer"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/referrals"
	"github.com/postwave/postwave/apps/api/internal/sending"
	"github.com/postwave/postwave/apps/api/internal/serviceproxy"
	"github.com/postwave/postwave/apps/api/internal/status"
	"github.com/postwave/postwave/apps/api/internal/suppressions"
	"github.com/postwave/postwave/apps/api/internal/tenants"
	"github.com/postwave/postwave/packages/secrets"
)

// newStripeWebhookAttemptReplayHandler serves the internal DLQ replay
// endpoint. Moved verbatim from run().
func newStripeWebhookAttemptReplayHandler(retryStore *webhook_retry.PgStore) func(w http.ResponseWriter, req *http.Request) {
	replayStripeWebhookAttempt := func(w http.ResponseWriter, req *http.Request) {
		id := chi.URLParam(req, "id")
		if id == "" {
			http.Error(w, "missing id", http.StatusBadRequest)
			return
		}
		newID, err := retryStore.Replay(req.Context(), id)
		if err != nil {
			http.Error(w, "replay failed: "+err.Error(), http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(map[string]string{"new_attempt_id": newID})
	}

	return replayStripeWebhookAttempt
}

// newStripeWebhookAttemptsListHandler serves the internal DLQ listing
// endpoint. Moved verbatim from run().
func newStripeWebhookAttemptsListHandler(retryStore *webhook_retry.PgStore) func(w http.ResponseWriter, req *http.Request) {
	listStripeWebhookAttempts := func(w http.ResponseWriter, req *http.Request) {
		status := req.URL.Query().Get("status")
		if status == "" {
			status = "dead_lettered"
		}
		limit, _ := strconv.Atoi(req.URL.Query().Get("limit"))
		if limit <= 0 {
			limit = 50
		}
		rows, err := retryStore.ListByStatus(req.Context(), webhook_retry.AttemptStatus(status), limit)
		if err != nil {
			http.Error(w, "list failed", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(map[string]any{"attempts": rows})
	}

	return listStripeWebhookAttempts
}

// newInternalBearerGuard builds the constant-time Bearer middleware that
// guards the internal DLQ admin routes. Moved verbatim from run().
func newInternalBearerGuard(cfg config.Config) func(next http.Handler) http.Handler {
	internalToken := strings.TrimSpace(cfg.InternalAPIToken)
	internalGuard := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			if internalToken == "" {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			authz := req.Header.Get("Authorization")
			if !strings.HasPrefix(authz, "Bearer ") {
				w.Header().Set("WWW-Authenticate", "Bearer")
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			if subtle.ConstantTimeCompare([]byte(strings.TrimPrefix(authz, "Bearer ")), []byte(internalToken)) != 1 {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			next.ServeHTTP(w, req)
		})
	}

	return internalGuard
}

// buildStatusHandler builds the public status page handler. Moved verbatim
// from run().
func buildStatusHandler(pool *db.Pool, cfg config.Config) *status.Handler {
	statusHandler := status.NewHandler(pool, status.ServiceTargets{
		Migration:      cfg.MigrationServiceURL,
		Voice:          cfg.VoiceServiceURL,
		Automation:     cfg.AutomationServiceURL,
		Deliverability: cfg.DeliverabilityServiceURL,
		Listmonk:       cfg.ListmonkURL,
	})

	return statusHandler
}

// newSendDomainLookupGuard builds the constant-time Bearer guard for the
// internal send-domain lookup. Moved verbatim from run().
func newSendDomainLookupGuard(cfg config.Config) func(next http.Handler) http.Handler {
	sendomainInternalToken := strings.TrimSpace(cfg.InternalAPIToken)
	sendomainBearerGuard := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			if sendomainInternalToken == "" {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			authz := req.Header.Get("Authorization")
			if !strings.HasPrefix(authz, "Bearer ") {
				w.Header().Set("WWW-Authenticate", "Bearer")
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			provided := strings.TrimSpace(strings.TrimPrefix(authz, "Bearer "))
			if subtle.ConstantTimeCompare([]byte(provided), []byte(sendomainInternalToken)) != 1 {
				w.Header().Set("WWW-Authenticate", "Bearer")
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			next.ServeHTTP(w, req)
		})
	}

	return sendomainBearerGuard
}

// buildTenantsAdminDeps builds the internal tenant admin dependencies. Moved
// verbatim from run().
func buildTenantsAdminDeps(pool *db.Pool, cfg config.Config) *tenants.AdminDeps {

	// ----- testing-support: tenant admin + web vitals -----
	// Two routes that share a common shape: anonymous-ish ingest /
	// admin-only side channel that lives under /api/internal/* so the
	// edge can refuse them without our internal-proxy auth header.
	//
	//   DELETE /api/internal/tenants/{slug}
	//     Cascade-deletes a tenant. Used by the e2e harness'
	//     CleanupTenant helper. Auth: Bearer InternalAPIToken
	//     (or any request when AllowDevTenantSlugHeader is on so the
	//     local docker stack works without juggling tokens).
	//
	//   POST /api/internal/web-vitals
	//     Public anonymous Core Web Vitals ingest from apps/web. No
	//     auth (telemetry fires from any browser); rate-limited per-IP
	//     in the handler. CORS allow-list is the canonical web origin
	//     in prod; empty in dev (sendBeacon and same-origin fetch still
	//     work).
	tenantsAdminDeps := &tenants.AdminDeps{
		Pool:             pool,
		InternalAPIToken: cfg.InternalAPIToken,
		AllowDevToken:    cfg.AllowDevTenantSlugHeader,
	}

	return tenantsAdminDeps
}

// buildBillingWebhookDeps carries the dependencies buildBillingWebhook needs.
type buildBillingWebhookDeps struct {
	billingRepo      *billing.Repo
	provisioner      *sending.Provisioner
	pool             *db.Pool
	logger           *slog.Logger
	authMailer       mailer.Mailer
	authFromAddress  string
	operatorNotifier *operatorNotifyAdapter
	authDeps         *auth.Deps
	cfg              config.Config
}

// buildBillingWebhook builds the Stripe billing webhook handler. Moved
// verbatim from run().
func buildBillingWebhook(d buildBillingWebhookDeps) *billing.WebhookHandler {
	billingRepo := d.billingRepo
	provisioner := d.provisioner
	pool := d.pool
	logger := d.logger
	authMailer := d.authMailer
	authFromAddress := d.authFromAddress
	operatorNotifier := d.operatorNotifier
	authDeps := d.authDeps
	cfg := d.cfg
	// Legacy Stripe webhook core. The route uses a dedicated high-volume
	// machine-traffic limiter, signature verification, and event-id dedupe. Dodo
	// Payments reuses the provider-neutral effects through DodoWebhookHandler.
	billingWebhook := &billing.WebhookHandler{
		Secret: os.Getenv("STRIPE_WEBHOOK_SECRET"),
		// Optional second secret during a Stripe dashboard rotation
		// window. When set, both must fail before we 400. Operator
		// clears this env var after Stripe's old secret is removed.
		// Audit (webhook-rotation CRITICAL #1).
		SecondarySecret: os.Getenv("STRIPE_WEBHOOK_SECRET_SECONDARY"),
		Repo:            billingRepo,
		Provisioner:     provisioner,
		// Audit logger wiring (audit-log audit HIGH #3): the handler
		// emits ~8 audit events per Stripe webhook (auto_provisioned,
		// studio.purchased, subscription.created/updated/deleted,
		// payment.received/failed, charge.refunded). Previously the
		// Audit field was nil, so all billing mutations went into
		// audit_log via NOTHING — financial events were untraceable.
		Audit: &billingAuditLoggerAdapter{Pool: pool, Logger: logger},
		Prices: billing.PriceMap{
			Sending: os.Getenv("STRIPE_PRICE_SENDING"),
			Pro:     os.Getenv("STRIPE_PRICE_PRO"),
			LTD:     os.Getenv("STRIPE_PRICE_LTD"),
			// BILL-052: the metered price whose subscription item receives
			// overage usage records. Empty disables metered reporting.
			Overage: os.Getenv("STRIPE_PRICE_OVERAGE"),
		},
		// The commercial affiliate offer is not release-qualified. Keep both
		// accrual and reversal detached from canonical billing so a closed
		// program cannot mutate a financial ledger or fail a customer webhook.
		// Historical exceptions require an explicit reconciliation workflow.
		Affiliates: nil,
		Attributor: nil,
		Logger:     logger,
		// Wire the customer-facing payment-failed dunning notice through
		// the same Mailer that auth uses (SES in prod, dev-spool in dev).
		// nil mailer would just log — but we always have one configured.
		PaymentFailedMailer: &billingPaymentFailedAdapter{
			Mailer:      authMailer,
			FromAddress: authFromAddress,
		},
		// COMMERCE#4 — put the dunning alert on the feed, the browser and the
		// phone as well as in the inbox. Same recipient (billing resolves the
		// owner and applies the pref gate before calling); the adapter only
		// adds channels.
		PaymentFailedNotifier: operatorNotifier,
		// Auto-provision tenants for marketing-site /pricing flows that
		// arrive without a TenantSlug — the public_checkout path stuffs
		// `auto:<email>` into client_reference_id; this adapter mints a
		// fresh tenant + emails a magic-link invitation. Idempotent on
		// stripe_customer_id + email so Stripe redeliveries are safe.
		AutoTenant: &billingAutoTenantAdapter{
			Pool:   pool,
			Logger: logger,
			// Wire the magic-link emitter from the auth package. The
			// async goroutine inside EnsureTenantForEmail uses this to
			// fire off the invitation without blocking the Stripe
			// webhook ack.
			MagicLinkSender: authDeps.SendMagicLink,
		},
		Automation: &billingAutomationEmitter{
			BaseURL:          cfg.AutomationServiceURL,
			InternalAPIToken: cfg.InternalAPIToken,
		},
	}
	// Stripe webhook ingest: gated by HMAC signature verification +
	// per-IP rate limit (audit finding H4). Cloudflare WAF in front
	// of ALB allows-listing Stripe egress is the primary defence, but
	// any direct hit on the origin IP that bypasses CF (e.g. via DNS
	// leak or migration window) must still be bounded — each event
	// triggers DB writes, provisioner work, and outbound mail.

	return billingWebhook
}

// wireInboundReplyClassifier attaches the AI reply classifier to the inbound
// ingest deps unless the reply loop is disabled. Moved verbatim from run().
func wireInboundReplyClassifier(cfg config.Config, inboundIngestDeps *inbound_email.Deps, pool *db.Pool, logger *slog.Logger) {
	// G3 follow-up: auto-classify campaign replies on ingest unless the
	// reply-loop kill-switch (POSTWAVE_DISABLE_REPLY_LOOP) is set.
	if cfg.FeatureReplyLoop {
		replyClassifier := campaign_replies.NewAIIntentClassifier(
			aicompose.NewHTTPVoiceClient(cfg.VoiceServiceURL, cfg.InternalAPIToken))
		inboundIngestDeps.Classifier = func(ctx context.Context, tenantID string, emailID int64) {
			if err := campaign_replies.ClassifyAndSaveByID(ctx, pool, replyClassifier, tenantID, emailID); err != nil {
				logger.Warn("reply auto-classify failed", "tenant", tenantID, "email_id", emailID, "err", err.Error())
			}
		}
	}
}

// newVoiceDriftHandler enriches the voice drift request with the tenant's
// brand-voice profile before proxying. Moved verbatim from run().
func newVoiceDriftHandler(pool *db.Pool, voiceProxy http.Handler) func(w http.ResponseWriter, req *http.Request) {
	voiceDriftHandler := func(w http.ResponseWriter, req *http.Request) {
		var body map[string]any
		if err := httpbody.DecodeJSONWith(w, req, 1<<20, &body, httpbody.Options{
			AllowUnknownFields: true,
			AllowEmptyBody:     true,
		}); err != nil {
			httpbody.WriteError(w, err)
			return
		}
		if body == nil {
			body = map[string]any{}
		}
		// Map the desktop's html/text onto the body field the scorer reads.
		if _, ok := body["body"]; !ok {
			if h, ok := body["html"].(string); ok && h != "" {
				body["body"] = h
			} else if tx, ok := body["text"].(string); ok && tx != "" {
				body["body"] = tx
			}
		}
		if t, ok := middleware.TenantFromContext(req.Context()); ok {
			if p, err := brand_voice.LoadActive(req.Context(), pool, t.ID); err == nil && p != nil {
				if v, _ := body["profile_id"].(string); v == "" {
					body["profile_id"] = p.ID
				}
				if len(p.Descriptors) > 0 {
					body["descriptors"] = p.Descriptors
				}
				if banned := brand_voice.BannedTermsFromRules(p.WritingRules); len(banned) > 0 {
					body["banned_terms"] = banned
				}
			}
		}
		nb, _ := json.Marshal(body)
		req.Body = io.NopCloser(bytes.NewReader(nb))
		req.ContentLength = int64(len(nb))
		req.Header.Set("Content-Type", "application/json")
		voiceProxy.ServeHTTP(w, req)
	}

	return voiceDriftHandler
}

// newAutomationProxyWithLimits wraps the automation proxy with the
// plan-limit check on flow creation. Moved verbatim from run().
func newAutomationProxyWithLimits(planLimits *limits.Enforcer, automationProxy http.Handler) http.HandlerFunc {
	automationProxyWithLimits := http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Method == http.MethodPost && req.URL.Path == "/api/v1/automations" {
			if t, ok := middleware.TenantFromContext(req.Context()); ok && planLimits != nil {
				if err := planLimits.Check(req.Context(), t.ID, limits.ResourceAutomations, 1); err != nil {
					if limits.WriteExceeded(w, err) {
						return
					}
					http.Error(w, http.StatusText(http.StatusInternalServerError), http.StatusInternalServerError)
					return
				}
			}
		}
		automationProxy.ServeHTTP(w, req)
	})

	return automationProxyWithLimits
}

// buildServiceProxies builds the migration, voice, automation and automation
// admin service proxies. Moved verbatim from run().
func buildServiceProxies(cfg config.Config, tenantHeaders func(ctx context.Context, h http.Header)) (http.Handler, http.Handler, http.Handler, http.Handler) {
	migrationProxy := serviceproxy.New(serviceproxy.Options{
		Target:           cfg.MigrationServiceURL,
		PublicPrefix:     "/api/v1/migrations",
		UpstreamPrefix:   "/v1/migrations",
		InternalAPIToken: cfg.InternalAPIToken,
		AddHeaders:       tenantHeaders,
	})
	voiceProxy := serviceproxy.New(serviceproxy.Options{
		Target:           cfg.VoiceServiceURL,
		PublicPrefix:     "/api/v1/voice",
		UpstreamPrefix:   "/v1/voice",
		InternalAPIToken: cfg.InternalAPIToken,
		AddHeaders:       tenantHeaders,
	})
	automationProxy := serviceproxy.New(serviceproxy.Options{
		Target:           cfg.AutomationServiceURL,
		PublicPrefix:     "/api/v1/automations",
		UpstreamPrefix:   "/v1/automations",
		InternalAPIToken: cfg.InternalAPIToken,
		AddHeaders:       tenantHeaders,
	})
	// Admin trigger to run one recurrence scan immediately. Proxied
	// to the automation service's POST /admin/recurrence/run.
	automationAdminProxy := serviceproxy.New(serviceproxy.Options{
		Target:           cfg.AutomationServiceURL,
		PublicPrefix:     "/api/v1/admin/automation",
		UpstreamPrefix:   "/admin",
		InternalAPIToken: cfg.InternalAPIToken,
		AddHeaders:       tenantHeaders,
	})

	return migrationProxy, voiceProxy, automationProxy, automationAdminProxy
}

// newDeliverabilityHeaderWriter builds the header writer the deliverability
// proxies use. Moved verbatim from run().
func newDeliverabilityHeaderWriter(tenantHeaders func(ctx context.Context, h http.Header), stateRepo sending.StateRepo) func(ctx context.Context, h http.Header) {
	deliverabilityHeaders := func(ctx context.Context, h http.Header) {
		tenantHeaders(ctx, h)
		if t, ok := middleware.TenantFromContext(ctx); ok {
			if st, _, err := stateRepo.Get(ctx, t.ID); err == nil && st != nil {
				if st.DKIMDomain != "" {
					h.Set("X-Sending-Domain", st.DKIMDomain)
				}
				if st.DedicatedIP != "" {
					h.Set("X-Sending-IP", st.DedicatedIP)
				}
				h.Set("X-DKIM-Selector", "default")
			}
		}
	}

	return deliverabilityHeaders
}

// buildSuppressionsHandlers builds the X1 suppression handlers with every
// ESP mirror client. Moved verbatim from run().
func buildSuppressionsHandlers(pool *db.Pool, secretsResolver secrets.Resolver, logger *slog.Logger, suppressionsStore *suppressions.Store) *suppressions.StoreHandlers {
	suppressionsMirrorCreds := &suppressions.DBEnvMirrorCredentials{
		Pool: pool, Secrets: secretsResolver,
	}
	// SES suppression mirror uses the AWS credential chain (region from
	// AWS_REGION, same as the SES mailer). If the AWS config can't load, fall
	// back to the fail-loud placeholder so the rest of suppression management
	// still works. Missing per-provider creds/domain degrade to a typed
	// not-configured error (503) inside each client — never a crash.
	var sesSuppressionMirror suppressions.MirrorClient
	if c, sesMirrorErr := suppressions.NewSESMirrorClient(context.Background(), os.Getenv("AWS_REGION")); sesMirrorErr != nil {
		logger.Warn("SES suppression mirror unavailable; using fail-loud placeholder", "err", sesMirrorErr.Error())
		sesSuppressionMirror = suppressions.NewNilMirrorClient(suppressions.MirrorProviderSES)
	} else {
		sesSuppressionMirror = c
	}
	suppressionsHandlers := &suppressions.StoreHandlers{
		Store:  suppressionsStore,
		Audit:  &suppressions.AuditLogger{Pool: pool},
		Logger: logger,
		Mirrors: &suppressions.MirrorClients{
			SES:       sesSuppressionMirror,
			Mailgun:   suppressions.NewMailgunMirrorClient(suppressionsMirrorCreds),
			Postmark:  suppressions.NewPostmarkMirrorClient(suppressionsMirrorCreds),
			Mailchimp: suppressions.NewMailchimpMirrorClient(suppressionsMirrorCreds),
			SendGrid:  suppressions.NewSendGridMirrorClient(suppressionsMirrorCreds),
		},
	}

	return suppressionsHandlers
}

// buildFeedIngestPoller builds the RSS/Atom poller that mints draft digest
// campaigns. Moved verbatim from run().
func buildFeedIngestPoller(pool *db.Pool, outboundWebhookHTTPClient *http.Client, logger *slog.Logger, campaignDeps *campaigns.Deps) (*feed_ingest.Repo, *feed_ingest.Poller) {
	feedIngestRepo := &feed_ingest.Repo{Pool: pool}
	feedIngestPoller := &feed_ingest.Poller{
		Store:      feedIngestRepo,
		HTTPClient: outboundWebhookHTTPClient,
		Logger:     logger,
		Campaigns: feed_ingest.CampaignCreatorFunc(func(ctx context.Context, tenantID string, draft feed_ingest.DraftCampaign) (string, error) {
			c, err := campaignDeps.Repo.Create(ctx, tenantID, campaigns.CreateInput{
				Name:         draft.Name,
				Subject:      draft.Subject,
				BodyHTML:     draft.BodyHTML,
				CampaignType: "rss",
				EditorMode:   "html",
				SegmentID:    draft.SegmentID,
				// Create resolves the list through the tenant's list_id_map
				// before inserting, so a source naming a list the workspace
				// no longer has fails the poll instead of minting a draft.
				ListID: draft.ListID,
				// ScheduledAt deliberately nil → status 'draft'.
			})
			if err != nil {
				return "", err
			}
			if c.ListID != "" || draft.SegmentID != "" {
				if err := campaignDeps.Repo.SetABTestAudience(ctx, tenantID, c.ID, c.ListID, draft.SegmentID); err != nil {
					return "", err
				}
			}
			return c.ID, nil
		}),
	}

	return feedIngestRepo, feedIngestPoller
}

// buildAIRegressionRunnerResult bundles the values buildAIRegressionRunner hands back to run().
type buildAIRegressionRunnerResult struct {
	aiRegressionStore         *ai_regression.Repo
	aiRegressionRuntime       ai_regression.VoiceRuntimeIdentity
	aiRegressionExecutorReady bool
	aiRegressionRunner        *ai_regression.Runner
}

// buildAIRegressionRunner builds the AI-output regression store, runtime
// identity, voice client and runner. Moved verbatim from run().
func buildAIRegressionRunner(pool *db.Pool, cfg config.Config, logger *slog.Logger) buildAIRegressionRunnerResult {
	aiRegressionStore := &ai_regression.Repo{Pool: pool}
	aiRegressionRuntime := ai_regression.VoiceRuntimeIdentity{
		Provider:            ai_regression.DefaultRuntimeProvider,
		ModelID:             ai_regression.DefaultRuntimeModelID,
		PromptPolicyVersion: ai_regression.DefaultRuntimePromptPolicyVersion,
	}
	aiRegressionExecutorReady := strings.TrimSpace(cfg.VoiceServiceURL) != "" &&
		strings.TrimSpace(cfg.InternalAPIToken) != ""
	aiRegressionVoice := ai_regression.NewHTTPRegressionVoiceClient(
		cfg.VoiceServiceURL,
		cfg.InternalAPIToken,
	)
	aiRegressionRunner := &ai_regression.Runner{
		Store:  aiRegressionStore,
		Voice:  aiRegressionVoice,
		Logger: logger,
	}

	return buildAIRegressionRunnerResult{
		aiRegressionStore:         aiRegressionStore,
		aiRegressionRuntime:       aiRegressionRuntime,
		aiRegressionExecutorReady: aiRegressionExecutorReady,
		aiRegressionRunner:        aiRegressionRunner,
	}
}

// buildReferralsRuntime builds the referrals repo, cookie secret and the
// event emitter. Moved verbatim from run().
func buildReferralsRuntime(pool *db.Pool, cfg config.Config, eventsBus *events.Bus) (*referrals.Repo, string, referrals.EventEmitter) {
	referralsRepo := &referrals.Repo{Pool: pool}
	referralCookieSecret := strings.TrimSpace(os.Getenv("POSTWAVE_REFERRAL_COOKIE_SECRET"))
	if referralCookieSecret == "" && !isProductionEnv() {
		referralCookieSecret = strings.TrimSpace(cfg.InternalAPIToken)
	}
	referralEvents := referrals.EventEmitter(func(ctx context.Context, tenantID, eventType string, payload map[string]any) {
		if eventsBus == nil || tenantID == "" || eventType == "" {
			return
		}
		eventsBus.Publish(events.Event{
			Topic:    eventType,
			TenantID: tenantID,
			At:       time.Now().UTC(),
			Payload:  payload,
		})
	})

	return referralsRepo, referralCookieSecret, referralEvents
}

// buildInboundEmailDeps builds the inbound-route action executor and the
// inbound email dependencies. Moved verbatim from run().
func buildInboundEmailDeps(listmonkClient *listmonk.Client, pool *db.Pool, cfg config.Config, logger *slog.Logger, envCipher sending.EnvelopeEncryptor) *inbound_email.Deps {
	var inboundActionSender inbound_email.Sender
	if listmonkClient != nil {
		inboundActionSender = newListmonkSender(
			listmonkClient,
			os.Getenv("POSTWAVE_DEFAULT_FROM_EMAIL"),
		)
	}
	inboundActions := &inbound_email.ActionDeps{
		Pool:                 pool,
		Sender:               inboundActionSender,
		AutomationServiceURL: cfg.AutomationServiceURL,
		InternalAPIToken:     cfg.InternalAPIToken,
		Logger:               logger,
	}
	inboundEmailDeps := &inbound_email.Deps{
		Repo: &inbound_email.Repo{
			Pool:      pool,
			Cipher:    envCipher,
			LegacyKEK: cfg.SendingKEK,
		},
		AutomationServiceURL: cfg.AutomationServiceURL,
		InternalAPIToken:     cfg.InternalAPIToken,
		Actions:              inboundActions,
		Logger:               logger,
	}

	return inboundEmailDeps
}
