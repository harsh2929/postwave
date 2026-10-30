// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/abtests"
	"github.com/postwave/postwave/apps/api/internal/actionticket"
	"github.com/postwave/postwave/apps/api/internal/ai_regression"
	"github.com/postwave/postwave/apps/api/internal/analytics"
	"github.com/postwave/postwave/apps/api/internal/archive"
	"github.com/postwave/postwave/apps/api/internal/assets"
	"github.com/postwave/postwave/apps/api/internal/auth"
	"github.com/postwave/postwave/apps/api/internal/billing"
	"github.com/postwave/postwave/apps/api/internal/blocklist"
	"github.com/postwave/postwave/apps/api/internal/campaigns"
	"github.com/postwave/postwave/apps/api/internal/campaigntemplates"
	"github.com/postwave/postwave/apps/api/internal/config"
	"github.com/postwave/postwave/apps/api/internal/consent"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/discordint"
	"github.com/postwave/postwave/apps/api/internal/events"
	"github.com/postwave/postwave/apps/api/internal/feed_ingest"
	"github.com/postwave/postwave/apps/api/internal/inbound_email"
	"github.com/postwave/postwave/apps/api/internal/lifecycle"
	"github.com/postwave/postwave/apps/api/internal/listmonk"
	"github.com/postwave/postwave/apps/api/internal/lists"
	"github.com/postwave/postwave/apps/api/internal/mailer"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/mobilepush"
	"github.com/postwave/postwave/apps/api/internal/notification_feed"
	"github.com/postwave/postwave/apps/api/internal/notifications"
	"github.com/postwave/postwave/apps/api/internal/notifyfanout"
	"github.com/postwave/postwave/apps/api/internal/notifywebhook"
	"github.com/postwave/postwave/apps/api/internal/outbox"
	"github.com/postwave/postwave/apps/api/internal/pii_scanner"
	"github.com/postwave/postwave/apps/api/internal/referrals"
	"github.com/postwave/postwave/apps/api/internal/reputationalerts"
	"github.com/postwave/postwave/apps/api/internal/safego"
	"github.com/postwave/postwave/apps/api/internal/sendallowance"
	"github.com/postwave/postwave/apps/api/internal/sending"
	"github.com/postwave/postwave/apps/api/internal/slackint"
	"github.com/postwave/postwave/apps/api/internal/sms"
	"github.com/postwave/postwave/apps/api/internal/streaming_export"
	"github.com/postwave/postwave/apps/api/internal/subscribers"
	"github.com/postwave/postwave/apps/api/internal/suppressions"
	"github.com/postwave/postwave/apps/api/internal/teamsint"
	"github.com/postwave/postwave/apps/api/internal/tenantcontrols"
	"github.com/postwave/postwave/apps/api/internal/webhooks"
	"github.com/postwave/postwave/apps/api/internal/webpush"
	"github.com/postwave/postwave/packages/runtime/campaigndispatch"
)

// startStreamingExportWorker starts the hourly streaming export tick unless
// disabled. Moved verbatim from run().
func startStreamingExportWorker(logger *slog.Logger, streamingExportWorker *streaming_export.Worker, outboxCtx context.Context, streamingExportRepo *streaming_export.Repo) {
	if os.Getenv("POSTWAVE_DISABLE_STREAMING_EXPORT_WORKER") != "1" {
		safego.Go(logger, "streaming-export-worker", func() {
			if err := streamingExportWorker.Run(outboxCtx, streamingExportRepo); err != nil &&
				!errors.Is(err, context.Canceled) {
				logger.Error("streaming-export worker exited", "err", err.Error())
			}
		})
	}
}

// startFeedIngestScheduler starts the minute tick that polls due feed
// sources. Moved verbatim from run().
func startFeedIngestScheduler(pool *db.Pool, feedIngestPoller *feed_ingest.Poller, logger *slog.Logger, outboxCtx context.Context) {
	feedIngestScheduler := &feed_ingest.Scheduler{
		Pool:   pool,
		Poller: feedIngestPoller,
		Logger: logger,
	}
	safego.Go(logger, "feed-ingest-scheduler", func() {
		if err := feedIngestScheduler.Run(outboxCtx); err != nil &&
			!errors.Is(err, context.Canceled) {
			logger.Warn("feed_ingest: scheduler exited", "err", err.Error())
		}
	})
}

// startAIRegressionScheduler starts the AI regression scheduler when the
// voice executor is configured. Moved verbatim from run().
func startAIRegressionScheduler(aiRegressionExecutorReady bool, aiRegressionStore *ai_regression.Repo, aiRegressionRunner *ai_regression.Runner, logger *slog.Logger, outboxCtx context.Context) {
	if aiRegressionExecutorReady {
		aiRegressionScheduler := &ai_regression.Scheduler{
			Store:  aiRegressionStore,
			Runner: aiRegressionRunner,
			Logger: logger,
		}
		safego.Go(logger, "ai-regression-scheduler", func() {
			if err := aiRegressionScheduler.Run(outboxCtx); err != nil &&
				!errors.Is(err, context.Canceled) {
				logger.Warn("ai_regression: scheduler exited", "err", err.Error())
			}
		})
	} else {
		logger.Warn("ai_regression: executor disabled because internal Voice authentication is not configured")
	}
}

