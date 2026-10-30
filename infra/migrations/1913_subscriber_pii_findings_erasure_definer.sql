-- 1913_subscriber_pii_findings_erasure_definer.sql
--
-- GDPR erasure could not remove a subject's PII findings, and the obvious fix
-- breaks a deliberate immutability contract. This migration does neither.
--
-- `privacy.eraseSubscriber` deletes the subject's rows from thirteen profile
-- satellite tables. One of them is `subscriber_pii_findings`:
--
--     DELETE FROM subscriber_pii_findings
--      WHERE tenant_id = $1 AND subscriber_id IN (SELECT id FROM subscribers ...)
--
-- `postwave_app` holds no DELETE on that table, so every erasure aborted with
-- `permission denied for table subscriber_pii_findings` — and because the loop
-- returns on the first error, the deletes that come after it in the list never
-- ran either. An erasure request that fails is better than one that silently
-- half-completes, but a subject-access deletion that cannot complete at all is
-- still a compliance defect.
--
-- A BARE `GRANT DELETE ... TO postwave_app` IS WRONG HERE, and this is the
-- second attempt. `pii_scanner`'s repository test asserts, by name, that the
-- app role has NO delete and NO truncate privilege on either the findings
-- table or its review receipts:
--
--     has_table_privilege(current_user, 'subscriber_pii_findings', 'DELETE')
--
-- A finding is an accusation that a tenant is storing personal data in a field
-- that should not hold it, and a receipt is the record of a human reviewing
-- that accusation. Both are evidence about the tenant, so the tenant must not
-- be able to delete either. That is the contract, and it is tested.
--
-- THE CAPABILITY-GATED-GRANT PATTERN CANNOT SATISFY IT. Migrations 1902, 1908
-- and 1909 solved the same "compliance job lacks the write it exists to
-- perform" shape with a plain grant plus a RESTRICTIVE policy gated on a worker
-- GUC. That does not work here, because the test inspects the GRANT rather than
-- the effective ability: `has_table_privilege` would report true the moment the
-- grant exists, however narrowly RLS then confines it. The contract is written
-- at the privilege layer, so the fix has to leave the privilege layer alone.
--
-- SO THE DELETE MOVES BEHIND A FUNCTION, which is the idiom this schema already
-- uses seven times over (1738, 1739, 1764, 1772, 1774, and the discovery
-- definers). A dedicated NOLOGIN/NOINHERIT/BYPASSRLS role owns a fixed-SQL
-- SECURITY DEFINER function; `postwave_app` gets EXECUTE on the function and
-- nothing on the table. `has_table_privilege` stays false, the immutability
-- contract holds, and erasure completes.
--
-- BYPASSRLS IS REQUIRED, not incidental: both tables carry FORCE ROW LEVEL
-- SECURITY, which applies RLS even to the table owner, so a definer without it
-- would be confined by the very policies it needs to reach past.
--
-- THE TENANT PARAMETER IS BOUND TO THE SESSION, which is the property a bare
-- grant would have had for free and a definer function otherwise throws away.
-- Under RLS, `postwave_app` could only ever delete rows of its own tenant. A
-- function that trusts `p_tenant_id` would let any caller holding EXECUTE erase
-- any tenant's findings by naming its uuid — a cross-tenant destructive
-- capability handed out to fix a permission error. The function therefore
-- requires the argument to equal `app.tenant_id` and raises otherwise, so the
-- reachable blast radius is identical to the RLS-confined delete it replaces.
-- It raises rather than returning zero: a caller that disagrees with its own
-- session about which tenant it is erasing has a bug, and a silent no-op would
-- report a successful erasure that deleted nothing.
--
-- RECEIPTS ARE NOT GRANTED SEPARATELY. `subscriber_pii_review_receipts_finding_fk`
-- is ON DELETE CASCADE, and a referential action runs with the constraint's own
-- rights rather than the caller's, so removing a finding removes its receipts
-- without the definer holding DELETE on that table.
--
-- That was verified rather than assumed, because it is the kind of claim that
-- would fail only in production: a throwaway parent/child pair with FORCE ROW
-- LEVEL SECURITY on both and NO privilege of any kind granted on the child,
-- deleted through a SECURITY DEFINER function owned by this same role. The
-- parent delete succeeded and the child row was gone, confirming the cascade
-- needs neither the privilege nor an RLS exemption on the referencing table.

