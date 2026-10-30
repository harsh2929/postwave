// SPDX-License-Identifier: AGPL-3.0-only
//
// dashboard_live_cache.go — per-tenant TTL singleflight cache for the
// DashboardLive SSE endpoint.
//
// Why this exists:
//
//   The SSE handler (dashboard_live.go) calls Repo.DashboardStats once per
//   dashboardLivePollInterval per open EventSource connection. The default
//   desktop shell keeps ~5 tabs open per tenant, so without collapsing, a
//   tenant pays five times over for the same numbers. Scale that across 100
//   active tenants and the dashboard query alone eats a measurable slice of
//   pool capacity.
//
//   The query is identical across every connection for the same tenant in
//   the same window — the only thing that varies is which socket the bytes
//   get written to. So we wrap the fetch in a per-tenant cache with a TTL
//   equal to the poll interval and a singleflight to collapse the herd.
//
// Math:
//
//   Before: N_connections × the poll rate.
//   After:  1 × the poll rate (cap, regardless of N_connections),
//           because the LRU TTL matches the poll cadence so each tick
//           triggers exactly one compute that all listeners read from.
//
//   The cache bounds the MULTIPLIER, not the cadence: cutting the query
//   rate itself is what dashboardLivePollInterval is for.
//
// Implementation notes:
//
//   * Backed by the Phase-1 BoundedBuckets LRU primitive (bounded at
//     1024 tenant entries — generous headroom; with current scale we
//     never approach the cap, but the bound guarantees the cache can't
//     leak memory under a tenant-spray attack).
//   * The LRU's built-in singleflight (sf.Do inside GetOrCreate) is
//     what gives us the herd-collapsing behavior. We don't need an
//     external singleflight.Group — BoundedBuckets already wraps one
//     per key.
//   * TTL matches the SSE poll interval (dashboardLivePollInterval). On
//     cache miss / expiry the factory runs DashboardStatsWithOptions once;
//     concurrent
//     callers block briefly inside sf.Do and then read the same cached
//     pointer.
//   * Cache stores *DashboardStats (pointer) so we don't copy ~200B of
//     struct per consumer. Callers must treat the returned struct as
//     read-only — they all share the same underlying pointer.

package analytics

import (
	"context"
	"time"

	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// dashboardLivePollInterval is the default SSE tick for the dashboard stats
// stream.
//
// It was 2s, copied from the per-campaign /events stream. The two are not
// comparable: that stream tails one campaign's recent events, while this one
// re-runs the tenant's whole 30-day rollup — four COUNT(*) subqueries, a
// ten-aggregate 30-day scan with five count(DISTINCT ...), the 60-day
// previous-window CTE, and the sparklines — 1,800 times an hour per open
// analytics tab, to refresh 30-day denominators that move by well under 0.1%
// in two seconds. The TTL cache collapsed concurrent tabs of one tenant but
// could not reduce the cadence, because it expired exactly as fast as the
// ticker fired.
//
// 15s keeps the stream feeling live for the counters that actually move
// (today's sends, opens in the last minute) at an eighth of the database cost.
// Callers that want a different cadence still set LiveDeps.PollInterval.
const dashboardLivePollInterval = 15 * time.Second

// dashboardLiveCacheTTL is how long a cached DashboardStats payload is
// considered fresh. Matches the SSE poll interval so each poll cycle triggers
// at most one underlying query per tenant, and so tabs whose ticks land in the
// same window share one execution rather than each paying for a scan.
const dashboardLiveCacheTTL = dashboardLivePollInterval

// dashboardLiveCacheCapacity caps the LRU at 1024 entries. At ~250B
// per cached struct that's ~250KB resident — negligible. The bound
// exists to prevent unbounded growth under tenant-spray, not to
// reflect a realistic working set.
const dashboardLiveCacheCapacity = 1024

// dashboardLiveCacheHits / Misses tracks how effective the cache is.
// A high hit ratio (~95%+ at scale) confirms the singleflight is
// collapsing the herd; a low one means tenants aren't sharing
// connections (which would be unexpected and worth investigating).
var (
	dashboardLiveCacheHits = promauto.NewCounter(prometheus.CounterOpts{
		Name: "dashboard_live_cache_hits_total",
		Help: "Cache hits on the per-tenant DashboardLive SSE cache (cached payload still fresh within the TTL).",
	})
	dashboardLiveCacheMisses = promauto.NewCounter(prometheus.CounterOpts{
		Name: "dashboard_live_cache_misses_total",
		Help: "Cache misses on the per-tenant DashboardLive SSE cache (factory invoked: stats freshly fetched).",
	})
)

// dashboardLiveCache wraps the per-tenant LRU + singleflight that
// fronts Repo.DashboardStats for the SSE endpoint.
//
// Safe for concurrent use. The underlying BoundedBuckets guards all
// state with an internal mutex + singleflight.Group.
type dashboardLiveCache struct {
	buckets *middleware.BoundedBuckets[*DashboardStats]
}

// newDashboardLiveCache constructs the singleton cache used by every
// DashboardLive handler instance. The TTL+capacity are package-level
// constants — there's no per-deployment knob because the values are
// tied to the poll cadence (TTL) and basic memory hygiene (cap).
func newDashboardLiveCache() *dashboardLiveCache {
	return &dashboardLiveCache{
		buckets: middleware.NewBoundedBuckets[*DashboardStats](
			"dashboard_live", dashboardLiveCacheCapacity, dashboardLiveCacheTTL,
		),
	}
}

// fetch returns the cached DashboardStats for tenantID if it's still
// fresh, otherwise invokes loader under singleflight to recompute and
// cache the result. Concurrent callers for the same tenant share a
// single loader invocation.
//
// loader is invoked at most once per (tenantID, TTL window) regardless
// of how many SSE connections are open for that tenant. On loader
// error the error propagates to all waiters and nothing is cached
// (so the next tick will retry rather than serving a stale failure).
func (c *dashboardLiveCache) fetch(
	ctx context.Context,
	tenantID string,
	loader func(ctx context.Context, tenantID string) (*DashboardStats, error),
) (*DashboardStats, error) {
	var loadErr error
	now := time.Now()
	stats, cached := c.buckets.GetOrCreate(tenantID, now, func() *DashboardStats {
		s, err := loader(ctx, tenantID)
		if err != nil {
			// Capture the error so we can surface it to the caller.
			// We still return nil here — the BoundedBuckets stores
			// whatever the factory returns, and the post-call check
			// below evicts the nil entry so the next caller retries
			// instead of getting a permanent miss.
			loadErr = err
			return nil
		}
		return s
	})
	if loadErr != nil {
		// Evict the nil sentinel so the next call re-fires the loader
		// instead of caching the failure for the full TTL.
		c.buckets.Delete(tenantID)
		return nil, loadErr
	}
	if stats == nil {
		// Defensive: another goroutine raced us through the factory
		// path and stored a nil. Treat as miss and re-load.
		c.buckets.Delete(tenantID)
		return loader(ctx, tenantID)
	}
	if cached {
		dashboardLiveCacheHits.Inc()
	} else {
		dashboardLiveCacheMisses.Inc()
	}
	return stats, nil
}
