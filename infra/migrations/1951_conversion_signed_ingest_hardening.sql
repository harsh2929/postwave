-- Harden signed conversion ingest at both trust boundaries.
--
-- 1. A key id must resolve to exactly one live workspace. Migration 1944 made
--    key ids unique only inside a tenant, while the public endpoint necessarily
--    resolves them before it knows the tenant. Two workspaces could therefore
--    publish the same key id and make tenant selection depend on which matching
--    row PostgreSQL happened to return first.
--
-- 2. Migration 1950 admitted the shared application role to a cross-tenant RLS
--    policy whenever it set a custom GUC. Any postwave_app session can set a
--    custom GUC, so that policy was a broad secret-reading capability rather
--    than a resolver boundary. A purpose-built NOLOGIN/NOBYPASSRLS role now
--    owns one fixed-query SECURITY DEFINER function. The role can read only the
--    six columns the function filters/returns and has no memberships or schema
--    CREATE.
--
-- 3. Version-2 signatures bind the globally unique key id into the signed
--    preimage. Existing live secrets receive a finite v1 compatibility window;
--    secrets created after this migration receive an expired fence and are
--    v2-only by default. This avoids a
--    flag-day outage without preserving the key-substitution weakness forever.
--
-- migration-execution: phased
-- rollback-strategy: no-op. Reinstating the GUC policy or permitting ambiguous
-- live key ids would re-open the cross-tenant resolver defect. Roll back the
-- application first; remove this function only after every caller has moved.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

ALTER TABLE public.conversion_ingest_secrets
    ADD COLUMN IF NOT EXISTS legacy_v1_until timestamptz;

-- Make reruns fail closed. Existing rows are still NULL at this point and are
-- granted the finite bridge below; credentials created after this transaction
-- receive an already-expired sentinel even if a later concurrent-index phase
-- has to be retried.
ALTER TABLE public.conversion_ingest_secrets
    ALTER COLUMN legacy_v1_until
    SET DEFAULT '-infinity'::timestamptz;

-- Prevent a legacy writer from inserting a colliding live key while the
-- concurrent unique index is being built. This trigger is intentionally kept
-- after the index exists: it serializes key rotation through the same advisory
-- lock and lets the partial unique index remain the final race-safe arbiter.
CREATE OR REPLACE FUNCTION public.conversion_ingest_secret_lock_key_id()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $guard$
BEGIN
    IF NEW.revoked_at IS NULL THEN
        PERFORM pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtextextended(NEW.key_id, 1951)
        );
        IF EXISTS (
            SELECT 1
              FROM public.conversion_ingest_secrets AS existing
             WHERE existing.key_id = NEW.key_id
               AND existing.revoked_at IS NULL
               AND existing.id <> NEW.id
        ) THEN
            RAISE EXCEPTION USING
                ERRCODE = '23505',
                MESSAGE = 'conversion signing key id is already live',
                CONSTRAINT = 'conversion_ingest_secrets_live_key_id_uniq';
        END IF;
    END IF;
    RETURN NEW;
END
$guard$;

DROP TRIGGER IF EXISTS conversion_ingest_secrets_live_key_guard
    ON public.conversion_ingest_secrets;
CREATE TRIGGER conversion_ingest_secrets_live_key_guard
    BEFORE INSERT OR UPDATE OF key_id, revoked_at
    ON public.conversion_ingest_secrets
    FOR EACH ROW
    EXECUTE FUNCTION public.conversion_ingest_secret_lock_key_id();

-- Only credentials that existed before this migration receive compatibility.
-- A newly-created credential has the already-expired default and can never
-- authenticate v1.
UPDATE public.conversion_ingest_secrets
   SET legacy_v1_until = pg_catalog.clock_timestamp() + interval '30 days'
 WHERE legacy_v1_until IS NULL;

ALTER TABLE public.conversion_ingest_secrets
    ALTER COLUMN legacy_v1_until SET NOT NULL;

-- Fail with an actionable message before CREATE UNIQUE INDEX emits a much less
-- useful duplicate-key diagnostic. We do not silently revoke or rename a
-- customer's credential: either choice would change which workspace a signed
-- request reaches. Operators must rotate the colliding ids deliberately.
DO $duplicates$
DECLARE
    duplicate_key text;
BEGIN
    SELECT secret.key_id
      INTO duplicate_key
      FROM public.conversion_ingest_secrets AS secret
     WHERE secret.revoked_at IS NULL
     GROUP BY secret.key_id
    HAVING pg_catalog.count(*) > 1
     ORDER BY secret.key_id
     LIMIT 1;

    IF duplicate_key IS NOT NULL THEN
        RAISE EXCEPTION
            'cannot harden conversion signing: live key_id % belongs to more than one tenant; rotate the colliding credentials first',
            duplicate_key;
    END IF;
END
$duplicates$;

COMMIT;

DROP INDEX CONCURRENTLY IF EXISTS public.conversion_ingest_secrets_live_idx;
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS conversion_ingest_secrets_live_key_id_uniq
    ON public.conversion_ingest_secrets (key_id)
    WHERE revoked_at IS NULL;

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

