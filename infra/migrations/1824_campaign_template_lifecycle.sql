-- 1824_campaign_template_lifecycle.sql
--
-- Tenant-editable campaign templates use monotonic versions for strong HTTP
-- preconditions, soft archive/restore instead of destructive deletion, and an
-- append-only snapshot for every authoring lifecycle transition.
--
-- rollback-strategy: no-op
-- rollback-details: versions and revision snapshots are durable authoring
-- history. Older binaries ignore the added columns; archived rows remain
-- readable by id and can be restored by a lifecycle-aware binary.

BEGIN;

ALTER TABLE campaign_templates
    ADD COLUMN version bigint NOT NULL DEFAULT 1,
    ADD COLUMN archived_at timestamptz,
    ADD CONSTRAINT campaign_templates_version_positive_chk
        CHECK (version > 0),
    ADD CONSTRAINT campaign_templates_reference_not_archived_chk
        CHECK (template_kind <> 'reference' OR archived_at IS NULL);

CREATE TABLE campaign_template_revisions (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    template_id  uuid NOT NULL REFERENCES campaign_templates(id) ON DELETE RESTRICT,
    version      bigint NOT NULL CHECK (version > 0),
    transition   text NOT NULL
                     CHECK (transition IN ('baseline', 'create', 'update', 'archive', 'restore')),
    snapshot     jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
    archived_at  timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (template_id, version)
);

CREATE INDEX campaign_template_revisions_tenant_template_idx
    ON campaign_template_revisions (tenant_id, template_id, version DESC);

-- Existing editable tenant rows start with an immutable baseline. Shared
-- platform rows and reference-only inspiration records intentionally do not
-- participate in editable authoring history.
INSERT INTO campaign_template_revisions
    (tenant_id, template_id, version, transition, snapshot, archived_at, created_at)
SELECT tenant_id, id, version, 'baseline', to_jsonb(template), archived_at, now()
  FROM campaign_templates AS template
 WHERE tenant_id IS NOT NULL
   AND template_kind = 'editable';

GRANT SELECT ON campaign_template_revisions TO postwave_app;

ALTER TABLE campaign_template_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_template_revisions FORCE ROW LEVEL SECURITY;

CREATE POLICY campaign_template_revisions_tenant_isolation
    ON campaign_template_revisions
    AS RESTRICTIVE
    FOR ALL
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

CREATE POLICY campaign_template_revisions_tenant_read
    ON campaign_template_revisions
    AS PERMISSIVE
    FOR SELECT
    TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

CREATE OR REPLACE FUNCTION campaign_template_assign_lifecycle_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
    IF NEW.template_kind = 'reference' AND NEW.archived_at IS NOT NULL THEN
        RAISE EXCEPTION 'campaign template references cannot be archived'
            USING ERRCODE = '55000';
    END IF;

    IF TG_OP = 'INSERT' THEN
        NEW.version := 1;
        RETURN NEW;
    END IF;

    -- The application role cannot choose a version. Only meaningful changes
    -- to a tenant-editable authoring record advance the counter. Operational
    -- popularity/curation updates remain outside authoring history.
    IF NEW.tenant_id IS NOT NULL
       AND OLD.template_kind = 'editable'
       AND NEW.template_kind = 'editable' THEN
        IF (
            to_jsonb(NEW) - ARRAY[
                'version', 'updated_at', 'usage_count', 'last_used_at',
                'is_featured'
            ]::text[]
        ) IS DISTINCT FROM (
            to_jsonb(OLD) - ARRAY[
                'version', 'updated_at', 'usage_count', 'last_used_at',
                'is_featured'
            ]::text[]
        ) THEN
            NEW.version := OLD.version + 1;
        ELSE
            NEW.version := OLD.version;
        END IF;
    ELSE
        NEW.version := OLD.version;
    END IF;
    RETURN NEW;
END;
$function$;

CREATE TRIGGER campaign_template_lifecycle_version
    BEFORE INSERT OR UPDATE ON campaign_templates
    FOR EACH ROW EXECUTE FUNCTION campaign_template_assign_lifecycle_version();

CREATE OR REPLACE FUNCTION campaign_template_append_revision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    lifecycle_transition text;
BEGIN
    IF NEW.tenant_id IS NULL OR NEW.template_kind <> 'editable' THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.version = OLD.version THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' THEN
        lifecycle_transition := 'create';
    ELSIF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN
        lifecycle_transition := 'archive';
    ELSIF OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL THEN
        lifecycle_transition := 'restore';
    ELSE
        lifecycle_transition := 'update';
    END IF;

    INSERT INTO public.campaign_template_revisions
        (tenant_id, template_id, version, transition, snapshot, archived_at)
    VALUES
        (NEW.tenant_id, NEW.id, NEW.version, lifecycle_transition,
         to_jsonb(NEW), NEW.archived_at);
    RETURN NEW;
END;
$function$;

CREATE TRIGGER campaign_template_revision_append
    AFTER INSERT OR UPDATE ON campaign_templates
    FOR EACH ROW EXECUTE FUNCTION campaign_template_append_revision();

CREATE OR REPLACE FUNCTION prevent_campaign_template_revision_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
    RAISE EXCEPTION 'campaign template revisions are append-only'
        USING ERRCODE = '55000';
END;
$function$;

CREATE TRIGGER campaign_template_revision_immutable
    BEFORE UPDATE OR DELETE ON campaign_template_revisions
    FOR EACH ROW EXECUTE FUNCTION prevent_campaign_template_revision_mutation();

-- Lifecycle-aware application code archives instead of deleting. Revoking the
-- direct table privilege also protects rows changed through older binaries.
REVOKE DELETE ON campaign_templates FROM postwave_app;

COMMIT;
