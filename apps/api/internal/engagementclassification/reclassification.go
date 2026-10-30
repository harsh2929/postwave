// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"context"
	"crypto/sha256"
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

const defaultReclassificationLeaseTTL = 2 * time.Minute

type ReclassificationWindow struct {
	RequestID string
	Start     time.Time
	End       time.Time
	BatchSize int
}

type ReclassificationRun struct {
	ID                 string
	RequestID          string
	RequestHash        string
	State              string
	Start              time.Time
	End                time.Time
	Cursor             *EventRef
	CandidateCount     int64
	ClassifiedCount    int64
	UnchangedCount     int64
	ErrorCount         int64
	ClassifierVersion  string
	MethodologyVersion string
	RegistryVersion    string
	ConfigurationHash  string
	WorkerID           string
	LeaseToken         string
	LeaseExpiresAt     *time.Time
	HeartbeatAt        *time.Time
	AttemptCount       int
	StartedAt          *time.Time
	CompletedAt        *time.Time
}

type reclassificationLease struct {
	RunID        string
	WorkerID     string
	Token        string
	AttemptCount int
	TTL          time.Duration
}

func (repo *Repo) reclassificationLeaseTTL() time.Duration {
	if repo != nil && repo.ReclassificationLeaseTTL > 0 {
		return repo.ReclassificationLeaseTTL
	}
	return defaultReclassificationLeaseTTL
}

func (repo *Repo) reclassificationWorkerID() string {
	if repo != nil {
		workerID := strings.TrimSpace(repo.ReclassificationWorkerID)
		if workerID != "" {
			return workerID
		}
	}
	return "engagement-reclassifier-" + uuid.NewString()
}

func leaseFromRun(run ReclassificationRun, ttl time.Duration) reclassificationLease {
	return reclassificationLease{
		RunID: run.ID, WorkerID: run.WorkerID, Token: run.LeaseToken,
		AttemptCount: run.AttemptCount, TTL: ttl,
	}
}

// ReclassifyEvent appends one new methodology version without updating either
// subscriber_events or any prior event_classifications row.
func (repo *Repo) ReclassifyEvent(
	ctx context.Context,
	tenantID string,
	event EventRef,
	classifier *Classifier,
	runID string,
) (RecordReceipt, error) {
	if strings.TrimSpace(runID) != "" {
		return RecordReceipt{}, fmt.Errorf("%w: a run-bound reclassification requires its lease", ErrInvalidInput)
	}
	return repo.reclassifyEvent(ctx, tenantID, event, classifier, reclassificationLease{})
}

