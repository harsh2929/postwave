// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

var ErrNotFound = errors.New("crm_integrations: not found")
var ErrCRMWebhookBodyMismatch = errors.New("crm_integrations: webhook body hash mismatch")

const defaultCRMWebhookClaimStaleAfter = 10 * time.Minute

type Repo struct {
	Pool                   *db.Pool
	Cipher                 EnvelopeCipher
	LegacyKEK              []byte
	webhookClaimStaleAfter time.Duration
}

// bindOAuthStateHash narrows a pre-tenant OAuth callback transaction to the
// one row authorized by the caller's high-entropy state token. The matching
// RLS policy added by migration 1721 also admits tenant-scoped requests, but a
// public callback has no tenant identity until this one-time row is consumed.
func bindOAuthStateHash(ctx context.Context, tx pgx.Tx, stateHash string) error {
	_, err := tx.Exec(ctx, "SELECT set_config('app.oauth_state_hash', $1, true)", stateHash)
	return err
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
  FROM crm_integrations
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

func (r *Repo) FindIntegrationByTenantProviderName(ctx context.Context, tenantID, provider, name string) (*Integration, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, provider, name, status, scopes,
       credentials_ref, settings, sync_cursor, last_sync_at,
       error_message, created_at, updated_at
  FROM crm_integrations
 WHERE tenant_id = $1::uuid
   AND provider = $2
   AND name = $3
 ORDER BY updated_at DESC
 LIMIT 1`, tenantID, strings.ToLower(strings.TrimSpace(provider)), strings.TrimSpace(name))
	out, err := scanIntegration(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
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
INSERT INTO crm_integrations (
    tenant_id, provider, name, status, scopes, credentials_ref, settings
) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb)
ON CONFLICT (tenant_id, provider, name) DO UPDATE SET
    status = EXCLUDED.status,
    scopes = EXCLUDED.scopes,
    credentials_ref = EXCLUDED.credentials_ref,
    settings = CASE
        WHEN crm_integrations.status = 'disconnected' AND EXCLUDED.status <> 'disconnected'
            THEN EXCLUDED.settings
        ELSE (COALESCE(crm_integrations.settings, '{}'::jsonb) - 'provider_cleanup') || EXCLUDED.settings
    END,
    sync_cursor = CASE
        WHEN crm_integrations.status = 'disconnected' AND EXCLUDED.status <> 'disconnected' THEN ''
        ELSE crm_integrations.sync_cursor
    END,
    last_sync_at = CASE
        WHEN crm_integrations.status = 'disconnected' AND EXCLUDED.status <> 'disconnected' THEN NULL
        ELSE crm_integrations.last_sync_at
    END,
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

func (r *Repo) ResumeIntegration(ctx context.Context, tenantID, id string) (*Integration, error) {
	return r.setStatus(ctx, tenantID, id, "active")
}

func (r *Repo) DisconnectIntegration(ctx context.Context, tenantID, id string) error {
	return r.DisconnectIntegrationWithProviderCleanup(ctx, tenantID, id, nil)
}

func (r *Repo) DisconnectIntegrationWithProviderCleanup(ctx context.Context, tenantID, id string, cleanup *DisconnectCleanupEvidence) error {
	tx, txErr := db.WithTenant(ctx, r.Pool, tenantID)
	if txErr != nil {
		return txErr
	}
	defer func() { _ = tx.Rollback(ctx) }()
	cleanupPayload := ""
	if cleanup != nil {
		payload, err := json.Marshal(cleanup)
		if err != nil {
			return err
		}
		cleanupPayload = string(payload)
	}
	tag, txErr := tx.Exec(ctx, `
UPDATE crm_integrations
   SET status = 'disconnected',
       settings = CASE
           WHEN NULLIF($3, '') IS NULL THEN COALESCE(settings, '{}'::jsonb)
           ELSE COALESCE(settings, '{}'::jsonb) || jsonb_build_object('provider_cleanup', $3::jsonb)
       END,
       error_message = '',
       updated_at = now()
 WHERE tenant_id = $1::uuid
   AND id::text = $2
   AND status <> 'disconnected'`, tenantID, id, cleanupPayload)
	if txErr != nil {
		return txErr
	}
	if tag.RowsAffected() == 0 {
		var status string
		txErr = tx.QueryRow(ctx, `
SELECT status
  FROM crm_integrations
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, id).Scan(&status)
		if errors.Is(txErr, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if txErr != nil {
			return txErr
		}
		if strings.EqualFold(strings.TrimSpace(status), "disconnected") {
			return tx.Commit(ctx)
		}
		return ErrNotFound
	}
	return tx.Commit(ctx)
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
INSERT INTO crm_sync_runs (
    tenant_id, integration_id, run_mode, status, cursor_from, cursor_to,
    contacts_seen, contacts_upserted, events_seen, events_tracked,
    rows_failed, error_message, metadata, started_at, completed_at
) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15)
RETURNING id::text, tenant_id::text, integration_id::text, run_mode, status,
       cursor_from, cursor_to, contacts_seen, contacts_upserted,
       events_seen, events_tracked, rows_failed, error_message, metadata,
       started_at, completed_at, created_at`,
		tenantID, integrationID, req.RunMode, status, current.SyncCursor, cursor,
		summary.ContactsSeen, summary.ContactsUpserted, summary.EventsSeen,
		summary.EventsTracked, summary.RowsFailed, summary.ErrorMessage,
		string(metadata), started, completed)
	run, err := scanSyncRun(row)
	if err != nil {
		return nil, err
	}
	integrationStatus := "connected"
	switch {
	case status == "failed":
		integrationStatus = "error"
	case current.Status == "paused":
		integrationStatus = "paused"
	case current.Status == "disconnected":
		integrationStatus = "disconnected"
	}
	if _, err := tx.Exec(ctx, `
