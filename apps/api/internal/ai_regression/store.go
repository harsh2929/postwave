// SPDX-License-Identifier: AGPL-3.0-only
//
// store.go — persistence for the AI-output regression harness. Store is an
// interface so the handler tests run with a fake (no Postgres); *Repo is the
// pgx-backed implementation. All tenant-scoped reads/writes go through
// db.WithTenant (RLS-bound, app.tenant_id GUC) exactly like agent_routines.
package ai_regression

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// ErrNotFound is returned when a tenant-scoped row is absent.
var ErrNotFound = errors.New("ai_regression: not found")

// ErrRunInFlight is returned by CreateRun when a pending/running run already
// exists for the tenant (concurrent-trigger guard — spec risk "Concurrent
// regression runs").
var ErrRunInFlight = errors.New("ai_regression: a run is already in progress")

// ErrNoGoldenExamples means an atomic create observed no live examples.  It
// replaces the handler's former count-then-create race window.
var ErrNoGoldenExamples = errors.New("ai_regression: no live golden examples")

// ErrLeaseLost is returned when a claim token/attempt/status/expiry CAS no
// longer identifies the active worker attempt.
var ErrLeaseLost = errors.New("ai_regression: run lease lost")

// ErrSnapshotIncomplete means finalization found missing, duplicate, or
// otherwise inconsistent result coverage for the immutable example snapshot.
var ErrSnapshotIncomplete = errors.New("ai_regression: snapshot result coverage is incomplete")

// ErrInvalidResult means a result does not name an example in the frozen run
// snapshot or violates the bounded scoring contract.
var ErrInvalidResult = errors.New("ai_regression: invalid regression result")

// ErrInvalidFailure means a worker supplied an unsafe or unbounded public
// failure payload. Raw provider detail belongs in private logs, never here.
var ErrInvalidFailure = errors.New("ai_regression: invalid public failure")

// ErrInvalidLease means a worker identity or lease duration is outside the
// deliberately bounded lifecycle contract.
var ErrInvalidLease = errors.New("ai_regression: invalid worker lease")

const (
	maxWorkerIDLen        = 200
	maxLeaseTTL           = 24 * time.Hour
	maxResultBreakdownLen = 64 << 10
	legacyFailureCode     = "legacy_failure_details_withheld"
	legacyFailureMessage  = "legacy regression failure details were withheld"
)

var publicFailureCodePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,63}$`)

// Store is the handler-facing persistence surface. Implemented by *Repo;
// handler tests pass a fake.
type Store interface {
	// Golden examples.
	InsertGolden(ctx context.Context, tenantID string, in CaptureGoldenInput) (*GoldenExample, error)
	ListGolden(ctx context.Context, tenantID, surfaceKind string, limit int) ([]GoldenExample, error)
	CountGolden(ctx context.Context, tenantID string) (int, error)
	ArchiveGolden(ctx context.Context, tenantID, id string) error

	// Runs.
	CreateRun(ctx context.Context, tenantID string, in TriggerRunInput) (*RegressionRun, error)
	ClaimRun(ctx context.Context, workerID string, leaseTTL time.Duration) (*ClaimedRegressionRun, error)
	RenewRunLease(ctx context.Context, tenantID, runID, claimToken string, attempt int, leaseTTL time.Duration) (*RegressionRun, error)
	RetryRun(ctx context.Context, tenantID, runID, claimToken string, attempt int, notBefore time.Time, failure RunFailure) (*RegressionRun, error)
	FinalizeRun(ctx context.Context, tenantID, runID, claimToken string, attempt int) (*RegressionRun, error)
	FailRun(ctx context.Context, tenantID, runID, claimToken string, attempt int, failure RunFailure) (*RegressionRun, error)
	RequeueStaleRuns(ctx context.Context, staleBefore time.Time, limit int) (int, error)
	UpsertResult(ctx context.Context, tenantID, runID, claimToken string, attempt int, in UpsertRegressionResultInput) (*RegressionResult, error)
	ListRuns(ctx context.Context, tenantID string, limit int) ([]RegressionRun, error)
	LatestRun(ctx context.Context, tenantID string) (*RegressionRun, error)
	GetRun(ctx context.Context, tenantID, id string) (*RegressionRun, error)
	ListResults(ctx context.Context, tenantID, runID string) ([]RegressionResult, error)

	// Settings.
	GetSettings(ctx context.Context, tenantID string) (RegressionSettings, error)
	PutSettings(ctx context.Context, tenantID string, s RegressionSettings) (RegressionSettings, error)
}

// Repo implements Store on Postgres.
type Repo struct {
	Pool *db.Pool
}

// ----- golden examples -----------------------------------------------------

const goldenColumns = `
id::text, surface_kind, brief, model_id,
NULLIF(capture_request_id::text, ''), NULLIF(approval_id::text, ''),
NULLIF(agent_run_id::text, ''), created_at`

func scanGolden(row pgx.Row) (GoldenExample, error) {
	var g GoldenExample
	if err := row.Scan(&g.ID, &g.SurfaceKind, &g.Brief, &g.ModelID,
		&g.RequestID, &g.ApprovalID, &g.AgentRunID, &g.CreatedAt); err != nil {
		return GoldenExample{}, err
	}
	return g, nil
}

// InsertGolden snapshots one (brief -> approved-output) pair. model_id
// defaults to 'unknown' when absent (mirrors the column default).
func (r *Repo) InsertGolden(ctx context.Context, tenantID string, in CaptureGoldenInput) (*GoldenExample, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	modelID := in.ModelID
	if modelID == "" {
		modelID = "unknown"
	}
	g, err := scanGolden(tx.QueryRow(ctx, `
INSERT INTO ai_golden_examples (
    tenant_id, surface_kind, brief, approved_output, model_id,
    voice_profile_version, approval_id, agent_run_id, capture_request_id
)
VALUES (
    $1::uuid, $2, $3, $4, $5,
    NULLIF($6, ''), NULLIF($7, '')::uuid, NULLIF($8, '')::uuid,
    NULLIF($9, '')::uuid
)
ON CONFLICT (tenant_id, capture_request_id)
    WHERE capture_request_id IS NOT NULL
DO NOTHING
RETURNING `+goldenColumns,
		tenantID, in.SurfaceKind, in.Brief, in.ApprovedOutput, modelID,
		in.VoiceProfileVersion, in.ApprovalID, in.AgentRunID, in.RequestID))
	if errors.Is(err, pgx.ErrNoRows) && in.RequestID != "" {
		g, err = scanGolden(tx.QueryRow(ctx, `
