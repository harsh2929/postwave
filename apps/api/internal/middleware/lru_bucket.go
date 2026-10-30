// SPDX-License-Identifier: AGPL-3.0-only
//
// lru_bucket.go — bounded LRU bucket store used by the in-process
// fixed-window rate limiters (auth bruteforce, tenant rate-limit,
// API-key rate-limit, public IP rate-limit) when no Redis store is
// configured. A configured store's runtime failure fails closed; it does not
// silently downgrade to the local fallback.
//
// Why bounded:
//
//   Prior to this change every limiter held a map[string]*bucket that
//   grew without bound. An attacker rotating IPs (X-Forwarded-For,
//   tenant ids, key ids) could push the process to OOM. The GC pass
//   in each limiter was lazy and only dropped expired entries; the
//   working set could still pin all "recently-seen" identities in
//   memory.
//
// What this gives us:
//
//   * Fixed N=10_000 entry cap by default (configurable).
//   * O(1) get/put with container/list (front = most recent).
//   * Lazy TTL: entries that age past the configured TTL (~30 days
//     default for auth IPs, shorter for the high-volume limiters) get
//     evicted on the next touch. Worst case we hold N entries, never
//     more.
//   * Single-flight on the hot path so a thundering herd of N requests
//     for the same key doesn't all race the LRU lock — the first
//     reserves, the rest read the result.
//   * Prometheus eviction counter so operators see when the LRU starts
//     to spill (signal that the limiter is undersized and needs Redis
//     or a bigger cap).
//
// Scope: in-process only. When REDIS_URL is set the limiters route
// to the existing RedisFixedWindowStore and this LRU is unused. The
// fallback metric (rate_limit_redis_fallback_total) lets ops detect
// when a deployment was intentionally constructed without shared storage.

package middleware

import (
	"container/list"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"golang.org/x/sync/singleflight"
)

// Defaults for the bounded LRU. Sized to ~1MB at steady state for
// every limiter — comfortably below the per-pod memory budget.
const (
	// DefaultLRUCapacity caps each limiter's working set. At 10k
	// entries × ~80 bytes/bucket × 4 limiters ≈ 3.2 MiB resident.
	DefaultLRUCapacity = 10_000
	// DefaultLRUTTL applies when the limiter doesn't request a
	// shorter one. 30 days matches the longest-lived cooldown we
	// care about (auth bruteforce); shorter-window limiters
	// override via NewBoundedBuckets.
	DefaultLRUTTL = 30 * 24 * time.Hour
)

// boundedBucketsEvictions counts entries dropped because the LRU hit
// its capacity (signal: limiter undersized OR attacker spraying).
var boundedBucketsEvictions = promauto.NewCounterVec(
	prometheus.CounterOpts{
		Name: "rate_limit_lru_evictions_total",
		Help: "Bucket entries evicted from the bounded-LRU rate-limit store, partitioned by limiter name. A sustained non-zero rate means the limiter is either undersized or under spray attack.",
	},
	[]string{"limiter"},
)

// boundedBucketsTTLExpired counts entries dropped because they aged
// past TTL (the GC path, distinct from capacity eviction).
var boundedBucketsTTLExpired = promauto.NewCounterVec(
	prometheus.CounterOpts{
		Name: "rate_limit_lru_ttl_expired_total",
		Help: "Bucket entries dropped by the bounded-LRU TTL sweep, partitioned by limiter name.",
	},
	[]string{"limiter"},
)

// redisFallbackTotal counts requests that routed through the
// in-process LRU because REDIS_URL was unset OR the Redis store was
// nil at construction time. Mounted at limiter-construction so the
// signal stays per-limiter; per-request fallback (Redis-down at call
// time) surfaces as the existing rate_limit_unavailable 503 path.
var redisFallbackTotal = promauto.NewCounterVec(
	prometheus.CounterOpts{
		Name: "rate_limit_redis_fallback_total",
		Help: "Rate-limiter constructed without a Redis store and falling back to per-replica bounded LRU enforcement. Incremented once per limiter at construction; the value should match the number of limiter instances when REDIS_URL is unset.",
	},
	[]string{"limiter"},
)

