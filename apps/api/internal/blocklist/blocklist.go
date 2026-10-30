// SPDX-License-Identifier: AGPL-3.0-only
//
// Package blocklist exposes the per-tenant view of the deliverability
// service's blocklist monitor. The monitor writes observations to
// blocklist_observations (migration 0112); this package surfaces them
// to operators via authenticated API endpoints + acts on
// ShouldAutoSuppress decisions by writing into the existing
// email_suppressions list.
//
// Why a thin reader package alongside the deliverability worker:
//   - apps/api owns the per-tenant API contract + auth.
//   - services/deliverability owns the DNS fan-out + write path.
//   - Both share the same table; tenant isolation is enforced by RLS.
package blocklist

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Observation mirrors the blacklist.Observation struct so apps/api
// doesn't import the services/deliverability internal package.
type Observation struct {
	SubjectType string    `json:"subject_type"`
	Subject     string    `json:"subject"`
	Zone        string    `json:"zone"`
	Listed      bool      `json:"listed"`
	Confidence  float64   `json:"confidence"`
	Error       string    `json:"error,omitempty"`
	CheckedAt   time.Time `json:"checked_at"`
}

// SubjectStatus is the aggregated view of one subject's most recent
// observations across all zones.
type SubjectStatus struct {
	SubjectType  string        `json:"subject_type"`
	Subject      string        `json:"subject"`
	ListedZones  []string      `json:"listed_zones"`
	CleanZones   []string      `json:"clean_zones"`
	ErrorZones   []string      `json:"error_zones"`
	Tier1Hit     bool          `json:"tier1_hit"`
	Listed       int           `json:"listed_count"`
	TotalZones   int           `json:"total_zones"`
	AutoSuppress bool          `json:"would_auto_suppress"`
	Observations []Observation `json:"observations"`
	LastChecked  time.Time     `json:"last_checked"`
}

// Deps wires the handlers + auto-suppress hook.
type Deps struct {
	Pool   *db.Pool
	Logger *slog.Logger
}

// MountRoutes registers the per-tenant blocklist-status endpoints.
//
//	GET  /api/v1/monitoring/blocklist-status         — all subjects for tenant
//	GET  /api/v1/monitoring/blocklist-status/{type}/{subject}  — one subject
//	POST /api/v1/monitoring/blocklist-status/{type}/{subject}/suppress  — manually suppress
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(
		"/api/v1/monitoring/blocklist-status", d.List)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(
		"/api/v1/monitoring/blocklist-status/{subject_type}/{subject}", d.GetOne)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post(
		"/api/v1/monitoring/blocklist-status/{subject_type}/{subject}/suppress", d.Suppress)
}

// List returns the latest-per-zone observation for every subject the
// tenant owns (dedicated IPs + verified domains).
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	statuses, err := d.tenantStatuses(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	autoSuppress, err := tenantAutoSuppressEnabled(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"subjects":      statuses,
		"auto_suppress": autoSuppress,
	})
}

// GetOne returns the full status for one (subject_type, subject) plus
// the recent observation history.
func (d *Deps) GetOne(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	subjectType := chi.URLParam(r, "subject_type")
	subject := chi.URLParam(r, "subject")
	if subjectType != "ip" && subjectType != "domain" {
		writeJSON(w, http.StatusBadRequest, errEnv("bad_subject_type", "subject_type must be ip or domain"))
		return
	}
	hours := 24
	if v := r.URL.Query().Get("hours"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 24*30 {
			hours = n
		}
	}
	status, err := d.subjectStatus(r.Context(), t.ID, subjectType, subject, time.Duration(hours)*time.Hour)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if status == nil {
		writeJSON(w, http.StatusNotFound, errEnv("not_found", "no observations for subject"))
		return
	}
	writeJSON(w, http.StatusOK, status)
}

// Suppress is the manual-trigger of an auto-suppression action. Used
// by the dashboard's "Suppress now" button when a customer wants to
// act on a blocklist hit without waiting for the periodic auto-suppress
// sweep. Returns 409 if the subject is already on the suppression list.
func (d *Deps) Suppress(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	subjectType := chi.URLParam(r, "subject_type")
	subject := chi.URLParam(r, "subject")
	if subjectType != "ip" && subjectType != "domain" {
		writeJSON(w, http.StatusBadRequest, errEnv("bad_subject_type", "subject_type must be ip or domain"))
		return
	}
	added, err := insertSuppression(r.Context(), d.Pool, t.ID, subjectType, subject, "blocklist_manual")
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	status := http.StatusCreated
	if !added {
		status = http.StatusConflict
	}
	writeJSON(w, status, map[string]any{
		"subject_type":   subjectType,
		"subject":        subject,
		"added":          added,
		"suppression_at": time.Now().UTC(),
	})
}

