// SPDX-License-Identifier: AGPL-3.0-only
//
// worker.go — picks up queued tenant_exports rows, walks each
// requested resource, builds a bounded zip, uploads to private object storage,
// and marks the row ready without minting or persisting a bearer URL.

package exports

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/postwave/postwave/apps/api/internal/db"
)

// Worker is the background job runner.
type Worker struct {
	Pool           *db.Pool
	Storage        Storage
	Logger         *slog.Logger
	Interval       time.Duration
	MaxBundleBytes int64
	LeaseDuration  time.Duration
	HeartbeatEvery time.Duration
	LegacyStaleAge time.Duration
}

const (
	DefaultMaxBundleBytes int64 = 2 * 1024 * 1024 * 1024
	defaultLeaseDuration        = 10 * time.Minute
	defaultHeartbeatEvery       = 2 * time.Minute
	defaultLegacyStaleAge       = 6 * time.Hour
)

var errExportBundleTooLarge = errors.New("export bundle exceeds configured byte limit")
var errExportLeaseLost = errors.New("export worker lease lost")

// Run drives the worker until ctx is canceled.
func (w *Worker) Run(ctx context.Context) error {
	if w == nil || w.Pool == nil || w.Storage == nil {
		return errors.New("exports worker: incomplete deps")
	}
	interval := w.Interval
	if interval <= 0 {
		interval = 10 * time.Second
	}
	logger := w.Logger
	if logger == nil {
		logger = slog.Default()
	}
	logger.Info("exports worker: starting", "interval", interval.String())
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if err := w.tick(ctx); err != nil {
			logger.Warn("exports tick failed", "err", err.Error())
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}

// tick claims one queued job, processes it, and updates the row.
// Single-flight per tick is deliberate — exports can be GB-scale and
// we don't want to fan out N workers that all try to read the same
// large tenant.
func (w *Worker) tick(ctx context.Context) error {
	// Claim one job in its own short worker-scope tx so the 'running' stamp
	// commits (and the row lock releases) immediately — the long zip build +
	// S3 upload below must NOT run with a tx held open.
	var jobID, tenantID, leaseToken string
	var previousLeaseToken *string
	var includeJSON []byte
	{
		tx, err := db.WithWorkerScope(ctx, w.Pool)
		if err != nil {
			return err
		}
		// Claim with SKIP LOCKED so two workers running this tick in
		// parallel never grab the same row.
		leaseSeconds := durationSeconds(w.leaseDuration())
		legacyStaleSeconds := durationSeconds(w.legacyStaleAge())
		err = tx.QueryRow(ctx, `
WITH candidate AS (
    SELECT id, lease_token AS previous_lease_token
      FROM tenant_exports
     WHERE status = 'queued'
        OR (
            status = 'running'
            AND (
                (
                    lease_token IS NOT NULL
                    AND (
                        lease_expires_at IS NULL
                        OR lease_expires_at <= clock_timestamp()
                    )
                )
                OR (
                    lease_token IS NULL
                    AND COALESCE(started_at, created_at) <= clock_timestamp()
                        - make_interval(secs => $2)
                )
            )
        )
     ORDER BY
        CASE WHEN status = 'queued' THEN 0 ELSE 1 END,
        created_at ASC,
        id ASC
     FOR UPDATE SKIP LOCKED
     LIMIT 1
), claimed AS (
    UPDATE tenant_exports AS jobs
       SET status = 'running',
           started_at = clock_timestamp(),
           completed_at = NULL,
           error = NULL,
           lease_token = gen_random_uuid(),
           lease_expires_at = clock_timestamp() + make_interval(secs => $1),
           heartbeat_at = clock_timestamp(),
           attempt_count = attempt_count + 1
      FROM candidate
     WHERE jobs.id = candidate.id
 RETURNING jobs.id::text, jobs.tenant_id::text, jobs.include,
           jobs.lease_token::text, candidate.previous_lease_token::text
)
SELECT id, tenant_id, include, lease_token, previous_lease_token
  FROM claimed`, leaseSeconds, legacyStaleSeconds).Scan(
			&jobID,
			&tenantID,
			&includeJSON,
			&leaseToken,
			&previousLeaseToken,
		)
		if err != nil {
			_ = tx.Rollback(ctx)
			if errors.Is(err, pgx.ErrNoRows) {
				return nil
			}
			return fmt.Errorf("claim export: %w", err)
		}
		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("claim commit: %w", err)
		}
	}

	workCtx, heartbeat := w.startLeaseHeartbeat(ctx, jobID, leaseToken)
	defer func() { _ = heartbeat.Stop() }()
	if previousLeaseToken != nil && *previousLeaseToken != "" {
		staleObjectKey := exportObjectKey(tenantID, jobID, *previousLeaseToken)
		if err := w.deleteObject(workCtx, staleObjectKey); err != nil {
			if w.Logger != nil {
				w.Logger.Error("exports: stale attempt object purge failed",
					"id", jobID, "object_key", staleObjectKey, "err", err)
			}
			return fmt.Errorf("purge stale export attempt: %w", err)
		}
	}

	var include []string
	if err := json.Unmarshal(includeJSON, &include); err != nil || !validResourceSelection(include) {
		cause := err
		if cause == nil {
			cause = errors.New("invalid persisted resource selection")
		}
		return w.failAttempt(ctx, heartbeat, jobID, leaseToken, "invalid_selection", cause)
	}

	if w.Logger != nil {
		w.Logger.Info("exports: processing job",
			"id", jobID, "tenant", tenantID, "include", include)
	}

	// Build into a private temporary file rather than retaining a workspace's
	// complete export in process memory. The bounded writer fails closed before
	// an unexpectedly large tenant can exhaust the container's RAM or disk.
	maxBundleBytes := w.MaxBundleBytes
	if maxBundleBytes <= 0 {
		maxBundleBytes = DefaultMaxBundleBytes
	}
	tmp, err := os.CreateTemp("", "postwave-tenant-export-*.zip")
	if err != nil {
		return w.failAttempt(ctx, heartbeat, jobID, leaseToken, "temporary_file", err)
	}
	tmpName := tmp.Name()
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
	}()
	if err := tmp.Chmod(0o600); err != nil {
		return w.failAttempt(ctx, heartbeat, jobID, leaseToken, "temporary_file", err)
	}
	bundleHasher := sha256.New()
	bounded := &maxBytesWriter{
		Writer: io.MultiWriter(tmp, bundleHasher),
		Max:    maxBundleBytes,
	}
	zw := zip.NewWriter(bounded)
	totalRows := int64(0)
	{
		tx, err := db.WithWorkerScope(workCtx, w.Pool)
		if err != nil {
			return w.failAttempt(ctx, heartbeat, jobID, leaseToken, "data_read", err)
		}
		// Bind app.tenant_id (SET LOCAL) so the walks RLS down to the
		// target tenant; it dies with this tx.
		if _, err := tx.Exec(workCtx,
			`SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
			_ = tx.Rollback(workCtx)
			return w.failAttempt(ctx, heartbeat, jobID, leaseToken, "data_read", err)
		}
		for _, resource := range include {
			count, err := w.walkResource(workCtx, tx, tenantID, resource, zw)
			if err != nil {
				_ = zw.Close()
				_ = tx.Rollback(workCtx)
				return w.failAttempt(ctx, heartbeat, jobID, leaseToken, "data_read", err)
			}
			totalRows += count
		}
		_ = tx.Rollback(workCtx) // read-only — release before the upload
	}
	if err := zw.Close(); err != nil {
		if errors.Is(err, errExportBundleTooLarge) {
			return w.failAttempt(ctx, heartbeat, jobID, leaseToken, "bundle_too_large", errExportBundleTooLarge)
		}
		return w.failAttempt(ctx, heartbeat, jobID, leaseToken, "bundle_write", err)
	}
	if err := tmp.Sync(); err != nil {
		return w.failAttempt(ctx, heartbeat, jobID, leaseToken, "bundle_write", err)
	}
	stat, err := tmp.Stat()
	if err != nil {
		return w.failAttempt(ctx, heartbeat, jobID, leaseToken, "bundle_write", err)
	}
	bytesTotal := stat.Size()
	if bytesTotal <= 0 || bytesTotal > maxBundleBytes {
		return w.failAttempt(ctx, heartbeat, jobID, leaseToken, "bundle_too_large", errExportBundleTooLarge)
	}
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		return w.failAttempt(ctx, heartbeat, jobID, leaseToken, "bundle_write", err)
	}
	bundleSHA256 := hex.EncodeToString(bundleHasher.Sum(nil))
	if !validSHA256Hex(bundleSHA256) {
		return w.failAttempt(ctx, heartbeat, jobID, leaseToken, "bundle_write",
			errors.New("private export bundle digest is invalid"))
	}

	// Read the tenant policy immediately before upload. Missing rows are
	// initialized to the bounded defaults inside tenant RLS; any database,
	// policy, or contract error fails the job before a blob is written. A
	// hard-coded fallback here would silently extend or shorten retention while
	// the settings route reported a different value.
	retentionDays, err := w.retentionDays(workCtx, tenantID)
	if err != nil {
		return w.failAttempt(ctx, heartbeat, jobID, leaseToken, "retention_policy", err)
	}

	objectKey := exportObjectKey(tenantID, jobID, leaseToken)
	if err := w.Storage.Put(
		workCtx, objectKey, "application/zip", tmp, bytesTotal, bundleSHA256,
	); err != nil {
		w.deleteUncommittedObject(objectKey)
		return w.failAttempt(ctx, heartbeat, jobID, leaseToken, "storage_write", err)
	}
	expiresAt := retentionDeadline(time.Now().UTC(), retentionDays)
	if err := heartbeat.Stop(); err != nil {
		w.deleteUncommittedObject(objectKey)
		return err
	}
	if err := ctx.Err(); err != nil {
		w.deleteUncommittedObject(objectKey)
		return err
	}
	// Mark ready in its own short tx.
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		w.deleteUncommittedObject(objectKey)
		w.fail(ctx, jobID, leaseToken, "finalize", err)
		return fmt.Errorf("mark ready scope: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
	UPDATE tenant_exports
	   SET status = 'ready',
	       object_key = $1,
	       bytes_total = $2,
	       rows_total = $3,
	       bundle_sha256 = $4,
	       download_url = NULL,
	       expires_at = $5,
	       completed_at = clock_timestamp(),
	       error = NULL,
	       lease_token = NULL,
	       lease_expires_at = NULL,
	       heartbeat_at = NULL
	 WHERE id = $6::uuid
	   AND status = 'running'
	   AND lease_token = $7::uuid`,
		objectKey, bytesTotal, totalRows, bundleSHA256, expiresAt, jobID, leaseToken)
	if err != nil {
		_ = tx.Rollback(ctx)
		w.deleteUncommittedObject(objectKey)
		w.fail(ctx, jobID, leaseToken, "finalize", err)
		return fmt.Errorf("mark ready: %w", err)
	}
	if tag.RowsAffected() != 1 {
		_ = tx.Rollback(ctx)
		w.deleteUncommittedObject(objectKey)
		return errExportLeaseLost
	}
	if err := tx.Commit(ctx); err != nil {
		// A commit error is ambiguous: PostgreSQL may have committed before the
		// connection failed. Re-read before deleting, otherwise a transient ACK
		// loss could turn a valid ready row into a broken download.
		persisted, checkErr := w.readyPersisted(jobID, objectKey, bytesTotal, bundleSHA256)
		if checkErr == nil && persisted {
			return nil
		}
		if checkErr == nil {
			w.deleteUncommittedObject(objectKey)
			failCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			w.fail(failCtx, jobID, leaseToken, "finalize", err)
			cancel()
		} else if w.Logger != nil {
			w.Logger.Error("exports: ambiguous ready commit; retaining private object for reconciliation",
				"id", jobID, "object_key", objectKey, "commit_error", err, "check_error", checkErr)
		}
		return fmt.Errorf("mark ready commit: %w", err)
	}
	return nil
}

