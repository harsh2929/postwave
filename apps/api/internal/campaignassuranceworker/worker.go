// SPDX-License-Identifier: AGPL-3.0-only

package campaignassuranceworker

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/postwave/postwave/apps/api/internal/campaignassurance"
	"github.com/postwave/postwave/apps/api/internal/campaignchecks"
	"github.com/postwave/postwave/apps/api/internal/campaigncoverage"
	"github.com/postwave/postwave/apps/api/internal/factcontract"
)

const maxLeaseTTL = 24 * time.Hour

// Process claims and resolves exactly one durable tenant/run command. A
// successful return means the repository lifecycle was advanced or the
// command was proven to be a harmless duplicate/deferred delivery.
func (w *Worker) Process(ctx context.Context, raw Command) (Result, error) {
	worker, command, err := w.normalized(raw)
	if err != nil {
		return Result{}, err
	}
	claimed, err := worker.Assurance.ClaimRun(ctx, command.TenantID, command.RunID,
		worker.Config.WorkerID, worker.Config.LeaseTTL)
	if errors.Is(err, campaignassurance.ErrNotFound) {
		return worker.resolveUnclaimed(ctx, command)
	}
	if err != nil {
		return Result{}, fmt.Errorf("claim assurance run: %w", err)
	}
	if err := validateClaim(command, claimed); err != nil {
		return worker.failInvalidClaim(ctx, claimed, err)
	}

	workContext, heartbeat := worker.startHeartbeat(ctx, claimed)
	summary, executionErr := worker.execute(workContext, claimed)
	if executionErr != nil {
		heartbeatErr := heartbeat.stop()
		if heartbeatErr != nil && !errors.Is(executionErr, heartbeatErr) {
			executionErr = errors.Join(executionErr, heartbeatErr)
		}
		return worker.releaseAfterFailure(ctx, claimed, executionErr, summary)
	}

	gate := campaignassurance.GatePass
	if summary.unavailable != 0 {
		gate = campaignassurance.GateUnavailable
	} else if summary.blockers != 0 {
		gate = campaignassurance.GateBlock
	} else if summary.findings != 0 {
		gate = campaignassurance.GateWarn
	}
	// Keep the lease heartbeat active through the terminal database write. A
	// slow finalization must not create a lease-expiry window after all evidence
	// has already been persisted.
	finalized, err := worker.Assurance.FinalizeRun(workContext, claimed.Run.TenantID, claimed.Run.ID,
		*claimed.Run.ClaimToken, claimed.Run.AttemptCount, summary.finalizeInput(gate))
	heartbeatErr := heartbeat.stop()
	if err != nil {
		if heartbeatErr != nil {
			err = errors.Join(err, heartbeatErr)
		}
		return worker.releaseAfterFailure(ctx, claimed,
			fmt.Errorf("%w: finalize run: %w", ErrLifecycle, err), summary)
	}
	// A heartbeat racing the successful terminal transition can observe a lost
	// lease after FinalizeRun clears the token. The fenced terminal receipt is
	// authoritative, so that expected post-commit heartbeat error is ignored.
	return resultForRun(finalized, summary), nil
}

