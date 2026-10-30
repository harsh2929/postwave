-- 1567_support_chat_provider_parity.sql
-- Promote live chat, conversational support, and commerce support inbox tools
-- into the managed support integration control plane.

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
        'helpcrunch'
    ));
