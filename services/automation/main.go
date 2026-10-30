// Package main is the entrypoint for the Moosewave automation runtime.
//
// Phase 2 in-house runtime that executes wait/branch/send/action nodes against
// Listmonk's transactional API. Powers Pillar 3 voice sequences and supported
// paused Mailchimp Classic Automations. Customer Journey graphs are manual
// rebuild work because Mailchimp does not expose a supported general export.
//
// Architecture (see services/automation/README.md for diagrams):
//
//   - HTTP control plane (this file's chi server) accepts /v1/automations/*
//     calls from the apps/api gateway: trigger, pause, resume, health.
//   - Asynq worker (started in a goroutine here) consumes the
//     "automation_default" queue and drives runtime.Engine.Execute.
//   - Wait nodes are scheduled via Asynq's ProcessAt; Redis owns the
//     delay tier.
//   - Listmonk is reached over HTTP only — no go imports across the
//     license boundary (see LICENSE-BOUNDARY.md).
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
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5/pgxpool"
	sharedusage "github.com/postwave/postwave/packages/runtime/commercialusage"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/postwave/postwave/packages/runtime/campaigndispatch"
	runtimedb "github.com/postwave/postwave/packages/runtime/db"
	runtimeobs "github.com/postwave/postwave/packages/runtime/observability"
	"github.com/postwave/postwave/services/automation/internal/config"
	"github.com/postwave/postwave/services/automation/internal/handlers"
	"github.com/postwave/postwave/services/automation/internal/internalauth"
	"github.com/postwave/postwave/services/automation/internal/listmonk"
	"github.com/postwave/postwave/services/automation/internal/runtime"
	"github.com/postwave/postwave/services/automation/internal/worker"
)

