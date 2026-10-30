// SPDX-License-Identifier: AGPL-3.0-only
//
// Package scheduled_reports implements operator-defined recurring
// digest emails.
//
// Endpoints (admin):
//
//   GET    /api/v1/scheduled-reports                 list
//   POST   /api/v1/scheduled-reports                 create
//   PATCH  /api/v1/scheduled-reports/{id}            update
//   DELETE /api/v1/scheduled-reports/{id}            delete
//   POST   /api/v1/scheduled-reports/{id}/send-now   fire one off
//                                                       (useful to
//                                                       verify the
//                                                       schedule + the
//                                                       email body
//                                                       look right).
//
// Schedule grammar (parsed by parseSchedule):
//   weekly:<dow>@HH:MM   dow ∈ {mon,tue,wed,thu,fri,sat,sun}
//   monthly:<dom>@HH:MM  dom ∈ 1..28 (capped at 28 to dodge
//                                       Feb-29 edge cases)
//
// The worker (worker.go) walks rows where enabled=true AND the internal
// durable cursor is due, materializes an occurrence, then advances that
// cursor. The public wire field remains next_due_at.

package scheduled_reports

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Report is the wire shape.
type Report struct {
	ID                  string     `json:"id"`
	Name                string     `json:"name"`
	Enabled             bool       `json:"enabled"`
	Template            string     `json:"template"`
	Schedule            string     `json:"schedule"`
	Timezone            string     `json:"timezone"`
	Recipients          []string   `json:"recipients"`
	LastRunAt           *time.Time `json:"last_run_at,omitempty"`
	LastRunError        string     `json:"last_run_error,omitempty"`
	LatestRunID         *string    `json:"latest_run_id,omitempty"`
	LatestRunStatus     *string    `json:"latest_run_status,omitempty"`
	LatestRunCreatedAt  *time.Time `json:"latest_run_created_at,omitempty"`
	LatestRunAccepted   int        `json:"latest_run_accepted_count"`
	LatestRunFailed     int        `json:"latest_run_failed_count"`
	LatestRunUnknown    int        `json:"latest_run_unknown_count"`
	LatestRunRecipients int        `json:"latest_run_recipient_count"`
	NextDueAt           *time.Time `json:"next_due_at,omitempty"`
	CreatedAt           time.Time  `json:"created_at"`
}

// CreateInput is the POST body.
type CreateInput struct {
	Name       string   `json:"name"`
	Template   string   `json:"template"`
	Schedule   string   `json:"schedule"`
	Timezone   string   `json:"timezone,omitempty"`
	Recipients []string `json:"recipients"`
}

// Deps wires the handlers + worker.
type Deps struct {
	Pool *db.Pool
	// Logger is optional — when nil httperror.WriteInternal still emits
	// the user-facing 500 envelope but suppresses the structured log line.
	Logger *slog.Logger

	// sendNowStore is injectable for wire-contract tests. Production lazily
	// binds the PostgreSQL Store to Pool.
	sendNowStore manualRunQueuer
}

func (d *Deps) manualRuns() manualRunQueuer {
	if d.sendNowStore != nil {
		return d.sendNowStore
	}
	return &Store{Pool: d.Pool}
}

// MountRoutes registers the CRUD + send-now endpoints.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	r.With(admin).Get("/api/v1/scheduled-reports", d.List)
	r.With(admin).Post("/api/v1/scheduled-reports", d.Create)
	r.With(admin).Patch("/api/v1/scheduled-reports/{id}", d.Patch)
	r.With(admin).Delete("/api/v1/scheduled-reports/{id}", d.Delete)
	r.With(admin).Post("/api/v1/scheduled-reports/{id}/send-now", d.SendNow)
}

