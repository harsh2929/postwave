// SPDX-License-Identifier: AGPL-3.0-only

// Package campaignreportprojection materializes the legacy campaign report
// read model from canonical subscriber events. It deliberately owns no report
// queries: existing readers remain unchanged while writers migrate to the
// canonical ledger and this projection one composition boundary at a time.
package campaignreportprojection

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
)

const (
	// ProjectionVersionV1 is persisted in every immutable projection link.
	ProjectionVersionV1 = "postwave.campaign-report-projection.v1"
	defaultLeaseTTL     = 2 * time.Minute
	maxLeaseTTL         = 30 * time.Minute
	maxBatchSize        = 1000
)

var (
	ErrInvalidInput            = errors.New("campaign report projection: invalid input")
	ErrIdempotencyConflict     = errors.New("campaign report projection: idempotency conflict")
	ErrAmbiguousLegacyRow      = errors.New("campaign report projection: ambiguous legacy row")
	ErrLeaseHeld               = errors.New("campaign report projection: lease held")
	ErrLeaseLost               = errors.New("campaign report projection: lease lost")
	ErrSourceFenceChanged      = errors.New("campaign report projection: fenced source set changed")
	ErrUnsupportedCanonicalRow = errors.New("campaign report projection: canonical event is not projectable")
)

// EventRef is the complete identity of a row in partitioned subscriber_events.
type EventRef struct {
	ID int64
	At time.Time
}

// Receipt describes the one compatibility row bound to a canonical event.
// ProjectionInserted means the immutable link was created by this call; it is
// false for an exact replay. MaterializationMethod remains stable on replay.
type Receipt struct {
	CampaignReportEventID int64
	CampaignReportEventAt time.Time
	MaterializationMethod string
	ProjectionInserted    bool
}

type ReconciliationRequest struct {
	RequestID         string
	ProjectionVersion string
	WindowStart       time.Time
	WindowEnd         time.Time
}

type Run struct {
	ID                string
	TenantID          string
	RequestID         string
	RequestHash       string
	ProjectionVersion string
	WindowStart       time.Time
	WindowEnd         time.Time
	FenceEventID      int64
	FenceCapturedAt   time.Time
	Cursor            *EventRef
	CandidateCount    int64
	ProcessedCount    int64
	InsertedCount     int64
	AdoptedCount      int64
	ReplayedCount     int64
	State             string
	WorkerID          string
	LeaseToken        string
	LeaseExpiresAt    *time.Time
	HeartbeatAt       *time.Time
	AttemptCount      int
	ErrorCode         string
	CreatedAt         time.Time
	StartedAt         *time.Time
	CompletedAt       *time.Time
	UpdatedAt         time.Time
}

// Repo is safe for concurrent use when WorkerID is configured once before use.
// WorkerID is required only for reconciliation; direct Append calls do not
// acquire a durable run lease.
type Repo struct {
	Pool     *db.Pool
	WorkerID string
	LeaseTTL time.Duration
}

