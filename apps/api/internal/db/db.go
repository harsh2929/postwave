// Package db owns the pgx connection pool for the API gateway and the
// tenant-scoped transaction helper that every per-tenant query MUST go
// through so Row-Level Security policies actually fire.
//
// The shape is deliberately tiny: a pool factory + a `WithTenant` /
// `WithWorkerScope` helper. Anything more sophisticated (repositories,
// query builders) belongs in the caller — this package just owns the
// connection lifecycle and the `SET LOCAL app.<scope>` ritual.
//
// Defence-in-depth: the pool installs an `AfterRelease` hook that RESETs
// the well-known worker GUCs (`app.outbox_worker`, `app.tenant_id`,
// `app.sending_deprovision_worker`) before a connection returns to the
// pool. Anything that historically set them at the *session* level
// (set_config(..., false)) used to leak the scope to the next caller —
// AfterRelease closes that hole even for legacy call sites that haven't
// been migrated to WithWorkerScope yet. The lint script
// `scripts/check-no-bare-set-config.sh` blocks new uses of the unsafe form.
package db

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/exaring/otelpgx"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
)

// workerGUCs lists every Postgres GUC the API or its workers ever bind at
// the session level. They MUST be reset on connection release so a worker
// scope can't ride a recycled connection into a per-tenant request handler
// (which would silently bypass RLS or trigger the wrong audit branch).
//
// New scopes go here AND in the matching RLS predicate.
var workerGUCs = []string{
	"app.outbox_worker",
	// Intelligent-retry claims are a cross-tenant discovery window. Requiring
	// this dedicated capability as well as app.outbox_worker prevents an
	// unrelated background subsystem from enumerating or mutating retry rows.
	"app.intelligent_retry_worker",
	// New generic outbox workers advertise this capability so migration 1857
	// can hide auth.new_device_sign_in.dispatch from older replicas that would
	// otherwise claim an unknown kind and immediately DLQ it.
	"app.device_signin_outbox_worker",
	// Compatible mobile-push lifecycle workers preserve notification_feed.id
	// when reconstructing a native send after a durable-claim crash. Migration
	// 1858 hides security deliveries from older workers lacking this scope.
	"app.mobile_push_notification_identity_worker",
	"app.tenant_id",
	"app.sending_deprovision_worker",
	// app.developer_marketplace_reviewer is a read-only cross-tenant
	// marketplace review queue scope. Review decisions still re-enter a
	// tenant-scoped transaction before mutating app/listing rows.
	"app.developer_marketplace_reviewer",
	// app.tenant_resolver is bound by the pre-tenant resolution window
	// (slug -> tenant_id, api-key tenant_id -> tenants row) so the
	// narrow resolver-only SELECT policy on `tenants` fires. See
	// migration 0333_tenants_rls_split.sql for the policy split and
	// apps/api/internal/middleware/tenant.go (lookupTenantBySlug),
	// apps/api/internal/apikeys/middleware.go (lookupTenantByID),
	// apps/api/internal/compat/popups_public.go, replies/repo.go,
	// and tenants/admin_handlers.go (lookupTenantIDBySlug) for the
	// call sites that opt in.
	"app.tenant_resolver",
	// Scheduled native CRM workers enumerate due integrations across
	// tenants before re-entering tenant scope for each sync write.
	"app.crm_worker",
	// Scheduled native support workers enumerate due helpdesk integrations
	// across tenants before re-entering tenant scope for each sync write.
	"app.support_worker",
	// Scheduled review and loyalty workers enumerate due integrations across
	// tenants before re-entering tenant scope for each sync write.
	"app.review_worker",
	"app.loyalty_worker",
	// Scheduled native marketing workers enumerate due integrations across
	// tenants before re-entering tenant scope for each sync write.
	"app.marketing_worker",
	// Public marketing provider webhooks resolve by provider + opaque token
	// before re-entering tenant scope for idempotent delivery processing.
	"app.marketing_webhook_provider",
	"app.marketing_webhook_token",
	// Public Pipedrive OAuth uninstall callbacks resolve an install by the
	// provider's client/user/company identifiers before re-entering tenant
	// scope for local disconnect and secret cleanup.
	"app.crm_oauth_client_id",
	"app.crm_oauth_company_id",
	"app.crm_oauth_user_id",
}

