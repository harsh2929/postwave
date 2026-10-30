// SPDX-License-Identifier: AGPL-3.0-only
package marketing_integrations

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

func bindMarketingOAuthStateHash(ctx context.Context, tx pgx.Tx, stateHash string) error {
	_, err := tx.Exec(ctx, "SELECT set_config('app.oauth_state_hash', $1, true)", stateHash)
	return err
}

func (r *Repo) CreateKlaviyoOAuthState(ctx context.Context, state KlaviyoOAuthState) (string, error) {
	if r == nil || r.Pool == nil {
		return "", fmt.Errorf("marketing integrations repo is not configured")
	}
	if strings.TrimSpace(state.TenantID) == "" {
		return "", fmt.Errorf("klaviyo OAuth state requires tenant_id")
	}
	if state.ExpiresAt.IsZero() {
		state.ExpiresAt = time.Now().UTC().Add(klaviyoOAuthStateTTL)
	}
	token, err := randomKlaviyoOAuthToken(32)
	if err != nil {
		return "", err
	}
	settings, _ := json.Marshal(nonNilMap(state.Settings))
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindMarketingOAuthStateHash(ctx, tx, hashKlaviyoOAuthState(token)); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO marketing_oauth_states (
    state_hash, tenant_id, provider, integration_name, redirect_uri, redirect_to,
    scopes, settings, code_verifier, expires_at
) VALUES ($1, $2::uuid, $3, $4, $5, NULLIF($6, ''), $7, $8::jsonb, $9, $10)`,
		hashKlaviyoOAuthState(token), state.TenantID, ProviderKlaviyo,
		strings.TrimSpace(state.IntegrationName), strings.TrimSpace(state.RedirectURI),
		strings.TrimSpace(state.RedirectTo), uniqueMarketingStrings(state.Scopes), string(settings),
		strings.TrimSpace(state.CodeVerifier), state.ExpiresAt.UTC()); err != nil {
		return "", err
	}
	return token, tx.Commit(ctx)
}

func (r *Repo) ConsumeKlaviyoOAuthState(ctx context.Context, stateToken string) (KlaviyoOAuthState, error) {
	if r == nil || r.Pool == nil {
		return KlaviyoOAuthState{}, fmt.Errorf("marketing integrations repo is not configured")
	}
	stateToken = strings.TrimSpace(stateToken)
	if stateToken == "" {
		return KlaviyoOAuthState{}, ErrNotFound
	}
	tx, txErr := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if txErr != nil {
		return KlaviyoOAuthState{}, txErr
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindMarketingOAuthStateHash(ctx, tx, hashKlaviyoOAuthState(stateToken)); err != nil {
		return KlaviyoOAuthState{}, err
	}
	var out KlaviyoOAuthState
	var redirectTo *string
	var settingsRaw []byte
	txErr = tx.QueryRow(ctx, `
DELETE FROM marketing_oauth_states
 WHERE state_hash = $1
   AND provider = $2
   AND expires_at > now()
RETURNING tenant_id::text, integration_name, redirect_uri, redirect_to, scopes,
          settings, code_verifier, expires_at, created_at`,
		hashKlaviyoOAuthState(stateToken), ProviderKlaviyo).
		Scan(&out.TenantID, &out.IntegrationName, &out.RedirectURI, &redirectTo,
			&out.Scopes, &settingsRaw, &out.CodeVerifier, &out.ExpiresAt, &out.CreatedAt)
	if errors.Is(txErr, pgx.ErrNoRows) {
		return KlaviyoOAuthState{}, ErrNotFound
	}
	if txErr != nil {
		return KlaviyoOAuthState{}, txErr
	}
	if redirectTo != nil {
		out.RedirectTo = *redirectTo
	}
	out.Settings = map[string]any{}
	_ = json.Unmarshal(settingsRaw, &out.Settings)
	if err := tx.Commit(ctx); err != nil {
		return KlaviyoOAuthState{}, err
	}
	return out, nil
}

func (r *Repo) GetKlaviyoCredentialSecret(ctx context.Context, tenantID, ref string) (string, error) {
	if r == nil || r.Pool == nil {
		return "", fmt.Errorf("marketing integrations repo is not configured")
	}
	if r.Cipher == nil {
		return "", fmt.Errorf("marketing credential cipher is not configured")
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
  FROM marketing_credential_secrets
 WHERE tenant_id = $1::uuid
   AND provider = $2
   AND ref = $3`, tenantID, ProviderKlaviyo, ref).Scan(&envelope)
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

func (r *Repo) PutKlaviyoCredentialSecret(ctx context.Context, tenantID, ref string, creds KlaviyoCredentials) error {
	if r == nil || r.Pool == nil {
		return fmt.Errorf("marketing integrations repo is not configured")
	}
	if r.Cipher == nil {
		return fmt.Errorf("marketing credential cipher is not configured")
	}
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return fmt.Errorf("klaviyo credential ref is required")
	}
	envelope, err := r.Cipher.Encrypt(ctx, []byte(klaviyoStoredCredentialJSON(creds)))
	if err != nil {
		return err
	}
	metadata, _ := json.Marshal(map[string]any{
		"provider":         ProviderKlaviyo,
		"api_base_url":     strings.TrimSpace(creds.APIBaseURL),
		"oauth_base_url":   strings.TrimSpace(creds.OAuthBaseURL),
		"scope":            strings.TrimSpace(creds.Scope),
		"account_id":       strings.TrimSpace(creds.AccountID),
		"token_expires_at": klaviyoNullableTime(creds.TokenExpiresAt),
		"has_refresh":      strings.TrimSpace(creds.RefreshToken) != "",
	})
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
INSERT INTO marketing_credential_secrets (
    tenant_id, provider, ref, secret_envelope, metadata
) VALUES ($1::uuid, $2, $3, $4, $5::jsonb)
ON CONFLICT (tenant_id, provider, ref) DO UPDATE SET
    secret_envelope = EXCLUDED.secret_envelope,
    metadata = marketing_credential_secrets.metadata || EXCLUDED.metadata,
    updated_at = now()`,
		tenantID, ProviderKlaviyo, ref, envelope, string(metadata))
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *Repo) DeleteKlaviyoCredentialSecret(ctx context.Context, tenantID, ref string) error {
	if r == nil || r.Pool == nil {
		return fmt.Errorf("marketing integrations repo is not configured")
	}
	ref = strings.TrimSpace(ref)
	if ref == "" || !klaviyoIsStoredCredentialRef(ref) {
		return nil
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
DELETE FROM marketing_credential_secrets
 WHERE tenant_id = $1::uuid
   AND provider = $2
   AND ref = $3`, tenantID, ProviderKlaviyo, ref); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func uniqueMarketingStrings(values []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

func klaviyoNullableTime(t *time.Time) any {
	if t == nil {
		return nil
	}
	return t.UTC().Format(time.RFC3339)
}