// Append projects one canonical event in its own tenant-worker transaction.
func (repo *Repo) Append(
	ctx context.Context,
	tenantID string,
	event EventRef,
	projectionVersion string,
) (Receipt, error) {
	if repo == nil || repo.Pool == nil {
		return Receipt{}, fmt.Errorf("%w: repository pool is required", ErrInvalidInput)
	}
	tx, err := db.WithTenantWorker(ctx, repo.Pool, tenantID)
	if err != nil {
		return Receipt{}, fmt.Errorf("open projection transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	receipt, err := repo.AppendInTx(ctx, tx, tenantID, event, projectionVersion, "", "", 0)
	if err != nil {
		return Receipt{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Receipt{}, fmt.Errorf("commit campaign report projection: %w", err)
	}
	return receipt, nil
}

// AppendInTx is the composition hook for canonical ingesters. The caller must
// already hold a tenant-bound worker transaction; this method grants only the
// purpose-specific projection capability and never the generic worker scope.
// Passing a runID also requires its exact lease token and attempt; the database
// proves the event is inside that run's immutable window/fence before recording
// run-owned lineage. Direct composition passes an empty run/lease and attempt 0.
func (repo *Repo) AppendInTx(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	event EventRef,
	projectionVersion string,
	runID string,
	leaseToken string,
	attempt int,
) (Receipt, error) {
	if tx == nil {
		return Receipt{}, fmt.Errorf("%w: transaction is required", ErrInvalidInput)
	}
	if err := validateProjectionInput(tenantID, event, projectionVersion); err != nil {
		return Receipt{}, err
	}
	if runID != "" {
		if _, err := uuid.Parse(runID); err != nil {
			return Receipt{}, fmt.Errorf("%w: invalid reconciliation run id", ErrInvalidInput)
		}
		if _, err := uuid.Parse(leaseToken); err != nil || attempt < 1 {
			return Receipt{}, fmt.Errorf("%w: invalid reconciliation lease fence", ErrInvalidInput)
		}
	} else if leaseToken != "" || attempt != 0 {
		return Receipt{}, fmt.Errorf("%w: direct projection cannot carry a lease", ErrInvalidInput)
	}
	if err := bindProjectionScope(ctx, tx); err != nil {
		return Receipt{}, err
	}
	var receipt Receipt
	err := tx.QueryRow(ctx, `
SELECT campaign_report_event_id, campaign_report_event_at,
       materialization_method, projection_inserted
  FROM append_campaign_report_event_projection(
	  $1::uuid, $2, $3, $4, NULLIF($5, '')::uuid,
	  NULLIF($6, '')::uuid, NULLIF($7::integer, 0)
  )`, tenantID, event.ID, event.At.UTC(), projectionVersion, runID,
		leaseToken, attempt).Scan(
		&receipt.CampaignReportEventID,
		&receipt.CampaignReportEventAt,
		&receipt.MaterializationMethod,
		&receipt.ProjectionInserted,
	)
	if err != nil {
		return Receipt{}, classifyProjectionError(err)
	}
	return receipt, nil
}

// StartReconciliation creates an immutable source fence or resumes the exact
// same request, then acquires a fenced lease. It never processes an unbounded
// window: ProcessBatch is the only page executor.
func (repo *Repo) StartReconciliation(
	ctx context.Context,
	tenantID string,
	request ReconciliationRequest,
) (Run, error) {
	if repo == nil || repo.Pool == nil {
		return Run{}, fmt.Errorf("%w: repository pool is required", ErrInvalidInput)
	}
	request, err := normalizeRequest(tenantID, request)
	if err != nil {
		return Run{}, err
	}
	workerID, leaseTTL, err := repo.reconciliationSettings()
	if err != nil {
		return Run{}, err
	}
	requestHash, err := reconciliationRequestHash(request)
	if err != nil {
		return Run{}, err
	}
	tx, err := db.WithTenantWorker(ctx, repo.Pool, tenantID)
	if err != nil {
		return Run{}, fmt.Errorf("open projection reconciliation transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindProjectionScope(ctx, tx); err != nil {
		return Run{}, err
	}

	var fenceID, candidateCount int64
	if err := tx.QueryRow(ctx, `
SELECT COALESCE(max(id), 0), count(*)
  FROM subscriber_events
 WHERE tenant_id = $1::uuid
   AND campaign_id IS NOT NULL
   AND event_type = ANY(ARRAY[
       'delivered', 'opened', 'clicked', 'bounced',
       'complained', 'unsubscribed', 'replied'
   ]::text[])
   AND at >= $2 AND at < $3`, tenantID, request.WindowStart,
		request.WindowEnd).Scan(&fenceID, &candidateCount); err != nil {
		return Run{}, fmt.Errorf("capture projection source fence: %w", err)
	}

	runID := uuid.NewString()
	var inserted bool
	err = tx.QueryRow(ctx, `
WITH inserted AS (
    INSERT INTO campaign_report_projection_runs (
        id, tenant_id, request_id, request_hash, projection_version,
        event_window_start, event_window_end, fence_event_id,
        candidate_count
    ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9
    )
    ON CONFLICT (tenant_id, request_id) DO NOTHING
    RETURNING true
)
SELECT COALESCE((SELECT true FROM inserted), false)`, runID, tenantID,
		request.RequestID, requestHash, request.ProjectionVersion,
		request.WindowStart, request.WindowEnd, fenceID, candidateCount).Scan(&inserted)
	if err != nil {
		return Run{}, fmt.Errorf("create projection reconciliation run: %w", err)
	}
	if !inserted {
		var existing Run
		existing, err = loadRunByRequest(ctx, tx, tenantID, request.RequestID, false)
		if err != nil {
			return Run{}, err
		}
		if existing.RequestHash != requestHash {
			return Run{}, ErrIdempotencyConflict
		}
		runID = existing.ID
		if existing.State == "completed" || existing.State == "failed" {
			if err := tx.Commit(ctx); err != nil {
				return Run{}, fmt.Errorf("commit terminal reconciliation replay: %w", err)
			}
			return existing, nil
		}
		if existing.State == "running" && existing.WorkerID == workerID &&
			existing.LeaseExpiresAt != nil {
			var leaseValid bool
			if err := tx.QueryRow(ctx,
				`SELECT $1::timestamptz > clock_timestamp()`,
				*existing.LeaseExpiresAt).Scan(&leaseValid); err != nil {
				return Run{}, fmt.Errorf("inspect existing projection lease: %w", err)
			}
			if leaseValid {
				if err := tx.Commit(ctx); err != nil {
					return Run{}, fmt.Errorf("commit reconciliation lease replay: %w", err)
				}
				return existing, nil
			}
		}
	}

	leaseToken := uuid.NewString()
	run, err := claimRun(ctx, tx, tenantID, runID, workerID, leaseToken, leaseTTL)
	if err != nil {
		return Run{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Run{}, fmt.Errorf("commit projection reconciliation lease: %w", err)
	}
	return run, nil
}

// ProcessBatch processes at most batchSize fenced canonical rows and advances
// the cursor in the same transaction. A stale lease token/attempt cannot append
// run-owned lineage or advance progress after another worker reclaims the run.
func (repo *Repo) ProcessBatch(
	ctx context.Context,
	tenantID string,
	runID string,
	leaseToken string,
	attempt int,
	batchSize int,
) (Run, error) {
	if repo == nil || repo.Pool == nil {
		return Run{}, fmt.Errorf("%w: repository pool is required", ErrInvalidInput)
	}
	if _, err := uuid.Parse(tenantID); err != nil {
		return Run{}, fmt.Errorf("%w: tenant id must be a UUID", ErrInvalidInput)
	}
	if _, err := uuid.Parse(runID); err != nil {
		return Run{}, fmt.Errorf("%w: run id must be a UUID", ErrInvalidInput)
	}
	if _, err := uuid.Parse(leaseToken); err != nil || attempt < 1 {
		return Run{}, fmt.Errorf("%w: lease identity is invalid", ErrInvalidInput)
	}
	if batchSize < 1 || batchSize > maxBatchSize {
		return Run{}, fmt.Errorf("%w: batch size must be 1..%d", ErrInvalidInput, maxBatchSize)
	}
	_, leaseTTL, err := repo.reconciliationSettings()
	if err != nil {
		return Run{}, err
	}
	tx, err := db.WithTenantWorker(ctx, repo.Pool, tenantID)
	if err != nil {
		return Run{}, fmt.Errorf("open projection batch transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindProjectionScope(ctx, tx); err != nil {
		return Run{}, err
	}

	run, err := loadLeasedRunForUpdate(ctx, tx, tenantID, runID, leaseToken, attempt)
	if err != nil {
		return Run{}, err
	}
	candidates, err := loadCandidates(ctx, tx, run, batchSize)
	if err != nil {
		return Run{}, err
	}
	if run.ProcessedCount+int64(len(candidates)) > run.CandidateCount {
		failed, failErr := failRunInTx(ctx, tx, run, leaseToken, attempt,
			"source_fence_changed", run.Cursor, 0, 0, 0, 0)
		if failErr != nil {
			return Run{}, failErr
		}
		if err := tx.Commit(ctx); err != nil {
			return Run{}, fmt.Errorf("commit source-fence failure: %w", err)
		}
		return failed, fmt.Errorf("%w: more visible rows than the immutable candidate fence",
			ErrSourceFenceChanged)
	}

	var insertedCount, adoptedCount, replayedCount int64
	for _, event := range candidates {
		receipt, err := repo.AppendInTx(
			ctx, tx, tenantID, event, run.ProjectionVersion, run.ID,
			leaseToken, attempt,
		)
		if err != nil {
			return Run{}, err
		}
		if !receipt.ProjectionInserted {
			replayedCount++
			continue
		}
		switch receipt.MaterializationMethod {
		case "inserted_projection":
			insertedCount++
		case "adopted_legacy":
			adoptedCount++
		default:
			return Run{}, fmt.Errorf("%w: unknown materialization method %q",
				ErrInvalidInput, receipt.MaterializationMethod)
		}
	}

	newProcessed := run.ProcessedCount + int64(len(candidates))
	var cursor *EventRef
	if len(candidates) > 0 {
		last := candidates[len(candidates)-1]
		cursor = &last
	} else {
		cursor = run.Cursor
	}
	hasMore, err := hasMoreCandidates(ctx, tx, run, cursor)
	if err != nil {
		return Run{}, err
	}
	if (!hasMore && newProcessed != run.CandidateCount) ||
		(hasMore && newProcessed >= run.CandidateCount) {
		failed, failErr := failRunInTx(ctx, tx, run, leaseToken, attempt,
			"source_fence_changed", cursor, int64(len(candidates)), insertedCount,
			adoptedCount, replayedCount)
		if failErr != nil {
			return Run{}, failErr
		}
		if err := tx.Commit(ctx); err != nil {
			return Run{}, fmt.Errorf("commit source-fence failure: %w", err)
		}
		return failed, fmt.Errorf("%w: processed=%d fenced=%d remaining=%v",
			ErrSourceFenceChanged, newProcessed, run.CandidateCount, hasMore)
	}

	run, err = persistBatchProgress(ctx, tx, run, leaseToken, attempt,
		cursor, int64(len(candidates)), insertedCount, adoptedCount,
		replayedCount, !hasMore, leaseTTL)
	if err != nil {
		return Run{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Run{}, fmt.Errorf("commit projection reconciliation batch: %w", err)
	}
	return run, nil
}

// FailReconciliation makes an operational abandon/failure durable. It is
// fenced by the exact live lease; a stale worker cannot terminate a reclaimed
// run. Terminal failures are immutable and require a new request ID to retry.
func (repo *Repo) FailReconciliation(
	ctx context.Context,
	tenantID string,
	runID string,
	leaseToken string,
	attempt int,
	errorCode string,
) (Run, error) {
	if repo == nil || repo.Pool == nil {
		return Run{}, fmt.Errorf("%w: repository pool is required", ErrInvalidInput)
	}
	if _, err := uuid.Parse(tenantID); err != nil {
		return Run{}, fmt.Errorf("%w: tenant id must be a UUID", ErrInvalidInput)
	}
	if _, err := uuid.Parse(runID); err != nil {
		return Run{}, fmt.Errorf("%w: run id must be a UUID", ErrInvalidInput)
	}
	if _, err := uuid.Parse(leaseToken); err != nil || attempt < 1 ||
		!validErrorCode(errorCode) {
		return Run{}, fmt.Errorf("%w: failure fence/error code is invalid", ErrInvalidInput)
	}
	tx, err := db.WithTenantWorker(ctx, repo.Pool, tenantID)
	if err != nil {
		return Run{}, fmt.Errorf("open projection failure transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindProjectionScope(ctx, tx); err != nil {
		return Run{}, err
	}
	run, err := loadLeasedRunForUpdate(ctx, tx, tenantID, runID, leaseToken, attempt)
	if err != nil {
		return Run{}, err
	}
	run, err = failRunInTx(ctx, tx, run, leaseToken, attempt, errorCode,
		run.Cursor, 0, 0, 0, 0)
	if err != nil {
		return Run{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Run{}, fmt.Errorf("commit projection reconciliation failure: %w", err)
	}
	return run, nil
}

func validateProjectionInput(tenantID string, event EventRef, version string) error {
	if _, err := uuid.Parse(strings.TrimSpace(tenantID)); err != nil {
		return fmt.Errorf("%w: tenant id must be a UUID", ErrInvalidInput)
	}
	if event.ID <= 0 || event.At.IsZero() {
		return fmt.Errorf("%w: canonical event identity is incomplete", ErrInvalidInput)
	}
	if !validVersion(version) {
		return fmt.Errorf("%w: projection version is invalid", ErrInvalidInput)
	}
	return nil
}

func normalizeRequest(tenantID string, request ReconciliationRequest) (ReconciliationRequest, error) {
	if _, err := uuid.Parse(strings.TrimSpace(tenantID)); err != nil {
		return request, fmt.Errorf("%w: tenant id must be a UUID", ErrInvalidInput)
	}
	parsedRequestID, err := uuid.Parse(strings.TrimSpace(request.RequestID))
	if err != nil {
		return request, fmt.Errorf("%w: request id must be a UUID", ErrInvalidInput)
	}
	request.RequestID = parsedRequestID.String()
	if request.ProjectionVersion == "" {
		request.ProjectionVersion = ProjectionVersionV1
	}
	if !validVersion(request.ProjectionVersion) {
		return request, fmt.Errorf("%w: projection version is invalid", ErrInvalidInput)
	}
	if request.WindowStart.IsZero() || request.WindowEnd.IsZero() ||
		!request.WindowEnd.After(request.WindowStart) {
		return request, fmt.Errorf("%w: reconciliation window is invalid", ErrInvalidInput)
	}
	request.WindowStart = request.WindowStart.UTC()
	request.WindowEnd = request.WindowEnd.UTC()
	return request, nil
}

func validVersion(version string) bool {
	if len(version) < 1 || len(version) > 96 {
		return false
	}
	for index, r := range version {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') ||
			r == '_' || r == '.' || r == '-' {
			continue
		}
		if index == 0 {
			return false
		}
		return false
	}
	first := version[0]
	return (first >= 'a' && first <= 'z') || (first >= '0' && first <= '9')
}

func validErrorCode(value string) bool {
	if len(value) < 1 || len(value) > 96 {
		return false
	}
	for index, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') ||
			r == '_' || r == '.' || r == '-' {
			continue
		}
		if index == 0 {
			return false
		}
		return false
	}
	first := value[0]
	return first >= 'a' && first <= 'z'
}

func (repo *Repo) reconciliationSettings() (string, time.Duration, error) {
	workerID := strings.TrimSpace(repo.WorkerID)
	if workerID == "" || len(workerID) > 200 || strings.ContainsAny(workerID, "\x00\r\n") {
		return "", 0, fmt.Errorf("%w: a bounded worker id is required", ErrInvalidInput)
	}
	leaseTTL := repo.LeaseTTL
	if leaseTTL == 0 {
		leaseTTL = defaultLeaseTTL
	}
	if leaseTTL < time.Millisecond || leaseTTL > maxLeaseTTL {
		return "", 0, fmt.Errorf("%w: lease TTL must be 1ms..30m", ErrInvalidInput)
	}
	return workerID, leaseTTL, nil
}

func bindProjectionScope(ctx context.Context, tx pgx.Tx) error {
	var genericWorker string
	if err := tx.QueryRow(ctx,
		`SELECT COALESCE(current_setting('app.outbox_worker', true), '')`).Scan(&genericWorker); err != nil {
		return fmt.Errorf("inspect projection worker scope: %w", err)
	}
	if genericWorker != "true" {
		return fmt.Errorf("%w: tenant worker scope is required", ErrInvalidInput)
	}
	if _, err := tx.Exec(ctx, `
SELECT set_config('app.campaign_report_projection_worker', 'true', true),
       set_config('app.controlled_seed_evidence_reader', 'true', true)`); err != nil {
		return fmt.Errorf("bind campaign report projection scope: %w", err)
	}
	return nil
}

func reconciliationRequestHash(request ReconciliationRequest) (string, error) {
	payload := struct {
		Schema            string `json:"schema"`
		ProjectionVersion string `json:"projection_version"`
		WindowStart       string `json:"window_start"`
		WindowEnd         string `json:"window_end"`
	}{
		Schema:            "postwave.campaign-report-reconciliation-request.v1",
		ProjectionVersion: request.ProjectionVersion,
		WindowStart:       request.WindowStart.UTC().Format(time.RFC3339Nano),
		WindowEnd:         request.WindowEnd.UTC().Format(time.RFC3339Nano),
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("marshal reconciliation request: %w", err)
	}
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:]), nil
}

const runColumns = `
id::text, tenant_id::text, request_id::text, request_hash,
projection_version, event_window_start, event_window_end, fence_event_id,
fence_captured_at, cursor_event_at, cursor_event_id, candidate_count,
processed_count, inserted_count, adopted_count, replayed_count, state,
COALESCE(worker_id, ''), COALESCE(lease_token::text, ''), lease_expires_at,
heartbeat_at, attempt_count, COALESCE(error_code, ''), created_at,
started_at, completed_at, updated_at`

func scanRun(row pgx.Row) (Run, error) {
	var run Run
	var cursorAt, leaseExpires, heartbeat, started, completed sql.NullTime
	var cursorID sql.NullInt64
	err := row.Scan(
		&run.ID, &run.TenantID, &run.RequestID, &run.RequestHash,
		&run.ProjectionVersion, &run.WindowStart, &run.WindowEnd,
		&run.FenceEventID, &run.FenceCapturedAt, &cursorAt, &cursorID,
		&run.CandidateCount, &run.ProcessedCount, &run.InsertedCount,
		&run.AdoptedCount, &run.ReplayedCount, &run.State, &run.WorkerID,
		&run.LeaseToken, &leaseExpires, &heartbeat, &run.AttemptCount,
		&run.ErrorCode, &run.CreatedAt, &started, &completed, &run.UpdatedAt,
	)
	if err != nil {
		return Run{}, err
	}
	if cursorAt.Valid && cursorID.Valid {
		run.Cursor = &EventRef{ID: cursorID.Int64, At: cursorAt.Time}
	}
	if leaseExpires.Valid {
		value := leaseExpires.Time
		run.LeaseExpiresAt = &value
	}
	if heartbeat.Valid {
		value := heartbeat.Time
		run.HeartbeatAt = &value
	}
	if started.Valid {
		value := started.Time
		run.StartedAt = &value
	}
	if completed.Valid {
		value := completed.Time
		run.CompletedAt = &value
	}
	return run, nil
}

func loadRunByRequest(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	requestID string,
	forUpdate bool,
) (Run, error) {
	query := `SELECT ` + runColumns + `
  FROM campaign_report_projection_runs
 WHERE tenant_id = $1::uuid AND request_id = $2::uuid`
	if forUpdate {
		query += ` FOR UPDATE`
	}
	run, err := scanRun(tx.QueryRow(ctx, query, tenantID, requestID))
	if err != nil {
		return Run{}, fmt.Errorf("load projection reconciliation run: %w", err)
	}
	return run, nil
}

func claimRun(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	runID string,
	workerID string,
	leaseToken string,
	leaseTTL time.Duration,
) (Run, error) {
	run, err := scanRun(tx.QueryRow(ctx, `
UPDATE campaign_report_projection_runs
   SET state = 'running', worker_id = $3, lease_token = $4::uuid,
       heartbeat_at = clock_timestamp(),
       lease_expires_at = clock_timestamp() + ($5::bigint * interval '1 millisecond'),
       attempt_count = attempt_count + 1,
       started_at = COALESCE(started_at, clock_timestamp()),
       updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND id = $2::uuid
   AND (
       state = 'queued'
       OR (state = 'running' AND lease_expires_at <= clock_timestamp())
   )
RETURNING `+runColumns, tenantID, runID, workerID, leaseToken,
		leaseTTL.Milliseconds()))
	if err == nil {
		return run, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Run{}, fmt.Errorf("claim projection reconciliation run: %w", err)
	}
	existing, loadErr := scanRun(tx.QueryRow(ctx, `
SELECT `+runColumns+`
  FROM campaign_report_projection_runs
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, runID))
	if loadErr != nil {
		return Run{}, fmt.Errorf("inspect unclaimed projection reconciliation run: %w", loadErr)
	}
	if existing.State == "running" {
		return existing, ErrLeaseHeld
	}
	return existing, fmt.Errorf("%w: run is %s", ErrInvalidInput, existing.State)
}

func loadLeasedRunForUpdate(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	runID string,
	leaseToken string,
	attempt int,
) (Run, error) {
	run, err := scanRun(tx.QueryRow(ctx, `
SELECT `+runColumns+`
  FROM campaign_report_projection_runs
 WHERE tenant_id = $1::uuid AND id = $2::uuid
   AND state = 'running' AND lease_token = $3::uuid
   AND attempt_count = $4 AND lease_expires_at > clock_timestamp()
 FOR UPDATE`, tenantID, runID, leaseToken, attempt))
	if err == nil {
		return run, nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return Run{}, ErrLeaseLost
	}
	return Run{}, fmt.Errorf("lock projection reconciliation lease: %w", err)
}

func loadCandidates(
	ctx context.Context,
	tx pgx.Tx,
	run Run,
	batchSize int,
) ([]EventRef, error) {
	rows, err := tx.Query(ctx, `
SELECT id, at
  FROM subscriber_events
 WHERE tenant_id = $1::uuid
   AND id <= $2
   AND campaign_id IS NOT NULL
   AND event_type = ANY(ARRAY[
       'delivered', 'opened', 'clicked', 'bounced',
       'complained', 'unsubscribed', 'replied'
   ]::text[])
   AND at >= $3 AND at < $4
   AND (
       $5::timestamptz IS NULL
       OR (at, id) > ($5::timestamptz, $6::bigint)
   )
 ORDER BY at, id
 LIMIT $7`, run.TenantID, run.FenceEventID, run.WindowStart, run.WindowEnd,
		nullableCursorAt(run.Cursor), nullableCursorID(run.Cursor), batchSize)
	if err != nil {
		return nil, fmt.Errorf("load projection reconciliation candidates: %w", err)
	}
	defer rows.Close()
	candidates := make([]EventRef, 0, batchSize)
	for rows.Next() {
		var candidate EventRef
		if err := rows.Scan(&candidate.ID, &candidate.At); err != nil {
			return nil, fmt.Errorf("scan projection reconciliation candidate: %w", err)
		}
		candidates = append(candidates, candidate)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate projection reconciliation candidates: %w", err)
	}
	return candidates, nil
}

func hasMoreCandidates(
	ctx context.Context,
	tx pgx.Tx,
	run Run,
	cursor *EventRef,
) (bool, error) {
	var exists bool
	err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1
      FROM subscriber_events
     WHERE tenant_id = $1::uuid
       AND id <= $2
       AND campaign_id IS NOT NULL
       AND event_type = ANY(ARRAY[
           'delivered', 'opened', 'clicked', 'bounced',
           'complained', 'unsubscribed', 'replied'
       ]::text[])
       AND at >= $3 AND at < $4
       AND (
           $5::timestamptz IS NULL
           OR (at, id) > ($5::timestamptz, $6::bigint)
       )
)`, run.TenantID, run.FenceEventID, run.WindowStart, run.WindowEnd,
		nullableCursorAt(cursor), nullableCursorID(cursor)).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("inspect remaining projection candidates: %w", err)
	}
	return exists, nil
}

func persistBatchProgress(
	ctx context.Context,
	tx pgx.Tx,
	run Run,
	leaseToken string,
	attempt int,
	cursor *EventRef,
	processed, inserted, adopted, replayed int64,
	complete bool,
	leaseTTL time.Duration,
) (Run, error) {
	state := "running"
	if complete {
		state = "completed"
	}
	updated, err := scanRun(tx.QueryRow(ctx, `
UPDATE campaign_report_projection_runs
   SET cursor_event_at = COALESCE($5::timestamptz, cursor_event_at),
       cursor_event_id = COALESCE($6::bigint, cursor_event_id),
       processed_count = processed_count + $7,
       inserted_count = inserted_count + $8,
       adopted_count = adopted_count + $9,
       replayed_count = replayed_count + $10,
       state = $11,
       heartbeat_at = CASE WHEN $11 = 'running' THEN clock_timestamp()
                           ELSE heartbeat_at END,
       lease_expires_at = CASE WHEN $11 = 'running'
           THEN clock_timestamp() + ($12::bigint * interval '1 millisecond')
           ELSE lease_expires_at END,
       completed_at = CASE WHEN $11 = 'completed' THEN clock_timestamp()
                           ELSE NULL END,
       updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND id = $2::uuid
   AND state = 'running' AND lease_token = $3::uuid
   AND attempt_count = $4 AND lease_expires_at > clock_timestamp()
RETURNING `+runColumns, run.TenantID, run.ID, leaseToken, attempt,
		nullableCursorAt(cursor), nullableCursorID(cursor), processed, inserted,
		adopted, replayed, state, leaseTTL.Milliseconds()))
	if err == nil {
		return updated, nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return Run{}, ErrLeaseLost
	}
	return Run{}, fmt.Errorf("persist projection reconciliation progress: %w", err)
}

func failRunInTx(
	ctx context.Context,
	tx pgx.Tx,
	run Run,
	leaseToken string,
	attempt int,
	errorCode string,
	cursor *EventRef,
	processed, inserted, adopted, replayed int64,
) (Run, error) {
	if !validErrorCode(errorCode) || processed < 0 || inserted < 0 ||
		adopted < 0 || replayed < 0 || processed != inserted+adopted+replayed {
		return Run{}, fmt.Errorf("%w: invalid reconciliation failure progress", ErrInvalidInput)
	}
	failed, err := scanRun(tx.QueryRow(ctx, `
UPDATE campaign_report_projection_runs
   SET cursor_event_at = COALESCE($5::timestamptz, cursor_event_at),
       cursor_event_id = COALESCE($6::bigint, cursor_event_id),
       processed_count = processed_count + $7,
       inserted_count = inserted_count + $8,
       adopted_count = adopted_count + $9,
       replayed_count = replayed_count + $10,
       state = 'failed', error_code = $11,
       completed_at = clock_timestamp(), updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND id = $2::uuid
   AND state = 'running' AND lease_token = $3::uuid
   AND attempt_count = $4 AND lease_expires_at > clock_timestamp()
RETURNING `+runColumns, run.TenantID, run.ID, leaseToken, attempt,
		nullableCursorAt(cursor), nullableCursorID(cursor), processed, inserted,
		adopted, replayed, errorCode))
	if err == nil {
		return failed, nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return Run{}, ErrLeaseLost
	}
	return Run{}, fmt.Errorf("persist projection reconciliation failure: %w", err)
}

func nullableCursorAt(cursor *EventRef) any {
	if cursor == nil {
		return nil
	}
	return cursor.At.UTC()
}

func nullableCursorID(cursor *EventRef) any {
	if cursor == nil {
		return nil
	}
	return cursor.ID
}

func classifyProjectionError(err error) error {
	var postgresError *pgconn.PgError
	if !errors.As(err, &postgresError) {
		return fmt.Errorf("append campaign report projection: %w", err)
	}
	switch postgresError.Code {
	case "23505":
		return fmt.Errorf("%w: %s", ErrIdempotencyConflict, postgresError.Message)
	case "21000":
		return fmt.Errorf("%w: %s", ErrAmbiguousLegacyRow, postgresError.Message)
	case "22023":
		return fmt.Errorf("%w: %s", ErrUnsupportedCanonicalRow, postgresError.Message)
	case "42501":
		return fmt.Errorf("%w: %s", ErrInvalidInput, postgresError.Message)
	case "55000":
		if strings.Contains(postgresError.Message, "active run lease/fence") {
			return fmt.Errorf("%w: %s", ErrLeaseLost, postgresError.Message)
		}
		return fmt.Errorf("append campaign report projection: %w", err)
	default:
		return fmt.Errorf("append campaign report projection: %w", err)
	}
}