UPDATE crm_integrations
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
	tx, txErr := db.WithTenant(ctx, r.Pool, tenantID)
	if txErr != nil {
		return nil, txErr
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := getIntegrationTx(ctx, tx, tenantID, integrationID); err != nil {
		return nil, err
	}
	rows, txErr := tx.Query(ctx, `
SELECT id::text, tenant_id::text, integration_id::text, run_mode, status,
       cursor_from, cursor_to, contacts_seen, contacts_upserted,
       events_seen, events_tracked, rows_failed, error_message, metadata,
       started_at, completed_at, created_at
  FROM crm_sync_runs
 WHERE tenant_id = $1::uuid AND integration_id::text = $2
 ORDER BY created_at DESC
 LIMIT $3`, tenantID, integrationID, limit)
	if txErr != nil {
		return nil, txErr
	}
	items, txErr := scanSyncRuns(rows)
	if txErr != nil {
		return nil, txErr
	}
	return items, tx.Commit(ctx)
}

func (r *Repo) ListPostscriptBackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]SMSBackfillTarget, error) {
	return r.listSMSBackfillTargets(ctx, ProviderPostscript, limit, staleBefore)
}

func (r *Repo) ListAttentiveBackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]SMSBackfillTarget, error) {
	return r.listSMSBackfillTargets(ctx, ProviderAttentive, limit, staleBefore)
}