// reclassifyEvent holds the run row while it appends a classification. The
// row lock and exact token/attempt predicate form the fencing boundary: once a
// stale lease is reclaimed, the old worker can neither append more run-owned
// classifications nor advance the cursor.
func (repo *Repo) reclassifyEvent(
	ctx context.Context,
	tenantID string,
	event EventRef,
	classifier *Classifier,
	lease reclassificationLease,
) (RecordReceipt, error) {
	if repo == nil || repo.Pool == nil || classifier == nil ||
		strings.TrimSpace(tenantID) == "" || event.ID <= 0 || event.At.IsZero() {
		return RecordReceipt{}, fmt.Errorf("%w: invalid reclassification input", ErrInvalidInput)
	}
	tx, err := db.WithTenantWorker(ctx, repo.Pool, tenantID)
	if err != nil {
		return RecordReceipt{}, fmt.Errorf("open event reclassification transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindClassifierScope(ctx, tx); err != nil {
		return RecordReceipt{}, err
	}
	if lease.RunID != "" {
		if err := renewReclassificationLease(ctx, tx, tenantID, lease); err != nil {
			return RecordReceipt{}, err
		}
	}
	if err := ensureMethodology(ctx, tx, classifier.config, classifier.configHash); err != nil {
		return RecordReceipt{}, err
	}
	observation, observationIDs, aggregate, err := loadEventEvidence(ctx, tx, tenantID, event)
	if err != nil {
		return RecordReceipt{}, err
	}
	result, err := classifier.Classify(observation, aggregate)
	if err != nil {
		return RecordReceipt{}, err
	}
	var supersedesID string
	err = tx.QueryRow(ctx, `
SELECT id::text
  FROM event_classifications
 WHERE tenant_id = $1::uuid
   AND subscriber_event_id = $2 AND subscriber_event_at = $3
 ORDER BY classified_at DESC, id DESC
 LIMIT 1`, tenantID, event.ID, event.At).Scan(&supersedesID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return RecordReceipt{}, fmt.Errorf("load prior event classification: %w", err)
	}
	classificationID, added, classificationRunID, err := insertClassification(
		ctx, tx, tenantID, event, observationIDs, result, supersedesID, lease.RunID,
	)
	if err != nil {
		return RecordReceipt{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return RecordReceipt{}, fmt.Errorf("commit event reclassification: %w", err)
	}
	return RecordReceipt{
		ObservationID: observationIDs[0], ClassificationID: classificationID,
		ReclassificationRunID: classificationRunID,
		ClassificationAdded:   added, Result: result,
	}, nil
}

// ReclassifyWindow is a resumable, cursor-based batch. A crash can replay the
// current page safely because exact-version classifications are idempotent and
// the cursor advances only after every event in the page commits.
func (repo *Repo) ReclassifyWindow(
	ctx context.Context,
	tenantID string,
	window ReclassificationWindow,
	classifier *Classifier,
) (ReclassificationRun, error) {
	if repo == nil || repo.Pool == nil || classifier == nil ||
		strings.TrimSpace(tenantID) == "" {
		return ReclassificationRun{}, fmt.Errorf("%w: repository, tenant, and classifier are required", ErrInvalidInput)
	}
	if _, err := uuid.Parse(window.RequestID); err != nil || window.Start.IsZero() ||
		window.End.IsZero() || !window.End.After(window.Start) {
		return ReclassificationRun{}, fmt.Errorf("%w: invalid reclassification window", ErrInvalidInput)
	}
	if window.BatchSize == 0 {
		window.BatchSize = 500
	}
	if window.BatchSize < 1 || window.BatchSize > 5000 {
		return ReclassificationRun{}, fmt.Errorf("%w: batch size must be 1..5000", ErrInvalidInput)
	}
	window.Start = window.Start.UTC()
	window.End = window.End.UTC()
	requestHash, err := reclassificationRequestHash(window, classifier)
	if err != nil {
		return ReclassificationRun{}, err
	}
	run, err := repo.createAndClaimRun(ctx, tenantID, window, classifier, requestHash)
	if err != nil {
		return run, err
	}
	if run.State == "completed" {
		return run, nil
	}
	lease := leaseFromRun(run, repo.reclassificationLeaseTTL())

	for {
		candidates, err := repo.loadReclassificationCandidates(ctx, tenantID, run, lease, window.BatchSize)
		if err != nil {
			if errors.Is(err, ErrLeaseLost) {
				return run, err
			}
			return repo.failReclassificationRun(ctx, tenantID, run, lease, "candidate_load_failed", err)
		}
		if len(candidates) == 0 {
			return repo.completeReclassificationRun(ctx, tenantID, run, lease)
		}
		var classified, unchanged int64
		for _, event := range candidates {
			receipt, err := repo.reclassifyEvent(ctx, tenantID, event, classifier, lease)
			if err != nil {
				if errors.Is(err, ErrLeaseLost) {
					return run, err
				}
				run.ErrorCount++
				return repo.failReclassificationRun(ctx, tenantID, run, lease, "classification_failed", err)
			}
			// If a process died after appending the classification but before
			// persisting the page cursor, the reclaimed worker sees an exact
			// replay. Count it as classified by this run from durable lineage,
			// not as unchanged merely because this attempt did not insert it.
			if receipt.ReclassificationRunID == run.ID {
				classified++
			} else {
				unchanged++
			}
		}
		last := candidates[len(candidates)-1]
		run.CandidateCount += int64(len(candidates))
		run.ClassifiedCount += classified
		run.UnchangedCount += unchanged
		run.Cursor = &last
		if err := repo.persistRunProgress(ctx, tenantID, run, lease); err != nil {
			return run, err
		}
	}
}

func reclassificationRequestHash(window ReclassificationWindow, classifier *Classifier) (string, error) {
	payload := struct {
		Start, End         string
		ClassifierVersion  string
		MethodologyVersion string
		RegistryVersion    string
		ConfigurationHash  string
	}{
		Start:              window.Start.UTC().Format(time.RFC3339Nano),
		End:                window.End.UTC().Format(time.RFC3339Nano),
		ClassifierVersion:  classifier.config.ClassifierVersion,
		MethodologyVersion: classifier.config.MethodologyVersion,
		RegistryVersion:    classifier.config.RegistryVersion,
		ConfigurationHash:  classifier.configHash,
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("marshal reclassification request: %w", err)
	}
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:]), nil
}