func (w *Worker) execute(ctx context.Context, claimed *campaignassurance.ClaimedRun) (executionSummary, error) {
	configurations := make(map[string]campaignassurance.RunConfiguration, len(claimed.Configurations))
	for _, configuration := range claimed.Configurations {
		configurations[configuration.ID] = configuration
	}
	artifactSnapshots := make(map[string]campaignassurance.RunArtifact, len(claimed.Artifacts))
	for _, artifact := range claimed.Artifacts {
		artifactSnapshots[artifact.ArtifactID] = artifact
	}
	modeledPreparations := w.prepareModeledConfigurations(claimed)
	modeledResults := newModeledExecutionResults(claimed, modeledPreparations)
	// A summary-stability target is modeled, but it is not an ensemble member,
	// so it is never recorded into the scored result set.
	scored := func(target campaignassurance.RunTarget) bool {
		return target.SourceClass == campaignassurance.SourceModeled &&
			!modeledPreparations.isSummaryStability(target.ConfigurationID)
	}

	var (
		summary          executionSummary
		frozen           frozenInputs
		frozenErr        error
		frozenLoaded     bool
		modelContract    factcontract.ContractV1
		modelContractErr error
		modelContractSet bool
		artifactCache    = make(map[string]struct {
			value loadedArtifact
			err   error
		}, len(claimed.Artifacts))
	)
	for _, target := range claimed.Targets {
		if err := context.Cause(ctx); err != nil {
			return summary, err
		}
		configuration := configurations[target.ConfigurationID]
		if target.SourceClass == campaignassurance.SourceControlledObservation {
			persisted, err := w.recordUnavailable(ctx, claimed, target, unsupportedSourceSpec(target.SourceClass))
			if err != nil {
				return summary, err
			}
			addPersisted(&summary, persisted)
			continue
		}
		if target.SourceClass == campaignassurance.SourceDeterministic &&
			(configuration.ID != DeterministicConfigurationID ||
				validateDeterministicConfiguration(configuration.Configuration, claimed.Run.GatePolicyVersion) != nil) {
			persisted, err := w.analyzeDeterministicTarget(ctx, claimed, target, configuration, loadedArtifact{})
			if err != nil {
				return summary, err
			}
			addPersisted(&summary, persisted)
			continue
		}
		var modeledPreparation modeledPreparation
		if target.SourceClass == campaignassurance.SourceModeled {
			modeledPreparation = modeledPreparations.forTarget(target)
			if modeledPreparation.unavailable != nil {
				persisted, err := w.recordUnavailable(ctx, claimed, target, *modeledPreparation.unavailable)
				if err != nil {
					return summary, err
				}
				addPersisted(&summary, persisted)
				if scored(target) {
					if err := modeledResults.record(target, persisted); err != nil {
						return summary, err
					}
				}
				continue
			}
		}

		if !frozenLoaded {
			frozen, frozenErr = w.loadFrozenInputs(ctx, claimed)
			frozenLoaded = true
		}
		if frozenErr != nil {
			if !permanentArtifactError(frozenErr) {
				return summary, frozenErr
			}
			persisted, err := w.recordUnavailable(ctx, claimed, target, artifactUnavailableSpec(frozenErr))
			if err != nil {
				return summary, err
			}
			addPersisted(&summary, persisted)
			if scored(target) {
				if err := modeledResults.record(target, persisted); err != nil {
					return summary, err
				}
			}
			continue
		}
		// Summary stability needs no sender oracle. It asks whether a summariser
		// represents this message consistently, which is a question about the
		// message; the Fact Contract only exists to score comprehension against
		// declared intent. Gating it on a contract would make the check
		// unreachable for the campaigns that arrive without one, which is most
		// of them — a check that only runs on the campaigns least likely to need
		// it is a check that does not run.
		if target.SourceClass == campaignassurance.SourceModeled &&
			!modeledPreparations.isSummaryStability(target.ConfigurationID) {
			if !modelContractSet {
				modelContract, modelContractErr = normalizedFactContract(frozen.revision.FactContract)
				modelContractSet = true
			}
			if modelContractErr != nil {
				persisted, err := w.recordUnavailable(ctx, claimed, target, modeledFactContractUnavailableSpec())
				if err != nil {
					return summary, err
				}
				addPersisted(&summary, persisted)
				if scored(target) {
					if err := modeledResults.record(target, persisted); err != nil {
						return summary, err
					}
				}
				continue
			}
		}

		cached, exists := artifactCache[target.ArtifactID]
		if !exists {
			value, loadErr := w.loadArtifact(ctx, frozen, artifactSnapshots[target.ArtifactID])
			cached = struct {
				value loadedArtifact
				err   error
			}{value: value, err: loadErr}
			artifactCache[target.ArtifactID] = cached
		}
		if cached.err != nil {
			if !permanentArtifactError(cached.err) {
				return summary, cached.err
			}
			persisted, err := w.recordUnavailable(ctx, claimed, target, artifactUnavailableSpec(cached.err))
			if err != nil {
				return summary, err
			}
			addPersisted(&summary, persisted)
			if scored(target) {
				if err := modeledResults.record(target, persisted); err != nil {
					return summary, err
				}
			}
			continue
		}
		var persisted persistedTarget
		var err error
		switch target.SourceClass {
		case campaignassurance.SourceDeterministic:
			persisted, err = w.analyzeDeterministicTarget(ctx, claimed, target, configuration, cached.value)
		case campaignassurance.SourceModeled:
			if modeledPreparations.isSummaryStability(target.ConfigurationID) {
				persisted, err = w.analyzeSummaryStabilityTarget(
					ctx, claimed, target, modeledPreparation.configuration, cached.value,
				)
			} else {
				persisted, err = w.analyzeModeledTarget(
					ctx, claimed, target, modeledPreparation.configuration,
					recoveryVocabulary(modelContract), cached.value,
				)
			}
		default:
			return summary, ErrManifestIntegrity
		}
		if err != nil {
			return summary, err
		}
		addPersisted(&summary, persisted)
		if scored(target) {
			if err := modeledResults.record(target, persisted); err != nil {
				return summary, err
			}
		}
	}
	if len(modeledResults.byArtifact) != 0 && modelContractSet && modelContractErr == nil {
		scores, findings, blockers, err := w.scoreModeledScenarios(ctx, claimed, modelContract, modeledResults)
		if err != nil {
			return summary, err
		}
		summary.modeledScores = scores
		summary.findings += findings
		summary.blockers += blockers
		summary.modeledFindings += findings
		summary.modeledBlockers += blockers
	}
	return summary, nil
}