SELECT `+goldenColumns+`
  FROM ai_golden_examples
 WHERE tenant_id = $1::uuid
   AND capture_request_id = $2::uuid`, tenantID, in.RequestID))
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &g, nil
}

// ListGolden returns the tenant's live (non-archived) golden examples,
// newest-first, optionally filtered by surface kind.
func (r *Repo) ListGolden(ctx context.Context, tenantID, surfaceKind string, limit int) ([]GoldenExample, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT `+goldenColumns+`
  FROM ai_golden_examples
 WHERE tenant_id = $1::uuid
   AND archived_at IS NULL
   AND ($2 = '' OR surface_kind = $2)
 ORDER BY created_at DESC
 LIMIT $3`, tenantID, surfaceKind, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []GoldenExample{}
	for rows.Next() {
		g, err := scanGolden(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// CountGolden returns the tenant's live golden-example count (used for
// gate eligibility + the trigger-with-zero-examples guard).
func (r *Repo) CountGolden(ctx context.Context, tenantID string) (int, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var n int
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM ai_golden_examples
 WHERE tenant_id = $1::uuid AND archived_at IS NULL`, tenantID).Scan(&n); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return n, nil
}

// ArchiveGolden soft-deletes (retires) a golden example. A retry after a
// committed archive is a successful no-op; only a tenant-scoped ID that never
// existed is ErrNotFound.
func (r *Repo) ArchiveGolden(ctx context.Context, tenantID, id string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE ai_golden_examples SET archived_at = COALESCE(archived_at, now())
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// ----- runs ----------------------------------------------------------------

const runColumns = `
id::text, tenant_id::text, runtime_provider, model_id, model_version_tag, prompt_version_tag, status,
total_examples, passed_examples, scored_examples, error_examples,
fidelity_score_mean, fidelity_score_p25,
gate_result, warn_threshold, hard_gate_enabled, hard_gate_threshold,
min_examples_for_gate, max_attempts, error_message, error_code,
started_at, completed_at, created_at, snapshot_frozen_at,
NULLIF(claim_token::text, ''), lease_owner, lease_expires_at, heartbeat_at,
attempt_count, retry_not_before, stale_at, updated_at`

func scanRun(row pgx.Row) (RegressionRun, error) {
	var rn RegressionRun
	if err := row.Scan(&rn.ID, &rn.TenantID, &rn.RuntimeProvider, &rn.ModelID,
		&rn.ModelVersionTag, &rn.PromptVersionTag,
		&rn.Status, &rn.TotalExamples, &rn.PassedExamples, &rn.ScoredExamples,
		&rn.ErrorExamples, &rn.FidelityScoreMean,
		&rn.FidelityScoreP25, &rn.GateResult, &rn.WarnThreshold, &rn.HardGateEnabled,
		&rn.HardGateThreshold, &rn.MinExamplesForGate, &rn.MaxAttempts,
		&rn.ErrorMessage, &rn.ErrorCode,
		&rn.StartedAt, &rn.CompletedAt, &rn.CreatedAt, &rn.SnapshotFrozenAt,
		&rn.ClaimToken, &rn.LeaseOwner, &rn.LeaseExpiresAt, &rn.HeartbeatAt,
		&rn.AttemptCount, &rn.RetryNotBefore, &rn.StaleAt, &rn.UpdatedAt); err != nil {
		return RegressionRun{}, err
	}
	rn.ErrorCode, rn.ErrorMessage = safeFailureForRead(rn.ErrorCode, rn.ErrorMessage)
	return rn, nil
}

// CreateRun atomically freezes tenant settings and every live golden example.
// The partial unique index is the authoritative manual/manual race guard.
func (r *Repo) CreateRun(ctx context.Context, tenantID string, in TriggerRunInput) (*RegressionRun, error) {
	runtimeProvider, modelID, modelVersionTag, promptTag, err := normalizeRunIdentity(in)
	if err != nil {
		return nil, err
	}
	tx, err := db.WithTenantOptions(ctx, r.Pool, tenantID, pgx.TxOptions{
		IsoLevel: pgx.RepeatableRead,
	})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	s, err := getSettingsTx(ctx, tx, tenantID)
	if err != nil {
		return nil, err
	}
	warn := s.WarnThreshold
	// Preserve the historical wire convention: a nil threshold means the
	// snapshotted hard gate was disabled.
	var hardGate *float64
	if s.HardGateEnabled {
		hg := s.HardGateThreshold
		hardGate = &hg
	}
	rn, err := scanRun(tx.QueryRow(ctx, `
INSERT INTO ai_regression_runs (
    tenant_id, runtime_provider, model_id, model_version_tag, prompt_version_tag, status,
    total_examples, warn_threshold, hard_gate_enabled, hard_gate_threshold,
    min_examples_for_gate, max_attempts, snapshot_frozen_at
)
VALUES ($1::uuid, $2, $3, $4, $5, 'pending', 0, $6, $7, $8, $9, $10, NULL)
RETURNING `+runColumns,
		tenantID, runtimeProvider, modelID, modelVersionTag, promptTag, warn,
		s.HardGateEnabled, hardGate, s.MinExamplesForGate, DefaultRunMaxAttempts))
	if err != nil {
		if isActiveRunUniqueViolation(err) {
			return nil, ErrRunInFlight
		}
		return nil, err
	}

	tag, err := tx.Exec(ctx, `
INSERT INTO ai_regression_run_examples (
    tenant_id, run_id, example_id, ordinal, surface_kind, brief,
    approved_output, source_model_id, voice_profile_version, approval_id,
    agent_run_id, source_created_at
)
SELECT examples.tenant_id,
       $2::uuid,
       examples.id,
       (row_number() OVER (ORDER BY examples.created_at, examples.id))::integer,
       examples.surface_kind,
       examples.brief,
       examples.approved_output,
       examples.model_id,
       examples.voice_profile_version,
       examples.approval_id,
       examples.agent_run_id,
       examples.created_at
  FROM ai_golden_examples AS examples
 WHERE examples.tenant_id = $1::uuid
   AND examples.archived_at IS NULL
 ORDER BY examples.created_at, examples.id`, tenantID, rn.ID)
	if err != nil {
		return nil, err
	}
	totalExamples := int(tag.RowsAffected())
	if totalExamples == 0 {
		return nil, ErrNoGoldenExamples
	}

	rn, err = scanRun(tx.QueryRow(ctx, `
UPDATE ai_regression_runs
   SET total_examples = $3,
       snapshot_frozen_at = now()
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
   AND status = 'pending'
   AND snapshot_frozen_at IS NULL
RETURNING `+runColumns, tenantID, rn.ID, totalExamples))
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &rn, nil
}

func isActiveRunUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505" &&
		pgErr.ConstraintName == "ai_regression_runs_one_active_tenant_idx"
}

func validBoundedText(value string, maxRunes int) bool {
	if value == "" || !utf8.ValidString(value) || utf8.RuneCountInString(value) > maxRunes {
		return false
	}
	for _, current := range value {
		if unicode.IsControl(current) {
			return false
		}
	}
	return true
}

// normalizeRunIdentity accepts only a complete server-attested replay
// identity. Fabricated defaults would make durable evidence look more certain
// than the runtime facts actually support.
func normalizeRunIdentity(in TriggerRunInput) (provider, modelID, modelVersionTag, promptTag string, err error) {
	provider = strings.TrimSpace(in.RuntimeProvider)
	modelID = strings.TrimSpace(in.ModelID)
	modelVersionTag = strings.TrimSpace(in.ModelVersionTag)
	promptTag = strings.TrimSpace(in.PromptVersionTag)
	if !validBoundedText(provider, 100) || !validBoundedText(modelID, 200) ||
		!validBoundedText(modelVersionTag, 160) || !validBoundedText(promptTag, 160) {
		return "", "", "", "", fmt.Errorf("ai_regression: incomplete or invalid runtime identity")
	}
	return provider, modelID, modelVersionTag, promptTag, nil
}

func safeFailureForRead(code, message *string) (*string, *string) {
	if code != nil {
		safeCode := strings.TrimSpace(*code)
		if publicFailureCodePattern.MatchString(safeCode) {
			if message == nil {
				return &safeCode, nil
			}
			safeMessage := strings.TrimSpace(*message)
			if validBoundedText(safeMessage, MaxRunFailureMessageLen) {
				return &safeCode, &safeMessage
			}
			generic := legacyFailureMessage
			return &safeCode, &generic
		}
	}
	if code == nil && message == nil {
		return nil, nil
	}
	genericCode := legacyFailureCode
	genericMessage := legacyFailureMessage
	return &genericCode, &genericMessage
}

func validLeaseInput(runID, claimToken string, attempt int, leaseTTL time.Duration) bool {
	if attempt < 1 || leaseTTL < time.Millisecond || leaseTTL > maxLeaseTTL {
		return false
	}
	if _, err := uuid.Parse(runID); err != nil {
		return false
	}
	if _, err := uuid.Parse(claimToken); err != nil {
		return false
	}
	return true
}

func settingsFromRun(run RegressionRun) RegressionSettings {
	hardThreshold := DefaultHardGateThreshold
	if run.HardGateThreshold != nil {
		hardThreshold = *run.HardGateThreshold
	}
	return RegressionSettings{
		WarnThreshold:      run.WarnThreshold,
		HardGateEnabled:    run.HardGateEnabled,
		HardGateThreshold:  hardThreshold,
		MinExamplesForGate: run.MinExamplesForGate,
	}
}

const runExampleColumns = `
run_id::text, example_id::text, ordinal, surface_kind, brief,
approved_output, source_model_id, voice_profile_version,
NULLIF(approval_id::text, ''), NULLIF(agent_run_id::text, ''),
source_created_at, snapshotted_at`

func scanRunExample(row pgx.Row) (RunExampleSnapshot, error) {
	var example RunExampleSnapshot
	err := row.Scan(
		&example.RunID, &example.ExampleID, &example.Ordinal,
		&example.SurfaceKind, &example.Brief, &example.ApprovedOutput,
		&example.SourceModelID, &example.VoiceProfileVersion,
		&example.ApprovalID, &example.AgentRunID, &example.SourceCreatedAt,
		&example.SnapshottedAt,
	)
	return example, err
}

func listRunExamplesTx(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, runID string,
) ([]RunExampleSnapshot, error) {
	rows, err := tx.Query(ctx, `
SELECT `+runExampleColumns+`
  FROM ai_regression_run_examples
 WHERE tenant_id = $1::uuid
   AND run_id = $2::uuid
 ORDER BY ordinal`, tenantID, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	examples := []RunExampleSnapshot{}
	for rows.Next() {
		example, scanErr := scanRunExample(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		examples = append(examples, example)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return examples, nil
}

// ClaimRun atomically leases the oldest eligible pending run across tenants.
// A future retry_not_before makes a pending row ineligible, and the immutable
// snapshot count must still match before a worker can observe it.
func (r *Repo) ClaimRun(ctx context.Context, workerID string, leaseTTL time.Duration) (*ClaimedRegressionRun, error) {
	workerID = strings.TrimSpace(workerID)
	if !validBoundedText(workerID, maxWorkerIDLen) || leaseTTL < time.Millisecond || leaseTTL > maxLeaseTTL {
		return nil, ErrInvalidLease
	}
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	run, err := scanRun(tx.QueryRow(ctx, `
WITH candidate AS (
    SELECT runs.id
      FROM ai_regression_runs AS runs
     WHERE runs.status = 'pending'
       AND runs.snapshot_frozen_at IS NOT NULL
       AND runs.total_examples > 0
       AND runs.attempt_count < runs.max_attempts
       AND (runs.retry_not_before IS NULL OR runs.retry_not_before <= now())
       AND runs.total_examples = (
           SELECT count(*)::integer
             FROM ai_regression_run_examples AS examples
            WHERE examples.tenant_id = runs.tenant_id
              AND examples.run_id = runs.id
       )
     ORDER BY COALESCE(runs.retry_not_before, runs.created_at), runs.created_at, runs.id
     FOR UPDATE SKIP LOCKED
     LIMIT 1
)
UPDATE ai_regression_runs AS runs
   SET status = 'running',
       claim_token = gen_random_uuid(),
       lease_owner = $1,
       lease_expires_at = now() + ($2 * interval '1 millisecond'),
       heartbeat_at = now(),
       attempt_count = runs.attempt_count + 1,
       retry_not_before = NULL,
       error_code = NULL,
       error_message = NULL,
       completed_at = NULL,
       started_at = COALESCE(runs.started_at, now())
 WHERE runs.id = (SELECT candidate.id FROM candidate)
RETURNING `+runColumns, workerID, leaseTTL.Milliseconds()))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	examples, err := listRunExamplesTx(ctx, tx, run.TenantID, run.ID)
	if err != nil {
		return nil, err
	}
	if len(examples) != run.TotalExamples {
		return nil, ErrSnapshotIncomplete
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &ClaimedRegressionRun{
		Run:      run,
		Examples: examples,
		Settings: settingsFromRun(run),
	}, nil
}

// RenewRunLease heartbeats one exact worker attempt. Expired or superseded
// attempts cannot resurrect themselves.
func (r *Repo) RenewRunLease(
	ctx context.Context,
	tenantID, runID, claimToken string,
	attempt int,
	leaseTTL time.Duration,
) (*RegressionRun, error) {
	if !validLeaseInput(runID, claimToken, attempt, leaseTTL) {
		return nil, ErrInvalidLease
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	run, err := scanRun(tx.QueryRow(ctx, `
UPDATE ai_regression_runs
   SET heartbeat_at = now(),
       lease_expires_at = now() + ($5 * interval '1 millisecond')
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
   AND status = 'running'
   AND claim_token = $3::uuid
   AND attempt_count = $4
   AND lease_expires_at > now()
RETURNING `+runColumns, tenantID, runID, claimToken, attempt, leaseTTL.Milliseconds()))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrLeaseLost
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &run, nil
}

func normalizePublicFailure(failure RunFailure) (RunFailure, error) {
	failure.Code = strings.TrimSpace(failure.Code)
	failure.Message = strings.TrimSpace(failure.Message)
	if !publicFailureCodePattern.MatchString(failure.Code) ||
		!validBoundedText(failure.Message, MaxRunFailureMessageLen) {
		return RunFailure{}, ErrInvalidFailure
	}
	return failure, nil
}

type terminalAttemptReceipt struct {
	passed int
	scored int
	errors int
	mean   *float64
	p25    *float64
}

// lockActiveRunAttemptTx fences result writers before a terminal receipt is
// calculated. UpsertResult's snapshot guard takes a key-share lock on this
// row; taking the stronger update lock here guarantees that either an in-flight
// result is included or it observes the terminal status and is rejected.
func lockActiveRunAttemptTx(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, runID, claimToken string,
	attempt int,
) (RegressionRun, error) {
	run, err := scanRun(tx.QueryRow(ctx, `
SELECT `+runColumns+`
  FROM ai_regression_runs
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
   AND status = 'running'
   AND claim_token = $3::uuid
   AND attempt_count = $4
   AND lease_expires_at > now()
 FOR UPDATE`, tenantID, runID, claimToken, attempt))
	if errors.Is(err, pgx.ErrNoRows) {
		return RegressionRun{}, ErrLeaseLost
	}
	return run, err
}

// terminalAttemptReceiptTx derives a failed attempt's immutable summary from
// the rows that were actually persisted for that exact attempt. Missing
// snapshot members are intentionally not reclassified as errors: they have no
// result receipt and remain unprocessed evidence in the API/UI.
func terminalAttemptReceiptTx(
	ctx context.Context,
	tx pgx.Tx,
	run RegressionRun,
) (terminalAttemptReceipt, error) {
	var receipt terminalAttemptReceipt
	var resultCount int
	err := tx.QueryRow(ctx, `
SELECT count(results.id)::integer,
       count(results.fidelity_score)::integer,
       count(results.fidelity_score) FILTER (
           WHERE results.fidelity_score >= $4
       )::integer,
       avg(results.fidelity_score)::float8,
       percentile_disc(0.25) WITHIN GROUP (
           ORDER BY results.fidelity_score
       )::float8
  FROM ai_regression_run_examples AS examples
  LEFT JOIN ai_regression_results AS results
    ON results.tenant_id = examples.tenant_id
   AND results.run_id = examples.run_id
   AND results.example_id = examples.example_id
   AND results.attempt_count = $3
 WHERE examples.tenant_id = $1::uuid
   AND examples.run_id = $2::uuid`,
		run.TenantID, run.ID, run.AttemptCount, run.WarnThreshold,
	).Scan(&resultCount, &receipt.scored, &receipt.passed, &receipt.mean, &receipt.p25)
	if err != nil {
		return terminalAttemptReceipt{}, err
	}
	receipt.errors = resultCount - receipt.scored
	return receipt, nil
}

// RetryRun releases an exact attempt after a transient dependency failure.
// The frozen max-attempt policy decides whether the CAS schedules backoff or
// becomes terminal; stale-repair is never used for ordinary retries.
func (r *Repo) RetryRun(
	ctx context.Context,
	tenantID, runID, claimToken string,
	attempt int,
	notBefore time.Time,
	failure RunFailure,
) (*RegressionRun, error) {
	if !validLeaseInput(runID, claimToken, attempt, time.Second) {
		return nil, ErrInvalidLease
	}
	failure, err := normalizePublicFailure(failure)
	if err != nil {
		return nil, err
	}
	if notBefore.IsZero() {
		notBefore = time.Now()
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	active, err := lockActiveRunAttemptTx(ctx, tx, tenantID, runID, claimToken, attempt)
	if err != nil {
		return nil, err
	}
	if active.AttemptCount >= active.MaxAttempts {
		receipt, aggregateErr := terminalAttemptReceiptTx(ctx, tx, active)
		if aggregateErr != nil {
			return nil, aggregateErr
		}
		run, updateErr := scanRun(tx.QueryRow(ctx, `
UPDATE ai_regression_runs
   SET status = 'failed',
       passed_examples = $5,
       scored_examples = $6,
       error_examples = $7,
       fidelity_score_mean = $8,
       fidelity_score_p25 = $9,
       gate_result = NULL,
       claim_token = NULL,
       lease_owner = NULL,
       lease_expires_at = NULL,
       heartbeat_at = NULL,
       retry_not_before = NULL,
       error_code = $10,
       error_message = $11,
       completed_at = now()
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
   AND status = 'running'
   AND claim_token = $3::uuid
   AND attempt_count = $4
RETURNING `+runColumns,
			tenantID, runID, claimToken, attempt, receipt.passed, receipt.scored,
			receipt.errors, receipt.mean, receipt.p25, failure.Code, failure.Message))
		if updateErr != nil {
			return nil, updateErr
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return &run, nil
	}

	run, err := scanRun(tx.QueryRow(ctx, `
UPDATE ai_regression_runs
   SET status = 'pending',
       claim_token = NULL,
       lease_owner = NULL,
       lease_expires_at = NULL,
       heartbeat_at = NULL,
       retry_not_before = $5::timestamptz,
       error_code = $6,
       error_message = $7,
       completed_at = NULL
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
   AND status = 'running'
   AND claim_token = $3::uuid
   AND attempt_count = $4
RETURNING `+runColumns,
		tenantID, runID, claimToken, attempt, notBefore, failure.Code, failure.Message))
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &run, nil
}

// FailRun terminally fails one exact, unexpired worker attempt.
func (r *Repo) FailRun(
	ctx context.Context,
	tenantID, runID, claimToken string,
	attempt int,
	failure RunFailure,
) (*RegressionRun, error) {
	if !validLeaseInput(runID, claimToken, attempt, time.Second) {
		return nil, ErrInvalidLease
	}
	failure, err := normalizePublicFailure(failure)
	if err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	active, err := lockActiveRunAttemptTx(ctx, tx, tenantID, runID, claimToken, attempt)
	if err != nil {
		return nil, err
	}
	receipt, err := terminalAttemptReceiptTx(ctx, tx, active)
	if err != nil {
		return nil, err
	}
	run, err := scanRun(tx.QueryRow(ctx, `
UPDATE ai_regression_runs
   SET status = 'failed',
       passed_examples = $5,
       scored_examples = $6,
       error_examples = $7,
       fidelity_score_mean = $8,
       fidelity_score_p25 = $9,
       gate_result = NULL,
       claim_token = NULL,
       lease_owner = NULL,
       lease_expires_at = NULL,
       heartbeat_at = NULL,
       retry_not_before = NULL,
       error_code = $10,
       error_message = $11,
       completed_at = now()
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
   AND status = 'running'
   AND claim_token = $3::uuid
   AND attempt_count = $4
RETURNING `+runColumns, tenantID, runID, claimToken, attempt, receipt.passed,
		receipt.scored, receipt.errors, receipt.mean, receipt.p25, failure.Code, failure.Message))
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &run, nil
}

// RequeueStaleRuns repairs abandoned leases across tenants. Attempts that
// have consumed their frozen retry budget become terminal instead of cycling.
func (r *Repo) RequeueStaleRuns(ctx context.Context, staleBefore time.Time, limit int) (int, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	if staleBefore.IsZero() {
		staleBefore = time.Now()
	}
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
    SELECT `+runColumns+`
      FROM ai_regression_runs
     WHERE status = 'running'
       AND (lease_expires_at <= now() OR heartbeat_at < $1::timestamptz)
     ORDER BY LEAST(lease_expires_at, heartbeat_at), id
     FOR UPDATE SKIP LOCKED
     LIMIT $2`, staleBefore, limit)
	if err != nil {
		return 0, err
	}
	staleRuns := make([]RegressionRun, 0, limit)
	for rows.Next() {
		run, scanErr := scanRun(rows)
		if scanErr != nil {
			rows.Close()
			return 0, scanErr
		}
		staleRuns = append(staleRuns, run)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, err
	}
	rows.Close()

	updated := 0
	for _, run := range staleRuns {
		// Result rows deliberately remain tenant-scoped even for a cross-tenant
		// repair tick. Rebind the current locked run before reading its receipt.
		if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, run.TenantID); err != nil {
			return 0, err
		}

		if run.AttemptCount >= run.MaxAttempts {
			receipt, aggregateErr := terminalAttemptReceiptTx(ctx, tx, run)
			if aggregateErr != nil {
				return 0, aggregateErr
			}
			tag, updateErr := tx.Exec(ctx, `
UPDATE ai_regression_runs
   SET status = 'failed',
       passed_examples = $5,
       scored_examples = $6,
       error_examples = $7,
       fidelity_score_mean = $8,
       fidelity_score_p25 = $9,
       gate_result = NULL,
       claim_token = NULL,
       lease_owner = NULL,
       lease_expires_at = NULL,
       heartbeat_at = NULL,
       retry_not_before = NULL,
       stale_at = now(),
       error_code = 'lease_attempts_exhausted',
       error_message = 'the regression worker lease expired after the maximum number of attempts',
       completed_at = now()
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
   AND status = 'running'
   AND claim_token = $3::uuid
   AND attempt_count = $4`, run.TenantID, run.ID, run.ClaimToken,
				run.AttemptCount, receipt.passed, receipt.scored, receipt.errors,
				receipt.mean, receipt.p25)
			if updateErr != nil {
				return 0, updateErr
			}
			updated += int(tag.RowsAffected())
			continue
		}

		tag, updateErr := tx.Exec(ctx, `
UPDATE ai_regression_runs
   SET status = 'pending',
       claim_token = NULL,
       lease_owner = NULL,
       lease_expires_at = NULL,
       heartbeat_at = NULL,
       retry_not_before = NULL,
       stale_at = now(),
       error_code = 'stale_lease_requeued',
       error_message = 'an expired regression worker lease was safely requeued',
       completed_at = NULL
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
   AND status = 'running'
   AND claim_token = $3::uuid
   AND attempt_count = $4`, run.TenantID, run.ID, run.ClaimToken, run.AttemptCount)
		if updateErr != nil {
			return 0, updateErr
		}
		updated += int(tag.RowsAffected())
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return updated, nil
}

const resultColumns = `
id::text, NULLIF(example_id::text, ''), attempt_count, surface_kind, replayed_output,
fidelity_score, breakdown, COALESCE(severity, ''), error_code,
error_message, scored_at`

func scanResult(row pgx.Row) (RegressionResult, error) {
	var result RegressionResult
	var breakdownRaw []byte
	err := row.Scan(
		&result.ID, &result.ExampleID, &result.AttemptCount, &result.SurfaceKind,
		&result.ReplayedOutput, &result.FidelityScore, &breakdownRaw,
		&result.Severity, &result.ErrorCode, &result.ErrorMessage,
		&result.ScoredAt,
	)
	if err == nil && len(breakdownRaw) > 0 {
		if unmarshalErr := json.Unmarshal(breakdownRaw, &result.Breakdown); unmarshalErr != nil {
			return RegressionResult{}, unmarshalErr
		}
	}
	if err == nil {
		result.ErrorCode, result.ErrorMessage = safeFailureForRead(result.ErrorCode, result.ErrorMessage)
	}
	return result, err
}

func normalizeResultInput(input UpsertRegressionResultInput) (UpsertRegressionResultInput, any, error) {
	if _, err := uuid.Parse(input.ExampleID); err != nil || !validSurfaceSeverity(input.Severity) {
		return UpsertRegressionResultInput{}, nil, ErrInvalidResult
	}
	if input.ReplayedOutput != nil &&
		(!utf8.ValidString(*input.ReplayedOutput) || utf8.RuneCountInString(*input.ReplayedOutput) > maxOutputLen) {
		return UpsertRegressionResultInput{}, nil, ErrInvalidResult
	}
	if input.FidelityScore != nil && (math.IsNaN(*input.FidelityScore) || math.IsInf(*input.FidelityScore, 0) ||
		*input.FidelityScore < 0 || *input.FidelityScore > 100) {
		return UpsertRegressionResultInput{}, nil, ErrInvalidResult
	}
	if input.ErrorCode != nil {
		code := strings.TrimSpace(*input.ErrorCode)
		if !publicFailureCodePattern.MatchString(code) {
			return UpsertRegressionResultInput{}, nil, ErrInvalidResult
		}
		input.ErrorCode = &code
	}
	if input.ErrorMessage != nil {
		message := strings.TrimSpace(*input.ErrorMessage)
		if !validBoundedText(message, MaxRunFailureMessageLen) {
			return UpsertRegressionResultInput{}, nil, ErrInvalidResult
		}
		input.ErrorMessage = &message
	}
	if input.Severity == "error" {
		if input.FidelityScore != nil || input.ErrorCode == nil || input.Breakdown != nil {
			return UpsertRegressionResultInput{}, nil, ErrInvalidResult
		}
	} else if input.FidelityScore == nil || input.ErrorCode != nil || input.ErrorMessage != nil ||
		!validResultBreakdown(input.Breakdown, *input.FidelityScore) {
		return UpsertRegressionResultInput{}, nil, ErrInvalidResult
	}
	var breakdown any
	if input.Breakdown != nil {
		encoded, err := json.Marshal(input.Breakdown)
		if err != nil || len(encoded) > maxResultBreakdownLen {
			return UpsertRegressionResultInput{}, nil, ErrInvalidResult
		}
		breakdown = string(encoded)
	}
	return input, breakdown, nil
}

func validResultBreakdown(breakdown map[string]any, score float64) bool {
	if len(breakdown) != 5 {
		return false
	}
	unitKeys := [...]string{
		"embedding_similarity",
		"stylistic_distance",
		"vocabulary_overlap",
		"structural_match",
	}
	for _, key := range unitKeys {
		value, ok := breakdown[key].(float64)
		if !ok || math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || value > 1 {
			return false
		}
	}
	combined, ok := breakdown["combined"].(float64)
	return ok && !math.IsNaN(combined) && !math.IsInf(combined, 0) &&
		combined >= 0 && combined <= 100 && math.Abs(combined-score) <= 0.000001
}

func validSurfaceSeverity(value string) bool {
	switch value {
	case "ok", "warn", "critical", "error":
		return true
	default:
		return false
	}
}

// UpsertResult is first-write-wins and tenant-qualified. Replaying the same
// example is a no-op that returns the original row, but only while the caller
// still owns the exact unexpired attempt.
func (r *Repo) UpsertResult(
	ctx context.Context,
	tenantID, runID, claimToken string,
	attempt int,
	input UpsertRegressionResultInput,
) (*RegressionResult, error) {
	if !validLeaseInput(runID, claimToken, attempt, time.Second) {
		return nil, ErrInvalidLease
	}
	input, breakdown, err := normalizeResultInput(input)
	if err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	result, err := scanResult(tx.QueryRow(ctx, `
WITH valid_attempt AS (
    SELECT examples.surface_kind
      FROM ai_regression_runs AS runs
      JOIN ai_regression_run_examples AS examples
        ON examples.tenant_id = runs.tenant_id
       AND examples.run_id = runs.id
       AND examples.example_id = $5::uuid
     WHERE runs.tenant_id = $1::uuid
       AND runs.id = $2::uuid
       AND runs.status = 'running'
       AND runs.claim_token = $3::uuid
       AND runs.attempt_count = $4
       AND runs.lease_expires_at > now()
)
INSERT INTO ai_regression_results (
    tenant_id, run_id, example_id, attempt_count, surface_kind, replayed_output,
    fidelity_score, breakdown, severity, error_code, error_message
)
SELECT $1::uuid, $2::uuid, $5::uuid, $4, valid_attempt.surface_kind, $6,
       $7, $8::jsonb, $9, $10, $11
  FROM valid_attempt
ON CONFLICT (tenant_id, run_id, attempt_count, example_id)
    WHERE example_id IS NOT NULL AND durable_receipt
DO UPDATE SET id = ai_regression_results.id
RETURNING `+resultColumns,
		tenantID, runID, claimToken, attempt, input.ExampleID,
		input.ReplayedOutput, input.FidelityScore, breakdown, input.Severity,
		input.ErrorCode, input.ErrorMessage))
	if errors.Is(err, pgx.ErrNoRows) {
		var snapshotExists bool
		lookupErr := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1
      FROM ai_regression_run_examples
     WHERE tenant_id = $1::uuid
       AND run_id = $2::uuid
       AND example_id = $3::uuid
)`, tenantID, runID, input.ExampleID).Scan(&snapshotExists)
		if lookupErr != nil {
			return nil, lookupErr
		}
		if !snapshotExists {
			return nil, ErrInvalidResult
		}
		return nil, ErrLeaseLost
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &result, nil
}

type surfaceAccumulator struct {
	total  int
	errors int
	scores []float64
}

func aggregateBySurfaceTx(
	ctx context.Context,
	tx pgx.Tx,
	run RegressionRun,
) (map[string]SurfaceResult, error) {
	rows, err := tx.Query(ctx, `
SELECT examples.surface_kind, results.fidelity_score, results.id IS NOT NULL
  FROM ai_regression_run_examples AS examples
  LEFT JOIN ai_regression_results AS results
    ON results.tenant_id = examples.tenant_id
   AND results.run_id = examples.run_id
   AND results.example_id = examples.example_id
	AND results.attempt_count = $3
 WHERE examples.tenant_id = $1::uuid
   AND examples.run_id = $2::uuid
 ORDER BY examples.surface_kind, examples.ordinal`, run.TenantID, run.ID, run.AttemptCount)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	accumulators := map[string]*surfaceAccumulator{}
	for rows.Next() {
		var surface string
		var score *float64
		var hasResult bool
		if err := rows.Scan(&surface, &score, &hasResult); err != nil {
			return nil, err
		}
		accumulator := accumulators[surface]
		if accumulator == nil {
			accumulator = &surfaceAccumulator{}
			accumulators[surface] = accumulator
		}
		accumulator.total++
		if score != nil {
			accumulator.scores = append(accumulator.scores, *score)
		} else if hasResult {
			accumulator.errors++
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	if len(accumulators) == 0 {
		// Runs completed before migration 1918 have attempt-one results but no
		// immutable membership rows. Preserve their historical aggregate rather
		// than making the API appear to have lost evidence during the upgrade.
		legacyRows, legacyErr := tx.Query(ctx, `
SELECT surface_kind, fidelity_score
  FROM ai_regression_results
 WHERE tenant_id = $1::uuid
   AND run_id = $2::uuid
   AND attempt_count = $3
 ORDER BY surface_kind, scored_at, id`, run.TenantID, run.ID, run.AttemptCount)
		if legacyErr != nil {
			return nil, legacyErr
		}
		defer legacyRows.Close()
		for legacyRows.Next() {
			var surface string
			var score *float64
			if err := legacyRows.Scan(&surface, &score); err != nil {
				return nil, err
			}
			accumulator := accumulators[surface]
			if accumulator == nil {
				accumulator = &surfaceAccumulator{}
				accumulators[surface] = accumulator
			}
			accumulator.total++
			if score != nil {
				accumulator.scores = append(accumulator.scores, *score)
			} else {
				accumulator.errors++
			}
		}
		if err := legacyRows.Err(); err != nil {
			return nil, err
		}
	}
	settings := settingsFromRun(run)
	output := make(map[string]SurfaceResult, len(accumulators))
	for surface, accumulator := range accumulators {
		var scoreTotal float64
		for _, score := range accumulator.scores {
			scoreTotal += score
		}
		var mean *float64
		if len(accumulator.scores) > 0 {
			meanValue := scoreTotal / float64(len(accumulator.scores))
			mean = &meanValue
		}
		passed := 0
		for _, score := range accumulator.scores {
			if score >= settings.WarnThreshold {
				passed++
			}
		}
		meanValue := 0.0
		if mean != nil {
			meanValue = *mean
		}
		gate := ComputeGate(GateInput{
			MeanScore:      meanValue,
			ScoredExamples: len(accumulator.scores),
			TotalExamples:  accumulator.total,
			Settings:       settings,
		})
		output[surface] = SurfaceResult{
			Total:      accumulator.total,
			Scored:     len(accumulator.scores),
			Errors:     accumulator.errors,
			Passed:     passed,
			MeanScore:  mean,
			GateResult: gate,
		}
	}
	if len(output) == 0 {
		return nil, nil
	}
	return output, nil
}

// FinalizeRun computes the authoritative aggregate inside the same
// transaction as the terminal CAS. Completion fails closed unless every
// immutable example has exactly one result and no legacy/extraneous row exists.
func (r *Repo) FinalizeRun(
	ctx context.Context,
	tenantID, runID, claimToken string,
	attempt int,
) (*RegressionRun, error) {
	if !validLeaseInput(runID, claimToken, attempt, time.Second) {
		return nil, ErrInvalidLease
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	run, err := scanRun(tx.QueryRow(ctx, `
SELECT `+runColumns+`
  FROM ai_regression_runs
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
   AND status = 'running'
   AND claim_token = $3::uuid
   AND attempt_count = $4
   AND lease_expires_at > now()
 FOR UPDATE`, tenantID, runID, claimToken, attempt))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrLeaseLost
	}
	if err != nil {
		return nil, err
	}

	var snapshotTotal, resultTotal, matchedResults, scoredExamples int
	var mean, p25 *float64
	err = tx.QueryRow(ctx, `
SELECT count(*)::integer,
       (SELECT count(*)::integer
         FROM ai_regression_results AS all_results
         WHERE all_results.tenant_id = $1::uuid
           AND all_results.run_id = $2::uuid
		   AND all_results.attempt_count = $3),
       count(results.id)::integer,
       count(results.fidelity_score)::integer,
       avg(results.fidelity_score)::float8,
	   percentile_disc(0.25) WITHIN GROUP (
           ORDER BY results.fidelity_score
       )::float8
  FROM ai_regression_run_examples AS examples
  LEFT JOIN ai_regression_results AS results
   ON results.tenant_id = examples.tenant_id
   AND results.run_id = examples.run_id
   AND results.example_id = examples.example_id
	AND results.attempt_count = $3
 WHERE examples.tenant_id = $1::uuid
   AND examples.run_id = $2::uuid`, tenantID, runID, attempt).Scan(
		&snapshotTotal, &resultTotal, &matchedResults, &scoredExamples, &mean, &p25)
	if err != nil {
		return nil, err
	}
	if snapshotTotal == 0 || snapshotTotal != run.TotalExamples ||
		resultTotal != snapshotTotal || matchedResults != snapshotTotal {
		return nil, ErrSnapshotIncomplete
	}

	meanValue := 0.0
	if mean != nil {
		meanValue = *mean
	}
	settings := settingsFromRun(run)
	gate := ComputeGate(GateInput{
		MeanScore:      meanValue,
		ScoredExamples: scoredExamples,
		TotalExamples:  snapshotTotal,
		Settings:       settings,
	})
	var passedExamples int
	if err := tx.QueryRow(ctx, `
SELECT count(*)::integer
  FROM ai_regression_results
 WHERE tenant_id = $1::uuid
   AND run_id = $2::uuid
	AND attempt_count = $3
	AND fidelity_score >= $4`, tenantID, runID, attempt, settings.WarnThreshold).Scan(&passedExamples); err != nil {
		return nil, err
	}
	bySurface, err := aggregateBySurfaceTx(ctx, tx, run)
	if err != nil {
		return nil, err
	}

	completed, err := scanRun(tx.QueryRow(ctx, `
UPDATE ai_regression_runs
   SET status = 'completed',
       passed_examples = $5,
       scored_examples = $6,
       error_examples = $7,
       fidelity_score_mean = $8,
       fidelity_score_p25 = $9,
       gate_result = $10,
       claim_token = NULL,
       lease_owner = NULL,
       lease_expires_at = NULL,
       heartbeat_at = NULL,
       retry_not_before = NULL,
       error_code = NULL,
       error_message = NULL,
       completed_at = now()
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
   AND status = 'running'
   AND claim_token = $3::uuid
   AND attempt_count = $4
   AND lease_expires_at > now()
RETURNING `+runColumns,
		tenantID, runID, claimToken, attempt, passedExamples, scoredExamples,
		resultTotal-scoredExamples, mean, p25, gate))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrLeaseLost
	}
	if err != nil {
		return nil, err
	}
	completed.BySurface = bySurface
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &completed, nil
}

// ListRuns returns the tenant's runs, newest-first.
func (r *Repo) ListRuns(ctx context.Context, tenantID string, limit int) ([]RegressionRun, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT `+runColumns+`
  FROM ai_regression_runs
 WHERE tenant_id = $1::uuid
 ORDER BY created_at DESC
 LIMIT $2`, tenantID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []RegressionRun{}
	for rows.Next() {
		rn, err := scanRun(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, rn)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	for index := range out {
		bySurface, aggregateErr := aggregateBySurfaceTx(ctx, tx, out[index])
		if aggregateErr != nil {
			return nil, aggregateErr
		}
		out[index].BySurface = bySurface
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// LatestRun returns the most recent run for the tenant, or ErrNotFound when
// the tenant has never triggered one (the handler maps that to {"run":null}).
func (r *Repo) LatestRun(ctx context.Context, tenantID string) (*RegressionRun, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rn, err := scanRun(tx.QueryRow(ctx, `
SELECT `+runColumns+`
  FROM ai_regression_runs
 WHERE tenant_id = $1::uuid
 ORDER BY created_at DESC
 LIMIT 1`, tenantID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	rn.BySurface, err = aggregateBySurfaceTx(ctx, tx, rn)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &rn, nil
}

// GetRun fetches one run by id.
func (r *Repo) GetRun(ctx context.Context, tenantID, id string) (*RegressionRun, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rn, err := scanRun(tx.QueryRow(ctx, `
SELECT `+runColumns+`
  FROM ai_regression_runs
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	rn.BySurface, err = aggregateBySurfaceTx(ctx, tx, rn)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &rn, nil
}

// ListResults returns the per-example results for a run, ordered by surface.
func (r *Repo) ListResults(ctx context.Context, tenantID, runID string) ([]RegressionResult, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT results.id::text, NULLIF(results.example_id::text, ''),
       results.attempt_count, results.surface_kind, results.replayed_output, results.fidelity_score,
	   results.breakdown, COALESCE(results.severity, ''), results.error_code,
	   results.error_message, results.scored_at,
	   examples.brief, examples.approved_output, examples.source_model_id,
	   examples.voice_profile_version, NULLIF(examples.approval_id::text, ''),
	   NULLIF(examples.agent_run_id::text, ''), examples.source_created_at,
	   examples.snapshotted_at, examples.ordinal
  FROM ai_regression_results AS results
	JOIN ai_regression_runs AS runs
	  ON runs.tenant_id = results.tenant_id
	 AND runs.id = results.run_id
	 AND runs.attempt_count = results.attempt_count
  LEFT JOIN ai_regression_run_examples AS examples
    ON examples.tenant_id = results.tenant_id
	AND examples.run_id = results.run_id
	AND examples.example_id = results.example_id
 WHERE results.tenant_id = $1::uuid
   AND results.run_id = $2::uuid
 ORDER BY results.surface_kind, results.scored_at, results.id`, tenantID, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []RegressionResult{}
	for rows.Next() {
		var res RegressionResult
		var breakdownRaw []byte
		if err := rows.Scan(
			&res.ID, &res.ExampleID, &res.AttemptCount, &res.SurfaceKind, &res.ReplayedOutput,
			&res.FidelityScore, &breakdownRaw, &res.Severity, &res.ErrorCode,
			&res.ErrorMessage, &res.ScoredAt, &res.Brief, &res.ApprovedOutput,
			&res.SourceModelID, &res.VoiceProfileVersion, &res.ApprovalID,
			&res.AgentRunID, &res.SourceCreatedAt, &res.SnapshottedAt,
			&res.SnapshotOrdinal,
		); err != nil {
			return nil, err
		}
		if len(breakdownRaw) > 0 {
			_ = json.Unmarshal(breakdownRaw, &res.Breakdown)
		}
		res.ErrorCode, res.ErrorMessage = safeFailureForRead(res.ErrorCode, res.ErrorMessage)
		out = append(out, res)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// ----- settings ------------------------------------------------------------

func getSettingsTx(ctx context.Context, tx pgx.Tx, tenantID string) (RegressionSettings, error) {
	var settings RegressionSettings
	err := tx.QueryRow(ctx, `
SELECT warn_threshold, hard_gate_enabled, hard_gate_threshold, min_examples_for_gate
  FROM ai_regression_settings
 WHERE tenant_id = $1::uuid`, tenantID).Scan(
		&settings.WarnThreshold,
		&settings.HardGateEnabled,
		&settings.HardGateThreshold,
		&settings.MinExamplesForGate,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return DefaultSettings(), nil
	}
	return settings, err
}

// GetSettings returns the tenant's settings, or DefaultSettings() when no
// row exists (absence == defaults; advisory-first).
func (r *Repo) GetSettings(ctx context.Context, tenantID string) (RegressionSettings, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return RegressionSettings{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	s, err := getSettingsTx(ctx, tx, tenantID)
	if err != nil {
		return RegressionSettings{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return RegressionSettings{}, err
	}
	return s, nil
}

// PutSettings upserts the tenant's settings row.
func (r *Repo) PutSettings(ctx context.Context, tenantID string, s RegressionSettings) (RegressionSettings, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return RegressionSettings{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var out RegressionSettings
	err = tx.QueryRow(ctx, `
INSERT INTO ai_regression_settings (
    tenant_id, warn_threshold, hard_gate_enabled, hard_gate_threshold, min_examples_for_gate
)
VALUES ($1::uuid, $2, $3, $4, $5)
ON CONFLICT (tenant_id) DO UPDATE
   SET warn_threshold        = EXCLUDED.warn_threshold,
       hard_gate_enabled     = EXCLUDED.hard_gate_enabled,
       hard_gate_threshold   = EXCLUDED.hard_gate_threshold,
       min_examples_for_gate = EXCLUDED.min_examples_for_gate
RETURNING warn_threshold, hard_gate_enabled, hard_gate_threshold, min_examples_for_gate`,
		tenantID, s.WarnThreshold, s.HardGateEnabled, s.HardGateThreshold, s.MinExamplesForGate).Scan(
		&out.WarnThreshold, &out.HardGateEnabled, &out.HardGateThreshold, &out.MinExamplesForGate)
	if err != nil {
		return RegressionSettings{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return RegressionSettings{}, err
	}
	return out, nil
}
