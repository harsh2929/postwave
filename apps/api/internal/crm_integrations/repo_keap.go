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

// Keap persistence: OAuth state, managed credential secrets and backfill
// targets.

func (r *Repo) CreateKeapOAuthState(ctx context.Context, state KeapOAuthState) (string, error) {
	if r == nil || r.Pool == nil {
		return "", fmt.Errorf("crm integrations repo is not configured")
	}
	if strings.TrimSpace(state.TenantID) == "" {
		return "", fmt.Errorf("keap OAuth state requires tenant_id")
	}
	if state.ExpiresAt.IsZero() {
		state.ExpiresAt = time.Now().UTC().Add(keapOAuthStateTTL)
	}
	token, err := randomKeapToken(32)
	if err != nil {
		return "", err
	}
	settings, _ := json.Marshal(nonNilMap(state.Settings))
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindOAuthStateHash(ctx, tx, hashKeapOAuthState(token)); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO crm_oauth_states (
    state_hash, tenant_id, provider, integration_name, redirect_uri, redirect_to,
    scopes, settings, expires_at
) VALUES ($1, $2::uuid, $3, $4, $5, NULLIF($6, ''), $7, $8::jsonb, $9)`,
		hashKeapOAuthState(token), state.TenantID, ProviderKeap,
		strings.TrimSpace(state.IntegrationName), strings.TrimSpace(state.RedirectURI),
		strings.TrimSpace(state.RedirectTo), uniqueCRMStrings(state.Scopes), string(settings),
		state.ExpiresAt.UTC()); err != nil {
		return "", err
	}
	return token, tx.Commit(ctx)
}

func (r *Repo) ConsumeKeapOAuthState(ctx context.Context, stateToken string) (KeapOAuthState, error) {
	if r == nil || r.Pool == nil {
		return KeapOAuthState{}, fmt.Errorf("crm integrations repo is not configured")
	}
	stateToken = strings.TrimSpace(stateToken)
	if stateToken == "" {
		return KeapOAuthState{}, ErrNotFound
	}
	tx, txErr := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if txErr != nil {
		return KeapOAuthState{}, txErr
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindOAuthStateHash(ctx, tx, hashKeapOAuthState(stateToken)); err != nil {
		return KeapOAuthState{}, err
	}
	var out KeapOAuthState
	var redirectTo *string
	var settingsRaw []byte
	txErr = tx.QueryRow(ctx, `
DELETE FROM crm_oauth_states
 WHERE state_hash = $1
   AND provider = $2
   AND expires_at > now()
RETURNING tenant_id::text, integration_name, redirect_uri, redirect_to, scopes,
          settings, expires_at, created_at`,
		hashKeapOAuthState(stateToken), ProviderKeap).
		Scan(&out.TenantID, &out.IntegrationName, &out.RedirectURI, &redirectTo,
			&out.Scopes, &settingsRaw, &out.ExpiresAt, &out.CreatedAt)
	if errors.Is(txErr, pgx.ErrNoRows) {
		return KeapOAuthState{}, ErrNotFound
	}
	if txErr != nil {
		return KeapOAuthState{}, txErr
	}
	if redirectTo != nil {
		out.RedirectTo = *redirectTo
	}
	out.Settings = map[string]any{}
	_ = json.Unmarshal(settingsRaw, &out.Settings)
	if err := tx.Commit(ctx); err != nil {
		return KeapOAuthState{}, err
	}
	return out, nil
}

func (r *Repo) GetKeapCredentialSecret(ctx context.Context, tenantID, ref string) (string, error) {
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
   AND ref = $3`, tenantID, ProviderKeap, ref).Scan(&envelope)
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

func (r *Repo) PutKeapCredentialSecret(ctx context.Context, tenantID, ref string, creds KeapCredentials) error {
	if r == nil || r.Pool == nil {
		return fmt.Errorf("crm integrations repo is not configured")
	}
	if r.Cipher == nil {
		return fmt.Errorf("crm credential cipher is not configured")
	}
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return fmt.Errorf("keap credential ref is required")
	}
	envelope, err := r.Cipher.Encrypt(ctx, []byte(keapStoredCredentialJSON(creds)))
	if err != nil {
		return err
	}
	metadata, _ := json.Marshal(map[string]any{
		"provider":     ProviderKeap,
		"api_base_url": strings.TrimSpace(creds.APIBaseURL),

		"scope":            strings.TrimSpace(creds.Scope),
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
		tenantID, ProviderKeap, ref, envelope, string(metadata))
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *Repo) DeleteKeapCredentialSecret(ctx context.Context, tenantID, ref string) error {
	if r == nil || r.Pool == nil {
		return fmt.Errorf("crm integrations repo is not configured")
	}
	ref = strings.TrimSpace(ref)
	if ref == "" || !keapIsStoredCredentialRef(ref) {
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
   AND ref = $3`, tenantID, ProviderKeap, ref); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *Repo) ListKeapBackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]KeapBackfillTarget, error) {
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
 LIMIT $2`, ProviderKeap, limit, staleBefore)
	if txErr != nil {
		return nil, txErr
	}
	defer rows.Close()
	out := []KeapBackfillTarget{}
	for rows.Next() {
		var item KeapBackfillTarget
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