func addPersisted(summary *executionSummary, persisted persistedTarget) {
	summary.findings += persisted.findings
	summary.blockers += persisted.blockers
	if persisted.status != campaignassurance.ExtractionComplete {
		summary.unavailable++
	}
	switch persisted.sourceClass {
	case campaignassurance.SourceDeterministic:
		summary.deterministicFindings += persisted.findings
		summary.deterministicBlockers += persisted.blockers
	case campaignassurance.SourceModeled:
		summary.modeledFindings += persisted.findings
		summary.modeledBlockers += persisted.blockers
	}
}

func (w *Worker) normalized(raw Command) (*Worker, Command, error) {
	if w == nil || w.Assurance == nil || w.Artifacts == nil || w.Objects == nil {
		return nil, Command{}, ErrInvalidWorker
	}
	worker := *w
	if worker.RawOutputs == nil {
		worker.RawOutputs, _ = worker.Objects.(RawOutputStore)
	}
	configuration := w.Config
	configuration.WorkerID = strings.TrimSpace(configuration.WorkerID)
	if configuration.LeaseTTL == 0 {
		configuration.LeaseTTL = 2 * time.Minute
	}
	if configuration.HeartbeatEvery == 0 {
		configuration.HeartbeatEvery = configuration.LeaseTTL / 3
	}
	if configuration.CleanupTimeout == 0 {
		configuration.CleanupTimeout = 5 * time.Second
	}
	if configuration.MaxModelTimeout == 0 {
		configuration.MaxModelTimeout = defaultMaxModelTimeout
	}
	if configuration.RawOutputTTL == 0 {
		configuration.RawOutputTTL = defaultRawOutputTTL
	}
	if configuration.RetryBackoff == nil {
		configuration.RetryBackoff = defaultRetryBackoff
	}
	if configuration.Now == nil {
		configuration.Now = time.Now
	}
	if configuration.MaxHTMLBytes == 0 {
		configuration.MaxHTMLBytes = campaignchecks.MaxHTMLBytes
	}
	if configuration.MaxTextBytes == 0 {
		configuration.MaxTextBytes = campaignchecks.MaxTextBytes
	}
	if configuration.MaxMIMEBytes == 0 {
		configuration.MaxMIMEBytes = campaignchecks.MaxMIMEBytes
	}
	if configuration.MaxRevisionBytes == 0 {
		configuration.MaxRevisionBytes = campaigncoverage.MaxManifestBytes * 2
	}
	if !validWorkerID(configuration.WorkerID) || configuration.LeaseTTL < time.Millisecond || configuration.LeaseTTL > maxLeaseTTL ||
		configuration.HeartbeatEvery < time.Millisecond || configuration.HeartbeatEvery >= configuration.LeaseTTL ||
		configuration.CleanupTimeout < time.Millisecond || configuration.CleanupTimeout > time.Minute ||
		configuration.MaxModelTimeout < 100*time.Millisecond || configuration.MaxModelTimeout > maximumModelTimeout ||
		configuration.RawOutputTTL < time.Minute || configuration.RawOutputTTL > maximumRawOutputTTL ||
		configuration.MaxHTMLBytes < 1 || configuration.MaxHTMLBytes > campaignchecks.MaxHTMLBytes ||
		configuration.MaxTextBytes < 1 || configuration.MaxTextBytes > campaignchecks.MaxTextBytes ||
		configuration.MaxMIMEBytes < 1 || configuration.MaxMIMEBytes > campaignchecks.MaxMIMEBytes ||
		configuration.MaxRevisionBytes < 1 || configuration.MaxRevisionBytes > campaigncoverage.MaxManifestBytes*2 {
		return nil, Command{}, ErrInvalidWorker
	}
	worker.Config = configuration
	command := raw
	var err error
	command.TenantID, err = canonicalUUID(command.TenantID)
	if err != nil {
		return nil, Command{}, ErrInvalidCommand
	}
	command.RunID, err = canonicalUUID(command.RunID)
	if err != nil {
		return nil, Command{}, ErrInvalidCommand
	}
	if len(command.DeliveryID) > 200 || !utf8.ValidString(command.DeliveryID) {
		return nil, Command{}, ErrInvalidCommand
	}
	return &worker, command, nil
}

