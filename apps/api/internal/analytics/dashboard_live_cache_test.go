// SPDX-License-Identifier: AGPL-3.0-only

package analytics

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// TestDashboardLiveCache_SingleflightCollapsesHerd asserts that N
// concurrent calls for the same tenant produce exactly one loader
// invocation — the whole point of the cache layer.
func TestDashboardLiveCache_SingleflightCollapsesHerd(t *testing.T) {
	c := newDashboardLiveCache()

	var loaderCalls uint64
	// Block the loader briefly so all concurrent waiters pile up
	// inside the singleflight's Do() call. Without the sleep the
	// first goroutine could finish and cache the result before the
	// others even reach GetOrCreate, making the test prove nothing.
	loader := func(ctx context.Context, tenantID string) (*DashboardStats, error) {
		atomic.AddUint64(&loaderCalls, 1)
		time.Sleep(20 * time.Millisecond)
		return &DashboardStats{SubscribersTotal: 42}, nil
	}

	const N = 50
	var wg sync.WaitGroup
	wg.Add(N)
	for i := 0; i < N; i++ {
		go func() {
			defer wg.Done()
			stats, err := c.fetch(context.Background(), "tenant-A", loader)
			if err != nil {
				t.Errorf("fetch: %v", err)
				return
			}
			if stats.SubscribersTotal != 42 {
				t.Errorf("stats = %+v, want 42", stats)
			}
		}()
	}
	wg.Wait()

	if got := atomic.LoadUint64(&loaderCalls); got != 1 {
		t.Fatalf("loader called %d times, want exactly 1 (singleflight collapse failed)", got)
	}
}

// TestDashboardLiveCache_TTLExpiresAndRefetches asserts that after the
// 2s TTL elapses the next fetch triggers a fresh loader call. This
// guards against accidentally caching results forever — the whole
// point of the live SSE stream is that data updates.
func TestDashboardLiveCache_TTLExpiresAndRefetches(t *testing.T) {
	c := newDashboardLiveCache()

	var calls uint64
	loader := func(ctx context.Context, tenantID string) (*DashboardStats, error) {
		n := atomic.AddUint64(&calls, 1)
		return &DashboardStats{SubscribersTotal: int(n)}, nil
	}

	// First call: miss, loader runs.
	s1, err := c.fetch(context.Background(), "tenant-B", loader)
	if err != nil {
		t.Fatalf("fetch 1: %v", err)
	}
	if s1.SubscribersTotal != 1 {
		t.Fatalf("first fetch = %d, want 1", s1.SubscribersTotal)
	}

	// Immediate second call: hit, loader does NOT run.
	s2, err := c.fetch(context.Background(), "tenant-B", loader)
	if err != nil {
		t.Fatalf("fetch 2: %v", err)
	}
	if s2.SubscribersTotal != 1 {
		t.Fatalf("cached fetch = %d, want 1 (cache miss?)", s2.SubscribersTotal)
	}

	// Wait past TTL, then call again: miss, loader runs again.
	time.Sleep(dashboardLiveCacheTTL + 50*time.Millisecond)
	s3, err := c.fetch(context.Background(), "tenant-B", loader)
	if err != nil {
		t.Fatalf("fetch 3: %v", err)
	}
	if s3.SubscribersTotal != 2 {
		t.Fatalf("post-TTL fetch = %d, want 2 (TTL didn't expire?)", s3.SubscribersTotal)
	}
}

// TestDashboardLiveCache_LoaderErrorDoesntPoisonCache asserts that
// when the loader fails we don't cache the failure for the full TTL.
// Otherwise a transient DB blip would force every SSE connection to
// wait 2s before re-trying.
func TestDashboardLiveCache_LoaderErrorDoesntPoisonCache(t *testing.T) {
	c := newDashboardLiveCache()

	var calls uint64
	loader := func(ctx context.Context, tenantID string) (*DashboardStats, error) {
		n := atomic.AddUint64(&calls, 1)
		if n == 1 {
			return nil, errors.New("transient db error")
		}
		return &DashboardStats{SubscribersTotal: 99}, nil
	}

	// First call fails.
	_, err := c.fetch(context.Background(), "tenant-C", loader)
	if err == nil {
		t.Fatalf("expected error from loader")
	}

	// Second call should NOT see the cached error; it should re-load.
	s, err := c.fetch(context.Background(), "tenant-C", loader)
	if err != nil {
		t.Fatalf("second fetch: %v", err)
	}
	if s.SubscribersTotal != 99 {
		t.Fatalf("stats = %+v, want 99 (failure was cached?)", s)
	}
	if got := atomic.LoadUint64(&calls); got != 2 {
		t.Fatalf("loader calls = %d, want 2", got)
	}
}

// TestDashboardLiveCache_PerTenantIsolation asserts the cache keys by
// tenant — two different tenants get two different cached payloads,
// not a single shared one.
func TestDashboardLiveCache_PerTenantIsolation(t *testing.T) {
	c := newDashboardLiveCache()

	loader := func(ctx context.Context, tenantID string) (*DashboardStats, error) {
		// Encode tenant id into payload so we can detect cross-tenant bleed.
		v := 0
		for _, b := range tenantID {
			v += int(b)
		}
		return &DashboardStats{SubscribersTotal: v}, nil
	}

	sA, err := c.fetch(context.Background(), "tenant-A", loader)
	if err != nil {
		t.Fatalf("fetch A: %v", err)
	}
	sB, err := c.fetch(context.Background(), "tenant-B", loader)
	if err != nil {
		t.Fatalf("fetch B: %v", err)
	}
	if sA.SubscribersTotal == sB.SubscribersTotal {
		t.Fatalf("tenants A and B got identical stats (key collision)")
	}

	// Re-fetch A; should hit cache (same value, not B's value).
	sA2, err := c.fetch(context.Background(), "tenant-A", loader)
	if err != nil {
		t.Fatalf("fetch A again: %v", err)
	}
	if sA2.SubscribersTotal != sA.SubscribersTotal {
		t.Fatalf("tenant A second fetch = %d, want %d", sA2.SubscribersTotal, sA.SubscribersTotal)
	}
}
