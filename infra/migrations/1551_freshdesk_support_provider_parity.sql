-- 1551_freshdesk_support_provider_parity.sql
-- Promote Freshdesk from bridge-only catalog coverage into the managed
-- support/helpdesk connector control plane.

ALTER TABLE support_integrations
    DROP CONSTRAINT IF EXISTS support_integrations_provider_check;

ALTER TABLE support_integrations
    ADD CONSTRAINT support_integrations_provider_check
    CHECK (provider IN (
        'zendesk',
        'intercom',
        'gorgias',
        'freshdesk'
    ));
