-- 1769_subscriber_merge_evidence_lineage.sql
--
-- Subscriber merge must not UPDATE append-only consent evidence merely to
-- change its subject UUID, and must not hard-delete the duplicate while an
-- immutable import receipt still references it with ON DELETE CASCADE. Keep a
-- non-sendable, PII-minimised duplicate tombstone and record a durable lineage
-- edge instead. Evidence retains its exact original subject/address/chronology;
-- auditors resolve that historical subject through this table.
--
-- The application may create the lineage edge only through one fixed-SQL,
-- tenant-bound SECURITY DEFINER function. It receives no arbitrary table or
-- predicate input, validates both subscriber rows under deterministic locks,
-- and grants no direct write privilege on the lineage table.
--
-- rollback-strategy: no-op
-- rollback-details: merge lineage is compliance evidence and merged tombstones
-- must remain distinguishable. Older code safely ignores the additive columns.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

ALTER TABLE public.subscribers
    ADD COLUMN IF NOT EXISTS merged_into_subscriber_id uuid,
    ADD COLUMN IF NOT EXISTS merged_at timestamptz;

ALTER TABLE public.subscribers
    DROP CONSTRAINT IF EXISTS subscribers_merged_shape_check;
ALTER TABLE public.subscribers
    ADD CONSTRAINT subscribers_merged_shape_check CHECK (
        (merged_into_subscriber_id IS NULL AND merged_at IS NULL) OR
        (merged_into_subscriber_id IS NOT NULL AND merged_at IS NOT NULL AND
         merged_into_subscriber_id <> id AND archived_at IS NOT NULL AND
         status = 'blocklisted')
    ) NOT VALID;

CREATE INDEX IF NOT EXISTS subscribers_merged_into_idx
    ON public.subscribers (tenant_id, merged_into_subscriber_id, merged_at DESC)
    WHERE merged_into_subscriber_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.subscriber_merge_lineage (
    tenant_id              uuid        NOT NULL,
    duplicate_subscriber_id uuid       NOT NULL,
    primary_subscriber_id   uuid       NOT NULL,
    duplicate_profile_id    uuid       NOT NULL,
    linked_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, duplicate_subscriber_id),
    UNIQUE (tenant_id, duplicate_profile_id),
    CHECK (duplicate_subscriber_id <> primary_subscriber_id),
    CONSTRAINT subscriber_merge_lineage_tenant_fkey
        FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE
);

COMMENT ON TABLE public.subscriber_merge_lineage IS
    'Immutable subject-lineage edge for resolving consent/import evidence retained on a PII-minimised merged duplicate tombstone.';
COMMENT ON COLUMN public.subscribers.merged_into_subscriber_id IS
    'Surviving profile for a non-sendable merged tombstone. NULL on ordinary subscriber rows.';

ALTER TABLE public.subscriber_merge_lineage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriber_merge_lineage FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS subscriber_merge_lineage_tenant_isolation
    ON public.subscriber_merge_lineage;
CREATE POLICY subscriber_merge_lineage_tenant_isolation
    ON public.subscriber_merge_lineage
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS subscriber_merge_lineage_tenant_visible
    ON public.subscriber_merge_lineage;
CREATE POLICY subscriber_merge_lineage_tenant_visible
    ON public.subscriber_merge_lineage
    AS PERMISSIVE FOR SELECT TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON TABLE public.subscriber_merge_lineage FROM PUBLIC, postwave_app;
GRANT SELECT ON TABLE public.subscriber_merge_lineage TO postwave_app;

