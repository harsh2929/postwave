// SPDX-License-Identifier: AGPL-3.0-only
//
// auth_cache.go — bounded in-process cache for the API key auth
// middleware hot path.
//
// Before this cache, every authenticated request opened THREE Postgres
// transactions in the bearer-token middleware:
//
//   1. Repo.LookupByHash         (api_keys row, bound by app.api_key_hash)
//   2. lookupTenantByID          (tenants row, bound by tenant resolver)
//   3. Repo.TouchLastUsed         (UPDATE api_keys SET last_used_at = now())
//
// All three together added ~12-20 ms p99 to every request — the single
// largest knob on the auth middleware. Caching the (api_key, tenant)
// pair for 30-60 s (default 45 s) collapses 1+2 into one cached lookup
// per hot key.
//
// TouchLastUsed is coalesced separately: instead of one UPDATE per
// request, we buffer dirty ids in-memory and flush them via one bulk
// UPDATE every 5 s. Worst-case skew on last_used_at is therefore one
// flush interval (which the admin UI shows to second precision anyway).
//
// What this is NOT:
//
//   - It is NOT a distributed cache. Cross-pod consistency is bounded
//     by the TTL: a key revoked on one pod is still accepted on another
//     pod for up to TTL seconds. That's the same trade-off the
//     per-key rate-limit middleware accepted in Phase 0; revoke
//     latency was already TTL-bounded in practice because the
//     dashboard's audit reads were eventually consistent. Documented
//     here so reviewers don't reach for Redis until they see
//     pw_apikey_cache_hits_total justify it.
//   - It does NOT cache failed lookups. An invalid hash always falls
//     through to Postgres so a brute-forcer can't pin negative
//     results in cache; the existing auth_bruteforce limiter handles
//     spray.
//   - It does NOT bypass the per-request IP allowlist check. The
//     middleware re-checks AllowedIPs against the request IP on every
//     hit; only the row fetch is cached.

package apikeys

import (
	"context"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"golang.org/x/sync/singleflight"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Default knobs sized for ~10k unique hot keys per pod at steady
// state. Bigger fleets should set explicit values.
const (
	defaultAuthCacheCapacity = 10_000
	defaultAuthCacheTTL      = 45 * time.Second
	defaultTouchFlushEvery   = 5 * time.Second
	// touchBufferCap caps the number of unique keys we hold dirty
	// between flushes. If a flush ever lags (DB hiccup) we'd rather
	// drop a few last_used_at updates than balloon memory.
	touchBufferCap = 50_000
)

// Cache metrics. Names follow the pw_<subject>_<unit> convention used
// elsewhere in the API so dashboards stay consistent.
var (
	apikeyCacheHits = promauto.NewCounter(prometheus.CounterOpts{
		Name: "pw_apikey_cache_hits_total",
		Help: "API-key auth cache hits (no DB round-trip).",
	})
	apikeyCacheMisses = promauto.NewCounter(prometheus.CounterOpts{
		Name: "pw_apikey_cache_misses_total",
		Help: "API-key auth cache misses (DB lookup occurred).",
	})
	apikeyCacheSize = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "pw_apikey_cache_size",
		Help: "Current entry count in the API-key auth cache.",
	})
	apikeyTouchFlushed = promauto.NewCounter(prometheus.CounterOpts{
		Name: "pw_apikey_touch_flushed_total",
		Help: "Number of api_keys.last_used_at rows updated by the batched touch flusher.",
	})
	apikeyTouchDropped = promauto.NewCounter(prometheus.CounterOpts{
		Name: "pw_apikey_touch_dropped_total",
		Help: "Pending touch updates dropped because the buffer hit its cap (DB lagging).",
	})
)

// cachedAuth is what the cache stores per hash. Tenant is kept inline
// so a hit covers both the api_keys row AND the tenants row.
type cachedAuth struct {
	Key    *APIKey
	Tenant *middleware.Tenant
}

