// Package main is the entrypoint for the Moosewave voice service.
//
// Pillar 3: ingests writer source material (newsletter archive, Twitter/X,
// blog RSS), generates voice profiles, drives few-shot template generation,
// and scores voice fidelity. HTTP-only contact with Listmonk.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	sharedusage "github.com/postwave/postwave/packages/runtime/commercialusage"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	runtimedb "github.com/postwave/postwave/packages/runtime/db"
	runtimeobs "github.com/postwave/postwave/packages/runtime/observability"
	"github.com/postwave/postwave/services/voice/internal/config"
	"github.com/postwave/postwave/services/voice/internal/fidelity"
	"github.com/postwave/postwave/services/voice/internal/generation"
	"github.com/postwave/postwave/services/voice/internal/handlers"
	"github.com/postwave/postwave/services/voice/internal/ingest"
	"github.com/postwave/postwave/services/voice/internal/ingest/archive"
	"github.com/postwave/postwave/services/voice/internal/ingest/linkedin"
	"github.com/postwave/postwave/services/voice/internal/ingest/pastein"
	"github.com/postwave/postwave/services/voice/internal/ingest/podcast"
	"github.com/postwave/postwave/services/voice/internal/ingest/rss"
	"github.com/postwave/postwave/services/voice/internal/ingest/twitter"
	"github.com/postwave/postwave/services/voice/internal/internalauth"
	"github.com/postwave/postwave/services/voice/internal/jobstore"
	"github.com/postwave/postwave/services/voice/internal/labels"
	"github.com/postwave/postwave/services/voice/internal/profile"
	"github.com/postwave/postwave/services/voice/internal/profile/embeddings"
	"github.com/postwave/postwave/services/voice/internal/profilestore"
	"github.com/postwave/postwave/services/voice/internal/quota"
	"github.com/postwave/postwave/services/voice/internal/regression"
	"github.com/postwave/postwave/services/voice/internal/seqjobstore"
	"github.com/postwave/postwave/services/voice/internal/seqstore"
	"github.com/postwave/postwave/services/voice/internal/sourcestore"
	"github.com/postwave/postwave/services/voice/internal/storage"
	"github.com/postwave/postwave/services/voice/internal/stuckworker"
	"github.com/postwave/postwave/services/voice/internal/templates"
)

