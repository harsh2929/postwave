// SPDX-License-Identifier: AGPL-3.0-only
package loyalty_integrations

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

var ErrNotFound = errors.New("loyalty_integrations: not found")
var ErrLoyaltyWebhookBodyMismatch = errors.New("loyalty_integrations: webhook body hash mismatch")

var ErrProviderCleanupMissing = errors.New("loyalty_integrations: provider cleanup evidence missing")

// ErrIngestNameConflict is returned when a webhook-ingest provision would collide
// with an existing NON-ingest (pull) integration on (tenant, provider, name) —
// converting it would corrupt its sync model and leave a tokenless endpoint.
var ErrIngestNameConflict = errors.New("loyalty_integrations: name already in use by a non-ingest integration")

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
  FROM loyalty_integrations
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

// FindLoyaltyIntegrationByIngestToken resolves a loyalty integration by its
// public webhook ingest token, before tenant context exists. A SELECT-only RLS
// lookup policy keyed by provider + token allows the pre-tenant resolution; a
// dummy app.tenant_id keeps tenant_isolation from evaluating an unset GUC.
// Ambiguous matches fail closed.
func (r *Repo) FindLoyaltyIntegrationByIngestToken(ctx context.Context, provider, token string) (*Integration, error) {
	provider = strings.ToLower(strings.TrimSpace(provider))
	token = strings.TrimSpace(token)
	if provider == "" || token == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true), set_config('app.loyalty_ingest_provider', $1, true), set_config('app.loyalty_ingest_token', $2, true)`, provider, token); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
WITH matched AS (
SELECT id::text, tenant_id::text, provider, name, status, scopes,
       credentials_ref, settings, sync_cursor, last_sync_at,
       error_message, created_at, updated_at
  FROM loyalty_integrations
 WHERE provider = $1
   AND settings->>'loyalty_ingest_token' = $2
   AND status IN ('connected', 'active', 'paused', 'error')
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
 LIMIT 1`, provider, token)
	out, err := scanIntegration(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// FindSmileIntegrationByAccountID resolves a Smile.io app webhook by the
// account_id included in the signed webhook body before tenant context exists.
// Ambiguous active account mappings fail closed.
func (r *Repo) FindSmileIntegrationByAccountID(ctx context.Context, accountID string) (*Integration, error) {
	accountID = strings.TrimSpace(accountID)
	if accountID == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true), set_config('app.smile_account_id', $1, true)`, accountID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
WITH matched AS (
    SELECT id::text, tenant_id::text, provider, name, status, scopes,
           credentials_ref, settings, sync_cursor, last_sync_at,
           error_message, created_at, updated_at
      FROM loyalty_integrations
     WHERE provider = 'smile'
       AND status IN ('connected', 'active', 'paused', 'error')
       AND (
            settings->>'account_id' = $1
            OR settings->>'smile_account_id' = $1
       )
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
 LIMIT 1`, accountID)
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
INSERT INTO loyalty_integrations (
    tenant_id, provider, name, status, scopes, credentials_ref, settings
) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb)
ON CONFLICT (tenant_id, provider, name) DO UPDATE SET
    status = EXCLUDED.status,
    scopes = EXCLUDED.scopes,
    credentials_ref = EXCLUDED.credentials_ref,
    settings = CASE
        WHEN loyalty_integrations.status = 'disconnected' THEN EXCLUDED.settings
        ELSE (COALESCE(loyalty_integrations.settings, '{}'::jsonb) - 'provider_cleanup') || EXCLUDED.settings
    END,
    sync_cursor = CASE WHEN loyalty_integrations.status = 'disconnected' THEN '' ELSE loyalty_integrations.sync_cursor END,
    last_sync_at = CASE WHEN loyalty_integrations.status = 'disconnected' THEN NULL ELSE loyalty_integrations.last_sync_at END,
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

