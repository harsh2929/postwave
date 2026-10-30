-- 2047_referral_token_tenant_binding_and_tenant_scope_comments.sql
--
-- Closes the two schema gaps that scripts/lint-migrations-schema.py reported
-- on a database migrated to head and that no reviewed record covered (1 and
-- 2), and a privilege gap that a review of those records found (3). The
-- verifier's other findings at head were intentional designs; they are
-- recorded as exact reviewed exceptions in that script, not changed here.
--
-- 1. referral_code_tokens.tenant_id was bound to nothing.
--
--    Migration 1772 built referral_code_tokens as the private registry behind
--    referral_code_resolve(). The tenant that function returns decides whose
--    scope a public referral click is recorded in. The column is a copy of
--    referral_codes.tenant_id that the SECURITY DEFINER trigger
--    referral_code_tokens_sync() keeps in step, but the table's only FK,
--    (referral_code_id) -> referral_codes(id), leaves tenant_id out of its
--    key. Tenant deletion did reach the rows through that FK. Nothing in the
--    schema, though, stopped a registry row from naming another tenant than
--    its referral code's, or a tenant that does not exist. 1772 checked that
--    once, in its post-check, and never again. The static migration lint
--    missed the table too: its comment stripper read the '--' literal in the
--    table's CHECK as a comment and lost the end of the CREATE TABLE.
--
--    This migration turns the copy into a constraint. It builds a unique key
--    on referral_codes (tenant_id, id) online, then replaces the id-only FK
--    with (tenant_id, referral_code_id) -> referral_codes (tenant_id, id),
--    ON DELETE CASCADE. Both columns are NOT NULL, so MATCH SIMPLE checks
--    every row. A registry row must now carry its referral code's tenant,
--    and it is still deleted with its referral code, one cascade level below
--    it (the table has no DELETE guard). The id-only FK is dropped because
--    the composite FK implies it.
--
--    ON UPDATE CASCADE keeps an UPDATE of referral_codes.tenant_id working
--    the way 1772's trigger expects: the key follows, then the trigger
--    rewrites the rows. A NO ACTION FK would refuse that UPDATE, because its
--    RI trigger sorts before referral_code_tokens_sync. Subscriber merges
--    change only subscriber_id, which is not in the key.
--
--    ON UPDATE CASCADE covers the whole key, so on its own it would also
--    change what an UPDATE of referral_codes.id does. The id-only NO ACTION
--    FK rejected every such UPDATE: each referral code has a registry row
--    (its 'code' token), and referral_code_tokens_sync() does not fire on id.
--    With the cascade alone, the UPDATE would succeed and rewrite the
--    registry. So the primary key stays immutable: the BEFORE UPDATE OF id
--    trigger referral_codes_id_immutable rejects any change of id with
--    SQLSTATE 55000, and the cascade only ever carries a tenant_id change. It
--    is created in the transaction that adds the FK, so no committed state
--    lets an id change cascade. No application code updates
--    referral_codes.id; the referral and subscriber-merge writers set only
--    clicks_count, last_clicked_at, desired_code and subscriber_id, and the
--    trigger does not fire for those.
--
-- 2. Three nullable tenant_id columns had no in-band exception.
--
--    Migration 1730 records each deliberately nullable tenant_id as a
--    machine-readable comment on the column. The verifier requires that
--    exact comment, and apps/api/internal/schemaguard requires a reviewed
--    category. These tables arrived later without one:
--      * content_reports (2041): a DSA Art. 16 notice is addressed to
--        Postwave and can arrive before its URL resolves to a tenant asset.
--        Its tenant FK is ON DELETE SET NULL, so the notice outlives the
--        tenant as evidence of when actual knowledge was obtained.
--      * content_report_decisions (2041): the Art. 17 statement of reasons,
--        kept the same way (ON DELETE SET NULL). It is NULL for a notice
--        that never resolved to a tenant. Nothing yet ties report_id to the
--        row's tenant_id; the verifier's register records that open gap.
--      * campaign_template_reference_review_decisions (1825): NULL is a
--        catalog operator's review of a platform-shared reference template.
--        Tenant rows keep their ON DELETE CASCADE FK, but that cascade
--        cannot complete: campaign_template_reference_review_immutable
--        rejects every DELETE, and ON DELETE RESTRICT FKs link the decisions
--        and campaign_templates both ways. Deleting a tenant that owns a
--        reference review fails. The comment records the exception only; the
--        erasure fix is a separate, recorded follow-up.
--
-- 3. The reported tenant could rewrite a DSA notice.
--
--    2041 granted postwave_app UPDATE on all of content_reports, and
--    content_reports_tenant_update admits every row of the session's tenant.
--    So that tenant (for a public notice, the tenant whose content it
--    reports) could rewrite actual_knowledge_at, which 2041's own column
--    comment says must not be writable after the fact, and the explanation,
--    notifier, subject, origin and reference with it. The only application
--    writer, contentreports.Repo.Decide, sets status and updated_at. This
--    migration revokes the table-level UPDATE and grants UPDATE on those two
--    columns only. Revoking a table privilege also revokes it on every
--    column, so the GRANT that follows is the whole UPDATE grant. The tenant
--    FK's ON DELETE SET NULL still works: a referential action runs with the
--    table owner's rights.
--
-- Locks. Writers take referral_codes before referral_code_tokens:
-- referral_code_tokens_sync() runs after each INSERT or UPDATE of a referral
-- code, and deleting a referral code cascades into its tokens. ADD CONSTRAINT
-- and DROP CONSTRAINT would lock referral_code_tokens first, so a referral
-- code write in flight could deadlock with them. Each phase that changes the
-- FK therefore locks both tables first, in the writers' order. While the
-- migration waits for referral_codes, it holds nothing that stops the public
-- click path, which reads referral_code_tokens through referral_code_resolve().
--   * The unique key is built CONCURRENTLY. It cannot fail on duplicates,
--     because id is referral_codes' primary key.
--   * The comments and the content_reports grant change commit in their own
--     transaction. REVOKE and GRANT update only the catalog row and take no
--     table lock. COMMENT takes SHARE UPDATE EXCLUSIVE, which blocks neither
--     reads nor writes, and nothing else is held while it waits.
--   * Adding the id trigger and the FK NOT VALID holds SHARE ROW EXCLUSIVE on
--     both tables, which blocks their writers but not their readers, for a
--     catalog change.
--   * VALIDATE runs in the next transaction and scans referral_code_tokens
--     under SHARE UPDATE EXCLUSIVE, which lets writers through. Only then are
--     both tables locked ACCESS EXCLUSIVE, for the DROP CONSTRAINT and the
--     self-audit, which touch only the catalog.
-- lock_timeout (5s) bounds every wait. A timeout rolls back only the current
-- phase, and the migrator resumes at that phase.
--
-- Row-level security. referral_code_tokens forces RLS and has no policy, and
-- referral_codes forces RLS with policies for postwave_app only. A migrator
-- that owns the tables but does not bypass RLS therefore sees no rows in
-- either. The preflight SELECT below would then pass without checking
-- anything, and so would VALIDATE CONSTRAINT: its check query is subject to
-- FORCE RLS for a table owner, unlike the per-row FK checks, so it marks the
-- FK valid without having read a row (measured on PostgreSQL 16.14 and
-- 17.9). 2045's header says VALIDATE runs outside row-level security; that
-- holds only for a migrator that bypasses RLS. Both phases here that read
-- rows set row_security = off, which turns a read that RLS would filter into
-- an error. A superuser or BYPASSRLS migrator is unaffected and checks every
-- row. Any other migrator stops with "query would be affected by row-level
-- security policy" instead of recording an unchecked FK. Run the migration
-- as a role that bypasses RLS; do not weaken the tables' RLS to get past it.
--
-- migration-execution: phased
-- rollback-strategy: no-op
-- rollback-details: Keep the unique key, the composite FK, the id trigger,
-- the comments and the narrowed content_reports grant when an earlier
-- application image is restored. No binary writes referral_code_tokens
-- directly; referral_code_tokens_sync() copies the tenant from the referral
-- code, so every row it writes satisfies the FK. No binary updates
-- referral_codes.id, so the id trigger rejects nothing an earlier image does.
-- Earlier images update content_reports only through Decide, which writes
-- status and updated_at, both still granted.

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS referral_codes_tenant_id_id_uidx
    ON public.referral_codes (tenant_id, id);