const serviceName = "automation"

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

	// ----- observability: sentry init (shared packages/runtime) -----
	// Uses SENTRY_DSN_AUTOMATION. PII redaction (Authorization headers,
	// secret query params, request bodies) lives inside the shared
	// helper so every service strips the same surface before emitting.
	defer runtimeobs.InitSentry(serviceName, sentryEnvironment())()
	// ----- end observability: sentry init -----

	// ----- observability: opentelemetry tracing (shared packages/runtime) -----
	tracingCtx, tracingCancel := context.WithCancel(context.Background())
	defer tracingCancel()
	shutdownTracing := runtimeobs.InitTracing(tracingCtx, "postwave-automation", sentryEnvironment())
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := shutdownTracing(shutdownCtx); err != nil {
			logger.Warn("tracing: shutdown error", "err", err.Error())
		}
	}()
	// ----- end observability: opentelemetry tracing -----

	redisOpt, err := asynq.ParseRedisURI(cfg.RedisURL)
	if err != nil {
		return fmt.Errorf("parse redis url: %w", err)
	}

	queue := runtime.NewRedisQueue(redisOpt, cfg.AsynqQueueName)
	defer func() { _ = queue.Close() }()
	queueMetricsCtx, queueMetricsCancel := context.WithCancel(context.Background())
	defer queueMetricsCancel()
	go worker.RunQueueMetrics(queueMetricsCtx, queue, cfg.AsynqQueueName, 15*time.Second)

	var store runtime.StateStore = runtime.NewMemoryStore()
	memResolver := runtime.NewMemoryResolver()
	var resolver runtime.SubscriberResolver = memResolver
	var lister runtime.AutomationLister = memResolver
	var automationStore runtime.AutomationStore = memResolver
	var triggerWriter runtime.BehavioralTriggerWriter = memResolver
	var pool *pgxpool.Pool
	if cfg.DatabaseURL != "" {
		// packages/runtime/db.New installs the AfterRelease hook that
		// RESETs the worker GUCs (app.tenant_id, app.outbox_worker,
		// app.tenant_resolver, app.sending_deprovision_worker) on every
		// connection return — that closes the GUC-leak hole that the
		// previous bare pgxpool.NewWithConfig left open. The otelpgx
		// tracer + Ping + privileged-role rejection are all baked into
		// the helper, so we no longer need them inline here.
		newPoolCtx, cancelNewPool := context.WithTimeout(context.Background(), 15*time.Second)
		newPool, perr := runtimedb.New(newPoolCtx, cfg.DatabaseURL)
		cancelNewPool()
		if perr != nil {
			if !cfg.AllowMemoryFallback {
				return fmt.Errorf("automation: postgres init failed: %w", perr)
			}
			logger.Warn("automation: postgres init failed, falling back to in-memory state store", "err", perr.Error())
		} else {
			pool = newPool
		}
		if pool != nil {
			pgResolver, rerr := runtime.NewPostgresResolver(pool)
			if rerr != nil {
				if !cfg.AllowMemoryFallback {
					return fmt.Errorf("automation: postgres resolver init failed: %w", rerr)
				}
				logger.Warn("automation: postgres resolver init failed, falling back to in-memory", "err", rerr.Error())
			} else {
				resolver = pgResolver
				lister = pgResolver
				automationStore = pgResolver
				triggerWriter = pgResolver
				logger.Info("automation: postgres resolver enabled")
				ps, perr := runtime.NewPostgresStateStore(pool, pgResolver.TenantOfAutomation)
				if perr != nil {
					if !cfg.AllowMemoryFallback {
						return fmt.Errorf("automation: postgres state store init failed: %w", perr)
					}
					logger.Warn("automation: postgres state store init failed", "err", perr.Error())
				} else {
					store = ps
					logger.Info("automation: postgres state store enabled")
				}
			}
		}
	} else {
		logger.Warn("automation: DATABASE_URL unset — using in-memory state store (executions lost on restart)")
	}
	if pool != nil {
		defer pool.Close()
	}

	tenantRoutes, err := tenantengine.FromEnv()
	if err != nil {
		return fmt.Errorf("email destination routing: %w", err)
	}
	lmClient := listmonk.New(listmonk.Config{
		ResolveDestination: func(ctx context.Context, tenantID string) (listmonk.Config, error) {
			if tenantRoutes == nil {
				if err := tenantengine.CheckLegacyPGX(ctx, pool, tenantID); err != nil {
					return listmonk.Config{}, err
				}
				return listmonk.Config{BaseURL: cfg.ListmonkURL, User: cfg.ListmonkAdminUser, Password: cfg.ListmonkAdminPassword}, nil
			}
			route, err := tenantRoutes.Resolve(tenantID)
			if err != nil {
				return listmonk.Config{}, err
			}
			if err := tenantengine.VerifyPGX(ctx, pool, route); err != nil {
				return listmonk.Config{}, err
			}
			return listmonk.Config{BaseURL: route.BaseURL, User: route.AdminUser, Password: route.AdminPassword}, nil
		},
		BaseURL:  cfg.ListmonkURL,
		User:     cfg.ListmonkAdminUser,
		Password: cfg.ListmonkAdminPassword,
		Timeout:  30 * time.Second,
	})

	engine := &runtime.Engine{
		Listmonk: lmClient,
		Store:    store,
		Queue:    queue,
		Resolver: resolver,
		Logger:   logger,
	}
	if pool != nil {
		engine.UsageMeter = &sharedusage.Meter{Pool: pool}
		engine.RequireUsageMeter = true
	}
	// Webhook fanout: when the engine reaches a journey's terminal node,
	// it writes a webhook.fanout outbox row scoped to the tenant; the
	// apps/api gateway worker expands that into per-subscription
	// deliveries. nil pool = no fanout (test/dev — keeps the engine
	// otherwise unchanged).
	if pool != nil {
		// Approval gate: manual_review nodes (and RequiresApproval nodes) park
		// until an operator approves/rejects via automation_message_approvals.
		engine.Approvals = &runtime.PgxApprovalGate{Pool: pool}
		engine.FanoutEmitter = &runtime.PgxFanoutEmitter{Pool: pool}
		// Coupon assignment is compiled out until the API-side entitlement
		// authority and reconciliation boundary is release-qualified.
		if runtime.CouponAllocationAvailable {
			engine.Coupon = &runtime.PgxCouponEmitter{Pool: pool}
		}
		// send_sms nodes enqueue an automation.sms outbox row for apps/api to
		// deliver (consent/quiet-hours/cost re-checked there).
		engine.SMS = &runtime.PgxSMSEmitter{Pool: pool}
		// send_email does the same. Without this the engine calls Listmonk
		// /api/tx directly, bypassing suppression, consent, frequency caps,
		// quiet hours, the send window and the tenant kill switch — and cannot
		// send a Moosewave (uuid) template at all.
		engine.Email = &runtime.PgxEmailEmitter{Pool: pool}
		// move_to_list actions enqueue an automation.list_membership row; apps/api
		// writes the membership campaigns send to. Without a pool the action
		// fails closed rather than touching only the engine's copy of the list.
		engine.ListMembership = &runtime.PgxListMembershipEmitter{Pool: pool}
	}
	// webhook nodes / flow_webhook actions make SSRF-guarded outbound HTTP
	// calls. Optional HMAC signing via AUTOMATION_WEBHOOK_SIGNING_SECRET.
	engine.Webhook = runtime.NewHTTPWebhookEmitter(os.Getenv("AUTOMATION_WEBHOOK_SIGNING_SECRET"))

	// Asynq server.
	asynqSrv := asynq.NewServer(redisOpt, asynq.Config{
		Concurrency:    cfg.WorkerConcurrency,
		Queues:         map[string]int{cfg.AsynqQueueName: 10},
		Logger:         asynqSlogAdapter{logger: logger},
		RetryDelayFunc: worker.RetryDelayFunc,
	})
	mux := asynq.NewServeMux()
	worker.Register(mux, &worker.Handler{Engine: engine, Logger: logger})

	workerErrCh := make(chan error, 1)
	go func() {
		logger.Info("asynq worker starting", "queue", cfg.AsynqQueueName)
		if err := asynqSrv.Run(mux); err != nil {
			workerErrCh <- fmt.Errorf("asynq server: %w", err)
			return
		}
		workerErrCh <- nil
	}()

	// X1+X2+X3 recurrence scanner: nightly cross-tenant scan over
	// campaigns.recurrence_cron, materializing child campaigns for
	// fire times falling in the next Window. No-op when pool == nil
	// (dev / in-memory mode where state is not persisted anyway).
	// scannerCtx is cancelled in the shutdown path below so the
	// scanner's ticker exits cleanly.
	scannerCtx, scannerCancel := context.WithCancel(context.Background())
	defer scannerCancel()
	var recurrenceScanner *worker.RecurrenceScanner
	campaignSchedulingRuntimeEnabled := cfg.CampaignLiveDispatchEnabled && cfg.CampaignSchedulerEnabled
	if pool != nil && campaignSchedulingStartupEnabled(cfg) {
		recurrenceScanner = &worker.RecurrenceScanner{
			Pool:           pool,
			Logger:         logger,
			Window:         24 * time.Hour,
			Interval:       24 * time.Hour,
			RuntimeEnabled: campaignSchedulingRuntimeEnabled,
		}
		go recurrenceScanner.Run(scannerCtx)
		logger.Info("automation: recurrence scanner started",
			"window", "24h", "interval", "24h")
	} else if pool != nil {
		err := campaigndispatch.CheckScheduledMaterialization(campaignSchedulingRuntimeEnabled)
		code, message := campaigndispatch.PublicError(err)
		logger.Warn("automation: recurrence scanner disabled", "code", code, "reason", message)
	}

	if pool != nil {
		// DateTriggerScanner and BestSendHourScanner were BUILT AND TESTED and
		// then never started — no caller anywhere. So birthday / anniversary /
		// date-field triggers could not fire at all, and best-send-hour was
		// never recomputed. Both are ticker loops with the same shape as the
		// recurrence scanner above; they were simply missing this line.
		dateScanner := &worker.DateTriggerScanner{
			Pool:     pool,
			Engine:   engine,
			Lister:   lister,
			Logger:   logger,
			Interval: time.Hour,
		}
		go dateScanner.Run(scannerCtx)
		logger.Info("automation: date-trigger scanner started", "interval", "1h")

		bestHourScanner := &worker.BestSendHourScanner{
			Pool:        pool,
			Logger:      logger,
			Interval:    24 * time.Hour,
			StaleWindow: 7 * 24 * time.Hour,
			BatchSize:   500,
		}
		go bestHourScanner.Run(scannerCtx)
		logger.Info("automation: best-send-hour scanner started", "interval", "24h")
	}

	// HTTP control plane.
	r := chi.NewRouter()
	// OpenTelemetry HTTP middleware. No-op when OTEL_EXPORTER_OTLP_ENDPOINT
	// is unset. Continues the incoming W3C traceparent so cross-service
	// flows stitch end-to-end.
	r.Use(runtimeobs.HTTPMiddleware("postwave-automation"))
	// Sentry HTTP middleware. No-op when SENTRY_DSN_AUTOMATION is unset.
	// Sits ABOVE the metrics handler too — promhttp panics are rare but
	// when they happen we want them captured.
	r.Use(runtimeobs.SentryHTTPMiddleware())
	// Prometheus metrics endpoint. Mounted BEFORE the internalauth
	// middleware so a Prometheus scraper without the X-Postwave-Internal
	// token can still pull metrics. We gate it on loopback peer / a
	// dedicated METRICS_TOKEN bearer instead — see metricsAllowed.
	metricsToken := os.Getenv("METRICS_TOKEN")
	metricsHandler := runtimeobs.ProtectMetrics(metricsToken, promhttp.Handler())
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

		dispatcher := &runtime.EventDispatcher{Engine: engine, Lister: lister}
		if pool != nil {
			lifecycleInbox, inboxErr := runtime.NewPgxLifecycleEventInbox(pool, lister, engine)
			if inboxErr != nil {
				// Construction can fail only for an incomplete dependency graph.
				// Keep the endpoint mounted fail-closed (503) and make the wiring
				// defect explicit in service logs.
				logger.Error("automation: durable lifecycle inbox unavailable", "err", inboxErr.Error())
			} else {
				dispatcher.LifecycleInbox = lifecycleInbox
				logger.Info("automation: durable ordered lifecycle inbox enabled")
			}
		}
		handlers.Register(protected, &handlers.Handlers{
			Engine: engine, Store: store, Queue: queue, Dispatcher: dispatcher, Triggers: triggerWriter,
			// The store behind list/create/update. Postgres-backed when a pool
			// exists (both tables, every status); in-memory in the local dev
			// loop, which is also what the handler tests drive.
			Automations: automationStore,
		})

		// Admin: trigger one immediate recurrence scan. Useful for testing
		// without waiting for the 24h interval. Returns {processed: <count>}
		// or 503 when the scanner isn't wired (in-memory dev mode).
		protected.Post("/admin/recurrence/run",
			recurrenceRunHandler(campaignSchedulingRuntimeEnabled, recurrenceScanner))
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
	httpErrCh := make(chan error, 1)
	go func() {
		logger.Info("http listening", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			httpErrCh <- fmt.Errorf("listen: %w", err)
			return
		}
		httpErrCh <- nil
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	select {
	case sig := <-stop:
		logger.Info("shutdown signal received", "signal", sig.String())
	case err := <-httpErrCh:
		if err != nil {
			return err
		}
	case err := <-workerErrCh:
		if err != nil {
			return err
		}
	}

	// Graceful shutdown: stop accepting HTTP, drain Asynq for up to 30s.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		logger.Warn("http shutdown", "err", err)
	}
	asynqSrv.Stop()     // stop fetching new tasks
	asynqSrv.Shutdown() // wait for active workers to finish
	logger.Info("server stopped cleanly")
	return nil
}

