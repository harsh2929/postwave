// SPDX-License-Identifier: AGPL-3.0-only
//
// ratelimit_tiered.go — Redis-first per-tenant send-rate limiter for
// the bulk-volume hot path.
//
// Why this exists:
//
//   The original PostgresRateLimiter (see ratelimit.go) takes 4-5
//   roundtrips per recipient (BEGIN, set tenant GUC, SELECT cap,
//   SELECT … FOR UPDATE on the bucket, UPDATE the bucket, COMMIT).
//   At 100 sends/sec/tenant across multiple tenants this saturates the
//   pgxpool with rate-limit traffic that has nothing to do with the
//   actual send. The send loop's profiling under load showed >40% of
//   wall time inside RateLimit.Try for bulk drains.
//
// What this gives us:
//
//   Three tiers, picked at Try-time per call:
//
//     1. Redis shared-cap authority — production primary when REDIS_URL
//        is set. One Lua operation reads the ready/conservatively-fenced
//        cap and applies INCRBY + first EXPIRE, so a settings commit cannot
//        race a replica that read an older cap. Cross-replica admissions are
//        linearised by Redis. Coordination errors fail the admission closed.
//
//     2. Bounded LRU (BoundedBuckets) — legacy single-process secondary.
//        Used only when shared cap coordination was never started, as in an
//        explicitly single-replica development process. Once coordination is
//        started, Redis failure never falls back to this replica-local tier.
//        Bounded so a tenant-id spray cannot OOM the limiter.
//
//     3. Postgres (PostgresRateLimiter) — tertiary cold-storage option
//        for restart durability. NOT consulted on the hot path; only
//        used at limiter construction to warm the in-process bucket
//        from disk so a freshly-restarted gateway doesn't briefly
//        ignore the per-tenant cap. Disabled by default (the warm-up
//        adds a Postgres SELECT per tenant at boot and most operators
//        prefer the simpler reset-on-restart semantic).
//
// Cap source:
//
//   tenant_sending_settings.max_sends_per_hour (uint32). NULL or ≤ 0 means
//   uncapped. Production initializes a missing shared Redis state from this
//   row, then consults Redis on every admission so even an uncapped tenant can
//   observe a later tightening. The 30s in-process cache exists only on the
//   explicitly non-coordinated legacy path.
//
// Atomicity / linearisation:
//
//   - The shared-cap Lua operation reads the current cap and applies INCRBY
//     atomically across replicas. Window TTL is set on the first reservation.
//     Settings writes install the stricter of old/requested cap before their
//     database commit, then replace it with the canonical committed cap.
//   - LRU path takes a mutex per bucket touch. Linearised within one
//     replica, NOT across replicas. It is never a production fallback after
//     shared coordination starts.
//
// Backend-selection metric:
//
//   sending_rate_limit_backend_total{backend="redis|lru|postgres",outcome="hit|miss|error"}
//
//   Operators dashboard this as a stacked area: redis should dominate in
//   production. Any `lru` traffic identifies a deliberately uncoordinated
//   single-process runtime; Redis errors correspond to denied admissions.

package sending

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// rateLimitBackendCounter labels each Try() call by which tier served
// it and the outcome (hit = within cap, miss = denied, error = backend
// failure). Dashboarded as the canary signal for "is the send loop
// healthy on the hot path".
var rateLimitBackendCounter = promauto.NewCounterVec(
	prometheus.CounterOpts{
		Name: "sending_rate_limit_backend_total",
		Help: "Per-tenant send-rate limiter calls partitioned by serving backend (redis|lru|postgres) and outcome (hit|miss|error).",
	},
	[]string{"backend", "outcome"},
)

// rateLimitCapCacheCounter tracks legacy non-coordinated cap-cache
// effectiveness. Production shared-cap admissions do not increment it.
// hit  = served from the in-process 30s cache (no Postgres roundtrip)
// miss = hit Postgres for a fresh cap value
// evict= entry aged out (informational; the LRU never bounds it but
//
//	stale entries are dropped on read)
var rateLimitCapCacheCounter = promauto.NewCounterVec(
	prometheus.CounterOpts{
		Name: "sending_rate_limit_cap_cache_total",
		Help: "Per-tenant cap-cache lookups for the send-rate limiter (hit|miss|evict).",
	},
	[]string{"outcome"},
)

// CapLookupTTL applies only to the legacy non-coordinated cap cache. The
// production shared-cap path observes each committed transition without this
// delay. Exposed as a var so legacy benchmarks/tests can shorten it.
var CapLookupTTL = 30 * time.Second