func (r *Repo) ListCRMStaticBackfillTargets(ctx context.Context, provider string, limit int, staleBefore time.Time) ([]CRMStaticBackfillTarget, error) {
	if limit <= 0 {
		limit = 10
	} else if limit > crmStaticBackfillWorkerMaxCandidateScan {
		limit = crmStaticBackfillWorkerMaxCandidateScan
	}
	provider = strings.ToLower(strings.TrimSpace(provider))
	if provider == "" {
		return nil, nil
	}
	now := time.Now().UTC()
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.crm_worker', 'true', true)`); err != nil {
		return nil, err
	}
	out := []CRMStaticBackfillTarget{}
	offset := 0
	for len(out) < limit {
		rows, err := tx.Query(ctx, `
SELECT tenant_id::text, id::text, sync_cursor, last_sync_at, error_message
  FROM crm_integrations
 WHERE provider = $1
   AND status IN ('connected', 'error')
   AND (
        status = 'error'
        OR last_sync_at IS NULL
        OR last_sync_at < $3
   )
 ORDER BY last_sync_at NULLS FIRST, updated_at
 LIMIT $2 OFFSET $4`, provider, crmStaticBackfillWorkerMaxCandidateScan, staleBefore, offset)
		if err != nil {
			return nil, err
		}
		batchCount := 0
		for rows.Next() {
			batchCount++
			var item CRMStaticBackfillTarget
			if err := rows.Scan(&item.TenantID, &item.IntegrationID, &item.Cursor, &item.LastSyncAt, &item.ErrorMessage); err != nil {
				rows.Close()
				return nil, err
			}
			if crmStaticBackfillTargetRetryNotDue(provider, item.Cursor, now) {
				continue
			}
			out = append(out, item)
			if len(out) >= limit {
				break
			}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
		if len(out) >= limit || batchCount < crmStaticBackfillWorkerMaxCandidateScan {
			break
		}
		offset += batchCount
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) listSMSBackfillTargets(ctx context.Context, provider string, limit int, staleBefore time.Time) ([]SMSBackfillTarget, error) {
	if limit <= 0 || limit > 100 {
		limit = 10
	}
	tx, txErr := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if txErr != nil {
		return nil, txErr
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.crm_worker', 'true', true)`); err != nil {
		return nil, err
	}
	rows, txErr := tx.Query(ctx, `
SELECT tenant_id::text, id::text, sync_cursor, last_sync_at, error_message
  FROM crm_integrations
 WHERE provider = $1
   AND status IN ('connected', 'error')
   AND (
        status = 'error'
        OR last_sync_at IS NULL
        OR last_sync_at < $3
   )
 ORDER BY last_sync_at NULLS FIRST, updated_at
	 LIMIT $2`, provider, limit, staleBefore)
	if txErr != nil {
		return nil, txErr
	}
	defer rows.Close()
	out := []SMSBackfillTarget{}
	for rows.Next() {
		var item SMSBackfillTarget
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

func (r *Repo) ClaimWebhook(ctx context.Context, tenantID, integrationID, provider, webhookID, topic string, body []byte) (WebhookClaim, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	sum := sha256.Sum256(body)
	bodyHash := hex.EncodeToString(sum[:])
	tag, err := tx.Exec(ctx, `
INSERT INTO crm_webhook_events (
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
	var status, existingHash string
	if err := tx.QueryRow(ctx, `
SELECT status, body_sha256
  FROM crm_webhook_events
 WHERE tenant_id = $1::uuid
   AND integration_id = $2::uuid
   AND provider = $3
   AND webhook_id = $4`, tenantID, integrationID, provider, webhookID).Scan(&status, &existingHash); err != nil {
		return "", err
	}
	if !strings.EqualFold(strings.TrimSpace(existingHash), bodyHash) {
		return "", ErrCRMWebhookBodyMismatch
	}
	if status == "processed" {
		return WebhookProcessed, tx.Commit(ctx)
	}
	staleAfter := defaultCRMWebhookClaimStaleAfter
	if r.webhookClaimStaleAfter > 0 {
		staleAfter = r.webhookClaimStaleAfter
	}
	tag, err = tx.Exec(ctx, `
UPDATE crm_webhook_events
   SET status = 'in_progress',
       topic = $5,
       body_sha256 = $6,
       attempts = attempts + 1,
       last_error = NULL,
       updated_at = now()
 WHERE tenant_id = $1::uuid
   AND integration_id = $2::uuid
   AND provider = $3
   AND webhook_id = $4
   AND (
       status = 'failed'
       OR (
           status = 'in_progress'
           AND updated_at <= now() - ($7::bigint * interval '1 millisecond')
       )
   )`,
		tenantID,
		integrationID,
		provider,
		webhookID,
		topic,
		bodyHash,
		staleAfter.Milliseconds(),
	)
	if err != nil {
		return "", err
	}
	if tag.RowsAffected() == 1 {
		return WebhookClaimed, tx.Commit(ctx)
	}
	// Another request may have completed while this claimant waited on the row.
	// Re-read the state so an already-processed delivery is acknowledged without
	// forcing an unnecessary provider retry.
	if err := tx.QueryRow(ctx, `
SELECT status
  FROM crm_webhook_events
 WHERE tenant_id = $1::uuid
   AND integration_id = $2::uuid
   AND provider = $3
   AND webhook_id = $4`,
		tenantID, integrationID, provider, webhookID).Scan(&status); err != nil {
		return "", err
	}
	if status == "processed" {
		return WebhookProcessed, tx.Commit(ctx)
	}
	return WebhookInProgress, tx.Commit(ctx)
}

func (r *Repo) MarkWebhookProcessed(ctx context.Context, tenantID, integrationID, provider, webhookID string) error {
	return r.markWebhook(ctx, tenantID, integrationID, provider, webhookID, "processed", "")
}

func (r *Repo) MarkWebhookFailed(ctx context.Context, tenantID, integrationID, provider, webhookID string, err error) error {
	msg := ""
	if err != nil {
		msg = err.Error()
	}
	return r.markWebhook(ctx, tenantID, integrationID, provider, webhookID, "failed", msg)
}

func (r *Repo) markWebhook(ctx context.Context, tenantID, integrationID, provider, webhookID, status, msg string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE crm_webhook_events
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
	if tag.RowsAffected() != 1 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

func (r *Repo) FindSMSIntegrationByWebhookToken(ctx context.Context, provider, token string) (*Integration, error) {
	provider = strings.ToLower(strings.TrimSpace(provider))
	token = strings.TrimSpace(token)
	if token == "" || (provider != ProviderPostscript && provider != ProviderAttentive) {
		return nil, ErrNotFound
	}
	providerKey := provider + "_webhook_route_token"
	tx, txErr := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if txErr != nil {
		return nil, txErr
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.crm_provider', $1, true), set_config('app.crm_webhook_route_token', $2, true)`, provider, token); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
WITH matched AS (
SELECT id::text, tenant_id::text, provider, name, status, scopes,
       credentials_ref, settings, sync_cursor, last_sync_at,
       error_message, created_at, updated_at
  FROM crm_integrations
 WHERE provider = $1
   AND (
       settings->>'webhook_route_token' = $2
       OR settings->>$3 = $2
   )
   AND status IN ('connected', 'active')
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
 LIMIT 1`, provider, token, providerKey)
	out, txErr := scanIntegration(row)
	if errors.Is(txErr, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if txErr != nil {
		return nil, txErr
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) FindCloseIntegrationByWebhookToken(ctx context.Context, token string) (*Integration, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return nil, ErrNotFound
	}
	tx, txErr := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if txErr != nil {
		return nil, txErr
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.crm_provider', $1, true), set_config('app.crm_webhook_route_token', $2, true)`, ProviderClose, token); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
WITH matched AS (
SELECT id::text, tenant_id::text, provider, name, status, scopes,
       credentials_ref, settings, sync_cursor, last_sync_at,
       error_message, created_at, updated_at
  FROM crm_integrations
 WHERE provider = $1
   AND (
       settings->>'webhook_route_token' = $2
       OR settings->>'close_webhook_route_token' = $2
   )
   AND status IN ('connected', 'active')
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
 LIMIT 1`, ProviderClose, token)
	out, txErr := scanIntegration(row)
	if errors.Is(txErr, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if txErr != nil {
		return nil, txErr
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) FindCopperIntegrationByWebhookToken(ctx context.Context, token string) (*Integration, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return nil, ErrNotFound
	}
	tx, txErr := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if txErr != nil {
		return nil, txErr
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.crm_provider', $1, true), set_config('app.crm_webhook_route_token', $2, true)`, ProviderCopper, token); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
WITH matched AS (
SELECT id::text, tenant_id::text, provider, name, status, scopes,
       credentials_ref, settings, sync_cursor, last_sync_at,
       error_message, created_at, updated_at
  FROM crm_integrations
 WHERE provider = $1
   AND (
       settings->>'webhook_route_token' = $2
       OR settings->>'copper_webhook_route_token' = $2
   )
   AND status IN ('connected', 'active')
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
 LIMIT 1`, ProviderCopper, token)
	out, txErr := scanIntegration(row)
	if errors.Is(txErr, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if txErr != nil {
		return nil, txErr
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
UPDATE crm_integrations
   SET status = $3,
       error_message = '',
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2
   AND status <> 'disconnected'
RETURNING id::text, tenant_id::text, provider, name, status, scopes,
       credentials_ref, settings, sync_cursor, last_sync_at,
       error_message, created_at, updated_at`, tenantID, id, status)
	out, err := scanIntegration(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) FindFreshsalesIntegrationByWebhookToken(ctx context.Context, token string) (*Integration, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return nil, ErrNotFound
	}
	tx, txErr := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if txErr != nil {
		return nil, txErr
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.crm_provider', $1, true), set_config('app.crm_webhook_route_token', $2, true)`, ProviderFreshsales, token); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
WITH matched AS (
SELECT id::text, tenant_id::text, provider, name, status, scopes,
       credentials_ref, settings, sync_cursor, last_sync_at,
       error_message, created_at, updated_at
  FROM crm_integrations
 WHERE provider = $1
   AND (
       settings->>'webhook_route_token' = $2
       OR settings->>'freshsales_webhook_route_token' = $2
   )
   AND status IN ('connected', 'active')
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
 LIMIT 1`, ProviderFreshsales, token)
	out, txErr := scanIntegration(row)
	if errors.Is(txErr, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if txErr != nil {
		return nil, txErr
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) FindHighLevelIntegrationByWebhookToken(ctx context.Context, token string) (*Integration, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return nil, ErrNotFound
	}
	tx, txErr := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if txErr != nil {
		return nil, txErr
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.crm_provider', $1, true), set_config('app.crm_webhook_route_token', $2, true)`, ProviderHighLevel, token); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
WITH matched AS (
SELECT id::text, tenant_id::text, provider, name, status, scopes,
       credentials_ref, settings, sync_cursor, last_sync_at,
       error_message, created_at, updated_at
  FROM crm_integrations
 WHERE provider = $1
   AND (
       settings->>'webhook_route_token' = $2
       OR settings->>'highlevel_webhook_route_token' = $2
   )
   AND status IN ('connected', 'active')
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
 LIMIT 1`, ProviderHighLevel, token)
	out, txErr := scanIntegration(row)
	if errors.Is(txErr, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if txErr != nil {
		return nil, txErr
	}
	return out, tx.Commit(ctx)
}

func getIntegrationTx(ctx context.Context, tx pgx.Tx, tenantID, id string) (*Integration, error) {
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, provider, name, status, scopes,
       credentials_ref, settings, sync_cursor, last_sync_at,
       error_message, created_at, updated_at
  FROM crm_integrations
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, id)
	out, err := scanIntegration(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	return out, err
}

func scanIntegration(row pgx.Row) (*Integration, error) {
	var out Integration
	var settingsRaw []byte
	if err := row.Scan(&out.ID, &out.TenantID, &out.Provider, &out.Name, &out.Status,
		&out.Scopes, &out.CredentialsRef, &settingsRaw, &out.SyncCursor,
		&out.LastSyncAt, &out.ErrorMessage, &out.CreatedAt, &out.UpdatedAt); err != nil {
		return nil, err
	}
	out.Settings = map[string]any{}
	_ = json.Unmarshal(settingsRaw, &out.Settings)
	return &out, nil
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

func scanSyncRun(row pgx.Row) (*SyncRun, error) {
	var out SyncRun
	var metadataRaw []byte
	if err := row.Scan(&out.ID, &out.TenantID, &out.IntegrationID, &out.RunMode,
		&out.Status, &out.CursorFrom, &out.CursorTo, &out.ContactsSeen,
		&out.ContactsUpserted, &out.EventsSeen, &out.EventsTracked,
		&out.RowsFailed, &out.ErrorMessage, &metadataRaw, &out.StartedAt,
		&out.CompletedAt, &out.CreatedAt); err != nil {
		return nil, err
	}
	out.Metadata = map[string]any{}
	_ = json.Unmarshal(metadataRaw, &out.Metadata)
	return &out, nil
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

func pipedriveNullableTime(t *time.Time) any {
	if t == nil {
		return nil
	}
	return t.UTC().Format(time.RFC3339)
}