// --- read helpers ---

func (d *Deps) tenantStatuses(ctx context.Context, tenantID string) ([]SubjectStatus, error) {
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
WITH latest AS (
  SELECT DISTINCT ON (subject_type, subject, zone)
         subject_type, subject, zone, listed, confidence,
         COALESCE(error,'') AS error, checked_at
    FROM blocklist_observations
   WHERE tenant_id = $1::uuid
   ORDER BY subject_type, subject, zone, checked_at DESC
)
SELECT subject_type, subject, zone, listed, confidence, error, checked_at
  FROM latest
 ORDER BY subject_type, subject, zone`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	bySubject := map[string]*SubjectStatus{}
	for rows.Next() {
		var o Observation
		if err := rows.Scan(
			&o.SubjectType, &o.Subject, &o.Zone, &o.Listed, &o.Confidence,
			&o.Error, &o.CheckedAt,
		); err != nil {
			return nil, err
		}
		key := o.SubjectType + ":" + o.Subject
		s, ok := bySubject[key]
		if !ok {
			s = &SubjectStatus{SubjectType: o.SubjectType, Subject: o.Subject}
			bySubject[key] = s
		}
		s.Observations = append(s.Observations, o)
		s.TotalZones++
		if o.CheckedAt.After(s.LastChecked) {
			s.LastChecked = o.CheckedAt
		}
		switch {
		case o.Error != "":
			s.ErrorZones = append(s.ErrorZones, o.Zone)
		case o.Listed:
			s.Listed++
			s.ListedZones = append(s.ListedZones, o.Zone)
			if o.Confidence >= 0.95 {
				s.Tier1Hit = true
			}
		default:
			s.CleanZones = append(s.CleanZones, o.Zone)
		}
	}
	out := make([]SubjectStatus, 0, len(bySubject))
	for _, s := range bySubject {
		s.AutoSuppress = s.Tier1Hit && s.Listed >= 2
		out = append(out, *s)
	}
	return out, rows.Err()
}

func (d *Deps) subjectStatus(ctx context.Context, tenantID, subjectType, subject string, window time.Duration) (*SubjectStatus, error) {
	since := time.Now().UTC().Add(-window)
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT subject_type, subject, zone, listed, confidence,
       COALESCE(error,''), checked_at
  FROM blocklist_observations
 WHERE tenant_id = $1::uuid
   AND subject_type = $2 AND subject = $3
   AND checked_at >= $4
 ORDER BY checked_at DESC`, tenantID, subjectType, subject, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	status := &SubjectStatus{SubjectType: subjectType, Subject: subject}
	zoneSeen := map[string]bool{}
	for rows.Next() {
		var o Observation
		if err := rows.Scan(
			&o.SubjectType, &o.Subject, &o.Zone, &o.Listed, &o.Confidence,
			&o.Error, &o.CheckedAt,
		); err != nil {
			return nil, err
		}
		status.Observations = append(status.Observations, o)
		if o.CheckedAt.After(status.LastChecked) {
			status.LastChecked = o.CheckedAt
		}
		if zoneSeen[o.Zone] {
			continue // dedupe per-zone for the summary counts
		}
		zoneSeen[o.Zone] = true
		status.TotalZones++
		switch {
		case o.Error != "":
			status.ErrorZones = append(status.ErrorZones, o.Zone)
		case o.Listed:
			status.Listed++
			status.ListedZones = append(status.ListedZones, o.Zone)
			if o.Confidence >= 0.95 {
				status.Tier1Hit = true
			}
		default:
			status.CleanZones = append(status.CleanZones, o.Zone)
		}
	}
	if status.TotalZones == 0 {
		return nil, nil
	}
	status.AutoSuppress = status.Tier1Hit && status.Listed >= 2
	return status, rows.Err()
}

