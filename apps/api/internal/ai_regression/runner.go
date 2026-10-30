// SPDX-License-Identifier: AGPL-3.0-only
//
// runner.go executes one already-claimed immutable AI-regression snapshot.
// Every write is fenced by the claim token and attempt number. Voice streams
// are validated in full before any result is accepted, result writes are
// attempt-scoped and idempotent, and the store recomputes the authoritative
// aggregate in the same transaction that marks the run terminal.
package ai_regression

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"
)

const (
	defaultRegressionLeaseTTL       = 5 * time.Minute
	defaultRegressionHeartbeatEvery = 30 * time.Second
	// Voice executes generation and fidelity scoring sequentially per
	// example. Keep the normal transport batch small enough to stream a
	// complete, strictly validated receipt within the internal HTTP/server
	// timeout even when individual provider calls are slow. The protocol still
	// accepts up to voiceReplayMaxExamples for explicit controlled callers.
	defaultRegressionBatchSize    = 5
	regressionFinalizationTimeout = 15 * time.Second
	regressionRetryBaseDelay      = 30 * time.Second
	regressionRetryMaxDelay       = 10 * time.Minute
	regressionQuotaRetryDelay     = time.Hour
)

// RegressionRunnerStore is the durable, fenced mutation surface used by a
// worker. *Repo implements it; focused tests use an in-memory fake.
type RegressionRunnerStore interface {
	RenewRunLease(ctx context.Context, tenantID, runID, claimToken string, attempt int, leaseTTL time.Duration) (*RegressionRun, error)
	RetryRun(ctx context.Context, tenantID, runID, claimToken string, attempt int, notBefore time.Time, failure RunFailure) (*RegressionRun, error)
	FinalizeRun(ctx context.Context, tenantID, runID, claimToken string, attempt int) (*RegressionRun, error)
	FailRun(ctx context.Context, tenantID, runID, claimToken string, attempt int, failure RunFailure) (*RegressionRun, error)
	UpsertResult(ctx context.Context, tenantID, runID, claimToken string, attempt int, in UpsertRegressionResultInput) (*RegressionResult, error)
}

// Runner executes claimed regression snapshots. It is stateless and safe to
// share across scheduler workers.
type Runner struct {
	Store          RegressionRunnerStore
	Voice          RegressionVoiceClient
	Logger         *slog.Logger
	LeaseTTL       time.Duration
	HeartbeatEvery time.Duration
	BatchSize      int
	Now            func() time.Time
}

