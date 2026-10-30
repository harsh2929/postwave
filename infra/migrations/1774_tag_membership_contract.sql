-- 1774_tag_membership_contract.sql
--
-- Establish one tenant-safe tag contract without rewriting the historical
-- migrations that introduced the registry, groups, compatibility array, join
-- table, or best-effort history.
-- migration-execution: phased
-- rollback-strategy: no-op - retaining tenant-safe canonical memberships and
-- bounded, honestly-labelled event coverage is compatible with older readers.
--
-- subscriber_tags is canonical after this migration. subscribers.tags remains
-- a bounded compatibility projection for older binaries and integrations:
-- either side may still be written, but triggers reconcile the other side in
-- the same transaction. A physically separate membership-event ledger starts
-- at this migration's coverage boundary; legacy tag_history rows are not
-- relabelled as complete evidence.

-- Existing tables need redundant tenant/reference targets before composite
-- foreign keys can be installed. Build them without holding table writes.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS tags_tenant_id_id_uniq
    ON public.tags (tenant_id, id);
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS tag_groups_tenant_id_id_uniq
    ON public.tag_groups (tenant_id, id);

BEGIN;

SET LOCAL lock_timeout = '5s';

-- Only a fixed-SQL trigger helper may append to the exact event ledger. The
-- ordinary application role can read its tenant's rows but cannot forge,
-- rewrite, or erase transitions. The dedicated owner has no login, schema
-- creation, memberships, or unrelated object privileges.
DO $role$
DECLARE
    definer pg_catalog.pg_roles%ROWTYPE;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles
         WHERE rolname = 'postwave_tag_event_definer'
    ) THEN
        CREATE ROLE postwave_tag_event_definer
            NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
            NOREPLICATION BYPASSRLS;
    END IF;
    SELECT * INTO definer FROM pg_catalog.pg_roles
     WHERE rolname = 'postwave_tag_event_definer';
    IF definer.rolcanlogin OR definer.rolsuper OR definer.rolcreatedb OR
       definer.rolcreaterole OR definer.rolinherit OR
       definer.rolreplication OR NOT definer.rolbypassrls THEN
        RAISE EXCEPTION 'postwave_tag_event_definer has unsafe role attributes';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_auth_members
         WHERE member = definer.oid OR roleid = definer.oid
    ) THEN
        RAISE EXCEPTION 'postwave_tag_event_definer must have no memberships';
    END IF;
    IF pg_catalog.has_schema_privilege(
        'postwave_tag_event_definer', 'public', 'CREATE'
    ) THEN
        RAISE EXCEPTION 'postwave_tag_event_definer unexpectedly has CREATE on public';
    END IF;
END
$role$;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
    FROM postwave_tag_event_definer;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public
    FROM postwave_tag_event_definer;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public
    FROM postwave_tag_event_definer;
REVOKE ALL PRIVILEGES ON SCHEMA public
    FROM postwave_tag_event_definer;

-- Complete the registry/group row contract used by the API. Existing legacy
-- values are retained; NOT VALID checks constrain new or subsequently changed
-- rows without destroying historical customer data during deployment.
ALTER TABLE public.tags
    ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 1;

UPDATE public.tags
   SET updated_at = COALESCE(updated_at, created_at, now())
 WHERE updated_at IS NULL;

ALTER TABLE public.tags
    ALTER COLUMN updated_at SET DEFAULT now(),
    ALTER COLUMN updated_at SET NOT NULL;

ALTER TABLE public.tags
    DROP CONSTRAINT IF EXISTS tags_version_contract_1774,
    ADD CONSTRAINT tags_version_contract_1774 CHECK (version > 0);

