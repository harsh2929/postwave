// SPDX-License-Identifier: AGPL-3.0-only
//
// audit_paging.go — sse-pinned-tail feature (Audit UX, P1).
//
// Three new endpoints power the Cloudflare-style faceting + async
// export UX on the Audit page:
//
//   GET  /api/v1/audit/count          — total / EXPLAIN-bounded estimate
//   POST /api/v1/audit/export-async   — queue a background CSV job
//   GET  /api/v1/audit/export-jobs/{id} — poll job status / progress
//
// The synchronous /audit/export endpoint is untouched and remains the
// fast-path for filters that return <5k rows. Anything larger should
// flow through the async path — the frontend pre-fetches /audit/count
// and routes accordingly.

package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/mail"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	auditlog "github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// countEstimateThreshold — above this row count we trust the
// planner's EXPLAIN row estimate rather than running a full COUNT(*).
// Below the threshold a COUNT(*) is fast enough to be exact.
const countEstimateThreshold int64 = 50_000

// AuditCountResponse is the wire shape for GET /api/v1/audit/count.
//
// `Confidence` is either "exact" (we ran COUNT(*)) or "approximate"
// (we used the planner row estimate). The UI shows the leading "~" only
// when confidence is approximate so an operator-trusted "Showing 1-50
// of 2,400" doesn't accidentally read as a fuzzy estimate.
type AuditCountResponse struct {
	TotalEstimate int64  `json:"totalEstimate"`
	Confidence    string `json:"confidence"`
}

