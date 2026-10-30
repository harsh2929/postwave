// SPDX-License-Identifier: AGPL-3.0-only
package analytics_integrations

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

var ErrNotFound = errors.New("analytics_integrations: not found")
var ErrDisconnected = errors.New("analytics_integrations: disconnected")

// ErrIngestNameConflict is returned when a webhook-ingest provision would collide
// with an existing NON-ingest (pull) integration on (tenant, provider, name).
var ErrIngestNameConflict = errors.New("analytics_integrations: name already in use by a non-ingest integration")

type Repo struct {
	Pool *db.Pool
}

func (r *Repo) ListIntegrations(ctx context.Context, tenantID string) ([]Integration, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, provider, name, status, scopes,
       credentials_ref, settings, sync_cursor, last_sync_at,
       error_message, created_at, updated_at
  FROM analytics_integrations
 WHERE tenant_id = $1::uuid
 ORDER BY updated_at DESC`, tenantID)
	if err != nil {
		return nil, err
	}
	items, err := scanIntegrations(rows)
	if err != nil {
		return nil, err
	}
	return items, tx.Commit(ctx)
}

func (r *Repo) GetIntegration(ctx context.Context, tenantID, id string) (*Integration, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	item, err := getIntegrationTx(ctx, tx, tenantID, id)
	if err != nil {
		return nil, err
	}
	return item, tx.Commit(ctx)
}

func (r *Repo) UpsertIntegration(ctx context.Context, tenantID string, in IntegrationInput) (*Integration, error) {
	normalized, _, err := normalizeIntegrationInput(in)
	if err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	settings, _ := json.Marshal(nonNilMap(normalized.Settings))
	row := tx.QueryRow(ctx, `
INSERT INTO analytics_integrations (
    tenant_id, provider, name, status, scopes, credentials_ref, settings
) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb)
ON CONFLICT (tenant_id, provider, name) DO UPDATE SET
    status = EXCLUDED.status,
    scopes = EXCLUDED.scopes,
    credentials_ref = EXCLUDED.credentials_ref,
    settings = analytics_integrations.settings || EXCLUDED.settings,
    error_message = '',
    updated_at = now()
RETURNING id::text, tenant_id::text, provider, name, status, scopes,
       credentials_ref, settings, sync_cursor, last_sync_at,
       error_message, created_at, updated_at`,
		tenantID, normalized.Provider, normalized.Name, normalized.Status,
		normalized.Scopes, normalized.CredentialsRef, string(settings))
	out, err := scanIntegration(row)
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// ProvisionIngestIntegration persists a webhook-ingest integration for a CDP
// source (Segment / RudderStack). Unlike UpsertIntegration it requires NO
// credentials_ref — an inbound CDP source has no outbound credential, only the
// inbound ingest token, which is the pre-tenant routing key resolved by the RLS
// lookup policy. The token is written under the provider-specific settings key
// the public lookup reads (segment_ingest_token / rudderstack_ingest_token).
func (r *Repo) ProvisionIngestIntegration(ctx context.Context, tenantID string, in IngestProvisionInput, token string) (*Integration, error) {
	provider := strings.ToLower(strings.TrimSpace(in.Provider))
	spec, ok := ProviderSpecByKey(provider)
	if !ok {
		return nil, fmt.Errorf("unsupported analytics provider %q", provider)
	}
	// CDP providers (segment/rudderstack) write under their own key; every other
	// provider uses the shared analytics_ingest_token (generic webhook ingest).
	tokenKey := analyticsIngestTokenSetting(provider)
	name := strings.TrimSpace(in.Name)
	if name == "" {
		name = spec.Name + " (webhook ingest)"
	}
	settings := map[string]any{
		tokenKey:              token,
		"managed_by_postwave": true,
		"provider_status":     spec.RuntimeStatus,
		"sync_model":          analyticsSyncModelIngest,
		"verification_mode":   spec.VerificationMode,
		"setup_surface":       "analytics_integrations",
		"ingest_mode":         "webhook",
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	settingsJSON, _ := json.Marshal(settings)
	row := tx.QueryRow(ctx, `
