// Package db owns the canonical pgx connection pool and tenant-scoped
// transaction helpers for the API gateway *and* its sibling Go services.
//
// This is the shared-runtime version of what used to live at
// apps/api/internal/db. The shape is deliberately tiny: a pool factory
// + a `WithTenant` / `WithWorkerScope` / `WithTenantResolver` helper.
// Anything more sophisticated (repositories, query builders) belongs in
// the caller — this package just owns the connection lifecycle and the
// `SET LOCAL app.<scope>` ritual.
//
// Defence-in-depth: the pool installs an `AfterRelease` hook that RESETs
// the well-known worker GUCs (`app.outbox_worker`, `app.tenant_id`,
// `app.sending_deprovision_worker`, `app.tenant_resolver`) before a
// connection returns to the pool. Anything that historically set them at
// the *session* level (set_config(..., false)) used to leak the scope to
// the next caller — AfterRelease closes that hole even for legacy call
// sites that haven't been migrated to WithWorkerScope yet. The lint script
// `scripts/check-no-bare-set-config.sh` blocks new uses of the unsafe form.
package db

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/exaring/otelpgx"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// workerGUCs lists every Postgres GUC the API or its workers ever bind at
// the session level. They MUST be reset on connection release so a worker
// scope can't ride a recycled connection into a per-tenant request handler
// (which would silently bypass RLS or trigger the wrong audit branch).
//
// New scopes go here AND in the matching RLS predicate.
var workerGUCs = []string{
	"app.outbox_worker",
	"app.tenant_id",
	"app.sending_deprovision_worker",
	// app.tenant_resolver is bound by the pre-tenant resolution window
	// (slug -> tenant_id, api-key tenant_id -> tenants row) so the
	// narrow resolver-only SELECT policy on `tenants` fires. See
	// migration 0333_tenants_rls_split.sql for the policy split.
	"app.tenant_resolver",
}

// Pool is the application's shared pgx pool. We alias the pgx type so
// callers don't need to import pgxpool directly for typing.
type Pool = pgxpool.Pool

// PoolConfig captures the small set of fields that callers occasionally
// want to override without having to round-trip through DATABASE_URL
// query params. The zero value yields the interactive-API defaults that
// the gateway has shipped with since day one.
//
// Callers that want the defaults verbatim should use New (which is
// equivalent to NewWithConfig(ctx, url, PoolConfig{})).
type PoolConfig struct {
	// MaxConns caps total connections in the pool. Defaults to 25.
	MaxConns int32
	// MinConns is the warm-pool floor. Defaults to 2.
	MinConns int32
	// MaxConnLifetime evicts a connection after this duration regardless
	// of activity (lets the LB rebalance). Defaults to 30 minutes.
	MaxConnLifetime time.Duration
	// MaxConnIdleTime closes idle connections after this duration.
	// Defaults to 5 minutes.
	MaxConnIdleTime time.Duration
	// HealthCheckPeriod is the gap between background health checks.
	// Defaults to 30 seconds.
	HealthCheckPeriod time.Duration
	// AllowPrivilegedRole bypasses the rolsuper/rolbypassrls guard only in
	// local development. Protected environments reject this setting before
	// accepting a connection.
	AllowPrivilegedRole bool
}

func (c PoolConfig) withDefaults() PoolConfig {
	if c.MaxConns == 0 {
		c.MaxConns = 25
	}
	if c.MinConns == 0 {
		c.MinConns = 2
	}
	if c.MaxConnLifetime == 0 {
		c.MaxConnLifetime = 30 * time.Minute
	}
	if c.MaxConnIdleTime == 0 {
		c.MaxConnIdleTime = 5 * time.Minute
	}
	if c.HealthCheckPeriod == 0 {
		c.HealthCheckPeriod = 30 * time.Second
	}
	return c
}

// New constructs a pgx pool from a Postgres connection URL with sane
// defaults for an interactive API workload. Equivalent to
// NewWithConfig(ctx, databaseURL, PoolConfig{}).
//
// We keep this small on purpose: the pool is tuned at the env-var level
// (PG* vars / DATABASE_URL params) — only the fields that don't have a
// reasonable URL-level expression are forced here.
func New(ctx context.Context, databaseURL string) (*Pool, error) {
	return NewWithConfig(ctx, databaseURL, PoolConfig{})
}

