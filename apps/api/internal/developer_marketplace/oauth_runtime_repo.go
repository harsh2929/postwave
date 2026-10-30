package developer_marketplace

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

type oauthClientDirectoryRow struct {
	ClientID         string
	OAuthClientID    string
	AppID            string
	AppOwnerTenantID string
	ClientSecretHash string
	Status           string
	RedirectURIs     []string
	Scopes           []string
	RevokedAt        *time.Time
}

type oauthAuthorizationCodeRow struct {
	ID                  string
	ClientID            string
	AppID               string
	AppOwnerTenantID    string
	InstallingTenantID  string
	InstallationID      string
	RedirectURI         string
	Scopes              []string
	CodeChallenge       string
	CodeChallengeMethod string
	ExpiresAt           time.Time
	ConsumedAt          *time.Time
}

func (r *Repo) AuthorizeOAuthApp(ctx context.Context, tenantID string, in OAuthAuthorizeInput) (*OAuthAuthorizeResponse, error) {
	if err := validateOAuthAuthorizeInput(in); err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	client, err := getOAuthClientDirectoryTx(ctx, tx, in.ClientID)
	if err != nil {
		return nil, err
	}
	if client.Status != "active" || client.RevokedAt != nil {
		return nil, fmt.Errorf("OAuth client is not active")
	}
	if !exactRedirectAllowed(in.RedirectURI, client.RedirectURIs) {
		return nil, fmt.Errorf("redirect_uri is not registered for this client")
	}
	app, err := getAppTx(ctx, tx, tenantID, client.AppID)
	if err != nil {
		return nil, err
	}
	if app.AppType != "public" {
		return nil, fmt.Errorf("OAuth authorization requires a public app")
	}
	scopes, err := resolveOAuthScopes(in.Scope, client.Scopes, app.Scopes)
	if err != nil {
		return nil, err
	}

	installation, err := installOAuthAppTx(ctx, tx, tenantID, app.ID, scopes, in.InstalledBy, client)
	if err != nil {
		return nil, err
	}
	code, err := newOpaqueSecret("pw_code_", 32)
	if err != nil {
		return nil, err
	}
	expiresAt := time.Now().UTC().Add(oauthAuthorizationCodeTTL)
	if _, err := tx.Exec(ctx, `
INSERT INTO app_oauth_authorization_codes
    (code_hash, client_id, app_id, app_owner_tenant_id, installing_tenant_id,
     installation_id, redirect_uri, scopes, state, code_challenge,
     code_challenge_method, expires_at)
VALUES
    ($1, $2, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, $8::text[],
     $9, $10, 'S256', $11)`,
		sha256Hex(code), client.ClientID, client.AppID, client.AppOwnerTenantID,
		tenantID, installation.ID, in.RedirectURI, scopes, in.State,
		in.CodeChallenge, expiresAt); err != nil {
		return nil, err
	}
	redirectURL, err := buildOAuthRedirectURL(in.RedirectURI, code, in.State)
	if err != nil {
		return nil, err
	}
	_ = recordAuditTx(ctx, tx, tenantID, app.ID, "oauth.authorization_code.created", map[string]any{
		"client_id":       client.ClientID,
		"installation_id": installation.ID,
		"scopes":          scopes,
	})
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &OAuthAuthorizeResponse{
		Code:           code,
		State:          in.State,
		RedirectURI:    in.RedirectURI,
		RedirectURL:    redirectURL,
		AppID:          app.ID,
		InstallationID: installation.ID,
		GrantedScopes:  scopes,
		ExpiresAt:      expiresAt,
		Installation:   *installation,
	}, nil
}

