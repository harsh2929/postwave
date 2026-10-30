-- 1772_referral_public_code_boundary.sql
--
-- Referral URLs are public capabilities, but referral_codes is a tenant table.
-- Its original `referral_codes_public_lookup` policy did not actually make the
-- unscoped lookup work: the table's RESTRICTIVE tenant policy still ANDed the
-- request down to zero rows. Broadening that policy would expose every issued
-- token and subscriber identifier to any postwave_app query.
--
-- Keep the table tenant-only and expose one exact-token resolver instead. A
-- purpose-built NOLOGIN/BYPASSRLS role owns the fixed-SQL SECURITY DEFINER
-- functions and can access only a PII-free token registry. The registry also
-- gives `code` and `desired_code` one physical UNIQUE namespace, including
-- concurrent cross-column claims that two independent unique indexes cannot
-- prevent.
--
-- Preflight:
--   * referral code and desired-code values must satisfy the canonical token
--     formats below;
--   * no issued random token may already equal any desired token;
--   * the dedicated role/function/table names must not exist out of band.
--
-- rollback-strategy: expand-contract - retain the registry and resolver while
-- old application instances drain; restoring the broad table policy is
-- forbidden. A later migration may remove the boundary only after no public
-- referral route depends on database resolution.
-- rollback-details: The token registry is derived but load-bearing for global
-- cross-column uniqueness. Do not drop it or its trigger during application
-- rollback; the preceding app version remains compatible with tenant-scoped
-- referral_codes reads.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $preflight$
BEGIN
    IF pg_catalog.to_regclass('public.referral_code_tokens') IS NOT NULL OR
       pg_catalog.to_regprocedure('public.referral_code_resolve(text)') IS NOT NULL OR
       pg_catalog.to_regprocedure('public.referral_code_tokens_sync()') IS NOT NULL THEN
        RAISE EXCEPTION '1772 referral boundary objects exist out of band';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM public.referral_codes AS referral
         WHERE referral.code IS NULL
            OR pg_catalog.octet_length(referral.code) <> 8
            OR referral.code COLLATE "C" !~
               '^[abcdefghijkmnpqrstuvwxyz23456789]{8}$'
    ) THEN
        RAISE EXCEPTION 'legacy random referral code is not canonical';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM public.referral_codes AS referral
         WHERE referral.desired_code IS NOT NULL
           AND (
                pg_catalog.octet_length(referral.desired_code) < 3 OR
                pg_catalog.octet_length(referral.desired_code) > 32 OR
                referral.desired_code <> pg_catalog.lower(
                    pg_catalog.btrim(referral.desired_code)
                ) OR
                referral.desired_code COLLATE "C" !~
                    '^[a-z0-9][a-z0-9-]*[a-z0-9]$' OR
                pg_catalog.strpos(referral.desired_code, '--') > 0 OR
                referral.desired_code IN
                    ('admin', 'system', 'test', 'support', 'help')
           )
    ) THEN
        RAISE EXCEPTION 'legacy branded referral code is not canonical';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM public.referral_codes AS random_owner
          JOIN public.referral_codes AS desired_owner
            ON desired_owner.desired_code = random_owner.code
    ) THEN
        RAISE EXCEPTION
            'random and branded referral codes already collide globally';
    END IF;
END;
$preflight$;

DO $role$
DECLARE
    definer pg_catalog.pg_roles%ROWTYPE;
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_roles
         WHERE rolname = 'postwave_referral_code_definer'
    ) THEN
        CREATE ROLE postwave_referral_code_definer
            NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
            NOREPLICATION BYPASSRLS;
    END IF;

    SELECT * INTO definer
      FROM pg_catalog.pg_roles
     WHERE rolname = 'postwave_referral_code_definer';
    IF definer.rolcanlogin OR definer.rolsuper OR definer.rolcreatedb OR
       definer.rolcreaterole OR definer.rolinherit OR
       definer.rolreplication OR NOT definer.rolbypassrls THEN
        RAISE EXCEPTION
            'postwave_referral_code_definer has unsafe role attributes';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_catalog.pg_auth_members
         WHERE member = definer.oid OR roleid = definer.oid
    ) THEN
        RAISE EXCEPTION
            'postwave_referral_code_definer must have no memberships';
    END IF;
    IF pg_catalog.has_schema_privilege(
        'postwave_referral_code_definer', 'public', 'CREATE'
    ) THEN
        RAISE EXCEPTION
            'postwave_referral_code_definer unexpectedly has CREATE on public';
    END IF;
