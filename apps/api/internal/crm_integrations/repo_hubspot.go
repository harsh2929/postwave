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

// HubSpot persistence: OAuth state, managed credential secrets, backfill
// targets and the app/portal lookup.

func (r *Repo) CreateHubSpotOAuthState(ctx context.Context, state HubSpotOAuthState) (string, error) {
	if r == nil || r.Pool == nil {
		return "", fmt.Errorf("crm integrations repo is not configured")
	}
	if strings.TrimSpace(state.TenantID) == "" {
		return "", fmt.Errorf("hubspot OAuth state requires tenant_id")
	}
	if state.ExpiresAt.IsZero() {
		state.ExpiresAt = time.Now().UTC().Add(hubSpotOAuthStateTTL)
	}
	token, err := randomHubSpotToken(32)
	if err != nil {
		return "", err
	}
	settings, _ := json.Marshal(nonNilMap(state.Settings))
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindOAuthStateHash(ctx, tx, hashHubSpotOAuthState(token)); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO crm_oauth_states (
    state_hash, tenant_id, provider, integration_name, redirect_uri, redirect_to,
    scopes, settings, expires_at
) VALUES ($1, $2::uuid, $3, $4, $5, NULLIF($6, ''), $7, $8::jsonb, $9)`,
		hashHubSpotOAuthState(token), state.TenantID, ProviderHubSpot,
		strings.TrimSpace(state.IntegrationName), strings.TrimSpace(state.RedirectURI),
		strings.TrimSpace(state.RedirectTo), uniqueCRMStrings(state.Scopes), string(settings),
		state.ExpiresAt.UTC()); err != nil {
		return "", err
	}
	return token, tx.Commit(ctx)
}

func (r *Repo) ConsumeHubSpotOAuthState(ctx context.Context, stateToken string) (HubSpotOAuthState, error) {
	if r == nil || r.Pool == nil {
		return HubSpotOAuthState{}, fmt.Errorf("crm integrations repo is not configured")
	}
	stateToken = strings.TrimSpace(stateToken)
	if stateToken == "" {
		return HubSpotOAuthState{}, ErrNotFound
	}
	tx, txErr := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if txErr != nil {
		return HubSpotOAuthState{}, txErr
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindOAuthStateHash(ctx, tx, hashHubSpotOAuthState(stateToken)); err != nil {
		return HubSpotOAuthState{}, err
	}
	var out HubSpotOAuthState
	var redirectTo *string
	var settingsRaw []byte
	txErr = tx.QueryRow(ctx, `
DELETE FROM crm_oauth_states
 WHERE state_hash = $1
   AND provider = $2
   AND expires_at > now()
RETURNING tenant_id::text, integration_name, redirect_uri, redirect_to, scopes,
          settings, expires_at, created_at`,
		hashHubSpotOAuthState(stateToken), ProviderHubSpot).
		Scan(&out.TenantID, &out.IntegrationName, &out.RedirectURI, &redirectTo,
			&out.Scopes, &settingsRaw, &out.ExpiresAt, &out.CreatedAt)
	if errors.Is(txErr, pgx.ErrNoRows) {
		return HubSpotOAuthState{}, ErrNotFound
	}
	if txErr != nil {
		return HubSpotOAuthState{}, txErr
	}
	if redirectTo != nil {
		out.RedirectTo = *redirectTo
	}
	out.Settings = map[string]any{}
	_ = json.Unmarshal(settingsRaw, &out.Settings)
	if err := tx.Commit(ctx); err != nil {
		return HubSpotOAuthState{}, err
	}
	return out, nil
}

func (r *Repo) GetHubSpotCredentialSecret(ctx context.Context, tenantID, ref string) (string, error) {
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
   AND ref = $3`, tenantID, ProviderHubSpot, ref).Scan(&envelope)
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

func (r *Repo) PutHubSpotCredentialSecret(ctx context.Context, tenantID, ref string, creds HubSpotCredentials) error {
	if r == nil || r.Pool == nil {
		return fmt.Errorf("crm integrations repo is not configured")
	}
	if r.Cipher == nil {
		return fmt.Errorf("crm credential cipher is not configured")
	}
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return fmt.Errorf("hubspot credential ref is required")
	}
	envelope, err := r.Cipher.Encrypt(ctx, []byte(hubSpotStoredCredentialJSON(creds)))
	if err != nil {
		return err
	}
	metadata, _ := json.Marshal(map[string]any{
		"provider":         ProviderHubSpot,
		"api_base_url":     strings.TrimSpace(creds.APIBaseURL),
		"oauth_base_url":   strings.TrimSpace(creds.OAuthBaseURL),
		"scope":            strings.TrimSpace(creds.Scope),
		"portal_id":        strings.TrimSpace(creds.PortalID),
		"token_expires_at": pipedriveNullableTime(creds.TokenExpiresAt),
		"has_refresh":      strings.TrimSpace(creds.RefreshToken) != "",
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
		tenantID, ProviderHubSpot, ref, envelope, string(metadata))
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *Repo) DeleteHubSpotCredentialSecret(ctx context.Context, tenantID, ref string) error {
	if r == nil || r.Pool == nil {
		return fmt.Errorf("crm integrations repo is not configured")
	}
	ref = strings.TrimSpace(ref)
	if ref == "" || !hubSpotIsStoredCredentialRef(ref) {
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
   AND ref = $3`, tenantID, ProviderHubSpot, ref); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *Repo) ListHubSpotBackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]HubSpotBackfillTarget, error) {
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
 LIMIT $2`, ProviderHubSpot, limit, staleBefore)
	if txErr != nil {
		return nil, txErr
	}
	defer rows.Close()
	out := []HubSpotBackfillTarget{}
	for rows.Next() {
		var item HubSpotBackfillTarget
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

func (r *Repo) FindHubSpotIntegrationByAppAndPortalID(ctx context.Context, appID, portalID string) (*Integration, error) {
	appID = strings.TrimSpace(appID)
	portalID = strings.TrimSpace(portalID)
	if appID == "" || portalID == "" {
		return nil, ErrNotFound
	}
	tx, txErr := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if txErr != nil {
		return nil, txErr
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.crm_provider', $1, true), set_config('app.crm_webhook_portal_id', $2, true), set_config('app.crm_webhook_app_id', $3, true)`, ProviderHubSpot, portalID, appID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
WITH matched AS (
	SELECT id::text, tenant_id::text, provider, name, status, scopes,
	       credentials_ref, settings, sync_cursor, last_sync_at,
	       error_message, created_at, updated_at
	  FROM crm_integrations
	 WHERE provider = $1
	   AND settings->>'hubspot_app_id' = $2
	   AND (settings->>'hubspot_portal_id' = $3 OR settings->>'portal_id' = $3)
	   AND (
	        settings->>'hubspot_auth_mode' = 'managed_oauth'
	        OR (
	            COALESCE(settings->>'hubspot_auth_mode', '') = ''
	            AND settings->>'hubspot_oauth_managed_by_postwave' = 'true'
	            AND credentials_ref LIKE 'crm:hubspot:%'
	        )
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
 LIMIT 1`, ProviderHubSpot, appID, portalID)
	out, txErr := scanIntegration(row)
	if errors.Is(txErr, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if txErr != nil {
		return nil, txErr
	}
	return out, tx.Commit(ctx)
}
