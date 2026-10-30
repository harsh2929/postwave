-- Pipedrive OAuth uninstall callbacks resolve installs by provider identity.
-- Pipedrive sends client_id, company_id, and user_id to the OAuth callback URL
-- after a user uninstalls the app from Pipedrive; local cleanup then re-enters
-- normal tenant scope before mutating the integration row or credential secret.

CREATE INDEX IF NOT EXISTS crm_integrations_pipedrive_oauth_install_idx
    ON crm_integrations (
        (settings->>'pipedrive_oauth_client_id'),
        (settings->>'pipedrive_company_id'),
        (settings->>'pipedrive_user_id'),
        updated_at DESC
    )
    WHERE provider = 'pipedrive'
      AND status IN ('connected', 'active', 'paused', 'error');

DROP POLICY IF EXISTS crm_integrations_pipedrive_oauth_uninstall_lookup ON crm_integrations;
CREATE POLICY crm_integrations_pipedrive_oauth_uninstall_lookup ON crm_integrations
    FOR SELECT
    USING (
        provider = 'pipedrive'
        AND status IN ('connected', 'active', 'paused', 'error')
        AND settings->>'pipedrive_oauth_client_id' =
            NULLIF(current_setting('app.crm_oauth_client_id', true), '')
        AND settings->>'pipedrive_company_id' =
            NULLIF(current_setting('app.crm_oauth_company_id', true), '')
        AND settings->>'pipedrive_user_id' =
            NULLIF(current_setting('app.crm_oauth_user_id', true), '')
    );
