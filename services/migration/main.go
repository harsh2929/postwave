// Package main is the entrypoint for the Moosewave migration service.
//
// Pillar 1: ingests subscribers, segments, automations, archives, and Stripe
// paid-subs from the registered ESP/CRM and CSV migration sources, then writes
// them through the Listmonk HTTP API. It never imports Listmonk packages — see
// LICENSE-BOUNDARY.md.
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/postwave/postwave/packages/runtime/tenantengine"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/secretsmanager"
	"github.com/exaring/otelpgx"
	"github.com/getsentry/sentry-go"
	sentryhttp "github.com/getsentry/sentry-go/http"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	// Side-effect imports register adapters into the global registry.
	_ "github.com/postwave/migrate/activecampaign"
	_ "github.com/postwave/migrate/aweber"
	_ "github.com/postwave/migrate/beehiiv"
	_ "github.com/postwave/migrate/bento"
	_ "github.com/postwave/migrate/brevo"
	_ "github.com/postwave/migrate/campaignmonitor"
	_ "github.com/postwave/migrate/constantcontact"
	_ "github.com/postwave/migrate/convertkit"
	_ "github.com/postwave/migrate/csv"
	_ "github.com/postwave/migrate/customerio"
	_ "github.com/postwave/migrate/drip"
	_ "github.com/postwave/migrate/flodesk"
	_ "github.com/postwave/migrate/hubspot"
	_ "github.com/postwave/migrate/klaviyo"
	_ "github.com/postwave/migrate/loops"
	_ "github.com/postwave/migrate/mailchimp"
	_ "github.com/postwave/migrate/mailerlite"
	_ "github.com/postwave/migrate/omnisend"
	_ "github.com/postwave/migrate/sendy"
	_ "github.com/postwave/migrate/substack"

	runtimeobs "github.com/postwave/postwave/packages/runtime/observability"
	secretspkg "github.com/postwave/postwave/packages/secrets"
	"github.com/postwave/postwave/services/migration/internal/config"
	"github.com/postwave/postwave/services/migration/internal/handlers"
	"github.com/postwave/postwave/services/migration/internal/internalauth"
	"github.com/postwave/postwave/services/migration/internal/jobstore"
	"github.com/postwave/postwave/services/migration/internal/translator/listmonk"
)

// jobStore is selected at startup: PostgresJobStore when DATABASE_URL is
// configured, MemoryJobStore otherwise (with a startup warning).
var _ jobstore.MigrationJobStore = (*jobstore.MemoryJobStore)(nil)