-- Do not truncate or silently hide customer metadata. Bounded legacy rows
-- remain readable under the wider response schema; anything outside that
-- envelope blocks rollout for explicit tenant/operator remediation.
DO $legacy_read_envelope$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.tags
         WHERE char_length(btrim(name::text)) NOT BETWEEN 1 AND 100
            OR char_length(description) > 4096
            OR (color IS NOT NULL AND char_length(color) > 32)
    ) THEN
        RAISE EXCEPTION
            '1774 found tag metadata outside the bounded legacy read envelope (name 1..100, description <=4096, color <=32); remediate without truncation and retry'
            USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.tag_groups
         WHERE char_length(btrim(name)) NOT BETWEEN 1 AND 100
            OR (color IS NOT NULL AND char_length(color) > 32)
    ) THEN
        RAISE EXCEPTION
            '1774 found tag-group metadata outside the bounded legacy read envelope (name 1..100, color <=32); remediate without truncation and retry'
            USING ERRCODE = '23514';
    END IF;
END
$legacy_read_envelope$;

-- Do not silently rewrite an impossible cross-tenant group reference. Block
-- rollout for explicit tenant/operator remediation, then install the composite
-- guard below once every retained reference is truthful.
DO $tenant_group_preflight$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM public.tags AS t
         WHERE t.group_id IS NOT NULL
           AND NOT EXISTS (
               SELECT 1
                 FROM public.tag_groups AS g
                WHERE g.tenant_id = t.tenant_id
                  AND g.id = t.group_id
           )
    ) THEN
        RAISE EXCEPTION
            '1774 found a cross-tenant tag group reference; remediate explicitly without silent rewriting and retry'
            USING ERRCODE = '23514';
    END IF;
END
$tenant_group_preflight$;

ALTER TABLE public.tags
    DROP CONSTRAINT IF EXISTS tags_tenant_group_fk_1774,
    ADD CONSTRAINT tags_tenant_group_fk_1774
        FOREIGN KEY (tenant_id, group_id)
        REFERENCES public.tag_groups (tenant_id, id)
        -- The pre-existing single-column FK owns the group_id SET NULL
        -- behavior. This composite guard must not try to null tenant_id.
        ON DELETE NO ACTION
        NOT VALID;
ALTER TABLE public.tags VALIDATE CONSTRAINT tags_tenant_group_fk_1774;

-- Cross-tenant join rows could previously satisfy the single-column FKs.
-- Never delete customer membership evidence during schema deployment. Fail
-- closed with an explicit remediation requirement before installing the
-- composite constraints.
DO $tenant_membership_preflight$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM public.subscriber_tags AS st
         WHERE NOT EXISTS (
                   SELECT 1
                     FROM public.subscribers AS s
                    WHERE s.tenant_id = st.tenant_id
                      AND s.id = st.subscriber_id
               )
            OR NOT EXISTS (
                   SELECT 1
                     FROM public.tags AS t
                    WHERE t.tenant_id = st.tenant_id
                      AND t.id = st.tag_id
               )
    ) THEN
        RAISE EXCEPTION
            '1774 found cross-tenant or orphan subscriber_tags evidence; remediate explicitly without silent deletion and retry'
            USING ERRCODE = '23514';
    END IF;
END
$tenant_membership_preflight$;

ALTER TABLE public.subscriber_tags
    DROP CONSTRAINT IF EXISTS subscriber_tags_tenant_subscriber_fk_1774,
    ADD CONSTRAINT subscriber_tags_tenant_subscriber_fk_1774
        FOREIGN KEY (tenant_id, subscriber_id)
        REFERENCES public.subscribers (tenant_id, id)
        ON DELETE CASCADE
        NOT VALID,
    DROP CONSTRAINT IF EXISTS subscriber_tags_tenant_tag_fk_1774,
    ADD CONSTRAINT subscriber_tags_tenant_tag_fk_1774
        FOREIGN KEY (tenant_id, tag_id)
        REFERENCES public.tags (tenant_id, id)
        ON DELETE CASCADE
        NOT VALID;
ALTER TABLE public.subscriber_tags
    VALIDATE CONSTRAINT subscriber_tags_tenant_subscriber_fk_1774;