// startReferralWorkersDeps carries the dependencies startReferralWorkers needs.
type startReferralWorkersDeps struct {
	pool           *db.Pool
	referralsRepo  *referrals.Repo
	authMailer     mailer.Mailer
	logger         *slog.Logger
	referralEvents referrals.EventEmitter
	outboxCtx      context.Context
}

// startReferralWorkers starts the referral congrats sender and verification
// worker when the operational runtime is available. Moved verbatim from run().
func startReferralWorkers(d startReferralWorkersDeps) {
	pool := d.pool
	referralsRepo := d.referralsRepo
	authMailer := d.authMailer
	logger := d.logger
	referralEvents := d.referralEvents
	outboxCtx := d.outboxCtx
	// Refined Referrals PR 3 follow-up: congrats sender. Ticks every
	// 10 min; per-conversion idempotency lives in congrats_sent_at.
	// Lookup is left nil here — wire to subscribers repo once it
	// exposes a SubscriberEmail(tenant, id) helper.
	referralFrom := strings.TrimSpace(os.Getenv("POSTWAVE_REFERRAL_FROM_EMAIL"))
	if referralFrom == "" {
		referralFrom = strings.TrimSpace(os.Getenv("POSTWAVE_DEFAULT_FROM_EMAIL"))
	}
	if referrals.OperationalRuntimeAvailable {
		congratsSender := &referrals.CongratsSender{
			Pool:   pool,
			Repo:   referralsRepo,
			Mailer: authMailer,
			From:   referralFrom,
			Logger: logger,
			Events: referralEvents,
		}
		safego.Go(logger, "referrals-congrats-sender", func() {
			congratsSender.Run(outboxCtx)
		})
		verificationWorker := &referrals.VerificationWorker{
			Pool:   pool,
			Repo:   referralsRepo,
			Logger: logger,
			Events: referralEvents,
		}
		safego.Go(logger, "referrals-verification-worker", func() {
			verificationWorker.Run(outboxCtx)
		})
	}
}

// startCampaignTemplateWorkersDeps carries the dependencies startCampaignTemplateWorkers needs.
type startCampaignTemplateWorkersDeps struct {
	logger                   *slog.Logger
	campaignTemplateDesigns  *campaigntemplates.DesignDraftRepo
	ctplDeps                 *campaigntemplates.Deps
	outboxCtx                context.Context
	assetStorage             assets.Storage
	campaignTemplatePreviews *campaigntemplates.PreviewAssetRepo
}

// startCampaignTemplateWorkers starts the campaign template design and
// preview workers. Moved verbatim from run().
func startCampaignTemplateWorkers(d startCampaignTemplateWorkersDeps) {
	logger := d.logger
	campaignTemplateDesigns := d.campaignTemplateDesigns
	ctplDeps := d.ctplDeps
	outboxCtx := d.outboxCtx
	assetStorage := d.assetStorage
	campaignTemplatePreviews := d.campaignTemplatePreviews
	safego.Go(logger, "campaign-template-design-worker", func() {
		(&campaigntemplates.DesignDraftWorker{
			Store: campaignTemplateDesigns, Templates: ctplDeps.Repo,
			Generator: ctplDeps.Generator, Logger: logger,
		}).Run(outboxCtx)
	})
	switch assetStorage.(type) {
	case *assets.S3Storage, *assets.R2Storage:
		safego.Go(logger, "campaign-template-preview-worker", func() {
			(&campaigntemplates.PreviewAssetWorker{
				Store:   campaignTemplatePreviews,
				Storage: assetStorage,
				Fetcher: campaigntemplates.NewPreviewFetcher(nil),
				Owner: fmt.Sprintf(
					"campaign-template-preview-%d-%d",
					os.Getpid(),
					time.Now().UTC().UnixNano(),
				),
				Logger: logger,
			}).Run(outboxCtx)
		})
	default:
		logger.Info(
			"campaign template preview worker disabled",
			"reason", "durable hosted asset storage is not configured",
		)
	}
}

// startPIICoverageWorker builds the shadow-PII scanner dependencies and
// starts the durable coverage worker. Moved verbatim from run().
func startPIICoverageWorker(pool *db.Pool, cfg config.Config, logger *slog.Logger, eventsBus *events.Bus, outboxCtx context.Context) *pii_scanner.Deps {
	piiScannerRepo := &pii_scanner.Repo{Pool: pool}
	piiDetector, piiDetectorErr := pii_scanner.NewDetector(
		cfg.PIIFingerprintPepper,
		cfg.PIIFingerprintKeyVersion,
	)
	if piiDetectorErr != nil {
		// Scanner capability always fails closed without an explicitly
		// configured dedicated key. A public compile-time development key
		// would turn deterministic fingerprints into an enumeration oracle
		// whenever environment classification was missing or misspelled.
		logger.Error("shadow PII scanner unavailable", "reason", piiDetectorErr.Error())
		piiDetector = nil
	}
	piiScannerDeps := &pii_scanner.Deps{
		Repo:     piiScannerRepo,
		Detector: piiDetector,
		Bus:      eventsBus,
		Logger:   logger,
	}
	// 1762 closes the all-writer coverage boundary at the database: every
	// INSERT and scan-relevant UPDATE persists/coalesces a revision-only intent.
	// This worker performs bounded tenant-scoped value fetches, heartbeat-
	// renewed claims, retry/DLQ processing, and resumable enable/backfill
	// reconciliation. It starts even when the detector key is unavailable so
	// that state is durably reported without burning per-row attempts.
	piiCoverageWorker := pii_scanner.NewCoverageWorker(piiScannerRepo, piiDetector)
	piiCoverageWorker.Deps = piiScannerDeps
	piiCoverageWorker.Logger = logger
	safego.Go(logger, "subscriber-pii-coverage-worker", func() {
		if err := piiCoverageWorker.Run(outboxCtx); err != nil &&
			!errors.Is(err, context.Canceled) {
			logger.Error("shadow PII coverage worker exited", "error_code", "worker_exit")
		}
	})

	return piiScannerDeps
}

