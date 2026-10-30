-- 1557_review_provider_parity_enterprise_reviews.sql
-- Promote Reviews.io, Bazaarvoice, and PowerReviews into the managed review
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
        'trustpilot',
        'reviews-io',
        'bazaarvoice',
        'powerreviews'
    ));