END;
$role$;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
    FROM postwave_referral_code_definer;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public
    FROM postwave_referral_code_definer;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public
    FROM postwave_referral_code_definer;
REVOKE ALL PRIVILEGES ON SCHEMA public
    FROM postwave_referral_code_definer;

-- Replace the ineffective global policy with an explicit tenant boundary.
-- The exact-token function below is the only cross-tenant read surface.
DROP POLICY IF EXISTS referral_codes_public_lookup ON public.referral_codes;
DROP POLICY IF EXISTS tenant_isolation ON public.referral_codes;
DROP POLICY IF EXISTS referral_codes_tenant_visible ON public.referral_codes;
CREATE POLICY referral_codes_tenant_isolation
    ON public.referral_codes
    AS RESTRICTIVE FOR ALL TO postwave_app
    USING (
        tenant_id = NULLIF(
            pg_catalog.current_setting('app.tenant_id', true), ''
        )::uuid
    )
    WITH CHECK (
        tenant_id = NULLIF(
            pg_catalog.current_setting('app.tenant_id', true), ''
        )::uuid
    );
CREATE POLICY referral_codes_tenant_visible
    ON public.referral_codes
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (
        tenant_id = NULLIF(
            pg_catalog.current_setting('app.tenant_id', true), ''
        )::uuid
    )
    WITH CHECK (
        tenant_id = NULLIF(
            pg_catalog.current_setting('app.tenant_id', true), ''
        )::uuid
    );

ALTER TABLE public.referral_codes
    DROP CONSTRAINT IF EXISTS referral_codes_random_token_canonical_check;
ALTER TABLE public.referral_codes
    ADD CONSTRAINT referral_codes_random_token_canonical_check CHECK (
        pg_catalog.octet_length(code) = 8 AND
        code COLLATE "C" ~ '^[abcdefghijkmnpqrstuvwxyz23456789]{8}$'
    ) NOT VALID;
ALTER TABLE public.referral_codes
    DROP CONSTRAINT IF EXISTS referral_codes_desired_token_canonical_check;
ALTER TABLE public.referral_codes
    ADD CONSTRAINT referral_codes_desired_token_canonical_check CHECK (
        desired_code IS NULL OR (
            pg_catalog.octet_length(desired_code) BETWEEN 3 AND 32 AND
            desired_code = pg_catalog.lower(pg_catalog.btrim(desired_code)) AND
            desired_code COLLATE "C" ~
                '^[a-z0-9][a-z0-9-]*[a-z0-9]$' AND
            pg_catalog.strpos(desired_code, '--') = 0 AND
            desired_code NOT IN
                ('admin', 'system', 'test', 'support', 'help')
        )
    ) NOT VALID;
ALTER TABLE public.referral_codes
    VALIDATE CONSTRAINT referral_codes_random_token_canonical_check;
ALTER TABLE public.referral_codes
    VALIDATE CONSTRAINT referral_codes_desired_token_canonical_check;

CREATE TABLE public.referral_code_tokens (
    token             text PRIMARY KEY,
    referral_code_id  uuid NOT NULL
        REFERENCES public.referral_codes(id) ON DELETE CASCADE,
    tenant_id         uuid NOT NULL,
    subscriber_id     text NOT NULL,
    token_kind        text NOT NULL CHECK (token_kind IN ('code', 'desired')),
    UNIQUE (referral_code_id, token_kind),
    CHECK (
        pg_catalog.octet_length(token) BETWEEN 3 AND 32 AND
        token = pg_catalog.lower(pg_catalog.btrim(token)) AND
        token COLLATE "C" ~ '^[a-z0-9][a-z0-9-]*[a-z0-9]$' AND
        pg_catalog.strpos(token, '--') = 0
    )
);

COMMENT ON TABLE public.referral_code_tokens IS
    'Private PII-free authority for the globally unique random/branded referral token namespace; maintained only by referral_code_tokens_sync().';
COMMENT ON COLUMN public.referral_code_tokens.token IS
    'Canonical public capability token. Primary-key conflicts serialize same- and cross-column claims.';

ALTER TABLE public.referral_code_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_code_tokens FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.referral_code_tokens
    FROM PUBLIC, postwave_app, postwave_public,
         postwave_referral_code_definer;

INSERT INTO public.referral_code_tokens
       (token, referral_code_id, tenant_id, subscriber_id, token_kind)
