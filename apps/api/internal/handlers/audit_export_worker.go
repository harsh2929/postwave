// SPDX-License-Identifier: AGPL-3.0-only
//
// audit_export_worker.go — sse-pinned-tail feature.
//
// Background worker that drains audit_export_jobs (pending →
// in_progress → completed | failed), streaming the matched audit_log
// rows into a CSV file on disk. The HTTP layer hands operators a
// fileUrl pointing back at /api/v1/audit/export-jobs/{id}/download
// once status='completed'.
//
// Design notes:
//   - Single-flight per tick (one worker per deployment) — exports
//     can be 100k-row scans and we'd rather not fan out parallel
//     workers all hitting the same tenant.
//   - Heartbeats progress every N rows so the UI's polling loop has
//     fresh exportedRows / totalBytes values to render.
//   - Output goes to TMPDIR by default; production deployments should
//     point AUDIT_EXPORT_DIR at a persistent volume.

package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// AuditExportWorker drains audit_export_jobs in the background.
//
// Construct with NewAuditExportWorker, then register Run() under a
// safego.Go in main.go.
type AuditExportWorker struct {
	Pool     *db.Pool
	Logger   *slog.Logger
	Interval time.Duration
	// OutputDir defaults to os.TempDir() when empty.
	OutputDir string
	// FlushEveryRows controls how often the worker updates
	// audit_export_jobs.exported_rows / total_bytes. Default 500.
	FlushEveryRows int
}

// NewAuditExportWorker constructs a worker with sensible defaults.
func NewAuditExportWorker(pool *db.Pool, logger *slog.Logger) *AuditExportWorker {
	dir := os.Getenv("POSTWAVE_AUDIT_EXPORT_DIR")
	if dir == "" {
		dir = os.TempDir()
	}
	return &AuditExportWorker{
		Pool:           pool,
		Logger:         logger,
		Interval:       10 * time.Second,
		OutputDir:      dir,
		FlushEveryRows: 500,
	}
}

// Run drives the worker until ctx is canceled. Returns ctx.Err() on
// graceful shutdown.
func (w *AuditExportWorker) Run(ctx context.Context) error {
	if w == nil || w.Pool == nil {
		return errors.New("audit-export worker: nil deps")
	}
	logger := w.Logger
	if logger == nil {
		logger = slog.Default()
	}
	interval := w.Interval
	if interval <= 0 {
		interval = 10 * time.Second
	}
	logger.Info("audit-export worker: starting", "interval", interval.String(), "output_dir", w.OutputDir)
	if err := os.MkdirAll(w.OutputDir, 0o755); err != nil {
		return fmt.Errorf("create export dir: %w", err)
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if err := w.tick(ctx); err != nil && !errors.Is(err, context.Canceled) {
			logger.Warn("audit-export tick failed", "err", err.Error())
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}

// tick claims one pending job and processes it to completion.
//
// The claim UPDATE runs under db.WithWorkerScope: audit_export_jobs is
// ENABLE+FORCE RLS and migration 0390 gates its cross-tenant claim path
// behind app.outbox_worker (worker_all + the widened tenant_isolation OR
// in both USING and WITH CHECK). Without that GUC the pending → in_progress
// UPDATE matches zero rows and the worker silently drains nothing.
func (w *AuditExportWorker) tick(ctx context.Context) error {
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Claim with SKIP LOCKED so concurrent workers don't grab the
	// same row. The UPDATE returns the claimed row in one round-trip.
	var (
		jobID, tenantID string
		filtersJSON     []byte
		email           *string
	)
	err = tx.QueryRow(ctx, `
UPDATE audit_export_jobs
   SET status = 'in_progress', started_at = now()
 WHERE id = (
    SELECT id FROM audit_export_jobs
     WHERE status = 'pending'
     ORDER BY created_at
     FOR UPDATE SKIP LOCKED
     LIMIT 1
 )
 RETURNING id::text, tenant_id::text, filters_json, email_address`,
	).Scan(&jobID, &tenantID, &filtersJSON, &email)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// No pending row (or every pending row is locked by a peer):
			// nothing to do this tick. Distinct from a real error so the
			// caller doesn't log a spurious warning every idle tick.
			return nil
		}
		return fmt.Errorf("claim job: %w", err)
	}
	// Commit the claim before the (potentially long) processJob so we
	// don't hold the worker-scope tx open across a 100k-row scan.
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit claim: %w", err)
	}

	flushEvery := w.FlushEveryRows
	if flushEvery <= 0 {
		flushEvery = 500
	}
	if err := w.processJob(ctx, jobID, tenantID, filtersJSON, email, flushEvery); err != nil {
		if mErr := w.markFailed(ctx, jobID, err.Error()); mErr != nil {
			w.log().Warn("audit-export: mark failed errored",
				"job_id", jobID, "err", mErr.Error())
		}
		return err
	}
	return nil
}

