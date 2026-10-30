package zerocopy_triggers

// Alert thresholds + last-fired bookkeeping for zero-copy warehouse
// triggers. Backs migration 0345's `external_warehouse_trigger_alerts`
// table.
//
// Today this file is a contained scaffold:
//   - The data model is exposed via AlertConfig + the AlertRepo.Get /
//     Upsert / RecordFired helpers.
//   - The HTTP GET handler exposes a redacted inspection DTO; PUT is a stable
//     fail-closed compatibility boundary while the evaluator is unqualified.
//   - The actual *evaluator* that watches RecordTick outcomes and
//     decides to fire an alert is deferred — see MIGRATION.md.
//
// The evaluator's seam is intentionally narrow so a future PR can
// implement it without re-touching this surface area:
//
//     EvaluateAndMaybeAlert(ctx, repo, alertsRepo, notifier, trigger, now) error
//
// `notifier` will dispatch to the existing alerts package (or to the
// configured per-trigger webhook). Both targets exist in the codebase
// already — the missing piece is the conditional + cooldown logic.

import (
	"context"

	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/runtimecapability"
)

// AlertKind is the small set of alert reasons the evaluator may fire.
// Mirrors external_warehouse_trigger_alerts.last_alert_kind values.
type AlertKind string

const (
	AlertKindNone       AlertKind = ""
	AlertKindFailures   AlertKind = "failures"
	AlertKindLag        AlertKind = "lag"
	AlertKindFiresBurst AlertKind = "fires_burst"
)

// AlertConfig is the API/JSON shape of one alerts row.
type AlertConfig struct {
	TriggerID                    string     `json:"trigger_id"`
	TenantID                     string     `json:"tenant_id,omitempty"`
	ConsecutiveFailuresThreshold int        `json:"consecutive_failures_threshold"`
	LagSecondsThreshold          int        `json:"lag_seconds_threshold"`
	FiresPerTickThreshold        int        `json:"fires_per_tick_threshold"`
	NotifyWebhookURL             string     `json:"notify_webhook_url,omitempty"`
	CooldownSeconds              int        `json:"cooldown_seconds"`
	LastAlertFiredAt             *time.Time `json:"last_alert_fired_at,omitempty"`
	LastAlertKind                AlertKind  `json:"last_alert_kind,omitempty"`
	LastAlertMessage             string     `json:"last_alert_message,omitempty"`
	CreatedAt                    time.Time  `json:"created_at,omitempty"`
	UpdatedAt                    time.Time  `json:"updated_at,omitempty"`
}

// AlertConfigView is the read-safe control-plane representation. It preserves
// operational thresholds and evidence while withholding the raw webhook target
// and free-form provider/error message from broad read:reports callers.
type AlertConfigView struct {
	TriggerID                    string                       `json:"trigger_id"`
	Runtime                      runtimecapability.Descriptor `json:"runtime"`
	ConsecutiveFailuresThreshold int                          `json:"consecutive_failures_threshold"`
	LagSecondsThreshold          int                          `json:"lag_seconds_threshold"`
	FiresPerTickThreshold        int                          `json:"fires_per_tick_threshold"`
	WebhookConfigured            bool                         `json:"webhook_configured"`
	CooldownSeconds              int                          `json:"cooldown_seconds"`
	LastAlertFiredAt             *time.Time                   `json:"last_alert_fired_at,omitempty"`
	LastAlertKind                AlertKind                    `json:"last_alert_kind,omitempty"`
	HasLastAlertMessage          bool                         `json:"has_last_alert_message"`
	CreatedAt                    time.Time                    `json:"created_at,omitempty"`
	UpdatedAt                    time.Time                    `json:"updated_at,omitempty"`
}

// AlertRepo isolates the alerts table behind a small surface so the
// evaluator (when it ships) can be unit-tested with a fake.
type AlertRepo struct {
	Pool *db.Pool
}

const alertColumns = `trigger_id::text, tenant_id::text,
       consecutive_failures_threshold, lag_seconds_threshold,
       fires_per_tick_threshold, notify_webhook_url, cooldown_seconds,
       last_alert_fired_at, last_alert_kind, last_alert_message,
       created_at, updated_at`

