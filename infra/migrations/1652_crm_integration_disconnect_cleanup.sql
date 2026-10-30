-- Persist CRM provider cleanup evidence and tighten HubSpot public webhook lookup
-- to rows that should still mutate Postwave state.

BEGIN;

CREATE INDEX IF NOT EXISTS crm_integrations_hubspot_portal_active_idx
    ON crm_integrations (
        (COALESCE(settings->>'hubspot_portal_id', settings->>'portal_id')),
        updated_at DESC
    )
    WHERE provider = 'hubspot'
      AND status IN ('connected', 'active');

DROP POLICY IF EXISTS crm_integrations_hubspot_webhook_lookup ON crm_integrations;
CREATE POLICY crm_integrations_hubspot_webhook_lookup ON crm_integrations
    FOR SELECT
    USING (
        provider = NULLIF(current_setting('app.crm_provider', true), '')
        AND provider = 'hubspot'
        AND status IN ('connected', 'active')
        AND (
            settings->>'hubspot_portal_id' =
                NULLIF(current_setting('app.crm_webhook_portal_id', true), '')
            OR settings->>'portal_id' =
                NULLIF(current_setting('app.crm_webhook_portal_id', true), '')
        )
    );

UPDATE crm_integrations
   SET settings = COALESCE(settings, '{}'::jsonb) ||
       jsonb_build_object(
           'provider_cleanup',
           jsonb_build_object(
               'provider', provider,
               'status', 'operator_action_required',
               'recorded_at', to_jsonb(now()),
               'postwave_status', 'disconnected',
               'provider_cleanup_posture', CASE provider
                   WHEN 'hubspot' THEN 'mixed_postwave_oauth_operator_hubspot_console'
                   WHEN 'salesforce' THEN 'mixed_postwave_oauth_operator_salesforce_console'
                   WHEN 'pipedrive' THEN 'mixed_postwave_webhook_oauth_operator_pipedrive_console'
                   ELSE 'operator_managed_provider_console'
               END,
               'managed_provider_cleanup', false,
               'provider_scope_type', CASE provider
                   WHEN 'hubspot' THEN 'hubspot_portal_id'
                   WHEN 'salesforce' THEN 'salesforce_org_id'
                   WHEN 'pipedrive' THEN 'pipedrive_company_id'
                   ELSE 'crm_provider_account'
               END,
               'provider_scope_id', CASE provider
                   WHEN 'hubspot' THEN COALESCE(settings->>'portal_id', settings->>'hubspot_portal_id', '')
                   WHEN 'salesforce' THEN COALESCE(settings->>'org_id', '')
                   WHEN 'pipedrive' THEN COALESCE(settings->>'pipedrive_company_id', settings->>'company_id', '')
                   ELSE ''
               END,
               'credential_ref_present',
                   COALESCE(NULLIF(credentials_ref, ''), NULLIF(settings->>'credentials_ref', '')) IS NOT NULL,
               'webhook_cleanup_status', CASE provider
                   WHEN 'hubspot' THEN 'app_level_webhook_subscription_shared_no_per_tenant_cleanup'
                   WHEN 'salesforce' THEN 'operator_review_connected_app_or_streaming_subscription_cleanup'
                   WHEN 'pipedrive' THEN 'operator_review_duplicate_or_manual_webhooks'
                   ELSE 'operator_review_provider_webhooks'
               END,
               'credential_cleanup_status', 'operator_revoke_or_rotate_if_no_longer_used',
               'postwave_effects', jsonb_build_array(
                   'local CRM integration is marked disconnected',
                   'manual and scheduled CRM pulls stop for this integration',
                   'provider webhook callbacks no longer resolve disconnected rows',
                   'CRM sync and webhook audit history is retained'
               ),
               'provider_console_actions', jsonb_build_array(
                   'review provider-side apps, API keys, OAuth installs, webhooks, and tokens for cleanup'
               ),
               'provider_cleanup_evidence', jsonb_build_array(
                   'Postwave recorded this cleanup evidence for a pre-existing disconnected CRM integration'
               )
           )
       )
 WHERE status = 'disconnected'
   AND NOT (COALESCE(settings, '{}'::jsonb) ? 'provider_cleanup');

COMMIT;
