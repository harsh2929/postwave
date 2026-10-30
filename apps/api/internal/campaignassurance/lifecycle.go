// SPDX-License-Identifier: AGPL-3.0-only

package campaignassurance

import (
	"context"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

type attemptAggregate struct {
	Terminal       int
	Successful     int
	Errors         int
	Findings       int
	Blocking       int
	InputTokens    int64
	OutputTokens   int64
	CostMicrounits int64
	LatencyMS      int64
}

func aggregateAttemptTx(ctx context.Context, tx pgx.Tx, run Run) (attemptAggregate, error) {
	var result attemptAggregate
	err := tx.QueryRow(ctx, `
SELECT count(extractions.id)::integer,
       count(extractions.id) FILTER (WHERE extractions.status = 'complete')::integer,
       count(extractions.id) FILTER (WHERE extractions.status IN ('error', 'unavailable'))::integer,
       COALESCE(sum(extractions.input_tokens), 0)::bigint,
       COALESCE(sum(extractions.output_tokens), 0)::bigint,
       COALESCE(sum(extractions.cost_microunits), 0)::bigint,
       COALESCE(sum(extractions.latency_ms), 0)::bigint
  FROM campaign_assurance_run_targets AS targets
  LEFT JOIN campaign_assurance_extractions AS extractions
    ON extractions.tenant_id = targets.tenant_id
   AND extractions.run_id = targets.run_id
   AND extractions.artifact_id = targets.artifact_id
   AND extractions.configuration_id = targets.configuration_id
   AND extractions.attempt_count = $3
 WHERE targets.tenant_id = $1::uuid AND targets.run_id = $2::uuid`,
		run.TenantID, run.ID, run.AttemptCount).Scan(
		&result.Terminal, &result.Successful, &result.Errors,
		&result.InputTokens, &result.OutputTokens, &result.CostMicrounits,
		&result.LatencyMS,
	)
	if err != nil {
		return attemptAggregate{}, err
	}
	err = tx.QueryRow(ctx, `
SELECT count(*)::integer,
       count(*) FILTER (WHERE blocking)::integer
  FROM campaign_assurance_findings
 WHERE tenant_id = $1::uuid AND run_id = $2::uuid AND attempt_count = $3`,
		run.TenantID, run.ID, run.AttemptCount).Scan(&result.Findings, &result.Blocking)
	return result, err
}

// FinalizeRun atomically fences result writers, proves target coverage, and
// derives complete versus incomplete from persisted receipts. A caller cannot
// claim completeness by supplying counts.
func (r *Repo) FinalizeRun(ctx context.Context, tenantID, runID, claimToken string, attempt int, rawInput FinalizeInput) (*Run, error) {
	if err := r.validate(); err != nil {
		return nil, err
	}
	var ok bool
	tenantID, runID, claimToken, ok = canonicalLeaseIdentity(tenantID, runID, claimToken, attempt, time.Second)
	if !ok {
		return nil, ErrInvalidLease
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
	aggregate, err := aggregateAttemptTx(ctx, tx, run)
	if err != nil {
		return nil, err
	}
	evidenceComplete := aggregate.Terminal == run.RequiredExtractionCount &&
		aggregate.Successful == run.RequiredExtractionCount && aggregate.Errors == 0
	if evidenceComplete && aggregate.Blocking > 0 && rawInput.GateDecision != GateBlock {
		return nil, fmt.Errorf("%w: persisted blocking findings require a blocked gate", ErrInvalidReceipt)
	}
	if evidenceComplete && aggregate.Blocking == 0 && rawInput.GateDecision == GateBlock {
		return nil, fmt.Errorf("%w: blocked gate requires a persisted blocking finding", ErrInvalidReceipt)
	}
	input, err := normalizeFinalizeInput(rawInput, evidenceComplete)
	if err != nil {
		return nil, err
	}
	state := StateIncomplete
	if evidenceComplete {
		state = StateComplete
	}
	var spread *float64
	if input.ScoreMin != nil {
		value := *input.ScoreMax - *input.ScoreMin
		if math.Abs(value) < 0.0000001 {
			value = 0
		}
		spread = &value
	}
	run, err = scanRun(tx.QueryRow(ctx, `
UPDATE campaign_assurance_runs AS runs
   SET state = $5,
       claim_token = NULL,
       lease_owner = NULL,
       lease_expires_at = NULL,
       heartbeat_at = NULL,
       retry_not_before = NULL,
       terminal_extraction_count = $6,
       successful_extraction_count = $7,
       extraction_error_count = $8,
       finding_count = $9,
       blocking_finding_count = $10,
       component_scores = $11::jsonb,
       overall_score = $12,
       score_min = $13,
       score_max = $14,
       score_spread = $15,
       agreement = $16,
       gate_decision = $17,
       input_tokens = $18,
       output_tokens = $19,
       cost_microunits = $20,
       latency_ms = $21,
       completed_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid
   AND state = 'running' AND claim_token = $3::uuid AND attempt_count = $4
RETURNING `+runJSON("runs"), tenantID, runID, claimToken, attempt, state,
		aggregate.Terminal, aggregate.Successful, aggregate.Errors,
		aggregate.Findings, aggregate.Blocking, nullJSON(input.ComponentScores),
		input.OverallScore, input.ScoreMin, input.ScoreMax, spread,
		input.Agreement, input.GateDecision, aggregate.InputTokens,
		aggregate.OutputTokens, aggregate.CostMicrounits, aggregate.LatencyMS))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrLeaseLost
	}
	if err != nil {
		return nil, mapInvariantError(err, ErrInvalidReceipt)
	}
	if err := appendFinalizationAuditEvents(ctx, tx, run); err != nil {
		return nil, err
	}
	// In the finalizing transaction on purpose: a webhook announcing an outcome
	// the database then rolled back is worse than no webhook at all.
	if err := appendFinalizationWebhookEvents(ctx, tx, run); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &run, nil
}

func failActiveTx(ctx context.Context, tx pgx.Tx, run Run, failure RunFailure) (Run, error) {
	aggregate, err := aggregateAttemptTx(ctx, tx, run)
	if err != nil {
		return Run{}, err
	}
	failed, err := scanRun(tx.QueryRow(ctx, `
UPDATE campaign_assurance_runs AS runs
   SET state = 'failed',
       claim_token = NULL,
       lease_owner = NULL,
       lease_expires_at = NULL,
       heartbeat_at = NULL,
       retry_not_before = NULL,
       terminal_extraction_count = $5,
       successful_extraction_count = $6,
       extraction_error_count = $7,
       finding_count = $8,
       blocking_finding_count = $9,
       gate_decision = 'unavailable',
       input_tokens = $10,
       output_tokens = $11,
       cost_microunits = $12,
       latency_ms = $13,
       error_code = $14,
       error_message = $15,
       completed_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid
   AND state = 'running' AND claim_token = $3::uuid AND attempt_count = $4
RETURNING `+runJSON("runs"), run.TenantID, run.ID, *run.ClaimToken,
		run.AttemptCount, aggregate.Terminal, aggregate.Successful,
		aggregate.Errors, aggregate.Findings, aggregate.Blocking,
		aggregate.InputTokens, aggregate.OutputTokens, aggregate.CostMicrounits,
		aggregate.LatencyMS, failure.Code, failure.Message))
	if err != nil {
		return Run{}, err
	}
	if err := appendRunAuditEvent(ctx, tx, auditAssuranceIncomplete, failed, "", nil); err != nil {
		return Run{}, err
	}
	return failed, nil
}

func (r *Repo) FailRun(ctx context.Context, tenantID, runID, claimToken string, attempt int, rawFailure RunFailure) (*Run, error) {
	if err := r.validate(); err != nil {
		return nil, err
	}
	var ok bool
	tenantID, runID, claimToken, ok = canonicalLeaseIdentity(tenantID, runID, claimToken, attempt, time.Second)
	if !ok {
		return nil, ErrInvalidLease
	}
	failure, err := normalizeFailure(rawFailure)
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
	run, err = failActiveTx(ctx, tx, run, failure)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &run, nil
}

// RetryRun releases the exact active attempt with bounded public failure
// information. Exhausting the frozen retry budget becomes terminal.
func (r *Repo) RetryRun(ctx context.Context, tenantID, runID, claimToken string, attempt int, notBefore time.Time, rawFailure RunFailure) (*Run, error) {
	if err := r.validate(); err != nil {
		return nil, err
	}
	var ok bool
	tenantID, runID, claimToken, ok = canonicalLeaseIdentity(tenantID, runID, claimToken, attempt, time.Second)
	if !ok {
		return nil, ErrInvalidLease
	}
	failure, err := normalizeFailure(rawFailure)
	if err != nil {
		return nil, err
	}
	if notBefore.IsZero() || notBefore.Before(time.Now()) {
		notBefore = time.Now()
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
	if run.AttemptCount >= run.MaxAttempts {
		run, err = failActiveTx(ctx, tx, run, failure)
	} else {
		run, err = scanRun(tx.QueryRow(ctx, `
UPDATE campaign_assurance_runs AS runs
   SET state = 'queued',
       claim_token = NULL,
       lease_owner = NULL,
       lease_expires_at = NULL,
       heartbeat_at = NULL,
       retry_not_before = $5,
       error_code = $6,
       error_message = $7
 WHERE tenant_id = $1::uuid AND id = $2::uuid
   AND state = 'running' AND claim_token = $3::uuid AND attempt_count = $4
RETURNING `+runJSON("runs"), tenantID, runID, claimToken, attempt,
			notBefore, failure.Code, failure.Message))
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &run, nil
}

// RecoverExpiredRun is a tenant-bound stale-lease repair. It never enumerates
// other tenants. Exhausted runs retain partial attempt evidence and fail with a
// fixed operator-safe reason; otherwise the exact run is requeued.
func (r *Repo) RecoverExpiredRun(ctx context.Context, tenantID, runID string, notBefore time.Time) (*Run, error) {
	if err := r.validate(); err != nil {
		return nil, err
	}
	var ok bool
	tenantID, runID, ok = canonicalUUIDPair(tenantID, runID)
	if !ok {
		return nil, ErrInvalidInput
	}
	if notBefore.IsZero() || notBefore.Before(time.Now()) {
		notBefore = time.Now()
	}
	tx, err := withWorkerTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	run, err := scanRun(tx.QueryRow(ctx, `
SELECT `+runJSON("runs")+`
  FROM campaign_assurance_runs AS runs
 WHERE runs.tenant_id = $1::uuid AND runs.id = $2::uuid
   AND runs.state = 'running' AND runs.lease_expires_at <= statement_timestamp()
 FOR UPDATE`, tenantID, runID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if run.AttemptCount >= run.MaxAttempts {
		run, err = failActiveTx(ctx, tx, run, RunFailure{
			Code:    "lease_attempts_exhausted",
			Message: "the assurance worker lease expired after the maximum number of attempts",
		})
	} else {
		run, err = scanRun(tx.QueryRow(ctx, `
UPDATE campaign_assurance_runs AS runs
   SET state = 'queued',
       claim_token = NULL,
       lease_owner = NULL,
       lease_expires_at = NULL,
       heartbeat_at = NULL,
       retry_not_before = $3,
       error_code = 'stale_lease_requeued',
       error_message = 'an expired assurance worker lease was safely requeued'
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND state = 'running'
RETURNING `+runJSON("runs"), tenantID, runID, notBefore))
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &run, nil
}

func (r *Repo) CancelRun(ctx context.Context, tenantID, runID string) (*Run, error) {
	return r.terminalApplicabilityTransition(ctx, tenantID, runID, StateCancelled)
}

func (r *Repo) MarkStale(ctx context.Context, tenantID, runID string) (*Run, error) {
	return r.terminalApplicabilityTransition(ctx, tenantID, runID, StateStale)
}

func (r *Repo) terminalApplicabilityTransition(ctx context.Context, tenantID, runID, target string) (*Run, error) {
	if err := r.validate(); err != nil {
		return nil, err
	}
	var ok bool
	tenantID, runID, ok = canonicalUUIDPair(tenantID, runID)
	if !ok || (target != StateCancelled && target != StateStale) {
		return nil, ErrInvalidInput
	}
	tx, err := dbTenant(ctx, r, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var run Run
	if target == StateCancelled {
		run, err = scanRun(tx.QueryRow(ctx, `
UPDATE campaign_assurance_runs AS runs
   SET state = 'cancelled', claim_token = NULL, lease_owner = NULL,
       lease_expires_at = NULL, heartbeat_at = NULL, retry_not_before = NULL,
       gate_decision = 'unavailable', completed_at = now(), cancelled_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND state IN ('queued', 'running')
RETURNING `+runJSON("runs"), tenantID, runID))
	} else {
		run, err = scanRun(tx.QueryRow(ctx, `
UPDATE campaign_assurance_runs AS runs
   SET state = 'stale', claim_token = NULL, lease_owner = NULL,
       lease_expires_at = NULL, heartbeat_at = NULL, retry_not_before = NULL,
       completed_at = COALESCE(completed_at, now()), stale_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid
   AND state IN ('queued', 'running', 'complete', 'incomplete')
RETURNING `+runJSON("runs"), tenantID, runID))
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrInvalidTransition
	}
	if err != nil {
		return nil, err
	}
	if target == StateStale {
		if err := appendRunAuditEvent(ctx, tx, auditAssuranceStale, run, "", nil); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &run, nil
}

func (r *Repo) GetRun(ctx context.Context, tenantID, runID string) (*Run, error) {
	if err := r.validate(); err != nil {
		return nil, err
	}
	var ok bool
	tenantID, runID, ok = canonicalUUIDPair(tenantID, runID)
	if !ok {
		return nil, ErrInvalidInput
	}
	tx, err := dbTenant(ctx, r, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	run, err := scanRun(tx.QueryRow(ctx, `
SELECT `+runJSON("runs")+` FROM campaign_assurance_runs AS runs
 WHERE runs.tenant_id = $1::uuid AND runs.id = $2::uuid`, tenantID, runID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &run, nil
}

func (r *Repo) ListRuns(ctx context.Context, tenantID, campaignID string, limit int) ([]Run, error) {
	if err := r.validate(); err != nil {
		return nil, err
	}
	var ok bool
	tenantID, campaignID, ok = canonicalUUIDPair(tenantID, campaignID)
	if !ok {
		return nil, ErrInvalidInput
	}
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	tx, err := dbTenant(ctx, r, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT `+runJSON("runs")+`
  FROM campaign_assurance_runs AS runs
 WHERE runs.tenant_id = $1::uuid AND runs.campaign_id = $2::uuid
 ORDER BY runs.run_no DESC, runs.id DESC
 LIMIT $3`, tenantID, campaignID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	values := make([]Run, 0)
	for rows.Next() {
		value, err := scanRun(rows)
		if err != nil {
			return nil, err
		}
		values = append(values, value)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return values, nil
}

func (r *Repo) GetRunManifest(ctx context.Context, tenantID, runID string) (*ClaimedRun, error) {
	if err := r.validate(); err != nil {
		return nil, err
	}
	var ok bool
	tenantID, runID, ok = canonicalUUIDPair(tenantID, runID)
	if !ok {
		return nil, ErrInvalidInput
	}
	tx, err := dbTenant(ctx, r, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	run, err := scanRun(tx.QueryRow(ctx, `
SELECT `+runJSON("runs")+` FROM campaign_assurance_runs AS runs
 WHERE runs.tenant_id = $1::uuid AND runs.id = $2::uuid`, tenantID, runID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	manifest, err := loadClaimedManifestTx(ctx, tx, run)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return manifest, nil
}

func (r *Repo) CreateOverride(ctx context.Context, tenantID, runID, actorID string, rawInput OverrideInput) (*Override, error) {
	if err := r.validate(); err != nil {
		return nil, err
	}
	var ok bool
	tenantID, runID, ok = canonicalUUIDPair(tenantID, runID)
	if !ok {
		return nil, ErrInvalidInput
	}
	var err error
	actorID, err = canonicalUUID(actorID)
	if err != nil {
		return nil, ErrInvalidInput
	}
	tx, err := db.WithTenantUser(ctx, r.Pool, tenantID, actorID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var actorRole string
	if err := tx.QueryRow(ctx, `
SELECT role
  FROM users
 WHERE tenant_id = $1::uuid AND id = $2::uuid
   AND role IN ('owner', 'admin')
 FOR SHARE`, tenantID, actorID).Scan(&actorRole); errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrUnauthorized
	} else if err != nil {
		return nil, err
	}
	input, requestHash, err := normalizeOverrideInput(rawInput, actorID, actorRole)
	if err != nil {
		return nil, err
	}
	var run Run
	run, err = scanRun(tx.QueryRow(ctx, `
SELECT `+runJSON("runs")+` FROM campaign_assurance_runs AS runs
 WHERE runs.tenant_id = $1::uuid AND runs.id = $2::uuid
   AND runs.state IN ('complete', 'incomplete')
 FOR SHARE`, tenantID, runID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrInvalidTransition
	}
	if err != nil {
		return nil, err
	}
	var findingReceiptHash string
	if err := tx.QueryRow(ctx, `
SELECT receipt_hash
  FROM campaign_assurance_findings
 WHERE tenant_id = $1::uuid AND run_id = $2::uuid
   AND attempt_count = $3 AND id = $4::uuid`,
		tenantID, runID, run.AttemptCount, input.FindingID).Scan(&findingReceiptHash); errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	} else if err != nil {
		return nil, err
	}
	created := true
	override, err := scanOverride(tx.QueryRow(ctx, `
INSERT INTO campaign_assurance_overrides (
    tenant_id, campaign_id, run_id, attempt_count, finding_id,
    finding_receipt_hash, request_id, request_hash, artifact_set_hash,
    actor_id, actor_role, decision, reason, expires_at
)
VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4, $5::uuid,
    $6, $7::uuid, $8, $9,
    $10::uuid, $11, $12, $13, $14
)
ON CONFLICT (tenant_id, run_id, request_id, finding_id) DO NOTHING
RETURNING `+tenantJSON("campaign_assurance_overrides"), tenantID, run.CampaignID,
		runID, run.AttemptCount, input.FindingID, findingReceiptHash,
		input.RequestID, requestHash, run.ArtifactSetHash, actorID,
		actorRole, input.Decision, input.Reason, input.ExpiresAt))
	if errors.Is(err, pgx.ErrNoRows) {
		override, err = scanOverride(tx.QueryRow(ctx, `
SELECT `+tenantJSON("overrides")+`
  FROM campaign_assurance_overrides AS overrides
 WHERE overrides.tenant_id = $1::uuid AND overrides.run_id = $2::uuid
   AND overrides.request_id = $3::uuid AND overrides.finding_id = $4::uuid`,
			tenantID, runID, input.RequestID, input.FindingID))
		if err != nil {
			return nil, err
		}
		if override.RequestHash != requestHash {
			return nil, ErrIdempotencyConflict
		}
		created = false
	}
	if err != nil {
		return nil, mapInvariantError(err, ErrOverrideNotAllowed)
	}
	if created {
		if err := appendRunAuditEvent(
			ctx, tx, auditAssuranceOverridden, run, actorID, &override,
		); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &override, nil
}

func (r *Repo) ListOverrides(ctx context.Context, tenantID, runID string) ([]Override, error) {
	if err := r.validate(); err != nil {
		return nil, err
	}
	var ok bool
	tenantID, runID, ok = canonicalUUIDPair(tenantID, runID)
	if !ok {
		return nil, ErrInvalidInput
	}
	tx, err := dbTenant(ctx, r, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT `+tenantJSON("overrides")+`
  FROM campaign_assurance_overrides AS overrides
 WHERE overrides.tenant_id = $1::uuid AND overrides.run_id = $2::uuid
 ORDER BY overrides.created_at, overrides.id`, tenantID, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	values := make([]Override, 0)
	for rows.Next() {
		value, err := scanOverride(rows)
		if err != nil {
			return nil, err
		}
		values = append(values, value)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return values, nil
}