// TODO(p0-pgxpool-after-release): the following call sites still issue a
// bare `SELECT set_config('app.outbox_worker', 'true', false)` on an
// acquired conn instead of going through WithWorkerScope. They are
// SAFE because the AfterRelease hook above RESETs the GUC on release —
// but converting them removes a class of foot-guns (e.g. a forgotten
// Release leaks the worker scope until the conn dies) and makes the lint
// in scripts/check-no-bare-set-config.sh fully green.
//
// Migration path per file: replace
//
//	conn, err := pool.Acquire(ctx); defer conn.Release()
//	conn.Exec(ctx, "SELECT set_config('app.outbox_worker', 'true', false)")
//	... queries on conn ...
//
// with
//
//	tx, err := db.WithWorkerScope(ctx, pool); defer tx.Rollback(ctx)
//	... queries on tx ...
//	tx.Commit(ctx)   // commit when the work is write-side; rollback for read
//
// Remaining (33) sites — grouped by package:
//
//   - apps/api/internal/audit_alerts/worker.go              (tick, processRuleInline)
//   - apps/api/internal/audit_alerts/inbound_webhook.go     (2 sites)
//   - apps/api/internal/dns_health/dns_health.go            (tick, recheck)
//   - apps/api/internal/exports/worker.go                   (tick, fail)
//   - apps/api/internal/scheduled_reports/worker.go         (3 sites)
//   - apps/api/internal/subscriber_import/worker.go         (5 sites)
//   - apps/api/internal/deliverability_hub/hub.go           (5 sites)
//   - apps/api/internal/outbound_webhooks/store_test.go     (4 sites; tests OK as-is)
//   - apps/api/internal/outbound_webhooks/worker_test.go    (n sites; tests OK as-is)
//
// Order of migration: dns_health and exports/worker are the highest-value
// targets — both hold a connection across slow network I/O (DNS lookups,
// S3 upload) where a stuck conn returning to the pool with the worker
// GUC still set is the exact bug class AfterRelease defends against.

// Pool is the application's shared pgx pool. We alias the pgx type so
// callers don't need to import pgxpool directly for typing.
type Pool = pgxpool.Pool