// NewWithConfig is like New but accepts a PoolConfig override. Most
// callers should use New; this exists for services that have a tuning
// reason to deviate (e.g. a background worker that wants a small pool).
func NewWithConfig(ctx context.Context, databaseURL string, pc PoolConfig) (*Pool, error) {
	pc = pc.withDefaults()

	cfg, configErr := pgxpool.ParseConfig(databaseURL)
	if configErr != nil {
		return nil, fmt.Errorf("db: parse DATABASE_URL: %w", configErr)
	}

	cfg.MaxConns = pc.MaxConns
	cfg.MinConns = pc.MinConns
	cfg.MaxConnLifetime = pc.MaxConnLifetime
	cfg.MaxConnIdleTime = pc.MaxConnIdleTime
	cfg.HealthCheckPeriod = pc.HealthCheckPeriod

	// Wire OpenTelemetry pgx tracer. A no-op TracerProvider (default when
	// observability.InitTracing didn't find OTEL_EXPORTER_OTLP_ENDPOINT)
	// means this is effectively free at runtime; with a provider it emits
	// one span per query / batch / connect so the database appears in
	// distributed traces.
	cfg.ConnConfig.Tracer = otelpgx.NewTracer()

	// AfterRelease defence-in-depth: RESET every worker GUC before the
	// connection returns to the pool so a worker scope cannot leak to the
	// next checkout. Returning false destroys the connection — which we do
	// only if the RESET itself failed (rare; means the conn is unhealthy).
	//
	// The RESETs are issued with a short bounded context — the caller's ctx
	// may already be cancelled (defer Release after request finish), and we
	// must not block the pool on a request-scoped deadline.
	cfg.AfterRelease = func(c *pgx.Conn) bool {
		rctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		for _, name := range workerGUCs {
			// RESET is the canonical "forget local setting" — equivalent
			// to SET name TO DEFAULT. It works whether the GUC was set
			// via SET LOCAL (per-tx) or SET (session). RESET on an unset
			// GUC is a no-op, so this is safe even for vanilla request
			// connections.
			if _, err := c.Exec(rctx, "RESET "+name); err != nil {
				// Connection is in a bad state — drop it rather than recycle.
				return false
			}
		}
		return true
	}

	pool, configErr := pgxpool.NewWithConfig(ctx, cfg)
	if configErr != nil {
		return nil, fmt.Errorf("db: connect: %w", configErr)
	}

	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("db: ping: %w", err)
	}
	allowPrivilegedRole, configErr := privilegedRoleBypassAllowed(pc.AllowPrivilegedRole, os.Getenv)
	if configErr != nil {
		pool.Close()
		return nil, configErr
	}
	if !allowPrivilegedRole {
		if err := rejectPrivilegedRuntimeRole(pingCtx, pool); err != nil {
			pool.Close()
			return nil, err
		}
	}

	return pool, nil
}

func rejectPrivilegedRuntimeRole(ctx context.Context, pool *Pool) error {
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

func privilegedRoleBypassAllowed(configured bool, env func(string) string) (bool, error) {
	if env == nil {
		env = os.Getenv
	}
	requested := configured || strings.TrimSpace(env("POSTWAVE_ALLOW_PRIVILEGED_DB_ROLE")) == "1"
	if !requested {
		return false, nil
	}
	for _, key := range []string{"POSTWAVE_ENV", "APP_ENV", "GO_ENV", "ENVIRONMENT"} {
		switch strings.ToLower(strings.TrimSpace(env(key))) {
		case "production", "prod", "staging", "stage":
			return false, fmt.Errorf("db: privileged runtime roles are forbidden in protected environments")
		}
	}
	return true, nil
}

// WithTenant opens a transaction and binds the tenant id to it via
// `SET LOCAL app.tenant_id`. The caller is responsible for committing or
// rolling back. Every per-tenant DB call MUST go through this — the RLS
// policies in 0001/0002/0003/0004 will return zero rows otherwise (or
// block inserts entirely).
//
// Usage:
//
//	tx, err := db.WithTenant(ctx, pool, tenantID)
//	if err != nil { return err }
//	defer tx.Rollback(ctx) // safe no-op after commit
//	... do queries on tx ...
//	return tx.Commit(ctx)
func WithTenant(ctx context.Context, pool *Pool, tenantID string) (pgx.Tx, error) {
	if tenantID == "" {
		return nil, fmt.Errorf("db: WithTenant requires a tenant id")
	}

	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
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

// WithWorkerScope opens a transaction and binds `app.outbox_worker = 'true'`
// to it via a transaction-local `set_config(..., true)`. Workers (outbox
// drainer, audit-alert tick, dns-health recheck, spam-trap sweeper, scoring
// recomputer, scheduled-reports dispatcher, etc.) MUST go through this
// rather than the historical bare `set_config('app.outbox_worker', 'true',
// false)` form — that session-level write used to leak onto the next
// checkout when the connection was returned to the pool.
//
// The caller owns commit/rollback. Read-only ticks can just Rollback at
// the end — the worker scope dies with the tx either way.
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
// across all tenants (audit-sink walk, scoring all-tenants pass) and we
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
