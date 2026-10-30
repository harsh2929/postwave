-- 0379_suppression_mirror_sources.sql
--
-- GAP-LS-026 (desktop audit A6): ESP suppression mirror. The mirror
-- endpoint (POST /api/v1/suppressions/mirror/{provider}) upserts rows
-- pulled from external ESPs into subscriber_suppressions with the
-- provider recorded in `source` for provenance. Two constraint gaps
-- block that today:
--
--   1. subscriber_suppressions.source still carries the original 0081
--      CHECK list ('postmark','mailgun','ses','manual','api','import')
--      even though the Go-side ValidSources enum already accepts
--      sendgrid/resend/sparkpost/mailersend — any webhook or mirror
--      write attributed to those providers fails the CHECK. Mailchimp
--      (a pull-only mirror source, no webhook receiver) is added at
--      the same time.
--
--   2. tenant_deliverability_providers.provider (0327) — the per-tenant
--      credential store the mirror clients read API keys from — has the
--      same gap for 'mailchimp', so a tenant cannot store Mailchimp
--      credentials.
--
-- DROP CONSTRAINT + ADD CONSTRAINT is the standard enum-widening dance;
-- both lists are strict supersets of the old ones so no existing row
-- can fail revalidation. No new tables → no new RLS policies needed.

BEGIN;

ALTER TABLE subscriber_suppressions
    DROP CONSTRAINT IF EXISTS subscriber_suppressions_source_check;
ALTER TABLE subscriber_suppressions
    ADD CONSTRAINT subscriber_suppressions_source_check CHECK (source IN (
        'postmark', 'mailgun', 'ses', 'sendgrid', 'resend', 'sparkpost',
        'mailersend', 'mailchimp', 'manual', 'api', 'import'
    ));

ALTER TABLE tenant_deliverability_providers
    DROP CONSTRAINT IF EXISTS tenant_deliverability_providers_provider_check;
ALTER TABLE tenant_deliverability_providers
    ADD CONSTRAINT tenant_deliverability_providers_provider_check CHECK (provider IN (
        'postmark', 'mailgun', 'ses', 'sendgrid', 'resend', 'sparkpost',
        'mailersend', 'mailchimp'
    ));

COMMIT;