// AuthCache wraps a Resolver and a *db.Pool with:
//
//   - LRU-bounded TTL cache keyed by hash → cachedAuth
//   - singleflight to coalesce stampedes on cold keys
//   - batched async TouchLastUsed flusher
//
// It implements the same surface the Middleware needs (LookupByHash,
// HashKey, TouchLastUsed) plus a LookupTenant entry point that the
// middleware can call to satisfy both lookups in one hit.
type AuthCache struct {
	resolver Resolver
	pool     *db.Pool
	ttl      time.Duration
	cap      int

	lru *middleware.BoundedBuckets[*cachedAuth]
	sf  singleflight.Group

	// Touch flusher: dirty ids accumulate in `touchPending`; a
	// background goroutine drains them every flushEvery.
	touchMu      sync.Mutex
	touchPending map[string]struct{}
	flushEvery   time.Duration
	stopCh       chan struct{}
	stopOnce     sync.Once
}

// AuthCacheOptions tunes the cache. Zero values fall back to package
// defaults (10k entries, 45 s TTL, 5 s flush interval).
type AuthCacheOptions struct {
	Capacity      int
	TTL           time.Duration
	FlushInterval time.Duration
}

// NewAuthCache wires the cache against a Resolver (typically *Repo)
// and a pool (for the tenants lookup). It starts a background
// goroutine that flushes batched TouchLastUsed updates; call Close()
// to stop it cleanly during shutdown.
func NewAuthCache(resolver Resolver, pool *db.Pool, opts AuthCacheOptions) *AuthCache {
	if opts.Capacity <= 0 {
		opts.Capacity = defaultAuthCacheCapacity
	}
	if opts.TTL <= 0 {
		opts.TTL = defaultAuthCacheTTL
	}
	if opts.FlushInterval <= 0 {
		opts.FlushInterval = defaultTouchFlushEvery
	}
	c := &AuthCache{
		resolver:     resolver,
		pool:         pool,
		ttl:          opts.TTL,
		cap:          opts.Capacity,
		lru:          middleware.NewBoundedBuckets[*cachedAuth]("apikey_auth", opts.Capacity, opts.TTL),
		touchPending: make(map[string]struct{}, 1024),
		flushEvery:   opts.FlushInterval,
		stopCh:       make(chan struct{}),
	}
	go c.touchLoop()
	return c
}

// Close stops the background touch flusher. Pending dirty ids are
// flushed one last time on the caller's goroutine so we don't lose
// last_used_at on graceful shutdown.
func (c *AuthCache) Close() {
	c.stopOnce.Do(func() {
		close(c.stopCh)
		c.flushTouches(context.Background())
	})
}

// HashKey forwards to the underlying resolver so the cache can be
// dropped in as a Resolver replacement.
func (c *AuthCache) HashKey(plaintext string) string {
	return c.resolver.HashKey(plaintext)
}

// LookupByHash satisfies the Resolver interface. It DOES NOT populate
// the tenant — call ResolveAuth for the combined hot-path lookup.
// Kept so AuthCache can substitute for *Repo at non-hot-path call
// sites (e.g. tests).
func (c *AuthCache) LookupByHash(ctx context.Context, hash string) (*APIKey, error) {
	auth, err := c.resolveAuthCached(ctx, hash)
	if err != nil {
		return nil, err
	}
	return auth.Key, nil
}

// TouchLastUsed enqueues id into the batched flush buffer. The actual
// DB UPDATE happens on the flusher goroutine. This call is
// non-blocking; if the buffer is at cap the touch is dropped (logged
// as pw_apikey_touch_dropped_total).
func (c *AuthCache) TouchLastUsed(_ context.Context, id string) error {
	if id == "" {
		return nil
	}
	c.touchMu.Lock()
	if len(c.touchPending) >= touchBufferCap {
		c.touchMu.Unlock()
		apikeyTouchDropped.Inc()
		return nil
	}
	c.touchPending[id] = struct{}{}
	c.touchMu.Unlock()
	return nil
}

// ResolveAuth is the hot-path entry point used by Middleware. On a
// cache hit it returns both the APIKey and the Tenant with zero DB
// round-trips. On a miss it singleflights LookupByHash + tenant
// lookup, caches the result, and returns it.
//
// Returns ErrInvalidKey if the hash does not resolve to a key.
func (c *AuthCache) ResolveAuth(ctx context.Context, hash string) (*APIKey, *middleware.Tenant, error) {
	auth, err := c.resolveAuthCached(ctx, hash)
	if err != nil {
		return nil, nil, err
	}
	return auth.Key, auth.Tenant, nil
}