func (repo *Repo) createAndClaimRun(
	ctx context.Context,
	tenantID string,
	window ReclassificationWindow,
	classifier *Classifier,
	requestHash string,
) (ReclassificationRun, error) {
	leaseTTL := repo.reclassificationLeaseTTL()
	if leaseTTL < time.Millisecond || leaseTTL > 30*time.Minute {
		return ReclassificationRun{}, fmt.Errorf("%w: reclassification lease must be between 1ms and 30m", ErrInvalidInput)
	}
	workerID := repo.reclassificationWorkerID()
	if len(workerID) > 200 || strings.ContainsAny(workerID, "\x00\r\n") {
		return ReclassificationRun{}, fmt.Errorf("%w: reclassification worker id is invalid", ErrInvalidInput)
	}
	tx, err := db.WithTenantWorker(ctx, repo.Pool, tenantID)
	if err != nil {
		return ReclassificationRun{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindClassifierScope(ctx, tx); err != nil {
		return ReclassificationRun{}, err
	}
	id := uuid.NewString()
	_, err = tx.Exec(ctx, `
INSERT INTO event_reclassification_runs (
    id, tenant_id, request_id, request_hash, event_window_start,
    event_window_end, classifier_version, methodology_version,
    registry_version, configuration_hash
) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10)
ON CONFLICT (tenant_id, request_id) DO NOTHING`, id, tenantID, window.RequestID,
		requestHash, window.Start, window.End, classifier.config.ClassifierVersion,
		classifier.config.MethodologyVersion, classifier.config.RegistryVersion,
		classifier.configHash)
	if err != nil {
		return ReclassificationRun{}, fmt.Errorf("create reclassification run: %w", err)
	}
	run, err := scanReclassificationRun(tx.QueryRow(ctx, `
SELECT id::text, request_id::text, request_hash, state,
       event_window_start, event_window_end, cursor_event_at, cursor_event_id,
       candidate_count, classified_count, unchanged_count, error_count,
       classifier_version, methodology_version, registry_version,
       configuration_hash, COALESCE(worker_id, ''),
       COALESCE(lease_token::text, ''), lease_expires_at, heartbeat_at,
       attempt_count, started_at, completed_at
  FROM event_reclassification_runs
 WHERE tenant_id = $1::uuid AND request_id = $2::uuid
 FOR UPDATE`, tenantID, window.RequestID))
	if err != nil {
		return ReclassificationRun{}, fmt.Errorf("load reclassification run: %w", err)
	}
	if run.RequestHash != requestHash {
		return ReclassificationRun{}, ErrIdempotencyConflict
	}
	switch run.State {
	case "completed":
		if err := tx.Commit(ctx); err != nil {
			return ReclassificationRun{}, err
		}
		return run, nil
	case "failed":
		return run, ErrRunTerminal
	case "queued", "running":
		// A running row reaches this branch only when its prior lease is stale.
		// The trigger independently rejects token replacement before expiry and
		// requires an exact +1 attempt, so a second claimant cannot steal a live
		// run even if its application clock is skewed.
		token := uuid.NewString()
		row := tx.QueryRow(ctx, `
UPDATE event_reclassification_runs
   SET state = 'running',
       started_at = COALESCE(started_at, clock_timestamp()),
       worker_id = $3, lease_token = $4::uuid,
       heartbeat_at = clock_timestamp(),
       lease_expires_at = clock_timestamp() + ($5::bigint * interval '1 millisecond'),
       attempt_count = attempt_count + 1
 WHERE tenant_id = $1::uuid AND id = $2::uuid
   AND (state = 'queued' OR
        (state = 'running' AND lease_expires_at <= statement_timestamp()))
 RETURNING state, worker_id, lease_token::text, lease_expires_at,
           heartbeat_at, attempt_count, started_at`,
			tenantID, run.ID, workerID, token, leaseTTL.Milliseconds())
		if err := row.Scan(&run.State, &run.WorkerID, &run.LeaseToken,
			&run.LeaseExpiresAt, &run.HeartbeatAt, &run.AttemptCount,
			&run.StartedAt); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return run, ErrRunInProgress
			}
			return ReclassificationRun{}, fmt.Errorf("claim reclassification run: %w", err)
		}
	default:
		return ReclassificationRun{}, fmt.Errorf("%w: unknown run state %q", ErrInvalidInput, run.State)
	}
	if err := tx.Commit(ctx); err != nil {
		return ReclassificationRun{}, fmt.Errorf("commit reclassification claim: %w", err)
	}
	return run, nil
}

