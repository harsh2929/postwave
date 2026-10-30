// SPDX-License-Identifier: AGPL-3.0-only

package campaignassurance

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

func modeledLedgerJSON(alias string) string {
	return alias + `.tenant_id::text, ` + alias + `.claim_token::text,
(to_jsonb(` + alias + `) - ARRAY['tenant_id', 'claim_token'])`
}

func scanModeledReservation(row pgx.Row) (ModeledInvocationReservation, error) {
	var value ModeledInvocationReservation
	var raw []byte
	if err := row.Scan(&value.TenantID, &value.ClaimToken, &raw); err != nil {
		return ModeledInvocationReservation{}, err
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		return ModeledInvocationReservation{}, err
	}
	return value, nil
}

func scanModeledResult(row pgx.Row) (ModeledInvocationResult, error) {
	var value ModeledInvocationResult
	var raw []byte
	if err := row.Scan(&value.TenantID, &value.ClaimToken, &raw); err != nil {
		return ModeledInvocationResult{}, err
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		return ModeledInvocationResult{}, err
	}
	return value, nil
}

func normalizeModeledCacheLookup(input ModeledCacheLookupInput) (ModeledCacheLookupInput, error) {
	var err error
	input.ArtifactID, err = canonicalUUID(input.ArtifactID)
	input.ConfigurationID = strings.TrimSpace(input.ConfigurationID)
	input.ConfigurationHash = strings.TrimSpace(input.ConfigurationHash)
	input.OutboundMIMEHash = strings.TrimSpace(input.OutboundMIMEHash)
	input.CacheKey = strings.TrimSpace(input.CacheKey)
	input.InputManifestHash = strings.TrimSpace(input.InputManifestHash)
	if err != nil || !configurationPattern.MatchString(input.ConfigurationID) ||
		!hashPattern.MatchString(input.ConfigurationHash) || !hashPattern.MatchString(input.OutboundMIMEHash) ||
		!hashPattern.MatchString(input.CacheKey) || !hashPattern.MatchString(input.InputManifestHash) {
		return ModeledCacheLookupInput{}, fmt.Errorf("%w: invalid modeled cache identity", ErrInvalidReceipt)
	}
	return input, nil
}

func normalizeModeledReservation(input ModeledInvocationReservationInput) (ModeledInvocationReservationInput, error) {
	lookup, err := normalizeModeledCacheLookup(ModeledCacheLookupInput{
		ArtifactID: input.ArtifactID, ConfigurationID: input.ConfigurationID,
		ConfigurationHash: input.ConfigurationHash, OutboundMIMEHash: input.OutboundMIMEHash,
		CacheKey: input.CacheKey, InputManifestHash: input.InputManifestHash,
	})
	input.InvocationID = strings.TrimSpace(input.InvocationID)
	if err != nil || !hashPattern.MatchString(input.InvocationID) || input.ReservedMicrounits < 1 ||
		input.ReservedMicrounits > MaximumModeledInvocationCostMicrounits {
		return ModeledInvocationReservationInput{}, fmt.Errorf("%w: invalid modeled reservation", ErrInvalidReceipt)
	}
	input.ArtifactID = lookup.ArtifactID
	input.ConfigurationID = lookup.ConfigurationID
	input.ConfigurationHash = lookup.ConfigurationHash
	input.OutboundMIMEHash = lookup.OutboundMIMEHash
	input.CacheKey = lookup.CacheKey
	input.InputManifestHash = lookup.InputManifestHash
	return input, nil
}

type modeledInvocationResultReceipt struct {
	InvocationID   string `json:"invocation_id"`
	Status         string `json:"status"`
	InputTokens    int64  `json:"input_tokens"`
	OutputTokens   int64  `json:"output_tokens"`
	CostMicrounits int64  `json:"cost_microunits"`
	LatencyMS      int64  `json:"latency_ms"`
	ReasonCode     string `json:"reason_code"`
}