INSERT INTO analytics_integrations (
    tenant_id, provider, name, status, scopes, credentials_ref, settings
) VALUES ($1::uuid, $2, $3, 'connected', $4, '', $5::jsonb)
ON CONFLICT (tenant_id, provider, name) DO UPDATE SET
    status = CASE WHEN analytics_integrations.status = 'disconnected' THEN 'connected' ELSE analytics_integrations.status END,
    settings = analytics_integrations.settings || EXCLUDED.settings,
    error_message = '',
    updated_at = now()
WHERE analytics_integrations.settings->>'segment_ingest_token' IS NOT NULL
   OR analytics_integrations.settings->>'rudderstack_ingest_token' IS NOT NULL
   OR analytics_integrations.settings->>'analytics_ingest_token' IS NOT NULL
RETURNING id::text, tenant_id::text, provider, name, status, scopes,
       credentials_ref, settings, sync_cursor, last_sync_at,
       error_message, created_at, updated_at`,
		tenantID, provider, name, []string{}, string(settingsJSON))
	out, err := scanIntegration(row)
	if err != nil {
		// Conflict target was a non-ingest (pull) integration the WHERE refused
		// to convert.
		if errors.Is(err, ErrNotFound) {
			return nil, ErrIngestNameConflict
		}
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// RotateIngestToken issues a fresh ingest token for an existing webhook-ingest
// integration, invalidating the previous public URL. It writes the token under
// whichever provider-specific ingest key the row already carries and only matches
// rows that already carry such a token, so it cannot inject one into a pull
// integration or change which CDP key a row uses.
func (r *Repo) RotateIngestToken(ctx context.Context, tenantID, id, token string) (*Integration, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
UPDATE analytics_integrations
   SET settings = CASE
           WHEN settings->>'segment_ingest_token' IS NOT NULL
               THEN settings || jsonb_build_object('segment_ingest_token', $3::text)
           WHEN settings->>'rudderstack_ingest_token' IS NOT NULL
               THEN settings || jsonb_build_object('rudderstack_ingest_token', $3::text)
           ELSE settings || jsonb_build_object('analytics_ingest_token', $3::text)
       END,
       status = CASE WHEN status = 'disconnected' THEN 'connected' ELSE status END,
       error_message = '',
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2
   AND status != 'disconnected'
   AND (settings->>'segment_ingest_token' IS NOT NULL
        OR settings->>'rudderstack_ingest_token' IS NOT NULL
        OR settings->>'analytics_ingest_token' IS NOT NULL)
RETURNING id::text, tenant_id::text, provider, name, status, scopes,
       credentials_ref, settings, sync_cursor, last_sync_at,
       error_message, created_at, updated_at`, tenantID, id, token)
	out, err := scanIntegration(row)
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) PauseIntegration(ctx context.Context, tenantID, id string) (*Integration, error) {
	return r.setStatus(ctx, tenantID, id, "paused")
}

func (r *Repo) DisconnectIntegration(ctx context.Context, tenantID, id string) error {
	return r.disconnectIntegration(ctx, tenantID, id, nil)
}

func (r *Repo) DisconnectIntegrationWithProviderCleanup(ctx context.Context, tenantID, id string, cleanup map[string]any) error {
	return r.disconnectIntegration(ctx, tenantID, id, cleanup)
}