ALTER TABLE public.subscriber_tags
    VALIDATE CONSTRAINT subscriber_tags_tenant_tag_fk_1774;

-- Preserve the union of valid historical memberships. Legacy-only labels are
-- registered and inserted into the canonical join; join-only applications are
-- retained and projected back to the compatibility array below.
INSERT INTO public.tags (tenant_id, name)
SELECT DISTINCT s.tenant_id, btrim(label)::citext
  FROM public.subscribers AS s
 CROSS JOIN LATERAL unnest(COALESCE(s.tags, '{}'::text[])) AS label
 WHERE btrim(label) <> ''
ON CONFLICT (tenant_id, name) DO NOTHING;

INSERT INTO public.subscriber_tags
       (tenant_id, subscriber_id, tag_id, source, applied_at)
SELECT s.tenant_id, s.id, t.id, '1774_legacy_reconcile',
       COALESCE(s.created_at, now())
  FROM public.subscribers AS s
 CROSS JOIN LATERAL unnest(COALESCE(s.tags, '{}'::text[])) AS label
  JOIN public.tags AS t
    ON t.tenant_id = s.tenant_id
   AND t.name = btrim(label)::citext
 WHERE btrim(label) <> ''
ON CONFLICT (tenant_id, subscriber_id, tag_id) DO NOTHING;

-- Strict new/touched-row write contract. NOT VALID deliberately allows the
-- bounded legacy read envelope above (100/4096/arbitrary <=32 color) without
-- rewriting it, while every post-1774 INSERT/UPDATE must use the shared
-- 64/1024/palette-or-hex contract.
ALTER TABLE public.tags
    DROP CONSTRAINT IF EXISTS tags_name_contract_1774,
    ADD CONSTRAINT tags_name_contract_1774 CHECK (
        name::text = btrim(name::text) AND
        char_length(name::text) BETWEEN 1 AND 64
    ) NOT VALID,
    DROP CONSTRAINT IF EXISTS tags_color_contract_1774,
    ADD CONSTRAINT tags_color_contract_1774 CHECK (
        color IS NULL OR lower(color) IN (
            'slate', 'teal', 'sky', 'indigo',
            'violet', 'rose', 'amber', 'lime'
        ) OR color ~ '^#[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?$'
    ) NOT VALID,
    DROP CONSTRAINT IF EXISTS tags_description_contract_1774,
    ADD CONSTRAINT tags_description_contract_1774
        CHECK (char_length(description) <= 1024) NOT VALID;

ALTER TABLE public.tag_groups
    DROP CONSTRAINT IF EXISTS tag_groups_name_contract_1774,
    ADD CONSTRAINT tag_groups_name_contract_1774 CHECK (
        name = btrim(name) AND char_length(name) BETWEEN 1 AND 64
    ) NOT VALID,
    DROP CONSTRAINT IF EXISTS tag_groups_color_contract_1774,
    ADD CONSTRAINT tag_groups_color_contract_1774 CHECK (
        color IS NULL OR lower(color) IN (
            'slate', 'teal', 'sky', 'indigo',
            'violet', 'rose', 'amber', 'lime'
        ) OR color ~ '^#[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?$'
    ) NOT VALID,
    DROP CONSTRAINT IF EXISTS tag_groups_sort_contract_1774,
    ADD CONSTRAINT tag_groups_sort_contract_1774
        CHECK (sort_order BETWEEN 0 AND 1000000) NOT VALID;

-- The compatibility array has an established 50-item/4096-byte budget. Do not
-- silently truncate canonical memberships: fail the migration with a precise
-- operator action if pre-existing join-only data cannot be represented.
DO $contract$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM public.subscriber_tags AS st
          JOIN public.tags AS t
            ON t.tenant_id = st.tenant_id
           AND t.id = st.tag_id
         GROUP BY st.tenant_id, st.subscriber_id
        HAVING count(*) > 50
            OR max(char_length(t.name::text)) > 100
            OR sum(octet_length(t.name::text)) > 4096
    ) THEN
        RAISE EXCEPTION
            '1774 cannot represent an existing canonical membership set in subscribers.tags; review the >50 item, >100 character, or >4096 byte tenant/subscriber set'
            USING ERRCODE = '23514';
    END IF;