BEGIN;

-- Undo the first attempt. Written unconditionally so an environment that
-- already applied the bare grant converges on the correct state, and harmless
-- on a fresh database where the grant never existed.
REVOKE DELETE ON subscriber_pii_findings FROM postwave_app;

-- The owning role. Same attribute assertions the other definer roles make:
-- a role that can log in, inherit, or hold unrelated privileges would turn a
-- narrow capability into a general one.
DO $role$
DECLARE
    definer pg_catalog.pg_roles%ROWTYPE;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles
         WHERE rolname = 'postwave_pii_erasure_definer'
    ) THEN
        CREATE ROLE postwave_pii_erasure_definer
            NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
            NOREPLICATION BYPASSRLS;
    END IF;
    SELECT * INTO definer FROM pg_catalog.pg_roles
     WHERE rolname = 'postwave_pii_erasure_definer';
    IF definer.rolcanlogin OR definer.rolsuper OR definer.rolcreatedb OR
       definer.rolcreaterole OR definer.rolinherit OR
       definer.rolreplication OR NOT definer.rolbypassrls THEN
        RAISE EXCEPTION 'postwave_pii_erasure_definer has unsafe role attributes';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_auth_members
         WHERE member = definer.oid OR roleid = definer.oid
    ) THEN
        RAISE EXCEPTION 'postwave_pii_erasure_definer must have no memberships';
    END IF;
END
$role$;

-- Exactly what the function body touches, and nothing else. SELECT on
-- subscribers because the subject is identified by address; SELECT and DELETE
-- on the findings table because that is the row being erased.
GRANT USAGE ON SCHEMA public TO postwave_pii_erasure_definer;
GRANT SELECT (id, tenant_id, email) ON public.subscribers
    TO postwave_pii_erasure_definer;
GRANT SELECT, DELETE ON public.subscriber_pii_findings
    TO postwave_pii_erasure_definer;

-- pg_temp IS LISTED, AND LISTED LAST. This is not stylistic; omitting it makes
-- the function a privilege-escalation primitive, which a review of the first
-- version of this migration demonstrated by exploiting it.
--
-- When `pg_temp` is absent from an explicit search_path, PostgreSQL still
-- searches the caller's temporary schema — and searches it FIRST for relation
-- and TYPE names. Every unqualified type in the body was therefore
-- attacker-controllable. Naming pg_temp explicitly puts it last in resolution
-- order instead of implicitly first.
--
-- The exploit, run as `postwave_app` against a real database: create
-- `pg_temp.evil(text)` containing arbitrary SQL, then
-- `CREATE DOMAIN pg_temp.uuid AS text CHECK (pg_temp.evil(VALUE))`, then call
-- this function normally. The body's `session_tenant uuid` bound to the
-- attacker's domain, so its CHECK ran inside the SECURITY DEFINER context —
-- i.e. as a BYPASSRLS role. The injected statement saw 244 subscribers across
-- 144 distinct tenants; the identical read as `postwave_app` under RLS returns
-- zero rows and zero tenants. Nothing about the tenant-binding check below
-- helps, because the attacker's code runs before and independently of it.
--
-- So the narrow, tenant-confined delete this migration set out to grant was in
-- fact a general cross-tenant read/write capability, defeating the blast-radius
-- claim made above. The types are additionally schema-qualified below: pg_temp
-- last is what closes the hole, and qualification means a future edit that
-- forgets the search_path clause is not instantly exploitable again.
--
-- The qualified spelling of bigint is `pg_catalog.int8`: `bigint` is a name the
-- SQL grammar recognises rather than a catalog entry, so `pg_catalog.bigint`
-- does not exist and fails at CREATE. `uuid` and `citext` are real catalog and
-- extension types and qualify normally.
--
-- This is a CLASS, not an instance. Sibling definer functions in 1738, 1739,
-- 1764, 1772, 1774 and 1849 also omit pg_temp; each is exposed exactly insofar
-- as its body names an unqualified type. They are swept in 1915 rather than
-- here, so this migration stays about one function.
DROP FUNCTION IF EXISTS public.subscriber_pii_findings_erase(uuid, citext);
CREATE FUNCTION public.subscriber_pii_findings_erase(
    p_tenant_id pg_catalog.uuid,
    p_email public.citext
)
RETURNS pg_catalog.int8
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    session_tenant pg_catalog.uuid;
    erased pg_catalog.int8;