// insertSuppression idempotently inserts a row into
// blocklist_suppressions. Returns (added=true) when a fresh row was
// inserted, (added=false) when the same subject was already present.
func insertSuppression(ctx context.Context, pool *db.Pool, tenantID, subjectType, subject, reason string) (bool, error) {
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
INSERT INTO blocklist_suppressions (tenant_id, subject_type, subject, reason)
VALUES ($1::uuid, $2, $3, $4)
ON CONFLICT (tenant_id, subject_type, subject) DO NOTHING`,
		tenantID, subjectType, subject, reason)
	if err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// AutoSuppressSweep runs the auto-suppress decision across every
// tenant-owned subject and inserts suppression entries for subjects
// where ShouldAutoSuppress() returns true (two zones listed including
// at least one tier-1).
//
// Idempotent: subjects already on the suppression list are skipped via
// ON CONFLICT DO NOTHING. Returns the number of NEW suppressions
// inserted in this sweep.
//
// Intended for a per-minute cron in the background (see
// apps/api/main.go wiring).
func (d *Deps) AutoSuppressSweep(ctx context.Context) (int, error) {
	tx, err := db.WithWorkerScope(ctx, d.Pool)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Pull the latest-per-zone observations across every tenant-owned
	// subject. Subjects with tenant_id IS NULL are operator-owned
	// free-pool IPs; we don't auto-suppress those (operator decides).
	rows, err := tx.Query(ctx, `
WITH latest AS (
  SELECT DISTINCT ON (tenant_id, subject_type, subject, zone)
         tenant_id, subject_type, subject, zone, listed, confidence, checked_at
    FROM blocklist_observations
   WHERE tenant_id IS NOT NULL
   ORDER BY tenant_id, subject_type, subject, zone, checked_at DESC
)
SELECT tenant_id::text, subject_type, subject,
       SUM(CASE WHEN listed AND confidence >= 0.95 THEN 1 ELSE 0 END) AS tier1_hits,
       SUM(CASE WHEN listed THEN 1 ELSE 0 END) AS listed_count
  FROM latest
 GROUP BY tenant_id, subject_type, subject
HAVING SUM(CASE WHEN listed AND confidence >= 0.95 THEN 1 ELSE 0 END) > 0
   AND SUM(CASE WHEN listed THEN 1 ELSE 0 END) >= 2`)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	inserted := 0
	type pending struct {
		tenantID, subjectType, subject string
	}
	var batch []pending
	for rows.Next() {
		var p pending
		var tier1, listed int
		if err := rows.Scan(&p.tenantID, &p.subjectType, &p.subject, &tier1, &listed); err != nil {
			return inserted, err
		}
		batch = append(batch, p)
	}
	if err := rows.Err(); err != nil {
		return inserted, err
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		return inserted, err
	}
	// Insert outside the SELECT — we need a tenant context for each.
	// The setting is tenant-scoped and defaults to false. This is the
	// load-bearing connection between the workspace toggle and the worker;
	// a process-wide environment flag must never opt every tenant in.
	enabledByTenant := map[string]bool{}
	for _, p := range batch {
		enabled, known := enabledByTenant[p.tenantID]
		if !known {
			var err error
			enabled, err = tenantAutoSuppressEnabled(ctx, d.Pool, p.tenantID)
			if err != nil {
				return inserted, err
			}
			enabledByTenant[p.tenantID] = enabled
		}
		if !enabled {
			continue
		}
		added, err := insertSuppression(ctx, d.Pool, p.tenantID, p.subjectType, p.subject, "blocklist_auto")
		if err != nil {
			return inserted, err
		}
		if added {
			inserted++
		}
	}
	return inserted, nil
}

func tenantAutoSuppressEnabled(ctx context.Context, pool *db.Pool, tenantID string) (bool, error) {
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var enabled bool
	err = tx.QueryRow(ctx, `
SELECT auto_suppress
  FROM blocklist_settings
 WHERE tenant_id = $1::uuid`, tenantID).Scan(&enabled)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, tx.Commit(ctx)
	}
	if err != nil {
		return false, err
	}
	return enabled, tx.Commit(ctx)
}

// --- helpers ---

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

type errEnvelope struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func errEnv(code, msg string) errEnvelope { return errEnvelope{Code: code, Message: msg} }

// Unused imports guard.
var _ = strings.TrimSpace
var _ = errors.New