// ProvisionIngestIntegration persists a webhook-ingest integration for a
// push-only loyalty desk. Unlike UpsertIntegration it requires NO credentials_ref
// — a push-only provider has no outbound credential, only the inbound ingest
// token, which is the pre-tenant routing key resolved by the RLS lookup policy.
func (r *Repo) ProvisionIngestIntegration(ctx context.Context, tenantID string, in IngestProvisionInput, token string) (*Integration, error) {
	provider := strings.ToLower(strings.TrimSpace(in.Provider))
	if provider == "" {
		return nil, fmt.Errorf("provider is required")
	}
	// Curated providers carry richer metadata; any other tool (long-tail bridge
	// entries) gets a tolerant webhook-ingest spec so it is still set-up-able.
	spec, ok := ProviderSpecByKey(provider)
	if !ok {
		spec = ProviderSpec{
			Provider:         provider,
			Name:             provider,
			Category:         "loyalty",
			RuntimeStatus:    "partial",
			SyncModel:        loyaltySyncModelIngest,
			VerificationMode: "custom_webhook_ingest_pending_provider_adapter",
		}
	}
	name := strings.TrimSpace(in.Name)
	if name == "" {
		name = spec.Name + " (webhook ingest)"
	}
	settings := map[string]any{
		loyaltyIngestTokenSetting: token,
		"managed_by_postwave":     true,
		"provider_status":         spec.RuntimeStatus,
		"sync_model":              loyaltySyncModelIngest,
		"verification_mode":       spec.VerificationMode,
		"setup_surface":           "loyalty_integrations",
		"ingest_mode":             "webhook",
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	settingsJSON, _ := json.Marshal(settings)
	row := tx.QueryRow(ctx, `
INSERT INTO loyalty_integrations (
    tenant_id, provider, name, status, scopes, credentials_ref, settings
) VALUES ($1::uuid, $2, $3, 'connected', $4, '', $5::jsonb)
ON CONFLICT (tenant_id, provider, name) DO UPDATE SET
    status = CASE WHEN loyalty_integrations.status = 'disconnected' THEN 'connected' ELSE loyalty_integrations.status END,
    -- Reconnecting a disconnected ingest row ADOPTS the freshly minted token
    -- (disconnect revoked the old one — never resurrect it). A still-live row
    -- conflict is a concurrent re-provision race -> preserve the live token by
    -- subtracting the challenger's. The WHERE below ensures we only ever touch a
    -- row that is already a webhook-ingest endpoint, so a curated pull row sharing
    -- (provider, name) is never silently converted/clobbered.
    settings = loyalty_integrations.settings || (
        CASE WHEN loyalty_integrations.status = 'disconnected'
             THEN EXCLUDED.settings
             ELSE EXCLUDED.settings - 'loyalty_ingest_token' END),
    error_message = '',
    updated_at = now()
WHERE loyalty_integrations.settings->>'loyalty_ingest_token' IS NOT NULL
RETURNING id::text, tenant_id::text, provider, name, status, scopes,
       credentials_ref, settings, sync_cursor, last_sync_at,
       error_message, created_at, updated_at`,
		tenantID, provider, name, []string{}, string(settingsJSON))
	out, err := scanIntegration(row)
	if err != nil {
		// No row returned from an ON CONFLICT means the conflict target was a
		// non-ingest (pull) integration the WHERE refused to convert.
		if errors.Is(err, ErrNotFound) {
			return nil, ErrIngestNameConflict
		}
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// RotateIngestToken issues a fresh ingest token for an existing webhook-ingest
// integration, invalidating the previous public URL. It only matches rows that
// already carry an ingest token, so it cannot inject one into a pull integration.
func (r *Repo) RotateIngestToken(ctx context.Context, tenantID, id, token string) (*Integration, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Rotation never reconnects a deliberately disconnected desk — a
	// disconnected id returns ErrNotFound (404). Re-provision to reconnect.
	row := tx.QueryRow(ctx, `
UPDATE loyalty_integrations
   SET settings = settings || jsonb_build_object('loyalty_ingest_token', $3::text),
       error_message = '',
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2
   AND status != 'disconnected'
   AND settings->>'loyalty_ingest_token' IS NOT NULL
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
UPDATE loyalty_integrations
   SET status = 'disconnected',
       settings = settings || jsonb_build_object('provider_cleanup', $3::jsonb),
       error_message = '',
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, id, string(payload))
	} else {
		tag, err = tx.Exec(ctx, `
UPDATE loyalty_integrations
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
	if !loyaltyProviderCleanupEligible(current.Provider) || current.Status != "disconnected" ||
		current.Settings == nil || current.Settings["provider_cleanup"] == nil {
		return nil, ErrProviderCleanupMissing
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
UPDATE loyalty_integrations
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
INSERT INTO loyalty_sync_runs (
    tenant_id, integration_id, run_mode, status, cursor_from, cursor_to,
    members_seen, members_upserted, events_seen, events_tracked,
    rows_failed, error_message, metadata, started_at, completed_at
) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15)
RETURNING id::text, tenant_id::text, integration_id::text, run_mode, status,
       cursor_from, cursor_to, members_seen, members_upserted,
       events_seen, events_tracked, rows_failed, error_message, metadata,
       started_at, completed_at, created_at`,
		tenantID, integrationID, req.RunMode, status, current.SyncCursor, cursor,
		summary.MembersSeen, summary.MembersUpserted, summary.EventsSeen,
		summary.EventsTracked, summary.RowsFailed, summary.ErrorMessage,
		string(metadata), started, completed)
	run, err := scanSyncRun(row)
	if err != nil {
		return nil, err
	}
	integrationStatus := "connected"
	if status == "failed" {
		integrationStatus = "error"
	} else if current.Status == "paused" {
		integrationStatus = "paused"
	} else if loyaltyIntegrationDisconnected(current) {
		integrationStatus = "disconnected"
	}
	if _, err := tx.Exec(ctx, `
UPDATE loyalty_integrations
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
       cursor_from, cursor_to, members_seen, members_upserted,
       events_seen, events_tracked, rows_failed, error_message, metadata,
       started_at, completed_at, created_at
  FROM loyalty_sync_runs
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

func (r *Repo) ClaimLoyaltyWebhook(ctx context.Context, tenantID, integrationID, provider, webhookID, topic string, body []byte) (WebhookClaim, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	sum := sha256.Sum256(body)
	bodyHash := hex.EncodeToString(sum[:])
	tag, err := tx.Exec(ctx, `
	INSERT INTO loyalty_webhook_events (
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
	  FROM loyalty_webhook_events
	 WHERE tenant_id = $1::uuid
	   AND integration_id = $2::uuid
	   AND provider = $3
	   AND webhook_id = $4`, tenantID, integrationID, provider, webhookID).Scan(&status, &storedBodyHash); err != nil {
		return "", err
	}
	if storedBodyHash != bodyHash {
		return "", fmt.Errorf("%w: delivery %q", ErrLoyaltyWebhookBodyMismatch, webhookID)
	}
	switch status {
	case "processed":
		return WebhookProcessed, tx.Commit(ctx)
	case "failed":
		if _, err := tx.Exec(ctx, `
	UPDATE loyalty_webhook_events
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

func (r *Repo) MarkLoyaltyWebhookProcessed(ctx context.Context, tenantID, integrationID, provider, webhookID string) error {
	return r.markLoyaltyWebhook(ctx, tenantID, integrationID, provider, webhookID, "processed", "")
}

func (r *Repo) MarkLoyaltyWebhookFailed(ctx context.Context, tenantID, integrationID, provider, webhookID string, err error) error {
	msg := ""
	if err != nil {
		msg = err.Error()
	}
	return r.markLoyaltyWebhook(ctx, tenantID, integrationID, provider, webhookID, "failed", msg)
}

func (r *Repo) markLoyaltyWebhook(ctx context.Context, tenantID, integrationID, provider, webhookID, status, msg string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
	UPDATE loyalty_webhook_events
	   SET status = $3,
	       last_error = NULLIF($4, ''),
	       processed_at = CASE WHEN $3 = 'processed' THEN now() ELSE processed_at END,
	       updated_at = now()
	 WHERE tenant_id = $1::uuid
	   AND integration_id = $2::uuid
	   AND provider = $5
	   AND webhook_id = $6`, tenantID, integrationID, status, msg, provider, webhookID)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *Repo) ListSmileBackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]SmileBackfillTarget, error) {
	targets, err := r.ListLoyaltyBackfillTargets(ctx, ProviderSmile, limit, staleBefore)
	if err != nil {
		return nil, err
	}
	out := make([]SmileBackfillTarget, 0, len(targets))
	for _, item := range targets {
		out = append(out, SmileBackfillTarget{
			TenantID:      item.TenantID,
			IntegrationID: item.IntegrationID,
			Cursor:        item.Cursor,
			LastSyncAt:    item.LastSyncAt,
			ErrorMessage:  item.ErrorMessage,
		})
	}
	return out, nil
}

func (r *Repo) ListLoyaltyBackfillTargets(ctx context.Context, provider string, limit int, staleBefore time.Time) ([]LoyaltyBackfillTarget, error) {
	if limit <= 0 {
		limit = 10
	} else if limit > loyaltyBackfillWorkerMaxCandidateScan {
		limit = loyaltyBackfillWorkerMaxCandidateScan
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
	if _, err := tx.Exec(ctx, `SELECT set_config('app.loyalty_worker', 'true', true)`); err != nil {
		return nil, err
	}
	out := []LoyaltyBackfillTarget{}
	offset := 0
	for len(out) < limit {
		rows, err := tx.Query(ctx, `
SELECT tenant_id::text, id::text, sync_cursor, last_sync_at, error_message
  FROM loyalty_integrations
 WHERE provider = $1
   AND status IN ('connected', 'active', 'error')
   AND (
        status = 'error'
        OR last_sync_at IS NULL
        OR last_sync_at < $3
   )
 ORDER BY last_sync_at NULLS FIRST, updated_at
 LIMIT $2 OFFSET $4`, provider, loyaltyBackfillWorkerMaxCandidateScan, staleBefore, offset)
		if err != nil {
			return nil, err
		}
		batchCount := 0
		for rows.Next() {
			batchCount++
			var item LoyaltyBackfillTarget
			if err := rows.Scan(&item.TenantID, &item.IntegrationID, &item.Cursor, &item.LastSyncAt, &item.ErrorMessage); err != nil {
				rows.Close()
				return nil, err
			}
			if loyaltyBackfillTargetRetryNotDue(provider, item.Cursor, now) {
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
		if len(out) >= limit || batchCount < loyaltyBackfillWorkerMaxCandidateScan {
			break
		}
		offset += batchCount
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
UPDATE loyalty_integrations
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
  FROM loyalty_integrations
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
		&item.MembersSeen,
		&item.MembersUpserted,
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
