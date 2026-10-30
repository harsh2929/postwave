package reportstore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const (
	seedObservationDeletionReceiptVersion = "postwave.seed-observation-object-deletion.v1"
	defaultSeedRetentionBatchSize         = 100
	maxSeedRetentionBatchSize             = 1000
	defaultSeedRetentionInterval          = time.Hour
	defaultSeedRetentionBackoff           = time.Minute
)

// SeedObservationObject identifies one exact, versioned object whose payload
// has reached its short-retention boundary. ObjectRef is service-internal and
// must never be emitted to logs, metrics, or customer responses.
type SeedObservationObject struct {
	TenantID      string
	ObservationID string
	ObjectKind    string
	ObjectRef     string
	ObjectVersion string
	ExpiresAt     time.Time
}

// SeedObservationDeletionRecord is the non-secret append-only acknowledgement
// written only after the object store has accepted an exact-version delete.
type SeedObservationDeletionRecord struct {
	ObjectRefSHA256 string
	Receipt         map[string]any
	DeletedAt       time.Time
}

// SeedObservationRetentionStore is deliberately small so the object deletion
// loop can be tested independently from PostgreSQL and S3.
type SeedObservationRetentionStore interface {
	ListExpiredSeedObservationObjects(context.Context, time.Time, int) ([]SeedObservationObject, error)
	RecordSeedObservationObjectDeletion(context.Context, SeedObservationObject, SeedObservationDeletionRecord) (alreadyRecorded bool, err error)
}

// SeedObservationRetentionResult is safe for structured logs: it contains no
// tenant, mailbox, object, or message identifiers.
type SeedObservationRetentionResult struct {
	Scanned         int
	Deleted         int
	AlreadyRecorded int
	Failed          int
}

// SeedObservationRetentionSweeper deletes expired raw MIME by exact S3 object
// version and then appends an immutable database receipt. DeleteObject is
// idempotent for an exact version, so a crash after S3 success but before the
// database receipt safely retries instead of silently retaining private data.
type SeedObservationRetentionSweeper struct {
	Store     SeedObservationRetentionStore
	Objects   ObservationObjectStore
	BatchSize int
	Interval  time.Duration
	Backoff   time.Duration
	Now       func() time.Time
	Logger    *slog.Logger
}

func (w *SeedObservationRetentionSweeper) RunOnce(ctx context.Context) (SeedObservationRetentionResult, error) {
	var result SeedObservationRetentionResult
	if w == nil || w.Store == nil {
		return result, errors.New("seed observation retention: store is required")
	}
	if w.Objects == nil {
		return result, errors.New("seed observation retention: object store is required")
	}
	batchSize := w.BatchSize
	if batchSize <= 0 {
		batchSize = defaultSeedRetentionBatchSize
	}
	if batchSize > maxSeedRetentionBatchSize {
		return result, fmt.Errorf("seed observation retention: batch size exceeds %d", maxSeedRetentionBatchSize)
	}
	now := time.Now().UTC()
	if w.Now != nil {
		now = w.Now().UTC()
	}
	candidates, err := w.Store.ListExpiredSeedObservationObjects(ctx, now, batchSize)
	if err != nil {
		return result, fmt.Errorf("seed observation retention: list: %w", err)
	}
	result.Scanned = len(candidates)
	var failures []error
	for _, candidate := range candidates {
		if err := ctx.Err(); err != nil {
			failures = append(failures, err)
			break
		}
		if candidate.ObjectKind != "received_mime" {
			result.Failed++
			failures = append(failures, fmt.Errorf("seed observation retention: unsupported object kind %q", candidate.ObjectKind))
			continue
		}
		if candidate.ExpiresAt.After(now) {
			result.Failed++
			failures = append(failures, errors.New("seed observation retention: store returned an unexpired object"))
			continue
		}
		receipt := ObjectReceipt{ObjectRef: candidate.ObjectRef, VersionID: candidate.ObjectVersion}
		if err := w.Objects.DeleteRawMIME(ctx, receipt); err != nil {
			result.Failed++
			// Object-store errors can include request paths. Keep the worker's
			// returned/logged error free of private object coordinates.
			failures = append(failures, errors.New("seed observation retention: exact-version delete failed"))
			continue
		}
		record := SeedObservationDeletionRecord{
			ObjectRefSHA256: digestString(candidate.ObjectRef),
			DeletedAt:       now,
			Receipt: map[string]any{
				"schema":                seedObservationDeletionReceiptVersion,
				"store":                 "s3",
				"result":                "exact_version_delete_acknowledged",
				"object_version_sha256": digestString(candidate.ObjectVersion),
			},
		}
		alreadyRecorded, err := w.Store.RecordSeedObservationObjectDeletion(ctx, candidate, record)
		if err != nil {
			result.Failed++
			failures = append(failures, fmt.Errorf("seed observation retention: record receipt: %w", err))
			continue
		}
		if alreadyRecorded {
			result.AlreadyRecorded++
		} else {
			result.Deleted++
		}
	}
	return result, errors.Join(failures...)
}