func (r *Repo) ExchangeOAuthCode(ctx context.Context, in OAuthTokenRequest) (*OAuthTokenResponse, error) {
	if err := validateOAuthTokenRequest(in); err != nil {
		return nil, err
	}
	if r.Pool == nil {
		return nil, fmt.Errorf("developer marketplace repo requires a database pool")
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	code, err := getOAuthAuthorizationCodeTx(ctx, tx, sha256Hex(in.Code))
	if err != nil {
		return nil, err
	}
	client, err := getOAuthClientDirectoryTx(ctx, tx, code.ClientID)
	if err != nil {
		return nil, err
	}
	if code.ClientID != strings.TrimSpace(in.ClientID) {
		return nil, fmt.Errorf("client_id is invalid")
	}
	if code.RedirectURI != strings.TrimSpace(in.RedirectURI) {
		return nil, fmt.Errorf("redirect_uri is invalid")
	}
	if code.ConsumedAt != nil {
		return nil, fmt.Errorf("authorization code already consumed")
	}
	if time.Now().UTC().After(code.ExpiresAt) {
		return nil, fmt.Errorf("authorization code expired")
	}
	if client.Status != "active" || client.RevokedAt != nil {
		return nil, fmt.Errorf("OAuth client is not active")
	}
	if !constantTimeHashMatch(in.ClientSecret, client.ClientSecretHash) {
		return nil, fmt.Errorf("client_secret is invalid")
	}
	if code.CodeChallengeMethod != "S256" || !verifyPKCES256(in.CodeVerifier, code.CodeChallenge) {
		return nil, fmt.Errorf("code_verifier is invalid")
	}

	token, err := newOpaqueSecret("pw_at_", 32)
	if err != nil {
		return nil, err
	}
	expiresAt := time.Now().UTC().Add(oauthAccessTokenTTL)
	if _, err := tx.Exec(ctx, `
UPDATE app_oauth_authorization_codes
   SET consumed_at = now()
 WHERE id = $1::uuid AND consumed_at IS NULL`, code.ID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO app_oauth_access_tokens
    (token_hash, client_id, app_id, app_owner_tenant_id, installing_tenant_id,
     installation_id, scopes, expires_at)
VALUES ($1, $2, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::text[], $8)`,
		sha256Hex(token), code.ClientID, code.AppID, code.AppOwnerTenantID,
		code.InstallingTenantID, code.InstallationID, code.Scopes, expiresAt); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &OAuthTokenResponse{
		AccessToken:    token,
		TokenType:      "Bearer",
		ExpiresIn:      int(oauthAccessTokenTTL.Seconds()),
		Scope:          scopeString(code.Scopes),
		AppID:          code.AppID,
		InstallationID: code.InstallationID,
		ExpiresAt:      expiresAt,
	}, nil
}

func (r *Repo) RevokeOAuthAccessToken(ctx context.Context, in OAuthRevokeRequest) (*OAuthRevokeResponse, error) {
	if err := validateOAuthRevokeRequest(in); err != nil {
		return nil, err
	}
	if r.Pool == nil {
		return nil, fmt.Errorf("developer marketplace repo requires a database pool")
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	clientID := strings.TrimSpace(in.ClientID)
	if clientID != "" {
		client, err := getOAuthClientDirectoryTx(ctx, tx, clientID)
		if err != nil {
			return nil, err
		}
		if !constantTimeHashMatch(in.ClientSecret, client.ClientSecretHash) {
			return nil, fmt.Errorf("client_secret is invalid")
		}
	}
	query := `
UPDATE app_oauth_access_tokens
   SET revoked_at = COALESCE(revoked_at, now())
 WHERE token_hash = $1`
	args := []any{sha256Hex(in.Token)}
	if clientID != "" {
		query += ` AND client_id = $2`
		args = append(args, clientID)
	}
	tag, err := tx.Exec(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return &OAuthRevokeResponse{Revoked: false, Status: "not_found"}, nil
	}
	return &OAuthRevokeResponse{Revoked: true, Status: "revoked"}, nil
}

func installOAuthAppTx(ctx context.Context, tx pgx.Tx, tenantID, appID string, scopes []string, installedBy string, client *oauthClientDirectoryRow) (*Installation, error) {
	cfg, _ := json.Marshal(map[string]any{
		"oauth_client_id": client.ClientID,
		"install_flow":    "oauth_authorization_code",
	})
	row := tx.QueryRow(ctx, `
INSERT INTO app_installations
    (tenant_id, app_id, installed_by, status, granted_scopes, config)
VALUES ($1::uuid, $2::uuid, $3, 'installed', $4::text[], $5::jsonb)
ON CONFLICT (tenant_id, app_id) DO UPDATE SET
    installed_by = EXCLUDED.installed_by,
    status = 'installed',
    granted_scopes = EXCLUDED.granted_scopes,
    config = app_installations.config || EXCLUDED.config,
    revoked_at = NULL,
    updated_at = now()
RETURNING id::text, tenant_id::text, app_id::text, installed_by, status,
       granted_scopes, config, installed_at, updated_at, revoked_at`,
		tenantID, appID, strings.TrimSpace(installedBy), scopes, string(cfg))
	return scanInstallation(row)
}

func upsertOAuthClientDirectoryTx(ctx context.Context, tx pgx.Tx, client OAuthClient, secretHash string) error {
	if secretHash == "" {
		var current string
		if err := tx.QueryRow(ctx, `
SELECT client_secret_hash
  FROM oauth_clients
 WHERE id = $1::uuid`, client.ID).Scan(&current); err != nil {
			return err
		}
		secretHash = current
	}
	_, err := tx.Exec(ctx, `
INSERT INTO oauth_client_directory
    (client_id, oauth_client_id, app_id, app_owner_tenant_id, client_secret_hash,
     status, redirect_uris, scopes, revoked_at)
VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::text[], $8::text[], $9)
ON CONFLICT (client_id) DO UPDATE SET
    oauth_client_id = EXCLUDED.oauth_client_id,
    app_id = EXCLUDED.app_id,
    app_owner_tenant_id = EXCLUDED.app_owner_tenant_id,
    client_secret_hash = EXCLUDED.client_secret_hash,
    status = EXCLUDED.status,
    redirect_uris = EXCLUDED.redirect_uris,
    scopes = EXCLUDED.scopes,
    revoked_at = EXCLUDED.revoked_at,
    updated_at = now()`,
		client.ClientID, client.ID, client.AppID, client.TenantID, secretHash,
		client.Status, client.RedirectURI, client.Scopes, client.RevokedAt)
	return err
}

func getOAuthClientDirectoryTx(ctx context.Context, tx pgx.Tx, clientID string) (*oauthClientDirectoryRow, error) {
	row := tx.QueryRow(ctx, `
SELECT client_id, oauth_client_id::text, app_id::text, app_owner_tenant_id::text,
       client_secret_hash, status, redirect_uris, scopes, revoked_at
  FROM oauth_client_directory
 WHERE client_id = $1`, strings.TrimSpace(clientID))
	var out oauthClientDirectoryRow
	if err := row.Scan(&out.ClientID, &out.OAuthClientID, &out.AppID,
		&out.AppOwnerTenantID, &out.ClientSecretHash, &out.Status,
		&out.RedirectURIs, &out.Scopes, &out.RevokedAt); err != nil {
		return nil, mapNoRows(err)
	}
	return &out, nil
}

func getOAuthAuthorizationCodeTx(ctx context.Context, tx pgx.Tx, codeHash string) (*oauthAuthorizationCodeRow, error) {
	row := tx.QueryRow(ctx, `
SELECT id::text, client_id, app_id::text, app_owner_tenant_id::text,
       installing_tenant_id::text, installation_id::text, redirect_uri,
       scopes, code_challenge, code_challenge_method, expires_at, consumed_at
  FROM app_oauth_authorization_codes
 WHERE code_hash = $1
 FOR UPDATE`, codeHash)
	var out oauthAuthorizationCodeRow
	var consumed sql.NullTime
	if err := row.Scan(&out.ID, &out.ClientID, &out.AppID, &out.AppOwnerTenantID,
		&out.InstallingTenantID, &out.InstallationID, &out.RedirectURI,
		&out.Scopes, &out.CodeChallenge, &out.CodeChallengeMethod,
		&out.ExpiresAt, &consumed); err != nil {
		return nil, mapNoRows(err)
	}
	if consumed.Valid {
		out.ConsumedAt = &consumed.Time
	}
	return &out, nil
}