// TieredRateLimiter is the production RateLimiter. With cap coordination
// started it uses only the fail-closed shared Redis authority. Without that
// authority it retains the historical Redis → LRU → Postgres sequence for
// explicit single-process development and focused legacy tests.
//
// Construction: NewTieredRateLimiter. Callers should typically pass:
//
//   - Pool: the gateway pgxpool. Required (used for the cap lookup
//     and the optional Postgres tertiary backend).
//   - Redis: middleware.FixedWindowStore (Redis-backed) when set.
//     Pass nil for single-replica deploys.
//   - Window: defaults to 1 hour when zero.
//   - EnablePostgresFallback: when true, hot-path falls back to the
//     PostgresRateLimiter if both Redis AND the LRU are unavailable.
//     Almost always false — the LRU is the recommended fallback.
//
// Fields are public for the rare test that needs to swap backends
// in/out at runtime. Production callers should use the constructor.
type TieredRateLimiter struct {
	Pool                   *db.Pool
	Redis                  middleware.FixedWindowStore
	Window                 time.Duration
	EnablePostgresFallback bool

	// lru is the bounded in-process bucket store used when Redis is
	// unavailable. 10k tenant cap is comfortably above any realistic
	// active-tenant count; spray-attack tenants get evicted LRU-style
	// rather than OOM-ing the process.
	lru *middleware.BoundedBuckets[*tieredBucket]

	// postgres is the tertiary cold-storage option. nil unless
	// EnablePostgresFallback is true at construction.
	postgres *PostgresRateLimiter

	// capCache deduplicates the tenant_sending_settings.max_sends_per_hour
	// lookup per tenant for CapLookupTTL. Mutex-guarded; the cap
	// rarely changes so a single mutex is fine for the read path.
	capMu    sync.RWMutex
	capCache map[string]capEntry

	// capCoord is the production cross-replica authority. When present, Try
	// bypasses capCache and performs cap resolution + counter reservation in
	// one shared operation. The legacy cache remains only for explicitly
	// non-coordinated single-process tests/development.
	coordMu     sync.RWMutex
	capCoord    CapCoordinationBackend
	capResolver func(context.Context, string) (int, bool, error)
	// staleCapReconciler is a deterministic test seam for the production
	// Postgres-lock + Redis-CAS reclamation path.
	staleCapReconciler func(context.Context, string, *staleCapStateError, CapCoordinationBackend) error
	// missingCapInitializer is the matching test seam for missing-key
	// rehydration under the tenant Postgres mutation lock.
	missingCapInitializer func(context.Context, string, CapCoordinationBackend) error
}

type capEntry struct {
	cap       int  // 0 means uncapped (NULL or <=0 in DB)
	hasCap    bool // false means the tenant has no settings row OR has NULL
	expiresAt time.Time
}

// tieredBucket is the LRU-fallback bucket payload. Kept tiny so the
// 10k-entry bounded LRU stays well under 1MB.
type tieredBucket struct {
	mu          sync.Mutex
	sent        int
	windowStart time.Time
}

// NewTieredRateLimiter constructs a tiered limiter wired to the
// caller's pool + (optional) Redis store. lruCapacity ≤ 0 falls back
// to the bounded-LRU default (10k entries).
//
// At construction we record a one-shot metric for which backend is
// active: if Redis is nil we bump middleware.MarkRedisFallback so
// operators see the "this gateway is single-replica" signal in the
// rate_limit_redis_fallback_total counter (shared label space with
// the other limiters).
func NewTieredRateLimiter(pool *db.Pool, redis middleware.FixedWindowStore, window time.Duration, lruCapacity int) *TieredRateLimiter {
	if window <= 0 {
		window = time.Hour
	}
	// 30 days TTL on the LRU entries is far longer than the 1h window;
	// the bucket reset logic inside Try() handles window-elapsed
	// resets independently. The TTL only serves to drop tenants that
	// have stopped sending entirely so they don't pin a slot.
	lru := middleware.NewBoundedBuckets[*tieredBucket]("sending_rate_limit", lruCapacity, 24*time.Hour)
	if redis == nil {
		middleware.MarkRedisFallback("sending_rate_limit")
	}
	t := &TieredRateLimiter{
		Pool:     pool,
		Redis:    redis,
		Window:   window,
		lru:      lru,
		capCache: make(map[string]capEntry, 256),
	}
	return t
}

// EnablePostgresTertiary turns on the cold-storage tertiary backend for the
// legacy non-coordinated path. Production shared-cap coordination never falls
// through to it after a Redis error.
func (t *TieredRateLimiter) EnablePostgresTertiary() {
	if t == nil {
		return
	}
	t.EnablePostgresFallback = true
	t.postgres = &PostgresRateLimiter{Pool: t.Pool, Window: t.Window}
}

