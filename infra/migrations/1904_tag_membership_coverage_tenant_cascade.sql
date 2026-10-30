-- 1904_tag_membership_coverage_tenant_cascade.sql
--
-- A tenant with ANY tagged subscriber could not be deleted.
--
-- `tag_membership_join_changed_1774` runs on every subscriber_tags change and
-- upserts `tag_membership_coverage` for the affected tenant. subscriber_tags
-- cascades from tenants, so a tenant delete fires it once per tagged subscriber
-- — after the tenant row is gone — and the upsert violates
-- tag_membership_coverage_tenant_id_fkey, failing the entire DELETE.
--
-- Tagging is ubiquitous, so this blocked offboarding and GDPR erasure for a
-- large share of real tenants, with an error naming a coverage table nobody was
-- asking about.
--
-- THIRD INSTANCE OF ONE CLASS, after 1899 (tenant_pii_scan_config) and 1903
-- (audit_log). Each is a trigger that cannot distinguish "this row is being
-- rewritten" from "this row's owner is being erased", and each blocked the one
-- operation that must always be possible. The fix is the same in all three:
-- if the tenant is already gone, let the row go with it.

BEGIN;

-- The definer role must be able to ASK whether the tenant still exists. Read
-- only, on one table, which is the least it can be given for the check above.
GRANT SELECT ON public.tenants TO postwave_tag_event_definer;

CREATE OR REPLACE FUNCTION tag_membership_join_changed_1774()
RETURNS trigger
LANGUAGE plpgsql
-- PRESERVED FROM 1774. This function is owned by the non-login definer role
-- postwave_tag_event_definer precisely so it can write coverage rows the
-- application role cannot. Dropping SECURITY DEFINER makes every tag change
-- fail with "permission denied for table tag_membership_coverage".
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
    v_tenant_id uuid;
    v_subscriber_id uuid;
    v_tag_id uuid;
    v_action text;
    v_source text;
    v_actor_id uuid;
    v_actor_evidence text;
    v_metadata jsonb;
