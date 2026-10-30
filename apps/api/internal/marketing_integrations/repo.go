// SPDX-License-Identifier: AGPL-3.0-only
package marketing_integrations

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
)

var ErrNotFound = errors.New("marketing_integrations: not found")
var ErrProviderCleanupMissing = errors.New("marketing_integrations: provider cleanup evidence missing")

type Repo struct {
	Pool      *db.Pool
	Cipher    EnvelopeCipher
	LegacyKEK []byte
}

type EnvelopeCipher interface {
	Encrypt(ctx context.Context, plaintext []byte) ([]byte, error)
	Decrypt(ctx context.Context, blob, legacyKEK []byte) ([]byte, error)
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
  FROM marketing_integrations
 WHERE tenant_id = $1::uuid
   AND status <> 'disconnected'
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
INSERT INTO marketing_integrations (
    tenant_id, provider, name, status, scopes, credentials_ref, settings
) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb)
ON CONFLICT (tenant_id, provider, name) DO UPDATE SET
    status = EXCLUDED.status,
    scopes = EXCLUDED.scopes,
    credentials_ref = EXCLUDED.credentials_ref,
    settings = (marketing_integrations.settings - 'provider_cleanup') || EXCLUDED.settings,
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

func (r *Repo) PauseIntegration(ctx context.Context, tenantID, id string) (*Integration, error) {
	return r.setStatus(ctx, tenantID, id, "paused")
}

func (r *Repo) DisconnectIntegration(ctx context.Context, tenantID, id string) error {
	return r.DisconnectIntegrationWithProviderCleanup(ctx, tenantID, id, nil)
}

func (r *Repo) DisconnectIntegrationWithProviderCleanup(ctx context.Context, tenantID, id string, cleanup *DisconnectCleanupEvidence) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var tag pgconn.CommandTag
	if cleanup != nil {
		payload, marshalErr := json.Marshal(cleanup)
		if marshalErr != nil {
			return marshalErr
		}
		tag, err = tx.Exec(ctx, `
UPDATE marketing_integrations
   SET status = 'disconnected',
       settings = settings || jsonb_build_object('provider_cleanup', $3::jsonb),
       error_message = '',
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, id, string(payload))
	} else {
		tag, err = tx.Exec(ctx, `
UPDATE marketing_integrations
   SET status = 'disconnected',
       error_message = '',
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, id)
	}
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
	if current.Provider != ProviderKlaviyo || current.Status != "disconnected" ||
		current.Settings == nil || current.Settings["provider_cleanup"] == nil {
		return nil, ErrProviderCleanupMissing
	}
	patch := map[string]any{
		"status":          "operator_acknowledged",
		"acknowledged_at": acknowledgedAt.UTC().Format(time.RFC3339),
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
UPDATE marketing_integrations
   SET settings = jsonb_set(
           settings,
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
   AND provider = 'klaviyo'
   AND status = 'disconnected'
   AND settings ? 'provider_cleanup'
RETURNING id::text, tenant_id::text, provider, name, status, scopes,
       credentials_ref, settings, sync_cursor, last_sync_at,
       error_message, created_at, updated_at`, tenantID, id, string(payload))
	out, err := scanIntegration(row)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil, ErrProviderCleanupMissing
		}
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
	status := strings.TrimSpace(summary.Status)
	if status == "" {
		status = "completed"
	}
	cursor := firstString(summary.Cursor, req.Cursor, current.SyncCursor)
	metadata := cloneMap(req.Metadata)
	for key, value := range summary.Metadata {
		metadata[key] = value
	}
	metadata["provider"] = current.Provider
	metadata["mode"] = req.RunMode
	if spec, ok := ProviderSpecByKey(current.Provider); ok {
		metadata["sync_model"] = spec.SyncModel
	} else {
		metadata["sync_model"] = settingString(current.Settings, "sync_model")
	}
	metadataJSON, _ := json.Marshal(metadata)
	row := tx.QueryRow(ctx, `
INSERT INTO marketing_sync_runs (
    tenant_id, integration_id, run_mode, status, cursor_from, cursor_to,
    profiles_seen, events_seen, lists_seen, rows_failed, error_message,
    metadata, started_at, completed_at
) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14)
RETURNING id::text, tenant_id::text, integration_id::text, run_mode, status,
       cursor_from, cursor_to, profiles_seen, events_seen, lists_seen,
       rows_failed, error_message, metadata, started_at, completed_at, created_at`,
		tenantID, integrationID, req.RunMode, status, current.SyncCursor, cursor,
		summary.ProfilesSeen, summary.EventsSeen, summary.ListsSeen,
		summary.RowsFailed, summary.ErrorMessage, string(metadataJSON),
		started, completed)
	run, err := scanSyncRun(row)
	if err != nil {
		return nil, err
	}
	integrationStatus := "connected"
	if status == "failed" {
		integrationStatus = "error"
	} else if current.Status == "paused" {
		integrationStatus = "paused"
	} else if marketingIntegrationDisconnected(current) {
		integrationStatus = "disconnected"
	}
	if _, err := tx.Exec(ctx, `
UPDATE marketing_integrations
   SET status = CASE WHEN status = 'disconnected' THEN status ELSE $3 END,
       sync_cursor = CASE WHEN status = 'disconnected' THEN sync_cursor ELSE $4 END,
       last_sync_at = CASE WHEN status = 'disconnected' THEN last_sync_at ELSE $5 END,
       error_message = CASE WHEN status = 'disconnected' THEN error_message ELSE $6 END,
       updated_at = CASE WHEN status = 'disconnected' THEN updated_at ELSE now() END
 WHERE tenant_id = $1::uuid AND id::text = $2`,
		tenantID, integrationID, integrationStatus, cursor, completed, summary.ErrorMessage); err != nil {
		return nil, err
	}
	return run, tx.Commit(ctx)
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
       cursor_from, cursor_to, profiles_seen, events_seen, lists_seen,
       rows_failed, error_message, metadata, started_at, completed_at, created_at
  FROM marketing_sync_runs
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

func (r *Repo) FindKlaviyoIntegrationByWebhookToken(ctx context.Context, token string) (*Integration, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true), set_config('app.marketing_webhook_provider', 'klaviyo', true), set_config('app.marketing_webhook_token', $1, true)`, token); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
WITH matched AS (
    SELECT id::text, tenant_id::text, provider, name, status, scopes,
           credentials_ref, settings, sync_cursor, last_sync_at,
           error_message, created_at, updated_at
      FROM marketing_integrations
     WHERE provider = 'klaviyo'
       AND status IN ('connected', 'active', 'paused', 'error')
       AND COALESCE(NULLIF(settings->>'klaviyo_webhook_token', ''), NULLIF(settings->>'marketing_webhook_token', ''), NULLIF(settings->>'webhook_token', '')) = $1
),
counted AS (
    SELECT matched.*, count(*) OVER () AS match_count
      FROM matched
)
SELECT id, tenant_id, provider, name, status, scopes,
       credentials_ref, settings, sync_cursor, last_sync_at,
       error_message, created_at, updated_at
  FROM counted
 WHERE match_count = 1
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

