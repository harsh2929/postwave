// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

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

var ErrNotFound = errors.New("support_integrations: not found")

// ErrSupportRuntimeHeld is returned by every archived pre-tenant support
// integration lookup. The public provider runtime is release-held, and the
// caller-set lookup policies that once authorized these queries were removed
// by migration 1993. Keeping one typed error at the repository boundary makes
// an accidental direct handler wiring fail before a connection is acquired.
var ErrSupportRuntimeHeld = errors.New("support_integrations: runtime release held")

func enforceSupportRuntimeReleaseHold() error {
	return ErrSupportRuntimeHeld
}

// ErrIngestNameConflict is returned when a webhook-ingest provision would collide
// with an existing NON-ingest (pull) integration on (tenant, provider, name).
var ErrIngestNameConflict = errors.New("support_integrations: name already in use by a non-ingest integration")

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
  FROM support_integrations
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

func (r *Repo) ListIntegrationProjections(ctx context.Context, tenantID string, snapshotAt, cursorAt time.Time, cursorID string, limit int) ([]IntegrationProjection, error) {
	if limit < 1 || limit > 101 {
		return nil, errors.New("support_integrations: projection page limit invalid")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, provider, name, status,
       credentials_ref <> '', created_at, updated_at
  FROM support_integrations
 WHERE tenant_id=$1::uuid
   AND updated_at <= $2::timestamptz
   AND (NOT $3::boolean OR (updated_at,id) < ($4::timestamptz,$5::uuid))
 ORDER BY updated_at DESC,id DESC
 LIMIT $6`, tenantID, snapshotAt, !cursorAt.IsZero(), cursorAt, nullableProjectionUUID(cursorID), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]IntegrationProjection, 0, limit)
	for rows.Next() {
		var item IntegrationProjection
		if err = rows.Scan(&item.ID, &item.TenantID, &item.Provider, &item.Name, &item.Status,
			&item.CredentialConfigured, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	return items, tx.Commit(ctx)
}

func (r *Repo) GetIntegrationProjection(ctx context.Context, tenantID, id string) (*IntegrationProjection, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var item IntegrationProjection
	err = tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, provider, name, status,
       credentials_ref <> '', created_at, updated_at
  FROM support_integrations
 WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, id).Scan(
		&item.ID, &item.TenantID, &item.Provider, &item.Name, &item.Status,
		&item.CredentialConfigured, &item.CreatedAt, &item.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &item, tx.Commit(ctx)
}

func nullableProjectionUUID(id string) any {
	if strings.TrimSpace(id) == "" {
		return nil
	}
	return id
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
INSERT INTO support_integrations (
    tenant_id, provider, name, status, scopes, credentials_ref, settings
) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb)
ON CONFLICT (tenant_id, provider, name) DO UPDATE SET
    status = EXCLUDED.status,
    scopes = EXCLUDED.scopes,
    credentials_ref = EXCLUDED.credentials_ref,
    settings = CASE
        WHEN support_integrations.status = 'disconnected' THEN EXCLUDED.settings
        ELSE (COALESCE(support_integrations.settings, '{}'::jsonb) - 'provider_cleanup') || EXCLUDED.settings
    END,
    sync_cursor = CASE WHEN support_integrations.status = 'disconnected' THEN '' ELSE support_integrations.sync_cursor END,
    last_sync_at = CASE WHEN support_integrations.status = 'disconnected' THEN NULL ELSE support_integrations.last_sync_at END,
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
// push-only support desk. Unlike UpsertIntegration it requires NO credentials_ref
// — a push-only desk has no outbound credential, only the historical inbound
// ingest token. That token cannot currently be resolved: all public support
// provider ingress and its pre-tenant repository lookups are release-held.
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
			Category:         "customer_service",
			RuntimeStatus:    "partial",
			SyncModel:        supportSyncModelIngest,
			VerificationMode: "custom_webhook_ingest_pending_provider_adapter",
		}
	}
	name := strings.TrimSpace(in.Name)
	if name == "" {
		name = spec.Name + " (webhook ingest)"
	}
	settings := map[string]any{
		supportIngestTokenSetting: token,
		"managed_by_postwave":     true,
		"provider_status":         spec.RuntimeStatus,
		"sync_model":              supportSyncModelIngest,
		"verification_mode":       spec.VerificationMode,
		"setup_surface":           "support_integrations",
		"ingest_mode":             "webhook",
	}
	if ref := strings.TrimSpace(in.WebhookSecretRef); ref != "" {
		settings["webhook_secret_ref"] = ref
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	settingsJSON, _ := json.Marshal(settings)
	row := tx.QueryRow(ctx, `
INSERT INTO support_integrations (
    tenant_id, provider, name, status, scopes, credentials_ref, settings
) VALUES ($1::uuid, $2, $3, 'connected', $4, '', $5::jsonb)
ON CONFLICT (tenant_id, provider, name) DO UPDATE SET
    status = CASE WHEN support_integrations.status = 'disconnected' THEN 'connected' ELSE support_integrations.status END,
    -- Reconnecting a disconnected ingest row ADOPTS the freshly minted token
    -- (disconnect revoked the old one — never resurrect it). A still-live row
    -- conflict is a concurrent re-provision race -> preserve the live token by
    -- subtracting the challenger's. The WHERE below ensures we only ever touch a
    -- row that is already a webhook-ingest endpoint, so a curated pull row sharing
    -- (provider, name) is never silently converted/clobbered.
    settings = (COALESCE(support_integrations.settings, '{}'::jsonb) - 'provider_cleanup') || (
        CASE WHEN support_integrations.status = 'disconnected'
             THEN EXCLUDED.settings
             ELSE EXCLUDED.settings - 'support_ingest_token' END),
    error_message = '',
    updated_at = now()
WHERE support_integrations.settings->>'support_ingest_token' IS NOT NULL
RETURNING id::text, tenant_id::text, provider, name, status, scopes,
       credentials_ref, settings, sync_cursor, last_sync_at,
       error_message, created_at, updated_at`,
		tenantID, provider, name, []string{}, string(settingsJSON))
	out, err := scanIntegration(row)
	if err != nil {
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
UPDATE support_integrations
   SET settings = settings || jsonb_build_object('support_ingest_token', $3::text),
       error_message = '',
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2
   AND status != 'disconnected'
   AND settings->>'support_ingest_token' IS NOT NULL
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
UPDATE support_integrations
   SET status = 'disconnected',
       settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('provider_cleanup', $3::jsonb),
       error_message = '',
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, id, string(payload))
	} else {
		tag, err = tx.Exec(ctx, `
UPDATE support_integrations
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
INSERT INTO support_sync_runs (
    tenant_id, integration_id, run_mode, status, cursor_from, cursor_to,
    tickets_seen, tickets_upserted, messages_seen, messages_upserted,
    profiles_upserted, events_seen, events_tracked, rows_failed,
    error_message, metadata, started_at, completed_at
) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17, $18)
RETURNING id::text, tenant_id::text, integration_id::text, run_mode, status,
       cursor_from, cursor_to, tickets_seen, tickets_upserted,
       messages_seen, messages_upserted, profiles_upserted, events_seen,
       events_tracked, rows_failed, error_message, metadata,
       started_at, completed_at, created_at`,
		tenantID, integrationID, req.RunMode, status, current.SyncCursor, cursor,
		summary.TicketsSeen, summary.TicketsUpserted,
		summary.MessagesSeen, summary.MessagesUpserted, summary.ProfilesUpserted,
		summary.EventsSeen, summary.EventsTracked, summary.RowsFailed,
		summary.ErrorMessage, string(metadata), started, completed)
	run, err := scanSyncRun(row)
	if err != nil {
		return nil, err
	}
	integrationStatus := "connected"
	if status == "failed" {
		integrationStatus = "error"
	} else if current.Status == "paused" {
		integrationStatus = "paused"
	} else if supportIntegrationDisconnected(current) {
		integrationStatus = "disconnected"
	}
	if _, err := tx.Exec(ctx, `
UPDATE support_integrations
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
	if limit <= 0 || limit > 101 {
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
       cursor_from, cursor_to, tickets_seen, tickets_upserted,
       messages_seen, messages_upserted, profiles_upserted, events_seen,
       events_tracked, rows_failed, error_message, metadata,
       started_at, completed_at, created_at
  FROM support_sync_runs
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

func (r *Repo) ClaimSupportWebhook(ctx context.Context, tenantID, integrationID, provider, webhookID, topic string, body []byte) (WebhookClaim, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	sum := sha256.Sum256(body)
	bodyHash := hex.EncodeToString(sum[:])
	tag, err := tx.Exec(ctx, `
INSERT INTO support_webhook_events (
    tenant_id, integration_id, provider, webhook_id, topic, body_sha256, status, attempts
) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, 'in_progress', 1)
ON CONFLICT (provider, webhook_id) DO NOTHING`,
		tenantID, integrationID, provider, webhookID, topic, bodyHash)
	if err != nil {
		return "", err
	}
	if tag.RowsAffected() == 1 {
		return WebhookClaimed, tx.Commit(ctx)
	}
	var status string
	if err := tx.QueryRow(ctx, `
SELECT status
  FROM support_webhook_events
 WHERE provider = $1 AND webhook_id = $2`, provider, webhookID).Scan(&status); err != nil {
		return "", err
	}
	switch status {
	case "processed":
		return WebhookProcessed, tx.Commit(ctx)
	case "failed":
		if _, err := tx.Exec(ctx, `
UPDATE support_webhook_events
   SET status = 'in_progress',
       topic = $3,
       body_sha256 = $4,
       attempts = attempts + 1,
       last_error = NULL,
       updated_at = now()
 WHERE provider = $1 AND webhook_id = $2`, provider, webhookID, topic, bodyHash); err != nil {
			return "", err
		}
		return WebhookClaimed, tx.Commit(ctx)
	default:
		return WebhookInProgress, tx.Commit(ctx)
	}
}

func (r *Repo) MarkSupportWebhookProcessed(ctx context.Context, tenantID, provider, webhookID string) error {
	return r.markSupportWebhook(ctx, tenantID, provider, webhookID, "processed", "")
}

func (r *Repo) MarkSupportWebhookFailed(ctx context.Context, tenantID, provider, webhookID string, err error) error {
	msg := ""
	if err != nil {
		msg = err.Error()
	}
	return r.markSupportWebhook(ctx, tenantID, provider, webhookID, "failed", msg)
}

func (r *Repo) markSupportWebhook(ctx context.Context, tenantID, provider, webhookID, status, msg string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
UPDATE support_webhook_events
   SET status = $3,
       last_error = NULLIF($4, ''),
       processed_at = CASE WHEN $3 = 'processed' THEN now() ELSE processed_at END,
       updated_at = now()
 WHERE provider = $1 AND webhook_id = $2`, provider, webhookID, status, msg)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *Repo) ListZendeskBackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]SupportBackfillTarget, error) {
	return r.listSupportBackfillTargets(ctx, ProviderZendesk, limit, staleBefore)
}

func (r *Repo) ListIntercomBackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]SupportBackfillTarget, error) {
	return r.listSupportBackfillTargets(ctx, ProviderIntercom, limit, staleBefore)
}

func (r *Repo) ListHelpScoutBackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]SupportBackfillTarget, error) {
	return r.listSupportBackfillTargets(ctx, ProviderHelpScout, limit, staleBefore)
}

func (r *Repo) ListGorgiasBackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]SupportBackfillTarget, error) {
	return r.listSupportBackfillTargets(ctx, ProviderGorgias, limit, staleBefore)
}

func (r *Repo) ListFreshdeskBackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]SupportBackfillTarget, error) {
	return r.listSupportBackfillTargets(ctx, ProviderFreshdesk, limit, staleBefore)
}

func (r *Repo) ListSupportBackfillTargets(ctx context.Context, provider string, limit int, staleBefore time.Time) ([]SupportBackfillTarget, error) {
	return r.listSupportBackfillTargets(ctx, provider, limit, staleBefore)
}

func (r *Repo) listSupportBackfillTargets(ctx context.Context, provider string, limit int, staleBefore time.Time) ([]SupportBackfillTarget, error) {
	if limit <= 0 {
		limit = 10
	} else if limit > supportBackfillWorkerMaxCandidateScan {
		limit = supportBackfillWorkerMaxCandidateScan
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.support_worker', 'true', true)`); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT tenant_id::text, id::text, sync_cursor, last_sync_at, error_message
  FROM support_integrations
 WHERE provider = $2
   AND status IN ('connected', 'active', 'error')
   AND (
        status = 'error'
        OR last_sync_at IS NULL
        OR last_sync_at < $3
   )
 ORDER BY last_sync_at NULLS FIRST, updated_at
 LIMIT $1`, limit, provider, staleBefore)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SupportBackfillTarget{}
	for rows.Next() {
		var item SupportBackfillTarget
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
UPDATE support_integrations
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
  FROM support_integrations
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
		&item.TicketsSeen,
		&item.TicketsUpserted,
		&item.MessagesSeen,
		&item.MessagesUpserted,
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
