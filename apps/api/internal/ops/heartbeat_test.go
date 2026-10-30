// SPDX-License-Identifier: AGPL-3.0-only

package ops

import (
	"context"
	"errors"
	"testing"
	"time"
)

type beatSink struct {
	beats  []time.Time
	err    error
	calls  int
	lastID string
}

func (r *beatSink) beat(_ context.Context, id string, at time.Time) error {
	r.calls++
	r.lastID = id
	if r.err != nil {
		return r.err
	}
	r.beats = append(r.beats, at)
	return nil
}

// A worker loop can iterate thousands of times a minute. Writing to Postgres on
// every iteration would make the monitoring more expensive than the work, so
// beats are coalesced -- but never so much that the freshness budget is missed.
func TestHeartbeat_CoalescesWritesWithinTheBudget(t *testing.T) {
	sink := &beatSink{}
	now := time.Now()
	hb := newHeartbeat("worker.x", time.Minute, sink.beat)
	hb.now = func() time.Time { return now }

	hb.Beat(context.Background())
	for i := 0; i < 1000; i++ {
		hb.Beat(context.Background())
	}
	if sink.calls != 1 {
		t.Fatalf("a thousand loop iterations inside one window must write once, got %d", sink.calls)
	}

	// Half the interval is the write cadence: it guarantees two writes inside
	// the 2*Interval staleness budget, so a single failed write cannot make a
	// healthy worker look dead.
	now = now.Add(31 * time.Second)
	hb.Beat(context.Background())
	if sink.calls != 2 {
		t.Fatalf("past half the interval the beat must be written, got %d calls", sink.calls)
	}
}

// A failed write must not advance the coalescing clock, or one transient DB
// blip suppresses beats for the rest of the window and the worker reads dead.
func TestHeartbeat_FailedWriteIsRetriedOnTheNextBeat(t *testing.T) {
	sink := &beatSink{err: errors.New("db down")}
	now := time.Now()
	hb := newHeartbeat("worker.x", time.Minute, sink.beat)
	hb.now = func() time.Time { return now }

	hb.Beat(context.Background())
	if sink.calls != 1 {
		t.Fatalf("first beat must attempt a write, got %d", sink.calls)
	}
	hb.Beat(context.Background())
	if sink.calls != 2 {
		t.Fatalf("after a failed write the next beat must retry rather than wait out the window, got %d", sink.calls)
	}

	sink.err = nil
	hb.Beat(context.Background())
	if sink.calls != 3 || len(sink.beats) != 1 {
		t.Fatalf("the retry must land, got calls=%d writes=%d", sink.calls, len(sink.beats))
	}
	// And once it lands, coalescing resumes.
	hb.Beat(context.Background())
	if sink.calls != 3 {
		t.Fatalf("after a successful write the window applies again, got %d", sink.calls)
	}
}

// A nil Heartbeat is the "not wired up" case. It must be a silent no-op rather
// than a panic: monitoring must never be able to crash the worker it watches.
func TestHeartbeat_NilIsSafe(t *testing.T) {
	var hb *Heartbeat
	hb.Beat(context.Background()) // must not panic
}

func TestHeartbeat_BeatsUnderTheCheckID(t *testing.T) {
	sink := &beatSink{}
	hb := newHeartbeat("queues.outbox-worker", time.Minute, sink.beat)
	hb.Beat(context.Background())
	if sink.lastID != "queues.outbox-worker" {
		t.Fatalf("the beat must be written under the check ID, got %q", sink.lastID)
	}
}