func validateClaim(command Command, claimed *campaignassurance.ClaimedRun) error {
	if claimed == nil || claimed.Run.ClaimToken == nil || claimed.Run.State != campaignassurance.StateRunning ||
		claimed.Run.TenantID != command.TenantID || claimed.Run.ID != command.RunID || claimed.Run.AttemptCount < 1 ||
		len(claimed.Artifacts) != claimed.Run.RequiredScenarioCount ||
		len(claimed.Configurations) != claimed.Run.RequiredConfigurationCount ||
		len(claimed.Targets) != claimed.Run.RequiredExtractionCount ||
		len(claimed.Artifacts) == 0 || len(claimed.Artifacts) > campaigncoverage.MaxScenarios ||
		len(claimed.Configurations) == 0 || len(claimed.Configurations) > 64 ||
		len(claimed.Targets) == 0 || len(claimed.Targets) > 100_000 ||
		!validHash(claimed.Run.SourceHash) || !validHash(claimed.Run.PlanHash) || !validHash(claimed.Run.ArtifactSetHash) ||
		!validHash(claimed.Run.CoverageManifestHash) || !validHash(claimed.Run.ConfigurationManifestHash) ||
		!validHash(claimed.Run.TargetManifestHash) {
		return ErrManifestIntegrity
	}
	if _, err := uuid.Parse(*claimed.Run.ClaimToken); err != nil {
		return ErrManifestIntegrity
	}
	artifacts, err := validateClaimArtifacts(claimed.Run, claimed.Artifacts)
	if err != nil {
		return err
	}
	configurations, err := validateClaimConfigurations(claimed.Run, claimed.Configurations)
	if err != nil {
		return err
	}
	seenTargets := make(map[string]struct{}, len(claimed.Targets))
	seenArtifacts := make(map[string]struct{}, len(artifacts))
	seenConfigurations := make(map[string]struct{}, len(configurations))
	for index, target := range claimed.Targets {
		artifact, artifactExists := artifacts[target.ArtifactID]
		configuration, configurationExists := configurations[target.ConfigurationID]
		key := target.ArtifactID + "\x00" + target.ConfigurationID
		_, duplicate := seenTargets[key]
		if !artifactExists || !configurationExists || duplicate || target.Ordinal != index+1 ||
			target.TenantID != claimed.Run.TenantID || target.CampaignID != claimed.Run.CampaignID ||
			target.RunID != claimed.Run.ID || target.SendPlanID != claimed.Run.SendPlanID ||
			target.SourceClass != configuration.SourceClass || target.ConfigurationHash != configuration.ConfigurationHash ||
			target.OutboundMIMEHash != artifact.OutboundMIMEHash {
			return ErrManifestIntegrity
		}
		seenTargets[key] = struct{}{}
		seenArtifacts[target.ArtifactID] = struct{}{}
		seenConfigurations[target.ConfigurationID] = struct{}{}
	}
	if len(seenArtifacts) != len(artifacts) || len(seenConfigurations) != len(configurations) {
		return ErrManifestIntegrity
	}
	return nil
}