type maxBytesWriter struct {
	Writer  io.Writer
	Max     int64
	Written int64
}

func (w *maxBytesWriter) Write(p []byte) (int, error) {
	if w == nil || w.Writer == nil || w.Max <= 0 {
		return 0, errExportBundleTooLarge
	}
	if int64(len(p)) > w.Max-w.Written {
		return 0, errExportBundleTooLarge
	}
	n, err := w.Writer.Write(p)
	w.Written += int64(n)
	return n, err
}

// retentionDays reads through the same export_retention_policy row the admin
// route mutates. Worker scope is cross-tenant only for job discovery; policy
// access explicitly binds app.tenant_id so the table's FORCE RLS predicate
// remains effective.
func (w *Worker) retentionDays(ctx context.Context, tenantID string) (int, error) {
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return 0, fmt.Errorf("bind tenant: %w", err)
	}
	if err := ensureRetentionPolicyRow(ctx, tx, tenantID); err != nil {
		return 0, fmt.Errorf("initialize policy: %w", err)
	}
	var days int
	if err := tx.QueryRow(ctx, `
SELECT retention_days
  FROM export_retention_policy
 WHERE tenant_id = $1::uuid`, tenantID).Scan(&days); err != nil {
		return 0, fmt.Errorf("read policy: %w", err)
	}
	if days < MinRetentionDays || days > MaxRetentionDays {
		return 0, fmt.Errorf("retention_days %d is outside %d..%d", days, MinRetentionDays, MaxRetentionDays)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit policy read: %w", err)
	}
	return days, nil
}

