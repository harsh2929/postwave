package developer_marketplace

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const oauthAccessTokenPrefix = "pw_at_"

type OAuthBearerResolver struct {
	Pool *db.Pool
	Now  func() time.Time
}

func NewOAuthBearerResolver(pool *db.Pool) *OAuthBearerResolver {
	return &OAuthBearerResolver{Pool: pool}
}

func (r *OAuthBearerResolver) SupportsBearerToken(plaintext string) bool {
	return strings.HasPrefix(strings.TrimSpace(plaintext), oauthAccessTokenPrefix)
}

func (r *OAuthBearerResolver) ResolveBearerToken(ctx context.Context, plaintext string) (*apikeys.SupplementalBearerAuth, error) {
	if r == nil || r.Pool == nil || !r.SupportsBearerToken(plaintext) {
		return nil, apikeys.ErrInvalidKey
	}
	now := time.Now().UTC()
	if r.Now != nil {
		now = r.Now().UTC()
	}

	tx, err := db.WithTenantResolver(ctx, r.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	token, err := getOAuthAccessTokenForBearerTx(ctx, tx, sha256Hex(strings.TrimSpace(plaintext)))
	if err != nil {
		return nil, err
	}
	if token.RevokedAt != nil || !now.Before(token.ExpiresAt) {
		return nil, apikeys.ErrInvalidKey
	}

	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, token.InstallingTenantID); err != nil {
		return nil, err
	}

	appName, appSlug, err := verifyOAuthBearerInstallationTx(ctx, tx, token)
	if err != nil {
		return nil, err
	}

	tenant, err := getTenantForOAuthBearerTx(ctx, tx, token.InstallingTenantID)
	if err != nil {
		return nil, err
	}

	if _, err := tx.Exec(ctx, `
UPDATE app_oauth_access_tokens
   SET last_used_at = now()
 WHERE id = $1::uuid AND revoked_at IS NULL`, token.ID); err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	return &apikeys.SupplementalBearerAuth{
		Tenant:     tenant,
		Scopes:     apiKeyScopesFromMarketplaceScopes(token.Scopes),
		ActorType:  "agent",
		ActorLabel: oauthBearerActorLabel(appName, appSlug, token.ClientID, token.InstallationID),
	}, nil
}

type oauthAccessTokenBearerRow struct {
	ID                 string
	ClientID           string
	AppID              string
	InstallingTenantID string
	InstallationID     string
	Scopes             []string
	ExpiresAt          time.Time
	RevokedAt          *time.Time
}

func getOAuthAccessTokenForBearerTx(ctx context.Context, tx pgx.Tx, tokenHash string) (*oauthAccessTokenBearerRow, error) {
	row := tx.QueryRow(ctx, `
SELECT id::text, client_id, app_id::text, installing_tenant_id::text,
       installation_id::text, scopes, expires_at, revoked_at
  FROM app_oauth_access_tokens
 WHERE token_hash = $1
 LIMIT 1`, tokenHash)
	var out oauthAccessTokenBearerRow
	if err := row.Scan(&out.ID, &out.ClientID, &out.AppID, &out.InstallingTenantID,
		&out.InstallationID, &out.Scopes, &out.ExpiresAt, &out.RevokedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, apikeys.ErrInvalidKey
		}
		return nil, err
	}
	return &out, nil
}

func verifyOAuthBearerInstallationTx(ctx context.Context, tx pgx.Tx, token *oauthAccessTokenBearerRow) (appName, appSlug string, err error) {
	row := tx.QueryRow(ctx, `
SELECT a.name, a.slug::text
  FROM app_installations i
  JOIN developer_apps a ON a.id = i.app_id
 WHERE i.id = $1::uuid
   AND i.tenant_id = $2::uuid
   AND i.app_id = $3::uuid
   AND i.status = 'installed'
   AND a.app_type = 'public'
   AND a.distribution IN ('marketplace','partner_catalog')
   AND a.status IN ('approved','active')
 LIMIT 1`, token.InstallationID, token.InstallingTenantID, token.AppID)
	if err := row.Scan(&appName, &appSlug); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", "", apikeys.ErrInvalidKey
		}
		return "", "", err
	}
	return appName, appSlug, nil
}

func getTenantForOAuthBearerTx(ctx context.Context, tx pgx.Tx, tenantID string) (*middleware.Tenant, error) {
	row := tx.QueryRow(ctx, `
SELECT id::text, slug, name, tier
  FROM tenants
 WHERE id::text = $1`, tenantID)
	var tenant middleware.Tenant
	if err := row.Scan(&tenant.ID, &tenant.Slug, &tenant.Name, &tenant.Tier); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, apikeys.ErrInvalidKey
		}
		return nil, err
	}
	return &tenant, nil
}

func apiKeyScopesFromMarketplaceScopes(scopes []string) []apikeys.Scope {
	out := make([]apikeys.Scope, 0, len(scopes))
	for _, scope := range cleanStrings(scopes) {
		if apikeys.IsValidScope(scope) {
			out = append(out, apikeys.Scope(scope))
		}
	}
	return out
}

func oauthBearerActorLabel(appName, appSlug, clientID, installationID string) string {
	name := strings.TrimSpace(appSlug)
	if name == "" {
		name = strings.TrimSpace(appName)
	}
	if name == "" {
		name = strings.TrimSpace(clientID)
	}
	if installationID == "" {
		return fmt.Sprintf("developer-marketplace:%s", name)
	}
	return fmt.Sprintf("developer-marketplace:%s:%s", name, installationID)
}
