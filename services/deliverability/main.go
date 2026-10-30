// Package main is the entrypoint for the Moosewave deliverability service.
//
// Pillar 2: seedlist inbox monitoring, reputation aggregation
// (Postmaster/SNDS/SenderScore), SPF/DKIM/DMARC/BIMI validation, AI
// Diagnostician, and the Pre-Send Predictor. Talks to Listmonk over HTTP only.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/exaring/otelpgx"
	"github.com/getsentry/sentry-go"
	sentryhttp "github.com/getsentry/sentry-go/http"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	runtimeobs "github.com/postwave/postwave/packages/runtime/observability"
	"github.com/postwave/postwave/services/deliverability/internal/auth"
	"github.com/postwave/postwave/services/deliverability/internal/config"
	"github.com/postwave/postwave/services/deliverability/internal/content"
	"github.com/postwave/postwave/services/deliverability/internal/diagnostician"
	"github.com/postwave/postwave/services/deliverability/internal/handlers"
	"github.com/postwave/postwave/services/deliverability/internal/internalauth"
	"github.com/postwave/postwave/services/deliverability/internal/predictor"
	"github.com/postwave/postwave/services/deliverability/internal/render"
	"github.com/postwave/postwave/services/deliverability/internal/reportstore"
	"github.com/postwave/postwave/services/deliverability/internal/reputation"
	"github.com/postwave/postwave/services/deliverability/internal/reputation/blacklist"
	"github.com/postwave/postwave/services/deliverability/internal/reputation/postmaster"
	"github.com/postwave/postwave/services/deliverability/internal/reputation/senderscore"
	"github.com/postwave/postwave/services/deliverability/internal/reputation/snds"
	"github.com/postwave/postwave/services/deliverability/internal/seedlist"
)