// BoundedBuckets is a fixed-capacity LRU bucket store with TTL
// eviction. T is the bucket payload type — keep it small and
// reset-friendly (e.g. *bucket, *authBucket, *kBucket).
//
// Concurrency: all public methods take the mutex. The singleflight
// group dedupes per-key Get-or-Create races so a hot key with N
// parallel requests does one map operation, not N.
type BoundedBuckets[T any] struct {
	name     string
	capacity int
	ttl      time.Duration

	mu    sync.Mutex
	ll    *list.List
	index map[string]*list.Element

	sf singleflight.Group
}

type lruEntry[T any] struct {
	key      string
	value    T
	insertAt time.Time
	// mu serialises caller fn invocations targeting THIS bucket only.
	// It is NEVER held while we touch the parent BoundedBuckets.mu
	// (list/index) — the rule is: take global mu briefly to look up
	// the entry, capture entry.mu, release global mu, then take
	// entry.mu around the user fn. This keeps a slow fn from
	// serialising every other key's reservations on the global lock.
	mu sync.Mutex
}

// NewBoundedBuckets constructs a bounded LRU. name labels the
// prometheus metrics. capacity<=0 falls back to DefaultLRUCapacity;
// ttl<=0 falls back to DefaultLRUTTL.
//
// Note: incrementing the redis-fallback counter is the caller's job
// at construction (so the metric reflects "limiter created without
// Redis" rather than "LRU touched"). Callers should call
// MarkRedisFallback(name) when they fall back.
func NewBoundedBuckets[T any](name string, capacity int, ttl time.Duration) *BoundedBuckets[T] {
	if capacity <= 0 {
		capacity = DefaultLRUCapacity
	}
	if ttl <= 0 {
		ttl = DefaultLRUTTL
	}
	return &BoundedBuckets[T]{
		name:     name,
		capacity: capacity,
		ttl:      ttl,
		ll:       list.New(),
		index:    make(map[string]*list.Element, capacity),
	}
}

// MarkRedisFallback bumps the redis-fallback metric for limiter name.
// Call once at construction when a Redis store was expected but not
// provided.
func MarkRedisFallback(limiterName string) {
	redisFallbackTotal.WithLabelValues(limiterName).Inc()
}

// GetOrCreate returns the bucket for key. If absent, factory is
// invoked under singleflight to construct one. The bucket is moved
// to the front (most-recently-used). When the LRU exceeds capacity
// the oldest entry is evicted; the eviction counter is bumped.
//
// touch indicates whether the caller wants the LRU position bumped
// even on a hit (every Reserve call should bump; cleanup/peek
// shouldn't).
func (b *BoundedBuckets[T]) GetOrCreate(key string, now time.Time, factory func() T) (T, bool) {
	// Fast path: try to read without the singleflight overhead.
	b.mu.Lock()
	if el, ok := b.index[key]; ok {
		ent := el.Value.(*lruEntry[T])
		// TTL check on read — if expired drop and fall through to
		// the factory path. This is the lazy GC.
		if now.Sub(ent.insertAt) > b.ttl {
			b.ll.Remove(el)
			delete(b.index, key)
			boundedBucketsTTLExpired.WithLabelValues(b.name).Inc()
		} else {
			b.ll.MoveToFront(el)
			b.mu.Unlock()
			return ent.value, true
		}
	}
	b.mu.Unlock()

	// Slow path under singleflight so a thundering herd doesn't
	// race the factory N times.
	v, _, _ := b.sf.Do(key, func() (any, error) {
		b.mu.Lock()
		defer b.mu.Unlock()
		// Re-check after acquiring the lock — another goroutine in
		// the same singleflight call group may have raced past us.
		if el, ok := b.index[key]; ok {
			ent := el.Value.(*lruEntry[T])
			if now.Sub(ent.insertAt) <= b.ttl {
				b.ll.MoveToFront(el)
				return ent.value, nil
			}
			// Expired — drop and fall through to recreate.
			b.ll.Remove(el)
			delete(b.index, key)
			boundedBucketsTTLExpired.WithLabelValues(b.name).Inc()
		}
		val := factory()
		ent := &lruEntry[T]{key: key, value: val, insertAt: now}
		el := b.ll.PushFront(ent)
		b.index[key] = el
		// Evict oldest while over capacity.
		for b.ll.Len() > b.capacity {
			oldest := b.ll.Back()
			if oldest == nil {
				break
			}
			oldEnt := oldest.Value.(*lruEntry[T])
			b.ll.Remove(oldest)
			delete(b.index, oldEnt.key)
			boundedBucketsEvictions.WithLabelValues(b.name).Inc()
		}
		return val, nil
	})
	if v == nil {
		var zero T
		return zero, false
	}
	return v.(T), false
}

