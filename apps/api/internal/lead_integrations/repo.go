// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
)

var (
	ErrNotFound                = errors.New("lead_integrations: not found")
	errIntegrationDisconnected = errors.New("lead integration is disconnected")
)

func leadIntegrationDisconnected(integration *Integration) bool {
	return integration != nil && strings.EqualFold(strings.TrimSpace(integration.Status), "disconnected")
}

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
  FROM lead_integrations
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
	provider = strings.ToLower(strings.TrimSpace(provider))
	name = strings.TrimSpace(name)
	if tenantID == "" || provider == "" || name == "" {
		return nil, ErrNotFound
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, provider, name, status, scopes,
       credentials_ref, settings, sync_cursor, last_sync_at,
       error_message, created_at, updated_at
  FROM lead_integrations
 WHERE tenant_id = $1::uuid
   AND provider = $2
   AND name = $3
 ORDER BY updated_at DESC
 LIMIT 1`, tenantID, provider, name)
	item, err := scanIntegration(row)
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
INSERT INTO lead_integrations (
    tenant_id, provider, name, status, scopes, credentials_ref, settings
) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb)
ON CONFLICT (tenant_id, provider, name) DO UPDATE SET
    status = EXCLUDED.status,
    scopes = EXCLUDED.scopes,
    credentials_ref = EXCLUDED.credentials_ref,
    settings = (COALESCE(lead_integrations.settings, '{}'::jsonb) - 'provider_cleanup') || EXCLUDED.settings,
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
UPDATE lead_integrations
   SET status = 'disconnected',
       settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('provider_cleanup', $3::jsonb),
       error_message = '',
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, id, string(payload))
	} else {
		tag, err = tx.Exec(ctx, `
UPDATE lead_integrations
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
INSERT INTO lead_sync_runs (
    tenant_id, integration_id, run_mode, status, cursor_from, cursor_to,
    submissions_seen, subscribers_upserted, events_tracked, rows_failed,
    error_message, metadata, started_at, completed_at
) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14)
RETURNING id::text, tenant_id::text, integration_id::text, run_mode, status,
       cursor_from, cursor_to, submissions_seen, subscribers_upserted,
       events_tracked, rows_failed, error_message, metadata,
       started_at, completed_at, created_at`,
		tenantID, integrationID, req.RunMode, status, current.SyncCursor, cursor,
		summary.SubmissionsSeen, summary.SubscribersUpserted, summary.EventsTracked,
		summary.RowsFailed, summary.ErrorMessage, string(metadata), started, completed)
	run, err := scanSyncRun(row)
	if err != nil {
		return nil, err
	}
	integrationStatus := "connected"
	if status == "failed" {
		integrationStatus = "error"
	} else if current.Status == "paused" {
		integrationStatus = "paused"
	} else if current.Status == "disconnected" {
		integrationStatus = "disconnected"
	}
	if _, err := tx.Exec(ctx, `
UPDATE lead_integrations
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
       cursor_from, cursor_to, submissions_seen, subscribers_upserted,
       events_tracked, rows_failed, error_message, metadata,
       started_at, completed_at, created_at
  FROM lead_sync_runs
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