const serviceName = "deliverability"

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "fatal: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	cfg := config.Load()

	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: parseLogLevel(cfg.LogLevel),
	}))
	slog.SetDefault(logger)

	logger.Info("starting service", "service", serviceName, "port", cfg.Port)

	// ----- observability: sentry init -----
	defer initSentry(serviceName)()
	// ----- end observability: sentry init -----

	// ----- observability: opentelemetry tracing -----
	tracingCtx, tracingCancel := context.WithCancel(context.Background())
	defer tracingCancel()
	shutdownTracing := runtimeobs.InitTracing(tracingCtx, "postwave-deliverability", sentryEnvironment())
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := shutdownTracing(shutdownCtx); err != nil {
			logger.Warn("tracing: shutdown error", "err", err.Error())
		}
	}()
	// ----- end observability: opentelemetry tracing -----

	// --- Shared Postgres pool for durable deliverability state.
	var dbPool *pgxpool.Pool
	if cfg.DatabaseURL != "" {
		poolCtx, poolCancel := context.WithTimeout(context.Background(), 10*time.Second)
		pgxConfig, perr := pgxpool.ParseConfig(cfg.DatabaseURL)
		if perr == nil {
			pgxConfig.ConnConfig.Tracer = otelpgx.NewTracer()
			dbPool, perr = pgxpool.NewWithConfig(poolCtx, pgxConfig)
		}
		if perr == nil && isProductionEnv() {
			perr = dbPool.Ping(poolCtx)
		}
		poolCancel()
		if perr != nil {
			if isProductionEnv() {
				return fmt.Errorf("postgres: pool init failed in production: %w", perr)
			}
			logger.Warn("postgres: pool init failed; durable stores disabled", "err", perr)
			if dbPool != nil {
				dbPool.Close()
				dbPool = nil
			}
		} else {
			defer dbPool.Close()
			logger.Info("postgres: shared pool wired")
		}
	} else if isProductionEnv() {
		return errors.New("postgres: DATABASE_URL is required in production")
	} else {
		logger.Warn("postgres: DATABASE_URL not set; durable stores disabled")
	}

	// --- Seedlist (Layer 1): registry + poller. Local/dev can run with the
	// no-op connector; production must provide real seed inboxes and either
	// IMAP or a vendor connector so Inbox Reality cannot silently report fake
	// emptiness.
	registry := seedlist.NewRegistry()
	if err := loadSeedlistRegistry(registry, cfg, logger); err != nil {
		if isProductionEnv() {
			return err
		}
		logger.Warn("seedlist config not loaded", "err", err)
	}
	connectorKind := seedlist.ConnectorKindFromEnv()
	if isProductionEnv() {
		if active := countActiveSeedlist(registry); active == 0 {
			return errors.New("seedlist: at least one active seed inbox is required in production")
		}
		if connectorKind == "nop" {
			return errors.New("seedlist: SEEDLIST_CONNECTOR must be imap or vendor in production")
		}
		if connectorKind == "vendor" && strings.TrimSpace(os.Getenv("SEEDLIST_VENDOR_API_URL")) == "" {
			return errors.New("seedlist: SEEDLIST_VENDOR_API_URL is required when SEEDLIST_CONNECTOR=vendor")
		}
		if connectorKind == "imap" {
			if err := validateSeedlistIMAPCredentials(registry); err != nil {
				return err
			}
		}
	}
	connector := seedlist.ConnectorFromEnv()
	applySeedMIMECaptureFlag(connector, cfg.SeedMIMECaptureEnabled)
	var reports interface {
		seedlist.ReportSink
		handlers.CampaignReportStore
	} = reportstore.NewMemoryStore("local")
	var seedObservationStore *reportstore.PostgresStore
	var seedObservationObjects reportstore.ObservationObjectStore
	if cfg.SeedMIMECaptureEnabled && dbPool == nil {
		return errors.New("seedlist: SEED_MIME_CAPTURE_ENABLED requires a ready postgres pool")
	}
	if dbPool != nil {
		if cfg.SeedMIMECaptureEnabled {
			if err := verifySeedObservationDatabase(tracingCtx, dbPool); err != nil {
				return fmt.Errorf("seedlist: raw MIME database readiness: %w", err)
			}
			var err error
			seedObservationObjects, err = buildSeedObservationObjectStore(tracingCtx, cfg)
			if err != nil {
				return fmt.Errorf("seedlist: raw MIME capture readiness: %w", err)
			}
			seedObservationStore = reportstore.NewPostgresStore(dbPool, "", seedObservationObjects)
			if seedObservationStore == nil {
				return errors.New("seedlist: raw MIME capture could not construct postgres report store")
			}
			reports = seedObservationStore
			logger.Info("seedlist: durable raw MIME observation store wired",
				"connector", connectorKind,
				"bucket", cfg.SeedObservationS3Bucket,
				"sse_kms", true)
		} else {
			// The wrapper deliberately does not implement
			// seedlist.MessageObservationSink. Keeping that method out of the
			// dynamic interface prevents a disabled rollout from accepting raw
			// bytes into a Postgres store that has no encrypted object backend.
			pgReports := reportstore.NewPostgresStore(dbPool, "")
			projection := reportstore.NewProjectionOnlyStore(pgReports)
			if projection == nil {
				return errors.New("seedlist: could not construct postgres placement projection store")
			}
			reports = projection
			logger.Info("seedlist: postgres placement projection store wired; raw MIME capture disabled")
		}
	} else if isProductionEnv() {
		return errors.New("seedlist: postgres report store is required in production")
	}
	if err := initializeControlledSeedRegistry(tracingCtx, controlledSeedRegistryDependencies{
		Enabled:   cfg.DurableControlledSeedRegistryEnabled,
		Pool:      dbPool,
		Registry:  registry,
		Connector: connector,
	}); err != nil {
		return err
	}
	inboxRealityRuntime, err := initializeInboxRealityDeliverabilityRuntime(tracingCtx, inboxRealityDeliverabilityDependencies{
		Enabled:               cfg.InboxRealityLifecycleEnabled,
		Pool:                  dbPool,
		Registry:              registry,
		Connector:             connector,
		ConnectorKind:         connectorKind,
		ObservationStore:      seedObservationStore,
		RawMIMECaptureEnabled: cfg.SeedMIMECaptureEnabled,
		GatewayURL:            cfg.InboxRealityGatewayURL,
		BearerToken:           cfg.InternalAPIToken,
		SigningSecrets:        cfg.InboxRealitySigningSecrets,
		SESRegion:             cfg.InboxRealitySESRegion,
		SESConfigurationSet:   cfg.InboxRealitySESConfigurationSet,
	})
	if err != nil {
		return err
	}
	poller := seedlist.NewPoller(registry, connector, seedlist.NopHealthSender{}, reports, logger)
	pollerCtx, pollerCancel := context.WithCancel(context.Background())
	var seedRetentionWG sync.WaitGroup
	defer func() {
		pollerCancel()
		poller.Stop()
		seedRetentionWG.Wait()
	}()
	poller.Start(pollerCtx)
	if cfg.SeedMIMECaptureEnabled {
		// This worker can only exist after the feature-on branch has proved the
		// database schema/privileges and live exact-version S3-KMS deletion. It
		// shares the poller's service-lifetime context and is joined before the
		// shared database pool is closed.
		retention := &reportstore.SeedObservationRetentionSweeper{
			Store:   seedObservationStore,
			Objects: seedObservationObjects,
			Logger:  logger,
		}
		seedRetentionWG.Add(1)
		go func() {
			defer seedRetentionWG.Done()
			if err := retention.Run(pollerCtx); err != nil && !errors.Is(err, context.Canceled) {
				logger.Warn("seed observation retention worker exited", "err", err.Error())
			}
		}()
		logger.Info("seed observation retention worker started", "interval", time.Hour)
	}

	// --- Reputation (Layer 2): adapter aggregator. Sources only become
	// active when their credentials are present in env.
	repSources := []reputation.Source{blacklist.New()}
	if cfg.PostmasterCredentials != "" {
		repSources = append(repSources, postmaster.New(cfg.PostmasterCredentials))
	}
	if cfg.MicrosoftSNDSKey != "" {
		repSources = append(repSources, snds.New(cfg.MicrosoftSNDSKey))
	}
	if v := os.Getenv("VALIDITY_SENDERSCORE_KEY"); v != "" {
		repSources = append(repSources, senderscore.New(v))
	}
	repAgg := reputation.NewAggregator(repSources...)

	// --- Blocklist monitor (Layer 2.5). Continuous DNSBL polling
	// across the 80+ zones cataloged in blacklist/zones.go. Writes
	// observations to blocklist_observations (migration 0112). The
	// API surfaces the latest-per-zone view at GET
	// /api/v1/monitoring/blocklist-status (mounted in apps/api).
	//
	// Free-pool IPs are taken from POSTWAVE_FREE_POOL_IPS (comma-
	// separated). Dedicated IPs + verified domains are discovered
	// from the DB by LoadTargetsFromPostgres.
	if dbPool != nil {
		store := blacklist.NewPostgresStore(dbPool)
		freePool := []string{}
		if v := strings.TrimSpace(os.Getenv("POSTWAVE_FREE_POOL_IPS")); v != "" {
			for _, ip := range strings.Split(v, ",") {
				if ip = strings.TrimSpace(ip); ip != "" {
					freePool = append(freePool, ip)
				}
			}
		}
		targets := blacklist.LoadTargetsFromPostgres(dbPool, freePool)
		monitor := blacklist.NewMonitor(blacklist.New(), store, targets)
		worker := blacklist.NewWorker(monitor, logger)
		// Reuse the poller context (canceled on shutdown via the
		// poller.Stop deferred above + signal handling further down).
		go func() {
			if err := worker.Run(pollerCtx); err != nil && !errors.Is(err, context.Canceled) {
				logger.Warn("blocklist worker exited", "err", err.Error())
			}
		}()
	} else {
		logger.Warn("blocklist worker: dbPool unavailable, not starting")
	}

	// --- Auth (Layer 3): real DNS resolver. No external creds required.
	authResolver := auth.New()

	// --- DMARC aggregate-report ingestion (Layer 3.5).
	//
	// Two independent pieces of config: the shared Postgres pool and the
	// default-off legacy IMAP poller. Either can be missing in local/dev — log a
	// warning and continue rather than fail startup. Production rejects the
	// break-glass flag before storage setup so a missing database cannot bypass
	// the trust-boundary guard. RLS ensures cross-tenant reads are denied.
	if legacyDMARCIMAPForbiddenInProduction() {
		return errors.New("dmarc poller: untrusted legacy IMAP ingestion is forbidden in production; configure an authenticated inbound transport")
	}
	var dmarcStore *auth.Store
	if dbPool != nil {
		s, serr := auth.NewStore(dbPool)
		if serr != nil {
			if isProductionEnv() {
				return fmt.Errorf("dmarc storage: NewStore failed in production: %w", serr)
			}
			logger.Warn("dmarc storage: NewStore failed; storage disabled", "err", serr)
		} else {
			dmarcStore = s
			logger.Info("dmarc storage: pgx pool wired")
		}
	} else {
		logger.Warn("dmarc storage: shared postgres pool not available; storage disabled")
	}

	// INBOX-031: reputation trend store. Disabled (nil) without a pool; the
	// handler nil-guards it and capture-on-fetch is best-effort.
	var repHistory *reputation.SnapshotStore
	if dbPool != nil {
		if s, serr := reputation.NewSnapshotStore(dbPool); serr == nil {
			repHistory = s
			logger.Info("reputation history: pgx pool wired")
		} else {
			logger.Warn("reputation history: NewSnapshotStore failed; disabled", "err", serr)
		}
	}

	if dmarcStore != nil {
		poller, perr := auth.PollerFromEnv(dmarcStore, logger)
		if perr != nil {
			logger.Warn("dmarc poller: config invalid; poller disabled", "err", perr)
		} else if poller == nil {
			logger.Warn("dmarc poller: legacy IMAP ingestion is disabled; a trusted recipient- and authentication-verdict transport is required for production")
		} else {
			// ----- send-domain client wiring (cross-service tenant resolution) -----
			//
			// The DefaultTenantResolver constructed by PollerFromEnv has a
			// nil SendDomainClient by default — that means step 2 of the
			// resolution order (policy_published.domain → tenant) is
			// skipped. We upgrade the resolver here when both
			// POSTWAVE_API_BASE_URL and POSTWAVE_INTERNAL_API_TOKEN are
			// set so deliverability can map DMARC reports to tenants by
			// domain even when the envelope-To plus-addressing strategy
			// doesn't match.
			//
			// Either env var being unset is non-fatal: we log a Warn and
			// leave the resolver at its current shape (back-compat with
			// pre-cross-service deploys).
			apiBaseURL := strings.TrimSpace(os.Getenv("POSTWAVE_API_BASE_URL"))
			apiInternalToken := strings.TrimSpace(os.Getenv("POSTWAVE_INTERNAL_API_TOKEN"))
			if apiBaseURL == "" || apiInternalToken == "" {
				logger.Warn("dmarc poller: send-domain client disabled (POSTWAVE_API_BASE_URL or POSTWAVE_INTERNAL_API_TOKEN unset); step 2 of tenant resolution will be skipped")
			} else if def, ok := poller.TenantResolver.(auth.DefaultTenantResolver); ok {
				def.SendDomainClient = &auth.SendDomainClient{
					BaseURL:   apiBaseURL,
					AuthToken: apiInternalToken,
					HTTPClient: &http.Client{
						Transport: runtimeobs.HTTPTransport(nil),
						Timeout:   5 * time.Second,
					},
				}
				poller.TenantResolver = def
				logger.Info("dmarc poller: send-domain client wired", "api_base_url", apiBaseURL)
			}
			// ----- end send-domain client wiring -----
			pollerCtx, pollerStop := context.WithCancel(context.Background())
			go poller.Run(pollerCtx)
			defer pollerStop()
			logger.Info("dmarc poller: started",
				"host", poller.Host,
				"port", poller.Port,
				"folder", poller.Folder,
				"interval", poller.Interval.String(),
			)
		}
	}

	// --- Content (Layer 4).
	scanner := content.New()

	// --- Diagnostician (Layer 5). Real Gemini client when GEMINI_API_KEY
	// is present; otherwise fall back to StubLLMClient with a startup
	// warning so dev/CI environments still serve plausible responses for
	// the three starter eval cases.
	//
	// Production gate: refuse to start without a real key. The StubLLMClient
	// returns canned output for 3 hardcoded eval ids — in prod this would
	// surface as plausible-looking diagnoses for unrelated campaigns.
	var llm diagnostician.LLMClient
	if isProductionEnv() {
		promptPath := strings.TrimSpace(os.Getenv("DIAGNOSTICIAN_PROMPTS_PATH"))
		if err := diagnostician.ValidatePromptPack(promptPath); err != nil {
			return fmt.Errorf("diagnostician: production prompt pack invalid: %w", err)
		}
		evalPath := strings.TrimSpace(os.Getenv("DIAGNOSTICIAN_EVAL_CASES_PATH"))
		if evalPath == "" {
			return errors.New("diagnostician: DIAGNOSTICIAN_EVAL_CASES_PATH is required in production")
		}
		if _, err := os.Stat(evalPath); err != nil {
			return fmt.Errorf("diagnostician: DIAGNOSTICIAN_EVAL_CASES_PATH invalid: %w", err)
		}
	}
	if key := cfg.GeminiAPIKey; key != "" {
		llm = &diagnostician.GeminiClient{APIKey: key, MaxTokens: 4096, MaxRetries: 3}
		logger.Info("diagnostician: real Gemini client wired", "model", diagnostician.Model)
	} else {
		if isProductionEnv() {
			return errors.New("diagnostician: GEMINI_API_KEY is required in production (refusing to start with StubLLMClient — diagnose calls would return canned output for unrelated test cases)")
		}
		llm = diagnostician.StubLLMClient{}
		logger.Warn("diagnostician: GEMINI_API_KEY not set; using StubLLMClient (dev-only). Diagnose calls will return deterministic stub output.")
	}
	diag := diagnostician.New(llm)

	// --- Predictor.
	pred := predictor.New()

	// --- Renderer (cross-client preview). Real HCTI client when both
	// HCTI_USER_ID and HCTI_API_KEY are set; otherwise fall back to the
	// deterministic MockRenderer so /v1/render still returns plausible
	// output for the editor preview tab in dev/CI.
	//
	// Production gate: refuse to start without HCTI creds. MockRenderer
	// serves placehold.co PNGs which would appear as broken cross-client
	// previews to real customers.
	var renderer render.Renderer
	if uid, key := os.Getenv("HCTI_USER_ID"), os.Getenv("HCTI_API_KEY"); uid != "" && key != "" {
		hc, err := render.NewHCTIClient(uid, key)
		if err != nil {
			if isProductionEnv() {
				return fmt.Errorf("renderer: HCTI init failed in production: %w", err)
			}
			logger.Warn("renderer: HCTI init failed; using MockRenderer", "err", err)
			renderer = render.MockRenderer{}
		} else {
			if dbPool != nil {
				hc.Cache = render.NewPostgresCache(dbPool)
				logger.Info("renderer: postgres render cache wired")
			}
			renderer = hc
			logger.Info("renderer: HCTI client wired")
		}
	} else {
		if isProductionEnv() {
			return errors.New("renderer: HCTI_USER_ID and HCTI_API_KEY are required in production (refusing to start with MockRenderer — cross-client previews would show placehold.co placeholder PNGs to customers)")
		}
		renderer = render.MockRenderer{}
		logger.Warn("renderer: HCTI_USER_ID/HCTI_API_KEY not set; using MockRenderer (dev-only; placehold.co URLs).")
	}

	r := chi.NewRouter()
	// OpenTelemetry HTTP middleware. No-op when OTEL_EXPORTER_OTLP_ENDPOINT
	// is unset. Continues the incoming W3C traceparent so cross-service
	// flows stitch end-to-end.
	r.Use(runtimeobs.HTTPMiddleware("postwave-deliverability"))
	// Sentry HTTP middleware. No-op when SENTRY_DSN_DELIVERABILITY is unset.
	r.Use(sentryhttp.New(sentryhttp.Options{Repanic: true, WaitForDelivery: false}).Handle)
	// Metrics remain tenant-less but are not public. A loopback sidecar may
	// scrape directly; a remote collector must use the dedicated bearer.
	metricsHandler := runtimeobs.ProtectMetrics(os.Getenv("METRICS_TOKEN"), promhttp.Handler())
	r.Get("/metrics", metricsHandler.ServeHTTP)
	r.Get("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"service": serviceName,
			"status":  "ok",
		})
	})

	r.Group(func(protected chi.Router) {
		protected.Use(internalauth.Middleware(cfg.InternalAPIToken))
		inboxRealityRuntime.MountInternal(protected)

		handlers.Mount(protected, handlers.Deps{
			Reports:           reports,
			Reputation:        repAgg,
			ReputationHistory: repHistory,
			AuthResolver:      authResolver,
			Tenant:            handlers.HeaderTenantResolver{},
			Diagnostician:     diag,
			Predictor:         pred,
			ContentScanner:    scanner,
			Renderer:          renderer,
			DMARC:             dmarcStore,
		})
	})

	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           r,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      2 * time.Minute,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    64 << 10,
	}

	errCh := make(chan error, 1)
	go func() {
		logger.Info("listening", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- fmt.Errorf("listen: %w", err)
			return
		}
		errCh <- nil
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	select {
	case sig := <-stop:
		logger.Info("shutdown signal received", "signal", sig.String())
	case err := <-errCh:
		if err != nil {
			return err
		}
		return nil
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("graceful shutdown: %w", err)
	}
	logger.Info("server stopped cleanly")
	return nil
}