func retentionDeadline(now time.Time, days int) time.Time {
	return now.UTC().AddDate(0, 0, days)
}

func (w *Worker) leaseDuration() time.Duration {
	if w != nil && w.LeaseDuration > 0 {
		return w.LeaseDuration
	}
	return defaultLeaseDuration
}

func (w *Worker) heartbeatEvery() time.Duration {
	lease := w.leaseDuration()
	interval := defaultHeartbeatEvery
	if w != nil && w.HeartbeatEvery > 0 {
		interval = w.HeartbeatEvery
	}
	if interval >= lease {
		interval = lease / 3
	}
	if interval <= 0 {
		interval = time.Second
	}
	return interval
}

func (w *Worker) legacyStaleAge() time.Duration {
	if w != nil && w.LegacyStaleAge > 0 {
		return w.LegacyStaleAge
	}
	return defaultLegacyStaleAge
}

func durationSeconds(value time.Duration) int64 {
	seconds := int64(value / time.Second)
	if seconds < 1 {
		return 1
	}
	return seconds
}

func exportObjectKey(tenantID, jobID, leaseToken string) string {
	return fmt.Sprintf("exports/%s/%s/%s.zip", tenantID, jobID, leaseToken)
}

func validResourceSelection(resources []string) bool {
	if len(resources) == 0 || len(resources) > len(SupportedResources) {
		return false
	}
	seen := make(map[string]struct{}, len(resources))
	for _, resource := range resources {
		if !isSupported(resource) {
			return false
		}
		if _, duplicate := seen[resource]; duplicate {
			return false
		}
		seen[resource] = struct{}{}
	}
	return true
}

