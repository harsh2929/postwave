// SPDX-License-Identifier: AGPL-3.0-only
//
// lru_bucket_test.go — covers
//
//   1. Bounded LRU correctness: eviction, TTL, MRU-on-touch.
//   2. Per-limiter integration: that the unbounded map → LRU swap
//      doesn't regress the existing limiter math (counts, lockouts).
//   3. Multi-replica enforcement: simulates 4 replicas sharing a
//      single FixedWindowStore and asserts the limit is enforced
//      ACROSS the fleet (not just per-replica). This is the
//      regression guard for p1-ratelimit-lru's "Redis fallback works"
//      claim. Uses an in-memory atomic counter implementation that
//      models Redis INCR+EXPIRE semantics so the test runs hermetic
//      (no docker).

package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// memFixedWindowStore is a hermetic stand-in for RedisFixedWindowStore.
// It mirrors Redis INCR+EXPIRE: counters live shared across all
// callers, and Reserve atomically increments + reads.
//
// The TTL is honoured lazily — Reserve drops any counter whose
// installedAt is older than its window before incrementing. This
// matches what Redis does (lazy expiration on next touch + active
// expiration on a timer; the lazy half is sufficient for tests).
type memFixedWindowStore struct {
	mu       sync.Mutex
	counters map[string]*memCounter
	calls    atomic.Int64 // for "did all replicas hit the store?" assertions
}

type memCounter struct {
	value     int
	installed time.Time
	window    time.Duration
}

func newMemFixedWindowStore() *memFixedWindowStore {
	return &memFixedWindowStore{counters: map[string]*memCounter{}}
}

func (s *memFixedWindowStore) Reserve(_ context.Context, key string, limit int, window time.Duration, now time.Time) (int, time.Time, error) {
	s.calls.Add(1)
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.counters[key]
	if !ok || now.Sub(c.installed) > window {
		c = &memCounter{installed: now, window: window}
		s.counters[key] = c
	}
	c.value++
	return c.value, c.installed.Add(c.window), nil
}

// ---------------------------------------------------------------
// 1. Bounded LRU correctness.
// ---------------------------------------------------------------

func TestBoundedBuckets_EvictsWhenOverCapacity(t *testing.T) {
	b := NewBoundedBuckets[*bucket]("test_evict", 3, time.Hour)
	now := time.Now()
	for i := 0; i < 5; i++ {
		b.Update(strconv.Itoa(i), now, func(existing *bucket, hit bool) *bucket {
			return &bucket{count: 1, reset: now.Add(time.Minute)}
		})
	}
	if got := b.Len(); got != 3 {
		t.Fatalf("len = %d, want 3 (evictions should cap at capacity)", got)
	}
	// Oldest two ("0", "1") should be evicted.
	for _, k := range []string{"0", "1"} {
		hit := false
		b.Update(k, now, func(existing *bucket, h bool) *bucket {
			hit = h
			return &bucket{count: 1, reset: now.Add(time.Minute)}
		})
		if hit {
			t.Errorf("key %q should have been evicted, but it was still in the LRU", k)
		}
	}
}

func TestBoundedBuckets_TTLExpires(t *testing.T) {
	b := NewBoundedBuckets[*bucket]("test_ttl", 10, time.Second)
	now := time.Now()
	b.Update("k", now, func(existing *bucket, hit bool) *bucket {
		return &bucket{count: 1, reset: now}
	})
	// Past TTL: the next touch should rebuild the entry.
	future := now.Add(2 * time.Second)
	hit := true
	b.Update("k", future, func(existing *bucket, h bool) *bucket {
		hit = h
		return &bucket{count: 1, reset: future}
	})
	if hit {
		t.Fatalf("expected entry to have aged past TTL; hit=true")
	}
}

func TestBoundedBuckets_MovesToFrontOnHit(t *testing.T) {
	b := NewBoundedBuckets[*bucket]("test_mru", 3, time.Hour)
	now := time.Now()
	for _, k := range []string{"a", "b", "c"} {
		b.Update(k, now, func(existing *bucket, hit bool) *bucket {
			return &bucket{count: 1, reset: now}
		})
	}
	// Touch "a" so it becomes MRU; pushing "d" should evict "b", not "a".
	b.Update("a", now, func(existing *bucket, hit bool) *bucket {
		if existing == nil {
			t.Fatal("a should still be present")
		}
		return existing
	})
	b.Update("d", now, func(existing *bucket, hit bool) *bucket {
		return &bucket{count: 1, reset: now}
	})
	// "a" must still be present; "b" must be evicted.
	bHit := false
	b.Update("b", now, func(existing *bucket, hit bool) *bucket {
		bHit = hit
		return &bucket{count: 1, reset: now}
	})
	if bHit {
		t.Fatal("b should have been evicted because a got promoted on touch")
	}
}