// Try implements RateLimiter. See the file header for backend
// selection and atomicity semantics.
func (t *TieredRateLimiter) Try(ctx context.Context, tenantID string, n int) (bool, time.Time, error) {
	if n <= 0 {
		return true, time.Time{}, nil
	}
	if t == nil {
		return false, time.Time{}, errors.New("ratelimit: nil tiered limiter")
	}
	window := t.Window
	if window <= 0 {
		window = time.Hour
	}
	now := time.Now().UTC()

	// Production path: Redis atomically reads the shared cap state and reserves
	// the shared counter. A separate GET followed by Reserve would still allow a
	// replica that read the old cap immediately before a settings commit to
	// admit immediately after it. Coordination failures deny the admission;
	// falling back to a per-process LRU here would defeat the contract.
	if coordinator := t.capCoordinator(); coordinator != nil {
		var reservation CapReservation
		var err error
		for attempt := 0; attempt < 3; attempt++ {
			now = time.Now().UTC()
			reservation, err = coordinator.Reserve(ctx, tenantID, n, window, now)
			if errors.Is(err, errCapStateMissing) ||
				errors.Is(err, errCapStateUntrusted) ||
				errors.Is(err, ErrCapStateCorrupt) {
				if initErr := t.initializeMissingCap(ctx, tenantID, coordinator); initErr != nil {
					err = initErr
					break
				}
				continue
			}
			var stale *staleCapStateError
			if errors.As(err, &stale) {
				if reconcileErr := t.reconcileStaleCap(ctx, tenantID, stale); reconcileErr != nil {
					err = reconcileErr
					break
				}
				continue
			}
			break
		}
		if err != nil {
			rateLimitBackendCounter.WithLabelValues("redis", "error").Inc()
			return false, time.Time{}, err
		}
		if !reservation.HasCap || reservation.Allowed {
			rateLimitBackendCounter.WithLabelValues("redis", "hit").Inc()
			return true, time.Time{}, nil
		}
		rateLimitBackendCounter.WithLabelValues("redis", "miss").Inc()
		return false, reservation.RetryAt, nil
	}
	// Pool nil is allowed when the cap cache is pre-populated (the
	// hot path will short-circuit before lookupCap; only a cache miss
	// reaches the Pool). lookupCap returns an explicit error in that
	// case, surfacing the wiring bug without crashing the send loop.

	// 1. Cap lookup (cached). Uncapped tenants short-circuit before
	//    we touch any backend.
	cap, hasCap, err := t.lookupCap(ctx, tenantID)
	if err != nil {
		return false, time.Time{}, err
	}
	if !hasCap || cap <= 0 {
		return true, time.Time{}, nil
	}

	// 2. Redis primary.
	if t.Redis != nil {
		count, resetAt, rerr := t.Redis.Reserve(ctx, "sending:tenant:"+tenantID, cap, window, now)
		if rerr == nil {
			if count <= cap {
				rateLimitBackendCounter.WithLabelValues("redis", "hit").Inc()
				return true, time.Time{}, nil
			}
			rateLimitBackendCounter.WithLabelValues("redis", "miss").Inc()
			return false, resetAt, nil
		}
		// Redis transient error → fall through to LRU. We don't
		// distinguish "Redis down" from "Redis returned an error" —
		// either way the LRU is the right tier to handle the next call.
		rateLimitBackendCounter.WithLabelValues("redis", "error").Inc()
	}

	// 3. LRU secondary.
	allowed, retryAt := t.lruTry(tenantID, cap, n, window, now)
	if allowed {
		rateLimitBackendCounter.WithLabelValues("lru", "hit").Inc()
		return true, time.Time{}, nil
	}
	if !t.EnablePostgresFallback {
		rateLimitBackendCounter.WithLabelValues("lru", "miss").Inc()
		return false, retryAt, nil
	}

	// 4. Postgres tertiary — only when the operator explicitly opted in
	//    at construction. The LRU returning miss means the in-process
	//    bucket says we're full; we double-check against Postgres so a
	//    cross-replica scenario where the LRU is stale doesn't refuse a
	//    send the durable bucket would have allowed.
	if t.postgres == nil {
		rateLimitBackendCounter.WithLabelValues("lru", "miss").Inc()
		return false, retryAt, nil
	}
	ok, pgRetry, perr := t.postgres.Try(ctx, tenantID, n)
	if perr != nil {
		rateLimitBackendCounter.WithLabelValues("postgres", "error").Inc()
		return false, time.Time{}, perr
	}
	if ok {
		rateLimitBackendCounter.WithLabelValues("postgres", "hit").Inc()
		return true, time.Time{}, nil
	}
	rateLimitBackendCounter.WithLabelValues("postgres", "miss").Inc()
	return false, pgRetry, nil
}