// validateClaimArtifacts binds every claimed artifact to the run identity, in
// ordinal order and without duplicates, and indexes them by artifact id.
func validateClaimArtifacts(run campaignassurance.Run, list []campaignassurance.RunArtifact) (map[string]campaignassurance.RunArtifact, error) {
	artifacts := make(map[string]campaignassurance.RunArtifact, len(list))
	for index, artifact := range list {
		if artifact.Ordinal != index+1 || artifact.TenantID != run.TenantID ||
			artifact.CampaignID != run.CampaignID || artifact.RunID != run.ID ||
			artifact.SendPlanID != run.SendPlanID || !validHash(artifact.OutboundMIMEHash) ||
			!validHash(artifact.MIMEStructureHash) {
			return nil, ErrManifestIntegrity
		}
		if _, err := uuid.Parse(artifact.ArtifactID); err != nil {
			return nil, ErrManifestIntegrity
		}
		if _, duplicate := artifacts[artifact.ArtifactID]; duplicate {
			return nil, ErrManifestIntegrity
		}
		artifacts[artifact.ArtifactID] = artifact
	}
	return artifacts, nil
}

// validateClaimConfigurations re-derives every claimed configuration hash,
// binds the configuration to the run identity, and indexes them by id.
func validateClaimConfigurations(run campaignassurance.Run, list []campaignassurance.RunConfiguration) (map[string]campaignassurance.RunConfiguration, error) {
	configurations := make(map[string]campaignassurance.RunConfiguration, len(list))
	for index, configuration := range list {
		hash, err := canonicalConfigurationHash(configuration.Configuration)
		if err != nil || hash != configuration.ConfigurationHash || configuration.Ordinal != index+1 ||
			configuration.TenantID != run.TenantID || configuration.CampaignID != run.CampaignID ||
			configuration.RunID != run.ID || !validSource(configuration.SourceClass) {
			return nil, ErrManifestIntegrity
		}
		if _, duplicate := configurations[configuration.ID]; duplicate {
			return nil, ErrManifestIntegrity
		}
		configurations[configuration.ID] = configuration
	}
	return configurations, nil
}

type leaseHeartbeat struct {
	stopOnce sync.Once
	stopCh   chan struct{}
	done     chan error
	cancel   context.CancelFunc
}

func (w *Worker) startHeartbeat(parent context.Context, claimed *campaignassurance.ClaimedRun) (context.Context, *leaseHeartbeat) {
	workContext, cancel := context.WithCancelCause(parent)
	heartbeatContext, cancelHeartbeat := context.WithCancel(parent)
	heartbeat := &leaseHeartbeat{stopCh: make(chan struct{}), done: make(chan error, 1), cancel: cancelHeartbeat}
	go func() {
		ticker := time.NewTicker(w.Config.HeartbeatEvery)
		defer ticker.Stop()
		for {
			select {
			case <-heartbeat.stopCh:
				heartbeat.done <- nil
				return
			case <-parent.Done():
				err := context.Cause(parent)
				cancel(err)
				heartbeat.done <- err
				return
			case <-ticker.C:
				_, err := w.Assurance.RenewLease(heartbeatContext, claimed.Run.TenantID, claimed.Run.ID,
					*claimed.Run.ClaimToken, claimed.Run.AttemptCount, w.Config.LeaseTTL)
				if err != nil {
					select {
					case <-heartbeat.stopCh:
						heartbeat.done <- nil
						return
					default:
					}
					if parent.Err() != nil {
						parentErr := context.Cause(parent)
						cancel(parentErr)
						heartbeat.done <- parentErr
						return
					}
					wrapped := fmt.Errorf("%w: %w", ErrHeartbeat, err)
					cancel(wrapped)
					heartbeat.done <- wrapped
					return
				}
			}
		}
	}()
	return workContext, heartbeat
}