func normalizeModeledResult(input ModeledInvocationResultInput) (ModeledInvocationResultInput, string, error) {
	input.InvocationID = strings.TrimSpace(input.InvocationID)
	input.ReasonCode = strings.TrimSpace(input.ReasonCode)
	const maximumUsage = int64(1_000_000_000_000)
	if !hashPattern.MatchString(input.InvocationID) || input.InputTokens < 0 || input.InputTokens > maximumUsage ||
		input.OutputTokens < 0 || input.OutputTokens > maximumUsage || input.CostMicrounits < 0 ||
		input.CostMicrounits > MaximumModeledInvocationCostMicrounits || input.LatencyMS < 0 || input.LatencyMS > maximumUsage {
		return ModeledInvocationResultInput{}, "", fmt.Errorf("%w: invalid modeled invocation usage", ErrInvalidReceipt)
	}
	switch input.Status {
	case InvocationResultComplete:
		if input.ReasonCode != "" {
			return ModeledInvocationResultInput{}, "", fmt.Errorf("%w: completed invocation has a failure reason", ErrInvalidReceipt)
		}
	case InvocationResultError, InvocationResultUnavailable:
		if !failureCodePattern.MatchString(input.ReasonCode) {
			return ModeledInvocationResultInput{}, "", fmt.Errorf("%w: modeled invocation failure reason is invalid", ErrInvalidReceipt)
		}
	case InvocationResultChargeUnknown:
		if !failureCodePattern.MatchString(input.ReasonCode) || input.InputTokens != 0 || input.OutputTokens != 0 ||
			input.CostMicrounits != 0 {
			return ModeledInvocationResultInput{}, "", fmt.Errorf("%w: unknown-charge invocation fabricated usage", ErrInvalidReceipt)
		}
	default:
		return ModeledInvocationResultInput{}, "", fmt.Errorf("%w: modeled invocation status is invalid", ErrInvalidReceipt)
	}
	receiptHash, err := digest(modeledInvocationResultReceipt(input))
	return input, receiptHash, err
}

