-- F03 conversion-subject erasure/key-revocation lock-order fence.
--
-- Migration 2029 takes tenant fence 2029, updates conversion/touch rows, and
-- the application then updates the subscriber. Migration 2017's subscriber
-- trigger takes the shared 2017 key-lifecycle fence. Revocation takes the key
-- row plus the exclusive 2017 fence before updating those same conversion and
-- touch rows. Without an early shared 2017 fence, this can invert as:
--
--   erasure:   conversion row -> shared 2017
--   revocation: exclusive 2017 -> conversion row
--
-- Keep applied migration 2029 checksum-immutable. Rename its implementation
-- to a non-callable invoker helper and put the canonical capability behind a
-- least-privileged SECURITY DEFINER wrapper that establishes the complete
-- order before any identity row is read or written:
--
--   exclusive tenant erasure 2029 -> shared key lifecycle 2017 -> rows
--
-- migration-execution: transactional
-- rollback-strategy: no-op
-- rollback-details: Keep the wrapper applied during application rollback. It preserves the exact function signature and only adds transaction-scoped serialization.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER FUNCTION public.conversion_subject_identity_privacy_erase(
    uuid, citext, citext, uuid
) RENAME TO conversion_subject_identity_privacy_erase_unfenced_2029;

-- The implementation is reachable only from the wrapper. SECURITY INVOKER is
-- defense in depth: even an accidental future EXECUTE grant would run with the
-- caller's restricted table privileges rather than the eraser capability.
ALTER FUNCTION public.conversion_subject_identity_privacy_erase_unfenced_2029(
    uuid, citext, citext, uuid
) SECURITY INVOKER;
REVOKE ALL ON FUNCTION public.conversion_subject_identity_privacy_erase_unfenced_2029(
    uuid, citext, citext, uuid
) FROM PUBLIC, postwave_public, postwave_app;

CREATE FUNCTION public.conversion_subject_identity_privacy_erase(
    p_tenant_id uuid,
    p_subject_email citext,
    p_erased_email citext,
    p_request_id uuid
)
RETURNS TABLE (
    receipt_id uuid,
    conversions_redacted bigint,
    identity_touches_shredded bigint,
    campaign_links_severed bigint,
    click_bindings_deleted bigint
)
LANGUAGE plpgsql
VOLATILE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET TimeZone = 'UTC'
AS $function$
BEGIN
    -- Reject cross-tenant calls before letting a caller contend on another
    -- tenant's advisory locks. The inner 2029 implementation repeats this
    -- check before touching data.
    IF p_tenant_id::text IS DISTINCT FROM
       NULLIF(current_setting('app.tenant_id', true), '') THEN
        RAISE EXCEPTION 'conversion subject erasure tenant scope mismatch'
            USING ERRCODE = '42501';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(p_tenant_id::text, 2029)
    );
    PERFORM pg_catalog.pg_advisory_xact_lock_shared(
        pg_catalog.hashtextextended(p_tenant_id::text, 2017)
    );

    RETURN QUERY
    SELECT erased.receipt_id,
           erased.conversions_redacted,
           erased.identity_touches_shredded,
           erased.campaign_links_severed,
           erased.click_bindings_deleted
      FROM public.conversion_subject_identity_privacy_erase_unfenced_2029(
          p_tenant_id, p_subject_email, p_erased_email, p_request_id
      ) AS erased;
END
$function$;

ALTER FUNCTION public.conversion_subject_identity_privacy_erase(
    uuid, citext, citext, uuid
) OWNER TO postwave_conversion_identity_eraser;
REVOKE ALL ON FUNCTION public.conversion_subject_identity_privacy_erase(
    uuid, citext, citext, uuid
) FROM PUBLIC, postwave_public;
GRANT EXECUTE ON FUNCTION public.conversion_subject_identity_privacy_erase(
    uuid, citext, citext, uuid
) TO postwave_app;

COMMENT ON FUNCTION public.conversion_subject_identity_privacy_erase(
    uuid, citext, citext, uuid
) IS
    'Tenant-bound F03 identity erasure. Locks exclusive fence 2029 then shared '
    'key-lifecycle fence 2017 before the private 2029 implementation so '
    'revocation and subscriber mutation have one deadlock-free order.';

COMMENT ON FUNCTION public.conversion_subject_identity_privacy_erase_unfenced_2029(
    uuid, citext, citext, uuid
) IS
    'Private SECURITY INVOKER implementation retained from migration 2029. '
    'No application/public role may execute it; call the fenced canonical wrapper.';

DO $audit$
DECLARE
    eraser_oid oid;
    wrapper_definition text;
    erasure_fence_at integer;
    lifecycle_fence_at integer;
    implementation_at integer;
BEGIN
    SELECT oid INTO eraser_oid
      FROM pg_catalog.pg_roles
     WHERE rolname = 'postwave_conversion_identity_eraser';

    IF eraser_oid IS NULL OR NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_proc AS procedure
         WHERE procedure.oid =
               'public.conversion_subject_identity_privacy_erase(uuid,citext,citext,uuid)'::regprocedure
           AND procedure.proowner = eraser_oid
           AND procedure.prosecdef
           AND procedure.proconfig @>
               ARRAY['search_path=pg_catalog, public, pg_temp']::text[]
           AND procedure.proconfig @> ARRAY['TimeZone=UTC']::text[]
    ) OR NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_proc AS procedure
         WHERE procedure.oid =
               'public.conversion_subject_identity_privacy_erase_unfenced_2029(uuid,citext,citext,uuid)'::regprocedure
           AND procedure.proowner = eraser_oid
           AND NOT procedure.prosecdef
    ) THEN
        RAISE EXCEPTION 'conversion subject erasure wrapper/helper provenance is unsafe';
    END IF;

    IF NOT pg_catalog.has_function_privilege(
        'postwave_app',
        'public.conversion_subject_identity_privacy_erase(uuid,citext,citext,uuid)',
        'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
        'postwave_app',
        'public.conversion_subject_identity_privacy_erase_unfenced_2029(uuid,citext,citext,uuid)',
        'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
        'postwave_public',
        'public.conversion_subject_identity_privacy_erase(uuid,citext,citext,uuid)',
        'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
        'postwave_public',
        'public.conversion_subject_identity_privacy_erase_unfenced_2029(uuid,citext,citext,uuid)',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'conversion subject erasure wrapper/helper grants are unsafe';
    END IF;

    SELECT pg_catalog.pg_get_functiondef(
        'public.conversion_subject_identity_privacy_erase(uuid,citext,citext,uuid)'::regprocedure
    ) INTO wrapper_definition;
    erasure_fence_at := pg_catalog.strpos(
        wrapper_definition,
        'hashtextextended(p_tenant_id::text, 2029)'
    );
    lifecycle_fence_at := pg_catalog.strpos(
        wrapper_definition,
        'hashtextextended(p_tenant_id::text, 2017)'
    );
    implementation_at := pg_catalog.strpos(
        wrapper_definition,
        'conversion_subject_identity_privacy_erase_unfenced_2029('
    );
    IF erasure_fence_at = 0 OR lifecycle_fence_at <= erasure_fence_at OR
       implementation_at <= lifecycle_fence_at THEN
        RAISE EXCEPTION 'conversion subject erasure lock order is unsafe';
    END IF;
END
$audit$;

COMMIT;
