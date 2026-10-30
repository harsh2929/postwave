-- 0514_subscriber_suppressions_bounce_category.sql
--
-- SUB-048: spamtrap / role-account / dns-failure categorisation. The
-- bounce-ingest receivers classify a raw provider bounce into one of
-- the new Klaviyo-parity reasons (spamtrap, role_account, dns_failure,
-- invalid_address) before hard-suppressing. We want to preserve the
-- ORIGINAL classification signal even when the row's `reason` is later
-- reclassified by an operator (BulkChangeReason) — e.g. an analyst
-- relabels a misfired "spamtrap" cluster as "manual_unsubscribe" but we
-- still want the audit trail to show the receiver's verdict.
--
-- `bounce_category` is that durable signal: the raw classification the
-- receiver derived from provider bounce codes + metadata at ingest
-- time. Nullable because the vast majority of rows (manual ops adds,
-- one-click unsubs, imports) have no provider bounce signal at all.
--
-- Constrained to the categorisation vocabulary (the bounce-derived
-- subset of the reason taxonomy) so a drifting client can't write
-- arbitrary text. Index is partial (WHERE bounce_category IS NOT NULL)
-- so the deliverability dashboard can break out counts by category
-- without scanning the manual-add rows.

BEGIN;

ALTER TABLE subscriber_suppressions
    ADD COLUMN IF NOT EXISTS bounce_category text;

ALTER TABLE subscriber_suppressions
    DROP CONSTRAINT IF EXISTS subscriber_suppressions_bounce_category_check;
ALTER TABLE subscriber_suppressions
    ADD CONSTRAINT subscriber_suppressions_bounce_category_check CHECK (
        bounce_category IS NULL OR bounce_category IN (
            'hard_bounce',
            'soft_bounce',
            'spamtrap',
            'role_account',
            'dns_failure',
            'invalid_address',
            'complaint'
        )
    );

CREATE INDEX IF NOT EXISTS subscriber_suppressions_tenant_bounce_category_idx
    ON subscriber_suppressions (tenant_id, bounce_category)
    WHERE bounce_category IS NOT NULL;

COMMIT;