// lruTry runs the read-modify-write under the per-bucket mutex inside
// the BoundedBuckets store's Update call.
//
// BoundedBuckets.Update releases the global LRU mutex BEFORE invoking
// this callback and then runs us under the entry's per-key mutex.
// That per-key mutex already serialises every concurrent reservation
// for `tenantID`, so we no longer need to lock tieredBucket.mu inside
// the callback — doing so would just acquire a second mutex covering
// the same critical section. We keep the bucket struct's mu field for
// callers that touch the bucket OUTSIDE Update (none today, but the
// invariant that the bucket payload is independently safe to read is
// worth preserving).
func (t *TieredRateLimiter) lruTry(tenantID string, cap, n int, window time.Duration, now time.Time) (bool, time.Time) {
	type result struct {
		allowed bool
		retryAt time.Time
	}
	var res result
	t.lru.Update(tenantID, now, func(existing *tieredBucket, hit bool) *tieredBucket {
		b := existing
		if b == nil {
			b = &tieredBucket{}
		}
		if b.windowStart.IsZero() || now.Sub(b.windowStart) >= window {
			b.windowStart = now
			b.sent = 0
		}
		if b.sent+n > cap {
			res = result{allowed: false, retryAt: b.windowStart.Add(window)}
			return b
		}
		b.sent += n
		res = result{allowed: true}
		return b
	})
	return res.allowed, res.retryAt
}

// lookupCap returns the per-tenant max_sends_per_hour from cache or
// Postgres. The cache TTL (CapLookupTTL) bounds operator-visible
// latency on cap changes.
func (t *TieredRateLimiter) lookupCap(ctx context.Context, tenantID string) (int, bool, error) {
	now := time.Now()
	t.capMu.RLock()
	if entry, ok := t.capCache[tenantID]; ok {
		if now.Before(entry.expiresAt) {
			t.capMu.RUnlock()
			rateLimitCapCacheCounter.WithLabelValues("hit").Inc()
			return entry.cap, entry.hasCap, nil
		}
	}
	t.capMu.RUnlock()
	rateLimitCapCacheCounter.WithLabelValues("miss").Inc()

	cap, hasCap, err := t.resolveCap(ctx, tenantID)
	if err != nil {
		return 0, false, err
	}
	t.capMu.Lock()
	// Bound the cache so a tenant-id spray can't grow it without bound.
	// 100k entries × ~40 bytes ≈ 4MB; small relative to the gateway
	// budget but worth bounding all the same.
	const capCacheMax = 100_000
	if len(t.capCache) >= capCacheMax {
		// Cheap full-flush rather than an LRU here — the cache is
		// short-TTL (30s) so a sweep recovers all live tenants
		// within a window or two. Operators of a 100k+ active-tenant
		// gateway should size CapLookupTTL accordingly.
		t.capCache = make(map[string]capEntry, 256)
		rateLimitCapCacheCounter.WithLabelValues("evict").Inc()
	}
	t.capCache[tenantID] = capEntry{
		cap:       cap,
		hasCap:    hasCap,
		expiresAt: now.Add(CapLookupTTL),
	}
	t.capMu.Unlock()
	return cap, hasCap, nil
}

// resolveCap performs an uncached authoritative read. Coordinated cold starts
// and mutation fences use it only when Redis has no tenant state. Tests may
// inject capResolver; production reads tenant_sending_settings through Pool.
func (t *TieredRateLimiter) resolveCap(ctx context.Context, tenantID string) (int, bool, error) {
	if t.capResolver != nil {
		return t.capResolver(ctx, tenantID)
	}
	if t.Pool == nil {
		return 0, false, errors.New("ratelimit: cap resolver is unavailable")
	}
	tx, err := db.WithTenant(ctx, t.Pool, tenantID)
	if err != nil {
		return 0, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var cap int
	var hasCap bool
	err = tx.QueryRow(ctx, `
SELECT COALESCE(max_sends_per_hour, 0), max_sends_per_hour IS NOT NULL
FROM tenant_sending_settings
WHERE tenant_id = $1::uuid`, tenantID).Scan(&cap, &hasCap)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return 0, false, fmt.Errorf("ratelimit: read cap: %w", err)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		cap = 0
		hasCap = false
	}
	if cerr := tx.Commit(ctx); cerr != nil {
		return 0, false, cerr
	}
	return cap, hasCap, nil
}

// InvalidateCapCache drops the legacy single-process cache. Production
// settings writes use BeginCapChange/CommitCapChange instead; local eviction
// alone is not a cross-replica convergence guarantee.
func (t *TieredRateLimiter) InvalidateCapCache(tenantID string) {
	if t == nil {
		return
	}
	t.capMu.Lock()
	delete(t.capCache, tenantID)
	t.capMu.Unlock()
}