// New constructs a pgx pool from a Postgres connection URL with sane
// defaults for an interactive API workload.
//
// We keep this small on purpose: the pool is tuned at the env-var level
// (PG* vars / DATABASE_URL params) — only the fields that don't have a
// reasonable URL-level expression are forced here.
//
// Pool sizing is env-driven via DATABASE_MAX_CONNS. The historical
// hardcoded value (25) is the dev default; production gets 50 by default
// (selected when POSTWAVE_ENV / APP_ENV / GO_ENV is "production" /
// "prod" and DATABASE_MAX_CONNS is unset). Values <=0 (parse error,
// unset env) fall back to the env-default. Out-of-range numbers (e.g.
// 10000) are accepted here but Postgres will reject them at connect time.
//
// On construction the pool also publishes two Prometheus gauges scraped
// from pgxpool.Stat() — pw_pgxpool_conns_active and
// pw_pgxpool_conns_idle — so saturation is observable from Grafana /
// alerts without a per-request tap. These are registered against the
// default Prometheus registerer exactly once (subsequent calls reuse the
// existing collector, which lets tests instantiate the pool repeatedly).
func New(ctx context.Context, databaseURL string) (*Pool, error) {
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("db: parse DATABASE_URL: %w", err)
	}

	cfg.MaxConns = resolveMaxConns()
	cfg.MinConns = 2
	cfg.MaxConnLifetime = 30 * time.Minute
	cfg.MaxConnIdleTime = 5 * time.Minute
	cfg.HealthCheckPeriod = 30 * time.Second

	// Wire OpenTelemetry pgx tracer. A no-op TracerProvider (default when
	// InitTracing didn't find OTEL_EXPORTER_OTLP_ENDPOINT) means this is
	// effectively free at runtime; with a provider it emits one span per
	// query / batch / connect so the database appears in distributed traces.
	cfg.ConnConfig.Tracer = otelpgx.NewTracer()

	// AfterRelease defence-in-depth: RESET every worker GUC before the
	// connection returns to the pool so a worker scope cannot leak to the
	// next checkout. Returning false destroys the connection — which we do
	// only if the RESET itself failed (rare; means the conn is unhealthy).
	//
	// The RESETs are issued with a short bounded context — the caller's ctx
	// may already be cancelled (defer Release after request finish), and we
	// must not block the pool on a request-scoped deadline.
	// One batched RESET statement instead of one round-trip per GUC. pgx runs
	// an argument-free query through the simple protocol, which executes every
	// semicolon-separated statement in a SINGLE round-trip — so this resets the
	// exact same GUCs as the old per-GUC loop (RESET on an unset GUC is a no-op)
	// at 1 network round-trip on every connection release instead of 15. Only
	// the worker GUCs are touched (unlike RESET ALL, which could clear
	// connect-time session state).
	resetWorkerGUCs := "RESET " + strings.Join(workerGUCs, "; RESET ") + ";"
	cfg.AfterRelease = func(c *pgx.Conn) bool {
		rctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if _, err := c.Exec(rctx, resetWorkerGUCs); err != nil {
			// Connection is in a bad state — drop it rather than recycle.
			return false
		}
		return true
	}

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("db: connect: %w", err)
	}

	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("db: ping: %w", err)
	}
	if err := rejectPrivilegedRuntimeRole(pingCtx, pool); err != nil {
		pool.Close()
		return nil, err
	}

	// Publish saturation gauges so operators can alert before AcquireWait
	// time starts climbing. Registration is idempotent (sync.Once) — the
	// collector reads pool.Stat() lazily at scrape time, so it never holds
	// a connection.
	registerPoolSaturationMetrics(pool)

	return pool, nil
}

// resolveMaxConns reads DATABASE_MAX_CONNS from the environment with a
// dev/prod-aware default.
//
//   - DATABASE_MAX_CONNS set and parses to >0 → that value.
//   - Unset / empty / unparseable → 50 in production, 25 elsewhere.
//
// "Production" here means POSTWAVE_ENV / APP_ENV / GO_ENV in {production,
// prod, prd, live} (case-insensitive). We bias toward dev defaults so a
// missing env var on localhost doesn't accidentally open 50 connections
// per developer.
func resolveMaxConns() int32 {
	if raw := strings.TrimSpace(os.Getenv("DATABASE_MAX_CONNS")); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			const maxInt32 = int(^uint32(0) >> 1)
			if n > maxInt32 {
				return int32(maxInt32)
			}
			return int32(n)
		}
	}
	if isProductionEnv() {
		return 50
	}
	return 25
}

// isProductionEnv returns true when POSTWAVE_ENV / APP_ENV / GO_ENV is set
// to a recognisably-production-ish value. The set is small and
// case-insensitive so a typo (`PRODUCTION`, `Live`) is not silently
// treated as dev.
func isProductionEnv() bool {
	for _, key := range []string{"POSTWAVE_ENV", "APP_ENV", "GO_ENV"} {
		v := strings.ToLower(strings.TrimSpace(os.Getenv(key)))
		switch v {
		case "production", "prod", "prd", "live":
			return true
		}
	}
	return false
}

