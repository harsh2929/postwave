// SPDX-License-Identifier: AGPL-3.0-only

package conversions

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

type EmailHMACProjectionStore interface {
	Ready(context.Context) error
	Health(context.Context) (EmailHMACProjectionHealth, error)
	Claim(context.Context, string, int, time.Duration) ([]EmailHMACProjectionClaim, error)
	ResolveSecret(context.Context, EmailHMACProjectionClaim, EnvelopeCipher) ([]byte, error)
	Apply(context.Context, EmailHMACProjectionClaim, []byte, int) (ProjectionApplyResult, error)
	RecordFailure(context.Context, EmailHMACProjectionClaim, string, time.Duration) error
}

type EmailHMACProjectionWorkerConfiguration struct {
	WorkerID     string
	ClaimLimit   int
	Concurrency  int
	PageSize     int
	LeaseTTL     time.Duration
	PollInterval time.Duration
	RetryBackoff func(attempt int) time.Duration
}

func DefaultEmailHMACProjectionWorkerConfiguration(workerID string) EmailHMACProjectionWorkerConfiguration {
	return EmailHMACProjectionWorkerConfiguration{
		WorkerID: workerID, ClaimLimit: DefaultProjectionClaimLimit,
		Concurrency: 4, PageSize: DefaultProjectionPageSize,
		LeaseTTL: 2 * time.Minute, PollInterval: time.Second,
		RetryBackoff: projectionRetryBackoff,
	}
}

func normalizeProjectionWorkerConfiguration(
	configuration EmailHMACProjectionWorkerConfiguration,
) (EmailHMACProjectionWorkerConfiguration, error) {
	if configuration.WorkerID == "" || len(configuration.WorkerID) > 200 ||
		configuration.ClaimLimit < 1 || configuration.ClaimLimit > 100 ||
		configuration.Concurrency < 1 || configuration.Concurrency > 16 ||
		configuration.PageSize < 1 || configuration.PageSize > 1000 ||
		configuration.LeaseTTL < 10*time.Second || configuration.LeaseTTL > 30*time.Minute ||
		configuration.PollInterval < 100*time.Millisecond || configuration.PollInterval > time.Minute ||
		configuration.RetryBackoff == nil {
		return EmailHMACProjectionWorkerConfiguration{}, ErrProjectionConfiguration
	}
	return configuration, nil
}

func projectionRetryBackoff(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	exponent := attempt - 1
	if exponent > 10 {
		exponent = 10
	}
	delay := time.Second * time.Duration(1<<exponent)
	if attempt >= DefaultProjectionMaxAttempts && delay < time.Hour {
		delay = time.Hour
	}
	if delay > time.Hour {
		delay = time.Hour
	}
	return delay
}

type EmailHMACProjectionWorker struct {
	Repository EmailHMACProjectionStore
	Cipher     EnvelopeCipher
	Config     EmailHMACProjectionWorkerConfiguration
}

type EmailHMACProjectionSweepResult struct {
	Claimed       int
	Pages         int
	Subscribers   int
	Completed     int
	Retried       int
	LeaseLost     int
	FailedVisible int
	FailureSignal bool
	StalePresent  bool
	StaleSignal   bool
}

func NewEmailHMACProjectionWorker(
	repository EmailHMACProjectionStore,
	cipher EnvelopeCipher,
	configuration EmailHMACProjectionWorkerConfiguration,
) (*EmailHMACProjectionWorker, error) {
	configuration, err := normalizeProjectionWorkerConfiguration(configuration)
	if err != nil || repository == nil || cipher == nil {
		return nil, ErrProjectionConfiguration
	}
	return &EmailHMACProjectionWorker{
		Repository: repository, Cipher: cipher, Config: configuration,
	}, nil
}

func (worker *EmailHMACProjectionWorker) Ready(ctx context.Context) error {
	if worker == nil || worker.Repository == nil || worker.Cipher == nil {
		return ErrProjectionConfiguration
	}
	if _, err := normalizeProjectionWorkerConfiguration(worker.Config); err != nil {
		return err
	}
	return worker.Repository.Ready(ctx)
}