END
$contract$;

WITH canonical AS (
    SELECT st.tenant_id,
           st.subscriber_id,
           array_agg(t.name::text ORDER BY lower(t.name::text), t.id)::text[] AS tags
      FROM public.subscriber_tags AS st
      JOIN public.tags AS t
        ON t.tenant_id = st.tenant_id
       AND t.id = st.tag_id
     GROUP BY st.tenant_id, st.subscriber_id
)
UPDATE public.subscribers AS s
   SET tags = c.tags
  FROM canonical AS c
 WHERE s.tenant_id = c.tenant_id
   AND s.id = c.subscriber_id
   AND s.tags IS DISTINCT FROM c.tags;

-- Rows with no canonical memberships must expose an empty compatibility
-- projection rather than stale literal labels.
UPDATE public.subscribers AS s
   SET tags = '{}'::text[]
 WHERE cardinality(COALESCE(s.tags, '{}'::text[])) > 0
   AND NOT EXISTS (
       SELECT 1
         FROM public.subscriber_tags AS st
        WHERE st.tenant_id = s.tenant_id
          AND st.subscriber_id = s.id
   );

CREATE TABLE public.tag_membership_coverage (
    tenant_id            uuid PRIMARY KEY
                         REFERENCES tenants(id) ON DELETE CASCADE,
    contract_version     text NOT NULL DEFAULT 'canonical-join-events-v2'
                         CHECK (contract_version = 'canonical-join-events-v2'),
    coverage_started_at  timestamptz NOT NULL DEFAULT statement_timestamp(),
    created_at           timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.tag_membership_coverage (tenant_id)
SELECT id FROM public.tenants
ON CONFLICT (tenant_id) DO NOTHING;

CREATE TABLE public.tag_membership_events (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    tag_id         uuid NOT NULL,
    subscriber_id  uuid NOT NULL,
    action         text NOT NULL CHECK (action IN ('tag_added', 'tag_removed')),
    source         text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 64),
    actor_id       uuid,
    actor_evidence text NOT NULL CHECK (actor_evidence IN (
                       'writer_asserted', 'session_asserted', 'unavailable'
                   )),
    occurred_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
    metadata       jsonb NOT NULL DEFAULT '{}'::jsonb
                   CHECK (jsonb_typeof(metadata) = 'object')
);

COMMENT ON TABLE public.tag_membership_events IS
    'Exact subscriber_tags row transitions from the 1774 coverage boundary; legacy tag_history is not backfilled or relabelled.';

CREATE INDEX tag_membership_events_tag_time_idx
    ON public.tag_membership_events
       (tenant_id, tag_id, occurred_at DESC, id);
CREATE INDEX tag_membership_events_subscriber_time_idx
    ON public.tag_membership_events
       (tenant_id, subscriber_id, occurred_at DESC, id);

REVOKE ALL ON public.tag_membership_coverage FROM PUBLIC, postwave_app;
REVOKE ALL ON public.tag_membership_events FROM PUBLIC, postwave_app;
GRANT SELECT ON public.tag_membership_coverage TO postwave_app;
GRANT SELECT ON public.tag_membership_events TO postwave_app;

ALTER TABLE public.tag_membership_coverage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tag_membership_coverage FORCE ROW LEVEL SECURITY;
CREATE POLICY tag_membership_coverage_tenant_isolation
    ON public.tag_membership_coverage
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tag_membership_coverage_tenant_visible
    ON public.tag_membership_coverage
    AS PERMISSIVE FOR SELECT TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE public.tag_membership_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tag_membership_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tag_membership_events_tenant_isolation
    ON public.tag_membership_events
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tag_membership_events_tenant_visible
    ON public.tag_membership_events
    AS PERMISSIVE FOR SELECT TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Monotonic semantic versions back strong ETags. Callers cannot forge a lower