func (r *Repo) ClaimWebhook(ctx context.Context, tenantID, integrationID, provider, webhookID, topic string, body []byte) (WebhookClaim, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	sum := sha256.Sum256(body)
	bodyHash := hex.EncodeToString(sum[:])
	tag, err := tx.Exec(ctx, `
INSERT INTO lead_webhook_events (
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
  FROM lead_webhook_events
 WHERE provider = $1 AND webhook_id = $2`, provider, webhookID).Scan(&status); err != nil {
		return "", err
	}
	switch status {
	case "processed":
		return WebhookProcessed, tx.Commit(ctx)
	case "failed":
		if _, err := tx.Exec(ctx, `
UPDATE lead_webhook_events
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

func (r *Repo) MarkWebhookProcessed(ctx context.Context, tenantID, provider, webhookID string) error {
	return r.markWebhook(ctx, tenantID, provider, webhookID, "processed", "")
}

func (r *Repo) MarkWebhookFailed(ctx context.Context, tenantID, provider, webhookID string, err error) error {
	msg := ""
	if err != nil {
		msg = err.Error()
	}
	return r.markWebhook(ctx, tenantID, provider, webhookID, "failed", msg)
}

func (r *Repo) markWebhook(ctx context.Context, tenantID, provider, webhookID, status, msg string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
UPDATE lead_webhook_events
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

func (r *Repo) FindIntegrationByProviderFormID(ctx context.Context, provider, formID string) (*Integration, error) {
	provider = strings.ToLower(strings.TrimSpace(provider))
	formID = strings.TrimSpace(formID)
	if provider == "" || formID == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.lead_provider', $1, true), set_config('app.lead_form_id', $2, true)`, provider, formID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, provider, name, status, scopes,
       credentials_ref, settings, sync_cursor, last_sync_at,
       error_message, created_at, updated_at
  FROM lead_integrations
 WHERE provider = $1
   AND status = 'connected'
   AND (
        lower(COALESCE(settings->>'form_id', '')) = lower($2)
     OR lower(COALESCE(settings->>'typeform_form_id', '')) = lower($2)
     OR lower(COALESCE(settings->>'provider_form_id', '')) = lower($2)
   )
 ORDER BY updated_at DESC
 LIMIT 1`, provider, formID)
	item, err := scanIntegration(row)
	if err != nil {
		return nil, err
	}
	return item, tx.Commit(ctx)
}

func (r *Repo) FindFacebookLeadAdsIntegrationByPageAndForm(ctx context.Context, pageID, formID string) (*Integration, error) {
	pageID = strings.TrimSpace(pageID)
	formID = strings.TrimSpace(formID)
	if pageID == "" || formID == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
SELECT set_config('app.lead_provider', $1, true),
       set_config('app.lead_page_id', $2, true),
       set_config('app.lead_form_id', $3, true)`, ProviderFacebookLeadAds, pageID, formID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, provider, name, status, scopes,
       credentials_ref, settings, sync_cursor, last_sync_at,
       error_message, created_at, updated_at
  FROM lead_integrations
 WHERE provider = $1
   AND status IN ('connected', 'error', 'needs_auth')
   AND lower(COALESCE(settings->>'page_id', '')) = lower($2)
   AND lower(COALESCE(settings->>'form_id', '')) = lower($3)
 ORDER BY updated_at DESC
 LIMIT 1`, ProviderFacebookLeadAds, pageID, formID)
	item, err := scanIntegration(row)
	if err != nil {
		return nil, err
	}
	return item, tx.Commit(ctx)
}

func (r *Repo) FindIntegrationByProviderInstanceID(ctx context.Context, provider, instanceID string) (*Integration, error) {
	provider = strings.ToLower(strings.TrimSpace(provider))
	instanceID = strings.TrimSpace(instanceID)
	if provider == "" || instanceID == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.lead_provider', $1, true), set_config('app.lead_instance_id', $2, true)`, provider, instanceID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, provider, name, status, scopes,
       credentials_ref, settings, sync_cursor, last_sync_at,
       error_message, created_at, updated_at
  FROM lead_integrations
	 WHERE provider = $1
	   AND status IN ('connected', 'error', 'needs_auth')
	   AND (
	        lower(COALESCE(settings->>'instance_id', '')) = lower($2)
	     OR lower(COALESCE(settings->>'wix_instance_id', '')) = lower($2)
	     OR lower(COALESCE(settings->>'provider_instance_id', '')) = lower($2)
   )
 ORDER BY updated_at DESC
 LIMIT 1`, provider, instanceID)
	item, err := scanIntegration(row)
	if err != nil {
		return nil, err
	}
	return item, tx.Commit(ctx)
}

func (r *Repo) FindIntegrationByProviderSiteID(ctx context.Context, provider, siteID string) (*Integration, error) {
	provider = strings.ToLower(strings.TrimSpace(provider))
	siteID = strings.TrimSpace(siteID)
	if provider == "" || siteID == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.lead_provider', $1, true), set_config('app.lead_site_id', $2, true)`, provider, siteID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, provider, name, status, scopes,
       credentials_ref, settings, sync_cursor, last_sync_at,
       error_message, created_at, updated_at
  FROM lead_integrations
	 WHERE provider = $1
	   AND status IN ('connected', 'error', 'needs_auth')
	   AND (
	        lower(COALESCE(settings->>'site_id', '')) = lower($2)
	     OR lower(COALESCE(settings->>'wix_site_id', '')) = lower($2)
	     OR lower(COALESCE(settings->>'webflow_site_id', '')) = lower($2)
	     OR lower(COALESCE(settings->>'provider_site_id', '')) = lower($2)
	     OR lower(rtrim(COALESCE(settings->>'site_url', ''), '/')) = lower(rtrim($2, '/'))
	     OR lower(rtrim(COALESCE(settings->>'wordpress_site_url', ''), '/')) = lower(rtrim($2, '/'))
	     OR lower(rtrim(COALESCE(settings->>'provider_site_url', ''), '/')) = lower(rtrim($2, '/'))
	   )
 ORDER BY updated_at DESC
 LIMIT 1`, provider, siteID)
	item, err := scanIntegration(row)
	if err != nil {
		return nil, err
	}
	return item, tx.Commit(ctx)
}

func (r *Repo) FindIntegrationByProviderSiteAndForm(ctx context.Context, provider, siteID, formID, formElementID string) (*Integration, error) {
	provider = strings.ToLower(strings.TrimSpace(provider))
	siteID = strings.TrimSpace(siteID)
	formID = strings.TrimSpace(formID)
	formElementID = strings.TrimSpace(formElementID)
	if provider == "" || siteID == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
SELECT set_config('app.lead_provider', $1, true),
       set_config('app.lead_site_id', $2, true),
       set_config('app.lead_form_id', $3, true),
       set_config('app.lead_form_element_id', $4, true)`, provider, siteID, formID, formElementID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
WITH candidates AS (
	SELECT id::text, tenant_id::text, provider, name, status, scopes,
	       credentials_ref, settings, sync_cursor, last_sync_at,
	       error_message, created_at, updated_at,
	       lower(COALESCE(
	           NULLIF(btrim(settings->>'form_id'), ''),
	           NULLIF(btrim(settings->>'webflow_form_id'), ''),
	           NULLIF(btrim(settings->>'provider_form_id'), ''),
	           NULLIF(btrim(settings->>'campaign_id'), ''),
	           NULLIF(btrim(settings->>'campaign'), ''),
	           NULLIF(btrim(settings->>'provider_campaign_id'), ''),
	           NULLIF(btrim(settings->>'bar_id'), ''),
	           NULLIF(btrim(settings->>'hello_bar_id'), ''),
	           ''
	       )) AS form_filter,
	       lower(COALESCE(
	           NULLIF(btrim(settings->>'form_element_id'), ''),
	           NULLIF(btrim(settings->>'element_id'), ''),
	           NULLIF(btrim(settings->>'webflow_form_element_id'), ''),
	           NULLIF(btrim(settings->>'provider_form_element_id'), ''),
	           ''
	       )) AS element_filter
	  FROM lead_integrations
	 WHERE provider = $1
	   AND status IN ('connected', 'error', 'needs_auth')
	   AND (
	        lower(COALESCE(settings->>'site_id', '')) = lower($2)
	     OR lower(COALESCE(settings->>'wix_site_id', '')) = lower($2)
	     OR lower(COALESCE(settings->>'webflow_site_id', '')) = lower($2)
	     OR lower(COALESCE(settings->>'provider_site_id', '')) = lower($2)
	     OR lower(rtrim(COALESCE(settings->>'site_url', ''), '/')) = lower(rtrim($2, '/'))
	     OR lower(rtrim(COALESCE(settings->>'wordpress_site_url', ''), '/')) = lower(rtrim($2, '/'))
	     OR lower(rtrim(COALESCE(settings->>'provider_site_url', ''), '/')) = lower(rtrim($2, '/'))
	   )
)
SELECT id, tenant_id, provider, name, status, scopes,
       credentials_ref, settings, sync_cursor, last_sync_at,
       error_message, created_at, updated_at
  FROM candidates
 WHERE (form_filter = '' OR ($3 <> '' AND form_filter = lower($3)))
   AND (element_filter = '' OR ($4 <> '' AND element_filter = lower($4)))
 ORDER BY
       (CASE WHEN form_filter <> '' THEN 2 ELSE 0 END +
        CASE WHEN element_filter <> '' THEN 1 ELSE 0 END) DESC,
       updated_at DESC
 LIMIT 1`, provider, siteID, formID, formElementID)
	item, err := scanIntegration(row)
	if err != nil {
		return nil, err
	}
	return item, tx.Commit(ctx)
}

func (r *Repo) FindIntegrationByProviderAccountAndCampaign(ctx context.Context, provider, accountID, campaignID string) (*Integration, error) {
	provider = strings.ToLower(strings.TrimSpace(provider))
	accountID = strings.TrimSpace(accountID)
	campaignID = strings.TrimSpace(campaignID)
	if provider == "" || accountID == "" || campaignID == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
SELECT set_config('app.lead_provider', $1, true),
       set_config('app.lead_account_id', $2, true),
       set_config('app.lead_campaign_id', $3, true)`, provider, accountID, campaignID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, provider, name, status, scopes,
       credentials_ref, settings, sync_cursor, last_sync_at,
       error_message, created_at, updated_at
  FROM lead_integrations
 WHERE provider = $1
   AND status IN ('connected', 'error', 'needs_auth')
   AND lower(COALESCE(settings->>'account_id', settings->>'provider_account_id', '')) = lower($2)
   AND lower($3) IN (
       lower(COALESCE(settings->>'campaign_id', '')),
       lower(COALESCE(settings->>'campaign', '')),
       lower(COALESCE(settings->>'provider_campaign_id', '')),
       lower(COALESCE(settings->>'popup_id', '')),
       lower(COALESCE(settings->>'poptin_id', '')),
       lower(COALESCE(settings->>'page_id', '')),
       lower(COALESCE(settings->>'landing_page_id', '')),
       lower(COALESCE(settings->>'landingi_page_id', '')),
       lower(COALESCE(settings->>'outgrow_campaign_id', '')),
       lower(COALESCE(settings->>'content_id', '')),
       lower(COALESCE(settings->>'calculator_id', '')),
       lower(COALESCE(settings->>'quiz_id', '')),
       lower(COALESCE(settings->>'riddle_id', '')),
       lower(COALESCE(settings->>'experience_id', ''))
   )
 ORDER BY updated_at DESC
 LIMIT 1`, provider, accountID, campaignID)
	item, err := scanIntegration(row)
	if err != nil {
		return nil, err
	}
	return item, tx.Commit(ctx)
}

func (r *Repo) ListTypeformBackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]TypeformBackfillTarget, error) {
	if limit <= 0 || limit > 100 {
		limit = 10
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.lead_worker', 'true', true)`); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT tenant_id::text, id::text, sync_cursor, last_sync_at, error_message
  FROM lead_integrations
 WHERE provider = 'typeform'
   AND status IN ('connected', 'error')
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
	out := []TypeformBackfillTarget{}
	for rows.Next() {
		var item TypeformBackfillTarget
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

func (r *Repo) ListSurveyMonkeyBackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]SurveyMonkeyBackfillTarget, error) {
	if limit <= 0 || limit > 100 {
		limit = 10
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.lead_worker', 'true', true)`); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT tenant_id::text, id::text, sync_cursor, last_sync_at, error_message
  FROM lead_integrations
 WHERE provider = 'surveymonkey'
   AND status IN ('connected', 'error')
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
	out := []SurveyMonkeyBackfillTarget{}
	for rows.Next() {
		var item SurveyMonkeyBackfillTarget
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

func (r *Repo) ListUnbounceBackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]UnbounceBackfillTarget, error) {
	if limit <= 0 || limit > 100 {
		limit = 10
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.lead_worker', 'true', true)`); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT tenant_id::text, id::text, sync_cursor, last_sync_at, error_message
  FROM lead_integrations
 WHERE provider = 'unbounce'
   AND status IN ('connected', 'error')
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
	out := []UnbounceBackfillTarget{}
	for rows.Next() {
		var item UnbounceBackfillTarget
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

func (r *Repo) ListInstapageBackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]InstapageBackfillTarget, error) {
	if limit <= 0 || limit > 100 {
		limit = 10
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.lead_worker', 'true', true)`); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT tenant_id::text, id::text, sync_cursor, last_sync_at, error_message
  FROM lead_integrations
 WHERE provider = 'instapage'
   AND status IN ('connected', 'error')
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
	out := []InstapageBackfillTarget{}
	for rows.Next() {
		var item InstapageBackfillTarget
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

func (r *Repo) ListJotformBackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]JotformBackfillTarget, error) {
	if limit <= 0 || limit > 100 {
		limit = 10
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.lead_worker', 'true', true)`); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT tenant_id::text, id::text, sync_cursor, last_sync_at, error_message
  FROM lead_integrations
 WHERE provider = 'jotform'
   AND status IN ('connected', 'error')
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
	out := []JotformBackfillTarget{}
	for rows.Next() {
		var item JotformBackfillTarget
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

func (r *Repo) ListWebflowBackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]WebflowBackfillTarget, error) {
	if limit <= 0 || limit > 100 {
		limit = 10
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.lead_worker', 'true', true)`); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT tenant_id::text, id::text, sync_cursor, last_sync_at, error_message
  FROM lead_integrations
 WHERE provider = 'webflow'
   AND status IN ('connected', 'error')
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
	out := []WebflowBackfillTarget{}
	for rows.Next() {
		var item WebflowBackfillTarget
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

func (r *Repo) ListFilloutBackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]FilloutBackfillTarget, error) {
	if limit <= 0 || limit > 100 {
		limit = 10
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.lead_worker', 'true', true)`); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT tenant_id::text, id::text, sync_cursor, last_sync_at, error_message
  FROM lead_integrations
 WHERE provider = 'fillout'
   AND status IN ('connected', 'error')
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
	out := []FilloutBackfillTarget{}
	for rows.Next() {
		var item FilloutBackfillTarget
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

func (r *Repo) ListTallyBackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]TallyBackfillTarget, error) {
	if limit <= 0 || limit > 100 {
		limit = 10
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.lead_worker', 'true', true)`); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT tenant_id::text, id::text, sync_cursor, last_sync_at, error_message
  FROM lead_integrations
 WHERE provider = 'tally'
   AND status IN ('connected', 'error')
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
	out := []TallyBackfillTarget{}
	for rows.Next() {
		var item TallyBackfillTarget
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

func (r *Repo) ListPaperformBackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]PaperformBackfillTarget, error) {
	if limit <= 0 || limit > 100 {
		limit = 10
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.lead_worker', 'true', true)`); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT tenant_id::text, id::text, sync_cursor, last_sync_at, error_message
  FROM lead_integrations
 WHERE provider = 'paperform'
   AND status IN ('connected', 'error')
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
	out := []PaperformBackfillTarget{}
	for rows.Next() {
		var item PaperformBackfillTarget
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

func (r *Repo) ListFormstackBackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]FormstackBackfillTarget, error) {
	if limit <= 0 || limit > 100 {
		limit = 10
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.lead_worker', 'true', true)`); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT tenant_id::text, id::text, sync_cursor, last_sync_at, error_message
  FROM lead_integrations
 WHERE provider = 'formstack'
   AND status IN ('connected', 'error')
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
	out := []FormstackBackfillTarget{}
	for rows.Next() {
		var item FormstackBackfillTarget
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

func (r *Repo) ListFormsiteBackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]FormsiteBackfillTarget, error) {
	if limit <= 0 || limit > 100 {
		limit = 10
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.lead_worker', 'true', true)`); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT tenant_id::text, id::text, sync_cursor, last_sync_at, error_message
  FROM lead_integrations
 WHERE provider = 'formsite'
   AND status IN ('connected', 'error')
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
	out := []FormsiteBackfillTarget{}
	for rows.Next() {
		var item FormsiteBackfillTarget
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

func (r *Repo) ListLeadpagesBackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]LeadpagesBackfillTarget, error) {
	if limit <= 0 || limit > 100 {
		limit = 10
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.lead_worker', 'true', true)`); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT tenant_id::text, id::text, sync_cursor, last_sync_at, error_message
  FROM lead_integrations
 WHERE provider = 'leadpages'
   AND status IN ('connected', 'error')
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
	out := []LeadpagesBackfillTarget{}
	for rows.Next() {
		var item LeadpagesBackfillTarget
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

func (r *Repo) ListFormBuilder123BackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]FormBuilder123BackfillTarget, error) {
	if limit <= 0 || limit > 100 {
		limit = 10
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.lead_worker', 'true', true)`); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT tenant_id::text, id::text, sync_cursor, last_sync_at, error_message
  FROM lead_integrations
 WHERE provider = '123formbuilder'
   AND status IN ('connected', 'error')
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
	out := []FormBuilder123BackfillTarget{}
	for rows.Next() {
		var item FormBuilder123BackfillTarget
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

func (r *Repo) ListFormalooBackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]FormalooBackfillTarget, error) {
	if limit <= 0 || limit > 100 {
		limit = 10
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.lead_worker', 'true', true)`); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT tenant_id::text, id::text, sync_cursor, last_sync_at, error_message
  FROM lead_integrations
 WHERE provider = 'formaloo'
   AND status IN ('connected', 'error')
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
	out := []FormalooBackfillTarget{}
	for rows.Next() {
		var item FormalooBackfillTarget
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

func (r *Repo) ListCognitoFormsBackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]CognitoFormsBackfillTarget, error) {
	if limit <= 0 || limit > 100 {
		limit = 10
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.lead_worker', 'true', true)`); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT tenant_id::text, id::text, sync_cursor, last_sync_at, error_message
  FROM lead_integrations
 WHERE provider = 'cognito-forms'
   AND status IN ('connected', 'error')
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
	out := []CognitoFormsBackfillTarget{}
	for rows.Next() {
		var item CognitoFormsBackfillTarget
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

func (r *Repo) ListGravityFormsBackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]GravityFormsBackfillTarget, error) {
	if limit <= 0 || limit > 100 {
		limit = 10
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.lead_worker', 'true', true)`); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT tenant_id::text, id::text, sync_cursor, last_sync_at, error_message
  FROM lead_integrations
 WHERE provider = 'gravity-forms'
   AND status IN ('connected', 'error')
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
	out := []GravityFormsBackfillTarget{}
	for rows.Next() {
		var item GravityFormsBackfillTarget
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

func (r *Repo) ListWPFormsBackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]WPFormsBackfillTarget, error) {
	if limit <= 0 || limit > 100 {
		limit = 10
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.lead_worker', 'true', true)`); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT tenant_id::text, id::text, sync_cursor, last_sync_at, error_message
  FROM lead_integrations
 WHERE provider = 'wpforms'
   AND status IN ('connected', 'error')
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
	out := []WPFormsBackfillTarget{}
	for rows.Next() {
		var item WPFormsBackfillTarget
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

func (r *Repo) ListFormidableFormsBackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]FormidableFormsBackfillTarget, error) {
	if limit <= 0 || limit > 100 {
		limit = 10
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.lead_worker', 'true', true)`); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT tenant_id::text, id::text, sync_cursor, last_sync_at, error_message
  FROM lead_integrations
 WHERE provider = 'formidable-forms'
   AND status IN ('connected', 'error')
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
	out := []FormidableFormsBackfillTarget{}
	for rows.Next() {
		var item FormidableFormsBackfillTarget
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

func (r *Repo) ListGoogleFormsBackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]GoogleFormsBackfillTarget, error) {
	if limit <= 0 || limit > 100 {
		limit = 10
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.lead_worker', 'true', true)`); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT tenant_id::text, id::text, sync_cursor, last_sync_at, error_message
  FROM lead_integrations
 WHERE provider = 'google-forms'
   AND status IN ('connected', 'error')
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
	out := []GoogleFormsBackfillTarget{}
	for rows.Next() {
		var item GoogleFormsBackfillTarget
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

func (r *Repo) ListFeatheryBackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]FeatheryBackfillTarget, error) {
	if limit <= 0 || limit > 100 {
		limit = 10
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.lead_worker', 'true', true)`); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT tenant_id::text, id::text, sync_cursor, last_sync_at, error_message
  FROM lead_integrations
 WHERE provider = 'feathery'
   AND status IN ('connected', 'error')
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
	out := []FeatheryBackfillTarget{}
	for rows.Next() {
		var item FeatheryBackfillTarget
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

func (r *Repo) ListFacebookLeadAdsBackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]FacebookLeadAdsBackfillTarget, error) {
	if limit <= 0 || limit > 100 {
		limit = 10
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.lead_worker', 'true', true)`); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT tenant_id::text, id::text, sync_cursor, last_sync_at, error_message
  FROM lead_integrations
 WHERE provider = 'facebook-lead-ads'
   AND status IN ('connected', 'error')
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
	out := []FacebookLeadAdsBackfillTarget{}
	for rows.Next() {
		var item FacebookLeadAdsBackfillTarget
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

func (r *Repo) ListGoogleLeadFormsBackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]GoogleLeadFormsBackfillTarget, error) {
	if limit <= 0 || limit > 100 {
		limit = 10
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.lead_worker', 'true', true)`); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT tenant_id::text, id::text, sync_cursor, last_sync_at, error_message
  FROM lead_integrations
 WHERE provider = 'google-lead-form-extensions'
   AND status IN ('connected', 'error')
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
	out := []GoogleLeadFormsBackfillTarget{}
	for rows.Next() {
		var item GoogleLeadFormsBackfillTarget
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

func (r *Repo) ListWixBackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]WixBackfillTarget, error) {
	if limit <= 0 || limit > 100 {
		limit = 10
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.lead_worker', 'true', true)`); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT tenant_id::text, id::text, sync_cursor, last_sync_at, error_message
  FROM lead_integrations
 WHERE provider = 'wix'
   AND status IN ('connected', 'error')
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
	out := []WixBackfillTarget{}
	for rows.Next() {
		var item WixBackfillTarget
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
UPDATE lead_integrations
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
  FROM lead_integrations
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
		&item.SubmissionsSeen,
		&item.SubscribersUpserted,
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
