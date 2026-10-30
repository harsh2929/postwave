-- 1558_loyalty_provider_parity_batch.sql
-- Promote Growave, Marsello, Antavo, Friendbuy, and Talkable into the managed
-- loyalty/referral connector control plane.

ALTER TABLE loyalty_integrations
    DROP CONSTRAINT IF EXISTS loyalty_integrations_provider_check;

ALTER TABLE loyalty_integrations
    ADD CONSTRAINT loyalty_integrations_provider_check
    CHECK (provider IN (
        'smile',
        'loyaltylion',
        'rivo',
        'referralcandy',
        'growave',
        'marsello',
        'antavo',
        'friendbuy',
        'talkable'
    ));