func (w *AuditExportWorker) log() *slog.Logger {
	if w.Logger != nil {
		return w.Logger
	}
	return slog.Default()
}

type exportFilters struct {
	ActorType    string `json:"actor_type"`
	ActorLabel   string `json:"actor_label"`
	Action       string `json:"action"`
	ResourceType string `json:"resource_type"`
	ResourceID   string `json:"resource_id"`
	Since        string `json:"since"`
}

func (w *AuditExportWorker) processJob(
	ctx context.Context,
	jobID, tenantID string,
	filtersBytes []byte,
	emailAddr *string,
	flushEvery int,
) error {
	var f exportFilters
	if len(filtersBytes) > 0 {
		_ = json.Unmarshal(filtersBytes, &f)
	}
	var since *time.Time
	if raw := strings.TrimSpace(f.Since); raw != "" {
		parsed, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			parsed, err = time.Parse(time.RFC3339Nano, raw)
			if err != nil {
				return fmt.Errorf("bad since: %w", err)
			}
		}
		since = &parsed
	}

	outPath := filepath.Join(w.OutputDir, fmt.Sprintf("audit-export-%s.csv", jobID))
	file, err := os.Create(outPath)
	if err != nil {
		return fmt.Errorf("create export file: %w", err)
	}
	defer func() { _ = file.Close() }()

	// Header row matches the synchronous /audit/export endpoint.
	header := "id,at,action,resource_type,resource_id,actor_type,actor_label,user_id,ip,user_agent,metadata_json\n"
	if _, err := file.WriteString(header); err != nil {
		return fmt.Errorf("write header: %w", err)
	}
	var totalBytes int64 = int64(len(header))

	tx, err := db.WithTenant(ctx, w.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id, action, COALESCE(resource_type,''), COALESCE(resource_id,''),
       actor_type, COALESCE(actor_label,''), COALESCE(user_id::text,''),
       COALESCE(host(ip),''), COALESCE(user_agent,''), metadata, at
  FROM audit_log
 WHERE tenant_id = $1::uuid
   AND ($2 = '' OR actor_type  = $2)
   AND ($3 = '' OR actor_label = $3)
   AND ($4 = '' OR action ILIKE '%' || $4 || '%')
   AND ($5 = '' OR resource_type = $5)
   AND ($6::timestamptz IS NULL OR at >= $6::timestamptz)
   AND ($7 = '' OR resource_id ILIKE '%' || $7 || '%')
 ORDER BY id DESC`,
		tenantID, f.ActorType, f.ActorLabel, f.Action, f.ResourceType, since, f.ResourceID)
	if err != nil {
		return fmt.Errorf("query: %w", err)
	}
	defer rows.Close()

	var exported int64
	buf := bytes.NewBuffer(make([]byte, 0, 1<<16))
	for rows.Next() {
		var (
			id                                                                   int64
			action, resType, resID, actorType, actorLabel, userID, ip, userAgent string
			metadata                                                             map[string]any
			at                                                                   time.Time
		)
		if err := rows.Scan(&id, &action, &resType, &resID, &actorType,
			&actorLabel, &userID, &ip, &userAgent, &metadata, &at); err != nil {
			return fmt.Errorf("scan: %w", err)
		}
		metaJSON, _ := json.Marshal(metadata)
		line := csvJoin(
			strconv.FormatInt(id, 10),
			at.UTC().Format(time.RFC3339Nano),
			action, resType, resID, actorType, actorLabel,
			userID, ip, userAgent, string(metaJSON),
		) + "\n"
		buf.WriteString(line)
		exported++
		// Flush every flushEvery rows to disk + heartbeat progress.
		if exported%int64(flushEvery) == 0 {
			n, _ := file.Write(buf.Bytes())
			totalBytes += int64(n)
			buf.Reset()
			if err := w.heartbeat(ctx, jobID, exported, totalBytes); err != nil {
				// Heartbeat is best-effort progress; a failure here must
				// not abort an otherwise-healthy export, but we log it so a
				// stuck-looking UI has a paper trail (previously swallowed).
				w.log().Warn("audit-export: heartbeat errored",
					"job_id", jobID, "err", err.Error())
			}
		}
	}
	if buf.Len() > 0 {
		n, _ := file.Write(buf.Bytes())
		totalBytes += int64(n)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("rows iter: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("sync: %w", err)
	}

	// File URL is the streaming download endpoint (not the raw path).
	fileURL := "/api/v1/audit/export-jobs/" + jobID + "/download"
	if err := w.markCompleted(ctx, jobID, exported, totalBytes, fileURL, emailAddr); err != nil {
		// The CSV is on disk and complete; failing to flip status to
		// 'completed' leaves the job stuck in_progress (operator-visible),
		// so surface it rather than reporting a clean success.
		return fmt.Errorf("mark completed: %w", err)
	}
	return nil
}

// heartbeat updates progress under worker scope (audit_export_jobs is
// FORCE RLS; migration 0390's worker_all policy gates this UPDATE behind
// app.outbox_worker). Returns the error rather than discarding it so the
// caller can log a stuck-looking export.
func (w *AuditExportWorker) heartbeat(ctx context.Context, jobID string, exported, totalBytes int64) error {
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`UPDATE audit_export_jobs SET exported_rows = $2, total_bytes = $3 WHERE id = $1::uuid`,
		jobID, exported, totalBytes); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (w *AuditExportWorker) markCompleted(
	ctx context.Context,
	jobID string, exported, totalBytes int64,
	fileURL string,
	emailAddr *string,
) error {
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE audit_export_jobs
   SET status = 'completed',
       exported_rows = $2,
       total_bytes = $3,
       file_url = $4,
       completed_at = now()
 WHERE id = $1::uuid`,
		jobID, exported, totalBytes, fileURL); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	// Email-on-complete: when configured, log a structured signal so
	// the transactional email pipeline can pick it up via a tail. We
	// deliberately don't take a hard dependency on a system_notifications
	// table — every audit-export consumer (UI polling, the eventual
	// email worker) reads from audit_export_jobs directly.
	if emailAddr != nil && *emailAddr != "" && w.Logger != nil {
		w.Logger.Info("audit-export: completed",
			"job_id", jobID,
			"email", *emailAddr,
			"rows", exported,
			"bytes", totalBytes,
			"file_url", fileURL,
		)
	}
	return nil
}

