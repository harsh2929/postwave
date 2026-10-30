-- 1920_campaign_assurance_artifact_foundation.sql
--
-- Campaign Assurance must evaluate the exact source and render plan that live
-- dispatch uses.  Mutable campaign drafts therefore remain the authoring
-- surface, while explicit saves, assurance requests, and queue attempts create
-- immutable content revisions.  A send plan freezes compiler/policy/coverage
-- inputs and its scenario artifacts carry content-addressed projection/MIME
-- evidence.
--
-- This migration deliberately does not store real-recipient MIME.  Artifact
-- object references are for synthetic assurance fixtures and are governed by
-- expires_at.  Live delivery ledgers will retain hashes and compiler identity,
-- not subscriber-specific bodies, unless a separately reviewed forensic mode
-- is introduced.
--
-- rollback-strategy: no-op.  These additive evidence tables must be retained
-- for receipts already issued; older application versions ignore them.

BEGIN;

ALTER TABLE campaigns
    ADD COLUMN IF NOT EXISTS source_mode text NOT NULL DEFAULT 'legacy_html',
    ADD COLUMN IF NOT EXISTS content_schema_version integer NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS fact_contract jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE campaigns
    DROP CONSTRAINT IF EXISTS campaigns_source_mode_check,
    ADD CONSTRAINT campaigns_source_mode_check
        CHECK (source_mode IN ('semantic', 'legacy_html')),
    DROP CONSTRAINT IF EXISTS campaigns_content_schema_version_check,
    ADD CONSTRAINT campaigns_content_schema_version_check
        CHECK (content_schema_version BETWEEN 1 AND 1000),
    DROP CONSTRAINT IF EXISTS campaigns_fact_contract_object_check,
    ADD CONSTRAINT campaigns_fact_contract_object_check
        CHECK (jsonb_typeof(fact_contract) = 'object');