// startAudienceSnapshotWorkersDeps carries the dependencies startAudienceSnapshotWorkers needs.
type startAudienceSnapshotWorkersDeps struct {
	pool           *db.Pool
	subscriberDeps *subscribers.Deps
	logger         *slog.Logger
	outboxCtx      context.Context
}

// startAudienceSnapshotWorkers starts the subscriber growth, webmention, list
// version and STO trainer workers. Moved verbatim from run().
func startAudienceSnapshotWorkers(d startAudienceSnapshotWorkersDeps) {
	pool := d.pool
	subscriberDeps := d.subscriberDeps
	logger := d.logger
	outboxCtx := d.outboxCtx
	// SUB-124: daily audience-lifecycle snapshots (migration 1000)
	// backing GET /api/v1/subscribers/growth. Hourly tick, idempotent
	// per UTC day. Opt-out via
	// POSTWAVE_DISABLE_SUBSCRIBER_GROWTH_SNAPSHOTS=1.
	if os.Getenv("POSTWAVE_DISABLE_SUBSCRIBER_GROWTH_SNAPSHOTS") != "1" {
		subscriberGrowthWorker := &subscribers.GrowthSnapshotWorker{
			Pool:   pool,
			Repo:   subscriberDeps.Repo,
			Logger: logger,
		}
		safego.Go(logger, "subscriber-growth-snapshot-worker", func() {
			if err := subscriberGrowthWorker.Run(outboxCtx); err != nil && !errors.Is(err, context.Canceled) {
				logger.Warn("subscriber growth snapshot worker exited", "err", err.Error())
			}
		})
	}

	// Webmention parser worker: drains webmentions_inbox (open-web
	// Recommendations Network receiver), fetches each claimed source
	// over an SSRF-guarded client, verifies the target is actually
	// linked, extracts h-card author + title, and transitions rows to
	// parsed/rejected. Platform-scoped (rows may be tenant_id NULL) and
	// no-ops when the inbox is empty. Opt-out via
	// POSTWAVE_DISABLE_WEBMENTION_PARSER=1.
	if os.Getenv("POSTWAVE_DISABLE_WEBMENTION_PARSER") != "1" {
		webmentionWorker := archive.NewWebmentionWorker(pool, logger)
		safego.Go(logger, "webmention-parser-worker", func() {
			webmentionWorker.Run(outboxCtx)
		})
	}

	// GAP-LS-062: daily per-list snapshots (migration 0255 list_versions)
	// backing GET /api/v1/lists/{id}/versions. Hourly tick, idempotent
	// per UTC day. Opt-out via POSTWAVE_DISABLE_LIST_VERSION_SNAPSHOTS=1.
	if os.Getenv("POSTWAVE_DISABLE_LIST_VERSION_SNAPSHOTS") != "1" {
		listVersionWorker := &lists.VersionWorker{Pool: pool, Logger: logger}
		safego.Go(logger, "list-version-snapshot-worker", func() {
			if err := listVersionWorker.Run(outboxCtx); err != nil && !errors.Is(err, context.Canceled) {
				logger.Warn("list version snapshot worker exited", "err", err.Error())
			}
		})
	}
}

// startCampaignSchedulersDeps carries the dependencies startCampaignSchedulers needs.
type startCampaignSchedulersDeps struct {
	pool               *db.Pool
	campaignDeps       *campaigns.Deps
	cfg                config.Config
	logger             *slog.Logger
	outboxCtx          context.Context
	outboxRepo         *outbox.Repo
	webhooksDispatcher *webhooks.Dispatcher
	slackDispatcher    *slackint.Dispatcher
	discordDispatcher  *discordint.Dispatcher
	teamsDispatcher    *teamsint.Dispatcher
}