func (r *Repo) disconnectIntegration(ctx context.Context, tenantID, id string, cleanup map[string]any) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if cleanup == nil {
		tag, err := tx.Exec(ctx, `
UPDATE analytics_integrations
   SET status = 'disconnected',
       error_message = '',
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, id)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		return tx.Commit(ctx)
	}
	payload, err := json.Marshal(cleanup)
	if err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `
UPDATE analytics_integrations
   SET status = 'disconnected',
       error_message = '',
       settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{provider_cleanup}', $3::jsonb, true),
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, id, string(payload))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

func (r *Repo) AcknowledgeProviderCleanup(ctx context.Context, tenantID, id string, in ProviderCleanupAcknowledgementInput, acknowledgedAt time.Time) (*Integration, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	current, err := getIntegrationTx(ctx, tx, tenantID, id)
	if err != nil {
		return nil, err
	}
	if !analyticsIntegrationDisconnected(current) || current.Settings == nil || current.Settings["provider_cleanup"] == nil {
		return nil, ErrNotFound
	}
	patch := map[string]any{
		"status":                   "operator_acknowledged",
		"acknowledged_at":          acknowledgedAt.UTC().Format(time.RFC3339),
		"managed_provider_cleanup": false,
	}
	if strings.TrimSpace(in.AcknowledgedBy) != "" {
		patch["acknowledged_by"] = strings.TrimSpace(in.AcknowledgedBy)
	}
	if len(in.CompletedActions) > 0 {
		patch["completed_actions"] = append([]string(nil), in.CompletedActions...)
	}
	if strings.TrimSpace(in.Notes) != "" {
		patch["operator_notes"] = strings.TrimSpace(in.Notes)
	}
	payload, err := json.Marshal(patch)
	if err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
UPDATE analytics_integrations
   SET settings = jsonb_set(
           COALESCE(settings, '{}'::jsonb),
           '{provider_cleanup}',
           (
             CASE
               WHEN jsonb_typeof(settings->'provider_cleanup') = 'object'
               THEN settings->'provider_cleanup'
               ELSE '{}'::jsonb
             END
           ) || $3::jsonb,
           true
       ),
       updated_at = now()
 WHERE tenant_id = $1::uuid
   AND id::text = $2
   AND status = 'disconnected'
   AND settings->'provider_cleanup' IS NOT NULL
RETURNING id::text, tenant_id::text, provider, name, status, scopes,
       credentials_ref, settings, sync_cursor, last_sync_at,
       error_message, created_at, updated_at`, tenantID, id, string(payload))
	out, err := scanIntegration(row)
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) RecordSyncRun(ctx context.Context, tenantID, integrationID string, summary SyncSummary, req SyncRequest, started, completed time.Time) (*SyncRun, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	current, err := getIntegrationTx(ctx, tx, tenantID, integrationID)
	if err != nil {
		return nil, err
	}
	if analyticsIntegrationDisconnected(current) {
		return nil, ErrDisconnected
	}
	status := summary.Status
	if status == "" {
		status = "completed"
	}
	cursor := req.Cursor
	if cursor == "" {
		cursor = current.SyncCursor
	}
	metadata, _ := json.Marshal(map[string]any{
		"provider": current.Provider,
		"mode":     req.RunMode,
	})
	row := tx.QueryRow(ctx, `
INSERT INTO analytics_sync_runs (
    tenant_id, integration_id, run_mode, status, cursor_from, cursor_to,
    profiles_seen, profiles_upserted, events_seen, events_tracked,
    rows_failed, error_message, metadata, started_at, completed_at
) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15)
RETURNING id::text, tenant_id::text, integration_id::text, run_mode, status,
       cursor_from, cursor_to, profiles_seen, profiles_upserted,
       events_seen, events_tracked, rows_failed, error_message, metadata,
       started_at, completed_at, created_at`,
		tenantID, integrationID, req.RunMode, status, current.SyncCursor, cursor,
		summary.ProfilesSeen, summary.ProfilesUpserted, summary.EventsSeen,
		summary.EventsTracked, summary.RowsFailed, summary.ErrorMessage,
		string(metadata), started, completed)
	run, err := scanSyncRun(row)
	if err != nil {
		return nil, err
	}
	integrationStatus := "connected"
	if status == "failed" || status == "partial" {
		integrationStatus = "error"
	} else if current.Status == "paused" {
		integrationStatus = "paused"
	}
	if _, err := tx.Exec(ctx, `
UPDATE analytics_integrations
   SET status = $3,
       sync_cursor = $4,
       last_sync_at = $5,
       error_message = $6,
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2`,
		tenantID, integrationID, integrationStatus, cursor, completed, summary.ErrorMessage); err != nil {
		return nil, err
	}
	return run, tx.Commit(ctx)
}

func (r *Repo) ListAnalyticsBackfillTargets(ctx context.Context, provider string, limit int, staleBefore time.Time) ([]AnalyticsBackfillTarget, error) {
	if limit <= 0 {
		limit = 10
	} else if limit > analyticsBackfillWorkerMaxCandidateScan {
		limit = analyticsBackfillWorkerMaxCandidateScan
	}
	provider = strings.ToLower(strings.TrimSpace(provider))
	if !analyticsProviderCleanupEligible(provider) {
		return nil, nil
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.analytics_worker', 'true', true)`); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT tenant_id::text, id::text, sync_cursor, last_sync_at, error_message
  FROM analytics_integrations
 WHERE provider = $1
   AND status IN ('connected', 'active', 'error')
   AND (
        status = 'error'
        OR last_sync_at IS NULL
        OR last_sync_at < $3
   )
 ORDER BY last_sync_at NULLS FIRST, updated_at
 LIMIT $2`, provider, limit, staleBefore)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AnalyticsBackfillTarget{}
	for rows.Next() {
		var item AnalyticsBackfillTarget
		if err := rows.Scan(&item.TenantID, &item.IntegrationID, &item.Cursor, &item.LastSyncAt, &item.ErrorMessage); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) ListRuns(ctx context.Context, tenantID, integrationID string, limit int) ([]SyncRun, error) {
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := getIntegrationTx(ctx, tx, tenantID, integrationID); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, integration_id::text, run_mode, status,
       cursor_from, cursor_to, profiles_seen, profiles_upserted,
       events_seen, events_tracked, rows_failed, error_message, metadata,
       started_at, completed_at, created_at
  FROM analytics_sync_runs
 WHERE tenant_id = $1::uuid AND integration_id::text = $2
 ORDER BY created_at DESC
 LIMIT $3`, tenantID, integrationID, limit)
	if err != nil {
		return nil, err
	}
	items, err := scanSyncRuns(rows)
	if err != nil {
		return nil, err
	}
	return items, tx.Commit(ctx)
}