func (h *leaseHeartbeat) stop() error {
	h.stopOnce.Do(func() {
		close(h.stopCh)
		h.cancel()
	})
	return <-h.done
}

func (w *Worker) releaseAfterFailure(parent context.Context, claimed *campaignassurance.ClaimedRun, cause error, summary executionSummary) (Result, error) {
	cleanup, cancel := context.WithTimeout(context.WithoutCancel(parent), w.Config.CleanupTimeout)
	defer cancel()
	if errors.Is(cause, campaignassurance.ErrLeaseLost) {
		return w.resolveLostLease(cleanup, claimed.Run.TenantID, claimed.Run.ID, cause, summary)
	}
	if permanentLifecycleFailure(cause) {
		run, err := w.Assurance.FailRun(cleanup, claimed.Run.TenantID, claimed.Run.ID,
			*claimed.Run.ClaimToken, claimed.Run.AttemptCount, campaignassurance.RunFailure{
				Code: "worker_receipt_rejected", Message: "the durable assurance boundary rejected a worker evidence receipt",
			})
		if errors.Is(err, campaignassurance.ErrLeaseLost) {
			return w.resolveLostLease(cleanup, claimed.Run.TenantID, claimed.Run.ID, cause, summary)
		}
		if err != nil {
			return Result{}, errors.Join(cause, fmt.Errorf("fail rejected assurance receipt: %w", err))
		}
		return resultForRun(run, summary), nil
	}
	code, message := "worker_execution_retryable", "the assurance worker encountered a retryable execution failure"
	if errors.Is(cause, context.Canceled) || errors.Is(cause, context.DeadlineExceeded) || errors.Is(cause, ErrWorkerContextCanceled) {
		code, message = "worker_execution_cancelled", "the assurance worker execution context ended before completion"
	}
	retryAt := w.Config.Now().Add(w.Config.RetryBackoff(claimed.Run.AttemptCount))
	run, err := w.Assurance.RetryRun(cleanup, claimed.Run.TenantID, claimed.Run.ID,
		*claimed.Run.ClaimToken, claimed.Run.AttemptCount, retryAt,
		campaignassurance.RunFailure{Code: code, Message: message})
	if errors.Is(err, campaignassurance.ErrLeaseLost) {
		return w.resolveLostLease(cleanup, claimed.Run.TenantID, claimed.Run.ID, cause, summary)
	}
	if err != nil {
		return Result{}, errors.Join(cause, fmt.Errorf("release assurance lease: %w", err))
	}
	result := resultForRun(run, summary)
	if run.State == campaignassurance.StateQueued {
		result.Outcome = OutcomeRequeued
		result.RetryAt = run.RetryNotBefore
	}
	return result, nil
}

func permanentLifecycleFailure(err error) bool {
	return errors.Is(err, campaignassurance.ErrInvalidReceipt) ||
		errors.Is(err, campaignassurance.ErrInvalidInput) ||
		errors.Is(err, campaignassurance.ErrIdempotencyConflict) ||
		errors.Is(err, campaignassurance.ErrSnapshotIncomplete) ||
		errors.Is(err, campaignassurance.ErrInvalidTransition)
}