BEGIN;

SET LOCAL lock_timeout = '5s';

COMMENT ON COLUMN public.content_reports.tenant_id IS
    'postwave:tenant-scope-exception=unresolved-public-ingest; NULL identifies a notice not yet resolved to a tenant asset, and ON DELETE SET NULL keeps the notice as evidence after tenant deletion';
COMMENT ON COLUMN public.content_report_decisions.tenant_id IS
    'postwave:tenant-scope-exception=durable-audit-set-null; nullable FK uses ON DELETE SET NULL so a statement of reasons survives tenant deletion';
COMMENT ON COLUMN public.campaign_template_reference_review_decisions.tenant_id IS
    'postwave:tenant-scope-exception=platform-default; NULL identifies a catalog operator review of a platform-shared reference template';

-- Section 3: a notice's evidence is not the tenant's to rewrite.
REVOKE UPDATE ON public.content_reports FROM postwave_app;
GRANT UPDATE (status, updated_at) ON public.content_reports TO postwave_app;

COMMIT;

BEGIN;

SET LOCAL lock_timeout = '5s';
-- Fail rather than read past rows that row-level security hides (see the
-- header).
SET LOCAL row_security = off;

-- VALIDATE below is the real check. This names the problem first, so a
-- divergent registry fails with a message instead of a bare FK violation,
-- and before the NOT VALID FK is committed.
DO $preflight$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM public.referral_code_tokens AS token
          LEFT JOIN public.referral_codes AS referral
            ON referral.id = token.referral_code_id
         WHERE referral.id IS NULL
            OR referral.tenant_id <> token.tenant_id
    ) THEN
        RAISE EXCEPTION
            'referral_code_tokens has rows whose tenant is not their referral code''s tenant';
    END IF;