type recurrenceTrigger interface {
	Trigger(context.Context) (int, error)
}

func campaignSchedulingStartupEnabled(cfg config.Config) bool {
	runtimeEnabled := cfg.CampaignLiveDispatchEnabled && cfg.CampaignSchedulerEnabled
	return campaigndispatch.CheckScheduledMaterialization(runtimeEnabled) == nil
}

func recurrenceRunHandler(runtimeEnabled bool, scanner recurrenceTrigger) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		if err := campaigndispatch.CheckScheduledMaterialization(runtimeEnabled); err != nil {
			status := http.StatusServiceUnavailable
			if errors.Is(err, campaigndispatch.ErrSchedulingDisabled) {
				status = http.StatusLocked
			}
			code, message := campaigndispatch.PublicError(err)
			writeAutomationError(w, status, code, message)
			return
		}
		if scanner == nil {
			writeAutomationError(w, http.StatusServiceUnavailable,
				"recurrence_scanner_not_wired", "recurrence scanner requires a configured database")
			return
		}
		n, err := scanner.Trigger(req.Context())
		if err != nil {
			slog.ErrorContext(req.Context(), "automation recurrence trigger failed", "err", err.Error())
			writeAutomationError(w, http.StatusInternalServerError,
				"recurrence_scan_failed", "recurrence scan could not be completed")
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(map[string]int{"processed": n})
	}
}

