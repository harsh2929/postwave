-- 1556_support_provider_parity_helpdesk_batch.sql
-- Promote Help Scout, Front, and Zoho Desk into the managed support/helpdesk
-- connector control plane.

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
        'zoho-desk'
    ));
