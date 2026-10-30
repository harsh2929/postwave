// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
)

// FindSupportIntegrationByIngestToken is the archived public-token resolver.
// It remains in the repository contract for source compatibility, but always
// returns ErrSupportRuntimeHeld before normalizing the token or opening a
// transaction. Migration 1993 removed its former pre-tenant RLS policy.
func (r *Repo) FindSupportIntegrationByIngestToken(ctx context.Context, token string) (*Integration, error) {
	if err := enforceSupportRuntimeReleaseHold(); err != nil {
		return nil, err
	}
	token = strings.TrimSpace(token)
	if token == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true), set_config('app.support_ingest_token', $1, true)`, token); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, provider, name, status, scopes,
       credentials_ref, settings, sync_cursor, last_sync_at,
       error_message, created_at, updated_at
  FROM support_integrations
 WHERE settings->>'support_ingest_token' = $1
   AND status IN ('connected', 'active', 'paused', 'error')
 ORDER BY updated_at DESC
 LIMIT 1`, token)
	out, err := scanIntegration(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) FindZendeskIntegrationBySubdomain(ctx context.Context, subdomain, webhookID string) (*Integration, error) {
	if err := enforceSupportRuntimeReleaseHold(); err != nil {
		return nil, err
	}
	subdomain = strings.ToLower(strings.TrimSpace(subdomain))
	webhookID = strings.TrimSpace(webhookID)
	if subdomain == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true), set_config('app.support_provider', 'zendesk', true), set_config('app.support_zendesk_subdomain', $1, true), set_config('app.support_zendesk_webhook_id', $2, true)`, subdomain, webhookID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
WITH matched AS (
    SELECT id::text, tenant_id::text, provider, name, status, scopes,
           credentials_ref, settings, sync_cursor, last_sync_at,
           error_message, created_at, updated_at
      FROM support_integrations
     WHERE provider = 'zendesk'
       AND status IN ('connected', 'active', 'paused', 'error')
       AND (
            lower(COALESCE(settings->>'subdomain', '')) = lower($1)
         OR lower(COALESCE(settings->>'zendesk_subdomain', '')) = lower($1)
         OR lower(COALESCE(settings->>'provider_subdomain', '')) = lower($1)
       )
       AND (
            ($2 <> '' AND COALESCE(settings->>'zendesk_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = $2)
         OR ($2 = '' AND COALESCE(settings->>'zendesk_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = '')
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
 LIMIT 1`, subdomain, webhookID)
	out, err := scanIntegration(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) FindIntercomIntegrationByWorkspace(ctx context.Context, workspaceID string) (*Integration, error) {
	if err := enforceSupportRuntimeReleaseHold(); err != nil {
		return nil, err
	}
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true), set_config('app.support_provider', 'intercom', true), set_config('app.support_intercom_workspace_id', $1, true)`, workspaceID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, provider, name, status, scopes,
       credentials_ref, settings, sync_cursor, last_sync_at,
       error_message, created_at, updated_at
  FROM support_integrations
 WHERE provider = 'intercom'
   AND status IN ('connected', 'active', 'paused', 'error')
   AND (
        COALESCE(settings->>'workspace_id', '') = $1
     OR COALESCE(settings->>'intercom_workspace_id', '') = $1
     OR COALESCE(settings->>'app_id', '') = $1
   )
 ORDER BY updated_at DESC
 LIMIT 1`, workspaceID)
	out, err := scanIntegration(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) FindGorgiasIntegrationByDomain(ctx context.Context, accountDomain, integrationID string) (*Integration, error) {
	if err := enforceSupportRuntimeReleaseHold(); err != nil {
		return nil, err
	}
	accountDomain = normalizeGorgiasWebhookDomain(accountDomain)
	integrationID = strings.TrimSpace(integrationID)
	if accountDomain == "" {
		return nil, ErrNotFound
	}
	bareDomain := strings.TrimSuffix(accountDomain, ".gorgias.com")
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true), set_config('app.support_provider', 'gorgias', true), set_config('app.support_gorgias_domain', $1, true), set_config('app.support_gorgias_bare_domain', $2, true), set_config('app.support_gorgias_integration_id', $3, true)`, accountDomain, bareDomain, integrationID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
WITH candidates AS (
  SELECT id::text, tenant_id::text, provider, name, status, scopes,
         credentials_ref, settings, sync_cursor, last_sync_at,
         error_message, created_at, updated_at,
         lower(trim(both '/' from regexp_replace(COALESCE(settings->>'account_domain', settings->>'domain', settings->>'subdomain', ''), '^https?://', ''))) AS normalized_domain,
         COALESCE(settings->>'gorgias_http_integration_id', settings->>'gorgias_integration_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') AS configured_integration_id
    FROM support_integrations
   WHERE provider = 'gorgias'
     AND status IN ('connected', 'active', 'paused', 'error')
),
matched AS (
  SELECT id, tenant_id, provider, name, status, scopes,
         credentials_ref, settings, sync_cursor, last_sync_at,
         error_message, created_at, updated_at
    FROM candidates
   WHERE (
          normalized_domain = lower($1)
       OR normalized_domain = lower($2)
       OR normalized_domain = lower($2 || '.gorgias.com')
       OR regexp_replace(normalized_domain, '\.gorgias\.com$', '') = lower($2)
     )
     AND (
          ($3 <> '' AND configured_integration_id = $3)
       OR ($3 = '' AND configured_integration_id = '')
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
 LIMIT 1`, accountDomain, bareDomain, integrationID)
	out, err := scanIntegration(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) FindFreshdeskIntegrationByDomain(ctx context.Context, accountDomain, webhookID string) (*Integration, error) {
	if err := enforceSupportRuntimeReleaseHold(); err != nil {
		return nil, err
	}
	accountDomain = normalizeFreshdeskWebhookDomain(accountDomain)
	webhookID = strings.TrimSpace(webhookID)
	if accountDomain == "" {
		return nil, ErrNotFound
	}
	fullDomain := accountDomain + ".freshdesk.com"
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true), set_config('app.support_provider', 'freshdesk', true), set_config('app.support_freshdesk_domain', $1, true), set_config('app.support_freshdesk_full_domain', $2, true), set_config('app.support_freshdesk_webhook_id', $3, true)`, accountDomain, fullDomain, webhookID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
WITH candidates AS (
  SELECT id::text, tenant_id::text, provider, name, status, scopes,
         credentials_ref, settings, sync_cursor, last_sync_at,
         error_message, created_at, updated_at,
         lower(trim(both '/' from regexp_replace(COALESCE(settings->>'account_domain', settings->>'domain', settings->>'subdomain', ''), '^https?://', ''))) AS normalized_domain
    FROM support_integrations
   WHERE provider = 'freshdesk'
     AND status IN ('connected', 'active', 'paused', 'error')
)
SELECT id, tenant_id, provider, name, status, scopes,
       credentials_ref, settings, sync_cursor, last_sync_at,
       error_message, created_at, updated_at
  FROM candidates
 WHERE (
        regexp_replace(normalized_domain, '\.freshdesk\.com$', '') = lower($1)
     OR normalized_domain = lower($1)
     OR normalized_domain = lower($2)
   )
   AND (
        $3 = ''
     OR COALESCE(settings->>'freshdesk_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = ''
     OR COALESCE(settings->>'freshdesk_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = $3
   )
 ORDER BY
   CASE WHEN COALESCE(settings->>'freshdesk_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = $3 AND $3 <> '' THEN 0 ELSE 1 END,
   updated_at DESC
 LIMIT 1`, accountDomain, fullDomain, webhookID)
	out, err := scanIntegration(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) FindFreshchatIntegrationByDomain(ctx context.Context, accountDomain, webhookID string) (*Integration, error) {
	if err := enforceSupportRuntimeReleaseHold(); err != nil {
		return nil, err
	}
	accountDomain = normalizeFreshchatWebhookDomain(accountDomain)
	webhookID = strings.TrimSpace(webhookID)
	if accountDomain == "" {
		return nil, ErrNotFound
	}
	freshchatDomain := accountDomain + ".freshchat.com"
	freshworksDomain := accountDomain + ".myfreshworks.com"
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true), set_config('app.support_provider', 'freshchat', true), set_config('app.support_freshchat_domain', $1, true), set_config('app.support_freshchat_full_domain', $2, true), set_config('app.support_freshchat_freshworks_domain', $3, true), set_config('app.support_freshchat_webhook_id', $4, true)`, accountDomain, freshchatDomain, freshworksDomain, webhookID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
WITH candidates AS (
  SELECT id::text, tenant_id::text, provider, name, status, scopes,
         credentials_ref, settings, sync_cursor, last_sync_at,
         error_message, created_at, updated_at,
         lower(trim(both '/' from regexp_replace(COALESCE(settings->>'account_domain', settings->>'domain', settings->>'workspace_url', ''), '^https?://', ''))) AS normalized_domain
    FROM support_integrations
   WHERE provider = 'freshchat'
     AND status IN ('connected', 'active', 'paused', 'error')
),
matched AS (
  SELECT id, tenant_id, provider, name, status, scopes,
         credentials_ref, settings, sync_cursor, last_sync_at,
         error_message, created_at, updated_at
    FROM candidates
   WHERE (
          regexp_replace(regexp_replace(normalized_domain, '\.freshchat\.com$', ''), '\.myfreshworks\.com$', '') = lower($1)
       OR normalized_domain = lower($1)
       OR normalized_domain = lower($2)
       OR normalized_domain = lower($3)
     )
     AND (
          ($4 <> '' AND COALESCE(settings->>'freshchat_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = $4)
       OR ($4 = '' AND COALESCE(settings->>'freshchat_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = '')
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
 LIMIT 1`, accountDomain, freshchatDomain, freshworksDomain, webhookID)
	out, err := scanIntegration(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) FindTidioIntegrationByProject(ctx context.Context, projectPublicKey, webhookID string) (*Integration, error) {
	if err := enforceSupportRuntimeReleaseHold(); err != nil {
		return nil, err
	}
	projectPublicKey = normalizeTidioProjectPublicKey(projectPublicKey)
	webhookID = strings.TrimSpace(webhookID)
	if projectPublicKey == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true), set_config('app.support_provider', 'tidio', true), set_config('app.support_tidio_project_public_key', $1, true), set_config('app.support_tidio_webhook_id', $2, true)`, projectPublicKey, webhookID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
WITH candidates AS (
  SELECT id::text, tenant_id::text, provider, name, status, scopes,
         credentials_ref, settings, sync_cursor, last_sync_at,
         error_message, created_at, updated_at,
         lower(COALESCE(settings->>'project_public_key', settings->>'tidio_project_public_key', settings->>'provider_project_public_key', '')) AS configured_project_public_key,
         COALESCE(settings->>'tidio_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') AS configured_webhook_id
    FROM support_integrations
   WHERE provider = 'tidio'
     AND status IN ('connected', 'active', 'paused', 'error')
),
matched AS (
  SELECT id, tenant_id, provider, name, status, scopes,
         credentials_ref, settings, sync_cursor, last_sync_at,
         error_message, created_at, updated_at
    FROM candidates
   WHERE configured_project_public_key = lower($1)
     AND (
          configured_webhook_id = ''
       OR ($2 <> '' AND configured_webhook_id = $2)
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
 LIMIT 1`, projectPublicKey, webhookID)
	out, err := scanIntegration(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) FindAdaIntegrationByAgent(ctx context.Context, aiAgentDomain, webhookID string) (*Integration, error) {
	if err := enforceSupportRuntimeReleaseHold(); err != nil {
		return nil, err
	}
	aiAgentDomain = normalizeAdaAgentDomain(aiAgentDomain)
	webhookID = strings.TrimSpace(webhookID)
	if aiAgentDomain == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true), set_config('app.support_provider', 'ada', true), set_config('app.support_ada_ai_agent_domain', $1, true), set_config('app.support_ada_webhook_id', $2, true)`, aiAgentDomain, webhookID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
WITH candidates AS (
  SELECT id::text, tenant_id::text, provider, name, status, scopes,
         credentials_ref, settings, sync_cursor, last_sync_at,
         error_message, created_at, updated_at,
         lower(split_part(trim(both '/' from regexp_replace(COALESCE(settings->>'ai_agent_domain', settings->>'ada_ai_agent_domain', settings->>'bot_id', settings->>'provider_ai_agent_domain', settings->>'provider_domain', ''), '^https?://', '')), '/', 1)) AS configured_ai_agent_domain,
         COALESCE(settings->>'ada_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') AS configured_webhook_id
    FROM support_integrations
   WHERE provider = 'ada'
     AND status IN ('connected', 'active', 'paused', 'error')
),
matched AS (
  SELECT id, tenant_id, provider, name, status, scopes,
         credentials_ref, settings, sync_cursor, last_sync_at,
         error_message, created_at, updated_at
    FROM candidates
   WHERE configured_ai_agent_domain = lower($1)
     AND (
          configured_webhook_id = ''
       OR ($2 <> '' AND configured_webhook_id = $2)
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
 LIMIT 1`, aiAgentDomain, webhookID)
	out, err := scanIntegration(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) FindHelpScoutIntegrationByMailbox(ctx context.Context, mailboxID, webhookID string) (*Integration, error) {
	if err := enforceSupportRuntimeReleaseHold(); err != nil {
		return nil, err
	}
	mailboxID = strings.TrimSpace(mailboxID)
	webhookID = strings.TrimSpace(webhookID)
	if mailboxID == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true), set_config('app.support_provider', 'help-scout', true), set_config('app.support_helpscout_mailbox_id', $1, true), set_config('app.support_helpscout_webhook_id', $2, true)`, mailboxID, webhookID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, provider, name, status, scopes,
       credentials_ref, settings, sync_cursor, last_sync_at,
       error_message, created_at, updated_at
  FROM support_integrations
 WHERE provider = 'help-scout'
   AND status IN ('connected', 'active', 'paused', 'error')
   AND (
        COALESCE(settings->>'mailbox_id', '') = $1
     OR COALESCE(settings->>'help_scout_mailbox_id', '') = $1
     OR COALESCE(settings->>'provider_mailbox_id', '') = $1
   )
   AND (
        $2 = ''
     OR COALESCE(settings->>'help_scout_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = ''
     OR COALESCE(settings->>'help_scout_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = $2
   )
 ORDER BY
   CASE WHEN COALESCE(settings->>'help_scout_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = $2 AND $2 <> '' THEN 0 ELSE 1 END,
   updated_at DESC
 LIMIT 1`, mailboxID, webhookID)
	out, err := scanIntegration(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) FindGladlyIntegrationByOrganization(ctx context.Context, organizationDomain, webhookID string) (*Integration, error) {
	if err := enforceSupportRuntimeReleaseHold(); err != nil {
		return nil, err
	}
	organizationDomain = normalizeGladlyOrganizationDomain(organizationDomain)
	webhookID = strings.TrimSpace(webhookID)
	if organizationDomain == "" {
		return nil, ErrNotFound
	}
	bareDomain := strings.TrimSuffix(strings.TrimSuffix(organizationDomain, ".gladly.com"), ".gladly.qa")
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true), set_config('app.support_provider', 'gladly', true), set_config('app.support_gladly_organization_domain', $1, true), set_config('app.support_gladly_bare_domain', $2, true), set_config('app.support_gladly_webhook_id', $3, true)`, organizationDomain, bareDomain, webhookID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
WITH candidates AS (
  SELECT id::text, tenant_id::text, provider, name, status, scopes,
         credentials_ref, settings, sync_cursor, last_sync_at,
         error_message, created_at, updated_at,
         lower(split_part(trim(both '/' from regexp_replace(COALESCE(settings->>'organization_domain', settings->>'organization_id', settings->>'gladly_organization_domain', settings->>'account_domain', settings->>'domain', settings->>'subdomain', ''), '^https?://', '')), '/', 1)) AS normalized_domain,
         COALESCE(settings->>'gladly_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') AS configured_webhook_id
    FROM support_integrations
   WHERE provider = 'gladly'
     AND status IN ('connected', 'active', 'paused', 'error')
),
matched AS (
  SELECT id, tenant_id, provider, name, status, scopes,
         credentials_ref, settings, sync_cursor, last_sync_at,
         error_message, created_at, updated_at
    FROM candidates
   WHERE (
          normalized_domain = lower($1)
       OR normalized_domain = lower($2)
       OR normalized_domain = lower($2 || '.gladly.com')
       OR normalized_domain = lower($2 || '.gladly.qa')
       OR regexp_replace(regexp_replace(normalized_domain, '\.gladly\.com$', ''), '\.gladly\.qa$', '') = lower($2)
     )
     AND (
          ($3 <> '' AND configured_webhook_id = $3)
       OR ($3 = '' AND configured_webhook_id = '')
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
 LIMIT 1`, organizationDomain, bareDomain, webhookID)
	out, err := scanIntegration(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) FindGrooveIntegrationByMailbox(ctx context.Context, mailboxID, webhookID string) (*Integration, error) {
	if err := enforceSupportRuntimeReleaseHold(); err != nil {
		return nil, err
	}
	mailboxID = strings.TrimSpace(mailboxID)
	webhookID = strings.TrimSpace(webhookID)
	if mailboxID == "" || webhookID == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true), set_config('app.support_provider', 'groove', true), set_config('app.support_groove_mailbox_id', $1, true), set_config('app.support_groove_webhook_id', $2, true)`, mailboxID, webhookID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
WITH matched AS (
    SELECT id::text, tenant_id::text, provider, name, status, scopes,
           credentials_ref, settings, sync_cursor, last_sync_at,
           error_message, created_at, updated_at
      FROM support_integrations
     WHERE provider = 'groove'
       AND status IN ('connected', 'active', 'paused', 'error')
       AND (
            COALESCE(settings->>'mailbox_id', '') = $1
         OR COALESCE(settings->>'provider_mailbox_id', '') = $1
         OR COALESCE(settings->>'groove_mailbox_id', '') = $1
       )
       AND COALESCE(settings->>'groove_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = $2
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
 LIMIT 1`, mailboxID, webhookID)
	out, err := scanIntegration(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) FindReamazeIntegrationByDomain(ctx context.Context, accountDomain, webhookID string) (*Integration, error) {
	if err := enforceSupportRuntimeReleaseHold(); err != nil {
		return nil, err
	}
	accountDomain = normalizeReamazeAccountDomain(accountDomain)
	webhookID = strings.TrimSpace(webhookID)
	if accountDomain == "" || webhookID == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true), set_config('app.support_provider', 'reamaze', true), set_config('app.support_reamaze_account_domain', $1, true), set_config('app.support_reamaze_webhook_id', $2, true)`, accountDomain, webhookID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
WITH candidates AS (
  SELECT id::text, tenant_id::text, provider, name, status, scopes,
         credentials_ref, settings, sync_cursor, last_sync_at,
         error_message, created_at, updated_at,
         lower(trim(both '/' from regexp_replace(COALESCE(settings->>'account_domain', settings->>'brand', settings->>'subdomain', settings->>'domain', ''), '^https?://', ''))) AS normalized_domain,
         COALESCE(settings->>'reamaze_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') AS configured_webhook_id
    FROM support_integrations
   WHERE provider = 'reamaze'
     AND status IN ('connected', 'active', 'paused', 'error')
),
matched AS (
  SELECT id, tenant_id, provider, name, status, scopes,
         credentials_ref, settings, sync_cursor, last_sync_at,
         error_message, created_at, updated_at
    FROM candidates
   WHERE (
          normalized_domain = lower($1)
       OR regexp_replace(regexp_replace(normalized_domain, '\.reamaze\.io$', ''), '\.reamaze\.com$', '') = lower($1)
     )
     AND configured_webhook_id = $2
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
 LIMIT 1`, accountDomain, webhookID)
	out, err := scanIntegration(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) FindHelpCrunchIntegrationByOrganization(ctx context.Context, organizationID, webhookID string) (*Integration, error) {
	if err := enforceSupportRuntimeReleaseHold(); err != nil {
		return nil, err
	}
	organizationID = strings.TrimSpace(organizationID)
	webhookID = strings.TrimSpace(webhookID)
	if organizationID == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true), set_config('app.support_provider', 'helpcrunch', true), set_config('app.support_helpcrunch_organization_id', $1, true), set_config('app.support_helpcrunch_webhook_id', $2, true)`, organizationID, webhookID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
WITH candidates AS (
  SELECT id::text, tenant_id::text, provider, name, status, scopes,
         credentials_ref, settings, sync_cursor, last_sync_at,
         error_message, created_at, updated_at,
         COALESCE(settings->>'organization_id', settings->>'helpcrunch_organization_id', settings->>'provider_organization_id', '') AS configured_organization_id,
         COALESCE(settings->>'helpcrunch_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') AS configured_webhook_id
    FROM support_integrations
   WHERE provider = 'helpcrunch'
     AND status IN ('connected', 'active', 'paused', 'error')
),
matched AS (
  SELECT id, tenant_id, provider, name, status, scopes,
         credentials_ref, settings, sync_cursor, last_sync_at,
         error_message, created_at, updated_at
    FROM candidates
   WHERE configured_organization_id = $1
     AND (
          $2 = ''
       OR configured_webhook_id = ''
       OR configured_webhook_id = $2
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
 LIMIT 1`, organizationID, webhookID)
	out, err := scanIntegration(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) FindJiraServiceManagementIntegrationBySite(ctx context.Context, siteID, webhookID string) (*Integration, error) {
	if err := enforceSupportRuntimeReleaseHold(); err != nil {
		return nil, err
	}
	siteID = normalizeJiraServiceManagementSiteLookup(siteID)
	webhookID = strings.TrimSpace(webhookID)
	if siteID == "" || webhookID == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true), set_config('app.support_provider', 'jira-service-management', true), set_config('app.support_jira_service_site_id', $1, true), set_config('app.support_jira_service_webhook_id', $2, true)`, siteID, webhookID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
WITH candidates AS (
  SELECT id::text, tenant_id::text, provider, name, status, scopes,
         credentials_ref, settings, sync_cursor, last_sync_at,
         error_message, created_at, updated_at,
         lower(trim(both '/' from regexp_replace(COALESCE(settings->>'site_id', settings->>'cloud_id', settings->>'site_url', settings->>'atlassian_site_id', ''), '^https?://', ''))) AS normalized_site,
         COALESCE(settings->>'jira_service_management_webhook_id', settings->>'jira_service_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') AS configured_webhook_id
    FROM support_integrations
   WHERE provider = 'jira-service-management'
     AND status IN ('connected', 'active', 'paused', 'error')
),
matched AS (
  SELECT id, tenant_id, provider, name, status, scopes,
         credentials_ref, settings, sync_cursor, last_sync_at,
         error_message, created_at, updated_at
    FROM candidates
   WHERE (
          normalized_site = lower($1)
       OR regexp_replace(normalized_site, '\.atlassian\.net$', '') = lower($1)
     )
     AND configured_webhook_id = $2
)
SELECT id, tenant_id, provider, name, status, scopes,
       credentials_ref, settings, sync_cursor, last_sync_at,
       error_message, created_at, updated_at
  FROM matched
 ORDER BY updated_at DESC
 LIMIT 1`, siteID, webhookID)
	out, err := scanIntegration(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) FindLinearIntegrationByWorkspace(ctx context.Context, workspaceID, webhookID string) (*Integration, error) {
	if err := enforceSupportRuntimeReleaseHold(); err != nil {
		return nil, err
	}
	workspaceID = strings.TrimSpace(workspaceID)
	webhookID = strings.TrimSpace(webhookID)
	if workspaceID == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true), set_config('app.support_provider', 'linear', true), set_config('app.support_linear_workspace_id', $1, true), set_config('app.support_linear_webhook_id', $2, true)`, workspaceID, webhookID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, provider, name, status, scopes,
       credentials_ref, settings, sync_cursor, last_sync_at,
       error_message, created_at, updated_at
  FROM support_integrations
 WHERE provider = 'linear'
   AND status IN ('connected', 'active', 'paused', 'error')
   AND COALESCE(settings->>'workspace_id', settings->>'organization_id', settings->>'linear_workspace_id', settings->>'provider_workspace_id', '') = $1
   AND (
        $2 = ''
     OR COALESCE(settings->>'linear_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = ''
     OR COALESCE(settings->>'linear_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = $2
   )
 ORDER BY
   CASE WHEN COALESCE(settings->>'linear_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = $2 AND $2 <> '' THEN 0 ELSE 1 END,
   updated_at DESC
 LIMIT 1`, workspaceID, webhookID)
	out, err := scanIntegration(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) FindAsanaSupportIntegrationByWorkspace(ctx context.Context, workspaceID, webhookID string) (*Integration, error) {
	if err := enforceSupportRuntimeReleaseHold(); err != nil {
		return nil, err
	}
	workspaceID = strings.TrimSpace(workspaceID)
	webhookID = strings.TrimSpace(webhookID)
	if workspaceID == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true), set_config('app.support_provider', 'asana-support', true), set_config('app.support_asana_workspace_id', $1, true), set_config('app.support_asana_webhook_id', $2, true)`, workspaceID, webhookID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, provider, name, status, scopes,
       credentials_ref, settings, sync_cursor, last_sync_at,
       error_message, created_at, updated_at
  FROM support_integrations
 WHERE provider = 'asana-support'
   AND status IN ('connected', 'active', 'paused', 'error')
   AND COALESCE(settings->>'workspace_id', settings->>'organization_id', settings->>'asana_workspace_id', settings->>'provider_workspace_id', '') = $1
   AND (
        $2 = ''
     OR COALESCE(settings->>'asana_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = ''
     OR COALESCE(settings->>'asana_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = $2
   )
 ORDER BY
   CASE WHEN COALESCE(settings->>'asana_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = $2 AND $2 <> '' THEN 0 ELSE 1 END,
   updated_at DESC
 LIMIT 1`, workspaceID, webhookID)
	out, err := scanIntegration(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) FindClickUpSupportIntegrationByWorkspace(ctx context.Context, workspaceID, webhookID string) (*Integration, error) {
	if err := enforceSupportRuntimeReleaseHold(); err != nil {
		return nil, err
	}
	workspaceID = strings.TrimSpace(workspaceID)
	webhookID = strings.TrimSpace(webhookID)
	if workspaceID == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true), set_config('app.support_provider', 'clickup-support', true), set_config('app.support_clickup_workspace_id', $1, true), set_config('app.support_clickup_webhook_id', $2, true)`, workspaceID, webhookID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, provider, name, status, scopes,
       credentials_ref, settings, sync_cursor, last_sync_at,
       error_message, created_at, updated_at
  FROM support_integrations
 WHERE provider = 'clickup-support'
   AND status IN ('connected', 'active', 'paused', 'error')
   AND COALESCE(settings->>'workspace_id', settings->>'team_id', settings->>'clickup_workspace_id', settings->>'provider_workspace_id', '') = $1
   AND (
        $2 = ''
     OR COALESCE(settings->>'clickup_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = ''
     OR COALESCE(settings->>'clickup_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = $2
   )
 ORDER BY
   CASE WHEN COALESCE(settings->>'clickup_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = $2 AND $2 <> '' THEN 0 ELSE 1 END,
   updated_at DESC
 LIMIT 1`, workspaceID, webhookID)
	out, err := scanIntegration(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) FindFrontIntegrationByInbox(ctx context.Context, inboxID, webhookID string) (*Integration, error) {
	if err := enforceSupportRuntimeReleaseHold(); err != nil {
		return nil, err
	}
	inboxID = strings.TrimSpace(inboxID)
	webhookID = strings.TrimSpace(webhookID)
	if inboxID == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true), set_config('app.support_provider', 'front', true), set_config('app.support_front_inbox_id', $1, true), set_config('app.support_front_webhook_id', $2, true)`, inboxID, webhookID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
WITH matched AS (
    SELECT id::text, tenant_id::text, provider, name, status, scopes,
           credentials_ref, settings, sync_cursor, last_sync_at,
           error_message, created_at, updated_at
      FROM support_integrations
     WHERE provider = 'front'
       AND status IN ('connected', 'active', 'paused', 'error')
       AND (
            COALESCE(settings->>'inbox_id', '') = $1
         OR COALESCE(settings->>'front_inbox_id', '') = $1
         OR COALESCE(settings->>'provider_inbox_id', '') = $1
       )
       AND (
            ($2 <> '' AND COALESCE(settings->>'front_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = $2)
         OR ($2 = '' AND COALESCE(settings->>'front_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = '')
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
 LIMIT 1`, inboxID, webhookID)
	out, err := scanIntegration(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) FindCrispIntegrationByWebsite(ctx context.Context, websiteID, webhookID string) (*Integration, error) {
	if err := enforceSupportRuntimeReleaseHold(); err != nil {
		return nil, err
	}
	websiteID = strings.TrimSpace(websiteID)
	webhookID = strings.TrimSpace(webhookID)
	if websiteID == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true), set_config('app.support_provider', 'crisp', true), set_config('app.support_crisp_website_id', $1, true), set_config('app.support_crisp_webhook_id', $2, true)`, websiteID, webhookID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
WITH matched AS (
    SELECT id::text, tenant_id::text, provider, name, status, scopes,
           credentials_ref, settings, sync_cursor, last_sync_at,
           error_message, created_at, updated_at
      FROM support_integrations
     WHERE provider = 'crisp'
       AND status IN ('connected', 'active', 'paused', 'error')
       AND (
            COALESCE(settings->>'website_id', '') = $1
         OR COALESCE(settings->>'crisp_website_id', '') = $1
         OR COALESCE(settings->>'provider_website_id', '') = $1
       )
       AND (
            ($2 <> '' AND COALESCE(settings->>'crisp_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = $2)
         OR ($2 = '' AND COALESCE(settings->>'crisp_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = '')
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
 LIMIT 1`, websiteID, webhookID)
	out, err := scanIntegration(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) FindKustomerIntegrationByOrganization(ctx context.Context, organizationID, webhookID string) (*Integration, error) {
	if err := enforceSupportRuntimeReleaseHold(); err != nil {
		return nil, err
	}
	organizationID = strings.TrimSpace(organizationID)
	webhookID = strings.TrimSpace(webhookID)
	if organizationID == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true), set_config('app.support_provider', 'kustomer', true), set_config('app.support_kustomer_organization_id', $1, true), set_config('app.support_kustomer_webhook_id', $2, true)`, organizationID, webhookID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
WITH matched AS (
    SELECT id::text, tenant_id::text, provider, name, status, scopes,
           credentials_ref, settings, sync_cursor, last_sync_at,
           error_message, created_at, updated_at
      FROM support_integrations
     WHERE provider = 'kustomer'
       AND status IN ('connected', 'active', 'paused', 'error')
       AND (
            COALESCE(settings->>'organization_id', '') = $1
         OR COALESCE(settings->>'org_id', '') = $1
         OR COALESCE(settings->>'kustomer_organization_id', '') = $1
         OR COALESCE(settings->>'provider_organization_id', '') = $1
       )
       AND (
            ($2 <> '' AND COALESCE(settings->>'kustomer_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = $2)
         OR ($2 = '' AND COALESCE(settings->>'kustomer_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = '')
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
 LIMIT 1`, organizationID, webhookID)
	out, err := scanIntegration(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) FindDriftIntegrationByWorkspace(ctx context.Context, workspaceID, webhookID string) (*Integration, error) {
	if err := enforceSupportRuntimeReleaseHold(); err != nil {
		return nil, err
	}
	workspaceID = strings.TrimSpace(workspaceID)
	webhookID = strings.TrimSpace(webhookID)
	if workspaceID == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true), set_config('app.support_provider', 'drift', true), set_config('app.support_drift_workspace_id', $1, true), set_config('app.support_drift_webhook_id', $2, true)`, workspaceID, webhookID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
WITH matched AS (
    SELECT id::text, tenant_id::text, provider, name, status, scopes,
           credentials_ref, settings, sync_cursor, last_sync_at,
           error_message, created_at, updated_at
      FROM support_integrations
     WHERE provider = 'drift'
       AND status IN ('connected', 'active', 'paused', 'error')
       AND (
            COALESCE(settings->>'workspace_id', '') = $1
         OR COALESCE(settings->>'drift_workspace_id', '') = $1
         OR COALESCE(settings->>'organization_id', '') = $1
         OR COALESCE(settings->>'org_id', '') = $1
         OR COALESCE(settings->>'drift_organization_id', '') = $1
         OR COALESCE(settings->>'provider_workspace_id', '') = $1
         OR COALESCE(settings->>'provider_organization_id', '') = $1
       )
       AND (
            ($2 <> '' AND COALESCE(settings->>'drift_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = $2)
         OR ($2 = '' AND COALESCE(settings->>'drift_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = '')
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
 LIMIT 1`, workspaceID, webhookID)
	out, err := scanIntegration(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) FindLiveChatIntegrationByAccount(ctx context.Context, accountID, webhookID string) (*Integration, error) {
	if err := enforceSupportRuntimeReleaseHold(); err != nil {
		return nil, err
	}
	accountID = strings.TrimSpace(accountID)
	webhookID = strings.TrimSpace(webhookID)
	if accountID == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true), set_config('app.support_provider', 'livechat', true), set_config('app.support_livechat_account_id', $1, true), set_config('app.support_livechat_webhook_id', $2, true)`, accountID, webhookID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
WITH matched AS (
    SELECT id::text, tenant_id::text, provider, name, status, scopes,
           credentials_ref, settings, sync_cursor, last_sync_at,
           error_message, created_at, updated_at
      FROM support_integrations
     WHERE provider = 'livechat'
       AND status IN ('connected', 'active', 'paused', 'error')
       AND (
            COALESCE(settings->>'account_id', '') = $1
         OR COALESCE(settings->>'livechat_account_id', '') = $1
         OR COALESCE(settings->>'organization_id', '') = $1
         OR COALESCE(settings->>'livechat_organization_id', '') = $1
         OR COALESCE(settings->>'provider_account_id', '') = $1
         OR COALESCE(settings->>'provider_organization_id', '') = $1
       )
       AND (
            ($2 <> '' AND COALESCE(settings->>'livechat_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = $2)
         OR ($2 = '' AND COALESCE(settings->>'livechat_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = '')
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
 LIMIT 1`, accountID, webhookID)
	out, err := scanIntegration(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) FindOlarkIntegrationBySite(ctx context.Context, siteID, webhookID string) (*Integration, error) {
	if err := enforceSupportRuntimeReleaseHold(); err != nil {
		return nil, err
	}
	siteID = strings.TrimSpace(siteID)
	webhookID = strings.TrimSpace(webhookID)
	if siteID == "" || webhookID == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true), set_config('app.support_provider', 'olark', true), set_config('app.support_olark_site_id', $1, true), set_config('app.support_olark_webhook_id', $2, true)`, siteID, webhookID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
WITH matched AS (
    SELECT id::text, tenant_id::text, provider, name, status, scopes,
           credentials_ref, settings, sync_cursor, last_sync_at,
           error_message, created_at, updated_at
      FROM support_integrations
     WHERE provider = 'olark'
       AND status IN ('connected', 'active', 'paused', 'error')
       AND (
            COALESCE(settings->>'site_id', '') = $1
         OR COALESCE(settings->>'olark_site_id', '') = $1
         OR COALESCE(settings->>'provider_site_id', '') = $1
       )
       AND COALESCE(settings->>'olark_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = $2
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
 LIMIT 1`, siteID, webhookID)
	out, err := scanIntegration(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) FindKayakoIntegrationByDomain(ctx context.Context, accountDomain, webhookID string) (*Integration, error) {
	if err := enforceSupportRuntimeReleaseHold(); err != nil {
		return nil, err
	}
	accountDomain = normalizeKayakoWebhookDomain(accountDomain)
	webhookID = strings.TrimSpace(webhookID)
	if accountDomain == "" || webhookID == "" {
		return nil, ErrNotFound
	}
	fullDomain := accountDomain + ".kayako.com"
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true), set_config('app.support_provider', 'kayako', true), set_config('app.support_kayako_domain', $1, true), set_config('app.support_kayako_full_domain', $2, true), set_config('app.support_kayako_webhook_id', $3, true)`, accountDomain, fullDomain, webhookID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
WITH candidates AS (
  SELECT id::text, tenant_id::text, provider, name, status, scopes,
         credentials_ref, settings, sync_cursor, last_sync_at,
         error_message, created_at, updated_at,
         lower(trim(both '/' from regexp_replace(COALESCE(settings->>'account_domain', settings->>'domain', settings->>'subdomain', ''), '^https?://', ''))) AS normalized_domain
    FROM support_integrations
   WHERE provider = 'kayako'
     AND status IN ('connected', 'active', 'paused', 'error')
),
matched AS (
  SELECT id, tenant_id, provider, name, status, scopes,
         credentials_ref, settings, sync_cursor, last_sync_at,
         error_message, created_at, updated_at
    FROM candidates
   WHERE (
          regexp_replace(normalized_domain, '\.kayako\.com$', '') = lower($1)
       OR normalized_domain = lower($1)
       OR normalized_domain = lower($2)
     )
     AND COALESCE(settings->>'kayako_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = $3
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
 LIMIT 1`, accountDomain, fullDomain, webhookID)
	out, err := scanIntegration(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) FindHubSpotServiceHubIntegrationByPortal(ctx context.Context, portalID, webhookID string) (*Integration, error) {
	if err := enforceSupportRuntimeReleaseHold(); err != nil {
		return nil, err
	}
	portalID = strings.TrimSpace(portalID)
	webhookID = strings.TrimSpace(webhookID)
	if portalID == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true), set_config('app.support_provider', 'hubspot-service-hub', true), set_config('app.support_hubspot_portal_id', $1, true), set_config('app.support_hubspot_webhook_id', $2, true)`, portalID, webhookID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
WITH matched AS (
    SELECT id::text, tenant_id::text, provider, name, status, scopes,
           credentials_ref, settings, sync_cursor, last_sync_at,
           error_message, created_at, updated_at
      FROM support_integrations
     WHERE provider = 'hubspot-service-hub'
       AND status IN ('connected', 'active', 'paused', 'error')
       AND (
            COALESCE(settings->>'portal_id', '') = $1
         OR COALESCE(settings->>'hubspot_portal_id', '') = $1
         OR COALESCE(settings->>'hubspot_service_hub_portal_id', '') = $1
         OR COALESCE(settings->>'provider_portal_id', '') = $1
       )
       AND (
            ($2 <> '' AND COALESCE(settings->>'hubspot_service_hub_webhook_id', settings->>'hubspot_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = $2)
         OR ($2 = '' AND COALESCE(settings->>'hubspot_service_hub_webhook_id', settings->>'hubspot_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = '')
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
 LIMIT 1`, portalID, webhookID)
	out, err := scanIntegration(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) FindSalesforceServiceCloudIntegrationByInstance(ctx context.Context, instanceURL, webhookID string) (*Integration, error) {
	if err := enforceSupportRuntimeReleaseHold(); err != nil {
		return nil, err
	}
	instanceURL = normalizeSalesforceServiceCloudInstanceLookup(instanceURL)
	webhookID = strings.TrimSpace(webhookID)
	if instanceURL == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true), set_config('app.support_provider', 'salesforce-service-cloud', true), set_config('app.support_salesforce_service_cloud_instance_url', $1, true), set_config('app.support_salesforce_service_cloud_webhook_id', $2, true)`, instanceURL, webhookID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
WITH matched AS (
    SELECT id::text, tenant_id::text, provider, name, status, scopes,
           credentials_ref, settings, sync_cursor, last_sync_at,
           error_message, created_at, updated_at
      FROM support_integrations
     WHERE provider = 'salesforce-service-cloud'
       AND status IN ('connected', 'active', 'paused', 'error')
       AND (
            trim(trailing '/' from lower(COALESCE(settings->>'instance_url', ''))) = $1
         OR trim(trailing '/' from lower(COALESCE(settings->>'api_base_url', ''))) = $1
         OR trim(trailing '/' from lower(COALESCE(settings->>'salesforce_instance_url', ''))) = $1
         OR trim(trailing '/' from lower(COALESCE(settings->>'provider_instance_url', ''))) = $1
       )
       AND (
            ($2 <> '' AND COALESCE(settings->>'salesforce_service_cloud_webhook_id', settings->>'salesforce_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = $2)
         OR ($2 = '' AND COALESCE(settings->>'salesforce_service_cloud_webhook_id', settings->>'salesforce_webhook_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = '')
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
 LIMIT 1`, instanceURL, webhookID)
	out, err := scanIntegration(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) FindZohoDeskIntegrationByOrganization(ctx context.Context, organizationID, webhookID string) (*Integration, error) {
	if err := enforceSupportRuntimeReleaseHold(); err != nil {
		return nil, err
	}
	organizationID = strings.TrimSpace(organizationID)
	webhookID = strings.TrimSpace(webhookID)
	if organizationID == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true), set_config('app.support_provider', 'zoho-desk', true), set_config('app.support_zoho_desk_organization_id', $1, true), set_config('app.support_zoho_desk_webhook_id', $2, true)`, organizationID, webhookID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
WITH matched AS (
    SELECT id::text, tenant_id::text, provider, name, status, scopes,
           credentials_ref, settings, sync_cursor, last_sync_at,
           error_message, created_at, updated_at
      FROM support_integrations
     WHERE provider = 'zoho-desk'
       AND status IN ('connected', 'active', 'paused', 'error')
       AND (
            COALESCE(settings->>'organization_id', '') = $1
         OR COALESCE(settings->>'org_id', '') = $1
         OR COALESCE(settings->>'orgId', '') = $1
         OR COALESCE(settings->>'zoho_desk_organization_id', '') = $1
         OR COALESCE(settings->>'provider_organization_id', '') = $1
       )
       AND (
            ($2 <> '' AND COALESCE(settings->>'zoho_desk_webhook_id', settings->>'notification_channel_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = $2)
         OR ($2 = '' AND COALESCE(settings->>'zoho_desk_webhook_id', settings->>'notification_channel_id', settings->>'provider_webhook_id', settings->>'webhook_id', '') = '')
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
 LIMIT 1`, organizationID, webhookID)
	out, err := scanIntegration(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}