// pgxpool saturation gauges. Registration is gated behind sync.Once so
// calling New() multiple times (or in parallel tests) does not panic the
// default Prometheus registry with a duplicate-collector error. The
// gauges read from the most-recently-constructed pool — the API gateway
// only ever owns one, and any test that builds a temporary pool
// transparently re-points the gauge at it (the previous pool is closed
// in defer anyway, so its Stat() would just stop changing).
var (
	pgxpoolMetricsOnce sync.Once
	pgxpoolMu          sync.RWMutex
	pgxpoolForStats    *Pool

	pgxpoolConnsActiveGauge = prometheus.NewGaugeFunc(
		prometheus.GaugeOpts{
			Name: "pw_pgxpool_conns_active",
			Help: "Number of currently-acquired (in-use) connections in the pgxpool. Watch (active / max_conns) for saturation.",
		},
		func() float64 { return float64(currentPoolStatAcquired()) },
	)
	pgxpoolConnsIdleGauge = prometheus.NewGaugeFunc(
		prometheus.GaugeOpts{
			Name: "pw_pgxpool_conns_idle",
			Help: "Number of idle (in-pool, ready-to-acquire) connections in the pgxpool. A persistent zero with active==max_conns means saturated.",
		},
		func() float64 { return float64(currentPoolStatIdle()) },
	)
)

func registerPoolSaturationMetrics(p *Pool) {
	pgxpoolMu.Lock()
	pgxpoolForStats = p
	pgxpoolMu.Unlock()
	pgxpoolMetricsOnce.Do(func() {
		// Register against the default registerer. AlreadyRegistered means
		// a sibling collector with the same name was registered earlier
		// (e.g. in a test that wires its own); the existing one wins.
		if err := prometheus.Register(pgxpoolConnsActiveGauge); err != nil {
			if _, ok := err.(prometheus.AlreadyRegisteredError); !ok {
				_ = err
			}
		}
		if err := prometheus.Register(pgxpoolConnsIdleGauge); err != nil {
			if _, ok := err.(prometheus.AlreadyRegisteredError); !ok {
				_ = err
			}
		}
	})
}

func currentPoolStatAcquired() int32 {
	pgxpoolMu.RLock()
	defer pgxpoolMu.RUnlock()
	if pgxpoolForStats == nil {
		return 0
	}
	return pgxpoolForStats.Stat().AcquiredConns()
}

func currentPoolStatIdle() int32 {
	pgxpoolMu.RLock()
	defer pgxpoolMu.RUnlock()
	if pgxpoolForStats == nil {
		return 0
	}
	return pgxpoolForStats.Stat().IdleConns()
}

func rejectPrivilegedRuntimeRole(ctx context.Context, pool *Pool) error {
	allowed, err := privilegedRoleBypassAllowed(os.Getenv)
	if err != nil {
		return err
	}
	if allowed {
		return nil
	}
	var privileged bool
	if err := pool.QueryRow(ctx, `
		SELECT rolsuper OR rolbypassrls
		  FROM pg_roles
		 WHERE rolname = current_user
	`).Scan(&privileged); err != nil {
		return fmt.Errorf("db: inspect current role: %w", err)
	}
	if privileged {
		return fmt.Errorf("db: current role can bypass RLS; use postwave_app for runtime connections or set POSTWAVE_ALLOW_PRIVILEGED_DB_ROLE=1 for one-off local diagnostics")
	}
	return nil
}

func privilegedRoleBypassAllowed(env func(string) string) (bool, error) {
	if env == nil {
		env = os.Getenv
	}
	if strings.TrimSpace(env("POSTWAVE_ALLOW_PRIVILEGED_DB_ROLE")) != "1" {
		return false, nil
	}
	for _, key := range []string{"POSTWAVE_ENV", "APP_ENV", "GO_ENV", "ENVIRONMENT"} {
		switch strings.ToLower(strings.TrimSpace(env(key))) {
		case "production", "prod", "staging", "stage":
			return false, fmt.Errorf("db: POSTWAVE_ALLOW_PRIVILEGED_DB_ROLE is forbidden in protected environments")
		}
	}
	return true, nil
}