// Create POST /api/v1/scheduled-reports.
func (d *Deps) Create(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var in CreateInput
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	name, err := normalizeReportName(in.Name)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_name",
			"name must be 1–160 bytes and contain no control characters")
		return
	}
	in.Name = name
	recipients, err := normalizeRecipients(in.Recipients)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_recipients",
			"provide 1–20 valid recipient mailbox addresses")
		return
	}
	in.Recipients = recipients
	if in.Template == "" {
		in.Template = "engagement_summary"
	}
	switch in.Template {
	case "engagement_summary", "deliverability", "growth":
	default:
		writeErr(w, http.StatusBadRequest, "invalid_template",
			"template must be one of engagement_summary|deliverability|growth")
		return
	}
	in.Schedule = strings.TrimSpace(in.Schedule)
	if len(in.Schedule) == 0 || len(in.Schedule) > maxScheduleBytes {
		httperror.WriteValidation(w, "validation_failed", "schedule must be 1–80 bytes")
		return
	}
	timezone, _, err := normalizeTimezone(in.Timezone)
	if err != nil {
		httperror.WriteValidation(w, "validation_failed",
			"timezone must be UTC or a valid IANA timezone such as America/New_York")
		return
	}
	in.Timezone = timezone
	nextDue, err := computeNextDue(in.Schedule, in.Timezone, nowUTC())
	if err != nil {
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var id string
	err = tx.QueryRow(r.Context(), `
INSERT INTO scheduled_reports
  (tenant_id, name, template, schedule, timezone, recipients, delivery_next_due_at)
VALUES ($1::uuid, $2, $3, $4, $5, $6::text[], $7)
RETURNING id::text`,
		t.ID, in.Name, in.Template, in.Schedule, in.Timezone, in.Recipients, nextDue).Scan(&id)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"id":          id,
		"next_due_at": nextDue,
		"timezone":    in.Timezone,
	})
}

// List GET /api/v1/scheduled-reports.
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	// The response contains operator-entered recipient addresses.
	w.Header().Set("Cache-Control", "private, no-store")
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), `
SELECT reports.id::text, name, enabled, template, schedule, timezone, recipients,
       CASE
           WHEN latest.id IS NULL THEN reports.last_run_at
           ELSE latest.completed_at
       END,
       CASE
           WHEN latest.id IS NULL THEN COALESCE(reports.last_run_error, '')
           ELSE COALESCE(latest.last_error_summary, '')
       END,
       latest.id::text, latest.status,
       latest.created_at,
       COALESCE(latest.accepted_count, 0),
       COALESCE(latest.failed_count, 0),
       COALESCE(latest.unknown_count, 0),
       COALESCE(latest.recipient_count, 0),
       reports.delivery_next_due_at, reports.created_at
  FROM scheduled_reports AS reports
  LEFT JOIN LATERAL (
      SELECT
          runs.id,
          runs.status,
          runs.created_at,
          runs.completed_at,
          runs.last_error_summary,
          COUNT(receipts.id) FILTER (WHERE receipts.state = 'accepted')::integer
              AS accepted_count,
          COUNT(receipts.id) FILTER (
              WHERE receipts.state IN ('failed', 'skipped')
          )::integer
              AS failed_count,
          COUNT(receipts.id) FILTER (WHERE receipts.state = 'unknown')::integer
              AS unknown_count,
          COUNT(receipts.id)::integer AS recipient_count
        FROM scheduled_report_runs AS runs
        LEFT JOIN scheduled_report_delivery_receipts AS receipts
          ON receipts.tenant_id = runs.tenant_id
         AND receipts.run_id = runs.id
       WHERE runs.tenant_id = reports.tenant_id
         AND runs.scheduled_report_id = reports.id
       GROUP BY
           runs.id,
           runs.status,
           runs.created_at,
           runs.completed_at,
           runs.last_error_summary
       ORDER BY runs.created_at DESC, runs.id DESC
       LIMIT 1
  ) AS latest ON true
 WHERE reports.tenant_id = $1::uuid
 ORDER BY reports.created_at DESC`, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer rows.Close()
	out := []Report{}
	for rows.Next() {
		var (
			rp                   Report
			lastRunAt, nextDueAt *time.Time
		)
		if err := rows.Scan(
			&rp.ID,
			&rp.Name,
			&rp.Enabled,
			&rp.Template,
			&rp.Schedule,
			&rp.Timezone,
			&rp.Recipients,
			&lastRunAt,
			&rp.LastRunError,
			&rp.LatestRunID,
			&rp.LatestRunStatus,
			&rp.LatestRunCreatedAt,
			&rp.LatestRunAccepted,
			&rp.LatestRunFailed,
			&rp.LatestRunUnknown,
			&rp.LatestRunRecipients,
			&nextDueAt,
			&rp.CreatedAt,
		); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
			return
		}
		rp.LastRunAt = lastRunAt
		rp.NextDueAt = nextDueAt
		out = append(out, rp)
	}
	if err := rows.Err(); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"reports": out})
}