END;
$preflight$;

LOCK TABLE public.referral_codes, public.referral_code_tokens
    IN SHARE ROW EXCLUSIVE MODE;

-- The FK below cascades an UPDATE of its whole key. Keep referral_codes.id
-- immutable, so the cascade only ever carries a tenant_id change (see the
-- header).
CREATE FUNCTION public.referral_codes_id_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $guard$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id THEN
        RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'referral_codes.id is immutable: referral_code_tokens rows are bound to it';
    END IF;
    RETURN NEW;
END
$guard$;

REVOKE ALL ON FUNCTION public.referral_codes_id_immutable() FROM PUBLIC;

CREATE TRIGGER referral_codes_id_immutable
    BEFORE UPDATE OF id ON public.referral_codes
    FOR EACH ROW
    EXECUTE FUNCTION public.referral_codes_id_immutable();

ALTER TABLE public.referral_code_tokens
    ADD CONSTRAINT referral_code_tokens_referral_code_tenant_fkey
    FOREIGN KEY (tenant_id, referral_code_id)
    REFERENCES public.referral_codes (tenant_id, id)
    ON UPDATE CASCADE
    ON DELETE CASCADE
    NOT VALID;

COMMIT;

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL row_security = off;

ALTER TABLE public.referral_code_tokens
    VALIDATE CONSTRAINT referral_code_tokens_referral_code_tenant_fkey;

LOCK TABLE public.referral_codes, public.referral_code_tokens
    IN ACCESS EXCLUSIVE MODE;

ALTER TABLE public.referral_code_tokens
    DROP CONSTRAINT IF EXISTS referral_code_tokens_referral_code_id_fkey;

-- Self-audit. The same facts scripts/lint-migrations-schema.py checks, so the
-- migration cannot commit a state the verifier would reject.
DO $audit$
DECLARE
    binding pg_catalog.pg_constraint%ROWTYPE;
    key_shape text[];
    comment_problem text;
    update_problem text;
