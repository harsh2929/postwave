// SPDX-License-Identifier: AGPL-3.0-only
package webhooks

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// AlertPrefs is the per-user, per-tenant webhook alerting preference.
// Canonical outbound auto-pause notifications currently consult the workspace
// owner's NotifyAutoDisabled value. Failure-rate and latency fields are
// compatibility settings consumed by the legacy webhook-delivery sweep until
// that evaluator is migrated to canonical outbound delivery evidence.
type AlertPrefs struct {
	UserID             string     `json:"user_id"`
	TenantID           string     `json:"tenant_id"`
	NotifyAutoDisabled bool       `json:"notify_auto_disabled"`
	NotifyFailureRate  bool       `json:"notify_failure_rate"`
	FailureRatePct     int        `json:"failure_rate_pct"`
	NotifyLatency      bool       `json:"notify_latency"`
	LatencyMs          int        `json:"latency_ms"`
	LastAlertedAt      *time.Time `json:"last_alerted_at,omitempty"`
	UpdatedAt          time.Time  `json:"updated_at"`
}

// GetAlertPrefs returns the user's prefs, defaulting to a sensible
// "auto_disabled only" config when nothing's stored yet.
func (r *Repo) GetAlertPrefs(ctx context.Context, tenantID, userID string) (*AlertPrefs, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	out := &AlertPrefs{
		UserID:             userID,
		TenantID:           tenantID,
		NotifyAutoDisabled: true,
		FailureRatePct:     20,
		LatencyMs:          5000,
		UpdatedAt:          time.Now().UTC(),
	}
	err = tx.QueryRow(ctx, `
SELECT notify_auto_disabled, notify_failure_rate, failure_rate_pct,
       notify_latency, latency_ms, last_alerted_at, updated_at
FROM webhook_alert_prefs
WHERE user_id = $1::uuid AND tenant_id = $2::uuid`, userID, tenantID,
	).Scan(
		&out.NotifyAutoDisabled, &out.NotifyFailureRate, &out.FailureRatePct,
		&out.NotifyLatency, &out.LatencyMs, &out.LastAlertedAt, &out.UpdatedAt,
	)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// UpsertAlertPrefs writes the user's chosen prefs.
func (r *Repo) UpsertAlertPrefs(ctx context.Context, tenantID, userID string, in AlertPrefs) error {
	// Defensive clamping — also enforced by SQL CHECK constraints.
	if in.FailureRatePct < 1 {
		in.FailureRatePct = 1
	}
	if in.FailureRatePct > 100 {
		in.FailureRatePct = 100
	}
	if in.LatencyMs < 1 {
		in.LatencyMs = 1
	}
	if in.LatencyMs > 600_000 {
		in.LatencyMs = 600_000
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO webhook_alert_prefs (user_id, tenant_id,
    notify_auto_disabled, notify_failure_rate, failure_rate_pct,
    notify_latency, latency_ms)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)
ON CONFLICT (user_id, tenant_id) DO UPDATE SET
    notify_auto_disabled = EXCLUDED.notify_auto_disabled,
    notify_failure_rate  = EXCLUDED.notify_failure_rate,
    failure_rate_pct     = EXCLUDED.failure_rate_pct,
    notify_latency       = EXCLUDED.notify_latency,
    latency_ms           = EXCLUDED.latency_ms,
    updated_at           = now()`,
		userID, tenantID,
		in.NotifyAutoDisabled, in.NotifyFailureRate, in.FailureRatePct,
		in.NotifyLatency, in.LatencyMs,
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// GetAlertPrefsHandler GET /api/v1/webhooks/alert-prefs
func (d *Deps) GetAlertPrefsHandler(w http.ResponseWriter, r *http.Request) {
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
	out, err := d.Repo.GetAlertPrefs(r.Context(), t.ID, u.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// PutAlertPrefsHandler PUT /api/v1/webhooks/alert-prefs
func (d *Deps) PutAlertPrefsHandler(w http.ResponseWriter, r *http.Request) {
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
		NotifyAutoDisabled *bool `json:"notify_auto_disabled"`
		NotifyFailureRate  *bool `json:"notify_failure_rate"`
		FailureRatePct     *int  `json:"failure_rate_pct"`
		NotifyLatency      *bool `json:"notify_latency"`
		LatencyMs          *int  `json:"latency_ms"`
	}
	if err := httpbody.DecodeJSON(w, r, 4*1024, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if in.NotifyAutoDisabled == nil ||
		in.NotifyFailureRate == nil ||
		in.FailureRatePct == nil ||
		in.NotifyLatency == nil ||
		in.LatencyMs == nil {
		httperror.WriteValidation(
			w,
			"invalid_alert_preferences",
			"all webhook notification preference fields are required",
		)
		return
	}
	if *in.FailureRatePct < 1 || *in.FailureRatePct > 100 {
		httperror.WriteValidation(
			w,
			"invalid_alert_preferences",
			"failure_rate_pct must be between 1 and 100",
		)
		return
	}
	if *in.LatencyMs < 1 || *in.LatencyMs > 600_000 {
		httperror.WriteValidation(
			w,
			"invalid_alert_preferences",
			"latency_ms must be between 1 and 600000",
		)
		return
	}
	if d == nil || d.Repo == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable", ""))
		return
	}
	prefs := AlertPrefs{
		NotifyAutoDisabled: *in.NotifyAutoDisabled,
		NotifyFailureRate:  *in.NotifyFailureRate,
		FailureRatePct:     *in.FailureRatePct,
		NotifyLatency:      *in.NotifyLatency,
		LatencyMs:          *in.LatencyMs,
	}
	if err := d.Repo.UpsertAlertPrefs(r.Context(), t.ID, u.ID, prefs); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