// WithTenant opens a transaction and binds the tenant id to it via
// `SET LOCAL app.tenant_id`. The caller is responsible for committing or
// rolling back. Every per-tenant DB call MUST go through this — the RLS
// policies in 0001/0002/0003/0004 will return zero rows otherwise (or block
// inserts entirely).
//
// Usage:
//
//	tx, err := db.WithTenant(ctx, pool, tenantID)
//	if err != nil { return err }
//	defer tx.Rollback(ctx) // safe no-op after commit
//	... do queries on tx ...
//	return tx.Commit(ctx)
func WithTenant(ctx context.Context, pool *Pool, tenantID string) (pgx.Tx, error) {
	return WithTenantOptions(ctx, pool, tenantID, pgx.TxOptions{})
}

// WithTenantOptions is WithTenant with caller-selected transaction semantics.
// It is primarily used by paginated reads that need one repeatable snapshot for
// their count and page query; the tenant GUC is still bound before any caller
// statement and remains transaction-local.
func WithTenantOptions(ctx context.Context, pool *Pool, tenantID string, options pgx.TxOptions) (pgx.Tx, error) {
	if tenantID == "" {
		return nil, fmt.Errorf("db: WithTenantOptions requires a tenant id")
	}

	tx, err := pool.BeginTx(ctx, options)
	if err != nil {
		return nil, fmt.Errorf("db: begin tx: %w", err)
	}

	// SET LOCAL is scoped to this transaction only; it is rolled back with
	// the tx. We pass the value via Exec parameters cast to ::uuid via the
	// policy itself — but `SET LOCAL` does not support bind parameters, so
	// we use `set_config(name, value, is_local)` which does.
	if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", tenantID); err != nil {
		_ = tx.Rollback(ctx)
		return nil, fmt.Errorf("db: set tenant scope: %w", err)
	}

	return tx, nil
}

// WithTenantUser is WithTenant plus the acting user, for tables whose rows
// belong to one PERSON inside a tenant rather than to the tenant at large.
//
// Binding `app.user_id` lets a RESTRICTIVE policy enforce ownership in the
// database instead of relying on every query remembering `AND user_id = $n`.
// That predicate is easy to write and impossible to notice missing: a review of
// `editor_checkpoints` deleted it and the whole package still passed, because a
// single-row fixture returns the right row either way.
//
// Deliberately a SEPARATE constructor rather than a change to WithTenant.
// Almost every table in this schema is tenant-scoped and shared on purpose —
// binding a user everywhere would put an ownership filter in front of queries
// that are supposed to see the whole workspace, and the failure would be silent
// and read as "the list is empty".
func WithTenantUser(ctx context.Context, pool *Pool, tenantID, userID string) (pgx.Tx, error) {
	if userID == "" {
		return nil, fmt.Errorf("db: WithTenantUser requires a user id")
	}
	tx, err := WithTenant(ctx, pool, tenantID)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, "SELECT set_config('app.user_id', $1, true)", userID); err != nil {
		_ = tx.Rollback(ctx)
		return nil, fmt.Errorf("db: set user scope: %w", err)
	}
	return tx, nil
}

// WithWorkerScope opens a transaction and binds `app.outbox_worker = 'true'`
// to it via a transaction-local `set_config(..., true)`. Workers (outbox
// drainer, audit-alert tick, dns-health recheck, spam-trap sweeper,
// scheduled-reports dispatcher, etc.) MUST go through this
// rather than the historical bare `set_config('app.outbox_worker', 'true',
// false)` form — that session-level write used to leak onto the next
// checkout when the connection was returned to the pool.
//
// The caller owns commit/rollback. Read-only ticks can just Rollback at the
// end — the worker scope dies with the tx either way.
//
// Combine with WithTenant by also binding `app.tenant_id` on the returned
// tx when the worker needs to act *as* a tenant (per-tenant RLS path):
//
//	tx, err := db.WithWorkerScope(ctx, pool)
//	if err != nil { return err }
//	defer tx.Rollback(ctx)
//	if _, err := tx.Exec(ctx,
//	    "SELECT set_config('app.tenant_id', $1, true)", tenantID); err != nil {
//	    return err
//	}
//	... queries ...
//	return tx.Commit(ctx)
//
// We intentionally do NOT take a tenantID here — many worker ticks operate
// across all tenants (for example, the audit-sink walk) and we
// don't want to force a no-op tenant binding on them.
func WithWorkerScope(ctx context.Context, pool *Pool) (pgx.Tx, error) {
	if pool == nil {
		return nil, fmt.Errorf("db: WithWorkerScope requires a non-nil pool")
	}

	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("db: begin worker tx: %w", err)
	}

	// SET LOCAL via set_config(..., true) so the scope dies with the tx.
	// The matching AfterRelease hook on the pool also RESETs the GUC, so
	// even a buggy caller that opens a raw conn and forgets to roll back
	// cannot leak the scope to the next checkout.
	if _, err := tx.Exec(ctx,
		"SELECT set_config('app.outbox_worker', 'true', true)"); err != nil {
		_ = tx.Rollback(ctx)
		return nil, fmt.Errorf("db: set worker scope: %w", err)
	}

	return tx, nil
}

