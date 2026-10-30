-- 0118_custom_domains_tracking.sql
--
-- Adds a 'tracking' purpose to custom_domains for the customer-branded
-- open-pixel host (e.g. mail.acme.com/pixel.gif). Click-tracking uses
-- the existing 'links' purpose (mapped at 0070); we keep that separate
-- so tenants can configure open + click independently — a single
-- domain often covers both, but some operators want a "soft" tracking
-- host that's only used for the open pixel and a higher-trust host
-- for clicks.

BEGIN;

-- Replace the existing CHECK constraint to include 'tracking'.
ALTER TABLE custom_domains DROP CONSTRAINT IF EXISTS custom_domains_purpose_check;
ALTER TABLE custom_domains
    ADD CONSTRAINT custom_domains_purpose_check
    CHECK (purpose IN ('forms', 'links', 'web', 'tracking'));

COMMIT;