func renewReclassificationLease(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	lease reclassificationLease,
) error {
	if tx == nil || strings.TrimSpace(tenantID) == "" ||
		strings.TrimSpace(lease.RunID) == "" || strings.TrimSpace(lease.WorkerID) == "" ||
		strings.TrimSpace(lease.Token) == "" || lease.AttemptCount < 1 ||
		lease.TTL < time.Millisecond || lease.TTL > 30*time.Minute {
		return fmt.Errorf("%w: invalid reclassification lease", ErrInvalidInput)
	}
	tag, err := tx.Exec(ctx, `
UPDATE event_reclassification_runs
   SET heartbeat_at = GREATEST(clock_timestamp(), heartbeat_at + interval '1 microsecond'),
       lease_expires_at = GREATEST(clock_timestamp(), heartbeat_at + interval '1 microsecond')
                          + ($6::bigint * interval '1 millisecond')
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND state = 'running'
   AND worker_id = $3 AND lease_token = $4::uuid AND attempt_count = $5
   AND lease_expires_at > statement_timestamp()`, tenantID, lease.RunID,
		lease.WorkerID, lease.Token, lease.AttemptCount, lease.TTL.Milliseconds())
	if err != nil {
		return fmt.Errorf("renew reclassification lease: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return ErrLeaseLost
	}
	return nil
}

func (repo *Repo) loadReclassificationCandidates(
	ctx context.Context,
	tenantID string,
	run ReclassificationRun,
	lease reclassificationLease,
	limit int,
) ([]EventRef, error) {
	tx, err := db.WithTenantWorker(ctx, repo.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindClassifierScope(ctx, tx); err != nil {
		return nil, err
	}
	if err := renewReclassificationLease(ctx, tx, tenantID, lease); err != nil {
		return nil, err
	}
	var cursorAt *time.Time
	var cursorID *int64
	if run.Cursor != nil {
		at := run.Cursor.At
		id := run.Cursor.ID
		cursorAt = &at
		cursorID = &id
	}
	rows, err := tx.Query(ctx, `
SELECT DISTINCT subscriber_event_at, subscriber_event_id
  FROM subscriber_event_observations
 WHERE tenant_id = $1::uuid
   AND occurred_at >= $2 AND occurred_at < $3
   AND ($4::timestamptz IS NULL OR
        (subscriber_event_at, subscriber_event_id) > ($4, $5))
 ORDER BY subscriber_event_at, subscriber_event_id
 LIMIT $6`, tenantID, run.Start, run.End, cursorAt, cursorID, limit)
	if err != nil {
		return nil, fmt.Errorf("query reclassification candidates: %w", err)
	}
	defer rows.Close()
	out := make([]EventRef, 0, limit)
	for rows.Next() {
		var event EventRef
		if err := rows.Scan(&event.At, &event.ID); err != nil {
			return nil, fmt.Errorf("scan reclassification candidate: %w", err)
		}
		out = append(out, event)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit reclassification candidate lease: %w", err)
	}
	return out, nil
}

func (repo *Repo) persistRunProgress(
	ctx context.Context,
	tenantID string,
	run ReclassificationRun,
	lease reclassificationLease,
) error {
	if run.Cursor == nil {
		return fmt.Errorf("%w: progress requires a cursor", ErrInvalidInput)
	}
	tx, err := db.WithTenantWorker(ctx, repo.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindClassifierScope(ctx, tx); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `
UPDATE event_reclassification_runs
   SET cursor_event_at = $3, cursor_event_id = $4,
       candidate_count = $5, classified_count = $6,
       unchanged_count = $7, error_count = $8,
       heartbeat_at = GREATEST(clock_timestamp(), heartbeat_at + interval '1 microsecond'),
       lease_expires_at = GREATEST(clock_timestamp(), heartbeat_at + interval '1 microsecond')
                          + ($12::bigint * interval '1 millisecond')
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND state = 'running'
   AND worker_id = $9 AND lease_token = $10::uuid AND attempt_count = $11
   AND lease_expires_at > statement_timestamp()`,
		tenantID, run.ID, run.Cursor.At, run.Cursor.ID, run.CandidateCount,
		run.ClassifiedCount, run.UnchangedCount, run.ErrorCount,
		lease.WorkerID, lease.Token, lease.AttemptCount, lease.TTL.Milliseconds())
	if err != nil {
		return fmt.Errorf("persist reclassification progress: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return ErrLeaseLost
	}
	return tx.Commit(ctx)
}

func (repo *Repo) completeReclassificationRun(
	ctx context.Context,
	tenantID string,
	run ReclassificationRun,
	lease reclassificationLease,
) (ReclassificationRun, error) {
	tx, err := db.WithTenantWorker(ctx, repo.Pool, tenantID)
	if err != nil {
		return run, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindClassifierScope(ctx, tx); err != nil {
		return run, err
	}
	completed := repo.now()
	tag, err := tx.Exec(ctx, `
UPDATE event_reclassification_runs
   SET state = 'completed', completed_at = $3,
       candidate_count = $4, classified_count = $5,
       unchanged_count = $6, error_count = $7
	 WHERE tenant_id = $1::uuid AND id = $2::uuid AND state = 'running'
   AND worker_id = $8 AND lease_token = $9::uuid AND attempt_count = $10
   AND lease_expires_at > statement_timestamp()`,
		tenantID, run.ID, completed, run.CandidateCount, run.ClassifiedCount,
		run.UnchangedCount, run.ErrorCount, lease.WorkerID, lease.Token,
		lease.AttemptCount)
	if err != nil {
		return run, fmt.Errorf("complete reclassification run: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return run, ErrLeaseLost
	}
	if err := tx.Commit(ctx); err != nil {
		return run, err
	}
	run.State = "completed"
	run.CompletedAt = &completed
	return run, nil
}

func (repo *Repo) failReclassificationRun(
	ctx context.Context,
	tenantID string,
	run ReclassificationRun,
	lease reclassificationLease,
	errorCode string,
	cause error,
) (ReclassificationRun, error) {
	if errors.Is(cause, ErrLeaseLost) {
		return run, cause
	}
	tx, err := db.WithTenantWorker(ctx, repo.Pool, tenantID)
	if err == nil {
		defer func() { _ = tx.Rollback(ctx) }()
		if err = bindClassifierScope(ctx, tx); err == nil {
			completed := repo.now()
			var tag pgconn.CommandTag
			tag, err = tx.Exec(ctx, `
UPDATE event_reclassification_runs
   SET state = 'failed', completed_at = $3, error_code = $4,
       candidate_count = $5, classified_count = $6,
       unchanged_count = $7, error_count = $8
	 WHERE tenant_id = $1::uuid AND id = $2::uuid AND state = 'running'
   AND worker_id = $9 AND lease_token = $10::uuid AND attempt_count = $11
   AND lease_expires_at > statement_timestamp()`,
				tenantID, run.ID, completed, errorCode, run.CandidateCount,
				run.ClassifiedCount, run.UnchangedCount, run.ErrorCount,
				lease.WorkerID, lease.Token, lease.AttemptCount)
			if err == nil && tag.RowsAffected() != 1 {
				err = ErrLeaseLost
			}
			if err == nil {
				err = tx.Commit(ctx)
				run.State = "failed"
				run.CompletedAt = &completed
			}
		}
	}
	if err != nil {
		return run, errors.Join(cause, fmt.Errorf("persist reclassification failure: %w", err))
	}
	return run, cause
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanReclassificationRun(row rowScanner) (ReclassificationRun, error) {
	var run ReclassificationRun
	var cursorAt *time.Time
	var cursorID *int64
	err := row.Scan(&run.ID, &run.RequestID, &run.RequestHash, &run.State,
		&run.Start, &run.End, &cursorAt, &cursorID, &run.CandidateCount,
		&run.ClassifiedCount, &run.UnchangedCount, &run.ErrorCount,
		&run.ClassifierVersion, &run.MethodologyVersion, &run.RegistryVersion,
		&run.ConfigurationHash, &run.WorkerID, &run.LeaseToken,
		&run.LeaseExpiresAt, &run.HeartbeatAt, &run.AttemptCount,
		&run.StartedAt, &run.CompletedAt)
	if err != nil {
		return ReclassificationRun{}, err
	}
	if cursorAt != nil && cursorID != nil {
		run.Cursor = &EventRef{ID: *cursorID, At: *cursorAt}
	}
	return run, nil
}

func loadEventEvidence(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	event EventRef,
) (ObservationInput, []string, MessageAggregate, error) {
	rows, err := tx.Query(ctx, observationSelectSQL+`
 WHERE tenant_id = $1::uuid
   AND subscriber_event_id = $2 AND subscriber_event_at = $3
 ORDER BY ingested_at, id
 LIMIT 257`, tenantID, event.ID, event.At)
	if err != nil {
		return ObservationInput{}, nil, MessageAggregate{}, fmt.Errorf("load event observations: %w", err)
	}
	defer rows.Close()
	var primary ObservationInput
	ids := make([]string, 0, 4)
	for rows.Next() {
		id, observation, err := scanObservation(rows)
		if err != nil {
			return ObservationInput{}, nil, MessageAggregate{}, err
		}
		if len(ids) == 0 {
			primary = observation
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return ObservationInput{}, nil, MessageAggregate{}, err
	}
	if len(ids) == 0 {
		return ObservationInput{}, nil, MessageAggregate{}, ErrNoObservation
	}
	if len(ids) > 256 {
		return ObservationInput{}, nil, MessageAggregate{}, fmt.Errorf("%w: event has more than 256 observations", ErrInvalidInput)
	}
	aggregate, err := loadMessageAggregate(ctx, tx, tenantID, primary)
	if err != nil {
		return ObservationInput{}, nil, MessageAggregate{}, err
	}
	return primary, ids, aggregate, nil
}

const observationSelectSQL = `
SELECT id::text, subscriber_event_id, subscriber_event_at,
       source, COALESCE(source_event_id, ''), idempotency_key,
       event_schema_version, event_type, occurred_at, ingested_at,
       delivered_at, COALESCE(campaign_id::text, ''),
       COALESCE(recipient_identity_hmac, ''), COALESCE(recipient_key_id, ''),
       COALESCE(message_identity_hash, ''), COALESCE(link_identity_hash, ''),
       is_seed, COALESCE(seed_test_id::text, ''),
       COALESCE(provider_message_id, ''), COALESCE(provider_request_id, ''),
       ordered_headers, ordered_headers_complete, COALESCE(user_agent, ''),
       COALESCE(host(ip_address), ''), network_asn, network_asn_source,
       COALESCE(network_region, ''), COALESCE(reverse_dns, ''),
       COALESCE(tls_ja4, ''), provider_signals, dwell_milliseconds,
       message_link_count, COALESCE(body_hash, ''),
       COALESCE(raw_object_ref, ''), COALESCE(raw_object_version_id, ''),
       privacy_expiry_at
  FROM subscriber_event_observations`

func scanObservation(row rowScanner) (string, ObservationInput, error) {
	var (
		id          string
		observation ObservationInput
		headersRaw  []byte
		signalsRaw  []byte
		asn         *int64
		asnSource   string
	)
	err := row.Scan(&id, &observation.ID, &observation.At, &observation.Source,
		&observation.SourceEventID, &observation.IdempotencyKey,
		&observation.EventSchemaVersion, &observation.EventType,
		&observation.OccurredAt, &observation.IngestedAt, &observation.DeliveredAt,
		&observation.CampaignID, &observation.RecipientIdentityHMAC,
		&observation.RecipientKeyID, &observation.MessageIdentityHash,
		&observation.LinkIdentityHash, &observation.IsSeed, &observation.SeedTestID,
		&observation.ProviderMessageID, &observation.ProviderRequestID,
		&headersRaw, &observation.OrderedHeadersComplete,
		&observation.UserAgent, &observation.IP, &asn, &asnSource,
		&observation.NetworkRegion, &observation.ReverseDNS, &observation.TLSJA4,
		&signalsRaw, &observation.DwellMilliseconds, &observation.MessageLinkCount,
		&observation.BodyHash, &observation.RawObjectRef,
		&observation.RawObjectVersionID, &observation.PrivacyExpiryAt)
	if err != nil {
		return "", ObservationInput{}, fmt.Errorf("scan engagement observation: %w", err)
	}
	if asn != nil {
		value := uint32(*asn)
		observation.NetworkASN = &value
	}
	// Provenance is read back with the value. A reclassification that lost it
	// would re-derive a verdict from evidence it could no longer describe, and
	// the retention degradation exemption deliberately KEEPS the ASN on a
	// degraded row — so the row that most needs its provenance is exactly the
	// one this path revisits.
	observation.NetworkASNSource = NetworkASNSource(asnSource)
	if err := json.Unmarshal(headersRaw, &observation.OrderedHeaders); err != nil {
		return "", ObservationInput{}, fmt.Errorf("decode ordered headers: %w", err)
	}
	if err := json.Unmarshal(signalsRaw, &observation.ProviderSignals); err != nil {
		return "", ObservationInput{}, fmt.Errorf("decode provider signals: %w", err)
	}
	return id, observation, nil
}

func loadMessageAggregate(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	primary ObservationInput,
) (MessageAggregate, error) {
	aggregate := MessageAggregate{DeliveredAt: primary.DeliveredAt}
	if primary.MessageIdentityHash == "" {
		if primary.MessageLinkCount != nil {
			aggregate.TotalLinks = *primary.MessageLinkCount
		}
		return aggregate, nil
	}
	aggregate.Complete = true
	rows, err := tx.Query(ctx, `
SELECT event_type, occurred_at, delivered_at,
       COALESCE(link_identity_hash, ''), COALESCE(user_agent, ''),
       message_link_count, COALESCE(network_region, '')
  FROM subscriber_event_observations
 WHERE tenant_id = $1::uuid AND message_identity_hash = $2
 ORDER BY occurred_at, id
 LIMIT 10001`, tenantID, primary.MessageIdentityHash)
	if err != nil {
		return MessageAggregate{}, fmt.Errorf("load message aggregate: %w", err)
	}
	defer rows.Close()
	links := make(map[string]struct{})
	openRegions := make(map[string]struct{})
	var firstAt, lastAt time.Time
	var lastOpenAt, firstRegionAt, lastRegionAt time.Time
	// The delivery time, derived from the sibling 'delivered' EVENT.
	//
	// The delivered_at COLUMN is accepted end-to-end and never populated by any
	// writer, so R_PREFETCH_LATENCY and R_HUMAN_LATENCY — the two rules that
	// decide whether an open arrived too fast to be human — could never fire.
	// Both read a delivery time that was always nil.
	//
	// It does not need a new producer at ingest: a 'delivered' event's own
	// occurred_at IS the delivery time, and it is already in this table, already
	// in this query. Deriving it here also means every historical message gains a
	// delivery time on the next reclassification rather than only new ones.
	var deliveredEventAt *time.Time
	for rows.Next() {
		var eventType, linkHash, userAgent, networkRegion string
		var occurredAt time.Time
		var deliveredAt *time.Time
		var totalLinks *int
		if err := rows.Scan(&eventType, &occurredAt, &deliveredAt,
			&linkHash, &userAgent, &totalLinks, &networkRegion); err != nil {
			return MessageAggregate{}, err
		}
		aggregate.EventCount++
		if firstAt.IsZero() {
			firstAt = occurredAt
		}
		lastAt = occurredAt
		if aggregate.DeliveredAt == nil && deliveredAt != nil {
			aggregate.DeliveredAt = deliveredAt
		}
		if eventType == "delivered" {
			// Earliest wins: a message delivered once and re-reported by a
			// provider retry was delivered at the first time, and taking the
			// latest would shrink every latency and make human opens look like
			// prefetches.
			if deliveredEventAt == nil || occurredAt.Before(*deliveredEventAt) {
				at := occurredAt
				deliveredEventAt = &at
			}
		}
		if totalLinks != nil && *totalLinks > aggregate.TotalLinks {
			aggregate.TotalLinks = *totalLinks
		}
		if linkHash != "" {
			links[linkHash] = struct{}{}
		}
		switch eventType {
		case "opened":
			aggregate.OpenUserAgents = append(aggregate.OpenUserAgents, userAgent)
			aggregate.OpenCount++
			// Rows arrive ordered by occurred_at, so the gap to the previous
			// open is the candidate minimum; keep the smallest seen.
			if !lastOpenAt.IsZero() {
				gap := occurredAt.Sub(lastOpenAt)
				if gap >= 0 && (aggregate.MinOpenGap == 0 || gap < aggregate.MinOpenGap) {
					aggregate.MinOpenGap = gap
				}
			}
			lastOpenAt = occurredAt
			if aggregate.FirstOpenAt == nil {
				at := occurredAt
				aggregate.FirstOpenAt = &at
			}
			// Regions are counted, never collected: the classifier records rule
			// identity, and a region name in evidence would be recipient data.
			if networkRegion != "" {
				if _, seen := openRegions[networkRegion]; !seen {
					openRegions[networkRegion] = struct{}{}
					if firstRegionAt.IsZero() {
						firstRegionAt = occurredAt
					}
					lastRegionAt = occurredAt
				}
			}
			if occurredAt.Before(primary.OccurredAt) {
				aggregate.HasPrecedingOpen = true
			}
		case "clicked":
			aggregate.ClickUserAgents = append(aggregate.ClickUserAgents, userAgent)
		}
	}
	if err := rows.Err(); err != nil {
		return MessageAggregate{}, err
	}
	// Fall back to the derived delivery time. The explicit column wins when a
	// writer ever populates it — this is a floor, not a replacement.
	if aggregate.DeliveredAt == nil {
		aggregate.DeliveredAt = deliveredEventAt
	}
	if aggregate.EventCount > 10000 {
		return MessageAggregate{}, fmt.Errorf("%w: message aggregate exceeds 10000 observations", ErrInvalidInput)
	}
	aggregate.DistinctLinksFetched = len(links)
	aggregate.DistinctOpenRegions = len(openRegions)
	if aggregate.DistinctOpenRegions >= 2 && !firstRegionAt.IsZero() && !lastRegionAt.IsZero() {
		// The span between the FIRST and LAST newly-seen region. With one
		// region there is no journey to judge, so the span stays zero and the
		// rule cannot fire.
		aggregate.RegionSpan = lastRegionAt.Sub(firstRegionAt)
	}
	if !firstAt.IsZero() && !lastAt.IsZero() {
		aggregate.BurstWindow = lastAt.Sub(firstAt)
	}
	return aggregate, nil
}
