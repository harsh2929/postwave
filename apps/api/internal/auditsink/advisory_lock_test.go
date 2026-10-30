// SPDX-License-Identifier: AGPL-3.0-only
package auditsink

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
)

func TestWithSinkAdvisoryLockReleasesOnEveryFailurePath(t *testing.T) {
	workErr := errors.New("work failed")
	releaseErr := errors.New("unlock failed")

	tests := []struct {
		name          string
		acquire       sinkLockAcquirer
		work          func() error
		wantProcessed bool
		wantWorkErr   bool
		wantUnlockErr bool
		wantReleases  int32
	}{
		{
			name: "work failure",
			acquire: func(context.Context, string) (bool, func() error, error) {
				return true, func() error { return nil }, nil
			},
			work:          func() error { return workErr },
			wantProcessed: true,
			wantWorkErr:   true,
			wantReleases:  1,
		},
		{
			name: "unlock failure is joined",
			acquire: func(context.Context, string) (bool, func() error, error) {
				return true, func() error { return releaseErr }, nil
			},
			work:          func() error { return workErr },
			wantProcessed: true,
			wantWorkErr:   true,
			wantUnlockErr: true,
			wantReleases:  1,
		},
		{
			name: "lock held elsewhere",
			acquire: func(context.Context, string) (bool, func() error, error) {
				return false, func() error { return errors.New("must not run") }, nil
			},
			work:          func() error { return errors.New("must not run") },
			wantProcessed: false,
			wantReleases:  0,
		},
		{
			name: "acquire failure",
			acquire: func(context.Context, string) (bool, func() error, error) {
				return false, func() error { return errors.New("must not run") }, workErr
			},
			work:          func() error { return errors.New("must not run") },
			wantProcessed: false,
			wantWorkErr:   true,
			wantReleases:  0,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var releases atomic.Int32
			acquire := func(ctx context.Context, sinkID string) (bool, func() error, error) {
				got, release, err := tc.acquire(ctx, sinkID)
				return got, func() error {
					releases.Add(1)
					return release()
				}, err
			}
			processed, err := withSinkAdvisoryLock(context.Background(), "sink-1", acquire, tc.work)
			if processed != tc.wantProcessed {
				t.Fatalf("processed = %v, want %v", processed, tc.wantProcessed)
			}
			if errors.Is(err, workErr) != tc.wantWorkErr {
				t.Fatalf("work error = %v, want presence %v", err, tc.wantWorkErr)
			}
			if errors.Is(err, releaseErr) != tc.wantUnlockErr {
				t.Fatalf("unlock error = %v, want presence %v", err, tc.wantUnlockErr)
			}
			if got := releases.Load(); got != tc.wantReleases {
				t.Fatalf("release calls = %d, want %d", got, tc.wantReleases)
			}
		})
	}
}

func TestWithSinkAdvisoryLockReleasesDuringPanic(t *testing.T) {
	var releases atomic.Int32
	func() {
		defer func() {
			if recover() == nil {
				t.Error("work did not panic")
			}
		}()
		_, _ = withSinkAdvisoryLock(
			context.Background(),
			"sink-panic",
			func(context.Context, string) (bool, func() error, error) {
				return true, func() error {
					releases.Add(1)
					return nil
				}, nil
			},
			func() error { panic("boom") },
		)
	}()
	if got := releases.Load(); got != 1 {
		t.Fatalf("release calls after panic = %d, want 1", got)
	}
}

func TestWithSinkAdvisoryLockConcurrentReleaseAccounting(t *testing.T) {
	const workers = 100
	var releases atomic.Int32
	var wg sync.WaitGroup
	wg.Add(workers)
	for i := 0; i < workers; i++ {
		go func(i int) {
			defer wg.Done()
			_, err := withSinkAdvisoryLock(
				context.Background(),
				fmt.Sprintf("sink-%d", i),
				func(context.Context, string) (bool, func() error, error) {
					return true, func() error {
						releases.Add(1)
						return nil
					}, nil
				},
				func() error {
					if i%2 == 0 {
						return errors.New("synthetic branch failure")
					}
					return nil
				},
			)
			if i%2 == 0 && err == nil {
				t.Errorf("worker %d lost synthetic error", i)
			}
		}(i)
	}
	wg.Wait()
	if got := releases.Load(); got != workers {
		t.Fatalf("release calls = %d, want %d", got, workers)
	}
}

func TestAdvisoryLockIsPinnedAndReleasedAfterCanceledWork(t *testing.T) {
	pool := newAuditTestPool(t)
	d := &Deps{Pool: pool}
	sinkID := "auditsink-lock-" + randHex(t)
	ctx, cancel := context.WithCancel(context.Background())

	processed, err := withSinkAdvisoryLock(ctx, sinkID, d.acquireAdvisoryLockSink, func() error {
		other, acquireErr := pool.Acquire(context.Background())
		if acquireErr != nil {
			return acquireErr
		}
		defer other.Release()
		var duplicateGot bool
		if queryErr := other.QueryRow(context.Background(),
			`SELECT pg_try_advisory_lock(hashtext($1)::bigint)`, sinkID).Scan(&duplicateGot); queryErr != nil {
			return queryErr
		}
		if duplicateGot {
			_, _ = other.Exec(context.Background(),
				`SELECT pg_advisory_unlock(hashtext($1)::bigint)`, sinkID)
			return errors.New("second session acquired the pinned lock")
		}
		cancel()
		return context.Canceled
	})
	if !processed {
		t.Fatal("lock was not acquired")
	}
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("work error = %v, want context cancellation", err)
	}

	// The release closure uses its own context, so cancellation of the work
	// context must not leave the session lock behind.
	got, release, err := d.acquireAdvisoryLockSink(context.Background(), sinkID)
	if err != nil {
		t.Fatalf("reacquire after canceled work: %v", err)
	}
	if !got {
		t.Fatal("lock remained held after canceled work")
	}
	if err := release(); err != nil {
		t.Fatalf("final release: %v", err)
	}
}