// Count GET /api/v1/audit/count — returns a row-count for the filter
// set without materializing rows. Used by the Audit page's
// "Showing 1-50 of ~2,400" pagination header.
//
// Strategy: ask the planner via EXPLAIN first. If the estimate is
// below countEstimateThreshold the count is cheap enough to do
// exactly — we re-run as a real COUNT(*) so the UI shows the precise
// number. Above the threshold we surface the planner estimate with
// confidence=approximate.
func (h *AuditHandlers) Count(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	q := r.URL.Query()
	actorType := q.Get("actor_type")
	actorLabel := q.Get("actor_label")
	action := strings.TrimSpace(q.Get("action"))
	resourceType := strings.TrimSpace(q.Get("resource_type"))
	resourceID := strings.TrimSpace(q.Get("resource_id"))
	var since *time.Time
	if raw := strings.TrimSpace(q.Get("since")); raw != "" {
		parsed, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			parsed, err = time.Parse(time.RFC3339Nano, raw)
		}
		if err != nil {
			httperror.Write(w, http.StatusBadRequest, "bad_since", "since must be an RFC3339 timestamp")
			return
		}
		since = &parsed
	}

	tx, err := db.WithTenant(r.Context(), h.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	args := []any{t.ID, actorType, actorLabel, action, resourceType, since, resourceID}

	// Planner estimate via EXPLAIN (FORMAT JSON). pgx returns the json
	// as bytes; we walk the first plan node for "Plan Rows".
	estimateBytes, err := tx.Query(r.Context(),
		`EXPLAIN (FORMAT JSON) SELECT 1 FROM audit_log`+auditAggregateWhere, args...,
	)
	var estimate int64 = -1
	if err == nil {
		for estimateBytes.Next() {
			var line string
			if err := estimateBytes.Scan(&line); err == nil {
				estimate = parsePlannerRows(line)
			}
		}
		estimateBytes.Close()
	}

	resp := AuditCountResponse{}
	if estimate >= 0 && estimate >= countEstimateThreshold {
		resp.TotalEstimate = estimate
		resp.Confidence = "approximate"
	} else {
		// Run an exact COUNT(*) — small enough to be cheap.
		var total int64
		if err := tx.QueryRow(r.Context(),
			`SELECT COUNT(*) FROM audit_log`+auditAggregateWhere, args...,
		).Scan(&total); err != nil {
			httperror.WriteInternal(w, h.Logger, err, r.Context())
			return
		}
		resp.TotalEstimate = total
		resp.Confidence = "exact"
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// parsePlannerRows extracts the top-level "Plan Rows" estimate from
// the EXPLAIN (FORMAT JSON) output. We don't pull a real JSON parser
// for this — the format is well-defined and a substring scan keeps
// the dependency surface flat.
func parsePlannerRows(explainLine string) int64 {
	const key = `"Plan Rows":`
	i := strings.Index(explainLine, key)
	if i < 0 {
		return -1
	}
	rest := explainLine[i+len(key):]
	// Skip whitespace.
	for len(rest) > 0 && (rest[0] == ' ' || rest[0] == '\t') {
		rest = rest[1:]
	}
	end := 0
	for end < len(rest) && rest[end] >= '0' && rest[end] <= '9' {
		end++
	}
	if end == 0 {
		return -1
	}
	n, err := strconv.ParseInt(rest[:end], 10, 64)
	if err != nil {
		return -1
	}
	return n
}

// ---------------------------------------------------------------------
// Async CSV export
// ---------------------------------------------------------------------

// AuditExportJob is the wire shape for the async export endpoints.
type AuditExportJob struct {
	ID              string     `json:"id"`
	Status          string     `json:"status"`
	EstimatedRows   *int64     `json:"estimatedRows,omitempty"`
	ExportedRows    int64      `json:"exportedRows"`
	TotalBytes      int64      `json:"totalBytes"`
	FileURL         *string    `json:"fileUrl,omitempty"`
	ErrorReason     *string    `json:"errorReason,omitempty"`
	EmailOnComplete bool       `json:"emailOnComplete"`
	EmailAddress    *string    `json:"emailAddress,omitempty"`
	CreatedAt       time.Time  `json:"createdAt"`
	StartedAt       *time.Time `json:"startedAt,omitempty"`
	CompletedAt     *time.Time `json:"completedAt,omitempty"`
	ETASeconds      *int64     `json:"etaSeconds,omitempty"`
}

type exportAsyncReq struct {
	ActorType       string `json:"actorType,omitempty"`
	ActorLabel      string `json:"actorLabel,omitempty"`
	Action          string `json:"action,omitempty"`
	ResourceType    string `json:"resourceType,omitempty"`
	ResourceID      string `json:"resourceId,omitempty"`
	Since           string `json:"since,omitempty"`
	EmailOnComplete bool   `json:"emailOnComplete,omitempty"`
	EmailAddress    string `json:"emailAddress,omitempty"`
}

// ExportAsync POST /api/v1/audit/export-async — enqueues a background
// CSV export job. Returns the job id + estimated row count so the UI
// can render a progress modal immediately.
//
// The actual file generation is handled by the audit-export worker
// (apps/api/internal/workers/export_async.go) which polls for pending
// jobs. The worker is best-effort — when no worker is running the row
// sits at status='pending' indefinitely and the UI shows a "queued"
// state with a manual retry button.
func (h *AuditHandlers) ExportAsync(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var in exportAsyncReq
	if r.ContentLength > 0 {
		if err := httpbody.DecodeJSON(w, r, 8<<10, &in); err != nil {
			httpbody.WriteError(w, err)
			return

		}
	}
	in.EmailAddress = strings.TrimSpace(in.EmailAddress)
	if in.EmailOnComplete {
		parsed, err := mail.ParseAddress(in.EmailAddress)
		if err != nil || parsed.Address != in.EmailAddress || len(in.EmailAddress) > 254 {
			httperror.WriteValidation(w, "invalid_email", "emailAddress must be a valid mailbox when emailOnComplete is true")
			return
		}
	} else {
		// Do not retain an address the caller explicitly said not to use.
		in.EmailAddress = ""
	}
	filters := map[string]any{
		"actor_type":    in.ActorType,
		"actor_label":   in.ActorLabel,
		"action":        in.Action,
		"resource_type": in.ResourceType,
		"resource_id":   in.ResourceID,
		"since":         in.Since,
	}
	filtersJSON, _ := json.Marshal(filters)

	// Pre-compute the EXPLAIN row estimate so the UI can render a
	// useful progress bar from the first frame.
	var since *time.Time
	if raw := strings.TrimSpace(in.Since); raw != "" {
		parsed, err := time.Parse(time.RFC3339, raw)
		if err == nil {
			since = &parsed
		}
	}
	estimate := h.estimateRowCount(r.Context(), t.ID,
		in.ActorType, in.ActorLabel, in.Action,
		in.ResourceType, in.ResourceID, since)

	var requestedBy *string
	var requestedByEmail *string
	if u, ok := middleware.UserFromContext(r.Context()); ok && u != nil {
		uid := u.ID
		em := u.Email
		requestedBy = &uid
		requestedByEmail = &em
	}

	tx, err := db.WithTenant(r.Context(), h.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	var jobID string
	var createdAt time.Time
	if err := tx.QueryRow(r.Context(), `
INSERT INTO audit_export_jobs (
  tenant_id, requested_by, requested_by_email, filters_json,
  estimated_rows, email_on_complete, email_address)
VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5, $6, NULLIF($7,''))
RETURNING id::text, created_at`,
		t.ID, requestedBy, requestedByEmail, filtersJSON,
		estimate, in.EmailOnComplete, in.EmailAddress,
	).Scan(&jobID, &createdAt); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	out := AuditExportJob{
		ID:              jobID,
		Status:          "pending",
		ExportedRows:    0,
		TotalBytes:      0,
		EmailOnComplete: in.EmailOnComplete,
		CreatedAt:       createdAt,
	}
	if estimate > 0 {
		out.EstimatedRows = &estimate
		// Rough ETA — ~5k rows/s sustained over the streaming writer.
		eta := estimate / 5000
		if eta < 1 {
			eta = 1
		}
		out.ETASeconds = &eta
	}
	if in.EmailAddress != "" {
		out.EmailAddress = &in.EmailAddress
	}
	auditlog.EmitOrLog(r.Context(), h.Pool, "audit.export_async.queue", "audit_export_job", jobID, nil,
		map[string]any{
			"actor_type":        in.ActorType,
			"action":            in.Action,
			"resource_type":     in.ResourceType,
			"has_since":         strings.TrimSpace(in.Since) != "",
			"estimated_rows":    estimate,
			"email_on_complete": in.EmailOnComplete,
			"email_address":     "withheld",
		}, nil)
	writeJSON(w, http.StatusAccepted, out)
}

// GetExportJob GET /api/v1/audit/export-jobs/{id} — poll status +
// progress for an async export job.
func (h *AuditHandlers) GetExportJob(w http.ResponseWriter, r *http.Request) {
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
		job         AuditExportJob
		estimated   *int64
		fileURL     *string
		errorReason *string
		emailAddr   *string
		startedAt   *time.Time
		completedAt *time.Time
	)
	if err := tx.QueryRow(r.Context(), `
SELECT id::text, status, estimated_rows, exported_rows, total_bytes,
       file_url, error_reason, email_on_complete, email_address,
       created_at, started_at, completed_at
  FROM audit_export_jobs
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		t.ID, id,
	).Scan(&job.ID, &job.Status, &estimated, &job.ExportedRows, &job.TotalBytes,
		&fileURL, &errorReason, &job.EmailOnComplete, &emailAddr,
		&job.CreatedAt, &startedAt, &completedAt); err != nil {
		httperror.Write(w, http.StatusNotFound, "not_found", "audit export job not found")
		return
	}
	job.EstimatedRows = estimated
	job.FileURL = fileURL
	job.ErrorReason = errorReason
	job.EmailAddress = emailAddr
	job.StartedAt = startedAt
	job.CompletedAt = completedAt
	// ETA: estimated_rows minus exported_rows at the observed rate.
	if job.Status == "in_progress" && startedAt != nil && estimated != nil && job.ExportedRows > 0 {
		elapsedSec := time.Since(*startedAt).Seconds()
		if elapsedSec > 0 {
			ratePerSec := float64(job.ExportedRows) / elapsedSec
			remaining := *estimated - job.ExportedRows
			if remaining > 0 && ratePerSec > 0 {
				eta := int64(float64(remaining) / ratePerSec)
				if eta < 1 {
					eta = 1
				}
				job.ETASeconds = &eta
			}
		}
	}
	writeJSON(w, http.StatusOK, job)
}

// ListExportJobs GET /api/v1/audit/export-jobs — most recent N jobs
// for the tenant, newest-first. Used by the "Export history" panel.
func (h *AuditHandlers) ListExportJobs(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	limit := 20
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}
	tx, err := db.WithTenant(r.Context(), h.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), `
SELECT id::text, status, estimated_rows, exported_rows, total_bytes,
       file_url, error_reason, email_on_complete, email_address,
       created_at, started_at, completed_at
  FROM audit_export_jobs
 WHERE tenant_id = $1::uuid
 ORDER BY created_at DESC
 LIMIT $2`, t.ID, limit)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	out := []AuditExportJob{}
	for rows.Next() {
		var (
			j           AuditExportJob
			estimated   *int64
			fileURL     *string
			errorReason *string
			emailAddr   *string
			startedAt   *time.Time
			completedAt *time.Time
		)
		if err := rows.Scan(&j.ID, &j.Status, &estimated, &j.ExportedRows, &j.TotalBytes,
			&fileURL, &errorReason, &j.EmailOnComplete, &emailAddr,
			&j.CreatedAt, &startedAt, &completedAt); err != nil {
			continue
		}
		j.EstimatedRows = estimated
		j.FileURL = fileURL
		j.ErrorReason = errorReason
		j.EmailAddress = emailAddr
		j.StartedAt = startedAt
		j.CompletedAt = completedAt
		out = append(out, j)
	}
	writeJSON(w, http.StatusOK, map[string]any{"jobs": out})
}

// estimateRowCount runs an EXPLAIN to get a planner row estimate.
// Returns 0 on any error — caller treats that as "unknown".
func (h *AuditHandlers) estimateRowCount(ctx context.Context, tenantID string,
	actorType, actorLabel, action, resourceType, resourceID string,
	since *time.Time,
) int64 {
	tx, err := db.WithTenant(ctx, h.Pool, tenantID)
	if err != nil {
		return 0
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
EXPLAIN (FORMAT JSON) SELECT 1 FROM audit_log
WHERE tenant_id = $1::uuid
  AND ($2 = '' OR actor_type  = $2)
  AND ($3 = '' OR actor_label = $3)
  AND ($4 = '' OR action ILIKE '%' || $4 || '%')
  AND ($5 = '' OR resource_type = $5)
  AND ($6::timestamptz IS NULL OR at >= $6::timestamptz)
  AND ($7 = '' OR resource_id ILIKE '%' || $7 || '%')`,
		tenantID, actorType, actorLabel, action, resourceType, since, resourceID)
	if err != nil {
		return 0
	}
	defer rows.Close()
	for rows.Next() {
		var line string
		if err := rows.Scan(&line); err == nil {
			if n := parsePlannerRows(line); n > 0 {
				return n
			}
		}
	}
	return 0
}