BEGIN
    IF p_tenant_id IS NULL OR p_email IS NULL THEN
        RAISE EXCEPTION
            'subscriber_pii_findings_erase requires a tenant and an address';
    END IF;

    -- The session's own tenant is the authority, not the argument. See the
    -- header: without this the function is a cross-tenant delete capability.
    -- NULLIF is unqualified because it is SQL syntax rather than a function;
    -- `pg_catalog.nullif` does not exist and fails at run time, not at CREATE.
    -- Being a construct, it is search_path-safe as written.
    session_tenant := NULLIF(
        pg_catalog.current_setting('app.tenant_id', true), ''
    )::pg_catalog.uuid;
    IF session_tenant IS NULL THEN
        RAISE EXCEPTION
            'subscriber_pii_findings_erase requires app.tenant_id to be set';
    END IF;
    IF session_tenant <> p_tenant_id THEN
        RAISE EXCEPTION
            'subscriber_pii_findings_erase refused: tenant % does not match session tenant %',
            p_tenant_id, session_tenant;
    END IF;

    WITH removed AS (
        DELETE FROM public.subscriber_pii_findings AS finding
         WHERE finding.tenant_id = p_tenant_id
           AND finding.subscriber_id IN (
               SELECT subscriber.id
                 FROM public.subscribers AS subscriber
                WHERE subscriber.tenant_id = p_tenant_id
                  AND subscriber.email = p_email
           )
        RETURNING 1
    )
    SELECT pg_catalog.count(*) INTO erased FROM removed;

    RETURN erased;
END;
$function$;

-- A function's owner needs CREATE on its schema to hold it; the role gives the
-- privilege back immediately so it cannot create anything else.
GRANT CREATE ON SCHEMA public TO postwave_pii_erasure_definer;
ALTER FUNCTION public.subscriber_pii_findings_erase(uuid, citext)
    OWNER TO postwave_pii_erasure_definer;
REVOKE CREATE ON SCHEMA public FROM postwave_pii_erasure_definer;

-- EXECUTE defaults to PUBLIC on a new function, which would hand this
-- capability to every role in the cluster.
REVOKE ALL ON FUNCTION public.subscriber_pii_findings_erase(uuid, citext)
    FROM PUBLIC, postwave_public;
GRANT EXECUTE ON FUNCTION public.subscriber_pii_findings_erase(uuid, citext)
    TO postwave_app;

COMMENT ON FUNCTION public.subscriber_pii_findings_erase(uuid, citext) IS
    'Erases one subject''s PII findings for GDPR deletion. Exists because '
    'postwave_app deliberately holds no DELETE on subscriber_pii_findings — a '
    'finding is evidence about the tenant, and pii_scanner asserts the app role '
    'cannot delete or truncate it. Erasure still has to remove the subject''s '
    'rows, so the delete lives behind this SECURITY DEFINER boundary instead of '
    'a grant. The tenant argument must equal app.tenant_id: without that check '
    'EXECUTE would be a cross-tenant delete capability rather than the '
    'RLS-confined one it replaces. Review receipts follow by ON DELETE CASCADE.';

COMMIT;