func (worker *EmailHMACProjectionWorker) Sweep(
	ctx context.Context,
) (EmailHMACProjectionSweepResult, error) {
	if worker == nil || worker.Repository == nil || worker.Cipher == nil {
		return EmailHMACProjectionSweepResult{}, ErrProjectionConfiguration
	}
	configuration, err := normalizeProjectionWorkerConfiguration(worker.Config)
	if err != nil {
		return EmailHMACProjectionSweepResult{}, err
	}
	claims, err := worker.Repository.Claim(
		ctx, configuration.WorkerID, configuration.ClaimLimit, configuration.LeaseTTL,
	)
	if err != nil {
		return EmailHMACProjectionSweepResult{}, err
	}
	result := EmailHMACProjectionSweepResult{Claimed: len(claims)}
	if len(claims) == 0 {
		health, healthErr := worker.Repository.Health(ctx)
		result.StalePresent = health.HasStale
		result.FailureSignal = health.HasFailed
		return result, healthErr
	}

	jobs := make(chan EmailHMACProjectionClaim)
	var wait sync.WaitGroup
	var mutex sync.Mutex
	var failures []error
	concurrency := configuration.Concurrency
	if concurrency > len(claims) {
		concurrency = len(claims)
	}
	for range concurrency {
		wait.Add(1)
		go func() {
			defer wait.Done()
			for claim := range jobs {
				page, retry, leaseLost, processErr := worker.process(ctx, configuration, claim)
				mutex.Lock()
				if page.Processed > 0 || page.Complete {
					result.Pages++
				}
				result.Subscribers += page.Processed
				if page.Complete {
					result.Completed++
				}
				if retry {
					result.Retried++
					if claim.Attempt >= DefaultProjectionMaxAttempts {
						result.FailedVisible++
					}
				}
				if leaseLost {
					result.LeaseLost++
				}
				if processErr != nil {
					failures = append(failures, processErr)
				}
				mutex.Unlock()
			}
		}()
	}
	for _, claim := range claims {
		select {
		case jobs <- claim:
		case <-ctx.Done():
			// Only leaves the select; the ctx.Err() check below leaves the loop.
		}
		if ctx.Err() != nil {
			break
		}
	}
	close(jobs)
	wait.Wait()
	if ctx.Err() != nil {
		failures = append(failures, ctx.Err())
	}
	health, healthErr := worker.Repository.Health(ctx)
	result.StalePresent = health.HasStale
	if health.HasFailed && result.FailedVisible == 0 {
		result.FailureSignal = true
	}
	if healthErr != nil {
		failures = append(failures, healthErr)
	}
	return result, errors.Join(failures...)
}

func (worker *EmailHMACProjectionWorker) process(
	ctx context.Context,
	configuration EmailHMACProjectionWorkerConfiguration,
	claim EmailHMACProjectionClaim,
) (ProjectionApplyResult, bool, bool, error) {
	secret, err := worker.Repository.ResolveSecret(ctx, claim, worker.Cipher)
	if err != nil {
		if errors.Is(err, ErrProjectionLeaseLost) {
			return ProjectionApplyResult{}, false, true, nil
		}
		code := ProjectionErrorFailed
		if errors.Is(err, ErrProjectionSecretUnavailable) {
			code = ProjectionErrorSecretUnavailable
		}
		recordErr := worker.Repository.RecordFailure(
			ctx, claim, code, configuration.RetryBackoff(claim.Attempt),
		)
		if errors.Is(recordErr, ErrProjectionLeaseLost) {
			return ProjectionApplyResult{}, false, true, err
		}
		return ProjectionApplyResult{}, true, false,
			fmt.Errorf("conversions: email identity projection %s: %w",
				code, errors.Join(err, recordErr))
	}
	defer zeroSecret(secret)

	page, err := worker.Repository.Apply(ctx, claim, secret, configuration.PageSize)
	if err == nil {
		return page, false, false, nil
	}
	if errors.Is(err, ErrProjectionLeaseLost) {
		return ProjectionApplyResult{}, false, true, nil
	}
	recordErr := worker.Repository.RecordFailure(
		ctx, claim, ProjectionErrorFailed, configuration.RetryBackoff(claim.Attempt),
	)
	if errors.Is(recordErr, ErrProjectionLeaseLost) {
		return ProjectionApplyResult{}, false, true, err
	}
	return ProjectionApplyResult{}, true, false,
		fmt.Errorf("conversions: email identity projection failed: %w", errors.Join(err, recordErr))
}

// Run polls continuously because subscriber mutation convergence is part of
// the public ingest correctness boundary, not an hourly maintenance sweep.
func (worker *EmailHMACProjectionWorker) Run(
	ctx context.Context,
	observe func(EmailHMACProjectionSweepResult, error),
) error {
	if worker == nil || observe == nil {
		return ErrProjectionConfiguration
	}
	configuration, err := normalizeProjectionWorkerConfiguration(worker.Config)
	if err != nil {
		return err
	}
	var lastFailureSignal, lastStaleSignal time.Time
	for {
		result, sweepErr := worker.Sweep(ctx)
		now := time.Now()
		if result.FailureSignal {
			if lastFailureSignal.IsZero() || now.Sub(lastFailureSignal) >= 15*time.Minute {
				lastFailureSignal = now
			} else {
				result.FailureSignal = false
			}
		} else if result.FailedVisible == 0 {
			lastFailureSignal = time.Time{}
		}
		if result.StalePresent {
			if lastStaleSignal.IsZero() || now.Sub(lastStaleSignal) >= 15*time.Minute {
				result.StaleSignal = true
				lastStaleSignal = now
			}
		} else {
			lastStaleSignal = time.Time{}
		}
		observe(result, sweepErr)
		if ctx.Err() != nil {
			return nil
		}
		delay := configuration.PollInterval
		if result.Claimed == configuration.ClaimLimit {
			delay = 100 * time.Millisecond
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return nil
		case <-timer.C:
		}
	}
}