// Update applies fn to the bucket for key and returns fn's result.
// If the key isn't present fn is called with the zero value of T and
// its result is stored as a new entry.
//
// Concurrency model (the contract every caller relies on):
//
//   - The global BoundedBuckets.mu is held ONLY for the O(1) list/map
//     work: find-or-create the entry, move-to-front, evict-on-overflow,
//     TTL drop. It is released BEFORE fn runs.
//   - fn runs under the entry's per-bucket mutex (lruEntry.mu). That
//     means concurrent Update calls for different keys do not contend
//     on a single lock — they only contend on the brief global
//     critical section. Concurrent Update calls for the SAME key are
//     still serialised through the per-entry mutex so read-modify-write
//     loops inside fn (e.g. "increment window counter") are safe.
//   - If a concurrent eviction drops the entry while fn is running, the
//     write-back simply repopulates the entry under a fresh global-lock
//     critical section (re-pushed to front, capacity respected).
//
// Why this matters: a 10k-key BoundedBuckets in front of a contended
// rate limiter would otherwise serialise EVERY tenant's reservation on
// one global mutex, even though each tenant's fn only touches its own
// counter. The new pattern moves that serialisation per-key, matching
// the granularity callers actually need.
func (b *BoundedBuckets[T]) Update(key string, now time.Time, fn func(existing T, hit bool) T) T {
	// --- Phase 1: find or create entry under the global mutex ---
	b.mu.Lock()
	var (
		ent *lruEntry[T]
		hit bool
	)
	if el, ok := b.index[key]; ok {
		candidate := el.Value.(*lruEntry[T])
		if now.Sub(candidate.insertAt) > b.ttl {
			b.ll.Remove(el)
			delete(b.index, key)
			boundedBucketsTTLExpired.WithLabelValues(b.name).Inc()
		} else {
			ent = candidate
			hit = true
			b.ll.MoveToFront(el)
		}
	}
	if ent == nil {
		var zero T
		ent = &lruEntry[T]{key: key, value: zero, insertAt: now}
		el := b.ll.PushFront(ent)
		b.index[key] = el
		for b.ll.Len() > b.capacity {
			oldest := b.ll.Back()
			if oldest == nil {
				break
			}
			oldEnt := oldest.Value.(*lruEntry[T])
			b.ll.Remove(oldest)
			delete(b.index, oldEnt.key)
			boundedBucketsEvictions.WithLabelValues(b.name).Inc()
		}
	}
	b.mu.Unlock()

	// --- Phase 2: run fn under the per-entry mutex ONLY ---
	// The global LRU mutex is no longer held, so concurrent Update
	// calls for other keys can proceed without blocking on a slow fn.
	ent.mu.Lock()
	existing := ent.value
	newVal := fn(existing, hit)
	ent.value = newVal
	ent.mu.Unlock()
	return newVal
}

// Delete removes the entry for key. No-op if absent.
func (b *BoundedBuckets[T]) Delete(key string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if el, ok := b.index[key]; ok {
		b.ll.Remove(el)
		delete(b.index, key)
	}
}

// Len returns the current entry count. For tests / metrics.
func (b *BoundedBuckets[T]) Len() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.ll.Len()
}

// Capacity returns the configured max entry count.
func (b *BoundedBuckets[T]) Capacity() int { return b.capacity }