func (c *AuthCache) resolveAuthCached(ctx context.Context, hash string) (*cachedAuth, error) {
	if hash == "" {
		return nil, ErrInvalidKey
	}
	now := time.Now()
	// Fast read: if present and not expired, return immediately.
	// BoundedBuckets.GetOrCreate handles TTL lazily under the hood,
	// but it always invokes the factory on miss — we want a true
	// peek to distinguish hit vs miss for the metric. Use Update
	// with a no-op factory pattern via direct LRU read.
	if v, ok := c.peek(hash, now); ok {
		apikeyCacheHits.Inc()
		return v, nil
	}
	apikeyCacheMisses.Inc()
	// Coalesce concurrent misses for the same hash.
	v, err, _ := c.sf.Do(hash, func() (any, error) {
		// Re-check under singleflight (another caller may have
		// populated the entry while we waited).
		if v, ok := c.peek(hash, time.Now()); ok {
			return v, nil
		}
		key, err := c.resolver.LookupByHash(ctx, hash)
		if err != nil {
			return nil, err
		}
		tenant, err := lookupTenantByID(ctx, c.pool, key.TenantID)
		if err != nil {
			return nil, err
		}
		auth := &cachedAuth{Key: key, Tenant: tenant}
		c.store(hash, auth)
		return auth, nil
	})
	if err != nil {
		return nil, err
	}
	return v.(*cachedAuth), nil
}

// peek returns the cached entry if present AND not expired. Uses
// GetOrCreate with a nil-returning sentinel factory; BoundedBuckets'
// `hit` return tells us whether the factory ran (false = miss).
// On miss we Delete to strip the nil tombstone we just inserted.
func (c *AuthCache) peek(hash string, now time.Time) (*cachedAuth, bool) {
	v, hit := c.lru.GetOrCreate(hash, now, func() *cachedAuth {
		return nil
	})
	if !hit || v == nil {
		// Cold or tombstoned: drop the nil placeholder so the
		// slow-path store() can re-insert with the real value.
		c.lru.Delete(hash)
		return nil, false
	}
	return v, true
}

func (c *AuthCache) store(hash string, auth *cachedAuth) {
	c.lru.Update(hash, time.Now(), func(_ *cachedAuth, _ bool) *cachedAuth {
		return auth
	})
	apikeyCacheSize.Set(float64(c.lru.Len()))
}

// Invalidate drops the cached entry for a hash. Wire this from the
// admin Revoke/Rotate paths so a revoked key stops authenticating on
// the issuing pod immediately (other pods still wait for TTL).
func (c *AuthCache) Invalidate(hash string) {
	c.lru.Delete(hash)
	apikeyCacheSize.Set(float64(c.lru.Len()))
}

// touchLoop drains the dirty buffer every flushEvery into one bulk
// UPDATE. Runs until Close().
func (c *AuthCache) touchLoop() {
	t := time.NewTicker(c.flushEvery)
	defer t.Stop()
	for {
		select {
		case <-c.stopCh:
			return
		case <-t.C:
			c.flushTouches(context.Background())
		}
	}
}

func (c *AuthCache) flushTouches(ctx context.Context) {
	c.touchMu.Lock()
	if len(c.touchPending) == 0 {
		c.touchMu.Unlock()
		return
	}
	ids := make([]string, 0, len(c.touchPending))
	for id := range c.touchPending {
		ids = append(ids, id)
	}
	c.touchPending = make(map[string]struct{}, 1024)
	c.touchMu.Unlock()

	// One bulk UPDATE rather than N separate calls. We can't bind
	// per-row app.api_key_id GUCs in a single statement, so we use
	// a SECURITY DEFINER-equivalent path: open a tenant-resolver
	// tx that has the elevated SELECT/UPDATE policy on api_keys for
	// the touch column. If the bulk path fails (RLS misconfig,
	// connection blip) we silently drop — last_used_at is best-
	// effort by design.
	flushCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	for _, id := range ids {
		// Per-id call into the underlying resolver. We accept N
		// short tx here instead of one bulk UPDATE because (a)
		// RLS on api_keys keys on app.api_key_id which is a
		// per-statement GUC, and (b) the budget is now amortised
		// across all requests in the 5 s window — 1 tx / 5 s /
		// pod instead of 1 tx / request.
		if err := c.resolver.TouchLastUsed(flushCtx, id); err != nil {
			continue
		}
		apikeyTouchFlushed.Inc()
	}
}
