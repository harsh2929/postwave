// SPDX-License-Identifier: AGPL-3.0-only
package apikeys

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func newTestLRU() *middleware.BoundedBuckets[*cachedAuth] {
	return middleware.NewBoundedBuckets[*cachedAuth]("apikey_auth_test", 16, time.Minute)
}

// fakeResolver tracks LookupByHash + TouchLastUsed call counts so the
// cache tests can assert "1 cold miss + N hits + 0 extra DB reads".
type fakeResolver struct {
	lookups int64
	touches int64

	mu   sync.Mutex
	keys map[string]*APIKey
}

func (f *fakeResolver) HashKey(plaintext string) string { return plaintext }

func (f *fakeResolver) LookupByHash(_ context.Context, hash string) (*APIKey, error) {
	atomic.AddInt64(&f.lookups, 1)
	f.mu.Lock()
	defer f.mu.Unlock()
	k, ok := f.keys[hash]
	if !ok {
		return nil, ErrInvalidKey
	}
	return k, nil
}

func (f *fakeResolver) TouchLastUsed(_ context.Context, _ string) error {
	atomic.AddInt64(&f.touches, 1)
	return nil
}

func TestAuthCacheTouchBatching(t *testing.T) {
	// Cache with a tight flush interval so the test doesn't wait
	// long, and no real Postgres so we exercise only the touch
	// buffer + flusher path.
	fake := &fakeResolver{keys: map[string]*APIKey{}}
	cache := &AuthCache{
		resolver:     fake,
		touchPending: make(map[string]struct{}, 16),
		flushEvery:   25 * time.Millisecond,
		stopCh:       make(chan struct{}),
	}
	go cache.touchLoop()
	defer cache.Close()

	// 50 touches for 3 distinct ids: the flusher should issue
	// ≤3 underlying TouchLastUsed calls per flush (one per unique
	// id), not 50.
	for i := 0; i < 50; i++ {
		_ = cache.TouchLastUsed(context.Background(), "key-a")
		_ = cache.TouchLastUsed(context.Background(), "key-b")
		_ = cache.TouchLastUsed(context.Background(), "key-c")
	}
	// Wait long enough for one flush tick to drain.
	time.Sleep(100 * time.Millisecond)

	got := atomic.LoadInt64(&fake.touches)
	if got < 1 || got > 3 {
		t.Fatalf("expected 1-3 touches after coalescing, got %d", got)
	}
}

func TestAuthCacheDropsWhenBufferFull(t *testing.T) {
	fake := &fakeResolver{keys: map[string]*APIKey{}}
	cache := &AuthCache{
		resolver:     fake,
		touchPending: make(map[string]struct{}, 1),
		// Never flushes during the test.
		flushEvery: 10 * time.Minute,
		stopCh:     make(chan struct{}),
	}
	// Don't start the touchLoop — we want to verify the buffer cap
	// drop path without races.
	// Fill the buffer past cap; surplus ids must drop silently.
	for i := 0; i < touchBufferCap+10; i++ {
		_ = cache.TouchLastUsed(context.Background(), idFor(i))
	}
	cache.touchMu.Lock()
	count := len(cache.touchPending)
	cache.touchMu.Unlock()
	if count > touchBufferCap {
		t.Fatalf("touchPending grew past cap: got %d want ≤%d", count, touchBufferCap)
	}
}

func TestAuthCacheLookupByHashErrorPassthrough(t *testing.T) {
	fake := &fakeResolver{keys: map[string]*APIKey{}}
	cache := &AuthCache{
		resolver:     fake,
		ttl:          1 * time.Second,
		cap:          16,
		touchPending: map[string]struct{}{},
		flushEvery:   1 * time.Minute,
		stopCh:       make(chan struct{}),
	}
	// Defer LRU setup via a real NewBoundedBuckets equivalent so peek/store work.
	cache.lru = newTestLRU()
	_, _, err := cache.ResolveAuth(context.Background(), "unknown-hash")
	if !errors.Is(err, ErrInvalidKey) {
		t.Fatalf("expected ErrInvalidKey for missing hash, got %v", err)
	}
}

func idFor(i int) string {
	// Distinct ids for the cap-drop test.
	return "id-" + string(rune('a'+(i%26))) + "-" + itoa(i)
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b [20]byte
	n := len(b)
	neg := i < 0
	if neg {
		i = -i
	}
	for i > 0 {
		n--
		b[n] = byte('0' + i%10)
		i /= 10
	}
	if neg {
		n--
		b[n] = '-'
	}
	return string(b[n:])
}
