// SPDX-License-Identifier: AGPL-3.0-only

package ai_regression

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestSchedulerRepairsBeforeWorkersAndUsesBoundedWorkerPolicy(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, time.August, 9, 12, 0, 0, 0, time.UTC)
	repairEntered := make(chan struct{})
	releaseRepair := make(chan struct{})
	claims := make(chan schedulerClaimCall, 3)
	store := &schedulerStoreFake{}
	var repairOnce sync.Once
	store.requeue = func(_ context.Context, staleBefore time.Time, limit int) (int, error) {
		if !staleBefore.Equal(now.Add(-15*time.Second)) || limit != 37 {
			t.Errorf("startup repair args = (%s, %d)", staleBefore, limit)
		}
		repairOnce.Do(func() {
			close(repairEntered)
			<-releaseRepair
		})
		return 0, nil
	}
	store.claim = func(_ context.Context, workerID string, leaseTTL time.Duration) (*ClaimedRegressionRun, error) {
		claims <- schedulerClaimCall{workerID: workerID, leaseTTL: leaseTTL}
		return nil, ErrNotFound
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	errCh := runScheduler(&Scheduler{
		Store: store, Runner: passingSchedulerRunner(), Workers: 3,
		PollEvery: time.Hour, StaleEvery: time.Hour, StaleAfter: 15 * time.Second,
		LeaseTTL: 42 * time.Second, StaleBatch: 37, Now: func() time.Time { return now },
	}, ctx)
	awaitScheduler(t, repairEntered, "startup stale repair")
	select {
	case call := <-claims:
		t.Fatalf("worker claimed before startup repair completed: %+v", call)
	case <-time.After(40 * time.Millisecond):
	}
	close(releaseRepair)

	seen := map[string]bool{}
	for range 3 {
		call := awaitSchedulerValue(t, claims, "bounded worker claim")
		if call.leaseTTL != 42*time.Second {
			t.Fatalf("claim lease ttl = %s, want %s", call.leaseTTL, 42*time.Second)
		}
		if !strings.HasPrefix(call.workerID, regressionSchedulerWorkerBase+"/") {
			t.Fatalf("worker id = %q", call.workerID)
		}
		if seen[call.workerID] {
			t.Fatalf("duplicate worker id %q", call.workerID)
		}
		seen[call.workerID] = true
	}
	cancel()
	if err := awaitSchedulerValue(t, errCh, "scheduler cancellation"); !errors.Is(err, context.Canceled) {
		t.Fatalf("Run() error = %v, want context cancellation", err)
	}
}

func TestSchedulerNoWorkAndNilClaimBackOffInsteadOfHotLooping(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name   string
		result *ClaimedRegressionRun
		err    error
	}{
		{name: "not found", err: ErrNotFound},
		{name: "nil claim", result: nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			first := make(chan struct{})
			second := make(chan struct{}, 1)
			store := &schedulerStoreFake{}
			var calls int
			store.claim = func(_ context.Context, _ string, _ time.Duration) (*ClaimedRegressionRun, error) {
				calls++
				if calls == 1 {
					close(first)
				} else {
					select {
					case second <- struct{}{}:
					default:
					}
				}
				return test.result, test.err
			}
			ctx, cancel := context.WithCancel(context.Background())
			errCh := runScheduler(&Scheduler{
				Store: store, Runner: passingSchedulerRunner(), Workers: 1,
				PollEvery: 200 * time.Millisecond, StaleEvery: time.Hour,
			}, ctx)
			awaitScheduler(t, first, "first no-work claim")
			select {
			case <-second:
				t.Fatal("scheduler immediately re-claimed after no work")
			case <-time.After(35 * time.Millisecond):
			}
			cancel()
			if err := awaitSchedulerValue(t, errCh, "no-work cancellation"); !errors.Is(err, context.Canceled) {
				t.Fatalf("Run() error = %v", err)
			}
		})
	}
}