func (w *Worker) failInvalidClaim(parent context.Context, claimed *campaignassurance.ClaimedRun, cause error) (Result, error) {
	if claimed == nil || claimed.Run.ClaimToken == nil {
		return Result{}, cause
	}
	cleanup, cancel := context.WithTimeout(context.WithoutCancel(parent), w.Config.CleanupTimeout)
	defer cancel()
	run, err := w.Assurance.FailRun(cleanup, claimed.Run.TenantID, claimed.Run.ID,
		*claimed.Run.ClaimToken, claimed.Run.AttemptCount, campaignassurance.RunFailure{
			Code: "worker_manifest_invalid", Message: "the claimed assurance manifest failed worker integrity validation",
		})
	if errors.Is(err, campaignassurance.ErrLeaseLost) {
		return w.resolveLostLease(cleanup, claimed.Run.TenantID, claimed.Run.ID, cause, executionSummary{})
	}
	if err != nil {
		return Result{}, errors.Join(cause, fmt.Errorf("fail invalid assurance claim: %w", err))
	}
	return resultForRun(run, executionSummary{}), nil
}

func (w *Worker) resolveUnclaimed(ctx context.Context, command Command) (Result, error) {
	run, err := w.Assurance.GetRun(ctx, command.TenantID, command.RunID)
	if errors.Is(err, campaignassurance.ErrNotFound) {
		return Result{Outcome: OutcomeDuplicate}, nil
	}
	if err != nil {
		return Result{}, fmt.Errorf("inspect unclaimed assurance run: %w", err)
	}
	result := resultForRun(run, executionSummary{})
	switch run.State {
	case campaignassurance.StateQueued:
		result.Outcome = OutcomeDeferred
		retryAt := w.Config.Now().Add(time.Second)
		if run.RetryNotBefore != nil && run.RetryNotBefore.After(retryAt) {
			retryAt = *run.RetryNotBefore
		}
		result.RetryAt = &retryAt
	case campaignassurance.StateRunning:
		result.Outcome = OutcomeDuplicate
	}
	return result, nil
}

func (w *Worker) resolveLostLease(ctx context.Context, tenantID, runID string, cause error, summary executionSummary) (Result, error) {
	run, err := w.Assurance.GetRun(ctx, tenantID, runID)
	if err != nil {
		return Result{}, errors.Join(cause, fmt.Errorf("inspect lost assurance lease: %w", err))
	}
	result := resultForRun(run, summary)
	if run.State == campaignassurance.StateRunning {
		result.Outcome = OutcomeDuplicate
	}
	return result, nil
}

func resultForRun(run *campaignassurance.Run, summary executionSummary) Result {
	result := Result{Run: run, FindingCount: summary.findings, BlockerCount: summary.blockers}
	if run == nil {
		result.Outcome = OutcomeFailed
		return result
	}
	switch run.State {
	case campaignassurance.StateComplete:
		result.Outcome = OutcomeComplete
	case campaignassurance.StateIncomplete:
		result.Outcome = OutcomeIncomplete
	case campaignassurance.StateFailed:
		result.Outcome = OutcomeFailed
	case campaignassurance.StateCancelled:
		result.Outcome = OutcomeCancelled
	case campaignassurance.StateStale:
		result.Outcome = OutcomeStale
	case campaignassurance.StateQueued:
		result.Outcome = OutcomeRequeued
		result.RetryAt = run.RetryNotBefore
	default:
		result.Outcome = OutcomeDuplicate
	}
	return result
}

func defaultRetryBackoff(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	if attempt > 7 {
		attempt = 7
	}
	delay := time.Duration(1<<(attempt-1)) * 5 * time.Second
	if delay > 5*time.Minute {
		return 5 * time.Minute
	}
	return delay
}

func canonicalUUID(value string) (string, error) {
	parsed, err := uuid.Parse(strings.TrimSpace(value))
	if err != nil {
		return "", err
	}
	return parsed.String(), nil
}

func validWorkerID(value string) bool {
	if value == "" || !utf8.ValidString(value) || utf8.RuneCountInString(value) > 200 {
		return false
	}
	for _, current := range value {
		if unicode.IsControl(current) {
			return false
		}
	}
	return true
}

func validHash(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, current := range value {
		if (current < '0' || current > '9') && (current < 'a' || current > 'f') {
			return false
		}
	}
	return true
}

func validSource(value string) bool {
	switch value {
	case campaignassurance.SourceDeterministic, campaignassurance.SourceModeled, campaignassurance.SourceControlledObservation:
		return true
	default:
		return false
	}
}
