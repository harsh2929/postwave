-- 1616_ingest_provider_check_relax.sql
--
-- Webhook ingest is a generic inbound capability: ProvisionIngest in the four
-- single-token-key land-only packages (loyalty/support/review/subscription) now
-- accepts ANY sanitized provider slug, so any tool that can POST a webhook is
-- set-up-able — not just the curated pullers. The enumerated provider CHECK
-- constraints predate that and would reject the long-tail / bridge providers at
-- INSERT (e.g. viral-loops, feefo, extole), 500-ing the generic provision path.
--
-- Drop the enumerated provider CHECKs on these four tables. Provider labels are
-- slug-sanitized at the Go layer (sanitizeIngestProvider), and the curated
-- CREATE path still validates against ProviderSpecByKey before insert, so this
-- removes a now-incorrect guardrail without opening an injection surface. The
-- status CHECK (which the RLS ingest-lookup relies on) is intentionally kept.

ALTER TABLE loyalty_integrations      DROP CONSTRAINT IF EXISTS loyalty_integrations_provider_check;
ALTER TABLE support_integrations      DROP CONSTRAINT IF EXISTS support_integrations_provider_check;
ALTER TABLE review_integrations       DROP CONSTRAINT IF EXISTS review_integrations_provider_check;
ALTER TABLE subscription_integrations DROP CONSTRAINT IF EXISTS subscription_integrations_provider_check;