// startCampaignSchedulers starts the A/B winner scheduler, the analytics
// digest runner and the inbound-route retention worker. Moved verbatim from
// run().
func startCampaignSchedulers(d startCampaignSchedulersDeps) (*abtests.Repo, *abtests.WinnerDeps) {
	pool := d.pool
	campaignDeps := d.campaignDeps
	cfg := d.cfg
	logger := d.logger
	outboxCtx := d.outboxCtx
	outboxRepo := d.outboxRepo
	webhooksDispatcher := d.webhooksDispatcher
	slackDispatcher := d.slackDispatcher
	discordDispatcher := d.discordDispatcher
	teamsDispatcher := d.teamsDispatcher
	abRepo := &abtests.Repo{Pool: pool}
	campaignDeps.ABRepo = abRepo
	// abWinnerDeps is the shared seam through which the reply tracker
	// feeds real reply counts into the A/B winner picker. Created
	// empty here so the abDeps + abScheduler can capture the pointer
	// at construction time; the // ----- replies ----- block below
	// fills in WinnerDeps.ReplyCounter once repliesStore is built.
	abWinnerDeps := &abtests.WinnerDeps{}
	var abRollout *abtests.RolloutDispatcher
	if campaignSchedulerStartupEnabled(cfg) {
		abRollout = &abtests.RolloutDispatcher{
			Pool: pool,
			Repo: abRepo,
			Creator: &campaigns.ABRolloutDeps{
				Repo:           campaignDeps.Repo,
				ABRepo:         abRepo,
				Pool:           pool,
				RuntimeEnabled: cfg.CampaignLiveDispatchEnabled && cfg.CampaignSchedulerEnabled,
			},
			Logger: logger,
		}
	} else {
		err := campaigndispatch.CheckScheduledMaterialization(
			cfg.CampaignLiveDispatchEnabled && cfg.CampaignSchedulerEnabled,
		)
		code, message := campaigndispatch.PublicError(err)
		logger.Info("A/B winner scheduled rollout disabled",
			"code", code, "reason", message)
	}
	abScheduler := &abtests.Scheduler{
		Pool:       pool,
		Repo:       abRepo,
		Logger:     logger,
		Interval:   5 * time.Minute,
		WinnerDeps: abWinnerDeps,
		// Rollout dispatcher — auto-queues the winning variant to the
		// held-back (100 - sample_pct)% audience after the scheduler
		// decides a winner. Creator implementation lives in the
		// campaigns package so we don't fight import cycles.
		Rollout: abRollout,
	}
	safego.Go(logger, "ab-test-scheduler", func() { abScheduler.Run(outboxCtx) })
	// Analytics digest cron: emits campaign.opens.digest +
	// campaign.clicks.digest hourly, batching the per-recipient
	// open/click events that would otherwise be N×subscribers webhook
	// fires per campaign. Cursor in campaign_digest_cursors
	// guarantees at-most-once-per-window emission across restarts.
	digestRunner := &analytics.DigestRunner{
		Pool:       pool,
		OutboxRepo: outboxRepo,
		Dispatcher: webhooksDispatcher,
		IntegrationFanouts: []webhooks.IntegrationFanouter{
			slackDispatcher, discordDispatcher, teamsDispatcher,
		},
		Logger:   logger,
		Interval: 1 * time.Hour,
	}
	safego.Go(logger, "digest-runner", func() { digestRunner.Run(outboxCtx) })

	// Inbound-route match-history pruner. The matcher records every
	// hit to inbound_route_matches so the admin UI can render a per-
	// rule timeline; without retention the table would accumulate
	// unbounded. 30-day window matches the operator-facing expectation
	// in the UI ("last 50 matches"); cron tick is hourly to keep each
	// delete batch small.
	inboundRetention := &inbound_email.RetentionWorker{
		Pool:      pool,
		RetainFor: 30 * 24 * time.Hour,
		Interval:  time.Hour,
		Logger:    logger,
	}
	safego.Go(logger, "inbound-route-matches-retention", func() {
		if err := inboundRetention.Run(outboxCtx); err != nil &&
			!errors.Is(err, context.Canceled) {
			logger.Warn("inbound-route-matches-retention worker exited",
				"err", err.Error())
		}
	})

	return abRepo, abWinnerDeps
}

// buildTieredSendRateLimiter builds the tiered per-tenant send-rate limiter and
// starts distributed cap coordination. Moved verbatim from run(); the limiter
// close that lived as an inline defer is returned as a cleanup func.
func buildTieredSendRateLimiter(logger *slog.Logger, pool *db.Pool) (*sending.TieredRateLimiter, func(), error) {
	// cleanup closes the distributed cap limiter when one was started; run()
	// defers it where the inline defer used to be registered.
	cleanup := func() {}
	// Per-tenant send-rate limiter: tiered Redis → bounded LRU →
	// (optional) Postgres tertiary. The legacy PostgresRateLimiter
	// took 4-5 roundtrips per recipient and showed up as >40% of the
	// drain-loop wall time under load; the tiered limiter serves the
	// hot path from Redis (single INCR+EXPIRE) or, when REDIS_URL is
	// unset, from a bounded in-process LRU. See
	// internal/sending/ratelimit_tiered.go for the full rationale and
	// the backend-selection metric.
	var sendRateLimitStore middleware.FixedWindowStore
	if redisURL := strings.TrimSpace(os.Getenv("REDIS_URL")); redisURL != "" {
		store, err := middleware.NewRedisFixedWindowStore(redisURL, "postwave:sending")
		if err != nil {
			if isProductionEnv() {
				return nil, cleanup, fmt.Errorf("sending cap authority readiness: %w", err)
			}
			logger.Warn("sending ratelimit: REDIS_URL set but limiter store unavailable; using in-process LRU fallback", "err", err.Error())
		} else {
			sendRateLimitStore = store
			logger.Info("sending ratelimit: Redis-backed tiered limiter active")
		}
	}
	tieredSendRateLimiter := sending.NewTieredRateLimiter(pool, sendRateLimitStore, time.Hour, 0)
	if scriptStore, ok := sendRateLimitStore.(sending.RedisCapScriptStore); ok {
		startCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		startErr := tieredSendRateLimiter.StartCapCoordination(
			startCtx,
			sending.NewRedisCapBackend(scriptStore),
		)
		cancel()
		if startErr != nil {
			return nil, cleanup, fmt.Errorf("sending cap coordination readiness: %w", startErr)
		}
		cleanup = func() { _ = tieredSendRateLimiter.Close() }
		logger.Info("sending ratelimit: atomic distributed cap authority active")
	} else {
		// Distributed cap authority is a production admission invariant, not an
		// optional rate-limit optimization. A memory-fallback override for other
		// limiter families must not boot replica-local sending admissions.
		if isProductionEnv() {
			return nil, cleanup, errors.New("sending cap authority requires a writable Redis service in production")
		}
		// In explicitly single-process development the legacy limiter remains
		// useful, but the settings control path refuses cap writes because it
		// cannot prove cross-replica convergence.
		logger.Warn("sending ratelimit: shared cap authority unavailable; sending-cap settings writes will fail closed")
	}

	return tieredSendRateLimiter, cleanup, nil
}