func (r *Repo) ClaimMarketingWebhook(ctx context.Context, tenantID, integrationID, provider, webhookID, topic string, body []byte) (WebhookClaim, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	sum := sha256.Sum256(body)
	bodyHash := hex.EncodeToString(sum[:])
	tag, err := tx.Exec(ctx, `
INSERT INTO marketing_webhook_events (
    tenant_id, integration_id, provider, webhook_id, topic, body_sha256, status, attempts
) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, 'in_progress', 1)
ON CONFLICT (tenant_id, integration_id, provider, webhook_id) DO NOTHING`,
		tenantID, integrationID, provider, webhookID, topic, bodyHash)
	if err != nil {
		return "", err
	}
	if tag.RowsAffected() == 1 {
		return WebhookClaimed, tx.Commit(ctx)
	}
	var status string
	var storedBodyHash string
	if err := tx.QueryRow(ctx, `
SELECT status, body_sha256
  FROM marketing_webhook_events
 WHERE tenant_id = $1::uuid
   AND integration_id = $2::uuid
   AND provider = $3
   AND webhook_id = $4`, tenantID, integrationID, provider, webhookID).Scan(&status, &storedBodyHash); err != nil {
		return "", err
	}
	if storedBodyHash != bodyHash {
		return "", fmt.Errorf("%w: delivery %q", ErrMarketingWebhookBodyMismatch, webhookID)
	}
	switch status {
	case "processed":
		return WebhookProcessed, tx.Commit(ctx)
	case "failed":
		if _, err := tx.Exec(ctx, `
UPDATE marketing_webhook_events
   SET status = 'in_progress',
       topic = $5,
       body_sha256 = $6,
       attempts = attempts + 1,
       last_error = NULL,
       updated_at = now()
 WHERE tenant_id = $1::uuid
   AND integration_id = $2::uuid
   AND provider = $3
   AND webhook_id = $4`, tenantID, integrationID, provider, webhookID, topic, bodyHash); err != nil {
			return "", err
		}
		return WebhookClaimed, tx.Commit(ctx)
	default:
		return WebhookInProgress, tx.Commit(ctx)
	}
}

func (r *Repo) MarkMarketingWebhookProcessed(ctx context.Context, tenantID, integrationID, provider, webhookID string) error {
	return r.markMarketingWebhook(ctx, tenantID, integrationID, provider, webhookID, "processed", "")
}

func (r *Repo) MarkMarketingWebhookFailed(ctx context.Context, tenantID, integrationID, provider, webhookID string, err error) error {
	msg := ""
	if err != nil {
		msg = err.Error()
	}
	return r.markMarketingWebhook(ctx, tenantID, integrationID, provider, webhookID, "failed", msg)
}

func (r *Repo) markMarketingWebhook(ctx context.Context, tenantID, integrationID, provider, webhookID, status, msg string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
UPDATE marketing_webhook_events
   SET status = $5,
       last_error = NULLIF($6, ''),
       processed_at = CASE WHEN $5 = 'processed' THEN now() ELSE processed_at END,
       updated_at = now()
 WHERE tenant_id = $1::uuid
   AND integration_id = $2::uuid
   AND provider = $3
   AND webhook_id = $4`, tenantID, integrationID, provider, webhookID, status, msg)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *Repo) ListKlaviyoBackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]KlaviyoBackfillTarget, error) {
	if limit <= 0 || limit > 100 {
		limit = 10
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.marketing_worker', 'true', true)`); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT tenant_id::text, id::text, sync_cursor, last_sync_at, error_message
  FROM marketing_integrations
 WHERE provider = 'klaviyo'
   AND status IN ('connected', 'active', 'error')
   AND (
        status = 'error'
        OR last_sync_at IS NULL
        OR last_sync_at < $2
   )
 ORDER BY last_sync_at NULLS FIRST, updated_at
 LIMIT $1`, limit, staleBefore)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []KlaviyoBackfillTarget{}
	for rows.Next() {
		var item KlaviyoBackfillTarget
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

func (r *Repo) setStatus(ctx context.Context, tenantID, id, status string) (*Integration, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
UPDATE marketing_integrations
   SET status = $3,
       error_message = '',
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2
   AND status != 'disconnected'
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
  FROM marketing_integrations
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
		&item.EventsSeen,
		&item.ListsSeen,
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
