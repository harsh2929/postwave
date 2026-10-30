// SPDX-License-Identifier: AGPL-3.0-only
package assets

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

type fakeLister struct{ called int32 }

func (f *fakeLister) ActiveTenantIDs(ctx context.Context) ([]string, error) {
	atomic.AddInt32(&f.called, 1)
	return nil, nil // empty tenant set — RecomputeAll is never invoked
}

func TestRefresherTicksOnIntervalAndStopsOnCancel(t *testing.T) {
	lister := &fakeLister{}
	rf := &Refresher{Repo: &Repo{}, Tenants: lister, Interval: 20 * time.Millisecond}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { rf.Run(ctx); close(done) }()
	time.Sleep(80 * time.Millisecond) // 1 immediate + ~3 ticks
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("refresher did not exit on ctx cancel")
	}
	if n := atomic.LoadInt32(&lister.called); n < 3 {
		t.Fatalf("expected >= 3 ticks (immediate + several), got %d", n)
	}
}

func TestRefresherNoopWithoutRepoOrTenants(t *testing.T) {
	// Defensive: a misconfigured Refresher should never panic. It just
	// ticks silently and exits when cancelled.
	rf := &Refresher{Interval: 20 * time.Millisecond}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { rf.Run(ctx); close(done) }()
	time.Sleep(40 * time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("refresher with no deps did not exit on ctx cancel")
	}
}
