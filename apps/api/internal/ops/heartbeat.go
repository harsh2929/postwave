// SPDX-License-Identifier: AGPL-3.0-only

// heartbeat.go — the "this loop is doing work" signal.
//
// ops.Fleet (fleet.go) answers "is this worker's goroutine alive". That is a
// real and complete fact, and it is not enough: a worker deadlocked on a lock,
// blocked on a connection that will never answer, or spinning on an error it
// cannot make progress past is still very much alive. It has simply stopped
// being useful, which is the failure customers actually notice.
//
// A Heartbeat is emitted from INSIDE a loop, after an iteration completes. It
// therefore claims something lifecycle cannot: work happened. Silence past the
// declared budget derives to stale and then red through Result.Effective, with
// no sweeper involved — the same read-time derivation the rest of the board
// rests on.
package ops

import (
	"context"
	"sync"
	"time"
)

// beatFunc persists one beat. Split out from Store so the coalescing logic is
// testable without a database.
type beatFunc func(ctx context.Context, checkID string, at time.Time) error

// Heartbeat coalesces beats from a hot loop into at most one write per half
// interval.
//
// Half, not whole: the staleness budget is 2*Interval, so writing every
// Interval/2 puts four beats inside the budget. A single failed write, or one
// slow iteration, then cannot make a healthy worker look dead — which matters
// because a false RED here is worse than no check at all. It would be
// investigated once, found to be nothing, and snoozed.
type Heartbeat struct {
	checkID string
	window  time.Duration
	write   beatFunc

	mu       sync.Mutex
	lastWrit time.Time
	now      func() time.Time
}

func newHeartbeat(checkID string, interval time.Duration, write beatFunc) *Heartbeat {
	return &Heartbeat{
		checkID: checkID,
		window:  interval / 2,
		write:   write,
		now:     func() time.Time { return time.Now().UTC() },
	}
}

// NewHeartbeat returns the beater for a KindHeartbeat check, writing through
// the ops store. interval must match the check's declared Interval.
func (s *Store) NewHeartbeat(checkID string, interval time.Duration) *Heartbeat {
	return newHeartbeat(checkID, interval, func(ctx context.Context, id string, at time.Time) error {
		return s.Beat(ctx, id, at)
	})
}

// Beat records that an iteration completed. Cheap enough for a hot loop: the
// common case is one mutex acquisition and a time comparison.
//
// A nil receiver is a no-op. Workers take their Heartbeat as an optional
// dependency, and a monitoring hook that panics the worker it monitors would
// be a strictly worse bug than the one it was added to catch.
func (h *Heartbeat) Beat(ctx context.Context) {
	if h == nil {
		return
	}
	h.mu.Lock()
	now := h.now()
	if !h.lastWrit.IsZero() && now.Sub(h.lastWrit) < h.window {
		h.mu.Unlock()
		return
	}
	h.mu.Unlock()

	// The clock only advances on a SUCCESSFUL write. A failed write that
	// advanced it would suppress every beat for the rest of the window, so one
	// transient database blip would present as a dead worker.
	if err := h.write(ctx, h.checkID, now); err != nil {
		return
	}
	h.mu.Lock()
	h.lastWrit = now
	h.mu.Unlock()
}