// buildSendSuppressionConverger builds the shared suppression store and the
// three-table converger and wires it into the campaign queue. Moved verbatim
// from run().
func buildSendSuppressionConverger(pool *db.Pool, logger *slog.Logger, campaignDeps *campaigns.Deps) (*suppressions.Store, *suppressions.SuppressionConverger) {
	// Send-loop guard: drains campaign_recipients while enforcing the
	// per-tenant rate limit + quiet hours configured in
	// tenant_sending_settings. Without this goroutine the marketing
	// claim "Sandbox · Budgets · Approvals" is just a UI knob — the
	// settings persist but nothing reads them at send-time. Runs for
	// the lifetime of the gateway process (shares outboxCtx so SIGTERM
	// cancels it cleanly). Tests can drive RunOnce explicitly without
	// going through Loop.
	// Deliverability suppression store: shared between the X1
	// inbound provider receivers (Postmark/Mailgun/SES) and the send
	// loop's per-row guard. Wired here so the same instance is
	// referenced by both surfaces — see the
	// "----- suppressions + deliverability webhooks -----" section
	// further down for the route + receiver registration.
	suppressionsStore := &suppressions.Store{Pool: pool}
	// Campaign sends must see rows from ALL THREE suppression tables
	// (legacy `suppressions`, Mailchimp-parity `email_suppressions`, and
	// `subscriber_suppressions`) via v_suppressions_unified — otherwise
	// CSV/paste-list imports (which land in the first two tables) are
	// silently ignored at campaign send time (P0 D05#1/#2). The
	// transactional send-core and activation firewall already read through
	// the converger; the campaign queue + send guard were the last raw-
	// store holdouts.
	sendSuppressionConverger := suppressions.NewConverger(suppressionsStore, logger)
	// Wire the bulk-suppression filter into the campaign queue path
	// now that the store is constructed. The campaignDeps struct was
	// built earlier (with the rest of the tenant-scoped wiring) but the
	// store had to wait for the deliverability section. Late assignment
	// is fine: QueueCampaign is mounted further down (after this point)
	// and reads the field at request time.
	campaignDeps.Suppressions = convergerCampaignLookup{conv: sendSuppressionConverger}

	return suppressionsStore, sendSuppressionConverger
}

// startSMSWorker starts the SMS worker when a dedicated worker identity is
// available. Moved verbatim from run().
func startSMSWorker(smsDeps *sms.Deps, cfg config.Config, logger *slog.Logger, outboxCtx context.Context) {
	smsWorker := &sms.Worker{
		Store:         smsDeps.Store,
		Provider:      smsDeps.Provider,
		PublicBaseURL: cfg.SMSProviderCallbackBaseURL,
		Logger:        logger,
		BatchSize:     50,
		LoopInterval:  5 * time.Second,
		MaxAttempts:   3,
	}
	if smsDeps.Store != nil && smsDeps.Store.SMSWorkerIdentityAvailable && smsDeps.Provider != nil {
		safego.Go(logger, "sms-worker", func() {
			if err := smsWorker.Run(outboxCtx); err != nil &&
				!errors.Is(err, context.Canceled) {
				logger.Warn("sms worker exited", "err", err.Error())
			}
		})
	} else {
		// The ordinary API DB role has no cross-tenant SMS worker authority.
		// Report the structural release hold once at startup instead of running
		// a five-second loop that can only fail and flood production logs.
		logger.Info("sms worker disabled", "reason", "dedicated_worker_identity_unavailable")
	}
}