const serviceName = "migration"

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
	shutdownTracing := runtimeobs.InitTracing(tracingCtx, "postwave-migration", sentryEnvironment())
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := shutdownTracing(shutdownCtx); err != nil {
			logger.Warn("tracing: shutdown error", "err", err.Error())
		}
	}()
	// ----- end observability: opentelemetry tracing -----

	// ----- aws: secrets manager -----
	// Listmonk admin creds resolver. Picks AWS Secrets Manager when
	// POSTWAVE_SECRETS_BACKEND=aws and AWS_REGION is set; env vars
	// otherwise. The Listmonk client falls back to env vars on
	// ErrSecretNotFound so dev stays unbroken when the secret store
	// is not configured at all.
	secretsResolver := buildSecretsResolver(context.Background(), logger)
	listmonkCtx, listmonkCancel := context.WithTimeout(context.Background(), 10*time.Second)
	if _, err := listmonk.NewClientFromResolver(listmonkCtx, secretsResolver); err != nil {
		// Non-fatal: NewClientFromResolver also runs lazily later for
		// per-request usage. We log here so misconfigurations are
		// visible at startup rather than on first migration job.
		logger.Warn("listmonk credentials not yet usable", "err", err.Error())
	}
	listmonkCancel()

	r := chi.NewRouter()
	// OpenTelemetry HTTP middleware. No-op when OTEL_EXPORTER_OTLP_ENDPOINT
	// is unset. Continues the incoming W3C traceparent so cross-service
	// flows stitch end-to-end.
	r.Use(runtimeobs.HTTPMiddleware("postwave-migration"))
	// Sentry HTTP middleware. No-op when SENTRY_DSN_MIGRATION is unset.
	r.Use(sentryhttp.New(sentryhttp.Options{Repanic: true, WaitForDelivery: false}).Handle)
	metricsHandler := runtimeobs.ProtectMetrics(os.Getenv("METRICS_TOKEN"), promhttp.Handler())
	r.Get("/metrics", metricsHandler.ServeHTTP)
	r.Get("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"service": serviceName,
			"status":  "ok",
		})
	})

	// OAuth callback URL — must be registered with each upstream provider's
	// developer console. Override via OAUTH_REDIRECT_URI for staging/prod.
	// Use "{source}" in the value when the callback URL carries the provider
	// as a query param, e.g. https://app.example/app/migrations/oauth/callback?source={source}.
	redirectURI := os.Getenv("OAUTH_REDIRECT_URI")
	if redirectURI == "" {
		redirectURI = "http://localhost:3000/app/migrations/oauth/callback?source={source}"
	}
	store := jobstore.MigrationJobStore(jobstore.NewMemoryJobStore())
	var pool *pgxpool.Pool
	var sqlDB *sql.DB
	if cfg.DatabaseURL != "" {
		pgxConfig, perr := pgxpool.ParseConfig(cfg.DatabaseURL)
		if perr == nil {
			pgxConfig.ConnConfig.Tracer = otelpgx.NewTracer()
			pool, perr = pgxpool.NewWithConfig(context.Background(), pgxConfig)
		}
		if perr != nil {
			if !cfg.AllowMemoryFallback {
				return fmt.Errorf("migration job store: postgres config failed: %w", perr)
			}
			logger.Warn("migration job store: postgres config failed, falling back to in-memory", "err", perr.Error())
		} else {
			pingCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			if perr = pool.Ping(pingCtx); perr != nil {
				cancel()
				pool.Close()
				pool = nil
				if !cfg.AllowMemoryFallback {
					return fmt.Errorf("migration job store: postgres unreachable: %w", perr)
				}
				logger.Warn("migration job store: postgres unreachable, falling back to in-memory", "err", perr.Error())
			} else {
				sessionCipher, cerr := jobstore.NewAESSessionCipher(cfg.MigrationSessionKEK)
				if cerr != nil {
					cancel()
					pool.Close()
					pool = nil
					return fmt.Errorf("migration session encryption: %w (set POSTWAVE_MIGRATION_SESSION_KEK)", cerr)
				}
				store = jobstore.NewPostgresJobStore(pool, sessionCipher)
				sqlDB, perr = sql.Open("pgx", cfg.DatabaseURL)
				if perr != nil {
					cancel()
					pool.Close()
					pool = nil
					return fmt.Errorf("migration persistence db: %w", perr)
				}
				if perr = sqlDB.PingContext(pingCtx); perr != nil {
					cancel()
					_ = sqlDB.Close()
					sqlDB = nil
					pool.Close()
					pool = nil
					return fmt.Errorf("migration persistence db unreachable: %w", perr)
				}
				cancel()
				logger.Info("migration job store: postgres enabled")
			}
		}
	} else {
		logger.Warn("migration job store: in-memory — jobs lost on restart (set DATABASE_URL)")
	}
	if pool != nil {
		defer pool.Close()
	}
	if sqlDB != nil {
		defer func() { _ = sqlDB.Close() }()
	}

	if err := handlers.ValidateMigrationUploadStorage(); err != nil {
		return err
	}
	if os.Getenv("POSTWAVE_MIGRATION_UPLOAD_BACKEND") == "efs" && sqlDB == nil {
		return fmt.Errorf("durable upload jobs require PostgreSQL persistence")
	}
	migrationAPI := handlers.NewMigration(redirectURI, store)
	if sqlDB != nil {
		migrationAPI = handlers.NewMigrationWithDB(redirectURI, store, sqlDB)
	}
	tenantRoutes, err := tenantengine.FromEnv()
	if err != nil {
		return fmt.Errorf("email destination routing: %w", err)
	}
	migrationAPI.SetListmonkClientFactory(func(ctx context.Context) (*listmonk.Client, error) {
		if tenantRoutes == nil {
			tenantID, _ := jobstore.TenantIDFromContext(ctx)
			if err := tenantengine.CheckLegacySQL(ctx, sqlDB, tenantID); err != nil {
				return nil, err
			}
			return listmonk.NewClientFromResolver(ctx, secretsResolver)
		}
		tenantID, _ := jobstore.TenantIDFromContext(ctx)
		route, err := tenantRoutes.Resolve(tenantID)
		if err != nil {
			return nil, err
		}
		if err := tenantengine.VerifySQL(ctx, sqlDB, route); err != nil {
			return nil, err
		}
		return listmonk.NewClientForDestination(route), nil
	})
	workerCtx, workerCancel := context.WithCancel(context.Background())
	defer workerCancel()
	migrationAPI.StartRecoveryWorker(workerCtx, 30*time.Second)
	migrationAPI.StartVerifierRetentionWorker(workerCtx, 5*time.Minute)
	migrationAPI.StartSourceRetentionWorker(workerCtx, time.Hour)
	migrationAPI.StartShadowMonitorWorker(workerCtx, time.Minute)
	migrationAPI.StartSourceEventMonitorWorker(workerCtx, time.Minute)
	r.Group(func(protected chi.Router) {
		protected.Use(internalauth.Middleware(cfg.InternalAPIToken))
		migrationAPI.Mount(protected)
	})

	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           r,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      15 * time.Minute,
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