// Run executes an immediate pass, then waits the configured interval. Errors
// back off without stopping the process; cancellation is the only terminal
// condition and supports the service's normal graceful shutdown.
func (w *SeedObservationRetentionSweeper) Run(ctx context.Context) error {
	if w == nil {
		return errors.New("seed observation retention: worker is required")
	}
	interval := w.Interval
	if interval <= 0 {
		interval = defaultSeedRetentionInterval
	}
	backoff := w.Backoff
	if backoff <= 0 {
		backoff = defaultSeedRetentionBackoff
	}
	logger := w.Logger
	if logger == nil {
		logger = slog.Default()
	}
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		started := time.Now()
		result, err := w.RunOnce(ctx)
		wait := interval - time.Since(started)
		if err != nil {
			logger.Warn("seed observation retention pass failed",
				"err", err.Error(), "scanned", result.Scanned,
				"deleted", result.Deleted, "failed", result.Failed)
			wait = backoff
		} else {
			logger.Info("seed observation retention pass complete",
				"scanned", result.Scanned, "deleted", result.Deleted,
				"already_recorded", result.AlreadyRecorded)
		}
		if wait < 0 {
			wait = 0
		}
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return ctx.Err()
		case <-timer.C:
		}
	}
}

func (s *PostgresStore) ListExpiredSeedObservationObjects(ctx context.Context, before time.Time, limit int) ([]SeedObservationObject, error) {
	if s == nil || s.Pool == nil {
		return nil, errors.New("postgres reportstore: nil pool")
	}
	if before.IsZero() {
		return nil, errors.New("seed observation retention: cutoff is required")
	}
	if limit <= 0 || limit > maxSeedRetentionBatchSize {
		return nil, fmt.Errorf("seed observation retention: limit must be between 1 and %d", maxSeedRetentionBatchSize)
	}
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, fmt.Errorf("list expired seed observations: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := setSeedRetentionScope(ctx, tx); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT o.tenant_id::text, o.id::text, 'received_mime',
       o.raw_mime_object_ref, COALESCE(o.raw_mime_object_version, ''), o.expires_at
  FROM seed_message_observations o
  LEFT JOIN seed_observation_object_deletions d
    ON d.tenant_id = o.tenant_id
   AND d.observation_id = o.id
   AND d.object_kind = 'received_mime'
 WHERE o.expires_at <= $1
   AND o.raw_mime_object_ref IS NOT NULL
   AND d.id IS NULL
   -- Legal hold (migration 1973). Seed observations DO carry a campaign, so
   -- this asks the narrow question: a hold on one campaign must not freeze
   -- retention for every other campaign the tenant ever sent. The predicate is
   -- the same SQL function every other assurance sweep calls — one definition,
   -- so a change cannot reach three sweeps and miss the fourth.
   AND NOT campaign_assurance_legal_hold_active(o.tenant_id, o.campaign_id)
 ORDER BY o.expires_at, o.id
 LIMIT $2
`, before.UTC(), limit)
	if err != nil {
		return nil, fmt.Errorf("list expired seed observations: %w", err)
	}
	defer rows.Close()
	objects := make([]SeedObservationObject, 0, limit)
	for rows.Next() {
		var object SeedObservationObject
		if err := rows.Scan(&object.TenantID, &object.ObservationID, &object.ObjectKind,
			&object.ObjectRef, &object.ObjectVersion, &object.ExpiresAt); err != nil {
			return nil, fmt.Errorf("list expired seed observations: scan: %w", err)
		}
		objects = append(objects, object)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list expired seed observations: rows: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("list expired seed observations: commit: %w", err)
	}
	return objects, nil
}

func (s *PostgresStore) RecordSeedObservationObjectDeletion(ctx context.Context, object SeedObservationObject, record SeedObservationDeletionRecord) (bool, error) {
	if s == nil || s.Pool == nil {
		return false, errors.New("postgres reportstore: nil pool")
	}
	if _, err := uuid.Parse(strings.TrimSpace(object.TenantID)); err != nil {
		return false, errors.New("seed observation retention: tenant id must be a UUID")
	}
	if _, err := uuid.Parse(strings.TrimSpace(object.ObservationID)); err != nil {
		return false, errors.New("seed observation retention: observation id must be a UUID")
	}
	if object.ObjectKind != "received_mime" {
		return false, errors.New("seed observation retention: unsupported object kind")
	}
	if strings.TrimSpace(object.ObjectRef) == "" || len(object.ObjectRef) > 2000 {
		return false, errors.New("seed observation retention: invalid object reference")
	}
	if strings.TrimSpace(object.ObjectVersion) == "" || len(object.ObjectVersion) > 1024 {
		return false, errors.New("seed observation retention: exact object version is required")
	}
	if !validLowerSHA256(strings.TrimSpace(record.ObjectRefSHA256)) || record.ObjectRefSHA256 != digestString(object.ObjectRef) {
		return false, errors.New("seed observation retention: object reference digest mismatch")
	}
	deletedAt := record.DeletedAt.UTC()
	if deletedAt.IsZero() {
		return false, errors.New("seed observation retention: deleted_at is required")
	}
	receiptJSON, err := json.Marshal(record.Receipt)
	if err != nil {
		return false, fmt.Errorf("seed observation retention: encode receipt: %w", err)
	}
	if len(receiptJSON) == 0 || len(receiptJSON) > 16*1024 {
		return false, errors.New("seed observation retention: invalid receipt size")
	}

	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("record seed observation deletion: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := setSeedRetentionScope(ctx, tx); err != nil {
		return false, err
	}
	lockKey := object.TenantID + ":" + object.ObservationID + ":" + object.ObjectKind
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, lockKey); err != nil {
		return false, fmt.Errorf("record seed observation deletion: lock: %w", err)
	}
	var currentRef, currentVersion string
	var expiresAt time.Time
	err = tx.QueryRow(ctx, `
SELECT raw_mime_object_ref, COALESCE(raw_mime_object_version, ''), expires_at
  FROM seed_message_observations
 WHERE tenant_id = $1::uuid AND id = $2::uuid
`, object.TenantID, object.ObservationID).Scan(&currentRef, &currentVersion, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, errors.New("seed observation retention: observation not found")
	}
	if err != nil {
		return false, fmt.Errorf("record seed observation deletion: read observation: %w", err)
	}
	if currentRef != object.ObjectRef || currentVersion != object.ObjectVersion {
		return false, errors.New("seed observation retention: immutable object identity mismatch")
	}
	if expiresAt.After(deletedAt) {
		return false, errors.New("seed observation retention: object has not expired")
	}
	command, err := tx.Exec(ctx, `
INSERT INTO seed_observation_object_deletions (
    tenant_id, observation_id, object_kind, object_ref_sha256,
    reason, deletion_receipt, deleted_at
) VALUES ($1::uuid, $2::uuid, $3, $4, 'retention', $5::jsonb, $6)
ON CONFLICT (tenant_id, observation_id, object_kind) DO NOTHING
`, object.TenantID, object.ObservationID, object.ObjectKind,
		record.ObjectRefSHA256, string(receiptJSON), deletedAt)
	if err != nil {
		return false, fmt.Errorf("record seed observation deletion: insert: %w", err)
	}
	alreadyRecorded := command.RowsAffected() == 0
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("record seed observation deletion: commit: %w", err)
	}
	return alreadyRecorded, nil
}

func setSeedRetentionScope(ctx context.Context, tx pgx.Tx) error {
	if _, err := tx.Exec(ctx, `SELECT set_config('app.outbox_worker','true',true)`); err != nil {
		return fmt.Errorf("seed observation retention: outbox scope: %w", err)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.seed_observation_retention_worker','true',true)`); err != nil {
		return fmt.Errorf("seed observation retention: worker scope: %w", err)
	}
	return nil
}
