-- 0438_subscribers_account_id.sql
--
-- SUB-012 — many-to-one contact → account link.
--
-- Companion to 0437_accounts.sql. Adds the nullable subscribers.account_id
-- FK so a contact can be linked to exactly one first-class account. NULL =
-- unlinked (the common B2C case). ON DELETE SET NULL so deleting an
-- account orphans its contacts back to "unlinked" rather than cascading a
-- contact delete (the contact is the durable record, the account is the
-- grouping).
--
-- The denormalised merge_fields.COMPANY pointer is intentionally left in
-- place: it remains the human-readable label and the CSV-import landing
-- spot, while account_id is the canonical join key.
--
-- rollback-strategy: additive. Hard rollback =
-- ALTER TABLE subscribers DROP COLUMN account_id.

BEGIN;

ALTER TABLE subscribers
    ADD COLUMN IF NOT EXISTS account_id uuid
        REFERENCES accounts(id) ON DELETE SET NULL;

COMMENT ON COLUMN subscribers.account_id IS
    'SUB-012 many-to-one link to the first-class accounts table (0437). NULL = unlinked. ON DELETE SET NULL so account deletion orphans contacts rather than cascading.';

-- Index the FK so "all contacts at account X" is a tight tenant-scoped
-- scan and the ON DELETE SET NULL fan-out is cheap. Partial: only linked
-- rows are indexed (the unlinked B2C majority is excluded).
CREATE INDEX IF NOT EXISTS subscribers_tenant_account_idx
    ON subscribers (tenant_id, account_id)
    WHERE account_id IS NOT NULL;

COMMIT;
