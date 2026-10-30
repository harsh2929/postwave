package send_time_opt

import (
	"context"
	"testing"
	"time"
)

// TestWorker_DefaultsApplied verifies the zero-value Worker hands back the
// documented defaults (6h interval, 1000 batch, 7d staleness). These knobs
// are part of the worker's contract — they're surfaced in the metric
// dashboards and on-call runbook, so a silent change here would mask
// regressions.
func TestWorker_DefaultsApplied(t *testing.T) {
	w := &Worker{}
	if got := w.interval(); got != 6*time.Hour {
		t.Fatalf("interval default: want 6h, got %s", got)
	}
	if got := w.batchSize(); got != 1000 {
		t.Fatalf("batchSize default: want 1000, got %d", got)
	}
	if got := w.staleAfter(); got != 7*24*time.Hour {
		t.Fatalf("staleAfter default: want 168h, got %s", got)
	}
}

// TestWorker_OverridesHonoured confirms non-zero fields beat the defaults.
func TestWorker_OverridesHonoured(t *testing.T) {
	w := &Worker{Interval: 30 * time.Second, BatchSize: 7, StaleAfter: time.Minute}
	if got := w.interval(); got != 30*time.Second {
		t.Fatalf("interval override: %s", got)
	}
	if got := w.batchSize(); got != 7 {
		t.Fatalf("batchSize override: %d", got)
	}
	if got := w.staleAfter(); got != time.Minute {
		t.Fatalf("staleAfter override: %s", got)
	}
}

// TestNewWorker_HasDefaults guards against future drift where a refactor
// might strip the constructor's defaulting behaviour.
func TestNewWorker_HasDefaults(t *testing.T) {
	w := NewWorker(nil)
	if w.Interval != 6*time.Hour || w.BatchSize != 1000 || w.StaleAfter != 7*24*time.Hour {
		t.Fatalf("NewWorker defaults drifted: %+v", w)
	}
}

// TestWorker_RunOnce_NilRepoNoPanic ensures the worker is null-safe — a
// boot path that wires Run() before Repo is ready (or with a nil pool)
// should be a no-op, not a crash.
func TestWorker_RunOnce_NilRepoNoPanic(t *testing.T) {
	w := &Worker{}
	processed, errs := w.RunOnce(context.Background())
	if processed != 0 || errs != 0 {
		t.Fatalf("nil-repo run: processed=%d errs=%d", processed, errs)
	}
}

// TestWorker_Run_StopsOnContextCancel ensures shutdown is bounded. We
// cancel before calling Run; the loop should return immediately without
// touching the (nil) Repo.
func TestWorker_Run_StopsOnContextCancel(t *testing.T) {
	w := &Worker{Interval: 10 * time.Millisecond}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	done := make(chan struct{})
	go func() {
		w.Run(ctx)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Run did not return after ctx cancel")
	}
}