// startSendingMaintenanceWorkers starts the sending deprovision, dedicated-IP
// snapshot, blocklist auto-suppress and double opt-in purge workers. Moved
// verbatim from run().
func startSendingMaintenanceWorkers(logger *slog.Logger, outboxCtx context.Context, provisioner *sending.Provisioner, pool *db.Pool) {
	// Wrapped under safego.Go so the worker participates in the
	// shutdown WaitGroup drain. Previously a bare `go` left this
	// worker running while pool.Close() ran on the deferred path.
	safego.Go(logger, "sending-deprovision-worker", func() {
		runSendingDeprovisionWorker(outboxCtx, provisioner, logger)
	})

	// Dedicated IP reputation snapshot worker. Samples per-IP
	// reputation every 10min, persists snapshots, and auto-rotates
	// halted IPs (tier-1 blocklist hit OR engagement-critical) to
	// 'draining' so the dispatcher routes new traffic away. Sampler
	// defaults to StaticSampler in dev/test; production wires an HTTP
	// client against the deliverability service via
	// POSTWAVE_REPUTATION_SAMPLER_URL.
	{
		ipRepo := &sending.DedicatedIPRepo{Pool: pool}
		var sampler sending.ReputationSampler = &sending.StaticSampler{}
		snapshotWorker := sending.NewSnapshotWorker(ipRepo, sampler, logger)
		safego.Go(logger, "ip-snapshot-worker", func() {
			if err := snapshotWorker.Run(outboxCtx); err != nil &&
				!errors.Is(err, context.Canceled) {
				logger.Warn("dedicated-ip snapshot worker exited", "err", err.Error())
			}
		})
	}

	// Blocklist auto-suppress sweep. The worker is always available, while
	// each workspace remains opted out by default via blocklist_settings.
	// AutoSuppressSweep re-checks the tenant-scoped setting before every
	// mutation; the retired process-wide env flag can no longer opt every
	// tenant in or leave an enabled workspace toggle inert.
	bl := &blocklist.Deps{Pool: pool, Logger: logger}
	safego.Go(logger, "blocklist-auto-suppress", func() {
		t := time.NewTicker(60 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-outboxCtx.Done():
				return
			case <-t.C:
				n, err := bl.AutoSuppressSweep(outboxCtx)
				if err != nil {
					logger.Warn("blocklist auto-suppress sweep failed", "err", err.Error())
					continue
				}
				if n > 0 {
					logger.Info("blocklist auto-suppress sweep", "inserted", n)
				}
			}
		}
	})
	// Double opt-in TTL purger (GAP-LS-094 / Mailchimp parity). Sweeps
	// double_optin_pending every 6h, deletes rows past expires_at, and
	// downgrades the matching unconfirmed subscriber to disabled.
	// Cross-tenant via app.outbox_worker GUC.
	doiPurger := &consent.Purger{Pool: pool, Logger: logger}
	safego.Go(logger, "double-optin-purger", func() {
		doiPurger.Run(outboxCtx)
	})
}

// startOutboxDrainWorkers starts the outbox drain, the reputation alert
// scanner and the overage reconciler. Moved verbatim from run().
func startOutboxDrainWorkers(logger *slog.Logger, outboxWorker *outbox.Worker, outboxCtx context.Context, reputationAlertWorker *reputationalerts.Worker, billingRepo *billing.Repo) {
	safego.Go(logger, "outbox-worker", func() {
		if err := outboxWorker.Run(outboxCtx); err != nil &&
			!errors.Is(err, context.Canceled) {
			logger.Warn("outbox worker exited", "err", err.Error())
		}
	})
	// INBOX-036 alert scanner. Every 2 minutes is well inside the reputation
	// aggregator's 24h cache TTL, so a drop is surfaced on the next fetch cycle.
	safego.Go(logger, "reputation-alert-worker", func() {
		reputationAlertWorker.Start(outboxCtx, 2*time.Minute)
	})
	// BILL-052 overage reconciler. Meters delivered over-cap usage and reports
	// it to Stripe when configured; otherwise accrues locally (ships dark).
	// action=set cumulative means the 10-minute cadence only affects reporting
	// latency, never correctness.
	overageReconciler := &billing.OverageReconciler{
		Repo:   billingRepo,
		Logger: logger,
		Secret: func() string { return os.Getenv("STRIPE_SECRET_KEY") },
	}
	safego.Go(logger, "overage-reconciler", func() {
		overageReconciler.Start(outboxCtx, 10*time.Minute)
	})
}

// wireNotifyFanoutDeps carries the dependencies wireNotifyFanout needs.
type wireNotifyFanoutDeps struct {
	notificationFeedRepo  *notification_feed.Repo
	webpushDeps           *webpush.Deps
	mobilePushDeps        *mobilepush.Deps
	pool                  *db.Pool
	logger                *slog.Logger
	actionTicketLinker    *actionticket.Linker
	eventsBus             *events.Bus
	outboxRegistry        *outbox.Registry
	requiredOutboxKinds   []string
	smsDeps               *sms.Deps
	webhooksFanoutHandler *webhooks.FanoutHandler
}