type exportLeaseHeartbeat struct {
	stop     chan struct{}
	done     chan error
	cancel   context.CancelFunc
	stopOnce sync.Once
	stopErr  error
}

func (h *exportLeaseHeartbeat) Stop() error {
	if h == nil {
		return nil
	}
	h.stopOnce.Do(func() {
		close(h.stop)
		h.stopErr = <-h.done
		h.cancel()
	})
	return h.stopErr
}

func (w *Worker) startLeaseHeartbeat(
	parent context.Context,
	jobID, leaseToken string,
) (context.Context, *exportLeaseHeartbeat) {
	workCtx, cancel := context.WithCancel(parent)
	h := &exportLeaseHeartbeat{
		stop:   make(chan struct{}),
		done:   make(chan error, 1),
		cancel: cancel,
	}
	go func() {
		ticker := time.NewTicker(w.heartbeatEvery())
		defer ticker.Stop()
		for {
			select {
			case <-h.stop:
				h.done <- nil
				return
			case <-parent.Done():
				h.done <- parent.Err()
				cancel()
				return
			case <-ticker.C:
				if err := w.renewLease(workCtx, jobID, leaseToken); err != nil {
					h.done <- err
					cancel()
					return
				}
			}
		}
	}()
	return workCtx, h
}

func (w *Worker) renewLease(ctx context.Context, jobID, leaseToken string) error {
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return fmt.Errorf("renew export lease scope: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE tenant_exports
   SET lease_expires_at = clock_timestamp() + make_interval(secs => $1),
       heartbeat_at = clock_timestamp()
 WHERE id = $2::uuid
   AND status = 'running'
   AND lease_token = $3::uuid
   AND lease_expires_at > clock_timestamp()`,
		durationSeconds(w.leaseDuration()), jobID, leaseToken)
	if err != nil {
		return fmt.Errorf("renew export lease: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return errExportLeaseLost
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit export lease renewal: %w", err)
	}
	return nil
}

func exportFailureMessage(code string) string {
	switch code {
	case "invalid_selection":
		return "The saved export resource selection is invalid. Create a new export."
	case "temporary_file", "bundle_write":
		return "The private export bundle could not be prepared."
	case "bundle_too_large":
		return "The export exceeded the configured private bundle size limit."
	case "data_read":
		return "The selected workspace data could not be read for export."
	case "retention_policy":
		return "The workspace export-retention policy could not be verified."
	case "storage_write":
		return "The private export bundle could not be stored."
	case "finalize":
		return "The private export bundle could not be finalized."
	default:
		return "The private export could not be completed."
	}
}

func (w *Worker) failAttempt(
	ctx context.Context,
	heartbeat *exportLeaseHeartbeat,
	jobID, leaseToken, code string,
	cause error,
) error {
	if leaseErr := heartbeat.Stop(); leaseErr != nil {
		if cause == nil {
			return leaseErr
		}
		return errors.Join(cause, leaseErr)
	}
	if err := ctx.Err(); err != nil {
		if cause == nil {
			return err
		}
		return errors.Join(cause, err)
	}
	w.fail(ctx, jobID, leaseToken, code, cause)
	return cause
}

func (w *Worker) fail(ctx context.Context, jobID, leaseToken, code string, cause error) {
	if w != nil && w.Logger != nil {
		w.Logger.Error("exports: attempt failed", "id", jobID, "code", code, "err", cause)
	}
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE tenant_exports
	   SET status = 'failed',
	       error = $1,
	       completed_at = clock_timestamp(),
	       lease_token = NULL,
	       lease_expires_at = NULL,
	       heartbeat_at = NULL
	 WHERE id = $2::uuid
	   AND status = 'running'
	   AND lease_token = $3::uuid`,
		exportFailureMessage(code), jobID, leaseToken); err != nil {
		return
	}
	_ = tx.Commit(ctx)
}