const serviceName = "voice"

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
	// Uses SENTRY_DSN_VOICE (matching the legacy local helper which
	// uppercased the service name). PII redaction lives inside the
	// shared helper so every service strips the same headers / query
	// params before emitting.
	defer runtimeobs.InitSentry(serviceName, sentryEnvironment())()
	// ----- end observability: sentry init -----

	// ----- observability: opentelemetry tracing (shared packages/runtime) -----
	tracingCtx, tracingCancel := context.WithCancel(context.Background())
	defer tracingCancel()
	shutdownTracing := runtimeobs.InitTracing(tracingCtx, "postwave-voice", sentryEnvironment())
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := shutdownTracing(shutdownCtx); err != nil {
			logger.Warn("tracing: shutdown error", "err", err.Error())
		}
	}()
	// ----- end observability: opentelemetry tracing -----

	// LLM client. GEMINI_API_KEY may be empty in dev; Builder degrades
	// gracefully (Tonal/Persona stay at defaults). In production we refuse
	// to start without a real key — the MockLLMClient produces empty
	// generation output that would otherwise look like a working profile
	// build to operators (audit finding: voice service silently no-ops
	// when key is missing).
	var llm profile.LLMClient
	if cfg.GeminiAPIKey != "" {
		llm = profile.NewGeminiClient(cfg.GeminiAPIKey)
	} else {
		if isProductionEnv() {
			return errors.New("GEMINI_API_KEY is required in production (refusing to start with MockLLMClient — voice profile build + sequence generation would silently produce empty output)")
		}
		logger.Warn("GEMINI_API_KEY not set — using MockLLMClient (dev-only; no live generation)")
		llm = &profile.MockLLMClient{}
	}
	// Gemini text-embedding-004 client. Powers per-tenant semantic
	// signature centroid (used by fidelity scoring), embedding-clustered
	// theme extraction, and embedding-cosine sample diversity. Nil-safe
	// in the builder — when unset, the builder degrades to TF-IDF themes
	// + Jaccard diversity (and SemanticSignature stays empty so downstream
	// fidelity scoring returns ErrNoSignature instead of a garbage score).
	var embeddingClient *embeddings.Client
	if cfg.GeminiAPIKey != "" {
		embeddingClient = embeddings.NewClient(cfg.GeminiAPIKey)
		logger.Info("embeddings: Gemini text-embedding-004 client wired",
			"model", embeddings.DefaultModel,
			"dim", embeddings.DefaultDimension)
	} else {
		logger.Warn("embeddings: GEMINI_API_KEY not set; profile build degrades to TF-IDF themes + heuristic sample diversity (semantic_signature will be empty)")
	}
	builder := profile.NewBuilder("", llm)
	if embeddingClient != nil {
		builder = builder.WithEmbeddings(embeddingClient)
	}

	// Persistence: Postgres-backed stores when DATABASE_URL is set, in-memory
	// otherwise. Production writes across voice_sources / voice_items /
	// voice_profiles / voice_sequences (see infra/migrations/0010_voice.sql).
	var store handlers.VoiceStore = handlers.NewMemoryStore()
	var seqStore handlers.SequenceStore = handlers.NewMemorySequenceStore()
	var ingestJobs handlers.IngestJobStore
	var sequenceJobs handlers.SequenceJobStore
	var participantStore handlers.SequenceParticipantStore
	var performanceStore handlers.SequencePerformanceStore
	var archiveStore archive.ArchiveStore
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
				return fmt.Errorf("voice: postgres init failed: %w", perr)
			}
			logger.Warn("voice: postgres init failed, in-memory fallback", "err", perr.Error())
		} else {
			pool = newPool
		}
		if pool != nil {
			srcStore, serr := sourcestore.New(pool)
			profStore, perr := profilestore.New(pool)
			pgSeqStore, qerr := seqstore.New(pool)
			pgJobStore, jerr := jobstore.New(pool)
			pgSeqJobStore, sjerr := seqjobstore.New(pool)
			if serr != nil || perr != nil || qerr != nil || jerr != nil || sjerr != nil {
				if !cfg.AllowMemoryFallback {
					return fmt.Errorf("voice: postgres store init failed: sources=%v profile=%v sequences=%v jobs=%v seqjobs=%v",
						serr, perr, qerr, jerr, sjerr)
				}
				logger.Warn("voice: postgres store init failed, in-memory fallback",
					"sources_err", errString(serr),
					"profile_err", errString(perr),
					"sequences_err", errString(qerr),
					"jobs_err", errString(jerr),
					"seqjobs_err", errString(sjerr))
			} else {
				store = storage.NewVoiceStore(srcStore, profStore)
				seqStore = pgSeqStore
				ingestJobs = storage.NewIngestJobsAdapter(pgJobStore)
				sequenceJobs = storage.NewSequenceJobsAdapter(pgSeqJobStore)
				// Sequence participants (desktop gap A9): derived from
				// sequence_funnel_events + the subscribers mirror —
				// Postgres-only, the handler reports a retryable dependency failure when nil.
				participantStore = storage.NewParticipantStore(pool)
				// Send-performance rollup (SEQ-009): same
				// sequence_funnel_events source as participants.
				performanceStore = storage.NewPerformanceStore(pool)
				archiveStore = storage.NewArchiveStore(pool)
				logger.Info("voice: postgres stores enabled")
			}
		}
	} else {
		logger.Warn("voice: DATABASE_URL unset — using in-memory stores (data lost on restart)")
	}
	if pool != nil {
		defer pool.Close()
	}

	// Ingest source registry. The newsletter archive source is backed by
	// campaign_archive when Postgres is configured; otherwise it returns a
	// clear runtime error like the other missing external connectors.
	reg := ingest.NewRegistry()
	reg.Register(rss.New())
	reg.Register(twitter.New())
	reg.Register(linkedin.New())
	reg.Register(podcast.New())
	reg.Register(pastein.New())
	reg.Register(archive.New(archiveStore))

	// Templates: Postgres-backed when DATABASE_URL is reachable, otherwise
	// in-memory seeded from the embedded local library.
	var tmplStore templates.TemplateStore
	if pool != nil {
		pgTemplates, terr := templates.NewPostgresStore(pool)
		if terr != nil {
			if !cfg.AllowMemoryFallback {
				return fmt.Errorf("voice: postgres template store init failed: %w", terr)
			}
			logger.Warn("voice: postgres template store init failed, in-memory fallback", "err", terr.Error())
		} else {
			tmplStore = pgTemplates
		}
	}
	if tmplStore == nil {
		var terr error
		tmplStore, terr = templates.SeededMemoryStore()
		if terr != nil {
			return fmt.Errorf("seed templates: %w", terr)
		}
	} else if err := templates.SeedInto(context.Background(), tmplStore); err != nil {
		if !cfg.AllowMemoryFallback {
			return fmt.Errorf("seed templates: %w", err)
		}
		logger.Warn("voice: postgres template seed failed, in-memory fallback", "err", err.Error())
		var terr error
		tmplStore, terr = templates.SeededMemoryStore()
		if terr != nil {
			return fmt.Errorf("seed templates: %w", terr)
		}
	}

	// Fidelity evaluator: real OpenAI embeddings in production. The
	// deterministic mock is dev/test-only; returning a "voice fidelity"
	// number from hash vectors in prod is more dangerous than refusing to
	// start because it makes low-quality generations look scored.
	emb, err := fidelityEmbeddingClient(cfg)
	if err != nil {
		return err
	}
	if _, ok := emb.(*fidelity.MockEmbeddingClient); ok {
		logger.Warn("OPENAI_API_KEY not set — using MockEmbeddingClient (dev-only, deterministic, non-semantic)")
	}
	evaluator := fidelity.NewEmbeddingEvaluator(emb)

	engine := generation.NewEngine(llm, tmplStore, evaluator)

	// Monthly cost-weighted AI-credit gate. Production shares the same
	// row-locked commercial authority as API and automation services.
	var aiQuota quota.Quota = quota.NoopQuota{}
	if pool != nil {
		aiQuota = &quota.CommercialQuota{
			Meter: &sharedusage.Meter{Pool: pool},
			Tier:  quota.BillingStateTierResolver(pool),
		}
		logger.Info("ai quota wired",
			"backend", "postgres",
			"period", "monthly",
			"unit", "milli_credit")
	} else {
		logger.Warn("ai quota: using NoopQuota (no Postgres pool — every LLM call allowed)")
	}

	voiceHandler := handlers.New(reg, store, builder).
		WithGeneration(handlers.GenerationDeps{
			Engine:    engine,
			Templates: tmplStore,
			Sequences: seqStore,
		}).
		WithIngestJobs(ingestJobs).
		WithSequenceJobs(sequenceJobs).
		WithQuota(aiQuota).
		WithRegressionRuntime(evaluator, handlers.RegressionRuntimeIdentity{
			Provider:            "google",
			ModelID:             "gemini-3-flash-preview",
			PromptPolicyVersion: regression.PromptPolicyVersion,
		})
	if participantStore != nil {
		voiceHandler = voiceHandler.WithSequenceParticipants(participantStore)
	} else {
		logger.Warn("voice: sequence participants disabled (no Postgres pool) — GET /sequences/{id}/participants returns retryable 503")
	}
	if performanceStore != nil {
		voiceHandler = voiceHandler.WithSequencePerformance(performanceStore)
	} else {
		logger.Warn("voice: sequence performance disabled (no Postgres pool) — GET /sequences/{id}/performance returns retryable 503")
	}
	// Stuck-participant report + scanner (roadmap: stuck alerts).
	// Postgres-only like participants: without a pool the endpoint reports 503
	// and no scanner runs.
	var activityStore handlers.SequenceActivityStore
	if pool != nil {
		activityStore = storage.NewActivityStore(pool)
		voiceHandler = voiceHandler.WithSequenceActivity(activityStore)
		// Goal-progress rollup (roadmap: goals / exit-on-goal). Reads
		// sequence_enrollments (migration 0399). Same pool gate.
		voiceHandler = voiceHandler.WithSequenceEnrollments(storage.NewEnrollmentStore(pool))
	} else {
		logger.Warn("voice: stuck-participant report disabled (no Postgres pool) — GET /sequences/{id}/stuck returns retryable 503")
	}
	// Chat (Moosewave AI panel). Both GeminiClient and MockLLMClient
	// implement ChatStreamer; the chat handler refuses to serve when
	// GEMINI_API_KEY is missing, but in dev with a mock the route
	// still wires up so end-to-end tests can exercise the SSE pipe.
	if chat, ok := llm.(handlers.ChatStreamer); ok {
		voiceHandler = voiceHandler.WithChat(chat)
		_, isMock := llm.(*profile.MockLLMClient)
		logger.Info("chat handler wired",
			"endpoint", "POST /v1/voice/generate",
			"model", "gemini-3-flash-preview",
			"backend", map[bool]string{true: "mock", false: "gemini"}[isMock])
	} else {
		logger.Warn("chat handler disabled — /v1/voice/generate will return 503",
			"reason", "LLM client does not implement ChatStreamer")
	}
	// Webhook fanout: when a sequence is generated, write a webhook.fanout
	// outbox row scoped to the tenant; the apps/api gateway worker
	// expands that into per-subscription deliveries. nil pool = no
	// fanout (matches the existing degrade-gracefully shape).
	if pool != nil {
		voiceHandler = voiceHandler.WithFanoutEmitter(&handlers.PgxFanoutEmitter{Pool: pool})
	}

	// Stuck-participant scanner: daily cross-tenant sweep over sequences
	// with stuck_after_days >= 1, emitting sequence.participants.stuck
	// webhook.fanout alerts (see internal/stuckworker). Needs Postgres
	// for enumeration + activity + outbox; skipped entirely without it.
	workerCtx, workerCancel := context.WithCancel(context.Background())
	defer workerCancel()
	if pool != nil && activityStore != nil {
		stuckWorker := &stuckworker.Worker{
			Pool:      pool,
			Sequences: seqStore,
			Activity:  activityStore,
			Emitter:   &handlers.PgxFanoutEmitter{Pool: pool},
			Logger:    logger,
			Interval:  stuckScanInterval(logger),
		}
		go func() {
			if err := stuckWorker.Run(workerCtx); err != nil && !errors.Is(err, context.Canceled) {
				logger.Warn("stuckworker: exited", "err", err.Error())
			}
		}()
		logger.Info("stuckworker: started", "event_type", stuckworker.EventType)
	} else {
		logger.Warn("stuckworker: disabled (no Postgres pool) — stuck-participant alerts will not be emitted")
	}

	r := chi.NewRouter()
	// OpenTelemetry HTTP middleware. No-op when OTEL_EXPORTER_OTLP_ENDPOINT
	// is unset. Sits above Sentry so the span exists for the whole request.
	r.Use(runtimeobs.HTTPMiddleware("postwave-voice"))
	// Sentry HTTP middleware. No-op when SENTRY_DSN_VOICE is unset.
	r.Use(runtimeobs.SentryHTTPMiddleware())
	metricsHandler := runtimeobs.ProtectMetrics(os.Getenv("METRICS_TOKEN"), promhttp.Handler())
	r.Get("/metrics", metricsHandler.ServeHTTP)
	r.Get("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"service": serviceName,
			"status":  "ok",
		})
	})
	// Voice profile labels (operator-facing tone-axis labeling +
	// trainer-facing export). Postgres-backed only — the labels table
	// has no in-memory fallback because the trainer cares about
	// durable rows. When pool is nil (dev without DATABASE_URL) the
	// labels routes simply don't register.
	var labelsDeps *labels.Deps
	if pool != nil {
		lstore, lerr := labels.NewStore(pool)
		if lerr != nil {
			return fmt.Errorf("voice: labels store init failed: %w", lerr)
		}
		labelsDeps = labels.NewDeps(lstore)
		logger.Info("voice: labels routes wired", "base", "/v1/voice/labels")
	} else {
		logger.Warn("voice: labels routes disabled (no Postgres pool)")
	}

	r.Group(func(protected chi.Router) {
		protected.Use(internalauth.Middleware(cfg.InternalAPIToken))
		protected.Route("/v1", func(r chi.Router) {
			r.Mount("/voice", voiceHandler.Routes())
			if labelsDeps != nil {
				r.Mount("/voice/labels", labelsDeps.Routes())
			}
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

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
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

// isProductionEnv mirrors apps/api/main.go's helper. Returns true when
// any of the standard env-marker variables identify a production deploy.
// Used to fail-loud when GEMINI_API_KEY is missing so the service
// cannot silently fall back to MockLLMClient in prod.
func isProductionEnv() bool {
	for _, key := range []string{"POSTWAVE_ENV", "ENVIRONMENT", "NODE_ENV"} {
		v := strings.TrimSpace(os.Getenv(key))
		if strings.EqualFold(v, "production") || strings.EqualFold(v, "prod") {
			return true
		}
	}
	return false
}

// stuckScanInterval reads POSTWAVE_VOICE_STUCK_SCAN_INTERVAL (a
// time.Duration string, e.g. "1h"); 0 falls back to the worker's
// DefaultInterval (24h). Malformed values warn and use the default.
func stuckScanInterval(logger *slog.Logger) time.Duration {
	raw := strings.TrimSpace(os.Getenv("POSTWAVE_VOICE_STUCK_SCAN_INTERVAL"))
	if raw == "" {
		return 0
	}
	d, err := time.ParseDuration(raw)
	if err != nil || d <= 0 {
		logger.Warn("stuckworker: invalid POSTWAVE_VOICE_STUCK_SCAN_INTERVAL, using default",
			"value", raw, "default", stuckworker.DefaultInterval.String())
		return 0
	}
	return d
}

func fidelityEmbeddingClient(cfg config.Config) (fidelity.EmbeddingClient, error) {
	if cfg.OpenAIAPIKey != "" {
		return fidelity.NewOpenAIClient(cfg.OpenAIAPIKey), nil
	}
	if isProductionEnv() {
		return nil, errors.New("OPENAI_API_KEY is required in production (refusing to start with MockEmbeddingClient — voice fidelity scoring would be deterministic and non-semantic)")
	}
	return &fidelity.MockEmbeddingClient{}, nil
}