func writeAutomationError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]string{"code": code, "message": message},
	})
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

// sentryEnvironment returns the first non-empty of POSTWAVE_ENV /
// ENVIRONMENT / NODE_ENV, defaulting to "development". Forwarded to
// runtimeobs.InitSentry / runtimeobs.InitTracing as the deployment
// environment tag.
func sentryEnvironment() string {
	for _, key := range []string{"POSTWAVE_ENV", "ENVIRONMENT", "NODE_ENV"} {
		if v := strings.TrimSpace(os.Getenv(key)); v != "" {
			return v
		}
	}
	return "development"
}

// asynqSlogAdapter satisfies asynq.Logger over slog.
type asynqSlogAdapter struct{ logger *slog.Logger }

func (a asynqSlogAdapter) Debug(args ...interface{}) { a.logger.Debug(fmt.Sprint(args...)) }
func (a asynqSlogAdapter) Info(args ...interface{})  { a.logger.Info(fmt.Sprint(args...)) }
func (a asynqSlogAdapter) Warn(args ...interface{})  { a.logger.Warn(fmt.Sprint(args...)) }
func (a asynqSlogAdapter) Error(args ...interface{}) { a.logger.Error(fmt.Sprint(args...)) }
func (a asynqSlogAdapter) Fatal(args ...interface{}) { a.logger.Error(fmt.Sprint(args...)) }