SELECT token_rows.token,
       referral.id,
       referral.tenant_id,
       referral.subscriber_id,
       token_rows.token_kind
  FROM public.referral_codes AS referral
 CROSS JOIN LATERAL (
       VALUES
           (referral.code, 'code'::text),
           (referral.desired_code, 'desired'::text)
 ) AS token_rows(token, token_kind)
 WHERE token_rows.token IS NOT NULL
 ORDER BY token_rows.token COLLATE "C";

-- The trigger serializes every old/new token in deterministic byte order
-- before replacing the row's registry entries. The registry primary key is
-- the correctness boundary; advisory locks keep swaps/contention bounded and
-- deadlock-free for callers that set lock_timeout.
CREATE FUNCTION public.referral_code_tokens_sync()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    locked_token text;
BEGIN
    FOR locked_token IN
        SELECT distinct_token.token
          FROM (
                SELECT DISTINCT candidate.token
                  FROM pg_catalog.unnest(ARRAY[
                           CASE WHEN TG_OP = 'UPDATE' THEN OLD.code ELSE NULL END,
                           CASE WHEN TG_OP = 'UPDATE' THEN OLD.desired_code ELSE NULL END,
                           NEW.code,
                           NEW.desired_code
                       ]) AS candidate(token)
                 WHERE candidate.token IS NOT NULL
          ) AS distinct_token
         ORDER BY distinct_token.token COLLATE "C"
    LOOP
        PERFORM pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtextextended(
                'postwave:referral-code-token:' || locked_token,
                1772::bigint
            )
        );
    END LOOP;

    IF TG_OP = 'UPDATE' THEN
        DELETE FROM public.referral_code_tokens AS token
         WHERE token.referral_code_id = OLD.id;
    END IF;

    INSERT INTO public.referral_code_tokens
           (token, referral_code_id, tenant_id, subscriber_id, token_kind)
    SELECT candidate.token,
           NEW.id,
           NEW.tenant_id,
           NEW.subscriber_id,
           candidate.token_kind
      FROM (
            VALUES
                (NEW.code, 'code'::text),
                (NEW.desired_code, 'desired'::text)
      ) AS candidate(token, token_kind)
     WHERE candidate.token IS NOT NULL
     ORDER BY candidate.token COLLATE "C";

    RETURN NEW;
END;
$function$;