BEGIN
    -- THE TENANT-CASCADE CASE.
    --
    -- subscriber_tags cascades from tenants, so deleting a tenant fires this
    -- trigger for every tagged subscriber. It then upserts tag_membership_coverage
    -- for a tenant the cascade has already removed, violating
    -- tag_membership_coverage_tenant_id_fkey and failing the whole DELETE — so a
    -- tenant with ANY tagged subscriber could not be deleted at all.
    --
    -- Coverage describes a tenant's tag-membership history. With the tenant gone
    -- there is nothing left for it to describe, and the foreign key says so.
    --
    -- Third instance of one class, after 1899 (tenant_pii_scan_config) and 1903
    -- (audit_log): a trigger that cannot tell a cascade from a rewrite blocks
    -- the one operation that must always succeed. TG_OP is checked for DELETE
    -- only, so ordinary tag changes are untouched.
    -- NESTED, not `TG_OP = 'DELETE' AND NOT EXISTS (...)`. PostgreSQL does not
    -- guarantee short-circuit evaluation of AND, so the combined form ran the
    -- tenants lookup on every INSERT and UPDATE too — and this function is
    -- SECURITY DEFINER as postwave_tag_event_definer, which is granted only what
    -- it needs. Every ordinary tag change then failed with "permission denied
    -- for table tenants".
    IF TG_OP = 'DELETE' THEN
        IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = OLD.tenant_id) THEN
            RETURN OLD;
        END IF;
    END IF;
    IF TG_OP = 'INSERT' THEN
        v_tenant_id := NEW.tenant_id;
        v_subscriber_id := NEW.subscriber_id;
        v_tag_id := NEW.tag_id;
        v_action := 'tag_added';
        v_source := COALESCE(NULLIF(pg_catalog.btrim(NEW.source), ''),
                             'database_trigger');
        v_actor_id := NEW.applied_by;
        v_actor_evidence := CASE WHEN NEW.applied_by IS NULL
                                 THEN 'unavailable' ELSE 'writer_asserted' END;
        v_metadata := pg_catalog.jsonb_build_object(
            'contract_version', 'canonical-join-events-v2',
            'application_source', NEW.source,
            'applied_at', NEW.applied_at
        );
    ELSIF TG_OP = 'DELETE' THEN
        v_tenant_id := OLD.tenant_id;
        v_subscriber_id := OLD.subscriber_id;
        v_tag_id := OLD.tag_id;
        v_action := 'tag_removed';
        v_source := COALESCE(
            NULLIF(pg_catalog.left(pg_catalog.btrim(
                pg_catalog.current_setting(
                    'app.tag_membership_source', true
                )
            ), 64), ''),
            'database_trigger'
        );
        BEGIN
            v_actor_id := NULLIF(pg_catalog.current_setting(
                'app.actor_id', true
            ), '')::uuid;
        EXCEPTION WHEN invalid_text_representation THEN
            v_actor_id := NULL;
        END;
        v_actor_evidence := CASE WHEN v_actor_id IS NULL
                                 THEN 'unavailable' ELSE 'session_asserted' END;
        v_metadata := pg_catalog.jsonb_build_object(
            'contract_version', 'canonical-join-events-v2',
            'previous_application_source', OLD.source,
            'previous_applied_by', OLD.applied_by,
            'previous_applied_at', OLD.applied_at
        );
    ELSE
        IF ROW(NEW.tenant_id, NEW.subscriber_id, NEW.tag_id)
           IS NOT DISTINCT FROM ROW(OLD.tenant_id, OLD.subscriber_id, OLD.tag_id) THEN
            RETURN NEW;
        END IF;
        BEGIN
            v_actor_id := NULLIF(pg_catalog.current_setting(
                'app.actor_id', true
            ), '')::uuid;
        EXCEPTION WHEN invalid_text_representation THEN
            v_actor_id := NULL;
        END;
        INSERT INTO public.tag_membership_coverage (tenant_id)
        VALUES (OLD.tenant_id)
        ON CONFLICT (tenant_id) DO NOTHING;
        INSERT INTO public.tag_membership_events
               (tenant_id, tag_id, subscriber_id, action, source,
                actor_id, actor_evidence, metadata)
        VALUES (OLD.tenant_id, OLD.tag_id, OLD.subscriber_id, 'tag_removed',
                COALESCE(NULLIF(pg_catalog.left(pg_catalog.btrim(
                    pg_catalog.current_setting(
                        'app.tag_membership_source', true
                    )
                ), 64), ''), 'database_trigger'),
                v_actor_id,
                CASE WHEN v_actor_id IS NULL
                     THEN 'unavailable' ELSE 'session_asserted' END,
                pg_catalog.jsonb_build_object(
                    'contract_version', 'canonical-join-events-v2',
                    'reason', 'join_key_updated',
                    'previous_application_source', OLD.source,
                    'previous_applied_by', OLD.applied_by,
                    'previous_applied_at', OLD.applied_at
                ));
        v_tenant_id := NEW.tenant_id;
        v_subscriber_id := NEW.subscriber_id;
        v_tag_id := NEW.tag_id;
        v_action := 'tag_added';
        v_source := COALESCE(NULLIF(pg_catalog.btrim(NEW.source), ''),
                             'database_trigger');
        v_actor_id := NEW.applied_by;
        v_actor_evidence := CASE WHEN NEW.applied_by IS NULL
                                 THEN 'unavailable' ELSE 'writer_asserted' END;
        v_metadata := pg_catalog.jsonb_build_object(
            'contract_version', 'canonical-join-events-v2',
            'reason', 'join_key_updated',
            'application_source', NEW.source,
            'applied_at', NEW.applied_at
        );
    END IF;

    INSERT INTO public.tag_membership_coverage (tenant_id)
    VALUES (v_tenant_id)
    ON CONFLICT (tenant_id) DO NOTHING;
    INSERT INTO public.tag_membership_events
           (tenant_id, tag_id, subscriber_id, action, source,
            actor_id, actor_evidence, metadata)
    VALUES (v_tenant_id, v_tag_id, v_subscriber_id, v_action, v_source,
            v_actor_id, v_actor_evidence, v_metadata);
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END

$fn$;

COMMIT;
