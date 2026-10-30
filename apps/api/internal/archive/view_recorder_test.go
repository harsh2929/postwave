// SPDX-License-Identifier: AGPL-3.0-only
//
// view_recorder_test.go — unit coverage for the async write-behind
// view recorder. Uses an in-memory stub sink so tests don't touch
// the real Pool; the prod sink is *Repo and is exercised by the
// integration test that hits the live pixel endpoint.

package archive

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// stubSink is an in-memory viewRecordSink. Records every call + can be
// configured to fail the first N calls per (tenant, campaign) pair to
// exercise the retry path.
type stubSink struct {
	mu        sync.Mutex
	calls     []viewEvent
	failFirst int           // fail the first N calls regardless of input
	failErr   error         // error to return when failing
	delay     time.Duration // optional artificial latency
}

func (s *stubSink) RecordView(_ context.Context, tenantID, campaignID, visitorID, referrer, country string, bot bool) error {
	s.mu.Lock()
	s.calls = append(s.calls, viewEvent{tenantID, campaignID, visitorID, referrer, country, bot})
	failing := s.failFirst > 0
	if failing {
		s.failFirst--
	}
	s.mu.Unlock()
	if s.delay > 0 {
		time.Sleep(s.delay)
	}
	if failing {
		if s.failErr != nil {
			return s.failErr
		}
		return errors.New("stub: transient")
	}
	return nil
}

func (s *stubSink) callCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.calls)
}

// waitFor polls until the predicate is true or the deadline expires.
// Returns false on timeout so the test can fail with a useful message.
func waitFor(d time.Duration, p func() bool) bool {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if p() {
			return true
		}
		time.Sleep(2 * time.Millisecond)
	}
	return p()
}

func TestViewRecorder_HappyPath(t *testing.T) {
	sink := &stubSink{}
	rec := NewViewRecorder(sink, nil)
	defer rec.Close()

	for i := 0; i < 10; i++ {
		if !rec.Enqueue("t1", "c1", "v"+string(rune('0'+i)), "", "US", false) {
			t.Fatalf("enqueue %d should succeed", i)
		}
	}

	if !waitFor(2*time.Second, func() bool { return sink.callCount() == 10 }) {
		t.Fatalf("expected 10 calls, got %d", sink.callCount())
	}
}

func TestViewRecorder_RetriesTransient(t *testing.T) {
	sink := &stubSink{failFirst: 2}
	// Pin retry timing tight for the test.
	oldBase := ViewRecorderBaseBackoff
	ViewRecorderBaseBackoff = 5 * time.Millisecond
	defer func() { ViewRecorderBaseBackoff = oldBase }()

	rec := NewViewRecorder(sink, nil)
	defer rec.Close()

	if !rec.Enqueue("t1", "c1", "v1", "", "US", false) {
		t.Fatalf("enqueue should succeed")
	}

	// 1 initial + 2 retries = 3 calls; the third succeeds.
	if !waitFor(2*time.Second, func() bool { return sink.callCount() >= 3 }) {
		t.Fatalf("expected at least 3 attempts, got %d", sink.callCount())
	}
}

func TestViewRecorder_DropsWhenBufferFull(t *testing.T) {
	// Tiny buffer, single worker blocked by sink latency so we
	// deterministically hit the full-buffer case.
	oldBuf, oldWorkers := ViewRecorderBufferSize, ViewRecorderWorkers
	ViewRecorderBufferSize = 2
	ViewRecorderWorkers = 1
	defer func() {
		ViewRecorderBufferSize = oldBuf
		ViewRecorderWorkers = oldWorkers
	}()

	sink := &stubSink{delay: 200 * time.Millisecond}
	rec := NewViewRecorder(sink, nil)
	defer rec.Close()

	// Fire a burst that exceeds buffer+worker capacity. Expect some
	// drops (Enqueue returns false).
	var drops atomic.Int32
	for i := 0; i < 50; i++ {
		if !rec.Enqueue("t1", "c1", "v", "", "US", false) {
			drops.Add(1)
		}
	}

	if drops.Load() == 0 {
		t.Fatalf("expected some Enqueue drops under buffer pressure, got 0")
	}
}

func TestViewRecorder_CloseDrains(t *testing.T) {
	sink := &stubSink{}
	rec := NewViewRecorder(sink, nil)

	const n = 25
	for i := 0; i < n; i++ {
		rec.Enqueue("t1", "c1", "v", "", "US", false)
	}
	rec.Close() // should block until drained (or shutdown timeout)

	if got := sink.callCount(); got != n {
		t.Fatalf("expected %d calls after Close, got %d", n, got)
	}
}

func TestViewRecorder_NilSafe(t *testing.T) {
	var rec *ViewRecorder
	// Each of these should be a no-op, not a panic.
	if rec.Enqueue("t", "c", "v", "", "", false) {
		t.Fatal("nil recorder should not report queued")
	}
	if rec.QueueDepth() != 0 {
		t.Fatal("nil recorder QueueDepth should be 0")
	}
	rec.Close()
}

func TestBackoffFor_GrowsBoundedAndJittered(t *testing.T) {
	if backoffFor(1) != 0 {
		t.Fatalf("attempt 1 should be 0, got %v", backoffFor(1))
	}
	// attempt 2 ≈ base; attempt 3 ≈ 2× base; cap kicks in eventually.
	for attempt := 2; attempt <= 10; attempt++ {
		d := backoffFor(attempt)
		if d < 0 {
			t.Fatalf("attempt %d returned negative duration %v", attempt, d)
		}
		if d > ViewRecorderMaxBackoff+ViewRecorderMaxBackoff/4 { // +jitter ceiling
			t.Fatalf("attempt %d exceeded cap+jitter: %v", attempt, d)
		}
	}
}
