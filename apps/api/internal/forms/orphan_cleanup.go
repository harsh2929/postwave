package forms

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

type orphanUpload struct {
	ID         string
	TenantID   string
	StorageKey string
	ClaimedAt  time.Time
}

// OrphanCleanupResult describes one bounded cleanup pass.
type OrphanCleanupResult struct {
	Claimed int
	Deleted int
	Failed  int
}

// CleanupOrphans claims unlinked uploads older than cutoff, removes their
// objects, then removes their metadata rows. Claims are committed before
// object I/O so no database transaction is held open across S3 requests.
//
// Cleanup is retry-safe: object deletion is idempotent, a successful object
// delete followed by a database failure is retried after the claim lease
// expires, and a failed object delete releases its claim for a later pass.
func (u *Uploads) CleanupOrphans(ctx context.Context, cutoff time.Time, limit int) (OrphanCleanupResult, error) {
	var result OrphanCleanupResult
	if u == nil || u.Pool == nil {
		return result, errors.New("forms: orphan cleanup requires a database pool")
	}
	if u.Store == nil {
		return result, errors.New("forms: orphan cleanup requires an upload store")
	}
	if cutoff.IsZero() {
		return result, errors.New("forms: orphan cleanup requires a cutoff")
	}
	if limit <= 0 {
		limit = 100
	}
	if limit > 1000 {
		limit = 1000
	}

	claimed, err := u.claimOrphans(ctx, cutoff.UTC(), limit)
	if err != nil {
		return result, err
	}
	result.Claimed = len(claimed)

	var cleanupErrs []error
	for _, upload := range claimed {
		if err := ctx.Err(); err != nil {
			cleanupErrs = append(cleanupErrs, err)
			break
		}
		if err := u.Store.Delete(ctx, upload.StorageKey); err != nil {
			result.Failed++
			cleanupErrs = append(cleanupErrs, fmt.Errorf("delete orphan object %s: %w", upload.ID, err))
			if releaseErr := u.releaseOrphanClaim(ctx, upload); releaseErr != nil {
				cleanupErrs = append(cleanupErrs, fmt.Errorf("release orphan claim %s: %w", upload.ID, releaseErr))
			}
			continue
		}
		deleted, err := u.deleteOrphanRow(ctx, upload)
		if err != nil {
			result.Failed++
			cleanupErrs = append(cleanupErrs, fmt.Errorf("delete orphan row %s: %w", upload.ID, err))
			continue
		}
		if deleted {
			result.Deleted++
		}
	}
	return result, errors.Join(cleanupErrs...)
}

func (u *Uploads) claimOrphans(ctx context.Context, cutoff time.Time, limit int) ([]orphanUpload, error) {
	tx, err := db.WithWorkerScope(ctx, u.Pool)
	if err != nil {
		return nil, fmt.Errorf("forms: begin orphan claim: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
WITH candidates AS (
    SELECT id
      FROM form_file_uploads
     WHERE submission_id IS NULL
       AND uploaded_at < $1
       AND (
            cleanup_claimed_at IS NULL
            OR cleanup_claimed_at < now() - INTERVAL '1 hour'
       )
     ORDER BY uploaded_at, id
     FOR UPDATE SKIP LOCKED
     LIMIT $2
)
UPDATE form_file_uploads AS upload
   SET cleanup_claimed_at = now()
  FROM candidates
 WHERE upload.id = candidates.id
RETURNING upload.id::text,
          upload.tenant_id::text,
          upload.storage_key,
          upload.cleanup_claimed_at`, cutoff, limit)
	if err != nil {
		return nil, fmt.Errorf("forms: claim orphan uploads: %w", err)
	}
	claimed := make([]orphanUpload, 0, limit)
	for rows.Next() {
		var upload orphanUpload
		if err := rows.Scan(&upload.ID, &upload.TenantID, &upload.StorageKey, &upload.ClaimedAt); err != nil {
			rows.Close()
			return nil, fmt.Errorf("forms: scan orphan claim: %w", err)
		}
		claimed = append(claimed, upload)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, fmt.Errorf("forms: iterate orphan claims: %w", err)
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("forms: commit orphan claims: %w", err)
	}
	return claimed, nil
}

func (u *Uploads) releaseOrphanClaim(ctx context.Context, upload orphanUpload) error {
	tx, err := db.WithTenant(ctx, u.Pool, upload.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE form_file_uploads
   SET cleanup_claimed_at = NULL
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
   AND submission_id IS NULL
   AND cleanup_claimed_at = $3`, upload.TenantID, upload.ID, upload.ClaimedAt); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (u *Uploads) deleteOrphanRow(ctx context.Context, upload orphanUpload) (bool, error) {
	tx, err := db.WithTenant(ctx, u.Pool, upload.TenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
DELETE FROM form_file_uploads
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
   AND submission_id IS NULL
   AND cleanup_claimed_at = $3`, upload.TenantID, upload.ID, upload.ClaimedAt)
	if err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// OrphanSweeper reclaims abandoned public-form uploads. It runs once at
// startup and then periodically, processing a bounded number of batches on
// each tick so cleanup cannot monopolize the API process after a long outage.
type OrphanSweeper struct {
	Uploads    *Uploads
	RetainFor  time.Duration
	Interval   time.Duration
	BatchSize  int
	MaxBatches int
	Logger     *slog.Logger
}

func (s *OrphanSweeper) Run(ctx context.Context) {
	if s == nil || s.Uploads == nil {
		return
	}
	if s.RetainFor <= 0 {
		s.RetainFor = 24 * time.Hour
	}
	if s.Interval <= 0 {
		s.Interval = time.Hour
	}
	if s.BatchSize <= 0 {
		s.BatchSize = 100
	}
	if s.MaxBatches <= 0 {
		s.MaxBatches = 10
	}

	s.sweep(ctx)
	ticker := time.NewTicker(s.Interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.sweep(ctx)
		}
	}
}

func (s *OrphanSweeper) sweep(ctx context.Context) {
	cutoff := time.Now().UTC().Add(-s.RetainFor)
	for batch := 0; batch < s.MaxBatches; batch++ {
		result, err := s.Uploads.CleanupOrphans(ctx, cutoff, s.BatchSize)
		if err != nil {
			if s.Logger != nil && !errors.Is(err, context.Canceled) {
				s.Logger.Warn("form upload orphan cleanup failed", "err", err.Error(), "claimed", result.Claimed, "deleted", result.Deleted, "failed", result.Failed)
			}
			return
		}
		if s.Logger != nil && result.Deleted > 0 {
			s.Logger.Info("form upload orphans deleted", "claimed", result.Claimed, "deleted", result.Deleted, "cutoff", cutoff.Format(time.RFC3339))
		}
		if result.Claimed < s.BatchSize {
			return
		}
	}
}
