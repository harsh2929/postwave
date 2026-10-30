// SPDX-License-Identifier: AGPL-3.0-only
package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/postwave/postwave/apps/api/internal/regions"
)

// Reuse the pre-auth expiring state store, with a distinct provider namespace.
// Only a hash of the browser capability is persisted. No migration is needed.
func (r *Repo) IssueOAuthSignup(ctx context.Context, claims idpClaims) (string, error) {
	if err := normalizeOIDCClaims(&claims); err != nil || !claims.EmailVerified {
		return "", ErrNotFound
	}
	token, err := randomToken(32)
	if err != nil {
		return "", err
	}
	csrf, err := randomToken(32)
	if err != nil {
		return "", err
	}
	claimsJSON, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	_, err = r.Pool.Exec(ctx, `INSERT INTO auth_oauth_state (state, provider, pkce_verifier, redirect_to, expires_at)
		VALUES ($1, $2, $3, $4, now() + interval '10 minutes')`, oauthSignupTokenHash(token), oauthSignupStateProvider, csrf, string(claimsJSON))
	return token, err
}

func (r *Repo) GetOAuthSignup(ctx context.Context, token string) (*OAuthSignupIntent, error) {
	var claimsJSON string
	intent := &OAuthSignupIntent{}
	err := r.Pool.QueryRow(ctx, `SELECT redirect_to, pkce_verifier FROM auth_oauth_state
		WHERE state = $1 AND provider = $2 AND expires_at > now()`, oauthSignupTokenHash(token), oauthSignupStateProvider).Scan(&claimsJSON, &intent.CSRFToken)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal([]byte(claimsJSON), &intent.Claims); err != nil {
		return nil, err
	}
	return intent, nil
}

func (r *Repo) CreateTenantWithGoogleOwner(ctx context.Context, token, csrf, workspaceName, workspaceSlug string) (string, string, error) {
	tx, err := r.withResolverGUC(ctx)
	if err != nil {
		return "", "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var claimsJSON string
	err = tx.QueryRow(ctx, `DELETE FROM auth_oauth_state
		WHERE state = $1 AND provider = $2 AND pkce_verifier = $3 AND expires_at > now()
		RETURNING redirect_to`, oauthSignupTokenHash(token), oauthSignupStateProvider, csrf).Scan(&claimsJSON)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", ErrNotFound
	}
	if err != nil {
		return "", "", err
	}
	var claims idpClaims
	if err := json.Unmarshal([]byte(claimsJSON), &claims); err != nil {
		return "", "", err
	}
	if err := normalizeOIDCClaims(&claims); err != nil || !claims.EmailVerified {
		return "", "", ErrNotFound
	}
	// Two independently completed Google flows must not create two owners.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, "google-signup:"+claims.Sub); err != nil {
		return "", "", err
	}
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE lower(email) = lower($1))
		OR EXISTS(SELECT 1 FROM auth_idp_links WHERE provider = 'google' AND subject = $2)`, claims.Email, claims.Sub).Scan(&exists); err != nil {
		return "", "", err
	}
	if exists {
		return "", "", ErrOAuthSignupAccountExists
	}
	var tenantID, userID string
	if err := tx.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&tenantID); err != nil {
		return "", "", err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return "", "", err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO tenants (id, slug, name, tier, data_region)
		VALUES ($1::uuid, $2, $3, 'sandbox', $4)`, tenantID, workspaceSlug, workspaceName, regions.Provisioning()); err != nil {
		return "", "", fmt.Errorf("insert Google tenant: %w", err)
	}
	if err := tx.QueryRow(ctx, `INSERT INTO users (tenant_id, email, role, auth_provider, email_verified_at)
		VALUES ($1::uuid, $2, 'owner', 'google', now()) RETURNING id::text`, tenantID, claims.Email).Scan(&userID); err != nil {
		return "", "", err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO auth_idp_links (user_id, provider, subject, email, raw_claims)
		VALUES ($1::uuid, 'google', $2, $3, $4::jsonb)`, userID, claims.Sub, claims.Email, claimsJSON); err != nil {
		return "", "", err
	}
	// Google is the standing credential: no auth_credentials/password row.
	if err := tx.Commit(ctx); err != nil {
		return "", "", err
	}
	return tenantID, userID, nil
}