func parseLogLevel(s string) slog.Level {
	switch strings.ToLower(s) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

func loadSeedlistRegistry(registry *seedlist.Registry, cfg config.Config, logger *slog.Logger) error {
	if raw := strings.TrimSpace(os.Getenv("POSTWAVE_SEEDLIST_IMAP_JSON")); raw != "" {
		if err := registry.LoadJSON(raw); err != nil {
			return fmt.Errorf("seedlist: POSTWAVE_SEEDLIST_IMAP_JSON: %w", err)
		}
		logger.Info("seedlist: inline JSON registry loaded", "active_inboxes", countActiveSeedlist(registry))
		return nil
	}
	path := strings.TrimSpace(cfg.SeedlistConfigPath)
	if path == "" {
		if isProductionEnv() {
			return errors.New("seedlist: SEEDLIST_CONFIG_PATH or POSTWAVE_SEEDLIST_IMAP_JSON is required in production")
		}
		path = defaultSeedlistPath()
	}
	if err := registry.Load(path); err != nil {
		return err
	}
	logger.Info("seedlist: registry loaded", "path", path, "active_inboxes", countActiveSeedlist(registry))
	return nil
}

func defaultSeedlistPath() string {
	for _, path := range []string{"seedlist.yaml", "services/deliverability/seedlist.yaml"} {
		if _, err := os.Stat(path); err == nil {
			return path
		}
	}
	return "seedlist.yaml"
}

func countActiveSeedlist(registry *seedlist.Registry) int {
	if registry == nil {
		return 0
	}
	count := 0
	for _, in := range registry.All() {
		if in.Status == seedlist.StatusActive {
			count++
		}
	}
	return count
}

func validateSeedlistIMAPCredentials(registry *seedlist.Registry) error {
	var missing []string
	for _, in := range registry.All() {
		if in.Status != seedlist.StatusActive {
			continue
		}
		if strings.TrimSpace(in.IMAPHost) == "" {
			missing = append(missing, in.ID+": imap_host")
		}
		if strings.TrimSpace(in.IMAPUser) == "" {
			missing = append(missing, in.ID+": imap_user")
		}
		if strings.TrimSpace(in.IMAPPasswordEnv) == "" {
			missing = append(missing, in.ID+": imap_password_env")
		} else if strings.TrimSpace(in.Password()) == "" {
			missing = append(missing, in.ID+": env "+in.IMAPPasswordEnv)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("seedlist: active IMAP inbox credentials missing (%s)", strings.Join(missing, ", "))
	}
	return nil
}

// initSentry wires sentry-go using SENTRY_DSN_<SERVICE>. Returns a
// no-op flush func when the DSN is unset (dev / local). Each service
// ships its own DSN → its own Sentry project for triage.
func initSentry(serviceName string) func() {
	dsn := os.Getenv("SENTRY_DSN_" + strings.ToUpper(serviceName))
	if dsn == "" {
		slog.Info("sentry: no DSN; running without error tracking", "service", serviceName)
		return func() {}
	}
	err := sentry.Init(sentry.ClientOptions{
		Dsn:              dsn,
		Environment:      sentryEnvironment(),
		Release:          os.Getenv("POSTWAVE_RELEASE"),
		TracesSampleRate: 0.1,
		AttachStacktrace: true,
		BeforeSend:       redactSentryEvent,
	})
	if err != nil {
		slog.Error("sentry: init failed", "err", err.Error())
		return func() {}
	}
	slog.Info("sentry: wired", "service", serviceName, "environment", sentryEnvironment())
	return func() { sentry.Flush(2 * time.Second) }
}

// sentryEnvironment returns the first non-empty of POSTWAVE_ENV /
// ENVIRONMENT / NODE_ENV, defaulting to "development".
func sentryEnvironment() string {
	for _, key := range []string{"POSTWAVE_ENV", "ENVIRONMENT", "NODE_ENV"} {
		if v := strings.TrimSpace(os.Getenv(key)); v != "" {
			return v
		}
	}
	return "development"
}

// redactSentryEvent strips PII/secrets from outgoing Sentry events:
// request bodies, Authorization/Cookie/X-Postwave-Token headers, and
// api_key/token/secret query parameters.
func redactSentryEvent(event *sentry.Event, _ *sentry.EventHint) *sentry.Event {
	if event == nil || event.Request == nil {
		return event
	}
	event.Request.Data = ""
	event.Request.Cookies = ""
	if event.Request.Headers != nil {
		for _, k := range []string{"Authorization", "Cookie", "X-Postwave-Token"} {
			delete(event.Request.Headers, k)
		}
	}
	if event.Request.URL != "" {
		if u, perr := url.Parse(event.Request.URL); perr == nil {
			q := u.Query()
			touched := false
			for k := range q {
				if isSensitiveSentryQueryKey(k) {
					for i := range q[k] {
						q[k][i] = "[redacted]"
					}
					touched = true
				}
			}
			if touched {
				u.RawQuery = q.Encode()
				event.Request.URL = u.String()
			}
		}
	}
	return event
}

func isSensitiveSentryQueryKey(name string) bool {
	lower := strings.ToLower(name)
	for _, part := range []string{
		"api_key", "token", "key", "secret", "password", "passwd", "pwd",
		"signature", "sig", "hmac", "authorization", "auth",
		"code", "state", "session", "email", "e-mail", "subscriber", "recipient", "address",
	} {
		if strings.Contains(lower, part) {
			return true
		}
	}
	return false
}

// isProductionEnv mirrors the apps/api gateway helper. Returns true when
// any of the standard env-marker variables identify a production deploy.
// Used to fail-loud when GEMINI_API_KEY or HCTI creds are missing so
// the service cannot silently fall back to StubLLMClient/MockRenderer
// in prod (would otherwise return canned diagnoses + placehold.co PNGs
// to real customers).
func isProductionEnv() bool {
	for _, key := range []string{"POSTWAVE_ENV", "ENVIRONMENT", "NODE_ENV"} {
		v := strings.TrimSpace(os.Getenv(key))
		if strings.EqualFold(v, "production") || strings.EqualFold(v, "prod") {
			return true
		}
	}
	return false
}

func legacyDMARCIMAPForbiddenInProduction() bool {
	return isProductionEnv() && strings.EqualFold(
		strings.TrimSpace(os.Getenv("DMARC_IMAP_ALLOW_UNTRUSTED_LEGACY_INGESTION")),
		"true",
	)
}