// ---------------------------------------------------------------
// 2. Per-limiter integration: limits still enforced after LRU swap.
// ---------------------------------------------------------------

func TestRateLimit_LRUEnforcesLimit(t *testing.T) {
	rl := NewRateLimit(2, time.Minute)
	h := rl.Middleware(newOK())
	for i := 0; i < 2; i++ {
		w := httptest.NewRecorder()
		r := httptest.NewRequest("GET", "/x", nil)
		r.RemoteAddr = "10.1.1.1:5000"
		h.ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("req %d: status=%d want 200", i+1, w.Code)
		}
	}
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/x", nil)
	r.RemoteAddr = "10.1.1.1:5000"
	h.ServeHTTP(w, r)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("over-limit request should be 429, got %d", w.Code)
	}
}

func TestAuthBruteforceLimiter_LRUEnforcesLockout(t *testing.T) {
	limiter := NewAuthBruteforceLimiterWithOptions(AuthBruteforceOptions{
		MaxAttempts:   2,
		Window:        time.Minute,
		Cooldown:      time.Minute,
		LocalCapacity: 8,
	})
	h := limiter.Middleware(newOK())
	for i := 0; i < 2; i++ {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", nil)
		r.RemoteAddr = "10.1.1.1:5000"
		h.ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("request %d: status=%d want 200", i+1, w.Code)
		}
	}
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", nil)
	r.RemoteAddr = "10.1.1.1:5000"
	h.ServeHTTP(w, r)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("over-limit auth request status=%d want 429", w.Code)
	}
	if got := limiter.buckets.Len(); got != 1 {
		t.Fatalf("local auth bucket count=%d want 1", got)
	}
}

// ---------------------------------------------------------------
// 3. Multi-replica enforcement (the headline test for this card).
// ---------------------------------------------------------------

// TestKeyRateLimit_MultiReplicaSharesRedisCounter is the regression
// guard for the Redis-backed enforcement claim. It constructs 4
// KeyRateLimit instances (one per "replica"), all pointed at the same
// memFixedWindowStore (the stand-in for Redis). Each replica handles
// a slice of the load for the same API key. The combined request
// count should be bounded by the limit — NOT 4× the limit (which is
// what we'd get with per-replica enforcement).
func TestKeyRateLimit_MultiReplicaSharesRedisCounter(t *testing.T) {
	const (
		replicas = 4
		perMin   = 10
		burst    = 0
		// Each replica sends `perReplica` requests. Total = perReplica*replicas.
		// If multi-replica enforcement works, only `perMin` get 200; the
		// rest get 429. Per-replica enforcement would let `perMin` through
		// per replica → 4× the limit.
		perReplica = 5
	)
	store := newMemFixedWindowStore()
	limiters := make([]*KeyRateLimit, replicas)
	for i := range limiters {
		limiters[i] = NewKeyRateLimitWithOptions(
			func(context.Context, string) (int, int, int, error) { return perMin, 0, burst, nil },
			KeyRateLimitOptions{Store: store, Namespace: "multi-replica-test"},
		)
	}

	var (
		mu    sync.Mutex
		ok429 int
		ok200 int
		wg    sync.WaitGroup
		keyID = "key_multi_replica"
	)
	// Fan out requests across replicas concurrently.
	for replica := 0; replica < replicas; replica++ {
		rl := limiters[replica]
		h := rl.Middleware(newOK())
		for j := 0; j < perReplica; j++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				r := httptest.NewRequest("GET", "/x", nil)
				r = r.WithContext(WithAPIKeyID(r.Context(), keyID))
				w := httptest.NewRecorder()
				h.ServeHTTP(w, r)
				mu.Lock()
				switch w.Code {
				case http.StatusOK:
					ok200++
				case http.StatusTooManyRequests:
					ok429++
				}
				mu.Unlock()
			}()
		}
	}
	wg.Wait()

	total := replicas * perReplica
	if ok200+ok429 != total {
		t.Fatalf("response counts don't add up: 200=%d 429=%d total=%d", ok200, ok429, total)
	}
	// The store enforces the limit across all replicas. With perMin=10
	// and total=20, exactly 10 should pass and 10 should be blocked.
	if ok200 != perMin {
		t.Errorf("admitted count = %d, want exactly %d (the shared per-minute limit)", ok200, perMin)
	}
	if ok429 != total-perMin {
		t.Errorf("rejected count = %d, want %d", ok429, total-perMin)
	}
	// Sanity: every request consulted the shared store (no replica fell
	// through to its local LRU because Store was nil somehow).
	if got := store.calls.Load(); got != int64(total) {
		t.Errorf("store calls = %d, want %d (every replica's request should hit Redis)", got, total)
	}
}