-- version or timestamp through a direct UPDATE.
CREATE FUNCTION public.tags_assign_version_1774()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.version := 1;
        NEW.updated_at := COALESCE(NEW.updated_at, NEW.created_at, clock_timestamp());
        RETURN NEW;
    END IF;

    IF ROW(NEW.name, NEW.color, NEW.description, NEW.group_id, NEW.pii,
           NEW.archived_at, NEW.updated_by)
       IS DISTINCT FROM
       ROW(OLD.name, OLD.color, OLD.description, OLD.group_id, OLD.pii,
           OLD.archived_at, OLD.updated_by) THEN
        NEW.version := OLD.version + 1;
        NEW.updated_at := clock_timestamp();
    ELSE
        NEW.version := OLD.version;
        NEW.updated_at := OLD.updated_at;
    END IF;
    RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS tags_assign_version_1774 ON public.tags;
CREATE TRIGGER tags_assign_version_1774
BEFORE INSERT OR UPDATE ON public.tags
FOR EACH ROW EXECUTE FUNCTION public.tags_assign_version_1774();

-- Rebuild one compatibility array from canonical joins. The invoker remains
-- subject to the subscribers RLS policy; UUID parameters cannot select a row
-- outside the session tenant. Composite FKs guarantee both ids belong there.
CREATE FUNCTION public.tag_membership_rebuild_array_1774(
    p_tenant_id uuid,
    p_subscriber_id uuid
)
RETURNS void
LANGUAGE sql
SET search_path = pg_catalog, public
AS $function$
    UPDATE public.subscribers AS s
       SET tags = COALESCE((
           SELECT array_agg(t.name::text ORDER BY lower(t.name::text), t.id)::text[]
             FROM public.subscriber_tags AS st
             JOIN public.tags AS t
               ON t.tenant_id = st.tenant_id
              AND t.id = st.tag_id
            WHERE st.tenant_id = p_tenant_id
              AND st.subscriber_id = p_subscriber_id
       ), '{}'::text[])
     WHERE s.tenant_id = p_tenant_id
       AND s.id = p_subscriber_id
       AND s.tags IS DISTINCT FROM COALESCE((
           SELECT array_agg(t.name::text ORDER BY lower(t.name::text), t.id)::text[]
             FROM public.subscriber_tags AS st
             JOIN public.tags AS t
               ON t.tenant_id = st.tenant_id
              AND t.id = st.tag_id
            WHERE st.tenant_id = p_tenant_id
              AND st.subscriber_id = p_subscriber_id
       ), '{}'::text[]);
$function$;

REVOKE ALL ON FUNCTION public.tag_membership_rebuild_array_1774(uuid, uuid)
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tag_membership_rebuild_array_1774(uuid, uuid)
    TO postwave_app;

