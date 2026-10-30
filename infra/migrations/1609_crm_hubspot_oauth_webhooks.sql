-- HubSpot app-level webhooks deliver every install's events to one public
-- endpoint, each event tagged with a portalId (hub_id). The public webhook
-- handler resolves the owning integration by portalId before tenant context
-- exists, then re-enters normal tenant scope to process the event. HubSpot does
-- not send an inbound uninstall callback, so there is no uninstall-lookup policy
-- (unlike Pipedrive's 1605); disconnect revokes the refresh token via the API.
--
-- The OAuth-state (crm_oauth_states), encrypted-credential (crm_credential_secrets),
-- webhook-idempotency (crm_webhook_events), and cross-tenant worker-select
-- assets are already provider-agnostic (migrations 1602-1604), so HubSpot reuses
-- them with provider = 'hubspot'; only the portalId lookup is new.

CREATE INDEX IF NOT EXISTS crm_integrations_hubspot_portal_idx
    ON crm_integrations (
        (settings->>'hubspot_portal_id'),
        updated_at DESC
    )
    WHERE provider = 'hubspot'
      AND status IN ('connected', 'active', 'paused', 'error');

DROP POLICY IF EXISTS crm_integrations_hubspot_webhook_lookup ON crm_integrations;
CREATE POLICY crm_integrations_hubspot_webhook_lookup ON crm_integrations
    FOR SELECT
    USING (
        provider = NULLIF(current_setting('app.crm_provider', true), '')
        AND provider = 'hubspot'
        AND status IN ('connected', 'active', 'paused', 'error')
        AND settings->>'hubspot_portal_id' =
            NULLIF(current_setting('app.crm_webhook_portal_id', true), '')
    );