// ExecuteClaimed runs one fenced attempt. It always tries to release the
// lease into retry/failed state on ordinary errors or panics; ErrLeaseLost is
// intentionally left untouched because a newer worker owns the authority.
func (runner *Runner) ExecuteClaimed(ctx context.Context, claimed *ClaimedRegressionRun) (err error) {
	if runner == nil || runner.Store == nil || runner.Voice == nil {
		return errors.New("ai_regression: runner is not configured")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	tenantID, runID, claimToken, attempt, validationErr := validateClaimedRun(claimed)
	if validationErr != nil {
		return validationErr
	}

	defer func() {
		if recovered := recover(); recovered != nil {
			runner.logPrivate("regression attempt panic recovered", claimed, fmt.Sprintf("%T", recovered), nil)
			panicErr := errors.New("ai_regression: regression worker panicked")
			if finalErr := runner.recordDisposition(ctx, claimed, RunFailure{
				Code:    "worker_panic",
				Message: "the regression worker stopped unexpectedly and the attempt was closed safely",
			}, false, 0); finalErr != nil {
				err = errors.Join(panicErr, finalErr)
				return
			}
			err = panicErr
		}
	}()

	leaseTTL, heartbeatEvery := runner.leasePolicy()
	workErr := runner.withHeartbeat(ctx, claimed, leaseTTL, heartbeatEvery, func(workCtx context.Context) error {
		return runner.persistVoiceResults(workCtx, claimed)
	})
	if workErr != nil {
		return runner.handleAttemptError(ctx, claimed, workErr)
	}

	// The heartbeat goroutine is stopped and joined before finalization, so a
	// successful terminal CAS cannot race a late renewal into a false lease-loss.
	_, finalizeErr := runner.Store.FinalizeRun(ctx, tenantID, runID, claimToken, attempt)
	if finalizeErr != nil {
		return runner.handleAttemptError(ctx, claimed, finalizeErr)
	}
	return nil
}

func validateClaimedRun(claimed *ClaimedRegressionRun) (tenantID, runID, claimToken string, attempt int, err error) {
	if claimed == nil || claimed.Run.TenantID == "" || claimed.Run.ID == "" ||
		claimed.Run.ClaimToken == nil || *claimed.Run.ClaimToken == "" ||
		claimed.Run.AttemptCount < 1 || claimed.Run.Status != RunStatusRunning ||
		len(claimed.Examples) == 0 || len(claimed.Examples) != claimed.Run.TotalExamples {
		return "", "", "", 0, errors.New("ai_regression: invalid claimed run")
	}
	return claimed.Run.TenantID, claimed.Run.ID, *claimed.Run.ClaimToken, claimed.Run.AttemptCount, nil
}

func (runner *Runner) persistVoiceResults(ctx context.Context, claimed *ClaimedRegressionRun) error {
	batchSize := runner.BatchSize
	if batchSize <= 0 || batchSize > voiceReplayMaxExamples {
		batchSize = defaultRegressionBatchSize
	}
	runtime := VoiceRuntimeIdentity{
		Provider:            claimed.Run.RuntimeProvider,
		ModelID:             claimed.Run.ModelID,
		PromptPolicyVersion: claimed.Run.PromptVersionTag,
	}
	tenantID := claimed.Run.TenantID
	runID := claimed.Run.ID
	claimToken := *claimed.Run.ClaimToken
	attempt := claimed.Run.AttemptCount

	for start := 0; start < len(claimed.Examples); start += batchSize {
		if err := ctx.Err(); err != nil {
			return err
		}
		end := start + batchSize
		if end > len(claimed.Examples) {
			end = len(claimed.Examples)
		}
		voiceExamples := make([]VoiceReplayExample, 0, end-start)
		for _, example := range claimed.Examples[start:end] {
			voiceExamples = append(voiceExamples, VoiceReplayExample{
				ID:             example.ExampleID,
				SurfaceKind:    example.SurfaceKind,
				Brief:          example.Brief,
				ApprovedOutput: example.ApprovedOutput,
			})
		}
		batch, err := runner.Voice.ReplayBatch(ctx, tenantID, VoiceReplayRequest{
			ExpectedRuntime: runtime,
			WarnThreshold:   claimed.Run.WarnThreshold,
			Examples:        voiceExamples,
		})
		if err != nil {
			return err
		}
		for _, result := range batch.Results {
			input := regressionResultInput(result)
			if _, err := runner.Store.UpsertResult(
				ctx, tenantID, runID, claimToken, attempt, input,
			); err != nil {
				return err
			}
		}
	}
	return nil
}

func regressionResultInput(result VoiceReplayResult) UpsertRegressionResultInput {
	input := UpsertRegressionResultInput{
		ExampleID:     result.ExampleID,
		FidelityScore: result.FidelityScore,
		Severity:      result.Severity,
	}
	if result.ReplayedOutput != "" {
		output := result.ReplayedOutput
		input.ReplayedOutput = &output
	}
	if result.Breakdown != nil {
		input.Breakdown = map[string]any{
			"embedding_similarity": result.Breakdown.EmbeddingSimilarity,
			"stylistic_distance":   result.Breakdown.StylisticDistance,
			"vocabulary_overlap":   result.Breakdown.VocabularyOverlap,
			"structural_match":     result.Breakdown.StructuralMatch,
			"combined":             result.Breakdown.Combined,
		}
	}
	if result.ErrorCode != "" {
		code := result.ErrorCode
		input.ErrorCode = &code
		message := safeResultErrorMessage(result.ErrorCode)
		input.ErrorMessage = &message
	}
	return input
}

func safeResultErrorMessage(code string) string {
	switch code {
	case "generation_unavailable":
		return "the replay generator was unavailable for this reference"
	case "generation_invalid":
		return "the replay generator returned an invalid bounded output"
	case "scoring_unavailable":
		return "the fidelity evaluator was unavailable for this reference"
	case "scoring_invalid":
		return "the fidelity evaluator returned an invalid score"
	default:
		return "the reference could not be scored safely"
	}
}

func (runner *Runner) withHeartbeat(
	ctx context.Context,
	claimed *ClaimedRegressionRun,
	leaseTTL, heartbeatEvery time.Duration,
	work func(context.Context) error,
) error {
	workCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	heartbeatDone := make(chan error, 1)
	go func() {
		ticker := time.NewTicker(heartbeatEvery)
		defer ticker.Stop()
		for {
			select {
			case <-workCtx.Done():
				heartbeatDone <- nil
				return
			case <-ticker.C:
				_, err := runner.Store.RenewRunLease(
					workCtx,
					claimed.Run.TenantID,
					claimed.Run.ID,
					*claimed.Run.ClaimToken,
					claimed.Run.AttemptCount,
					leaseTTL,
				)
				if err != nil {
					heartbeatDone <- err
					cancel()
					return
				}
			}
		}
	}()
	workErr := work(workCtx)
	cancel()
	heartbeatErr := <-heartbeatDone
	if heartbeatErr != nil {
		return heartbeatErr
	}
	return workErr
}

func (runner *Runner) leasePolicy() (time.Duration, time.Duration) {
	leaseTTL := runner.LeaseTTL
	if leaseTTL < time.Millisecond || leaseTTL > maxLeaseTTL {
		leaseTTL = defaultRegressionLeaseTTL
	}
	heartbeatEvery := runner.HeartbeatEvery
	if heartbeatEvery <= 0 {
		heartbeatEvery = defaultRegressionHeartbeatEvery
	}
	if heartbeatEvery >= leaseTTL {
		heartbeatEvery = leaseTTL / 3
	}
	if heartbeatEvery <= 0 {
		heartbeatEvery = time.Millisecond
	}
	return leaseTTL, heartbeatEvery
}

func (runner *Runner) handleAttemptError(ctx context.Context, claimed *ClaimedRegressionRun, cause error) error {
	if errors.Is(cause, ErrLeaseLost) {
		return cause
	}
	failure, retry, delay := classifyRegressionFailure(cause, claimed.Run.AttemptCount)
	runner.logPrivate("regression attempt failed", claimed, "", cause)
	if finalErr := runner.recordDisposition(ctx, claimed, failure, retry, delay); finalErr != nil {
		return errors.Join(cause, finalErr)
	}
	return cause
}

func (runner *Runner) recordDisposition(
	ctx context.Context,
	claimed *ClaimedRegressionRun,
	failure RunFailure,
	retry bool,
	delay time.Duration,
) error {
	base := ctx
	if base == nil {
		base = context.Background()
	}
	finalCtx, cancel := context.WithTimeout(context.WithoutCancel(base), regressionFinalizationTimeout)
	defer cancel()
	claimToken := *claimed.Run.ClaimToken
	if retry {
		_, err := runner.Store.RetryRun(
			finalCtx,
			claimed.Run.TenantID,
			claimed.Run.ID,
			claimToken,
			claimed.Run.AttemptCount,
			runner.now().Add(delay),
			failure,
		)
		return err
	}
	_, err := runner.Store.FailRun(
		finalCtx,
		claimed.Run.TenantID,
		claimed.Run.ID,
		claimToken,
		claimed.Run.AttemptCount,
		failure,
	)
	return err
}

func classifyRegressionFailure(cause error, attempt int) (RunFailure, bool, time.Duration) {
	switch {
	case errors.Is(cause, context.Canceled):
		return RunFailure{Code: "worker_interrupted", Message: "the regression attempt was interrupted and scheduled for a safe retry"}, true, regressionBackoff(attempt)
	case errors.Is(cause, context.DeadlineExceeded):
		return RunFailure{Code: "worker_timeout", Message: "the regression attempt exceeded its execution window and was scheduled for a safe retry"}, true, regressionBackoff(attempt)
	case errors.Is(cause, ErrVoiceUnavailable):
		return RunFailure{Code: "voice_unavailable", Message: "the replay service was unavailable and the run was scheduled for a safe retry"}, true, regressionBackoff(attempt)
	case errors.Is(cause, ErrVoiceQuotaExceeded):
		return RunFailure{Code: "voice_quota_exceeded", Message: "the replay quota was unavailable; the run will retry after a cooling-off period"}, true, regressionQuotaRetryDelay
	case errors.Is(cause, ErrVoiceAuthenticationUnavailable):
		return RunFailure{Code: "voice_auth_unavailable", Message: "the internal replay service authentication is not configured"}, false, 0
	case errors.Is(cause, ErrVoiceRuntimeMismatch):
		return RunFailure{Code: "runtime_mismatch", Message: "the snapshotted replay runtime is not available"}, false, 0
	case errors.Is(cause, ErrVoicePrerequisiteUnavailable):
		return RunFailure{Code: "replay_prerequisite_unavailable", Message: "a qualified voice profile and evaluator are required before replay"}, false, 0
	case errors.Is(cause, ErrVoiceInvalidResponse):
		return RunFailure{Code: "invalid_replay_receipt", Message: "the replay service returned an invalid or incomplete evidence receipt"}, false, 0
	case errors.Is(cause, ErrSnapshotIncomplete):
		return RunFailure{Code: "snapshot_incomplete", Message: "the immutable replay snapshot did not have complete result coverage"}, false, 0
	case errors.Is(cause, ErrInvalidResult), errors.Is(cause, ErrInvalidLease):
		return RunFailure{Code: "evidence_contract_invalid", Message: "the regression evidence failed an internal integrity check"}, false, 0
	default:
		return RunFailure{Code: "worker_dependency_unavailable", Message: "a regression worker dependency was unavailable and the run was scheduled for a safe retry"}, true, regressionBackoff(attempt)
	}
}

func regressionBackoff(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	delay := regressionRetryBaseDelay
	for current := 1; current < attempt && delay < regressionRetryMaxDelay; current++ {
		delay *= 2
		if delay > regressionRetryMaxDelay {
			delay = regressionRetryMaxDelay
		}
	}
	return delay
}

func (runner *Runner) now() time.Time {
	if runner.Now != nil {
		return runner.Now().UTC()
	}
	return time.Now().UTC()
}

func (runner *Runner) logPrivate(message string, claimed *ClaimedRegressionRun, panicType string, err error) {
	if runner.Logger == nil || claimed == nil {
		return
	}
	attributes := []any{
		"tenant_id", claimed.Run.TenantID,
		"run_id", claimed.Run.ID,
		"attempt", claimed.Run.AttemptCount,
	}
	if panicType != "" {
		attributes = append(attributes, "panic_type", panicType)
	}
	if err != nil {
		attributes = append(attributes, "err", err.Error())
	}
	runner.Logger.Warn(message, attributes...)
}