// wireNotifyFanout builds the unified notification fanout, registers the
// device sign-in outbox handler, validates the registry and wires operator
// notifications into SMS and the webhook fanout. Moved verbatim from run().
func wireNotifyFanout(d wireNotifyFanoutDeps) (*notifyfanout.Fanout, *operatorNotifyAdapter, error) {
	notificationFeedRepo := d.notificationFeedRepo
	webpushDeps := d.webpushDeps
	mobilePushDeps := d.mobilePushDeps
	pool := d.pool
	logger := d.logger
	actionTicketLinker := d.actionTicketLinker
	eventsBus := d.eventsBus
	outboxRegistry := d.outboxRegistry
	requiredOutboxKinds := slices.Concat(d.requiredOutboxKinds, automationOutboxKinds)
	smsDeps := d.smsDeps
	webhooksFanoutHandler := d.webhooksFanoutHandler
	notifyFanout := &notifyfanout.Fanout{
		Feed:   notificationFeedRepo,
		Web:    webpushDeps,
		Mobile: mobilePushDeps,
		Prefs:  &notifications.PgDispatcher{Pool: pool, Logger: logger},
		// SETC-037: the per-user Slack/generic webhook channel, SSRF-safe.
		Webhook: notifywebhook.New(),
		// …and its delivery record (migration 1885). Wired here rather than
		// defaulted inside the Fanout so the dependency stays visible: this was
		// the last of the four channels whose failures were a log line and
		// nothing else.
		WebhookLog: notifywebhook.NewRecorder(pool),
		// Action links for the out-of-app surface (migrations 1893-1895). A Slack
		// message can now be acted on; without POSTWAVE_PUBLIC_BASE_URL the minter
		// returns no link rather than a relative one, and the message still sends.
		Tickets: actionTicketLinker,
		Bus:     eventsBus,
		Log:     logger,
	}
	// A device-grant session is not activated unless this intent was written
	// transactionally. Drain it synchronously here in the worker so a failed
	// feed write is retried; notification-feed/session dedup makes replay safe.
	deviceSignInOutboxHandler := &auth.DeviceSignInOutboxHandler{
		Dispatch: func(ctx context.Context, event auth.NewDeviceSignIn) error {
			return dispatchNewDeviceSignInAlert(ctx, notifyFanout, mobilePushDeps, event)
		},
	}
	outboxRegistry.Register(auth.DeviceSignInOutboxKind, deviceSignInOutboxHandler.Handle)
	if missing := outboxRegistry.MustHave(requiredOutboxKinds...); len(missing) > 0 {
		return nil, nil, fmt.Errorf("outbox registry missing handlers for required kinds: %v", missing)
	}
	operatorNotifier := &operatorNotifyAdapter{Pool: pool, Fanout: notifyFanout, Logger: logger}
	// COMMERCE#2 — announce inbound SMS to the tenant's operators. Wired here
	// rather than at the smsDeps literal because the fanout it needs is
	// constructed above; smsDeps only holds the nil-able hook.
	smsDeps.Notify = operatorNotifier.NotifyInboundSMS
	// AUTOMATION#41 — the first-party half of a cross-service fanout. Assigned
	// here, not at the FanoutHandler literal above, for the same reason: the
	// handler is constructed before the notification fanout exists. Until now
	// every consumer of a sibling service's alert delivered only to a
	// destination the TENANT had configured, so an operational alert reached a
	// human only if somebody had built an integration to receive it.
	webhooksFanoutHandler.OperatorNotify = operatorNotifier
	// ----- end unified notification fanout -----

	return notifyFanout, operatorNotifier, nil
}

// automationOutboxKinds are the outbox kinds services/automation writes and
// registerAutomationMessageHandlers handles. The startup invariant requires
// every one of them: the engine enqueues these rows and treats the enqueue as
// the action done, so a dropped registration would dead-letter each one.
var automationOutboxKinds = []string{
	sms.AutomationOutboxKind,
	campaigns.AutomationEmailOutboxKind,
	lists.AutomationListMembershipKind,
}

// registerAutomationMessageHandlers registers the handlers for the outbox
// rows the automation engine enqueues: send_sms, send_email and move_to_list.
func registerAutomationMessageHandlers(smsDeps *sms.Deps, outboxRegistry *outbox.Registry, pool *db.Pool, listmonkClient *listmonk.Client, tenantControlsRepo *tenantcontrols.Repo, allowance sendallowance.Gate, membershipWebhooks lists.MembershipWebhookFanout, logger *slog.Logger) {
	// Automation SMS: services/automation send_sms nodes can't import this
	// package (separate deploy unit, no provider creds), so they enqueue an
	// automation.sms outbox row. This handler delivers it through the full SMS
	// Gate — consent / quiet-hours / cost / suppression are re-checked here, so
	// an automation graph can never bypass them.
	automationSMSHandler := &sms.AutomationSMSHandler{Deps: smsDeps}
	outboxRegistry.Register(sms.AutomationOutboxKind, automationSMSHandler.Handle)
	// Automation EMAIL: the twin of automation.sms above, and the reason a
	// flow's send_email can no longer bypass the guardrails. The engine used to
	// call Listmonk /api/tx directly, skipping suppression, consent, frequency
	// caps, quiet hours, the send window and the tenant kill switch — and it
	// could not send a Moosewave (uuid) template at all, because it Atoi'd the id.
	automationEmailHandler := &campaigns.AutomationEmailHandler{
		Pool:             pool,
		Suppression:      automationEmailSuppression{store: &suppressions.Store{Pool: pool}},
		Sender:           listmonkClient,
		Pause:            tenantControlsRepo,
		Logger:           logger,
		Allowance:        allowance,
		RequireAllowance: true,
	}
	outboxRegistry.Register(campaigns.AutomationEmailOutboxKind, automationEmailHandler.Handle)
	// Automation MOVE TO LIST: the engine cannot write Moosewave membership, and
	// its old Listmonk-only add never reached the list campaigns send to. The
	// row is written through the owned membership writer, with the same
	// list.subscriber.added fanout as every other membership source.
	automationListMembershipHandler := &lists.AutomationListMembershipHandler{
		Repo:   &lists.Repo{Pool: pool, MembershipWebhooks: membershipWebhooks},
		Logger: logger,
	}
	outboxRegistry.Register(lists.AutomationListMembershipKind, automationListMembershipHandler.Handle)
}