// --- secrets resolver wiring ------------------------------------------
//
// The shared implementation lives at packages/secrets — apps/api and
// services/migration both import it so the AWS+env chain logic stays in
// one place. listmonk.SecretsResolver is intentionally a narrower local
// interface (just GetJSON, with its own ErrSecretNotFound sentinel), so
// we wrap secretspkg.Resolver in a thin adapter that translates the
// not-found sentinel for the listmonk client's errors.Is check.

// buildSecretsResolver picks the resolver based on the environment:
//   - POSTWAVE_SECRETS_BACKEND=aws AND AWS_REGION set → AWS chained with env
//   - otherwise → env-only
//
// The Listmonk client itself handles ErrSecretNotFound so callers don't
// have to special-case missing secrets here.
func buildSecretsResolver(ctx context.Context, logger *slog.Logger) listmonk.SecretsResolver {
	backend := strings.ToLower(strings.TrimSpace(os.Getenv("POSTWAVE_SECRETS_BACKEND")))
	region := os.Getenv("AWS_REGION")
	if backend == "aws" && region != "" {
		cfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(region))
		if err != nil {
			logger.Warn("aws: failed to load config; falling back to env-only secrets", "err", err.Error())
			return &listmonkResolverAdapter{inner: secretspkg.NewEnvResolver()}
		}
		client := secretsmanager.NewFromConfig(cfg)
		logger.Info("secrets: AWS Secrets Manager resolver active", "region", region)
		return &listmonkResolverAdapter{
			inner: secretspkg.NewChain(
				secretspkg.NewAwsResolver(client, secretspkg.DefaultCacheTTL),
				secretspkg.NewEnvResolver(),
			),
		}
	}
	logger.Info("secrets: env-only resolver active (set POSTWAVE_SECRETS_BACKEND=aws + AWS_REGION for prod)")
	return &listmonkResolverAdapter{inner: secretspkg.NewEnvResolver()}
}

// listmonkResolverAdapter bridges secretspkg.Resolver to the narrower
// listmonk.SecretsResolver interface. The two interfaces are not type-
// compatible because listmonk owns its own ErrSecretNotFound sentinel
// (errors.Is happens inside the listmonk client) — we translate
// secretspkg.ErrNotFound on the boundary so the env fallback in
// NewClientFromResolver still fires correctly.
type listmonkResolverAdapter struct {
	inner secretspkg.Resolver
}

func (a *listmonkResolverAdapter) GetJSON(ctx context.Context, name string, dst any) error {
	err := a.inner.GetJSON(ctx, name, dst)
	if err == nil {
		return nil
	}
	if errors.Is(err, secretspkg.ErrNotFound) {
		return listmonk.ErrSecretNotFound
	}
	return err
}
