// SPDX-License-Identifier: AGPL-3.0-only
//
// audit_export_schedules.go — scheduled evidence packs (migration
// 0390, feat/full-surface-wiring task 2).
//
// Compliance teams configure a weekly/monthly cadence + recipient
// list; the schedule worker enqueues a regular audit_export_jobs row
// when a schedule is due (so the evidence pack flows through the
// EXACT same async export pipeline operators use interactively via
// POST /audit/export-async) and, once the export worker completes the
// job, emails the download link to every recipient.
//
// Surface (mounted in main.go next to the other /audit/export-*
// routes):
//
//	GET    /api/v1/audit/export-schedules        — list   (audit:read)
//	POST   /api/v1/audit/export-schedules        — create (audit:configure_sinks)
//	DELETE /api/v1/audit/export-schedules/{id}   — delete (audit:configure_sinks)
//
// Worker (AuditExportScheduleWorker, started in main.go):
//
//	due-scan    — cross-tenant read under db.WithWorkerScope (the
//	              worker_select policy from 0390); each due schedule
//	              re-enters tenant scope to INSERT the export job +
//	              stamp last_enqueued_at atomically.
//	notify-scan — completed jobs with schedule_id set and
//	              notified_at IS NULL; emails the download link via
//	              the platform mailer (same MailSender narrowing
//	              pattern scheduled_reports uses), then stamps
//	              notified_at so a job is never announced twice.

package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	auditlog "github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// maxExportScheduleRecipients bounds the recipient fan-out per
// schedule so a typo'd request can't turn the notifier into a spam
// cannon.
const maxExportScheduleRecipients = 20

// AuditExportSchedule is the wire shape.
type AuditExportSchedule struct {
	ID             string         `json:"id"`
	Cadence        string         `json:"cadence"` // "weekly" | "monthly"
	Recipients     []string       `json:"recipients"`
	Filters        map[string]any `json:"filters,omitempty"`
	Enabled        bool           `json:"enabled"`
	CreatedByEmail string         `json:"created_by_email,omitempty"`
	LastEnqueuedAt *time.Time     `json:"last_enqueued_at,omitempty"`
	CreatedAt      time.Time      `json:"created_at"`
}

type exportScheduleCreateReq struct {
	Cadence    string         `json:"cadence"`
	Recipients []string       `json:"recipients"`
	Filters    map[string]any `json:"filters,omitempty"`
}

// validateExportScheduleInput normalises + validates the POST body.
// Exported-shape errors are operator-safe strings.
func validateExportScheduleInput(cadence string, recipients []string) (string, []string, error) {
	cadence = strings.ToLower(strings.TrimSpace(cadence))
	if cadence != "weekly" && cadence != "monthly" {
		return "", nil, errors.New("cadence must be weekly|monthly")
	}
	clean := make([]string, 0, len(recipients))
	seen := map[string]bool{}
	for _, r := range recipients {
		r = strings.TrimSpace(r)
		if r == "" || seen[strings.ToLower(r)] {
			continue
		}
		if _, err := mail.ParseAddress(r); err != nil {
			return "", nil, fmt.Errorf("invalid recipient %q", r)
		}
		seen[strings.ToLower(r)] = true
		clean = append(clean, r)
	}
	if len(clean) == 0 {
		return "", nil, errors.New("at least one recipient email is required")
	}
	if len(clean) > maxExportScheduleRecipients {
		return "", nil, fmt.Errorf("at most %d recipients per schedule", maxExportScheduleRecipients)
	}
	return cadence, clean, nil
}