// WithTenantWorker opens a transaction that is both worker-authorized and
// tenant-bound. Use it for background mutations whose RLS contract requires
// app.outbox_worker without granting a cross-tenant enumeration window.
func WithTenantWorker(ctx context.Context, pool *Pool, tenantID string) (pgx.Tx, error) {
	return WithTenantWorkerOptions(ctx, pool, tenantID, pgx.TxOptions{})
}

// WithTenantWorkerOptions is the serializable/repeatable-read-capable form of
// WithTenantWorker. Both GUCs are transaction-local and are reset on rollback,
// commit, and pool release.
func WithTenantWorkerOptions(ctx context.Context, pool *Pool, tenantID string, options pgx.TxOptions) (pgx.Tx, error) {
	if pool == nil {
		return nil, fmt.Errorf("db: WithTenantWorkerOptions requires a non-nil pool")
	}
	if tenantID == "" {
		return nil, fmt.Errorf("db: WithTenantWorkerOptions requires a tenant id")
	}
	tx, err := pool.BeginTx(ctx, options)
	if err != nil {
		return nil, fmt.Errorf("db: begin tenant worker tx: %w", err)
	}
	if _, err := tx.Exec(ctx,
		"SELECT set_config('app.outbox_worker', 'true', true), set_config('app.tenant_id', $1, true)",
		tenantID); err != nil {
		_ = tx.Rollback(ctx)
		return nil, fmt.Errorf("db: set tenant worker scope: %w", err)
	}
	return tx, nil
}

// WithTenantResolver opens a transaction and binds
// `app.tenant_resolver = 'true'` to it via a transaction-local
// `set_config(..., true)`. Use this for the *narrow pre-tenant
// resolution window* where the caller needs to read from `tenants`
// before `app.tenant_id` has been bound — e.g. translating an
// X-Tenant-Slug header into a tenants row, or matching an API-key
// owner tenant_id back to a tenants row in the apikeys middleware.
//
// Outside this scope, the `tenant_resolver_select` policy on tenants
// (see migration 0333) returns false, so a regular per-tenant
// SELECT cannot accidentally enumerate other tenants — even one with
// a buggy `WHERE` clause that drops the tenant_id filter.
//
// The caller owns Commit/Rollback. The resolver scope dies with the
// tx; AfterRelease additionally RESETs app.tenant_resolver if the
// connection is recycled while the GUC is still set.
//
// Mirrors auth.Repo.withResolverGUC, which serves the same role for
// the pre-tenant auth_credentials / auth_sessions lookups.
func WithTenantResolver(ctx context.Context, pool *Pool) (pgx.Tx, error) {
	if pool == nil {
		return nil, fmt.Errorf("db: WithTenantResolver requires a non-nil pool")
	}

	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("db: begin tenant-resolver tx: %w", err)
	}

	if _, err := tx.Exec(ctx,
		"SELECT set_config('app.tenant_resolver', 'true', true)"); err != nil {
		_ = tx.Rollback(ctx)
		return nil, fmt.Errorf("db: set tenant_resolver scope: %w", err)
	}

	return tx, nil
}