-- Composite tenant identities let every new foreign key prove ownership in the
-- database instead of relying on RLS alone.  Both base tables already have a
-- globally unique UUID primary key, so these indexes cannot reject valid rows.
CREATE UNIQUE INDEX IF NOT EXISTS campaigns_tenant_id_id_uidx
    ON campaigns (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS campaign_variants_tenant_id_id_uidx
    ON campaign_variants (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS campaign_variants_tenant_campaign_id_uidx
    ON campaign_variants (tenant_id, campaign_id, id);

CREATE TABLE campaign_content_revisions (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id            uuid NOT NULL,
    revision_no            bigint NOT NULL CHECK (revision_no > 0),
    source_mode            text NOT NULL CHECK (source_mode IN ('semantic', 'legacy_html')),
    content_schema_version integer NOT NULL CHECK (content_schema_version BETWEEN 1 AND 1000),
    subject                text NOT NULL,
    preview_text           text,
    semantic_tree          jsonb NOT NULL DEFAULT '[]'::jsonb
                           CHECK (jsonb_typeof(semantic_tree) = 'array'),
    legacy_html            text,
    reviewed_plain_text    text,
    fact_contract          jsonb NOT NULL DEFAULT '{}'::jsonb
                           CHECK (jsonb_typeof(fact_contract) = 'object'),
    variants               jsonb NOT NULL DEFAULT '[]'::jsonb
                           CHECK (jsonb_typeof(variants) = 'array'),
    locales                jsonb NOT NULL DEFAULT '[]'::jsonb
                           CHECK (jsonb_typeof(locales) = 'array'),
    source_hash            text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
    created_by             uuid,
    created_at             timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT campaign_content_revisions_campaign_fk
        FOREIGN KEY (tenant_id, campaign_id)
        REFERENCES campaigns (tenant_id, id)
        ON DELETE CASCADE,
    CONSTRAINT campaign_content_revisions_source_shape_check CHECK (
        (source_mode = 'semantic' AND jsonb_array_length(semantic_tree) > 0)
        OR
        (source_mode = 'legacy_html' AND legacy_html IS NOT NULL)
    ),
    UNIQUE (tenant_id, campaign_id, revision_no),
    UNIQUE (tenant_id, campaign_id, source_hash),
    UNIQUE (tenant_id, campaign_id, id),
    UNIQUE (tenant_id, id)
);

CREATE INDEX campaign_content_revisions_campaign_created_idx
    ON campaign_content_revisions (tenant_id, campaign_id, created_at DESC, id DESC);

CREATE TABLE campaign_send_plans (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id            uuid NOT NULL,
    content_revision_id    uuid NOT NULL,
    plan_no                bigint NOT NULL CHECK (plan_no > 0),
    request_id             uuid,
    request_hash           text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    renderer_version       text NOT NULL CHECK (length(renderer_version) BETWEEN 1 AND 160),
    compiler_version       text NOT NULL CHECK (length(compiler_version) BETWEEN 1 AND 160),
    transform_manifest     jsonb NOT NULL DEFAULT '{}'::jsonb
                           CHECK (jsonb_typeof(transform_manifest) = 'object'),
    coverage_manifest      jsonb NOT NULL DEFAULT '{}'::jsonb
                           CHECK (jsonb_typeof(coverage_manifest) = 'object'),
    fixture_set_version    text NOT NULL CHECK (length(fixture_set_version) BETWEEN 1 AND 160),
    policy_version         text NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 160),
    plan_hash              text CHECK (plan_hash IS NULL OR plan_hash ~ '^[0-9a-f]{64}$'),
    state                  text NOT NULL DEFAULT 'preparing' CHECK (state IN (
                               'preparing', 'ready', 'certified', 'stale',
                               'superseded', 'failed'
                           )),
    failure_code           text CHECK (
                               failure_code IS NULL OR
                               failure_code ~ '^[A-Z][A-Z0-9_]{0,95}$'
                           ),
    created_by             uuid,
    created_at             timestamptz NOT NULL DEFAULT now(),
    ready_at               timestamptz,
    certified_at           timestamptz,
    stale_at               timestamptz,
    superseded_at          timestamptz,
    failed_at              timestamptz,
    CONSTRAINT campaign_send_plans_campaign_fk
        FOREIGN KEY (tenant_id, campaign_id)
        REFERENCES campaigns (tenant_id, id)
        ON DELETE CASCADE,
    CONSTRAINT campaign_send_plans_revision_fk
        FOREIGN KEY (tenant_id, campaign_id, content_revision_id)
        REFERENCES campaign_content_revisions (tenant_id, campaign_id, id),
    CONSTRAINT campaign_send_plans_terminal_shape_check CHECK (
        (state = 'preparing'
            AND ready_at IS NULL AND certified_at IS NULL AND stale_at IS NULL
            AND superseded_at IS NULL AND failed_at IS NULL
            AND failure_code IS NULL)
        OR (state = 'ready'
            AND ready_at IS NOT NULL AND certified_at IS NULL AND stale_at IS NULL
            AND superseded_at IS NULL AND failed_at IS NULL
            AND failure_code IS NULL AND plan_hash IS NOT NULL)
        OR (state = 'certified'
            AND ready_at IS NOT NULL AND certified_at IS NOT NULL AND stale_at IS NULL
            AND superseded_at IS NULL AND failed_at IS NULL
            AND failure_code IS NULL AND plan_hash IS NOT NULL)
        OR (state = 'stale'
            AND ready_at IS NOT NULL AND stale_at IS NOT NULL
            AND superseded_at IS NULL AND failed_at IS NULL
            AND plan_hash IS NOT NULL)
        OR (state = 'superseded'
            AND ready_at IS NOT NULL AND superseded_at IS NOT NULL
            AND failed_at IS NULL AND plan_hash IS NOT NULL)
        OR (state = 'failed'
            AND failed_at IS NOT NULL AND failure_code IS NOT NULL)
    ),
    UNIQUE (tenant_id, campaign_id, plan_no),
    UNIQUE (tenant_id, campaign_id, request_id),
    UNIQUE (tenant_id, campaign_id, id),
    UNIQUE (tenant_id, id)
);

CREATE INDEX campaign_send_plans_campaign_created_idx
    ON campaign_send_plans (tenant_id, campaign_id, created_at DESC, id DESC);
CREATE INDEX campaign_send_plans_active_idx
    ON campaign_send_plans (tenant_id, campaign_id, state, created_at DESC)
    WHERE state IN ('preparing', 'ready', 'certified');

CREATE TABLE campaign_render_artifacts (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id              uuid NOT NULL,
    send_plan_id             uuid NOT NULL,
    scenario_id              text NOT NULL CHECK (length(scenario_id) BETWEEN 1 AND 200),
    variant_id               uuid,
    locale                   text NOT NULL CHECK (length(locale) BETWEEN 2 AND 35),
    branch_key               text NOT NULL DEFAULT 'default'
                             CHECK (length(branch_key) BETWEEN 1 AND 200),
    fixture_id               text NOT NULL CHECK (length(fixture_id) BETWEEN 1 AND 200),
    source_hash              text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
    html_hash                text NOT NULL CHECK (html_hash ~ '^[0-9a-f]{64}$'),
    text_hash                text NOT NULL CHECK (text_hash ~ '^[0-9a-f]{64}$'),
    structured_data_hash     text CHECK (
                                 structured_data_hash IS NULL OR
                                 structured_data_hash ~ '^[0-9a-f]{64}$'
                             ),
    mime_structure_hash      text NOT NULL CHECK (mime_structure_hash ~ '^[0-9a-f]{64}$'),
    outbound_mime_hash       text NOT NULL CHECK (outbound_mime_hash ~ '^[0-9a-f]{64}$'),
    html_object_ref          text,
    text_object_ref          text,
    mime_object_ref          text,
    compiler_receipt         jsonb NOT NULL CHECK (jsonb_typeof(compiler_receipt) = 'object'),
    representation_manifest  jsonb NOT NULL CHECK (jsonb_typeof(representation_manifest) = 'object'),
    created_at               timestamptz NOT NULL DEFAULT now(),
    expires_at               timestamptz,
    CONSTRAINT campaign_render_artifacts_plan_fk
        FOREIGN KEY (tenant_id, campaign_id, send_plan_id)
        REFERENCES campaign_send_plans (tenant_id, campaign_id, id)
        ON DELETE CASCADE,
    CONSTRAINT campaign_render_artifacts_variant_fk
        FOREIGN KEY (tenant_id, campaign_id, variant_id)
        REFERENCES campaign_variants (tenant_id, campaign_id, id),
    CONSTRAINT campaign_render_artifacts_retention_check
        CHECK (expires_at IS NULL OR expires_at > created_at),
    UNIQUE (tenant_id, send_plan_id, scenario_id),
    UNIQUE (tenant_id, id)
);

CREATE INDEX campaign_render_artifacts_plan_created_idx
    ON campaign_render_artifacts (tenant_id, send_plan_id, created_at, id);
CREATE INDEX campaign_render_artifacts_expiry_idx
    ON campaign_render_artifacts (expires_at, id)
    WHERE expires_at IS NOT NULL;

-- Child snapshots are application-append-only.  Cascade deletion remains
-- possible for a parent campaign/tenant, while a direct evidence deletion or
-- any update is rejected even if privileges are accidentally widened later.
CREATE OR REPLACE FUNCTION campaign_assurance_append_only_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
    IF TG_OP = 'DELETE' THEN
        -- Branch before accessing OLD fields: a trigger record exposes only
        -- the columns of its own table, and PL/pgSQL is not required to avoid
        -- resolving the right side of a boolean expression for another table.
        IF TG_TABLE_NAME = 'campaign_content_revisions' THEN
            IF NOT EXISTS (
                SELECT 1 FROM public.campaigns
                 WHERE tenant_id = OLD.tenant_id AND id = OLD.campaign_id
            ) THEN
                RETURN OLD;
            END IF;
        ELSIF TG_TABLE_NAME = 'campaign_render_artifacts' THEN
            IF NOT EXISTS (
                SELECT 1 FROM public.campaign_send_plans
                 WHERE tenant_id = OLD.tenant_id AND id = OLD.send_plan_id
            ) THEN
                RETURN OLD;
            END IF;
        ELSIF TG_TABLE_NAME = 'campaign_send_plans' THEN
            IF NOT EXISTS (
                SELECT 1 FROM public.campaigns
                 WHERE tenant_id = OLD.tenant_id AND id = OLD.campaign_id
            ) THEN
                RETURN OLD;
            END IF;
        END IF;
    END IF;

    RAISE EXCEPTION '% evidence is append-only', TG_TABLE_NAME
        USING ERRCODE = '55000';
END;
$fn$;

CREATE TRIGGER campaign_content_revisions_append_only
    BEFORE UPDATE OR DELETE ON campaign_content_revisions
    FOR EACH ROW EXECUTE FUNCTION campaign_assurance_append_only_guard();

CREATE TRIGGER campaign_render_artifacts_append_only
    BEFORE UPDATE OR DELETE ON campaign_render_artifacts
    FOR EACH ROW EXECUTE FUNCTION campaign_assurance_append_only_guard();

CREATE TRIGGER campaign_send_plans_delete_guard
    BEFORE DELETE ON campaign_send_plans
    FOR EACH ROW EXECUTE FUNCTION campaign_assurance_append_only_guard();

CREATE OR REPLACE FUNCTION campaign_send_plans_lifecycle_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
    IF OLD.state IN ('superseded', 'failed') AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'terminal campaign send plan is immutable'
            USING ERRCODE = '55000';
    END IF;

    -- The plan freezes compiler/policy/coverage identity when it is created.
    -- The preparing state exists only while its immutable artifact set is
    -- populated; it is not an editing window for plan inputs.
    IF (
        NEW.id IS DISTINCT FROM OLD.id OR
        NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR
        NEW.campaign_id IS DISTINCT FROM OLD.campaign_id OR
        NEW.content_revision_id IS DISTINCT FROM OLD.content_revision_id OR
        NEW.plan_no IS DISTINCT FROM OLD.plan_no OR
        NEW.request_id IS DISTINCT FROM OLD.request_id OR
        NEW.request_hash IS DISTINCT FROM OLD.request_hash OR
        NEW.renderer_version IS DISTINCT FROM OLD.renderer_version OR
        NEW.compiler_version IS DISTINCT FROM OLD.compiler_version OR
        NEW.transform_manifest IS DISTINCT FROM OLD.transform_manifest OR
        NEW.coverage_manifest IS DISTINCT FROM OLD.coverage_manifest OR
        NEW.fixture_set_version IS DISTINCT FROM OLD.fixture_set_version OR
        NEW.policy_version IS DISTINCT FROM OLD.policy_version OR
        NEW.created_by IS DISTINCT FROM OLD.created_by OR
        NEW.created_at IS DISTINCT FROM OLD.created_at
    ) THEN
        RAISE EXCEPTION 'campaign send plan inputs are immutable'
            USING ERRCODE = '55000';
    END IF;

    IF OLD.state <> 'preparing' AND NEW.state = OLD.state AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'campaign send plan lifecycle is append-only'
            USING ERRCODE = '55000';
    END IF;

    IF NEW.plan_hash IS DISTINCT FROM OLD.plan_hash AND NOT (
        OLD.state = 'preparing' AND NEW.state = 'ready' AND
        OLD.plan_hash IS NULL AND NEW.plan_hash IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'plan_hash may only be set by preparing -> ready'
            USING ERRCODE = '55000';
    END IF;

    IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
        (OLD.state = 'preparing' AND NEW.state IN ('ready', 'failed')) OR
        (OLD.state = 'ready' AND NEW.state IN ('certified', 'stale', 'superseded', 'failed')) OR
        (OLD.state = 'certified' AND NEW.state IN ('stale', 'superseded')) OR
        (OLD.state = 'stale' AND NEW.state = 'superseded')
    ) THEN
        RAISE EXCEPTION 'invalid campaign send plan transition: % -> %', OLD.state, NEW.state
            USING ERRCODE = '55000';
    END IF;

    -- Each lifecycle timestamp may be written exactly once by the transition
    -- it represents. Earlier timestamps cannot be rewritten while advancing a
    -- later state, which keeps receipts historically stable.
    IF NEW.ready_at IS DISTINCT FROM OLD.ready_at AND NOT (
        OLD.state = 'preparing' AND NEW.state = 'ready' AND
        OLD.ready_at IS NULL AND NEW.ready_at IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'ready_at may only be set by preparing -> ready'
            USING ERRCODE = '55000';
    END IF;
    IF NEW.certified_at IS DISTINCT FROM OLD.certified_at AND NOT (
        OLD.state = 'ready' AND NEW.state = 'certified' AND
        OLD.certified_at IS NULL AND NEW.certified_at IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'certified_at may only be set by ready -> certified'
            USING ERRCODE = '55000';
    END IF;
    IF NEW.stale_at IS DISTINCT FROM OLD.stale_at AND NOT (
        OLD.state IN ('ready', 'certified') AND NEW.state = 'stale' AND
        OLD.stale_at IS NULL AND NEW.stale_at IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'stale_at may only be set when entering stale'
            USING ERRCODE = '55000';
    END IF;
    IF NEW.superseded_at IS DISTINCT FROM OLD.superseded_at AND NOT (
        OLD.state IN ('ready', 'certified', 'stale') AND NEW.state = 'superseded' AND
        OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'superseded_at may only be set when entering superseded'
            USING ERRCODE = '55000';
    END IF;
    IF NEW.failed_at IS DISTINCT FROM OLD.failed_at AND NOT (
        OLD.state IN ('preparing', 'ready') AND NEW.state = 'failed' AND
        OLD.failed_at IS NULL AND NEW.failed_at IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'failed_at may only be set when entering failed'
            USING ERRCODE = '55000';
    END IF;
    IF NEW.failure_code IS DISTINCT FROM OLD.failure_code AND NOT (
        OLD.state IN ('preparing', 'ready') AND NEW.state = 'failed' AND
        OLD.failure_code IS NULL AND NEW.failure_code IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'failure_code may only be set when entering failed'
            USING ERRCODE = '55000';
    END IF;

    RETURN NEW;
END;
$fn$;

CREATE TRIGGER campaign_send_plans_lifecycle
    BEFORE UPDATE ON campaign_send_plans
    FOR EACH ROW EXECUTE FUNCTION campaign_send_plans_lifecycle_guard();

ALTER TABLE campaign_content_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_content_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON campaign_content_revisions
    AS RESTRICTIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON campaign_content_revisions
    FOR ALL TO postwave_app USING (true) WITH CHECK (true);

ALTER TABLE campaign_send_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_send_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON campaign_send_plans
    AS RESTRICTIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON campaign_send_plans
    FOR ALL TO postwave_app USING (true) WITH CHECK (true);

ALTER TABLE campaign_render_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_render_artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON campaign_render_artifacts
    AS RESTRICTIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON campaign_render_artifacts
    FOR ALL TO postwave_app USING (true) WITH CHECK (true);

GRANT SELECT, INSERT ON campaign_content_revisions TO postwave_app;
GRANT SELECT, INSERT, UPDATE ON campaign_send_plans TO postwave_app;
GRANT SELECT, INSERT ON campaign_render_artifacts TO postwave_app;

COMMENT ON COLUMN campaigns.fact_contract IS
    'Mutable Fact Contract v1 draft; each content revision freezes it verbatim.';
COMMENT ON TABLE campaign_content_revisions IS
    'Immutable source snapshot used by one or more Campaign Assurance send plans.';
COMMENT ON TABLE campaign_send_plans IS
    'Versioned compiler, transform, fixture, coverage, and policy inputs frozen before assurance or dispatch.';
COMMENT ON TABLE campaign_render_artifacts IS
    'Immutable content-addressed synthetic artifact for one required variant/locale/branch/fixture scenario.';

COMMIT;
