-- 2006_verification_subscriber_email_identity_predicate.sql
--
-- A positive subscriber_emails row is deliberately hidden from postwave_app
-- when its exact-address consent proof is missing or expired. Email-health
-- reads still need one bit of information about that hidden row: whether an
-- exact subscriber identity exists. Without it, a later suppression write can
-- become the address-state row's last source and make an unproven secondary
-- address look like suppression-only history.
--
-- Expose only a tenant-bound boolean predicate. Its dedicated NOLOGIN,
-- BYPASSRLS owner can select only subscriber_emails.(tenant_id,email). The
-- function checks app.tenant_id before its one fixed query and returns no
-- subscriber UUID, consent value, or other profile data. BYPASSRLS is required
-- here so later restrictive-policy drift cannot silently turn a real hidden
-- identity into false and reopen the fail-open health classification.
--
-- migration-execution: transactional
-- rollback-strategy: expand-contract
-- rollback-details: Keep the predicate and its isolated owner while any
-- email-health binary calls it. Removing it first reopens a fail-open consent
-- classification for hidden secondary addresses whose last state source is a
-- suppression table.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $role$
DECLARE
    resolver pg_catalog.pg_roles%ROWTYPE;
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_roles
         WHERE rolname = 'postwave_verification_identity_resolver'
    ) THEN
        CREATE ROLE postwave_verification_identity_resolver
            NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
            NOREPLICATION BYPASSRLS;
    END IF;

    SELECT * INTO resolver
      FROM pg_catalog.pg_roles
     WHERE rolname = 'postwave_verification_identity_resolver';

    IF resolver.rolcanlogin OR resolver.rolsuper OR resolver.rolcreatedb OR
       resolver.rolcreaterole OR resolver.rolinherit OR
       resolver.rolreplication OR NOT resolver.rolbypassrls THEN
        RAISE EXCEPTION
            'postwave_verification_identity_resolver has unsafe role attributes';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_catalog.pg_auth_members
         WHERE member = resolver.oid OR roleid = resolver.oid
    ) THEN
        RAISE EXCEPTION
            'postwave_verification_identity_resolver must have no memberships or members';
    END IF;
END
$role$;

-- Converge a pre-provisioned purpose role on the reviewed direct grant set.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
    FROM postwave_verification_identity_resolver;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public
    FROM postwave_verification_identity_resolver;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public
    FROM postwave_verification_identity_resolver;
REVOKE ALL ON SCHEMA public
    FROM postwave_verification_identity_resolver;

GRANT USAGE, CREATE ON SCHEMA public
    TO postwave_verification_identity_resolver;
GRANT SELECT (tenant_id, email) ON public.subscriber_emails
    TO postwave_verification_identity_resolver;
GRANT EXECUTE ON FUNCTION
    public.subscriber_email_consent_normalize_email(pg_catalog.text)
    TO postwave_verification_identity_resolver;

-- A previous development build used a role-specific policy. Remove it: the
-- fixed predicate's exact tenant check, narrow column grant, and isolated
-- BYPASSRLS owner are intentionally independent from mutable table policies.
DROP POLICY IF EXISTS verification_subscriber_identity_resolver_select
    ON public.subscriber_emails;

CREATE OR REPLACE FUNCTION
    public.verification_subscriber_email_identity_exists(
        p_tenant_id pg_catalog.uuid,
        p_normalized_email pg_catalog.text
    )
RETURNS pg_catalog.bool
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
DECLARE
    configured_tenant pg_catalog.uuid;
BEGIN
    configured_tenant := NULLIF(
        pg_catalog.current_setting('app.tenant_id', true), ''
    )::pg_catalog.uuid;
    IF configured_tenant IS NULL OR p_tenant_id IS NULL OR
       configured_tenant <> p_tenant_id THEN
        RAISE EXCEPTION
            'verification subscriber identity tenant scope is missing or mismatched'
            USING ERRCODE = '42501';
    END IF;
    -- Bound the byte string before normalization. PostgreSQL may reorder
    -- boolean expressions, so keeping these as two statements prevents a
    -- hostile direct caller from making lower/btrim process an unbounded value.
    IF p_normalized_email IS NULL OR
       pg_catalog.octet_length(p_normalized_email) NOT BETWEEN 3 AND 320 THEN
        RAISE EXCEPTION
            'verification subscriber identity email is outside the canonical contract'
            USING ERRCODE = '22023';
    END IF;
    IF p_normalized_email IS DISTINCT FROM
       public.subscriber_email_consent_normalize_email(p_normalized_email) THEN
        RAISE EXCEPTION
            'verification subscriber identity email is outside the canonical contract'
            USING ERRCODE = '22023';
    END IF;

    RETURN EXISTS (
        SELECT 1
          FROM public.subscriber_emails AS address
         WHERE address.tenant_id = p_tenant_id
           AND public.subscriber_email_consent_normalize_email(
                   address.email::pg_catalog.text
               ) = p_normalized_email
    );
END
$function$;

ALTER FUNCTION public.verification_subscriber_email_identity_exists(
    pg_catalog.uuid, pg_catalog.text
) OWNER TO postwave_verification_identity_resolver;
REVOKE CREATE ON SCHEMA public
    FROM postwave_verification_identity_resolver;