func (w *AuditExportWorker) markFailed(ctx context.Context, jobID, reason string) error {
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE audit_export_jobs
   SET status = 'failed', error_reason = $2, completed_at = now()
 WHERE id = $1::uuid`, jobID, reason); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// DownloadExportJob GET /api/v1/audit/export-jobs/{id}/download —
// streams the completed CSV file. 404 when status != 'completed' or
// the file has been garbage collected.
func (h *AuditHandlers) DownloadExportJob(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	if id == "" {
		writeJSONErr(w, http.StatusBadRequest, "missing_id", "")
		return
	}
	tx, err := db.WithTenant(r.Context(), h.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	var (
		status   string
		fileURL  *string
		rowCount int64
	)
	if err := tx.QueryRow(r.Context(), `
SELECT status, file_url, exported_rows
  FROM audit_export_jobs
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		t.ID, id,
	).Scan(&status, &fileURL, &rowCount); err != nil {
		// An export job that does not exist is a 404. pgx.ErrNoRows went
		// straight to WriteInternal, so asking for any absent job id -- the
		// obvious case after a job is purged, or when a stale link is
		// followed -- answered 500.
		if errors.Is(err, pgx.ErrNoRows) {
			writeJSONErr(w, http.StatusNotFound, "not_found", "export job not found")
			return
		}
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	if status != "completed" || fileURL == nil {
		writeJSONErr(w, http.StatusConflict, "not_ready", "job is "+status)
		return
	}

	// Look up the path. file_url stores the URL endpoint; the actual
	// file path is derived deterministically from the job id.
	outDir := os.Getenv("POSTWAVE_AUDIT_EXPORT_DIR")
	if outDir == "" {
		outDir = os.TempDir()
	}
	path := filepath.Join(outDir, fmt.Sprintf("audit-export-%s.csv", id))
	f, err := os.Open(path)
	if err != nil {
		writeJSONErr(w, http.StatusGone, "file_gone", "export file was garbage-collected")
		return
	}
	defer func() { _ = f.Close() }()
	stat, err := f.Stat()
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}

	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition",
		`attachment; filename="postwave-audit-async-`+id[:8]+`.csv"`)
	w.Header().Set("Content-Length", strconv.FormatInt(stat.Size(), 10))
	w.Header().Set("X-Postwave-Audit-Export-Rows", strconv.FormatInt(rowCount, 10))
	w.WriteHeader(http.StatusOK)
	buf := make([]byte, 32<<10)
	for {
		n, err := f.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
		}
		if err != nil {
			return
		}
	}
}