func (w *Worker) deleteObject(ctx context.Context, objectKey string) error {
	if w == nil || w.Storage == nil || objectKey == "" {
		return errors.New("private export storage is unavailable")
	}
	return w.Storage.Delete(ctx, objectKey)
}

func (w *Worker) deleteUncommittedObject(objectKey string) {
	if w == nil || w.Storage == nil || objectKey == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := w.Storage.Delete(ctx, objectKey); err != nil && w.Logger != nil {
		w.Logger.Error("exports: failed to delete uncommitted private object",
			"object_key", objectKey, "err", err)
	}
}

func (w *Worker) readyPersisted(
	jobID, objectKey string,
	bytesTotal int64,
	bundleSHA256 string,
) (bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var (
		status     string
		storedKey  *string
		storedSHA  *string
		storedSize int64
	)
	if err := tx.QueryRow(ctx, `
SELECT status, object_key, bundle_sha256, COALESCE(bytes_total, 0)
  FROM tenant_exports
 WHERE id = $1::uuid`, jobID).Scan(&status, &storedKey, &storedSHA, &storedSize); err != nil {
		return false, err
	}
	return status == "ready" && storedKey != nil && *storedKey == objectKey &&
		storedSHA != nil && *storedSHA == bundleSHA256 && storedSize == bytesTotal, nil
}
