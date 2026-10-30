// SPDX-License-Identifier: AGPL-3.0-only
package analytics

import (
	"context"

	"net/http"
	"strconv"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// AnomalyRow is one detected anomaly persisted by DashboardStats when
// the bounces (or future) series spikes above the z-score threshold.
type AnomalyRow struct {
	ID         string    `json:"id"`
	TenantID   string    `json:"tenantId"`
	Metric     string    `json:"metric"`
	DayBucket  time.Time `json:"dayBucket"`
	Value      int       `json:"value"`
	Mean       float64   `json:"mean"`
	ZScore     float64   `json:"zScore"`
	RangeUsed  string    `json:"rangeUsed"`
	DetectedAt time.Time `json:"detectedAt"`
}

// RecordAnomaly upserts a single anomaly. Uniqueness on
// (tenant, metric, day_bucket) means re-detection on the same day
// just updates the row rather than spamming history.
//
// Called inline from DashboardStatsWithOptions when detectAnomalySimple
// fires, so the user's first refresh persists the spike.
func (r *Repo) RecordAnomaly(
	ctx context.Context,
	tenantID, metric, rangeUsed string,
	dayBucket time.Time, value int, mean, zScore float64,
) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO dashboard_anomalies (tenant_id, metric, day_bucket, value, mean, z_score, range_used)
VALUES ($1::uuid, $2, $3::date, $4, $5, $6, $7)
ON CONFLICT (tenant_id, metric, day_bucket)
DO UPDATE SET value = EXCLUDED.value,
              mean = EXCLUDED.mean,
              z_score = EXCLUDED.z_score,
              range_used = EXCLUDED.range_used,
              detected_at = now()`,
		tenantID, metric, dayBucket, value, mean, zScore, rangeUsed,
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ListAnomalies returns the most-recently detected anomalies for the
// tenant, newest first. Cap of 50 — the UI only ever shows the top N.
func (r *Repo) ListAnomalies(ctx context.Context, tenantID string, limit int) ([]AnomalyRow, error) {
	if limit <= 0 || limit > 50 {
		limit = 20
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, metric, day_bucket, value, mean, z_score, range_used, detected_at
FROM dashboard_anomalies
ORDER BY detected_at DESC
LIMIT `+strconv.Itoa(limit))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AnomalyRow{}
	for rows.Next() {
		var a AnomalyRow
		if err := rows.Scan(
			&a.ID, &a.TenantID, &a.Metric, &a.DayBucket, &a.Value,
			&a.Mean, &a.ZScore, &a.RangeUsed, &a.DetectedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// ListAnomalies GET /api/v1/dashboard/anomalies?limit=20
func (d *Deps) ListAnomalies(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	if d == nil || d.Repo == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable", ""))
		return
	}
	limit := atoiDefaultDash(r.URL.Query().Get("limit"), 20)
	out, err := d.Repo.ListAnomalies(r.Context(), t.ID, limit)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

/* ---------- digest prefs --------------------------------------- */

// DigestPrefs is the per-user dashboard email digest preference.
type DigestPrefs struct {
	UserID     string     `json:"userId"`
	TenantID   string     `json:"tenantId"`
	Frequency  string     `json:"frequency"` // "off" | "daily" | "weekly"
	LastSentAt *time.Time `json:"lastSentAt,omitempty"`
	UpdatedAt  time.Time  `json:"updatedAt"`
}

// GetDigestPrefs returns the row for the user+tenant, or a default
// (off) when the user hasn't set anything yet. We don't insert a
// default row on read — keeps the table clean and the user-visible
// state defaults to "I haven't opted in".
func (r *Repo) GetDigestPrefs(ctx context.Context, tenantID, userID string) (*DigestPrefs, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	out := &DigestPrefs{UserID: userID, TenantID: tenantID, Frequency: "off"}
	row := tx.QueryRow(ctx, `
SELECT frequency, last_sent_at, updated_at
FROM dashboard_digest_prefs
WHERE user_id = $1::uuid AND tenant_id = $2::uuid`, userID, tenantID)
	var freq string
	var lastSent *time.Time
	var updatedAt time.Time
	switch err := row.Scan(&freq, &lastSent, &updatedAt); err {
	case nil:
		out.Frequency = freq
		out.LastSentAt = lastSent
		out.UpdatedAt = updatedAt
		return out, tx.Commit(ctx)
	default:
		// pgx returns ErrNoRows; we already handle it via default sentinel above.
		// Re-fetch updatedAt as now() in the default-off case.
		out.UpdatedAt = time.Now().UTC()
		return out, tx.Commit(ctx)
	}
}

// UpsertDigestPrefs writes the user's chosen frequency. Validation
// (off / daily / weekly) is enforced at the SQL level too via the
// CHECK constraint on the table.
func (r *Repo) UpsertDigestPrefs(ctx context.Context, tenantID, userID, freq string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO dashboard_digest_prefs (user_id, tenant_id, frequency)
VALUES ($1::uuid, $2::uuid, $3)
ON CONFLICT (user_id, tenant_id)
DO UPDATE SET frequency = EXCLUDED.frequency, updated_at = now()`,
		userID, tenantID, freq,
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// GetDigestPrefs GET /api/v1/dashboard/digest
func (d *Deps) GetDigestPrefs(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	u, ok := middleware.UserFromContext(r.Context())
	if !ok || u == nil || u.ID == "" {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_user", ""))
		return
	}
	if d == nil || d.Repo == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable", ""))
		return
	}
	prefs, err := d.Repo.GetDigestPrefs(r.Context(), t.ID, u.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, prefs)
}

// PutDigestPrefs PUT /api/v1/dashboard/digest  {"frequency":"off|daily|weekly"}
func (d *Deps) PutDigestPrefs(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	u, ok := middleware.UserFromContext(r.Context())
	if !ok || u == nil || u.ID == "" {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_user", ""))
		return
	}
	var in struct {
		Frequency string `json:"frequency"`
	}
	if err := httpbody.DecodeJSON(w, r, 1024, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if in.Frequency != "off" && in.Frequency != "daily" && in.Frequency != "weekly" {
		writeJSON(w, http.StatusBadRequest, errEnv("bad_frequency", "frequency must be off|daily|weekly"))
		return
	}
	if d == nil || d.Repo == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable", ""))
		return
	}
	if err := d.Repo.UpsertDigestPrefs(r.Context(), t.ID, u.ID, in.Frequency); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "frequency": in.Frequency})
}

func atoiDefaultDash(s string, def int) int {
	if s == "" {
		return def
	}
	n, err := strconv.Atoi(s)
	if err != nil || n <= 0 {
		return def
	}
	return n
}
