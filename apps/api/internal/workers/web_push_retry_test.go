// SPDX-License-Identifier: AGPL-3.0-only

package workers

import (
	"context"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"
)

// The worker must actually sweep.
//
// A registration that compiles and never ticks leaves the delivery ledger
// exactly as it was — a table of failures nobody acts on. This drives the real
// start function rather than asserting the call exists in main.go.

type countingRetrier struct {
	calls atomic.Int32
	limit atomic.Int32
}

func (c *countingRetrier) RetryDue(_ context.Context, _ time.Time, limit int) (int, int, error) {
	c.calls.Add(1)
	c.limit.Store(int32(limit))
	return 0, 0, nil
}

func TestTheRetryWorkerSweepsImmediatelyOnStart(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r := &countingRetrier{}
	StartWebPushRetryWorker(ctx, r, slog.Default())

	// The first sweep runs before the first tick: a worker that waited a full
	// interval would leave everything that failed during a restart sitting
	// undelivered for that long, for no reason.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && r.calls.Load() == 0 {
		time.Sleep(10 * time.Millisecond)
	}
	if r.calls.Load() == 0 {
		t.Fatal("the worker never swept; the delivery ledger is recorded and " +
			"never acted on")
	}
	if got := r.limit.Load(); got != webPushRetryBatch {
		t.Errorf("sweep limit = %d, want %d — an unbounded sweep re-sends a whole "+
			"outage's backlog in one burst", got, webPushRetryBatch)
	}
}

func TestTheRetryWorkerStopsWithItsContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	r := &countingRetrier{}
	StartWebPushRetryWorker(ctx, r, slog.Default())
	for i := 0; i < 200 && r.calls.Load() == 0; i++ {
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	settled := r.calls.Load()
	time.Sleep(50 * time.Millisecond)
	if after := r.calls.Load(); after > settled+1 {
		t.Fatalf("the worker kept sweeping after cancellation (%d -> %d); shutdown "+
			"would hang on it", settled, after)
	}
}

// nil no-ops, matching the notification stack's convention that a deployment
// without web push still runs.
func TestANilRetrierDoesNotPanic(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	StartWebPushRetryWorker(ctx, nil, slog.Default())
}

// The sweep interval must not be longer than the shortest backoff the sender
// schedules, or the first retry waits for the sweep instead of the backoff.
func TestTheSweepIsAtLeastAsFrequentAsTheShortestBackoff(t *testing.T) {
	const shortestSenderBackoff = time.Minute
	if webPushRetryInterval > shortestSenderBackoff {
		t.Fatalf("sweep interval %v exceeds the sender's shortest backoff %v; the "+
			"first retry would be delayed by the sweep rather than the backoff",
			webPushRetryInterval, shortestSenderBackoff)
	}
}
