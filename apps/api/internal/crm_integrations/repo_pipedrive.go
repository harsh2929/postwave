// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

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

// Pipedrive persistence: OAuth state, managed credential secrets, backfill
// targets and webhook/OAuth-install lookups.

func (r *Repo) CreatePipedriveOAuthState(ctx context.Context, state PipedriveOAuthState) (string, error) {
	if r == nil || r.Pool == nil {
		return "", fmt.Errorf("crm integrations repo is not configured")
	}
	if strings.TrimSpace(state.TenantID) == "" {
		return "", fmt.Errorf("pipedrive OAuth state requires tenant_id")
	}
	if state.ExpiresAt.IsZero() {
		state.ExpiresAt = time.Now().UTC().Add(pipedriveOAuthStateTTL)
	}
	token, err := randomPipedriveToken(32)
	if err != nil {
		return "", err
	}
	settings, _ := json.Marshal(nonNilMap(state.Settings))
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindOAuthStateHash(ctx, tx, hashPipedriveOAuthState(token)); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO crm_oauth_states (
    state_hash, tenant_id, provider, integration_name, redirect_uri, redirect_to,
    scopes, settings, expires_at
) VALUES ($1, $2::uuid, $3, $4, $5, NULLIF($6, ''), $7, $8::jsonb, $9)`,
		hashPipedriveOAuthState(token), state.TenantID, ProviderPipedrive,
		strings.TrimSpace(state.IntegrationName), strings.TrimSpace(state.RedirectURI),
		strings.TrimSpace(state.RedirectTo), uniqueCRMStrings(state.Scopes), string(settings),
		state.ExpiresAt.UTC()); err != nil {
		return "", err
	}
	return token, tx.Commit(ctx)
}

func (r *Repo) ConsumePipedriveOAuthState(ctx context.Context, stateToken string) (PipedriveOAuthState, error) {
	if r == nil || r.Pool == nil {
		return PipedriveOAuthState{}, fmt.Errorf("crm integrations repo is not configured")
	}
	stateToken = strings.TrimSpace(stateToken)
	if stateToken == "" {
		return PipedriveOAuthState{}, ErrNotFound
	}
	tx, txErr := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if txErr != nil {
		return PipedriveOAuthState{}, txErr
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindOAuthStateHash(ctx, tx, hashPipedriveOAuthState(stateToken)); err != nil {
		return PipedriveOAuthState{}, err
	}
	var out PipedriveOAuthState
	var redirectTo *string
	var settingsRaw []byte
	txErr = tx.QueryRow(ctx, `
DELETE FROM crm_oauth_states
 WHERE state_hash = $1
   AND provider = $2
   AND expires_at > now()
RETURNING tenant_id::text, integration_name, redirect_uri, redirect_to, scopes,
          settings, expires_at, created_at`,
		hashPipedriveOAuthState(stateToken), ProviderPipedrive).
		Scan(&out.TenantID, &out.IntegrationName, &out.RedirectURI, &redirectTo,
			&out.Scopes, &settingsRaw, &out.ExpiresAt, &out.CreatedAt)
	if errors.Is(txErr, pgx.ErrNoRows) {
		return PipedriveOAuthState{}, ErrNotFound
	}
	if txErr != nil {
		return PipedriveOAuthState{}, txErr
	}
	if redirectTo != nil {
		out.RedirectTo = *redirectTo
	}
	out.Settings = map[string]any{}
	_ = json.Unmarshal(settingsRaw, &out.Settings)
	if err := tx.Commit(ctx); err != nil {
		return PipedriveOAuthState{}, err
	}
	return out, nil
}

func (r *Repo) GetPipedriveCredentialSecret(ctx context.Context, tenantID, ref string) (string, error) {
	if r == nil || r.Pool == nil {
		return "", fmt.Errorf("crm integrations repo is not configured")
	}
	if r.Cipher == nil {
		return "", fmt.Errorf("crm credential cipher is not configured")
	}
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return "", ErrNotFound
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var envelope []byte
	err = tx.QueryRow(ctx, `
SELECT secret_envelope
  FROM crm_credential_secrets
 WHERE tenant_id = $1::uuid
   AND provider = $2
   AND ref = $3`, tenantID, ProviderPipedrive, ref).Scan(&envelope)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	plain, err := r.Cipher.Decrypt(ctx, envelope, r.LegacyKEK)
	if err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return string(plain), nil
}

func (r *Repo) PutPipedriveCredentialSecret(ctx context.Context, tenantID, ref string, creds PipedriveCredentials) error {
	if r == nil || r.Pool == nil {
		return fmt.Errorf("crm integrations repo is not configured")
	}
	if r.Cipher == nil {
		return fmt.Errorf("crm credential cipher is not configured")
	}
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return fmt.Errorf("pipedrive credential ref is required")
	}
	raw, err := pipedriveCredentialsJSON(creds)
	if err != nil {
		return err
	}
	envelope, err := r.Cipher.Encrypt(ctx, raw)
	if err != nil {
		return err
	}
	metadata, _ := json.Marshal(map[string]any{
		"provider":         ProviderPipedrive,
		"api_base_url":     strings.TrimSpace(creds.APIBaseURL),
		"oauth_base_url":   strings.TrimSpace(creds.OAuthBaseURL),
		"scope":            strings.TrimSpace(creds.Scope),
		"token_expires_at": pipedriveNullableTime(creds.TokenExpiresAt),
		"has_refresh":      strings.TrimSpace(creds.RefreshToken) != "",
		"has_webhook_auth": strings.TrimSpace(creds.WebhookUsername) != "" && strings.TrimSpace(creds.WebhookPassword) != "",
	})
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
INSERT INTO crm_credential_secrets (
    tenant_id, provider, ref, secret_envelope, metadata
) VALUES ($1::uuid, $2, $3, $4, $5::jsonb)
ON CONFLICT (tenant_id, provider, ref) DO UPDATE SET
    secret_envelope = EXCLUDED.secret_envelope,
    metadata = crm_credential_secrets.metadata || EXCLUDED.metadata,
    updated_at = now()`,
		tenantID, ProviderPipedrive, ref, envelope, string(metadata))
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *Repo) DeletePipedriveCredentialSecret(ctx context.Context, tenantID, ref string) error {
	if r == nil || r.Pool == nil {
		return fmt.Errorf("crm integrations repo is not configured")
	}
	ref = strings.TrimSpace(ref)
	if ref == "" || !pipedriveIsStoredCredentialRef(ref) {
		return nil
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
DELETE FROM crm_credential_secrets
 WHERE tenant_id = $1::uuid
   AND provider = $2
   AND ref = $3`, tenantID, ProviderPipedrive, ref); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *Repo) ListPipedriveBackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]PipedriveBackfillTarget, error) {
	if limit <= 0 {
		limit = 10
	} else if limit > pipedriveBackfillWorkerMaxCandidateScan {
		limit = pipedriveBackfillWorkerMaxCandidateScan
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
	out := []PipedriveBackfillTarget{}
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
 LIMIT $2 OFFSET $4`, ProviderPipedrive, pipedriveBackfillWorkerMaxCandidateScan, staleBefore, offset)
		if err != nil {
			return nil, err
		}
		batchCount := 0
		for rows.Next() {
			batchCount++
			var item PipedriveBackfillTarget
			if err := rows.Scan(&item.TenantID, &item.IntegrationID, &item.Cursor, &item.LastSyncAt, &item.ErrorMessage); err != nil {
				rows.Close()
				return nil, err
			}
			if pipedriveBackfillTargetRetryNotDue(item.Cursor, now) {
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
		if len(out) >= limit || batchCount < pipedriveBackfillWorkerMaxCandidateScan {
			break
		}
		offset += batchCount
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) FindPipedriveIntegrationByWebhookID(ctx context.Context, webhookID string) (*Integration, error) {
	webhookID = strings.TrimSpace(webhookID)
	if webhookID == "" {
		return nil, ErrNotFound
	}
	tx, txErr := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if txErr != nil {
		return nil, txErr
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.crm_provider', $1, true), set_config('app.crm_webhook_id', $2, true)`, ProviderPipedrive, webhookID); err != nil {
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
       settings->>'pipedrive_webhook_id' = $2
       OR COALESCE(settings->'pipedrive_webhook_ids', '[]'::jsonb) ? $2
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
 LIMIT 1`, ProviderPipedrive, webhookID)
	out, txErr := scanIntegration(row)
	if errors.Is(txErr, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if txErr != nil {
		return nil, txErr
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) FindPipedriveIntegrationByOAuthInstall(ctx context.Context, clientID, companyID, userID string) (*Integration, error) {
	clientID = strings.TrimSpace(clientID)
	companyID = strings.TrimSpace(companyID)
	userID = strings.TrimSpace(userID)
	if clientID == "" || companyID == "" || userID == "" {
		return nil, ErrNotFound
	}
	tx, txErr := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if txErr != nil {
		return nil, txErr
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.crm_oauth_client_id', $1, true), set_config('app.crm_oauth_company_id', $2, true), set_config('app.crm_oauth_user_id', $3, true)`, clientID, companyID, userID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
WITH matched AS (
SELECT id::text, tenant_id::text, provider, name, status, scopes,
       credentials_ref, settings, sync_cursor, last_sync_at,
       error_message, created_at, updated_at
  FROM crm_integrations
 WHERE provider = $1
   AND settings->>'pipedrive_oauth_client_id' = $2
   AND settings->>'pipedrive_company_id' = $3
   AND settings->>'pipedrive_user_id' = $4
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
 LIMIT 1`, ProviderPipedrive, clientID, companyID, userID)
	out, txErr := scanIntegration(row)
	if errors.Is(txErr, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if txErr != nil {
		return nil, txErr
	}
	return out, tx.Commit(ctx)
}