func (r *Repo) setStatus(ctx context.Context, tenantID, id, status string) (*Integration, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
UPDATE analytics_integrations
   SET status = $3,
       error_message = '',
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2
RETURNING id::text, tenant_id::text, provider, name, status, scopes,
       credentials_ref, settings, sync_cursor, last_sync_at,
       error_message, created_at, updated_at`, tenantID, id, status)
	out, err := scanIntegration(row)
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func getIntegrationTx(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, tenantID, id string) (*Integration, error) {
	row := q.QueryRow(ctx, `
SELECT id::text, tenant_id::text, provider, name, status, scopes,
       credentials_ref, settings, sync_cursor, last_sync_at,
       error_message, created_at, updated_at
  FROM analytics_integrations
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, id)
	return scanIntegration(row)
}

type integrationScanner interface {
	Scan(dest ...any) error
}

func scanIntegration(row integrationScanner) (*Integration, error) {
	var item Integration
	var settings []byte
	if err := row.Scan(
		&item.ID,
		&item.TenantID,
		&item.Provider,
		&item.Name,
		&item.Status,
		&item.Scopes,
		&item.CredentialsRef,
		&settings,
		&item.SyncCursor,
		&item.LastSyncAt,
		&item.ErrorMessage,
		&item.CreatedAt,
		&item.UpdatedAt,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	item.Settings = map[string]any{}
	_ = json.Unmarshal(settings, &item.Settings)
	return &item, nil
}

func scanIntegrations(rows pgx.Rows) ([]Integration, error) {
	defer rows.Close()
	out := []Integration{}
	for rows.Next() {
		item, err := scanIntegration(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *item)
	}
	return out, rows.Err()
}

type syncRunScanner interface {
	Scan(dest ...any) error
}

func scanSyncRun(row syncRunScanner) (*SyncRun, error) {
	var item SyncRun
	var metadata []byte
	if err := row.Scan(
		&item.ID,
		&item.TenantID,
		&item.IntegrationID,
		&item.RunMode,
		&item.Status,
		&item.CursorFrom,
		&item.CursorTo,
		&item.ProfilesSeen,
		&item.ProfilesUpserted,
		&item.EventsSeen,
		&item.EventsTracked,
		&item.RowsFailed,
		&item.ErrorMessage,
		&metadata,
		&item.StartedAt,
		&item.CompletedAt,
		&item.CreatedAt,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	item.Metadata = map[string]any{}
	_ = json.Unmarshal(metadata, &item.Metadata)
	return &item, nil
}

func scanSyncRuns(rows pgx.Rows) ([]SyncRun, error) {
	defer rows.Close()
	out := []SyncRun{}
	for rows.Next() {
		item, err := scanSyncRun(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *item)
	}
	return out, rows.Err()
}

func nonNilMap(in map[string]any) map[string]any {
	if in == nil {
		return map[string]any{}
	}
	return in
}

// FindSegmentIntegrationByIngestToken resolves a Segment integration by its
// public ingest token without prior tenant context. A dummy app.tenant_id keeps
// the tenant_isolation policy from evaluating an unset GUC (raw ::uuid cast).
func (r *Repo) FindSegmentIntegrationByIngestToken(ctx context.Context, token string) (*Integration, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true), set_config('app.analytics_ingest_token', $1, true)`, token); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, provider, name, status, scopes,
       credentials_ref, settings, sync_cursor, last_sync_at,
       error_message, created_at, updated_at
  FROM analytics_integrations
 WHERE provider = 'segment'
   AND settings->>'segment_ingest_token' = $1
   AND status IN ('connected', 'active', 'paused', 'error')
 ORDER BY updated_at DESC
 LIMIT 1`, token)
	out, err := scanIntegration(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// FindRudderStackIntegrationByIngestToken resolves a RudderStack integration by
// its public ingest token, mirroring FindSegmentIntegrationByIngestToken (same
// app.analytics_ingest_token GUC + dummy tenant scope + SELECT-only lookup
// policy).
func (r *Repo) FindRudderStackIntegrationByIngestToken(ctx context.Context, token string) (*Integration, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true), set_config('app.analytics_ingest_token', $1, true)`, token); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, provider, name, status, scopes,
       credentials_ref, settings, sync_cursor, last_sync_at,
       error_message, created_at, updated_at
  FROM analytics_integrations
 WHERE provider = 'rudderstack'
   AND settings->>'rudderstack_ingest_token' = $1
   AND status IN ('connected', 'active', 'paused', 'error')
 ORDER BY updated_at DESC
 LIMIT 1`, token)
	out, err := scanIntegration(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// FindAnalyticsIntegrationByIngestToken resolves a GENERIC analytics
// webhook-ingest integration (any provider — payments/events/cms and other
// profile+event tools) by its public token, keyed on the shared
// analytics_ingest_token settings key (migration 1617). Mirrors the CDP lookups
// but without a provider filter, since the generic path is provider-agnostic.
func (r *Repo) FindAnalyticsIntegrationByIngestToken(ctx context.Context, token string) (*Integration, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true), set_config('app.analytics_ingest_token', $1, true)`, token); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, provider, name, status, scopes,
       credentials_ref, settings, sync_cursor, last_sync_at,
       error_message, created_at, updated_at
  FROM analytics_integrations
 WHERE settings->>'analytics_ingest_token' = $1
   AND status IN ('connected', 'active', 'paused', 'error')
 ORDER BY updated_at DESC
 LIMIT 1`, token)
	out, err := scanIntegration(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}