-- Check the compatibility projection before every canonical transition. The
-- existing subscribers BEFORE trigger independently checks legacy-array
-- inputs; this guard closes the inverse join-only write path before an AFTER
-- trigger attempts to rebuild the array. Any overflow aborts the membership
-- statement and its event with SQLSTATE 23514—never truncates silently.
CREATE FUNCTION public.tag_membership_enforce_budget_1774()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
    v_count bigint;
    v_max_chars integer;
    v_total_bytes bigint;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT count(*),
               COALESCE(max(pg_catalog.char_length(projected.name)), 0),
               COALESCE(sum(pg_catalog.octet_length(projected.name)), 0)
          INTO v_count, v_max_chars, v_total_bytes
          FROM (
                SELECT tag.name::text AS name
                  FROM public.subscriber_tags AS membership
                  JOIN public.tags AS tag
                    ON tag.tenant_id = membership.tenant_id
                   AND tag.id = membership.tag_id
                 WHERE membership.tenant_id = NEW.tenant_id
                   AND membership.subscriber_id = NEW.subscriber_id
                UNION ALL
                SELECT tag.name::text
                  FROM public.tags AS tag
                 WHERE tag.tenant_id = NEW.tenant_id
                   AND tag.id = NEW.tag_id
                   AND NOT EXISTS (
                       SELECT 1 FROM public.subscriber_tags AS existing
                        WHERE existing.tenant_id = NEW.tenant_id
                          AND existing.subscriber_id = NEW.subscriber_id
                          AND existing.tag_id = NEW.tag_id
                   )
          ) AS projected;
    ELSE
        SELECT count(*),
               COALESCE(max(pg_catalog.char_length(projected.name)), 0),
               COALESCE(sum(pg_catalog.octet_length(projected.name)), 0)
          INTO v_count, v_max_chars, v_total_bytes
          FROM (
                SELECT tag.name::text AS name
                  FROM public.subscriber_tags AS membership
                  JOIN public.tags AS tag
                    ON tag.tenant_id = membership.tenant_id
                   AND tag.id = membership.tag_id
                 WHERE membership.tenant_id = NEW.tenant_id
                   AND membership.subscriber_id = NEW.subscriber_id
                   AND ROW(membership.tenant_id, membership.subscriber_id,
                           membership.tag_id)
                       IS DISTINCT FROM ROW(OLD.tenant_id, OLD.subscriber_id,
                                            OLD.tag_id)
                UNION ALL
                SELECT tag.name::text
                  FROM public.tags AS tag
                 WHERE tag.tenant_id = NEW.tenant_id
                   AND tag.id = NEW.tag_id
          ) AS projected;
    END IF;

    IF v_count > 50 OR v_max_chars > 100 OR v_total_bytes > 4096 THEN
        RAISE EXCEPTION
            'tag membership exceeds subscribers.tags compatibility budget (50 items, 100 characters/item, 4096 bytes)'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'tag_membership_compatibility_budget_1774';
    END IF;
    RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.tag_membership_enforce_budget_1774()
    FROM PUBLIC;

DROP TRIGGER IF EXISTS subscriber_tags_budget_1774
    ON public.subscriber_tags;
CREATE TRIGGER subscriber_tags_budget_1774
BEFORE INSERT OR UPDATE OF tenant_id, subscriber_id, tag_id
ON public.subscriber_tags
FOR EACH ROW EXECUTE FUNCTION public.tag_membership_enforce_budget_1774();

-- Every actual canonical join transition produces one exact event through a
-- non-login definer. Membership-row provenance is retained. Removal actors
-- are nullable and explicitly labelled because a database trigger cannot
-- infer human identity; an API transaction may supply app.actor_id/source as
-- writer assertions, never as cryptographic authentication evidence.
CREATE FUNCTION public.tag_membership_join_changed_1774()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
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
$function$;

CREATE FUNCTION public.tag_membership_tenant_coverage_start_1774()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
    INSERT INTO public.tag_membership_coverage
           (tenant_id, coverage_started_at)
    VALUES (NEW.id, NEW.created_at)
    ON CONFLICT (tenant_id) DO NOTHING;
    RETURN NEW;
END
$function$;

GRANT USAGE, CREATE ON SCHEMA public TO postwave_tag_event_definer;
GRANT SELECT, INSERT ON public.tag_membership_coverage
    TO postwave_tag_event_definer;
GRANT INSERT ON public.tag_membership_events
    TO postwave_tag_event_definer;
ALTER FUNCTION public.tag_membership_join_changed_1774()
    OWNER TO postwave_tag_event_definer;
ALTER FUNCTION public.tag_membership_tenant_coverage_start_1774()
    OWNER TO postwave_tag_event_definer;
REVOKE CREATE ON SCHEMA public FROM postwave_tag_event_definer;
REVOKE ALL ON FUNCTION public.tag_membership_join_changed_1774()
    FROM PUBLIC, postwave_app;
