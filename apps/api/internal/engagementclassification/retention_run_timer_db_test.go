// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"
)

// RetentionWorker.Run must actually reach SweepOnce, and must carry the cursor.
//
// This test exists because its absence was found by mutation, not by review:
// SweepOnce could be cut out of Run entirely — retention completely dead — and
// the whole package stayed green. The only test touching any worker's Run
// pre-cancelled its context, so execution always took the <-ctx.Done() branch
// and the <-timer.C branch was never exercised at all.
//
// A dead retention loop is the quietest failure in this package. Nothing errors,
// no count looks wrong, and no alert fires; personal data simply stays past the
// expiry the product promised, forever. The Stage-2 sibling of this seam was
// tested first because that defect was named; this one is more severe and was
// left behind, which is the reason the class is now swept rather than the
// instance.
func TestRetentionWorkerRunDrivesSweepOnceAndCarriesTheCursorForward_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	sweeps := &stageTwoSweepCursorTracer{}
	app := tracedClassifierAppPool(t, ctx, sweeps)
	repo := &Repo{Pool: app}

	if got := sweeps.snapshot(); got != nil {
		t.Fatalf("tenant paging happened before Run started: %v", got)
	}

	worker := &RetentionWorker{
		Repo: repo,
		// The tightest cadence validate() accepts, so the second tick is ten
		// seconds away rather than an hour.
		Interval:             10 * time.Second,
		TenantBatchSize:      1,
		ObservationBatchSize: 50,
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, &slog.HandlerOptions{Level: slog.LevelError}))
	runCtx, cancelRun := context.WithCancel(ctx)
	defer cancelRun()
	done := make(chan error, 1)
	go func() { done <- worker.Run(runCtx, logger) }()

	// Two sweeps: the first proves the timer reaches SweepOnce at all, the second
	// is where the cursor Run carried between ticks becomes observable.
	deadline := time.Now().Add(60 * time.Second)
	for len(sweeps.snapshot()) < 2 {
		if time.Now().After(deadline) {
			cancelRun()
			t.Fatalf("Run swept %d times in 60s at a %s cadence; the timer never "+
				"reached SweepOnce, so no tenant's expired data is ever purged",
				len(sweeps.snapshot()), worker.Interval)
		}
		time.Sleep(50 * time.Millisecond)
	}
	time.Sleep(250 * time.Millisecond)
	cancelRun()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Run returned %v after cancellation, want context.Canceled", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("Run did not return after its context was cancelled")
	}

	cursors := sweeps.snapshot()
	if cursors[0] != "" {
		t.Fatalf("the first sweep opened at cursor %q, want the start of the tenant order", cursors[0])
	}
	// THE CURSOR ADVANCE. TenantBatchSize is 1, so the first page held exactly one
	// tenant and the next sweep must open AFTER it. A Run that drops
	// NextTenantCursor re-opens at "" forever and no tenant past the first page
	// ever has its expired observations degraded or purged.
	if cursors[1] == "" {
		t.Fatal("the second sweep re-opened at the start of the tenant order: Run did " +
			"not carry NextTenantCursor forward, so no tenant past the first page is " +
			"ever swept")
	}
}
