-- 0370_sms_keyword_responses.sql
--
-- GAP-LS-146 / GAP-LS-147 (desktop audit 2026-06-10 item A8): make
-- sms_keyword_responses enforceable by the inbound SMS handler.
--
-- The table landed in 0253 with the Wave-3 scaffold shape
-- (keyword / response_text / action in opt_out|opt_in|help|custom)
-- but no Go code ever consulted it — inbound keywords only hit the
-- hardcoded STOP/START/HELP switch in apps/api/internal/sms/phone.go.
-- This migration normalizes the table to the enforced contract:
--
--   * response_text  -> response_body (canonical column name).
--   * action enum    -> ('reply_only','opt_out','opt_in').
--     Legacy 'custom' and 'help' rows become 'reply_only'.
--   * keyword        -> upper-normalized single token, unique per
--     tenant (the per-tenant UNIQUE from 0253 is kept).
--   * Reserved carrier compliance keywords (STOP / STOPALL /
--     UNSUBSCRIBE / CANCEL / END / START / UNSTOP / HELP) must stay
--     hardcoded in phone.go and are NOT overridable: a CHECK prevents
--     their insertion (the API also rejects them with 422).
--
-- NO DELETE statements: the migration-safety scanner
-- (apps/api/internal/migrationrunner/safety.go, rule "delete-from")
-- classifies DELETE FROM in a schema migration as a SafetyBlocker and
-- the default deploy refuses the entire pending set. Rows the enforced
-- contract cannot represent (duplicates after upper-normalization,
-- reserved keywords, multi-word/empty keywords) are instead
-- NEUTRALIZED in place: disabled and renamed to a unique inert
-- tombstone ("<KEYWORD>~RETIRED~<ID>") that
--
--   * satisfies the shape CHECK below (uppercase, no whitespace),
--   * is never reserved,
--   * never collides (the row id is embedded), and
--   * can never auto-reply (matchKeywordResponseTx requires enabled).
--
-- In practice the table is expected to be empty everywhere — no write
-- path existed between 0253 and the keyword_responses.go API that
-- ships with this migration — so the neutralization UPDATEs are
-- defensive no-ops; operators can remove any tombstoned row through
-- DELETE /api/v1/sms/keyword-responses/{id}.

BEGIN;

-- 1. Canonical column name. Guarded rename: only when the old column
--    still exists and the new one does not.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'sms_keyword_responses' AND column_name = 'response_text'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'sms_keyword_responses' AND column_name = 'response_body'
    ) THEN
        ALTER TABLE sms_keyword_responses RENAME COLUMN response_text TO response_body;
    END IF;
END;
$$;

-- 2. Neutralize rows the enforced contract cannot represent (instead
--    of deleting them — see header). One snapshot UPDATE so the
--    duplicate check evaluates against pre-update state:
--      * duplicates after upper-normalization (keep the oldest row per
--        (tenant, normalized keyword), retire the rest);
--      * reserved carrier compliance keywords;
--      * empty or multi-word keywords that can never satisfy the shape
--        CHECK in step 5.
--    Idempotent: tombstoned rows are excluded on re-run.
UPDATE sms_keyword_responses a
   SET enabled = false,
       -- internal whitespace becomes '_' so the tombstone satisfies
       -- the shape CHECK (uppercase, non-empty, no whitespace).
       keyword = regexp_replace(upper(btrim(a.keyword)), '\s+', '_', 'g')
                 || '~RETIRED~' || upper(a.id::text)
 WHERE a.keyword NOT LIKE '%~RETIRED~%'
   AND (
        upper(btrim(a.keyword)) IN ('STOP','STOPALL','UNSUBSCRIBE','CANCEL','END','START','UNSTOP','HELP')
     OR btrim(a.keyword) = ''
     OR btrim(a.keyword) ~ '\s'
     OR EXISTS (
            SELECT 1 FROM sms_keyword_responses b
             WHERE b.tenant_id = a.tenant_id
               AND b.id <> a.id
               AND upper(btrim(b.keyword)) = upper(btrim(a.keyword))
               AND (b.created_at, b.id) < (a.created_at, a.id)
        )
   );

-- 3. Upper-normalize the surviving keywords. Collision-free against
--    the (tenant_id, keyword) UNIQUE from 0253: step 2 retired every
--    row whose normalized form had an older sibling.
UPDATE sms_keyword_responses
   SET keyword = upper(btrim(keyword))
 WHERE keyword <> upper(btrim(keyword));

-- 4. Action enum: reply_only | opt_out | opt_in. Drop 0253's CHECK
--    ('opt_out','opt_in','help','custom') BEFORE rewriting legacy
--    values — with the old constraint still attached the UPDATE to
--    'reply_only' is rejected on any populated table.
ALTER TABLE sms_keyword_responses
    DROP CONSTRAINT IF EXISTS sms_keyword_responses_action_check;

UPDATE sms_keyword_responses
   SET action = 'reply_only'
 WHERE action IN ('custom', 'help');

ALTER TABLE sms_keyword_responses
    ALTER COLUMN action SET DEFAULT 'reply_only';
ALTER TABLE sms_keyword_responses
    ADD CONSTRAINT sms_keyword_responses_action_check
    CHECK (action IN ('reply_only','opt_out','opt_in'));

-- 5. Keyword shape + reserved-keyword guards, enforced at the DB as
--    defense in depth behind the API's 422.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'sms_keyword_responses'::regclass
           AND conname  = 'sms_keyword_responses_keyword_shape_check'
    ) THEN
        ALTER TABLE sms_keyword_responses
            ADD CONSTRAINT sms_keyword_responses_keyword_shape_check
            CHECK (keyword <> '' AND keyword = upper(btrim(keyword)) AND keyword !~ '\s');
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'sms_keyword_responses'::regclass
           AND conname  = 'sms_keyword_responses_keyword_not_reserved_check'
    ) THEN
        ALTER TABLE sms_keyword_responses
            ADD CONSTRAINT sms_keyword_responses_keyword_not_reserved_check
            CHECK (keyword NOT IN ('STOP','STOPALL','UNSUBSCRIBE','CANCEL','END','START','UNSTOP','HELP'));
    END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS sms_keyword_responses_tenant_enabled_idx
    ON sms_keyword_responses (tenant_id, keyword)
    WHERE enabled;

-- 6. Re-assert canonical tenant RLS (idempotent; present from 0253).
ALTER TABLE sms_keyword_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_keyword_responses FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE tablename = 'sms_keyword_responses' AND policyname = 'tenant_isolation'
    ) THEN
        CREATE POLICY tenant_isolation ON sms_keyword_responses
            AS RESTRICTIVE FOR ALL
            USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
            WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE tablename = 'sms_keyword_responses' AND policyname = 'tenant_visible'
    ) THEN
        CREATE POLICY tenant_visible ON sms_keyword_responses
            AS PERMISSIVE FOR ALL
            TO postwave_app
            USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
            WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
    END IF;
END;
$$;

COMMIT;