REVOKE ALL ON FUNCTION public.verification_subscriber_email_identity_exists(
    pg_catalog.uuid, pg_catalog.text
) FROM PUBLIC, postwave_public, postwave_app;
GRANT EXECUTE ON FUNCTION
    public.verification_subscriber_email_identity_exists(
        pg_catalog.uuid, pg_catalog.text
    ) TO postwave_app;

COMMENT ON FUNCTION public.verification_subscriber_email_identity_exists(
    pg_catalog.uuid, pg_catalog.text
) IS
    'Returns only whether one exact subscriber_emails identity exists inside '
    'the caller-bound tenant, including a positive row hidden by consent RLS; '
    'used to keep email-health consent classification fail closed.';

DO $assertions$
DECLARE
    resolver pg_catalog.pg_roles%ROWTYPE;
    function_row pg_catalog.pg_proc%ROWTYPE;
BEGIN
    SELECT * INTO resolver
      FROM pg_catalog.pg_roles
     WHERE rolname = 'postwave_verification_identity_resolver';
    IF NOT FOUND OR resolver.rolcanlogin OR resolver.rolsuper OR
       resolver.rolcreatedb OR resolver.rolcreaterole OR resolver.rolinherit OR
       resolver.rolreplication OR NOT resolver.rolbypassrls OR EXISTS (
           SELECT 1
             FROM pg_catalog.pg_auth_members
            WHERE member = resolver.oid OR roleid = resolver.oid
       ) THEN
        RAISE EXCEPTION
            'verification identity resolver role contract is unsafe';
    END IF;

    SELECT * INTO function_row
      FROM pg_catalog.pg_proc
     WHERE oid =
           'public.verification_subscriber_email_identity_exists(uuid,text)'
           ::pg_catalog.regprocedure;
    IF function_row.proowner <> resolver.oid OR NOT function_row.prosecdef OR
       function_row.provolatile <> 's' OR function_row.proretset OR
       function_row.prorettype <> 'pg_catalog.bool'::pg_catalog.regtype OR
       function_row.proconfig IS DISTINCT FROM ARRAY[
           'search_path=pg_catalog, pg_temp',
           'row_security=off'
       ]::pg_catalog.text[] OR
       pg_catalog.strpos(
           pg_catalog.upper(function_row.prosrc), 'EXECUTE'
       ) <> 0 THEN
        RAISE EXCEPTION
            'verification identity predicate metadata is unsafe';
    END IF;

    IF pg_catalog.has_schema_privilege(
           'postwave_verification_identity_resolver', 'public', 'CREATE'
       ) OR
       pg_catalog.has_table_privilege(
           'postwave_verification_identity_resolver',
           'public.subscriber_emails', 'SELECT'
       ) OR
       NOT pg_catalog.has_column_privilege(
           'postwave_verification_identity_resolver',
           'public.subscriber_emails', 'tenant_id', 'SELECT'
       ) OR
       NOT pg_catalog.has_column_privilege(
           'postwave_verification_identity_resolver',
           'public.subscriber_emails', 'email', 'SELECT'
       ) OR EXISTS (
           SELECT 1
             FROM pg_catalog.pg_attribute AS attribute
            WHERE attribute.attrelid =
                      'public.subscriber_emails'::pg_catalog.regclass
              AND attribute.attnum > 0
              AND NOT attribute.attisdropped
              AND attribute.attname NOT IN ('tenant_id', 'email')
              AND pg_catalog.has_column_privilege(
                  'postwave_verification_identity_resolver',
                  'public.subscriber_emails', attribute.attname, 'SELECT'
              )
       ) THEN
        RAISE EXCEPTION
            'verification identity resolver relation grants are too broad';
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_policy AS policy
         WHERE policy.polrelid =
                   'public.subscriber_emails'::pg_catalog.regclass
           AND policy.polname =
                   'verification_subscriber_identity_resolver_select'
    ) THEN
        RAISE EXCEPTION
            'verification identity resolver must not depend on mutable RLS policy';
    END IF;

    IF NOT pg_catalog.has_function_privilege(
           'postwave_app',
           'public.verification_subscriber_email_identity_exists(uuid,text)',
           'EXECUTE'
       ) OR pg_catalog.has_function_privilege(
           'public',
           'public.verification_subscriber_email_identity_exists(uuid,text)',
           'EXECUTE'
       ) OR pg_catalog.has_function_privilege(
           'postwave_public',
           'public.verification_subscriber_email_identity_exists(uuid,text)',
           'EXECUTE'
       ) OR EXISTS (
           SELECT 1
             FROM pg_catalog.aclexplode(
                 COALESCE(
                     function_row.proacl,
                     pg_catalog.acldefault('f', function_row.proowner)
                 )
             ) AS privilege
            WHERE privilege.privilege_type = 'EXECUTE'
              AND privilege.grantee NOT IN (
                  function_row.proowner,
                  (
                      SELECT role.oid
                        FROM pg_catalog.pg_roles AS role
                       WHERE role.rolname = 'postwave_app'
                  )
              )
       ) THEN
        RAISE EXCEPTION
            'verification identity predicate execute grants are unsafe';
    END IF;
END
$assertions$;

COMMIT;