// Get returns the alerts row for a trigger, or ErrNotFound if none
// has been configured yet.
func (r *AlertRepo) Get(ctx context.Context, tenantID, triggerID string) (*AlertConfig, error) {
	if strings.TrimSpace(triggerID) == "" {
		return nil, ErrNotFound
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
SELECT `+alertColumns+`
FROM external_warehouse_trigger_alerts
WHERE tenant_id = $1::uuid AND trigger_id = $2::uuid`, tenantID, triggerID)
	out, err := scanAlertConfig(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// Upsert creates or updates the alerts row for a trigger.
func (r *AlertRepo) Upsert(ctx context.Context, tenantID string, in AlertConfig) (*AlertConfig, error) {
	if !zeroCopyRuntimeQualified() {
		return nil, ErrZeroCopyRuntimeUnavailable
	}
	normalizeAlertConfig(&in)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
INSERT INTO external_warehouse_trigger_alerts
    (trigger_id, tenant_id, consecutive_failures_threshold, lag_seconds_threshold,
     fires_per_tick_threshold, notify_webhook_url, cooldown_seconds)
VALUES
    ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)
ON CONFLICT (trigger_id) DO UPDATE
    SET consecutive_failures_threshold = EXCLUDED.consecutive_failures_threshold,
        lag_seconds_threshold          = EXCLUDED.lag_seconds_threshold,
        fires_per_tick_threshold       = EXCLUDED.fires_per_tick_threshold,
        notify_webhook_url             = EXCLUDED.notify_webhook_url,
        cooldown_seconds               = EXCLUDED.cooldown_seconds,
        updated_at                     = now()
RETURNING `+alertColumns,
		in.TriggerID, tenantID,
		in.ConsecutiveFailuresThreshold, in.LagSecondsThreshold,
		in.FiresPerTickThreshold, in.NotifyWebhookURL, in.CooldownSeconds)
	out, err := scanAlertConfig(row)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// RecordFired stamps the last-fired bookkeeping after the evaluator has
// dispatched a notification. The evaluator calls this BEFORE attempting
// the webhook so a stuck webhook can't bypass the cooldown.
func (r *AlertRepo) RecordFired(ctx context.Context, tenantID, triggerID string, kind AlertKind, msg string, now time.Time) error {
	if !zeroCopyRuntimeQualified() {
		return ErrZeroCopyRuntimeUnavailable
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE external_warehouse_trigger_alerts
   SET last_alert_fired_at = $3,
       last_alert_kind     = $4,
       last_alert_message  = $5,
       updated_at          = now()
 WHERE tenant_id = $1::uuid AND trigger_id = $2::uuid`,
		tenantID, triggerID, now, string(kind), msg); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func normalizeAlertConfig(in *AlertConfig) {
	if in.ConsecutiveFailuresThreshold < 0 {
		in.ConsecutiveFailuresThreshold = 0
	}
	if in.ConsecutiveFailuresThreshold > 1000 {
		in.ConsecutiveFailuresThreshold = 1000
	}
	if in.LagSecondsThreshold < 0 {
		in.LagSecondsThreshold = 0
	}
	if in.LagSecondsThreshold > 604800 {
		in.LagSecondsThreshold = 604800
	}
	if in.FiresPerTickThreshold < 0 {
		in.FiresPerTickThreshold = 0
	}
	if in.CooldownSeconds <= 0 {
		in.CooldownSeconds = 1800
	}
	if in.CooldownSeconds > 86400 {
		in.CooldownSeconds = 86400
	}
	in.NotifyWebhookURL = strings.TrimSpace(in.NotifyWebhookURL)
}

func scanAlertConfig(row pgx.Row) (*AlertConfig, error) {
	var out AlertConfig
	var kind string
	if err := row.Scan(
		&out.TriggerID, &out.TenantID,
		&out.ConsecutiveFailuresThreshold, &out.LagSecondsThreshold,
		&out.FiresPerTickThreshold, &out.NotifyWebhookURL, &out.CooldownSeconds,
		&out.LastAlertFiredAt, &kind, &out.LastAlertMessage,
		&out.CreatedAt, &out.UpdatedAt,
	); err != nil {
		return nil, err
	}
	out.LastAlertKind = AlertKind(kind)
	return &out, nil
}

// ----------------------------------------------------------------------
// HTTP handlers.
//
// GET /api/v1/zero-copy-triggers/{id}/alerts
// PUT /api/v1/zero-copy-triggers/{id}/alerts
// ----------------------------------------------------------------------

// GetAlerts returns the alert config for a trigger, or a sensible
// default if no config has been written yet (so the UI never has to
// special-case the empty state).
func (d *Deps) GetAlerts(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	id := chi.URLParam(r, "id")
	if d.AlertRepo == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("alerts_disabled",
			"alert repo not wired"))
		return
	}
	cfg, err := d.AlertRepo.Get(r.Context(), tenantID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusOK, alertConfigView(defaultAlertConfig(id)))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, alertConfigView(*cfg))
}

// PutAlerts is a fail-closed compatibility boundary. Persisting thresholds or
// an arbitrary webhook URL would claim a working evaluator/notifier and retain
// a dormant SSRF target, so rejection happens before body decoding or DB use.
func (d *Deps) PutAlerts(w http.ResponseWriter, r *http.Request) {
	if _, ok := tenantID(r); !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	runtimecapability.WriteUnavailable(w, zeroCopyControlPlaneDescriptor())
}

func defaultAlertConfig(triggerID string) AlertConfig {
	return AlertConfig{
		TriggerID:                    triggerID,
		ConsecutiveFailuresThreshold: 5,
		LagSecondsThreshold:          900,
		FiresPerTickThreshold:        0,
		CooldownSeconds:              1800,
	}
}

func alertConfigView(in AlertConfig) AlertConfigView {
	return AlertConfigView{
		TriggerID:                    in.TriggerID,
		Runtime:                      zeroCopyRuntimeDescriptor(),
		ConsecutiveFailuresThreshold: in.ConsecutiveFailuresThreshold,
		LagSecondsThreshold:          in.LagSecondsThreshold,
		FiresPerTickThreshold:        in.FiresPerTickThreshold,
		WebhookConfigured:            strings.TrimSpace(in.NotifyWebhookURL) != "",
		CooldownSeconds:              in.CooldownSeconds,
		LastAlertFiredAt:             in.LastAlertFiredAt,
		LastAlertKind:                in.LastAlertKind,
		HasLastAlertMessage:          strings.TrimSpace(in.LastAlertMessage) != "",
		CreatedAt:                    in.CreatedAt,
		UpdatedAt:                    in.UpdatedAt,
	}
}