// ReserveModeledInvocation atomically consumes the frozen worst-case cost
// before a provider call. Reservations are never released: an interrupted call
// can still have been billed, so retry attempts must consume fresh headroom.
func (r *Repo) ReserveModeledInvocation(
	ctx context.Context,
	tenantID, runID, claimToken string,
	attempt int,
	rawInput ModeledInvocationReservationInput,
) (*ModeledInvocationReservation, error) {
	if err := r.validate(); err != nil {
		return nil, err
	}
	var ok bool
	tenantID, runID, claimToken, ok = canonicalLeaseIdentity(tenantID, runID, claimToken, attempt, time.Second)
	if !ok {
		return nil, ErrInvalidLease
	}
	input, err := normalizeModeledReservation(rawInput)
	if err != nil {
		return nil, err
	}
	tx, err := withWorkerTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	run, err := lockActiveAttemptTx(ctx, tx, tenantID, runID, claimToken, attempt, "UPDATE")
	if err != nil {
		return nil, err
	}

	existing, existingErr := scanModeledReservation(tx.QueryRow(ctx, `
SELECT `+modeledLedgerJSON("reservations")+`
  FROM campaign_assurance_model_invocation_reservations AS reservations
 WHERE reservations.tenant_id = $1::uuid AND reservations.run_id = $2::uuid
   AND reservations.invocation_id = $3`, tenantID, runID, input.InvocationID))
	if existingErr == nil {
		if existing.AttemptCount != attempt || existing.ClaimToken != claimToken ||
			existing.ModeledInvocationReservationInput != input {
			return nil, ErrIdempotencyConflict
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return &existing, nil
	}
	if !errors.Is(existingErr, pgx.ErrNoRows) {
		return nil, existingErr
	}

	var frozenReservation int64
	if err := tx.QueryRow(ctx, `
SELECT COALESCE(NULLIF(configuration.configuration->>'maximum_cost_microunits', '')::bigint, 0)
  FROM campaign_assurance_run_targets AS target
  JOIN campaign_assurance_run_configurations AS configuration
    ON configuration.tenant_id = target.tenant_id
   AND configuration.run_id = target.run_id
   AND configuration.configuration_id = target.configuration_id
 WHERE target.tenant_id = $1::uuid AND target.run_id = $2::uuid
   AND target.artifact_id = $3::uuid AND target.configuration_id = $4
   AND target.source_class = 'modeled' AND target.configuration_hash = $5
   AND target.outbound_mime_hash = $6
 FOR SHARE`, tenantID, runID, input.ArtifactID, input.ConfigurationID,
		input.ConfigurationHash, input.OutboundMIMEHash).Scan(&frozenReservation); errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("%w: reservation target is not modeled", ErrInvalidReceipt)
	} else if err != nil {
		return nil, err
	}
	if frozenReservation != input.ReservedMicrounits {
		return nil, fmt.Errorf("%w: reservation differs from frozen modeled configuration", ErrInvalidReceipt)
	}
	var alreadyReserved int64
	if err := tx.QueryRow(ctx, `
SELECT COALESCE(sum(reserved_microunits), 0)::bigint
  FROM campaign_assurance_model_invocation_reservations
 WHERE tenant_id = $1::uuid AND run_id = $2::uuid`, tenantID, runID).Scan(&alreadyReserved); err != nil {
		return nil, err
	}
	if input.ReservedMicrounits > run.MaxModeledCostMicrounits ||
		alreadyReserved > run.MaxModeledCostMicrounits-input.ReservedMicrounits {
		return nil, ErrCostBudgetExceeded
	}
	reservation, err := scanModeledReservation(tx.QueryRow(ctx, `
INSERT INTO campaign_assurance_model_invocation_reservations (
    tenant_id, campaign_id, run_id, attempt_count, claim_token,
    invocation_id, model_cache_key, model_input_manifest_hash,
    artifact_id, configuration_id, configuration_hash, outbound_mime_hash,
    reserved_microunits
)
VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4, $5::uuid,
    $6, $7, $8, $9::uuid, $10, $11, $12, $13
)
RETURNING `+modeledLedgerJSON("campaign_assurance_model_invocation_reservations"),
		tenantID, run.CampaignID, run.ID, attempt, claimToken,
		input.InvocationID, input.CacheKey, input.InputManifestHash,
		input.ArtifactID, input.ConfigurationID, input.ConfigurationHash,
		input.OutboundMIMEHash, input.ReservedMicrounits))
	if err != nil {
		return nil, mapInvariantError(err, ErrInvalidReceipt)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &reservation, nil
}

// RecordModeledInvocationResult settles known metering without changing the
// reservation. An absent result remains an auditable unknown-charge call.
func (r *Repo) RecordModeledInvocationResult(
	ctx context.Context,
	tenantID, runID, claimToken string,
	attempt int,
	rawInput ModeledInvocationResultInput,
) (*ModeledInvocationResult, error) {
	if err := r.validate(); err != nil {
		return nil, err
	}
	var ok bool
	tenantID, runID, claimToken, ok = canonicalLeaseIdentity(tenantID, runID, claimToken, attempt, time.Second)
	if !ok {
		return nil, ErrInvalidLease
	}
	input, receiptHash, err := normalizeModeledResult(rawInput)
	if err != nil {
		return nil, err
	}
	tx, err := withWorkerTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	run, err := lockActiveAttemptTx(ctx, tx, tenantID, runID, claimToken, attempt, "SHARE")
	if err != nil {
		return nil, err
	}
	result, err := scanModeledResult(tx.QueryRow(ctx, `
INSERT INTO campaign_assurance_model_invocation_results (
    tenant_id, campaign_id, run_id, attempt_count, claim_token,
    invocation_id, status, input_tokens, output_tokens, cost_microunits,
    latency_ms, reason_code, receipt_hash
)
VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4, $5::uuid,
    $6, $7, $8, $9, $10, $11, $12, $13
)
ON CONFLICT (tenant_id, run_id, invocation_id) DO NOTHING
RETURNING `+modeledLedgerJSON("campaign_assurance_model_invocation_results"),
		tenantID, run.CampaignID, run.ID, attempt, claimToken,
		input.InvocationID, input.Status, input.InputTokens, input.OutputTokens,
		input.CostMicrounits, input.LatencyMS, nullString(input.ReasonCode), receiptHash))
	if errors.Is(err, pgx.ErrNoRows) {
		result, err = scanModeledResult(tx.QueryRow(ctx, `
SELECT `+modeledLedgerJSON("results")+`
  FROM campaign_assurance_model_invocation_results AS results
 WHERE results.tenant_id = $1::uuid AND results.run_id = $2::uuid
   AND results.invocation_id = $3`, tenantID, runID, input.InvocationID))
		if err == nil && (result.ReceiptHash != receiptHash || result.AttemptCount != attempt || result.ClaimToken != claimToken) {
			return nil, ErrIdempotencyConflict
		}
	}
	if err != nil {
		return nil, mapInvariantError(err, ErrInvalidReceipt)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &result, nil
}

func scanReusableModeled(row pgx.Row) (ReusableModeledExtraction, error) {
	var result ReusableModeledExtraction
	var raw []byte
	if err := row.Scan(&result.SourceRunID, &result.Extraction.TenantID,
		&result.Extraction.ClaimToken, &raw); err != nil {
		return ReusableModeledExtraction{}, err
	}
	if err := json.Unmarshal(raw, &result.Extraction); err != nil {
		return ReusableModeledExtraction{}, err
	}
	return result, nil
}

// FindReusableModeledExtraction returns only an invoked origin from a complete,
// exact-provenance run. The caller must still hash-verify the retained object,
// after which RecordModeledCacheReuse atomically rechecks eligibility.
func (r *Repo) FindReusableModeledExtraction(
	ctx context.Context,
	tenantID, runID, claimToken string,
	attempt int,
	rawInput ModeledCacheLookupInput,
) (*ReusableModeledExtraction, error) {
	if err := r.validate(); err != nil {
		return nil, err
	}
	var ok bool
	tenantID, runID, claimToken, ok = canonicalLeaseIdentity(tenantID, runID, claimToken, attempt, time.Second)
	if !ok {
		return nil, ErrInvalidLease
	}
	input, err := normalizeModeledCacheLookup(rawInput)
	if err != nil {
		return nil, err
	}
	tx, err := withWorkerTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	current, err := lockActiveAttemptTx(ctx, tx, tenantID, runID, claimToken, attempt, "SHARE")
	if err != nil {
		return nil, err
	}
	value, err := scanReusableModeled(tx.QueryRow(ctx, `
SELECT source_runs.id::text,
       extractions.tenant_id::text,
       extractions.claim_token::text,
       (to_jsonb(extractions) - ARRAY['tenant_id', 'claim_token'])
  FROM campaign_assurance_extractions AS extractions
  JOIN campaign_assurance_runs AS source_runs
    ON source_runs.tenant_id = extractions.tenant_id
   AND source_runs.campaign_id = extractions.campaign_id
   AND source_runs.id = extractions.run_id
   AND source_runs.attempt_count = extractions.attempt_count
  JOIN campaign_assurance_model_invocation_results AS results
    ON results.tenant_id = extractions.tenant_id
   AND results.run_id = extractions.run_id
   AND results.invocation_id = extractions.model_invocation_id
 WHERE extractions.tenant_id = $1::uuid
   AND extractions.run_id <> $2::uuid
   AND extractions.artifact_id = $3::uuid
   AND extractions.configuration_id = $4
   AND extractions.configuration_hash = $5
   AND extractions.outbound_mime_hash = $6
   AND extractions.model_cache_key = $7
   AND extractions.model_input_manifest_hash = $8
   AND extractions.source_class = 'modeled'
   AND extractions.status = 'complete'
   AND extractions.execution_kind = 'invoked'
   AND extractions.reused_from_extraction_id IS NULL
   AND extractions.raw_output_object_ref IS NOT NULL
   AND extractions.raw_output_hash IS NOT NULL
   AND extractions.raw_output_expires_at > statement_timestamp()
   AND results.status = 'complete'
   AND results.input_tokens = extractions.input_tokens
   AND results.output_tokens = extractions.output_tokens
   AND results.cost_microunits = extractions.cost_microunits
   AND source_runs.state = 'complete'
   AND source_runs.campaign_id = $9::uuid
   AND source_runs.content_revision_id = $10::uuid
   AND source_runs.send_plan_id = $11::uuid
   AND source_runs.source_hash = $12
   AND source_runs.plan_hash = $13
   AND source_runs.artifact_set_hash = $14
   AND source_runs.coverage_manifest_hash = $15
   AND source_runs.configuration_manifest_hash = $16
   AND source_runs.target_manifest_hash = $17
   AND source_runs.renderer_version = $18
   AND source_runs.compiler_version = $19
   AND source_runs.fixture_set_version = $20
   AND source_runs.plan_policy_version = $21
   AND source_runs.analyzer_suite_version = $22
   AND source_runs.model_suite_version = $23
   AND source_runs.prompt_suite_version = $24
   AND source_runs.prompt_suite_hash = $25
   AND source_runs.normalization_version = $26
   AND source_runs.scoring_version = $27
   AND source_runs.gate_policy_version = $28
   AND source_runs.methodology_version = $29
 ORDER BY source_runs.completed_at DESC, extractions.created_at DESC, extractions.id DESC
 LIMIT 1
 FOR SHARE OF source_runs, extractions`, tenantID, runID,
		input.ArtifactID, input.ConfigurationID, input.ConfigurationHash,
		input.OutboundMIMEHash, input.CacheKey, input.InputManifestHash,
		current.CampaignID, current.ContentRevisionID, current.SendPlanID,
		current.SourceHash, current.PlanHash, current.ArtifactSetHash,
		current.CoverageManifestHash, current.ConfigurationManifestHash,
		current.TargetManifestHash, current.RendererVersion, current.CompilerVersion,
		current.FixtureSetVersion, current.PlanPolicyVersion, current.AnalyzerSuiteVersion,
		current.ModelSuiteVersion, current.PromptSuiteVersion, current.PromptSuiteHash,
		current.NormalizationVersion, current.ScoringVersion, current.GatePolicyVersion,
		current.MethodologyVersion))
	if errors.Is(err, pgx.ErrNoRows) {
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &value, nil
}

// RecordModeledCacheReuse inserts the current receipt and source lineage in one
// transaction after rechecking every mutable eligibility fact under row locks.
func (r *Repo) RecordModeledCacheReuse(
	ctx context.Context,
	tenantID, runID, claimToken string,
	attempt int,
	rawInput ModeledCacheReuseInput,
) (*Extraction, error) {
	if err := r.validate(); err != nil {
		return nil, err
	}
	var ok bool
	tenantID, runID, claimToken, ok = canonicalLeaseIdentity(tenantID, runID, claimToken, attempt, time.Second)
	if !ok {
		return nil, ErrInvalidLease
	}
	sourceID, err := canonicalUUID(rawInput.SourceExtractionID)
	if err != nil || !hashPattern.MatchString(strings.TrimSpace(rawInput.SourceReceiptHash)) {
		return nil, fmt.Errorf("%w: invalid modeled cache source", ErrInvalidReceipt)
	}
	input, receiptHash, err := normalizeExtractionInput(rawInput.Extraction)
	if err != nil {
		return nil, err
	}
	if input.ExecutionKind != ModeledExecutionCacheReuse || input.ReusedFromExtractionID != sourceID ||
		input.ReusedFromReceiptHash != strings.TrimSpace(rawInput.SourceReceiptHash) {
		return nil, fmt.Errorf("%w: modeled cache lineage mismatch", ErrInvalidReceipt)
	}
	tx, err := withWorkerTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	current, err := lockActiveAttemptTx(ctx, tx, tenantID, runID, claimToken, attempt, "SHARE")
	if err != nil {
		return nil, err
	}
	var eligible bool
	err = tx.QueryRow(ctx, `
SELECT true
  FROM campaign_assurance_extractions AS source
  JOIN campaign_assurance_runs AS source_run
    ON source_run.tenant_id = source.tenant_id
   AND source_run.campaign_id = source.campaign_id
   AND source_run.id = source.run_id
   AND source_run.attempt_count = source.attempt_count
  JOIN campaign_assurance_model_invocation_results AS result
    ON result.tenant_id = source.tenant_id
   AND result.run_id = source.run_id
   AND result.invocation_id = source.model_invocation_id
 WHERE source.tenant_id = $1::uuid AND source.id = $2::uuid
   AND source.receipt_hash = $3 AND source.status = 'complete'
   AND source.source_class = 'modeled' AND source.execution_kind = 'invoked'
   AND source.reused_from_extraction_id IS NULL
   AND source.artifact_id = $4::uuid AND source.configuration_id = $5
   AND source.configuration_hash = $6 AND source.outbound_mime_hash = $7
   AND source.model_cache_key = $8 AND source.model_input_manifest_hash = $9
   AND source.raw_output_object_ref = $10 AND source.raw_output_hash = $11
   AND source.raw_output_expires_at = $12 AND source.raw_output_expires_at > statement_timestamp()
   AND source.model_provider = $13 AND source.model_id = $14 AND source.model_version = $15
   AND source.prompt_version = $16 AND source.prompt_hash = $17
   AND source.seed_value IS NOT DISTINCT FROM NULLIF($18, '')
   AND source.temperature IS NOT DISTINCT FROM $19
   AND source.cost_microunits = $20
   AND result.status = 'complete'
   AND result.input_tokens = source.input_tokens
   AND result.output_tokens = source.output_tokens
   AND result.cost_microunits = source.cost_microunits
   AND source_run.state = 'complete'
   AND source_run.campaign_id = $21::uuid
   AND source_run.content_revision_id = $22::uuid
   AND source_run.send_plan_id = $23::uuid
   AND source_run.source_hash = $24 AND source_run.plan_hash = $25
   AND source_run.artifact_set_hash = $26
   AND source_run.coverage_manifest_hash = $27
   AND source_run.configuration_manifest_hash = $28
   AND source_run.target_manifest_hash = $29
   AND source_run.renderer_version = $30 AND source_run.compiler_version = $31
   AND source_run.fixture_set_version = $32 AND source_run.plan_policy_version = $33
   AND source_run.analyzer_suite_version = $34 AND source_run.model_suite_version = $35
   AND source_run.prompt_suite_version = $36 AND source_run.prompt_suite_hash = $37
   AND source_run.normalization_version = $38 AND source_run.scoring_version = $39
   AND source_run.gate_policy_version = $40 AND source_run.methodology_version = $41
 FOR SHARE OF source, source_run`, tenantID, sourceID, rawInput.SourceReceiptHash,
		input.ArtifactID, input.ConfigurationID, input.ConfigurationHash,
		input.OutboundMIMEHash, input.ModelCacheKey, input.ModelInputManifestHash,
		input.RawOutputObjectRef, input.RawOutputHash, input.RawOutputExpiresAt,
		input.ModelProvider, input.ModelID, input.ModelVersion, input.PromptVersion,
		input.PromptHash, input.SeedValue, input.Temperature,
		input.ReusedOriginalCostMicrounits, current.CampaignID,
		current.ContentRevisionID, current.SendPlanID, current.SourceHash,
		current.PlanHash, current.ArtifactSetHash, current.CoverageManifestHash,
		current.ConfigurationManifestHash, current.TargetManifestHash,
		current.RendererVersion, current.CompilerVersion, current.FixtureSetVersion,
		current.PlanPolicyVersion, current.AnalyzerSuiteVersion, current.ModelSuiteVersion,
		current.PromptSuiteVersion, current.PromptSuiteHash, current.NormalizationVersion,
		current.ScoringVersion, current.GatePolicyVersion, current.MethodologyVersion).Scan(&eligible)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	extraction, err := insertExtractionTx(ctx, tx, current, claimToken, attempt, input, receiptHash)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &extraction, nil
}
