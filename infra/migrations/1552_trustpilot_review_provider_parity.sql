-- 1552_trustpilot_review_provider_parity.sql
-- Promote Trustpilot from bridge-only catalog coverage into the managed review
-- connector control plane.

ALTER TABLE review_integrations
    DROP CONSTRAINT IF EXISTS review_integrations_provider_check;

ALTER TABLE review_integrations
    ADD CONSTRAINT review_integrations_provider_check
    CHECK (provider IN (
        'yotpo',
        'judge-me',
        'okendo',
        'loox',
        'stamped',
        'trustpilot'
    ));