func TestSchedulerClaimErrorsRecoverAndBackOff(t *testing.T) {
	t.Parallel()
	first := make(chan struct{})
	recovered := make(chan struct{})
	store := &schedulerStoreFake{}
	var calls int
	store.claim = func(_ context.Context, _ string, _ time.Duration) (*ClaimedRegressionRun, error) {
		calls++
		switch calls {
		case 1:
			close(first)
			return nil, errors.New("transient database outage")
		case 2:
			close(recovered)
			return nil, ErrNotFound
		default:
			return nil, ErrNotFound
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	errCh := runScheduler(&Scheduler{
		Store: store, Runner: passingSchedulerRunner(), Workers: 1,
		PollEvery: time.Millisecond, StaleEvery: time.Hour,
	}, ctx)
	awaitScheduler(t, first, "initial claim failure")
	awaitScheduler(t, recovered, "recovered claim")
	cancel()
	if err := awaitSchedulerValue(t, errCh, "claim-error cancellation"); !errors.Is(err, context.Canceled) {
		t.Fatalf("Run() error = %v", err)
	}
}

func TestSchedulerDrainsClaimedBacklogWithoutPollingDelay(t *testing.T) {
	t.Parallel()
	claimedOne := testClaimedRun("first")
	claimedTwo := testClaimedRun("second")
	store := &schedulerStoreFake{claims: []*ClaimedRegressionRun{claimedOne, claimedTwo}}
	secondFinalized := make(chan struct{})
	runnerStore := &runnerStoreFake{}
	var finalized int
	runnerStore.finalize = func(context.Context, string, string, string, int) (*RegressionRun, error) {
		finalized++
		if finalized == 2 {
			close(secondFinalized)
		}
		return &RegressionRun{}, nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	errCh := runScheduler(&Scheduler{
		Store: store, Runner: &Runner{Store: runnerStore, Voice: passingVoice(), HeartbeatEvery: time.Hour},
		Workers: 1, PollEvery: 5 * time.Second, StaleEvery: time.Hour,
	}, ctx)
	awaitScheduler(t, secondFinalized, "two immediate backlog executions")
	if got := store.claimCount(); got < 2 {
		t.Fatalf("claim count = %d, want at least two", got)
	}
	cancel()
	if err := awaitSchedulerValue(t, errCh, "backlog cancellation"); !errors.Is(err, context.Canceled) {
		t.Fatalf("Run() error = %v", err)
	}
}

func TestSchedulerTimeoutRecordsSafeRetryDisposition(t *testing.T) {
	t.Parallel()
	claimed := testClaimedRun("timeout")
	store := &schedulerStoreFake{claims: []*ClaimedRegressionRun{claimed}}
	runnerStore := &runnerStoreFake{}
	retried := make(chan RunFailure, 1)
	runnerStore.retry = func(_ context.Context, _ string, _ string, _ string, _ int, _ time.Time, failure RunFailure) (*RegressionRun, error) {
		retried <- failure
		return &RegressionRun{}, nil
	}
	voice := &runnerVoiceFake{replay: func(ctx context.Context, _ string, _ VoiceReplayRequest) (VoiceReplayBatch, error) {
		<-ctx.Done()
		return VoiceReplayBatch{}, ctx.Err()
	}}
	ctx, cancel := context.WithCancel(context.Background())
	errCh := runScheduler(&Scheduler{
		Store: store, Runner: &Runner{Store: runnerStore, Voice: voice, HeartbeatEvery: time.Hour},
		Workers: 1, PollEvery: time.Hour, StaleEvery: time.Hour, RunTimeout: 15 * time.Millisecond,
	}, ctx)
	failure := awaitSchedulerValue(t, retried, "timeout retry disposition")
	if failure.Code != "worker_timeout" || !strings.Contains(failure.Message, "execution window") {
		t.Fatalf("timeout failure = %#v", failure)
	}
	cancel()
	if err := awaitSchedulerValue(t, errCh, "timeout cancellation"); !errors.Is(err, context.Canceled) {
		t.Fatalf("Run() error = %v", err)
	}
}

func TestSchedulerCancellationWaitsForWorkerAndReturnsContextError(t *testing.T) {
	t.Parallel()
	enteredClaim := make(chan struct{})
	store := &schedulerStoreFake{claim: func(ctx context.Context, _ string, _ time.Duration) (*ClaimedRegressionRun, error) {
		close(enteredClaim)
		<-ctx.Done()
		return nil, ctx.Err()
	}}
	ctx, cancel := context.WithCancel(context.Background())
	errCh := runScheduler(&Scheduler{Store: store, Runner: passingSchedulerRunner(), Workers: 1, StaleEvery: time.Hour}, ctx)
	awaitScheduler(t, enteredClaim, "blocking worker claim")
	cancel()
	if err := awaitSchedulerValue(t, errCh, "worker join on cancellation"); !errors.Is(err, context.Canceled) {
		t.Fatalf("Run() error = %v, want context cancellation", err)
	}
}

func TestSchedulerPerformsPeriodicStaleRepair(t *testing.T) {
	t.Parallel()
	repairs := make(chan int, 3)
	store := &schedulerStoreFake{
		claim: func(context.Context, string, time.Duration) (*ClaimedRegressionRun, error) { return nil, ErrNotFound },
		requeue: func(context.Context, time.Time, int) (int, error) {
			repairs <- 0
			return 0, nil
		},
	}
	ctx, cancel := context.WithCancel(context.Background())
	errCh := runScheduler(&Scheduler{
		Store: store, Runner: passingSchedulerRunner(), Workers: 1, PollEvery: time.Hour,
		StaleEvery: 5 * time.Millisecond, StaleAfter: time.Second,
	}, ctx)
	_ = awaitSchedulerValue(t, repairs, "startup repair")
	_ = awaitSchedulerValue(t, repairs, "periodic repair")
	cancel()
	if err := awaitSchedulerValue(t, errCh, "periodic repair cancellation"); !errors.Is(err, context.Canceled) {
		t.Fatalf("Run() error = %v", err)
	}
}

func TestSchedulerRecoversWorkerPanicWithoutLeakingPanicPayload(t *testing.T) {
	t.Parallel()
	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, nil))
	restarted := make(chan struct{})
	store := &schedulerStoreFake{}
	var calls int
	store.claim = func(ctx context.Context, _ string, _ time.Duration) (*ClaimedRegressionRun, error) {
		calls++
		if calls == 1 {
			panic("private provider credential must never reach logs")
		}
		if calls == 2 {
			close(restarted)
		}
		<-ctx.Done()
		return nil, ctx.Err()
	}
	ctx, cancel := context.WithCancel(context.Background())
	errCh := runScheduler(&Scheduler{
		Store: store, Runner: passingSchedulerRunner(), Logger: logger, Workers: 1,
		PollEvery: time.Hour, StaleEvery: time.Hour,
	}, ctx)
	awaitScheduler(t, restarted, "worker restart after panic")
	cancel()
	if err := awaitSchedulerValue(t, errCh, "panic recovery cancellation"); !errors.Is(err, context.Canceled) {
		t.Fatalf("Run() error = %v", err)
	}
	output := logs.String()
	if !strings.Contains(output, "scheduler worker panic recovered") || strings.Contains(output, "private provider credential") {
		t.Fatalf("unsafe or missing panic log: %q", output)
	}
}

func TestSchedulerDisabledConfigurationsDoNoWorkAndPolicyClamps(t *testing.T) {
	t.Parallel()
	for _, scheduler := range []*Scheduler{
		nil,
		{},
		{Store: &schedulerStoreFake{}},
		{Store: &schedulerStoreFake{}, Runner: &Runner{}},
	} {
		if err := scheduler.Run(context.Background()); err != nil {
			t.Fatalf("disabled scheduler Run() error = %v", err)
		}
	}
	policy := (&Scheduler{
		Runner: &Runner{LeaseTTL: 2 * time.Minute}, Workers: maxRegressionWorkerCount + 99,
		StaleBatch: 501, LeaseTTL: maxLeaseTTL + time.Second,
	}).policy()
	if policy.workers != maxRegressionWorkerCount || policy.staleBatch != defaultRegressionStaleBatch || policy.leaseTTL != 2*time.Minute {
		t.Fatalf("unsafe policy was not clamped: %+v", policy)
	}
	defaults := (&Scheduler{Runner: &Runner{}}).policy()
	if defaults.workers != defaultRegressionWorkerCount || defaults.staleBatch != defaultRegressionStaleBatch || defaults.leaseTTL != defaultRegressionLeaseTTL {
		t.Fatalf("default policy = %+v", defaults)
	}
}

type schedulerClaimCall struct {
	workerID string
	leaseTTL time.Duration
}

type schedulerStoreFake struct {
	mu       sync.Mutex
	claims   []*ClaimedRegressionRun
	claim    func(context.Context, string, time.Duration) (*ClaimedRegressionRun, error)
	requeue  func(context.Context, time.Time, int) (int, error)
	claimLog []schedulerClaimCall
}

func (fake *schedulerStoreFake) ClaimRun(ctx context.Context, workerID string, leaseTTL time.Duration) (*ClaimedRegressionRun, error) {
	fake.mu.Lock()
	fake.claimLog = append(fake.claimLog, schedulerClaimCall{workerID: workerID, leaseTTL: leaseTTL})
	callback := fake.claim
	if len(fake.claims) > 0 {
		claimed := fake.claims[0]
		fake.claims = fake.claims[1:]
		fake.mu.Unlock()
		return claimed, nil
	}
	fake.mu.Unlock()
	if callback != nil {
		return callback(ctx, workerID, leaseTTL)
	}
	return nil, ErrNotFound
}

func (fake *schedulerStoreFake) RequeueStaleRuns(ctx context.Context, staleBefore time.Time, limit int) (int, error) {
	fake.mu.Lock()
	callback := fake.requeue
	fake.mu.Unlock()
	if callback != nil {
		return callback(ctx, staleBefore, limit)
	}
	return 0, nil
}

func (fake *schedulerStoreFake) claimCount() int {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return len(fake.claimLog)
}

func passingSchedulerRunner() *Runner {
	return &Runner{Store: &runnerStoreFake{}, Voice: passingVoice(), HeartbeatEvery: time.Hour}
}

func runScheduler(scheduler *Scheduler, ctx context.Context) <-chan error {
	errCh := make(chan error, 1)
	go func() { errCh <- scheduler.Run(ctx) }()
	return errCh
}

func awaitScheduler(t *testing.T, signal <-chan struct{}, label string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(3 * time.Second):
		t.Fatalf("timed out waiting for %s", label)
	}
}

func awaitSchedulerValue[T any](t *testing.T, signal <-chan T, label string) T {
	t.Helper()
	select {
	case value := <-signal:
		return value
	case <-time.After(3 * time.Second):
		var zero T
		t.Fatalf("timed out waiting for %s", label)
		return zero
	}
}

var _ RegressionSchedulerStore = (*schedulerStoreFake)(nil)
