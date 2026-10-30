-- 0513_email_suppressions_klaviyo_taxonomy.sql
--
-- SUB-047 dual-write compatibility. The legacy `email_suppressions`
-- table (0030, Mailchimp-compat surface) carried a narrow reason CHECK:
--   'hard_bounce', 'complaint', 'unsubscribe', 'manual', 'imported'
--
-- Some write paths dual-write to both subscriber_suppressions (the X1
-- source of truth) and email_suppressions (read by the older admin
-- surface + the converger's per-table fallback). Widen the legacy CHECK
-- so the same Klaviyo-compatible taxonomy can land here without a
-- constraint violation, while preserving every existing value.
--
-- We intentionally keep BOTH the legacy short labels (complaint,
-- unsubscribe, manual) and the X1 canonical labels (spam_complaint,
-- manual_unsubscribe, …) valid so neither surface breaks during the
-- convergence window. The named constraint is DROP+ADD so a re-run is
-- safe.

BEGIN;

ALTER TABLE email_suppressions
    DROP CONSTRAINT IF EXISTS email_suppressions_reason_check;

-- The original 0030 CHECK was an anonymous inline constraint. Postgres
-- auto-names it email_suppressions_reason_check, so the DROP above
-- removes it; if a deploy renamed it, the DO block below strips any
-- remaining CHECK referencing the reason column before we re-add ours.
DO $$
DECLARE
    c record;
BEGIN
    FOR c IN
        SELECT con.conname
          FROM pg_constraint con
          JOIN pg_class rel ON rel.oid = con.conrelid
         WHERE rel.relname = 'email_suppressions'
           AND con.contype = 'c'
           AND pg_get_constraintdef(con.oid) ILIKE '%reason%'
    LOOP
        EXECUTE format('ALTER TABLE email_suppressions DROP CONSTRAINT %I', c.conname);
    END LOOP;
END$$;

ALTER TABLE email_suppressions
    ADD CONSTRAINT email_suppressions_reason_check CHECK (reason IN (
        -- legacy short labels (0030)
        'hard_bounce',
        'complaint',
        'unsubscribe',
        'manual',
        'imported',
        -- X1 canonical labels (for dual-write parity)
        'spam_complaint',
        'manual_unsubscribe',
        'list_manual',
        'global_unsubscribe',
        'soft_bounce_threshold',
        'dsar_deletion',
        'role_address',
        'invalid_email',
        'blocklist_auto',
        -- SUB-047 / SUB-048: Klaviyo-compatible rich taxonomy
        'soft_bounce',
        'list_unsub_header',
        'spamtrap',
        'role_account',
        'dns_failure',
        'invalid_address'
    ));

COMMIT;