// TestAuthBruteforceLimiter_MultiReplicaSharesRedisCounter is the
// sibling test for the auth-bruteforce limiter. The shared counter
// guarantees that an attacker spraying credentials across multiple
// load-balanced replicas still hits the per-IP budget within the
// configured window.
func TestAuthBruteforceLimiter_MultiReplicaSharesRedisCounter(t *testing.T) {
	const (
		replicas   = 4
		limit      = 10
		perReplica = 5
	)
	store := newMemFixedWindowStore()
	limiters := make([]*AuthBruteforceLimiter, replicas)
	for i := range limiters {
		limiters[i] = NewAuthBruteforceLimiterWithOptions(AuthBruteforceOptions{
			MaxAttempts: limit,
			Window:      time.Minute,
			Cooldown:    time.Minute,
			Store:       store,
			Namespace:   "auth-multi-replica-test",
		})
	}

	var (
		mu    sync.Mutex
		ok429 int
		ok200 int
		wg    sync.WaitGroup
	)
	for replica := 0; replica < replicas; replica++ {
		h := limiters[replica].Middleware(newOK())
		for j := 0; j < perReplica; j++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				r := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", nil)
				r.RemoteAddr = "10.2.2.2:5000"
				w := httptest.NewRecorder()
				h.ServeHTTP(w, r)
				mu.Lock()
				switch w.Code {
				case http.StatusOK:
					ok200++
				case http.StatusTooManyRequests:
					ok429++
				}
				mu.Unlock()
			}()
		}
	}
	wg.Wait()
	if ok200 != limit || ok429 != replicas*perReplica-limit {
		t.Fatalf("shared auth budget: 200=%d 429=%d want 200=%d 429=%d", ok200, ok429, limit, replicas*perReplica-limit)
	}
	if got := store.calls.Load(); got != replicas*perReplica {
		t.Fatalf("shared auth store calls=%d want %d", got, replicas*perReplica)
	}
}

// TestTenantRateLimit_MultiReplicaSharesRedisCounter is the third
// sibling — same shape, different limiter. Covers the new
// TenantRateLimit Store wiring added in this card.
func TestTenantRateLimit_MultiReplicaSharesRedisCounter(t *testing.T) {
	const (
		replicas   = 4
		limit      = 10
		perReplica = 5
	)
	store := newMemFixedWindowStore()
	limiters := make([]*TenantRateLimit, replicas)
	for i := range limiters {
		limiters[i] = NewTenantRateLimitWithOptions(limit, time.Minute, TenantRateLimitOptions{
			Store:     store,
			Namespace: "tenant-multi-replica-test",
		})
	}

	var (
		mu    sync.Mutex
		ok429 int
		ok200 int
		wg    sync.WaitGroup
	)
	for replica := 0; replica < replicas; replica++ {
		h := limiters[replica].Middleware(newOK())
		for j := 0; j < perReplica; j++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				r := httptest.NewRequest(http.MethodPost, "/api/v1/voice/generate", nil)
				r = r.WithContext(WithTenant(r.Context(), &Tenant{ID: "tenant-multi"}))
				w := httptest.NewRecorder()
				h.ServeHTTP(w, r)
				mu.Lock()
				switch w.Code {
				case http.StatusOK:
					ok200++
				case http.StatusTooManyRequests:
					ok429++
				}
				mu.Unlock()
			}()
		}
	}
	wg.Wait()
	if ok200 != limit || ok429 != replicas*perReplica-limit {
		t.Fatalf("shared tenant budget: 200=%d 429=%d want 200=%d 429=%d", ok200, ok429, limit, replicas*perReplica-limit)
	}
	if got := store.calls.Load(); got != replicas*perReplica {
		t.Fatalf("shared tenant store calls=%d want %d", got, replicas*perReplica)
	}
}

func TestTenantRateLimit_SharedStoreFailureFailsClosed(t *testing.T) {
	limiter := NewTenantRateLimitWithOptions(10, time.Minute, TenantRateLimitOptions{
		Store:     unavailableAuthRateLimitStore{},
		Namespace: "tenant-store-failure-test",
	})
	h := limiter.Middleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("downstream handler ran while tenant rate-limit store was unavailable")
	}))
	r := httptest.NewRequest(http.MethodPost, "/api/v1/voice/generate", nil)
	r = r.WithContext(WithTenant(r.Context(), &Tenant{ID: "tenant-store-failure"}))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d want 503", w.Code)
	}
	if !strings.Contains(w.Body.String(), "tenant_rate_limit_unavailable") {
		t.Fatalf("body=%q missing stable error code", w.Body.String())
	}
	if got := w.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control=%q want no-store", got)
	}
}
