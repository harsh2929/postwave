-- 0239_suppression_email_hash.sql
--
-- Adds email_sha256 to subscriber_suppressions (the active suppression
-- store consulted at send time) so a DSAR deletion can erase the
-- plaintext email column on the subscriber + suppression rows AND keep
-- the suppression effective. Without a hash column, anonymizing the
-- email field would silently re-enable sending to the same address as
-- soon as a future import or re-subscribe wrote a fresh subscriber row.
--
-- The column is nullable + indexed; the send-time suppression check
-- ORs on email equality and email_sha256 equality, so pre-existing
-- rows (no hash) continue to match by plaintext and DSAR-erased rows
-- match by hash. Future writes populate both.
--
-- Also extends the CHECK constraint with the 'dsar_deletion' reason
-- so the deletion worker has a first-class category for its synthetic
-- suppression rows; without this the INSERT would fail the check.

BEGIN;

-- subscriber_suppressions: hash column + reason
ALTER TABLE subscriber_suppressions
    ADD COLUMN IF NOT EXISTS email_sha256 char(64);

CREATE INDEX IF NOT EXISTS subscriber_suppressions_tenant_email_sha256_idx
    ON subscriber_suppressions (tenant_id, email_sha256)
    WHERE email_sha256 IS NOT NULL;

ALTER TABLE subscriber_suppressions
    DROP CONSTRAINT IF EXISTS subscriber_suppressions_reason_check;
ALTER TABLE subscriber_suppressions
    ADD CONSTRAINT subscriber_suppressions_reason_check CHECK (reason IN (
        'hard_bounce',
        'spam_complaint',
        'manual_unsubscribe',
        'list_manual',
        'global_unsubscribe',
        'soft_bounce_threshold',
        'dsar_deletion'
    ));

-- Older suppressions (0060) table — keep the column shape consistent
-- so future code paths can converge on a single read pattern. Index
-- only added where the column is populated.
ALTER TABLE suppressions
    ADD COLUMN IF NOT EXISTS email_sha256 char(64);

CREATE INDEX IF NOT EXISTS suppressions_tenant_email_sha256_idx
    ON suppressions (tenant_id, email_sha256)
    WHERE email_sha256 IS NOT NULL;

COMMIT;