REVOKE ALL ON FUNCTION public.tag_membership_tenant_coverage_start_1774()
    FROM PUBLIC, postwave_app;

DROP TRIGGER IF EXISTS tenants_tag_membership_coverage_1774
    ON public.tenants;
CREATE TRIGGER tenants_tag_membership_coverage_1774
AFTER INSERT ON public.tenants
FOR EACH ROW
EXECUTE FUNCTION public.tag_membership_tenant_coverage_start_1774();

DROP TRIGGER IF EXISTS subscriber_tags_membership_insert_1774
    ON public.subscriber_tags;
CREATE TRIGGER subscriber_tags_membership_insert_1774
AFTER INSERT ON public.subscriber_tags
FOR EACH ROW EXECUTE FUNCTION public.tag_membership_join_changed_1774();

DROP TRIGGER IF EXISTS subscriber_tags_membership_delete_1774
    ON public.subscriber_tags;
CREATE TRIGGER subscriber_tags_membership_delete_1774
AFTER DELETE ON public.subscriber_tags
FOR EACH ROW EXECUTE FUNCTION public.tag_membership_join_changed_1774();

DROP TRIGGER IF EXISTS subscriber_tags_membership_update_1774
    ON public.subscriber_tags;
CREATE TRIGGER subscriber_tags_membership_update_1774
AFTER UPDATE OF tenant_id, subscriber_id, tag_id ON public.subscriber_tags
FOR EACH ROW EXECUTE FUNCTION public.tag_membership_join_changed_1774();

-- Projection maintenance remains security-invoker and therefore tenant-RLS
-- bound. Keeping it separate from the private event writer avoids giving the
-- definer any subscriber-table privilege.
CREATE FUNCTION public.tag_membership_join_project_1774()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
    IF pg_catalog.pg_trigger_depth() > 1 THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND
       ROW(NEW.tenant_id, NEW.subscriber_id)
       IS DISTINCT FROM ROW(OLD.tenant_id, OLD.subscriber_id) THEN
        PERFORM public.tag_membership_rebuild_array_1774(
            OLD.tenant_id, OLD.subscriber_id);
    END IF;
    IF TG_OP = 'DELETE' THEN
        PERFORM public.tag_membership_rebuild_array_1774(
            OLD.tenant_id, OLD.subscriber_id);
        RETURN OLD;
    END IF;
    PERFORM public.tag_membership_rebuild_array_1774(
        NEW.tenant_id, NEW.subscriber_id);
    RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.tag_membership_join_project_1774()
    FROM PUBLIC;

DROP TRIGGER IF EXISTS subscriber_tags_projection_insert_1774
    ON public.subscriber_tags;
CREATE TRIGGER subscriber_tags_projection_insert_1774
AFTER INSERT ON public.subscriber_tags
FOR EACH ROW EXECUTE FUNCTION public.tag_membership_join_project_1774();
DROP TRIGGER IF EXISTS subscriber_tags_projection_delete_1774
    ON public.subscriber_tags;
CREATE TRIGGER subscriber_tags_projection_delete_1774
AFTER DELETE ON public.subscriber_tags
FOR EACH ROW EXECUTE FUNCTION public.tag_membership_join_project_1774();
DROP TRIGGER IF EXISTS subscriber_tags_projection_update_1774
    ON public.subscriber_tags;
CREATE TRIGGER subscriber_tags_projection_update_1774
AFTER UPDATE OF tenant_id, subscriber_id, tag_id ON public.subscriber_tags
FOR EACH ROW EXECUTE FUNCTION public.tag_membership_join_project_1774();