// CreateExportSchedule POST /api/v1/audit/export-schedules.
func (h *AuditHandlers) CreateExportSchedule(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var in exportScheduleCreateReq
	if err := httpbody.DecodeJSON(w, r, 16<<10, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	cadence, recipients, err := validateExportScheduleInput(in.Cadence, in.Recipients)
	if err != nil {
		httperror.WriteValidation(w, "invalid_schedule", err.Error())
		return
	}
	if in.Filters == nil {
		in.Filters = map[string]any{}
	}
	filtersJSON, _ := json.Marshal(in.Filters)

	var createdBy any
	var createdByEmail any
	if u, ok := middleware.UserFromContext(r.Context()); ok && u != nil {
		if u.ID != "" {
			createdBy = u.ID
		}
		if u.Email != "" {
			createdByEmail = u.Email
		}
	}

	tx, err := db.WithTenant(r.Context(), h.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	out := AuditExportSchedule{
		Cadence:    cadence,
		Recipients: recipients,
		Filters:    in.Filters,
		Enabled:    true,
	}
	var cbe *string
	err = tx.QueryRow(r.Context(), `
INSERT INTO audit_export_schedules
  (tenant_id, cadence, recipients, filters_json, created_by, created_by_email)
VALUES ($1::uuid, $2, $3::text[], $4::jsonb, $5::uuid, $6)
RETURNING id::text, created_by_email, created_at`,
		t.ID, cadence, recipients, string(filtersJSON), createdBy, createdByEmail,
	).Scan(&out.ID, &cbe, &out.CreatedAt)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	if cbe != nil {
		out.CreatedByEmail = *cbe
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	auditlog.EmitOrLog(r.Context(), h.Pool, "audit.export_schedule.create", "audit_export_schedule", out.ID, nil,
		map[string]any{
			"cadence":         out.Cadence,
			"recipient_count": len(out.Recipients),
			"filters_present": len(out.Filters) > 0,
			"recipients":      "withheld",
		}, nil)
	writeJSON(w, http.StatusCreated, out)
}

// ListExportSchedules GET /api/v1/audit/export-schedules.
func (h *AuditHandlers) ListExportSchedules(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	tx, err := db.WithTenant(r.Context(), h.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), `
SELECT id::text, cadence, recipients, filters_json,
       enabled, COALESCE(created_by_email, ''), last_enqueued_at, created_at
  FROM audit_export_schedules
 WHERE tenant_id = $1::uuid
 ORDER BY created_at DESC
 LIMIT 100`, t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	out := []AuditExportSchedule{}
	for rows.Next() {
		var s AuditExportSchedule
		var filters []byte
		if err := rows.Scan(&s.ID, &s.Cadence, &s.Recipients, &filters,
			&s.Enabled, &s.CreatedByEmail, &s.LastEnqueuedAt, &s.CreatedAt); err != nil {
			httperror.WriteInternal(w, h.Logger, err, r.Context())
			return
		}
		_ = json.Unmarshal(filters, &s.Filters)
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"schedules": out})
}

// DeleteExportSchedule DELETE /api/v1/audit/export-schedules/{id}.
func (h *AuditHandlers) DeleteExportSchedule(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
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
	tag, err := tx.Exec(r.Context(), `
DELETE FROM audit_export_schedules WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		t.ID, id)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	if tag.RowsAffected() == 0 {
		writeJSONErr(w, http.StatusNotFound, "not_found", "no such schedule")
		return
	}
	auditlog.EmitOrLog(r.Context(), h.Pool, "audit.export_schedule.delete", "audit_export_schedule", id,
		map[string]any{"id": id}, nil, nil)
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

// ----------------------------------------------------------------------
// Worker
// ----------------------------------------------------------------------

// ScheduleMailSender is the narrow surface the schedule worker needs
// to announce a completed evidence pack. main.go wires the same
// mailer adapter scheduled_reports uses.
type ScheduleMailSender interface {
	Send(ctx context.Context, to, subject, body string) error
}

// AuditExportScheduleWorker enqueues due evidence-pack exports +
// emails completed ones. Register Run() under safego.Go in main.go.
type AuditExportScheduleWorker struct {
	Pool   *db.Pool
	Logger *slog.Logger
	Mailer ScheduleMailSender
	// Interval defaults to 5 minutes.
	Interval time.Duration
	// PublicBaseURL prefixes the relative download path in the email
	// ("https://api.example.com"). Empty ⇒ the relative path is sent.
	PublicBaseURL string
}

// Run drives the worker until ctx is canceled.
func (w *AuditExportScheduleWorker) Run(ctx context.Context) error {
	if w == nil || w.Pool == nil {
		return errors.New("audit-export-schedule worker: nil deps")
	}
	interval := w.Interval
	if interval <= 0 {
		interval = 5 * time.Minute
	}
	if w.Logger != nil {
		w.Logger.Info("audit-export-schedule worker: starting", "interval", interval.String())
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if err := w.tick(ctx); err != nil && !errors.Is(err, context.Canceled) && w.Logger != nil {
			w.Logger.Warn("audit-export-schedule tick failed", "err", err.Error())
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}

func (w *AuditExportScheduleWorker) tick(ctx context.Context) error {
	if err := w.enqueueDue(ctx); err != nil {
		return err
	}
	return w.notifyCompleted(ctx)
}

// scheduleDue reports whether a schedule with the given cadence +
// last-enqueue time is due at `now`. Pure — unit-tested directly.
// Weekly = every 7 days; monthly = every calendar month (anchored on
// the last enqueue instant). Never-enqueued schedules are always due.
func scheduleDue(cadence string, lastEnqueuedAt *time.Time, now time.Time) bool {
	if lastEnqueuedAt == nil || lastEnqueuedAt.IsZero() {
		return true
	}
	switch cadence {
	case "weekly":
		return !now.Before(lastEnqueuedAt.Add(7 * 24 * time.Hour))
	case "monthly":
		return !now.Before(lastEnqueuedAt.AddDate(0, 1, 0))
	}
	return false
}

type dueExportSchedule struct {
	id, tenantID, cadence string
	recipients            []string
	filtersJSON           []byte
	createdByEmail        string
	lastEnqueuedAt        *time.Time
}

// enqueueDue scans enabled schedules cross-tenant (worker scope, 0390
// worker_select policy) and enqueues one audit_export_jobs row per
// due schedule under that schedule's tenant scope.
func (w *AuditExportScheduleWorker) enqueueDue(ctx context.Context) error {
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, cadence, recipients, filters_json,
       COALESCE(created_by_email, ''), last_enqueued_at
  FROM audit_export_schedules
 WHERE enabled
 ORDER BY last_enqueued_at ASC NULLS FIRST
 LIMIT 50`)
	if err != nil {
		return fmt.Errorf("due-scan: %w", err)
	}
	due := []dueExportSchedule{}
	now := time.Now().UTC()
	for rows.Next() {
		var s dueExportSchedule
		if err := rows.Scan(&s.id, &s.tenantID, &s.cadence, &s.recipients,
			&s.filtersJSON, &s.createdByEmail, &s.lastEnqueuedAt); err != nil {
			rows.Close()
			return err
		}
		if scheduleDue(s.cadence, s.lastEnqueuedAt, now) {
			due = append(due, s)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	_ = tx.Rollback(ctx) // read-only scan

	for _, s := range due {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err := w.enqueueOne(ctx, s); err != nil && w.Logger != nil {
			w.Logger.Warn("audit-export-schedule: enqueue failed",
				"schedule_id", s.id, "err", err.Error())
		}
	}
	return nil
}

// enqueueOne inserts the export job + stamps last_enqueued_at in ONE
// tenant-scoped tx so a crash between the two can't double-enqueue.
// The job carries schedule_id for provenance; email_on_complete stays
// false because the schedule worker (not the export worker) owns the
// recipient fan-out.
func (w *AuditExportScheduleWorker) enqueueOne(ctx context.Context, s dueExportSchedule) error {
	tx, err := db.WithTenant(ctx, w.Pool, s.tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Re-check due-ness with the row locked so two replicas can't
	// both enqueue inside the same tick window.
	var lastEnqueuedAt *time.Time
	if err := tx.QueryRow(ctx, `
SELECT last_enqueued_at FROM audit_export_schedules
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND enabled
 FOR UPDATE`, s.tenantID, s.id).Scan(&lastEnqueuedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil // deleted/disabled between scan and claim
		}
		return err
	}
	if !scheduleDue(s.cadence, lastEnqueuedAt, time.Now().UTC()) {
		return nil
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO audit_export_jobs
  (tenant_id, requested_by_email, filters_json, schedule_id)
VALUES ($1::uuid, NULLIF($2,''), $3::jsonb, $4::uuid)`,
		s.tenantID, s.createdByEmail, string(s.filtersJSON), s.id); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
UPDATE audit_export_schedules SET last_enqueued_at = now(), updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, s.tenantID, s.id); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if w.Logger != nil {
		w.Logger.Info("audit-export-schedule: job enqueued",
			"schedule_id", s.id, "cadence", s.cadence)
	}
	return nil
}

// notifyCompleted emails the download link for completed scheduled
// jobs that haven't been announced yet, then stamps notified_at.
func (w *AuditExportScheduleWorker) notifyCompleted(ctx context.Context) error {
	if w.Mailer == nil {
		return nil // no mailer wired — jobs stay un-notified, UI still works
	}
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT j.id::text, j.tenant_id::text, COALESCE(j.file_url, ''),
       COALESCE(j.exported_rows, 0), s.cadence, s.recipients
  FROM audit_export_jobs j
  JOIN audit_export_schedules s ON s.id = j.schedule_id
 WHERE j.schedule_id IS NOT NULL
   AND j.status = 'completed'
   AND j.notified_at IS NULL
 ORDER BY j.completed_at ASC
 LIMIT 20`)
	if err != nil {
		return fmt.Errorf("notify-scan: %w", err)
	}
	type doneJob struct {
		jobID, tenantID, fileURL, cadence string
		rowsExported                      int64
		recipients                        []string
	}
	jobs := []doneJob{}
	for rows.Next() {
		var j doneJob
		if err := rows.Scan(&j.jobID, &j.tenantID, &j.fileURL,
			&j.rowsExported, &j.cadence, &j.recipients); err != nil {
			rows.Close()
			return err
		}
		jobs = append(jobs, j)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	_ = tx.Rollback(ctx) // read-only scan

	for _, j := range jobs {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		link := j.fileURL
		if w.PublicBaseURL != "" && strings.HasPrefix(link, "/") {
			link = strings.TrimRight(w.PublicBaseURL, "/") + link
		}
		subject := fmt.Sprintf("[Moosewave] Your %s audit evidence pack is ready", j.cadence)
		body := fmt.Sprintf(
			"Your scheduled audit-trail export has completed.\n\n"+
				"Rows exported: %d\nDownload (sign-in required): %s\n\n"+
				"This link streams the CSV from the Moosewave audit export pipeline. "+
				"Files are garbage-collected after the retention window, so download promptly.\n",
			j.rowsExported, link)
		var firstErr error
		for _, to := range j.recipients {
			if err := w.Mailer.Send(ctx, to, subject, body); err != nil && firstErr == nil {
				firstErr = err
			}
		}
		if firstErr != nil {
			if w.Logger != nil {
				w.Logger.Warn("audit-export-schedule: notify failed",
					"job_id", j.jobID, "err", firstErr.Error())
			}
			continue // leave notified_at NULL → retried next tick
		}
		if err := w.markNotified(ctx, j.tenantID, j.jobID); err != nil && w.Logger != nil {
			w.Logger.Warn("audit-export-schedule: mark notified failed",
				"job_id", j.jobID, "err", err.Error())
		}
	}
	return nil
}

func (w *AuditExportScheduleWorker) markNotified(ctx context.Context, tenantID, jobID string) error {
	tx, err := db.WithTenant(ctx, w.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE audit_export_jobs SET notified_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, jobID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
