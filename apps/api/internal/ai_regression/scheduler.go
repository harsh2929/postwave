// SPDX-License-Identifier: AGPL-3.0-only
//
// scheduler.go runs a small bounded pool of durable AI-regression workers.
// Work is claimed one run at a time with a database lease; no in-memory queue
// is authoritative. Startup and periodic stale repair make process crashes
// recoverable without double-finalizing an attempt.
package ai_regression

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"
)

const (
	defaultRegressionWorkerCount  = 2
	maxRegressionWorkerCount      = 8
	defaultRegressionPollEvery    = 5 * time.Second
	defaultRegressionStaleEvery   = time.Minute
	defaultRegressionStaleAfter   = 10 * time.Minute
	defaultRegressionRunTimeout   = 45 * time.Minute
	defaultRegressionStaleBatch   = 100
	regressionWorkerRestartDelay  = time.Second
	regressionSchedulerWorkerBase = "ai-regression"
)

type RegressionSchedulerStore interface {
	ClaimRun(ctx context.Context, workerID string, leaseTTL time.Duration) (*ClaimedRegressionRun, error)
	RequeueStaleRuns(ctx context.Context, staleBefore time.Time, limit int) (int, error)
}

// Scheduler continuously drains durable pending work until ctx is cancelled.
type Scheduler struct {
	Store      RegressionSchedulerStore
	Runner     *Runner
	Logger     *slog.Logger
	Workers    int
	PollEvery  time.Duration
	StaleEvery time.Duration
	StaleAfter time.Duration
	RunTimeout time.Duration
	LeaseTTL   time.Duration
	StaleBatch int
	Now        func() time.Time
}

func (scheduler *Scheduler) Run(ctx context.Context) error {
	if scheduler == nil || scheduler.Store == nil || scheduler.Runner == nil ||
		scheduler.Runner.Store == nil || scheduler.Runner.Voice == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	policy := scheduler.policy()
	scheduler.requeueStale(ctx, policy)

	instanceID := uuid.NewString()
	var workers sync.WaitGroup
	for index := 0; index < policy.workers; index++ {
		workerID := fmt.Sprintf("%s/%s/%d", regressionSchedulerWorkerBase, instanceID, index+1)
		workers.Add(1)
		go func() {
			defer workers.Done()
			scheduler.runWorkerSafely(ctx, workerID, policy)
		}()
	}

	ticker := time.NewTicker(policy.staleEvery)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			workers.Wait()
			return ctx.Err()
		case <-ticker.C:
			scheduler.requeueStale(ctx, policy)
		}
	}
}

type schedulerPolicy struct {
	workers    int
	pollEvery  time.Duration
	staleEvery time.Duration
	staleAfter time.Duration
	runTimeout time.Duration
	leaseTTL   time.Duration
	staleBatch int
}

func (scheduler *Scheduler) policy() schedulerPolicy {
	workers := scheduler.Workers
	if workers <= 0 {
		workers = defaultRegressionWorkerCount
	}
	if workers > maxRegressionWorkerCount {
		workers = maxRegressionWorkerCount
	}
	pollEvery := scheduler.PollEvery
	if pollEvery <= 0 {
		pollEvery = defaultRegressionPollEvery
	}
	staleEvery := scheduler.StaleEvery
	if staleEvery <= 0 {
		staleEvery = defaultRegressionStaleEvery
	}
	staleAfter := scheduler.StaleAfter
	if staleAfter <= 0 {
		staleAfter = defaultRegressionStaleAfter
	}
	runTimeout := scheduler.RunTimeout
	if runTimeout <= 0 {
		runTimeout = defaultRegressionRunTimeout
	}
	leaseTTL := scheduler.LeaseTTL
	if leaseTTL <= 0 || leaseTTL > maxLeaseTTL {
		leaseTTL, _ = scheduler.Runner.leasePolicy()
	}
	staleBatch := scheduler.StaleBatch
	if staleBatch <= 0 || staleBatch > 500 {
		staleBatch = defaultRegressionStaleBatch
	}
	return schedulerPolicy{
		workers: workers, pollEvery: pollEvery, staleEvery: staleEvery,
		staleAfter: staleAfter, runTimeout: runTimeout, leaseTTL: leaseTTL,
		staleBatch: staleBatch,
	}
}

func (scheduler *Scheduler) runWorkerSafely(ctx context.Context, workerID string, policy schedulerPolicy) {
	for ctx.Err() == nil {
		panicked := false
		func() {
			defer func() {
				if recovered := recover(); recovered != nil {
					panicked = true
					if scheduler.Logger != nil {
						scheduler.Logger.Error(
							"ai_regression: scheduler worker panic recovered",
							"worker_id", workerID,
							"panic_type", fmt.Sprintf("%T", recovered),
						)
					}
				}
			}()
			scheduler.workerLoop(ctx, workerID, policy)
		}()
		if ctx.Err() != nil {
			return
		}
		if !panicked || !waitRegressionScheduler(ctx, regressionWorkerRestartDelay) {
			return
		}
	}
}

func (scheduler *Scheduler) workerLoop(ctx context.Context, workerID string, policy schedulerPolicy) {
	for {
		if ctx.Err() != nil {
			return
		}
		claimed, err := scheduler.Store.ClaimRun(ctx, workerID, policy.leaseTTL)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			if !errors.Is(err, ErrNotFound) && scheduler.Logger != nil {
				scheduler.Logger.Warn(
					"ai_regression: durable claim failed",
					"worker_id", workerID,
					"err", err.Error(),
				)
			}
			if !waitRegressionScheduler(ctx, policy.pollEvery) {
				return
			}
			continue
		}
		if claimed == nil {
			if scheduler.Logger != nil {
				scheduler.Logger.Warn("ai_regression: store returned an empty claim", "worker_id", workerID)
			}
			if !waitRegressionScheduler(ctx, policy.pollEvery) {
				return
			}
			continue
		}
		runCtx, cancel := context.WithTimeout(ctx, policy.runTimeout)
		runErr := scheduler.Runner.ExecuteClaimed(runCtx, claimed)
		cancel()
		if runErr != nil && !errors.Is(runErr, ErrLeaseLost) && scheduler.Logger != nil {
			scheduler.Logger.Warn(
				"ai_regression: claimed attempt ended with an error receipt",
				"tenant_id", claimed.Run.TenantID,
				"run_id", claimed.Run.ID,
				"attempt", claimed.Run.AttemptCount,
				"err", runErr.Error(),
			)
		}
		// A terminal or released attempt frees capacity immediately. Continue
		// without polling delay so a durable backlog drains at a bounded rate.
	}
}

func (scheduler *Scheduler) requeueStale(ctx context.Context, policy schedulerPolicy) {
	count, err := scheduler.Store.RequeueStaleRuns(
		ctx,
		scheduler.now().Add(-policy.staleAfter),
		policy.staleBatch,
	)
	if err != nil {
		if ctx.Err() == nil && scheduler.Logger != nil {
			scheduler.Logger.Warn("ai_regression: stale lease repair failed", "err", err.Error())
		}
		return
	}
	if count > 0 && scheduler.Logger != nil {
		scheduler.Logger.Info("ai_regression: stale leases reconciled", "count", count)
	}
}

func (scheduler *Scheduler) now() time.Time {
	if scheduler.Now != nil {
		return scheduler.Now().UTC()
	}
	return time.Now().UTC()
}

func waitRegressionScheduler(ctx context.Context, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