-- Legacy full-array writers remain supported. The function resolves/registers
-- every bounded label, makes the canonical join exactly match the supplied
-- array, then rewrites the array from canonical registry spellings.
CREATE FUNCTION public.subscriber_tags_array_reconcile_1774()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
    IF pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;

    INSERT INTO public.tags (tenant_id, name)
    SELECT DISTINCT NEW.tenant_id, btrim(label)::citext
      FROM unnest(COALESCE(NEW.tags, '{}'::text[])) AS label
     WHERE btrim(label) <> ''
       -- A bounded legacy label may be wider than the strict post-1774
       -- creation contract. Do not speculative-insert an already-registered
       -- legacy name: PostgreSQL evaluates CHECK constraints before the
       -- ON CONFLICT branch and would otherwise reject an array-only rewrite
       -- that merely preserves an existing historical membership.
       AND NOT EXISTS (
           SELECT 1
             FROM public.tags AS existing
            WHERE existing.tenant_id = NEW.tenant_id
              AND existing.name = btrim(label)::citext
       )
    ON CONFLICT (tenant_id, name) DO NOTHING;

    INSERT INTO public.subscriber_tags
           (tenant_id, subscriber_id, tag_id, source)
    SELECT NEW.tenant_id, NEW.id, t.id, 'legacy_array_writer'
      FROM public.tags AS t
     WHERE t.tenant_id = NEW.tenant_id
       AND EXISTS (
           SELECT 1
             FROM unnest(COALESCE(NEW.tags, '{}'::text[])) AS label
            WHERE t.name = btrim(label)::citext
       )
    ON CONFLICT (tenant_id, subscriber_id, tag_id) DO NOTHING;

    DELETE FROM public.subscriber_tags AS st
     WHERE st.tenant_id = NEW.tenant_id
       AND st.subscriber_id = NEW.id
       AND NOT EXISTS (
           SELECT 1
             FROM public.tags AS t
            WHERE t.tenant_id = st.tenant_id
              AND t.id = st.tag_id
              AND EXISTS (
                  SELECT 1
                    FROM unnest(COALESCE(NEW.tags, '{}'::text[])) AS label
                   WHERE t.name = btrim(label)::citext
              )
       );

    PERFORM public.tag_membership_rebuild_array_1774(NEW.tenant_id, NEW.id);
    RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.subscriber_tags_array_reconcile_1774()
    FROM PUBLIC;

DROP TRIGGER IF EXISTS subscribers_tag_array_insert_1774 ON public.subscribers;
CREATE TRIGGER subscribers_tag_array_insert_1774
AFTER INSERT ON public.subscribers
FOR EACH ROW EXECUTE FUNCTION public.subscriber_tags_array_reconcile_1774();

DROP TRIGGER IF EXISTS subscribers_tag_array_update_1774 ON public.subscribers;
CREATE TRIGGER subscribers_tag_array_update_1774
AFTER UPDATE OF tags ON public.subscribers
FOR EACH ROW
WHEN (NEW.tags IS DISTINCT FROM OLD.tags)
EXECUTE FUNCTION public.subscriber_tags_array_reconcile_1774();

-- A stable tag id survives rename. Rebuild only the subscribers carrying that
-- id so legacy readers observe the new canonical name in the same transaction.
CREATE FUNCTION public.tag_name_projection_reconcile_1774()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
    v_subscriber record;
BEGIN
    IF NEW.name IS NOT DISTINCT FROM OLD.name THEN
        RETURN NEW;
    END IF;
    FOR v_subscriber IN
        SELECT st.subscriber_id
          FROM public.subscriber_tags AS st
         WHERE st.tenant_id = NEW.tenant_id
           AND st.tag_id = NEW.id
    LOOP
        PERFORM public.tag_membership_rebuild_array_1774(
            NEW.tenant_id, v_subscriber.subscriber_id);
    END LOOP;
    RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.tag_name_projection_reconcile_1774()
    FROM PUBLIC;

DROP TRIGGER IF EXISTS tags_name_projection_reconcile_1774 ON public.tags;
CREATE TRIGGER tags_name_projection_reconcile_1774
AFTER UPDATE OF name ON public.tags
FOR EACH ROW
WHEN (NEW.name IS DISTINCT FROM OLD.name)
EXECUTE FUNCTION public.tag_name_projection_reconcile_1774();

COMMIT;