BEGIN
    SELECT * INTO binding
      FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.referral_code_tokens'::regclass
       AND conname = 'referral_code_tokens_referral_code_tenant_fkey';
    IF NOT FOUND
       OR binding.contype <> 'f'
       OR NOT binding.convalidated
       OR binding.confrelid <> 'public.referral_codes'::regclass
       OR binding.confdeltype <> 'c'
       OR binding.confupdtype <> 'c' THEN
        RAISE EXCEPTION
            'referral_code_tokens_referral_code_tenant_fkey is not a validated cascading FK into referral_codes';
    END IF;

    SELECT pg_catalog.array_agg(
               child.attname::text || '->' || parent.attname::text || ':' ||
               child.attnotnull::text
               ORDER BY key_column.ordinal
           )
      INTO key_shape
      FROM unnest(binding.conkey, binding.confkey)
           WITH ORDINALITY AS key_column(child_attnum, parent_attnum, ordinal)
      JOIN pg_catalog.pg_attribute AS child
        ON child.attrelid = binding.conrelid
       AND child.attnum = key_column.child_attnum
      JOIN pg_catalog.pg_attribute AS parent
        ON parent.attrelid = binding.confrelid
       AND parent.attnum = key_column.parent_attnum;
    IF key_shape IS DISTINCT FROM
       ARRAY['tenant_id->tenant_id:true', 'referral_code_id->id:true']::text[] THEN
        RAISE EXCEPTION
            'referral_code_tokens binding key is %, expected NOT NULL tenant_id->tenant_id and referral_code_id->id',
            key_shape;
    END IF;

    IF EXISTS (
        SELECT 1
          FROM pg_catalog.pg_constraint
         WHERE conrelid = 'public.referral_code_tokens'::regclass
           AND contype = 'f'
           AND conname <> 'referral_code_tokens_referral_code_tenant_fkey'
    ) THEN
        RAISE EXCEPTION
            'referral_code_tokens must have no FK besides referral_code_tokens_referral_code_tenant_fkey';
    END IF;

    -- The parent must be bound to tenants directly: a NOT NULL tenant_id with
    -- exactly one FK to tenants(id), validated and ON DELETE CASCADE.
    IF NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_attribute
         WHERE attrelid = 'public.referral_codes'::regclass
           AND attname = 'tenant_id'
           AND attnotnull
           AND NOT attisdropped
    ) OR (
        SELECT pg_catalog.count(*)
          FROM pg_catalog.pg_constraint AS tenant_fk
         WHERE tenant_fk.conrelid = 'public.referral_codes'::regclass
           AND tenant_fk.contype = 'f'
           AND tenant_fk.confrelid = 'public.tenants'::regclass
    ) <> 1 OR NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_constraint AS tenant_fk
          JOIN pg_catalog.pg_attribute AS tenant_column
            ON tenant_column.attrelid = tenant_fk.conrelid
           AND tenant_column.attname = 'tenant_id'
          JOIN pg_catalog.pg_attribute AS id_column
            ON id_column.attrelid = tenant_fk.confrelid
           AND id_column.attname = 'id'
         WHERE tenant_fk.conrelid = 'public.referral_codes'::regclass
           AND tenant_fk.contype = 'f'
           AND tenant_fk.confrelid = 'public.tenants'::regclass
           AND tenant_fk.convalidated
           AND tenant_fk.confdeltype = 'c'
           AND tenant_fk.conkey = ARRAY[tenant_column.attnum]::smallint[]
           AND tenant_fk.confkey = ARRAY[id_column.attnum]::smallint[]
    ) THEN
        RAISE EXCEPTION 'referral_codes is not bound directly to tenants';
    END IF;

    -- The FK's ON UPDATE CASCADE carries only tenant_id: one enabled row
    -- trigger, BEFORE UPDATE OF id and nothing else, runs the invoker-rights
    -- guard that rejects a changed id.
    IF NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_trigger AS trigger_meta
          JOIN pg_catalog.pg_proc AS function_meta
            ON function_meta.oid = trigger_meta.tgfoid
         WHERE trigger_meta.tgrelid = 'public.referral_codes'::regclass
           AND trigger_meta.tgname = 'referral_codes_id_immutable'
           AND NOT trigger_meta.tgisinternal
           AND trigger_meta.tgenabled = 'O'
           -- TRIGGER_TYPE_ROW (1) | TRIGGER_TYPE_BEFORE (2) | TRIGGER_TYPE_UPDATE (16)
           AND trigger_meta.tgtype = 19
           AND trigger_meta.tgqual IS NULL
           -- tgattr is an int2vector, whose array form is indexed from 0.
           AND ARRAY(SELECT pg_catalog.unnest(trigger_meta.tgattr::smallint[])) = ARRAY[(
               SELECT id_column.attnum
                 FROM pg_catalog.pg_attribute AS id_column
                WHERE id_column.attrelid = 'public.referral_codes'::regclass
                  AND id_column.attname = 'id'
                  AND NOT id_column.attisdropped
           )]::smallint[]
           AND function_meta.oid = 'public.referral_codes_id_immutable()'::regprocedure
           AND NOT function_meta.prosecdef
    ) THEN
        RAISE EXCEPTION 'referral_codes_id_immutable must guard every UPDATE OF referral_codes.id';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_index AS index_meta
          JOIN pg_catalog.pg_class AS index_class
            ON index_class.oid = index_meta.indexrelid
         WHERE index_class.relname = 'referral_codes_tenant_id_id_uidx'
           AND index_class.relnamespace = 'public'::regnamespace
           AND index_meta.indrelid = 'public.referral_codes'::regclass
           AND index_meta.indisunique
           AND index_meta.indisvalid
           AND index_meta.indisready
    ) THEN
        RAISE EXCEPTION 'referral_codes_tenant_id_id_uidx is missing, invalid or not unique';
    END IF;

    SELECT pg_catalog.string_agg(expected.table_name, ', ' ORDER BY expected.table_name)
      INTO comment_problem
      FROM (
            VALUES
                ('content_reports',
                 'postwave:tenant-scope-exception=unresolved-public-ingest; NULL identifies a notice not yet resolved to a tenant asset, and ON DELETE SET NULL keeps the notice as evidence after tenant deletion'),
                ('content_report_decisions',
                 'postwave:tenant-scope-exception=durable-audit-set-null; nullable FK uses ON DELETE SET NULL so a statement of reasons survives tenant deletion'),
                ('campaign_template_reference_review_decisions',
                 'postwave:tenant-scope-exception=platform-default; NULL identifies a catalog operator review of a platform-shared reference template')
           ) AS expected(table_name, comment_text)
      LEFT JOIN pg_catalog.pg_attribute AS tenant_column
        ON tenant_column.attrelid = pg_catalog.to_regclass('public.' || expected.table_name)
       AND tenant_column.attname = 'tenant_id'
       AND NOT tenant_column.attisdropped
     WHERE tenant_column.attnum IS NULL
        OR tenant_column.attnotnull
        OR pg_catalog.col_description(tenant_column.attrelid, tenant_column.attnum)
               IS DISTINCT FROM expected.comment_text;
    IF comment_problem IS NOT NULL THEN
        RAISE EXCEPTION
            'nullable tenant_id exception comment is missing or wrong on %', comment_problem;
    END IF;

    -- Section 3: postwave_app may UPDATE content_reports.status and
    -- updated_at and no other column. has_column_privilege also sees a
    -- table-level grant, so this covers both.
    SELECT pg_catalog.string_agg(column_meta.attname::text, ', ' ORDER BY column_meta.attnum)
      INTO update_problem
      FROM pg_catalog.pg_attribute AS column_meta
     WHERE column_meta.attrelid = 'public.content_reports'::regclass
       AND column_meta.attnum > 0
       AND NOT column_meta.attisdropped
       AND pg_catalog.has_column_privilege(
               'postwave_app', column_meta.attrelid, column_meta.attnum, 'UPDATE'
           ) IS DISTINCT FROM (column_meta.attname IN ('status', 'updated_at'));
    IF update_problem IS NOT NULL
       OR pg_catalog.has_table_privilege('postwave_app', 'public.content_reports', 'UPDATE') THEN
        RAISE EXCEPTION
            'postwave_app must hold UPDATE on content_reports.status and updated_at only (wrong on: %)',
            COALESCE(update_problem, 'the table');
    END IF;
END;
$audit$;

COMMIT;