// registerCoreOutboxHandlersResult bundles the values registerCoreOutboxHandlers hands back to run().
type registerCoreOutboxHandlersResult struct {
	outboxRegistry        *outbox.Registry
	formsConfirmation     *formsConfirmationDelivery
	webhooksRepo          *webhooks.Repo
	webhooksFanoutHandler *webhooks.FanoutHandler
}

// registerCoreOutboxHandlersDeps carries the dependencies registerCoreOutboxHandlers needs.
type registerCoreOutboxHandlersDeps struct {
	listmonkClient     *listmonk.Client
	logger             *slog.Logger
	subscriberDeps     *subscribers.Deps
	pool               *db.Pool
	lifecycleRepo      *lifecycle.Repo
	lifecycleForwarder *lifecycle.HTTPAutomationForwarder
	envCipher          sending.EnvelopeEncryptor
	webhooksDispatcher *webhooks.Dispatcher
	slackDispatcher    *slackint.Dispatcher
	discordDispatcher  *discordint.Dispatcher
	teamsDispatcher    *teamsint.Dispatcher
}

// registerCoreOutboxHandlers builds the outbox registry and registers the
// forms, subscriber sync, lifecycle, webhook delivery and fanout handlers.
// Moved verbatim from run().
func registerCoreOutboxHandlers(d registerCoreOutboxHandlersDeps) registerCoreOutboxHandlersResult {
	listmonkClient := d.listmonkClient
	logger := d.logger
	subscriberDeps := d.subscriberDeps
	pool := d.pool
	lifecycleRepo := d.lifecycleRepo
	lifecycleForwarder := d.lifecycleForwarder
	envCipher := d.envCipher
	webhooksDispatcher := d.webhooksDispatcher
	slackDispatcher := d.slackDispatcher
	discordDispatcher := d.discordDispatcher
	teamsDispatcher := d.teamsDispatcher
	// Transactional outbox: durable side-effects after a tenant tx commits.
	// outboxRepo was constructed earlier (before subscriber wiring) so the
	// webhooks Dispatcher could reference it. Here we set up the worker
	// registry + handlers and start draining.
	outboxRegistry := outbox.NewRegistry()
	formsConfirmation := registerFormsSignupHandlers(outboxRegistry,
		newFormsSignupAudience(pool, subscriberDeps.Repo, webhooksDispatcher,
			subscribers.NewEngineResolver(pool, listmonkClient),
			&outbox.Repo{Pool: pool}, logger))
	subscriberListmonkSyncHandler := &subscribers.ListmonkSyncHandler{
		Repo:     subscriberDeps.Repo,
		Resolver: subscribers.NewEngineResolver(pool, listmonkClient),
	}
	outboxRegistry.Register(subscribers.OutboxKindListmonkSync, subscriberListmonkSyncHandler.Handle)
	subscriberListmonkDeleteHandler := &subscribers.ListmonkDeleteHandler{
		Repo:     subscriberDeps.Repo,
		Resolver: subscribers.NewEngineResolver(pool, listmonkClient),
	}
	outboxRegistry.Register(subscribers.OutboxKindListmonkDelete, subscriberListmonkDeleteHandler.Handle)
	lifecycleAutomationHandler := &lifecycle.AutomationOutboxHandler{
		Repo:      lifecycleRepo,
		Forwarder: lifecycleForwarder,
	}
	outboxRegistry.Register(lifecycle.AutomationOutboxKind, lifecycleAutomationHandler.Handle)
	// Outbound webhooks: register the deliver handler against the outbox
	// so subscriber-write events fan out to tenant URLs with at-least-once
	// delivery, retry-on-failure backoff, and HMAC signing (when the KEK
	// is configured).
	webhooksRepo := &webhooks.Repo{Pool: pool}
	webhooksDeliverHandler := &webhooks.DeliverHandler{
		Pool:   pool,
		Repo:   webhooksRepo,
		Cipher: envCipher, // nil-safe: legacy webhooks deliver unsigned
	}
	outboxRegistry.Register(webhooks.OutboxKind, webhooksDeliverHandler.Handle)
	// Cross-service fanout: sibling services (services/migration, /voice,
	// /automation) can't import this package, so they enqueue a single
	// outbox row with kind=webhook.fanout carrying {event_type, body}.
	// FanoutHandler expands that row into N webhooks.deliver rows by
	// re-entering Dispatcher.Fire under a fresh tenant tx. Atomicity-
	// with-business-write is weaker for cross-service events but that's
	// fine for terminal events (migration done, sequence generated)
	// where the business state is already durable.
	webhooksFanoutHandler := &webhooks.FanoutHandler{
		Pool:       pool,
		Dispatcher: webhooksDispatcher,
		// All three integration adapters fan out alongside webhooks.
		// The FanoutHandler runs them inside the same tenant tx so a
		// multi-integration tenant gets atomic delivery across channels.
		IntegrationFanouts: []webhooks.IntegrationFanouter{
			slackDispatcher,
			discordDispatcher,
			teamsDispatcher,
		},
	}
	outboxRegistry.Register(webhooks.FanoutKind, webhooksFanoutHandler.Handle)

	return registerCoreOutboxHandlersResult{
		outboxRegistry:        outboxRegistry,
		formsConfirmation:     formsConfirmation,
		webhooksRepo:          webhooksRepo,
		webhooksFanoutHandler: webhooksFanoutHandler,
	}
}