ALTER TABLE public.conversion_ingest_secrets FORCE ROW LEVEL SECURITY;
ALTER TABLE public.conversion_ingest_idempotency FORCE ROW LEVEL SECURITY;

-- Remove the caller-controlled cross-tenant capability installed by 1950.
DROP POLICY IF EXISTS conversion_ingest_secrets_resolver_select
    ON public.conversion_ingest_secrets;

DO $role$
DECLARE
    resolver pg_catalog.pg_roles%ROWTYPE;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles
         WHERE rolname = 'postwave_conversion_secret_resolver'
    ) THEN
        CREATE ROLE postwave_conversion_secret_resolver
            NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
            NOREPLICATION NOBYPASSRLS;
    END IF;

    SELECT * INTO resolver
      FROM pg_catalog.pg_roles
     WHERE rolname = 'postwave_conversion_secret_resolver';

    IF resolver.rolcanlogin OR resolver.rolsuper OR resolver.rolcreatedb OR
       resolver.rolcreaterole OR resolver.rolinherit OR
       resolver.rolreplication OR resolver.rolbypassrls THEN
        RAISE EXCEPTION
            'postwave_conversion_secret_resolver has unsafe role attributes';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_auth_members
         WHERE member = resolver.oid OR roleid = resolver.oid
    ) THEN
        RAISE EXCEPTION
            'postwave_conversion_secret_resolver must have no memberships or members';
    END IF;
END
$role$;

-- Converge a pre-provisioned purpose role on the reviewed grant set.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
    FROM postwave_conversion_secret_resolver;
GRANT USAGE, CREATE ON SCHEMA public
    TO postwave_conversion_secret_resolver;
GRANT SELECT (
    tenant_id, key_id, secret, secret_envelope, revoked_at, legacy_v1_until
) ON public.conversion_ingest_secrets
    TO postwave_conversion_secret_resolver;

-- RLS remains visible in the policy inventory. The definer deliberately does
-- not BYPASSRLS, so this exact table/policy/column grant is its whole authority.
DROP POLICY IF EXISTS conversion_ingest_secrets_fixed_resolver_select
    ON public.conversion_ingest_secrets;
CREATE POLICY conversion_ingest_secrets_fixed_resolver_select
    ON public.conversion_ingest_secrets
    FOR SELECT TO postwave_conversion_secret_resolver
    USING (revoked_at IS NULL);

DROP FUNCTION IF EXISTS public.resolve_conversion_ingest_secret(text);
CREATE FUNCTION public.resolve_conversion_ingest_secret(
    p_key_id pg_catalog.text
)
RETURNS TABLE (
    tenant_id pg_catalog.uuid,
    secret pg_catalog.text,
    secret_envelope pg_catalog.bytea,
    legacy_v1_until pg_catalog.timestamptz
)
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
ROWS 1
AS $function$
    SELECT stored.tenant_id,
           stored.secret,
           stored.secret_envelope,
           stored.legacy_v1_until
      FROM public.conversion_ingest_secrets AS stored
     WHERE stored.key_id = p_key_id
       AND stored.revoked_at IS NULL
$function$;

ALTER FUNCTION public.resolve_conversion_ingest_secret(text)
    OWNER TO postwave_conversion_secret_resolver;
REVOKE CREATE ON SCHEMA public
    FROM postwave_conversion_secret_resolver;

-- Function EXECUTE defaults to PUBLIC, so revoke before admitting only the API
-- role. postwave_public is named explicitly because it is the anonymous role.
REVOKE ALL ON FUNCTION public.resolve_conversion_ingest_secret(text)
    FROM PUBLIC, postwave_public;
GRANT EXECUTE ON FUNCTION public.resolve_conversion_ingest_secret(text)
    TO postwave_app;

COMMENT ON FUNCTION public.resolve_conversion_ingest_secret(text) IS
    'Resolves one globally-unambiguous live conversion signing key. Owned by a '
    'NOLOGIN/NOBYPASSRLS role with exact column grants; postwave_app receives '
    'EXECUTE only. Replaces the caller-set resolver GUC policy from migration '
    '1950. The returned legacy_v1_until is a finite compatibility fence; an '
    'already-expired value means v2 key-bound signatures only.';

-- Migration-time assertions keep later edits from silently broadening the
-- capability while leaving the happy-path application tests green.
DO $audit$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_policies
         WHERE schemaname = 'public'
           AND tablename = 'conversion_ingest_secrets'
           AND policyname = 'conversion_ingest_secrets_resolver_select'
    ) THEN
        RAISE EXCEPTION 'caller-controlled conversion resolver policy still exists';
    END IF;
    IF pg_catalog.has_schema_privilege(
        'postwave_conversion_secret_resolver', 'public', 'CREATE'
    ) THEN
        RAISE EXCEPTION 'conversion secret resolver retained schema CREATE';
    END IF;
    IF NOT pg_catalog.has_function_privilege(
        'postwave_app',
        'public.resolve_conversion_ingest_secret(text)',
        'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
        'postwave_public',
        'public.resolve_conversion_ingest_secret(text)',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'conversion secret resolver EXECUTE grants are unsafe';
    END IF;
END
$audit$;

COMMIT;
