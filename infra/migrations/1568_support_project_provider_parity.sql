-- 1568_support_project_provider_parity.sql
-- Promote service hubs and project/task-based support workflows into the
-- managed support integration control plane.

ALTER TABLE support_integrations
    DROP CONSTRAINT IF EXISTS support_integrations_provider_check;

ALTER TABLE support_integrations
    ADD CONSTRAINT support_integrations_provider_check
    CHECK (provider IN (
        'zendesk',
        'intercom',
        'gorgias',
        'freshdesk',
        'help-scout',
        'front',
        'zoho-desk',
        'kustomer',
        'freshchat',
        'livechat',
        'crisp',
        'tidio',
        'olark',
        'drift',
        'ada',
        'gladly',
        'reamaze',
        'groove',
        'kayako',
        'helpcrunch',
        'hubspot-service-hub',
        'salesforce-service-cloud',
        'jira-service-management',
        'linear',
        'asana-support',
        'clickup-support'
    ));
