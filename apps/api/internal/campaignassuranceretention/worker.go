// SPDX-License-Identifier: AGPL-3.0-only

package campaignassuranceretention

import (
	"context"
	"errors"
	"sync"
	"time"
)

type Worker struct {
	Repository Repository
	Objects    ExactVersionStore
	Config     Configuration
}

func NewWorker(repository Repository, objects ExactVersionStore, config Configuration) (*Worker, error) {
	config, err := normalizeConfiguration(config)
	if err != nil || repository == nil || objects == nil {
		return nil, ErrInvalidConfiguration
	}
	return &Worker{Repository: repository, Objects: objects, Config: config}, nil
}

// Sweep claims at most BatchSize tasks and executes at most Concurrency exact
// version operations at once. Claims not reached because of cancellation are
// recovered only after their bounded database lease expires.
func (w *Worker) Sweep(ctx context.Context) (SweepResult, error) {
	if w == nil || w.Repository == nil || w.Objects == nil {
		return SweepResult{}, ErrInvalidConfiguration
	}
	config, err := normalizeConfiguration(w.Config)
	if err != nil {
		return SweepResult{}, err
	}
	claims, err := w.Repository.ClaimExpired(ctx, config.WorkerID, config.BatchSize, config.LeaseTTL)
	if err != nil {
		return SweepResult{}, err
	}
	result := SweepResult{Claimed: len(claims)}
	if len(claims) == 0 {
		return result, nil
	}

	jobs := make(chan Claim)
	var wg sync.WaitGroup
	var mu sync.Mutex
	var failures []error
	workers := config.Concurrency
	if workers > len(claims) {
		workers = len(claims)
	}
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for claim := range jobs {
				outcome, resolved, processErr := w.process(ctx, config, claim)
				mu.Lock()
				if resolved {
					result.VersionResolved++
				}
				switch outcome.Outcome {
				case "deleted":
					if outcome.Disposition == DispositionAlreadyMissing {
						result.AlreadyMissing++
					} else {
						result.Deleted++
					}
				case "deferred":
					result.Deferred++
				case "failure":
					result.Failed++
				}
				if processErr != nil {
					failures = append(failures, processErr)
				}
				mu.Unlock()
			}
		}()
	}
	for _, claim := range claims {
		select {
		case <-ctx.Done():
			// Only leaves the select; the ctx.Err() check below leaves the loop.
		case jobs <- claim:
		}
		if ctx.Err() != nil {
			break
		}
	}
	close(jobs)
	wg.Wait()
	if ctx.Err() != nil {
		failures = append(failures, ctx.Err())
	}
	return result, errors.Join(failures...)
}

func (w *Worker) process(
	ctx context.Context,
	config Configuration,
	claim Claim,
) (AttemptOutcome, bool, error) {
	claim, err := normalizeClaim(claim)
	if err != nil {
		return AttemptOutcome{Outcome: "failure", FailureCode: "invalid_claim"}, false, err
	}
	version, err := w.Repository.LoadVersion(ctx, claim)
	if err != nil {
		return AttemptOutcome{Outcome: "failure", FailureCode: "version_receipt_unavailable"}, false, err
	}
	resolved := false
	if version == nil {
		resolveContext, cancel := context.WithTimeout(ctx, config.ResolveTimeout)
		candidate, resolveErr := w.Objects.ResolveExactVersion(
			resolveContext, claim.TenantID, claim.ObjectKey, claim.RawOutputHash,
		)
		cancel()
		if resolveErr == nil {
			candidate, resolveErr = normalizeVersion(claim, candidate)
		}
		if resolveErr != nil {
			code := stableFailureCode(resolveErr)
			recordErr := w.Repository.RecordFailure(ctx, claim, code, resolveErr,
				config.WorkerID, config.RetryBackoff(claim.Attempt))
			return AttemptOutcome{Outcome: "failure", FailureCode: code}, false,
				errors.Join(resolveErr, recordErr)
		}
		candidate, err = w.Repository.RecordVersion(ctx, claim, candidate)
		if err != nil {
			code := stableFailureCode(err)
			recordErr := w.Repository.RecordFailure(ctx, claim, code, err,
				config.WorkerID, config.RetryBackoff(claim.Attempt))
			return AttemptOutcome{Outcome: "failure", FailureCode: code}, false,
				errors.Join(err, recordErr)
		}
		version = &candidate
		resolved = true
	}

	outcome, err := w.Repository.DeleteUnderLegalHoldFence(
		ctx, claim, *version, config.WorkerID, config.RetryBackoff(claim.Attempt),
		func(callContext context.Context) (DeleteResult, error) {
			deleteContext, cancel := context.WithTimeout(callContext, config.DeleteTimeout)
			defer cancel()
			return w.Objects.DeleteExactVersion(deleteContext, claim.TenantID, *version)
		},
	)
	return outcome, resolved, err
}

// Run performs an immediate sweep, then serialized sweeps on interval. It does
// not spin on failures and exits cleanly on cancellation.
func (w *Worker) Run(
	ctx context.Context,
	interval time.Duration,
	observe func(SweepResult, error),
) error {
	if w == nil || interval < time.Minute || interval > 24*time.Hour || observe == nil {
		return ErrInvalidConfiguration
	}
	run := func() {
		result, err := w.Sweep(ctx)
		observe(result, err)
	}
	run()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			run()
		}
	}
}

// FailClosedKeyOnlyStore is the explicit adapter for deployments that only
// have uploads.Store-style key deletion. It always refuses resolution and its
// delete method is unreachable. This makes the limitation observable through
// failure receipts without exposing an unsafe fallback.
type FailClosedKeyOnlyStore struct{}

func (FailClosedKeyOnlyStore) ResolveExactVersion(
	context.Context, string, string, string,
) (VersionIdentity, error) {
	return VersionIdentity{}, ErrExactVersionUnavailable
}

func (FailClosedKeyOnlyStore) DeleteExactVersion(
	context.Context, string, VersionIdentity,
) (DeleteResult, error) {
	return DeleteResult{}, ErrExactVersionUnavailable
}