CREATE OR REPLACE FUNCTION public.subscriber_merge_reparent_evidence(
    p_tenant_id uuid,
    p_primary_subscriber_id uuid,
    p_duplicate_subscriber_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    scoped_tenant uuid;
    locked_count integer;
    duplicate_target uuid;
    duplicate_profile uuid;
    existing_target uuid;
BEGIN
    scoped_tenant := NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid;
    IF scoped_tenant IS NULL OR scoped_tenant <> p_tenant_id THEN
        RAISE EXCEPTION 'subscriber merge tenant scope mismatch'
            USING ERRCODE = '42501';
    END IF;
    IF p_primary_subscriber_id IS NULL OR p_duplicate_subscriber_id IS NULL OR
       p_primary_subscriber_id = p_duplicate_subscriber_id THEN
        RAISE EXCEPTION 'subscriber merge requires two distinct identities'
            USING ERRCODE = '22023';
    END IF;

    -- UUID ordering matches the application lock order and prevents a second
    -- caller from constructing an opposite-order deadlock.
    PERFORM id
      FROM public.subscribers
     WHERE tenant_id = p_tenant_id
       AND id IN (p_primary_subscriber_id, p_duplicate_subscriber_id)
     ORDER BY id
     FOR UPDATE;
    GET DIAGNOSTICS locked_count = ROW_COUNT;
    IF locked_count <> 2 THEN
        RAISE EXCEPTION 'subscriber merge identities are not tenant-visible'
            USING ERRCODE = 'P0002';
    END IF;

    SELECT merged_into_subscriber_id, profile_id
      INTO duplicate_target, duplicate_profile
      FROM public.subscribers
     WHERE tenant_id = p_tenant_id AND id = p_duplicate_subscriber_id;
    IF duplicate_target IS NOT NULL AND duplicate_target <> p_primary_subscriber_id THEN
        RAISE EXCEPTION 'subscriber duplicate already belongs to another lineage'
            USING ERRCODE = '23505';
    END IF;

    -- Recheck irreversible erasure under the definer's complete tenant view.
    -- subscriber_emails intentionally has restrictive consent RLS, so the
    -- application-side friendly 409 preflight cannot be the sole safety gate.
    IF EXISTS (
        SELECT 1
          FROM public.subscriber_emails se
          JOIN public.email_suppressions es
            ON es.tenant_id=se.tenant_id AND lower(es.email::text)=lower(se.email::text)
         WHERE se.tenant_id=p_tenant_id
           AND se.subscriber_id IN (p_primary_subscriber_id,p_duplicate_subscriber_id)
           AND (lower(COALESCE(es.reason,'')) IN ('dsar_deletion','gdpr_erasure')
                OR COALESCE((es.metadata->>'gdpr_erasure')::boolean,false))
        UNION ALL
        SELECT 1
          FROM public.subscriber_emails se
          JOIN public.subscriber_suppressions ss
            ON ss.tenant_id=se.tenant_id AND lower(ss.email::text)=lower(se.email::text)
         WHERE se.tenant_id=p_tenant_id
           AND se.subscriber_id IN (p_primary_subscriber_id,p_duplicate_subscriber_id)
           AND (ss.reason='dsar_deletion'
                OR COALESCE((ss.metadata->>'gdpr_erasure')::boolean,false))
    ) THEN
        RAISE EXCEPTION 'subscriber merge is blocked by irreversible erasure evidence'
            USING ERRCODE = 'PWE01';
    END IF;

    SELECT primary_subscriber_id
      INTO existing_target
      FROM public.subscriber_merge_lineage
     WHERE tenant_id = p_tenant_id
       AND duplicate_subscriber_id = p_duplicate_subscriber_id;
    IF existing_target IS NOT NULL AND existing_target <> p_primary_subscriber_id THEN
        RAISE EXCEPTION 'subscriber duplicate already belongs to another lineage'
            USING ERRCODE = '23505';
    END IF;

    INSERT INTO public.subscriber_merge_lineage
        (tenant_id, duplicate_subscriber_id, primary_subscriber_id, duplicate_profile_id)
    VALUES
        (p_tenant_id, p_duplicate_subscriber_id, p_primary_subscriber_id, duplicate_profile)
    ON CONFLICT (tenant_id, duplicate_subscriber_id) DO NOTHING;

    -- The same subscriber may be a master identity referenced from child
    -- workspaces whose rows are intentionally invisible under the parent's
    -- tenant RLS. Preserve those links under the survivor inside this
    -- tenant-authenticated definer boundary. Exact child/master collisions
    -- collapse to the already-existing survivor link.
    DELETE FROM public.federated_subscriber_map d
     USING public.federated_subscriber_map p
     WHERE d.parent_tenant_id=p_tenant_id
       AND d.master_subscriber_id=p_duplicate_subscriber_id
       AND p.tenant_id=d.tenant_id
       AND p.child_subscriber_id=d.child_subscriber_id
       AND p.master_subscriber_id=p_primary_subscriber_id;

    UPDATE public.federated_subscriber_map
       SET master_subscriber_id=p_primary_subscriber_id,
           updated_at=clock_timestamp()
     WHERE parent_tenant_id=p_tenant_id
       AND master_subscriber_id=p_duplicate_subscriber_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.subscriber_merge_reparent_evidence(uuid,uuid,uuid)
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.subscriber_merge_reparent_evidence(uuid,uuid,uuid)
    TO postwave_app;

COMMIT;