-- Canonicalize one bounded ASCII token and return at most one owner. Invalid
-- values intentionally return no rows, exactly like an unknown capability.
CREATE FUNCTION public.referral_code_resolve(p_token text)
RETURNS TABLE (tenant_id uuid, subscriber_id text, token_kind text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    canonical_token text;
BEGIN
    -- Bound work before normalization so direct SQL callers cannot force a
    -- large lower()/trim allocation through this public capability boundary.
    IF p_token IS NULL OR pg_catalog.octet_length(p_token) > 64 THEN
        RETURN;
    END IF;
    canonical_token := pg_catalog.lower(
        pg_catalog.btrim(
            p_token,
            pg_catalog.concat(
                ' ', pg_catalog.chr(9), pg_catalog.chr(10),
                pg_catalog.chr(11), pg_catalog.chr(12), pg_catalog.chr(13)
            )
        )
    );
    IF canonical_token IS NULL OR
       pg_catalog.octet_length(canonical_token) < 3 OR
       pg_catalog.octet_length(canonical_token) > 32 OR
       canonical_token COLLATE "C" !~
           '^[a-z0-9][a-z0-9-]*[a-z0-9]$' OR
       pg_catalog.strpos(canonical_token, '--') > 0 THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT token.tenant_id, token.subscriber_id, token.token_kind
      FROM public.referral_code_tokens AS token
     WHERE token.token = canonical_token;
END;
$function$;

GRANT USAGE, CREATE ON SCHEMA public TO postwave_referral_code_definer;
GRANT SELECT (token, referral_code_id, tenant_id, subscriber_id, token_kind),
      INSERT (token, referral_code_id, tenant_id, subscriber_id, token_kind)
    ON public.referral_code_tokens TO postwave_referral_code_definer;
GRANT DELETE ON public.referral_code_tokens
    TO postwave_referral_code_definer;

ALTER FUNCTION public.referral_code_tokens_sync()
    OWNER TO postwave_referral_code_definer;
ALTER FUNCTION public.referral_code_resolve(text)
    OWNER TO postwave_referral_code_definer;
REVOKE CREATE ON SCHEMA public FROM postwave_referral_code_definer;

REVOKE ALL ON FUNCTION public.referral_code_tokens_sync()
    FROM PUBLIC, postwave_app, postwave_public;
REVOKE ALL ON FUNCTION public.referral_code_resolve(text)
    FROM PUBLIC, postwave_app, postwave_public;
GRANT EXECUTE ON FUNCTION public.referral_code_resolve(text)
    TO postwave_app;

CREATE TRIGGER referral_code_tokens_sync
    AFTER INSERT OR UPDATE OF code, desired_code, tenant_id, subscriber_id
    ON public.referral_codes
    FOR EACH ROW
    EXECUTE FUNCTION public.referral_code_tokens_sync();

COMMENT ON FUNCTION public.referral_code_resolve(text) IS
    'Resolves one canonical public referral capability to its tenant and source subscriber without exposing referral_codes or the token registry.';
COMMENT ON FUNCTION public.referral_code_tokens_sync() IS
    'Maintains the private globally unique referral token registry after each referral_codes write.';

-- Click recording re-enters the already-resolved tenant scope. Give that
-- table the same explicit restrictive + permissive tenant pair; the legacy
-- public-click GUC is no longer an authorization mechanism.
DROP POLICY IF EXISTS tenant_isolation ON public.referral_clicks;
DROP POLICY IF EXISTS referral_clicks_tenant_visible ON public.referral_clicks;
CREATE POLICY referral_clicks_tenant_isolation
    ON public.referral_clicks
    AS RESTRICTIVE FOR ALL TO postwave_app
    USING (
        tenant_id = NULLIF(
            pg_catalog.current_setting('app.tenant_id', true), ''
        )::uuid
    )
    WITH CHECK (
        tenant_id = NULLIF(
            pg_catalog.current_setting('app.tenant_id', true), ''
        )::uuid
    );
CREATE POLICY referral_clicks_tenant_visible
    ON public.referral_clicks
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (
        tenant_id = NULLIF(
            pg_catalog.current_setting('app.tenant_id', true), ''
        )::uuid
    )
    WITH CHECK (
        tenant_id = NULLIF(
            pg_catalog.current_setting('app.tenant_id', true), ''
        )::uuid
    );

DO $postcheck$
DECLARE
    definer_oid oid := (
        SELECT oid FROM pg_catalog.pg_roles
         WHERE rolname = 'postwave_referral_code_definer'
    );
    app_oid oid := (
        SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'postwave_app'
    );
    sync_oid oid := pg_catalog.to_regprocedure(
        'public.referral_code_tokens_sync()'
    );
    resolve_oid oid := pg_catalog.to_regprocedure(
        'public.referral_code_resolve(text)'
    );
BEGIN
    IF definer_oid IS NULL OR sync_oid IS NULL OR resolve_oid IS NULL THEN
        RAISE EXCEPTION '1772 referral boundary objects are missing';
    END IF;
    IF pg_catalog.has_schema_privilege(
        'postwave_referral_code_definer', 'public', 'CREATE'
    ) THEN
        RAISE EXCEPTION 'referral definer retained CREATE on public';
    END IF;
    IF NOT pg_catalog.has_column_privilege(
        'postwave_referral_code_definer', 'public.referral_code_tokens',
        'token', 'SELECT'
    ) OR NOT pg_catalog.has_column_privilege(
        'postwave_referral_code_definer', 'public.referral_code_tokens',
        'token', 'INSERT'
    ) OR NOT pg_catalog.has_table_privilege(
        'postwave_referral_code_definer', 'public.referral_code_tokens',
        'DELETE'
    ) OR pg_catalog.has_table_privilege(
        'postwave_referral_code_definer', 'public.referral_codes',
        'SELECT,INSERT,UPDATE,DELETE'
    ) THEN
        RAISE EXCEPTION 'referral definer table privileges are unsafe';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM information_schema.table_privileges AS privilege
         WHERE privilege.grantee = 'postwave_referral_code_definer'
           AND (
                privilege.table_schema <> 'public' OR
                privilege.table_name <> 'referral_code_tokens' OR
                privilege.privilege_type <> 'DELETE'
           )
    ) OR EXISTS (
        SELECT 1
          FROM information_schema.column_privileges AS privilege
         WHERE privilege.grantee = 'postwave_referral_code_definer'
           AND (
                privilege.table_schema <> 'public' OR
                privilege.table_name <> 'referral_code_tokens' OR
                privilege.privilege_type NOT IN ('SELECT', 'INSERT')
           )
    ) THEN
        RAISE EXCEPTION 'referral definer has out-of-bound relation grants';
    END IF;
    IF pg_catalog.has_table_privilege(
        'postwave_app', 'public.referral_code_tokens',
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'
    ) OR pg_catalog.has_table_privilege(
        'postwave_public', 'public.referral_code_tokens',
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'
    ) THEN
        RAISE EXCEPTION 'runtime role can access the private token registry';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_catalog.pg_proc AS proc
          JOIN pg_catalog.pg_language AS language
            ON language.oid = proc.prolang
         WHERE proc.oid IN (sync_oid, resolve_oid)
           AND (
                proc.proowner <> definer_oid OR
                NOT proc.prosecdef OR
                proc.prokind <> 'f' OR
                language.lanname <> 'plpgsql' OR
                proc.proconfig IS DISTINCT FROM
                    ARRAY['search_path=pg_catalog']::text[] OR
                (proc.oid = sync_oid AND proc.provolatile <> 'v') OR
                (proc.oid = resolve_oid AND proc.provolatile <> 's')
           )
    ) THEN
        RAISE EXCEPTION 'referral boundary function metadata is unsafe';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_catalog.pg_proc AS proc
         CROSS JOIN LATERAL pg_catalog.aclexplode(
             COALESCE(
                 proc.proacl,
                 pg_catalog.acldefault('f', proc.proowner)
             )
         ) AS acl
         WHERE proc.oid IN (sync_oid, resolve_oid)
           AND acl.privilege_type = 'EXECUTE'
           AND (
                (proc.oid = sync_oid AND acl.grantee <> definer_oid) OR
                (proc.oid = resolve_oid AND
                 acl.grantee NOT IN (definer_oid, app_oid))
           )
    ) THEN
        RAISE EXCEPTION 'unexpected referral boundary function grantee';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_catalog.pg_class AS relation
         WHERE relation.relowner = definer_oid
    ) OR EXISTS (
        SELECT 1
          FROM pg_catalog.pg_namespace AS namespace
         WHERE namespace.nspowner = definer_oid
    ) OR EXISTS (
        SELECT 1
          FROM pg_catalog.pg_proc AS proc
         WHERE proc.proowner = definer_oid
           AND proc.oid NOT IN (sync_oid, resolve_oid)
    ) THEN
        RAISE EXCEPTION 'referral definer owns an out-of-bound object';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_catalog.pg_policies
         WHERE schemaname = 'public'
           AND tablename = 'referral_codes'
           AND policyname = 'referral_codes_public_lookup'
    ) OR NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_policies
         WHERE schemaname = 'public'
           AND tablename = 'referral_codes'
           AND policyname = 'referral_codes_tenant_visible'
           AND roles = ARRAY['postwave_app']::name[]
    ) THEN
        RAISE EXCEPTION 'referral_codes RLS policy boundary is unsafe';
    END IF;
    IF NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_class
         WHERE oid = 'public.referral_code_tokens'::regclass
           AND relrowsecurity
           AND relforcerowsecurity
    ) THEN
        RAISE EXCEPTION 'private referral token registry must force RLS';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM public.referral_codes AS referral
         WHERE NOT EXISTS (
                   SELECT 1
                     FROM public.referral_code_tokens AS token
                    WHERE token.referral_code_id = referral.id
                      AND token.token_kind = 'code'
                      AND token.token = referral.code
                      AND token.tenant_id = referral.tenant_id
                      AND token.subscriber_id = referral.subscriber_id
               )
            OR (
                referral.desired_code IS NOT NULL AND NOT EXISTS (
                    SELECT 1
                      FROM public.referral_code_tokens AS token
                     WHERE token.referral_code_id = referral.id
                       AND token.token_kind = 'desired'
                       AND token.token = referral.desired_code
                       AND token.tenant_id = referral.tenant_id
                       AND token.subscriber_id = referral.subscriber_id
                )
            )
    ) OR EXISTS (
        SELECT 1
          FROM public.referral_code_tokens AS token
          LEFT JOIN public.referral_codes AS referral
            ON referral.id = token.referral_code_id
         WHERE referral.id IS NULL OR
               token.tenant_id <> referral.tenant_id OR
               token.subscriber_id <> referral.subscriber_id OR
               (token.token_kind = 'code' AND token.token <> referral.code) OR
               (token.token_kind = 'desired' AND
                token.token <> referral.desired_code)
    ) THEN
        RAISE EXCEPTION 'referral token registry is not synchronized';
    END IF;
END;
$postcheck$;

COMMIT;