// Patch PATCH /api/v1/scheduled-reports/{id}.
func (d *Deps) Patch(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id, ok := canonicalReportID(chi.URLParam(r, "id"))
	if !ok {
		writeErr(w, http.StatusNotFound, "not_found", "")
		return
	}
	var in struct {
		Enabled    *bool     `json:"enabled,omitempty"`
		Schedule   *string   `json:"schedule,omitempty"`
		Timezone   *string   `json:"timezone,omitempty"`
		Recipients *[]string `json:"recipients,omitempty"`
		Name       *string   `json:"name,omitempty"`
	}
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if in.Enabled == nil && in.Schedule == nil && in.Timezone == nil &&
		in.Recipients == nil && in.Name == nil {
		writeErr(w, http.StatusBadRequest, "empty_patch", "at least one field is required")
		return
	}
	var nextDue *time.Time
	if in.Schedule != nil {
		schedule := strings.TrimSpace(*in.Schedule)
		if len(schedule) == 0 || len(schedule) > maxScheduleBytes {
			httperror.WriteValidation(w, "validation_failed", "schedule must be 1–80 bytes")
			return
		}
		in.Schedule = &schedule
	}
	if in.Timezone != nil {
		timezone, _, err := normalizeTimezone(*in.Timezone)
		if err != nil {
			httperror.WriteValidation(w, "validation_failed",
				"timezone must be UTC or a valid IANA timezone such as America/New_York")
			return
		}
		in.Timezone = &timezone
	}
	if in.Recipients != nil {
		recipients, err := normalizeRecipients(*in.Recipients)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "invalid_recipients",
				"provide 1–20 valid recipient mailbox addresses")
			return
		}
		in.Recipients = &recipients
	}
	if in.Name != nil {
		name, err := normalizeReportName(*in.Name)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "invalid_name",
				"name must be 1–160 bytes and contain no control characters")
			return
		}
		in.Name = &name
	}

	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var existingSchedule, existingTimezone string
	if err := tx.QueryRow(r.Context(), `
SELECT schedule, timezone
  FROM scheduled_reports
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
 FOR UPDATE`, t.ID, id).Scan(
		&existingSchedule,
		&existingTimezone,
	); errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not_found", "")
		return
	} else if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	effectiveSchedule := existingSchedule
	if in.Schedule != nil {
		effectiveSchedule = *in.Schedule
	}
	effectiveTimezone := existingTimezone
	if in.Timezone != nil {
		effectiveTimezone = *in.Timezone
	}
	if in.Schedule != nil || in.Timezone != nil ||
		(in.Enabled != nil && *in.Enabled) {
		computed, err := computeNextDue(effectiveSchedule, effectiveTimezone, nowUTC())
		if err != nil {
			writeErr(w, http.StatusConflict, "report_configuration_invalid",
				"the stored schedule and timezone must be corrected before enabling")
			return
		}
		nextDue = &computed
	}
	if in.Enabled != nil {
		if _, err := tx.Exec(r.Context(),
			`UPDATE scheduled_reports
			    SET enabled = $1,
			        delivery_next_due_at =
			            COALESCE($2, delivery_next_due_at),
			        updated_at = now()
			   WHERE tenant_id = $3::uuid AND id = $4::uuid`,
			*in.Enabled, nextDue, t.ID, id); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
			return
		}
	}
	if in.Schedule != nil {
		if _, err := tx.Exec(r.Context(),
			`UPDATE scheduled_reports
			    SET schedule = $1,
			        delivery_next_due_at = $2,
			        updated_at = now()
			  WHERE tenant_id = $3::uuid AND id = $4::uuid`,
			*in.Schedule, *nextDue, t.ID, id); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
			return
		}
	}
	if in.Timezone != nil {
		if _, err := tx.Exec(r.Context(),
			`UPDATE scheduled_reports
			    SET timezone = $1,
			        delivery_next_due_at = $2,
			        updated_at = now()
			  WHERE tenant_id = $3::uuid AND id = $4::uuid`,
			*in.Timezone, *nextDue, t.ID, id); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
			return
		}
	}
	if in.Recipients != nil {
		if _, err := tx.Exec(r.Context(),
			`UPDATE scheduled_reports
			    SET recipients = $1::text[], updated_at = now()
			  WHERE tenant_id = $2::uuid AND id = $3::uuid`,
			*in.Recipients, t.ID, id); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
			return
		}
	}
	if in.Name != nil {
		if _, err := tx.Exec(r.Context(),
			`UPDATE scheduled_reports SET name = $1, updated_at = now()
			   WHERE tenant_id = $2::uuid AND id = $3::uuid`,
			*in.Name, t.ID, id); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"updated": true})
}

// Delete DELETE /api/v1/scheduled-reports/{id}.
func (d *Deps) Delete(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id, ok := canonicalReportID(chi.URLParam(r, "id"))
	if !ok {
		writeErr(w, http.StatusNotFound, "not_found", "")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	tag, err := tx.Exec(r.Context(),
		`DELETE FROM scheduled_reports
		   WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		t.ID, id)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, "not_found", "")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

// SendNow POST /api/v1/scheduled-reports/{id}/send-now — fire one
// run immediately. Useful for "let me see the email body before I
// turn the schedule on."
func (d *Deps) SendNow(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id, ok := canonicalReportID(chi.URLParam(r, "id"))
	if !ok {
		writeErr(w, http.StatusNotFound, "not_found", "")
		return
	}
	key, err := requiredIdempotencyKey(r.Header)
	switch {
	case errors.Is(err, ErrIdempotencyKeyRequired):
		writeErr(w, http.StatusBadRequest, "idempotency_key_required",
			"Send-now requires exactly one Idempotency-Key header.")
		return
	case errors.Is(err, ErrIdempotencyKeyInvalid):
		writeErr(w, http.StatusBadRequest, "invalid_idempotency_key",
			"Idempotency-Key must be valid UTF-8, contain no control characters, and be at most 255 bytes.")
		return
	}
	result, err := d.manualRuns().QueueManualRun(r.Context(), t.ID, id, key)
	switch {
	case errors.Is(err, ErrReportNotFound):
		writeErr(w, http.StatusNotFound, "not_found", "")
		return
	case errors.Is(err, ErrReportConfigInvalid):
		writeErr(w, http.StatusConflict, "report_configuration_invalid",
			"Correct the report name, schedule, template, or recipients before sending.")
		return
	case err != nil:
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusAccepted, struct {
		Queued bool `json:"queued"`
		SendNowResult
	}{
		Queued:        true,
		SendNowResult: result,
	})
}

// --- schedule parsing + next-due computation ---

// computeNextDue parses "weekly:mon@09:00" or "monthly:1@09:00" and
// returns the next future instant matching that wall-clock schedule in a
// validated IANA timezone. Results are normalized to UTC for persistence.
//
// DST policy is explicit:
//   - an ambiguous fall-back time uses its first occurrence;
//   - a nonexistent spring-forward time advances to the first valid wall
//     minute after the gap.
func computeNextDue(schedule, timezone string, from time.Time) (time.Time, error) {
	_, location, err := normalizeTimezone(timezone)
	if err != nil {
		return time.Time{}, err
	}
	kind, rest, ok := strings.Cut(schedule, ":")
	if !ok {
		return time.Time{}, fmt.Errorf("invalid schedule format")
	}
	dowOrDom, timeStr, ok := strings.Cut(rest, "@")
	if !ok {
		return time.Time{}, fmt.Errorf("invalid schedule format")
	}
	hh, mm, err := parseHHMM(timeStr)
	if err != nil {
		return time.Time{}, err
	}
	switch strings.ToLower(kind) {
	case "weekly":
		dow, err := parseDOW(dowOrDom)
		if err != nil {
			return time.Time{}, err
		}
		return nextWeekly(from, location, dow, hh, mm), nil
	case "monthly":
		dom, err := strconv.Atoi(dowOrDom)
		if err != nil || dom < 1 || dom > 28 {
			return time.Time{}, fmt.Errorf("monthly dom must be 1..28")
		}
		return nextMonthly(from, location, dom, hh, mm), nil
	}
	return time.Time{}, fmt.Errorf("unsupported schedule kind: %s", kind)
}

func normalizeTimezone(value string) (string, *time.Location, error) {
	if strings.IndexFunc(value, func(r rune) bool {
		return r < 0x20 || r == 0x7f
	}) >= 0 {
		return "", nil, fmt.Errorf("invalid timezone")
	}
	value = strings.TrimSpace(value)
	if value == "" {
		value = "UTC"
	}
	if len(value) > 64 {
		return "", nil, fmt.Errorf("invalid timezone")
	}
	// Abbreviations other than UTC are intentionally rejected: their offset
	// is globally ambiguous and does not encode DST rules.
	if value != "UTC" && !strings.Contains(value, "/") {
		return "", nil, fmt.Errorf("timezone must be an IANA location")
	}
	location, err := time.LoadLocation(value)
	if err != nil {
		return "", nil, fmt.Errorf("unknown IANA timezone")
	}
	return value, location, nil
}

func parseDOW(s string) (time.Weekday, error) {
	switch strings.ToLower(s) {
	case "sun":
		return time.Sunday, nil
	case "mon":
		return time.Monday, nil
	case "tue":
		return time.Tuesday, nil
	case "wed":
		return time.Wednesday, nil
	case "thu":
		return time.Thursday, nil
	case "fri":
		return time.Friday, nil
	case "sat":
		return time.Saturday, nil
	}
	return 0, fmt.Errorf("invalid weekday: %s", s)
}

func parseHHMM(s string) (int, int, error) {
	parts := strings.Split(s, ":")
	if len(parts) != 2 {
		return 0, 0, fmt.Errorf("time must be HH:MM")
	}
	hh, err1 := strconv.Atoi(parts[0])
	mm, err2 := strconv.Atoi(parts[1])
	if err1 != nil || err2 != nil || hh < 0 || hh > 23 || mm < 0 || mm > 59 {
		return 0, 0, fmt.Errorf("invalid time")
	}
	return hh, mm, nil
}

func nextWeekly(
	from time.Time,
	location *time.Location,
	target time.Weekday,
	hh, mm int,
) time.Time {
	localFrom := from.In(location)
	daysAhead := int(target - localFrom.Weekday())
	if daysAhead < 0 {
		daysAhead += 7
	}
	targetDate := time.Date(
		localFrom.Year(),
		localFrom.Month(),
		localFrom.Day(),
		0,
		0,
		0,
		0,
		location,
	).AddDate(0, 0, daysAhead)
	candidate := localWallTime(
		targetDate.Year(),
		targetDate.Month(),
		targetDate.Day(),
		hh,
		mm,
		location,
	)
	if !candidate.After(from) {
		nextDate := targetDate.AddDate(0, 0, 7)
		candidate = localWallTime(
			nextDate.Year(),
			nextDate.Month(),
			nextDate.Day(),
			hh,
			mm,
			location,
		)
	}
	return candidate.UTC()
}

func nextMonthly(
	from time.Time,
	location *time.Location,
	dom, hh, mm int,
) time.Time {
	localFrom := from.In(location)
	candidate := localWallTime(
		localFrom.Year(),
		localFrom.Month(),
		dom,
		hh,
		mm,
		location,
	)
	if !candidate.After(from) {
		nextMonth := time.Date(
			localFrom.Year(),
			localFrom.Month(),
			1,
			0,
			0,
			0,
			0,
			location,
		).AddDate(0, 1, 0)
		candidate = localWallTime(
			nextMonth.Year(),
			nextMonth.Month(),
			dom,
			hh,
			mm,
			location,
		)
	}
	return candidate.UTC()
}

// localWallTime applies the documented DST policy without depending on
// time.Date's choice for an ambiguous local clock. Walking real instants in
// chronological order makes the first exact match the first fall-back
// occurrence. If there is no exact match, the first later local minute is the
// spring-gap result.
func localWallTime(
	year int,
	month time.Month,
	day, hh, mm int,
	location *time.Location,
) time.Time {
	targetMinute := hh*60 + mm
	// Local noon exists on ordinary DST transition days. Starting 18 actual
	// hours earlier covers long/short civil days and both repeated hours.
	start := time.Date(year, month, day, 12, 0, 0, 0, location).
		Add(-18 * time.Hour)
	var firstLater time.Time
	var firstFollowingDate time.Time
	for elapsed := 0; elapsed <= 42*60; elapsed++ {
		probe := start.Add(time.Duration(elapsed) * time.Minute)
		local := probe.In(location)
		switch {
		case local.Year() == year && local.Month() == month && local.Day() == day:
			localMinute := local.Hour()*60 + local.Minute()
			if localMinute == targetMinute {
				return probe
			}
			if localMinute > targetMinute && firstLater.IsZero() {
				firstLater = probe
			}
		case firstFollowingDate.IsZero() &&
			time.Date(
				local.Year(),
				local.Month(),
				local.Day(),
				0,
				0,
				0,
				0,
				time.UTC,
			).After(time.Date(year, month, day, 0, 0, 0, 0, time.UTC)):
			firstFollowingDate = probe
		}
	}
	if !firstLater.IsZero() {
		return firstLater
	}
	if !firstFollowingDate.IsZero() {
		return firstFollowingDate
	}
	// The location database could not represent the requested or a following
	// civil date inside the deliberately generous search window.
	return time.Date(year, month, day, hh, mm, 0, 0, location)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]any{"code": code, "message": msg},
	})
}

func canonicalReportID(value string) (string, bool) {
	parsed, err := uuid.Parse(strings.TrimSpace(value))
	if err != nil {
		return "", false
	}
	return parsed.String(), true
}
