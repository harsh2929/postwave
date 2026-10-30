-- 1825_campaign_template_catalog_publication.sql
--
-- Explicit operator publication for reviewed tenant reference imports. A
-- scrape remains private and pending by default. Only the privileged catalog
-- operator function may copy an adaptation-approved reference into the
-- platform gallery; runtime postwave_app credentials cannot execute it.
--
-- Shared references remain inspiration-only: publication never grants direct
-- execution of captured third-party HTML. Every publish, refresh, and
-- unpublish is append-only evidence, and unpublished platform rows disappear
-- through RLS without destroying their audit or hosted-preview history.
--
-- rollback-strategy: no-op
-- rollback-details: publication evidence and platform reference lineage are
-- durable. Unpublish affected records before rolling application binaries
-- back; do not delete review/publication receipts.

BEGIN;

ALTER TABLE campaign_templates
    ADD COLUMN catalog_published_at timestamptz,
    ADD COLUMN catalog_unpublished_at timestamptz,
    ADD CONSTRAINT campaign_templates_catalog_publication_pair_chk CHECK (
        catalog_unpublished_at IS NULL
        OR catalog_published_at IS NOT NULL
    ),
    ADD CONSTRAINT campaign_templates_catalog_publication_scope_chk CHECK (
        tenant_id IS NULL
        OR (
            catalog_published_at IS NULL
            AND catalog_unpublished_at IS NULL
        )
    );

-- A platform review receipt has no tenant owner. Tenant receipts retain their
-- existing tenant FK and RLS behavior.
ALTER TABLE campaign_template_reference_review_decisions
    ALTER COLUMN tenant_id DROP NOT NULL;

CREATE OR REPLACE FUNCTION validate_campaign_template_reference_review_decision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_tenant uuid;
    target_kind text;
    target_license text;
    target_hash text;
    catalog_operator boolean;
BEGIN
    SELECT tenant_id, template_kind, source_license_status, content_hash
      INTO target_tenant, target_kind, target_license, target_hash
      FROM campaign_templates
     WHERE id = NEW.template_id
     FOR KEY SHARE;

    catalog_operator :=
        current_user <> 'postwave_app'
        AND current_setting('app.catalog_operator', true) = 'true';

    IF NOT FOUND OR target_kind <> 'reference' THEN
        RAISE EXCEPTION 'reference review target is missing or not a reference'
            USING ERRCODE = '23514';
    END IF;
    IF target_tenant IS NULL THEN
        IF NEW.tenant_id IS NOT NULL OR NOT catalog_operator THEN
            RAISE EXCEPTION 'shared reference review requires the catalog operator'
                USING ERRCODE = '42501';
        END IF;
    ELSIF NEW.tenant_id IS NULL OR target_tenant <> NEW.tenant_id THEN
        RAISE EXCEPTION 'reference review tenant does not match its target'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.source_license_status IS DISTINCT FROM target_license
       OR NEW.source_content_hash IS DISTINCT FROM target_hash THEN
        RAISE EXCEPTION 'reference review evidence does not match current source state'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.direct_use_allowed AND target_license <> 'owned' THEN
        RAISE EXCEPTION 'direct use requires an owned source license'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TABLE campaign_template_catalog_publications (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_tenant_id      uuid REFERENCES tenants(id) ON DELETE SET NULL,
    source_template_id    uuid REFERENCES campaign_templates(id) ON DELETE SET NULL,
    platform_template_id  uuid NOT NULL
                              REFERENCES campaign_templates(id) ON DELETE RESTRICT,
    action                text NOT NULL
                              CHECK (action IN ('publish', 'refresh', 'unpublish')),
    source_provider       text NOT NULL,
    source_external_id    text NOT NULL,
    source_content_hash   text NOT NULL DEFAULT '',
    actor_id              text NOT NULL
                              CHECK (char_length(btrim(actor_id)) BETWEEN 1 AND 512),
    note                  text NOT NULL
                              CHECK (char_length(btrim(note)) BETWEEN 1 AND 2000),
    created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX campaign_template_catalog_publications_platform_created_idx
    ON campaign_template_catalog_publications
       (platform_template_id, created_at DESC, id DESC);

CREATE INDEX campaign_template_catalog_publications_source_created_idx
    ON campaign_template_catalog_publications
       (source_provider, source_external_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION prevent_campaign_template_catalog_publication_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'campaign template catalog publications are append-only'
        USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER campaign_template_catalog_publications_immutable
    BEFORE UPDATE OR DELETE ON campaign_template_catalog_publications
    FOR EACH ROW
    EXECUTE FUNCTION prevent_campaign_template_catalog_publication_mutation();

ALTER TABLE campaign_template_catalog_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_template_catalog_publications FORCE ROW LEVEL SECURITY;

CREATE POLICY campaign_template_catalog_publications_operator
    ON campaign_template_catalog_publications
    FOR ALL
    USING (
        current_user <> 'postwave_app'
        AND current_setting('app.catalog_operator', true) = 'true'
    )
    WITH CHECK (
        current_user <> 'postwave_app'
        AND current_setting('app.catalog_operator', true) = 'true'
    );

-- FORCE RLS also applies to the table owner. This policy is the narrow lane
-- used by the SECURITY DEFINER publication functions below.
CREATE POLICY campaign_template_reference_review_catalog_operator
    ON campaign_template_reference_review_decisions
    FOR ALL
    USING (
        tenant_id IS NULL
        AND current_user <> 'postwave_app'
        AND current_setting('app.catalog_operator', true) = 'true'
    )
    WITH CHECK (
        tenant_id IS NULL
        AND current_user <> 'postwave_app'
        AND current_setting('app.catalog_operator', true) = 'true'
    );

-- Hide unpublished shared references at the database boundary. Existing
-- Postwave-authored editable platform templates stay visible without a
-- publication timestamp.
DROP POLICY tenant_isolation ON campaign_templates;
CREATE POLICY tenant_isolation ON campaign_templates
    FOR ALL
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR (
            tenant_id IS NULL
            AND (
                template_kind = 'editable'
                OR (
                    catalog_published_at IS NOT NULL
                    AND catalog_unpublished_at IS NULL
                )
            )
        )
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR (
            tenant_id IS NULL
            AND (
                template_kind = 'editable'
                OR (
                    catalog_published_at IS NOT NULL
                    AND catalog_unpublished_at IS NULL
                )
            )
        )
    );

CREATE POLICY campaign_templates_catalog_operator
    ON campaign_templates
    FOR ALL
    USING (
        current_user <> 'postwave_app'
        AND current_setting('app.catalog_operator', true) = 'true'
    )
    WITH CHECK (
        current_user <> 'postwave_app'
        AND current_setting('app.catalog_operator', true) = 'true'
    );

CREATE OR REPLACE FUNCTION campaign_template_publish_reference(
    p_source_tenant_id uuid,
    p_source_template_id uuid,
    p_actor_id text,
    p_note text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    source public.campaign_templates%ROWTYPE;
    platform_id uuid;
    decision_id uuid;
    platform_slug text;
    existed boolean;
    publication_action text;
BEGIN
    IF p_source_tenant_id IS NULL
       OR p_source_template_id IS NULL
       OR char_length(btrim(COALESCE(p_actor_id, ''))) NOT BETWEEN 1 AND 512
       OR char_length(btrim(COALESCE(p_note, ''))) NOT BETWEEN 1 AND 2000 THEN
        RAISE EXCEPTION 'valid source, actor, and publication note are required'
            USING ERRCODE = '22023';
    END IF;

    PERFORM set_config('app.catalog_operator', 'true', true);
    PERFORM set_config('app.outbox_worker', 'true', true);

    SELECT *
      INTO source
      FROM public.campaign_templates
     WHERE tenant_id = p_source_tenant_id
       AND id = p_source_template_id
     FOR SHARE;
    IF NOT FOUND
       OR source.template_kind <> 'reference'
       OR source.review_status <> 'approved'
       OR source.reference_adaptation_allowed IS NOT TRUE
       OR source.reference_review_decision_id IS NULL THEN
        RAISE EXCEPTION 'source reference is not adaptation-approved'
            USING ERRCODE = '23514';
    END IF;
    IF source.source_provider = 'postwave'
       OR NULLIF(btrim(COALESCE(source.source_external_id, '')), '') IS NULL THEN
        RAISE EXCEPTION 'source reference lacks an external identity'
            USING ERRCODE = '23514';
    END IF;

    SELECT EXISTS (
        SELECT 1
          FROM public.campaign_templates
         WHERE tenant_id IS NULL
           AND source_provider = source.source_provider
           AND source_external_id = source.source_external_id
    ) INTO existed;

    platform_slug :=
        left(
            regexp_replace(
                lower(source.source_provider || '-' || source.slug),
                '[^a-z0-9-]+', '-', 'g'
            ),
            47
        )
        || '-' || md5(source.source_external_id);

    INSERT INTO public.campaign_templates (
        tenant_id, slug, name, description, category, subject, preview_text,
        body_html, body_mjml, variables, tags, created_by,
        template_kind, source_provider, source_external_id, source_url,
        source_brand, thumbnail_url, source_captured_at,
        source_license_status, source_metadata, industry, style, layout,
        design_metadata, review_status, quality_score, content_hash,
        imported_at, reference_template_ids, generation_metadata,
        reference_adaptation_allowed, reference_direct_use_allowed,
        reference_review_decision_id, reference_reviewed_at,
        catalog_published_at, catalog_unpublished_at
    ) VALUES (
        NULL, platform_slug, source.name, source.description, source.category,
        source.subject, source.preview_text, source.body_html, source.body_mjml,
        source.variables, source.tags, NULL,
        'reference', source.source_provider, source.source_external_id,
        source.source_url, source.source_brand, source.thumbnail_url,
        source.source_captured_at, source.source_license_status,
        source.source_metadata || jsonb_build_object(
            'published_from_tenant_template_id', source.id::text
        ),
        source.industry, source.style, source.layout, source.design_metadata,
        'pending', source.quality_score, source.content_hash, source.imported_at,
        '{}'::uuid[], '{}'::jsonb, false, false, NULL, NULL,
        clock_timestamp(), NULL
    )
    ON CONFLICT (source_provider, source_external_id)
        WHERE tenant_id IS NULL AND source_external_id IS NOT NULL
    DO UPDATE SET
        slug = EXCLUDED.slug,
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        category = EXCLUDED.category,
        subject = EXCLUDED.subject,
        preview_text = EXCLUDED.preview_text,
        body_html = EXCLUDED.body_html,
        body_mjml = EXCLUDED.body_mjml,
        variables = EXCLUDED.variables,
        tags = EXCLUDED.tags,
        source_url = EXCLUDED.source_url,
        source_brand = EXCLUDED.source_brand,
        thumbnail_url = EXCLUDED.thumbnail_url,
        source_captured_at = EXCLUDED.source_captured_at,
        source_license_status = EXCLUDED.source_license_status,
        source_metadata = EXCLUDED.source_metadata,
        industry = EXCLUDED.industry,
        style = EXCLUDED.style,
        layout = EXCLUDED.layout,
        design_metadata = EXCLUDED.design_metadata,
        review_status = 'pending',
        quality_score = EXCLUDED.quality_score,
        content_hash = EXCLUDED.content_hash,
        imported_at = EXCLUDED.imported_at,
        reference_template_ids = '{}'::uuid[],
        generation_metadata = '{}'::jsonb,
        reference_adaptation_allowed = false,
        reference_direct_use_allowed = false,
        reference_review_decision_id = NULL,
        reference_reviewed_at = NULL,
        catalog_published_at = clock_timestamp(),
        catalog_unpublished_at = NULL
    RETURNING id INTO platform_id;

    INSERT INTO public.campaign_template_reference_review_decisions (
        tenant_id, template_id, decision, adaptation_allowed,
        direct_use_allowed, note, source_content_hash, source_license_status,
        actor_type, actor_id, actor_label
    ) VALUES (
        NULL, platform_id, 'approve', true, false,
        btrim(p_note), source.content_hash, source.source_license_status,
        'service', btrim(p_actor_id), 'Catalog operator'
    )
    RETURNING id INTO decision_id;

    UPDATE public.campaign_templates AS template
       SET review_status = 'approved',
           reference_adaptation_allowed = true,
           reference_direct_use_allowed = false,
           reference_review_decision_id = decision_id,
           reference_reviewed_at = decision.created_at
      FROM public.campaign_template_reference_review_decisions AS decision
     WHERE template.id = platform_id
       AND template.tenant_id IS NULL
       AND decision.id = decision_id
       AND decision.template_id = template.id;

    -- Reuse a ready hosted blob when available; otherwise queue the platform
    -- alias against the same allowlisted source. The retained-blob trigger
    -- prevents a refresh from erasing a last-known-good object.
    INSERT INTO public.campaign_template_preview_assets (
        template_id, variant, source_provider, source_url, source_provenance,
        blob_id, status, attempts, max_attempts, next_attempt_at,
        last_attempt_at, last_error, source_last_seen_at, source_missing_at,
        ready_at
    )
    SELECT platform_id, preview.variant, preview.source_provider,
           preview.source_url,
           preview.source_provenance || jsonb_build_object(
               'published_from_template_id', source.id::text
           ),
           preview.blob_id,
           CASE WHEN preview.blob_id IS NULL THEN 'queued' ELSE 'ready' END,
           0, preview.max_attempts, now(), preview.last_attempt_at, NULL,
           preview.source_last_seen_at, preview.source_missing_at,
           CASE WHEN preview.blob_id IS NULL THEN NULL
                ELSE COALESCE(preview.ready_at, now()) END
      FROM public.campaign_template_preview_assets AS preview
     WHERE preview.template_id = source.id
    ON CONFLICT (template_id, variant) DO UPDATE SET
        source_provider = EXCLUDED.source_provider,
        source_url = EXCLUDED.source_url,
        source_provenance = EXCLUDED.source_provenance,
        blob_id = COALESCE(EXCLUDED.blob_id, campaign_template_preview_assets.blob_id),
        status = CASE
            WHEN COALESCE(
                EXCLUDED.blob_id,
                campaign_template_preview_assets.blob_id
            ) IS NULL THEN 'queued'
            ELSE 'ready'
        END,
        attempts = 0,
        max_attempts = EXCLUDED.max_attempts,
        next_attempt_at = now(),
        last_error = NULL,
        lease_owner = NULL,
        lease_expires_at = NULL,
        ready_at = COALESCE(
            EXCLUDED.ready_at,
            campaign_template_preview_assets.ready_at
        );

    publication_action := CASE WHEN existed THEN 'refresh' ELSE 'publish' END;
    INSERT INTO public.campaign_template_catalog_publications (
        source_tenant_id, source_template_id, platform_template_id, action,
        source_provider, source_external_id, source_content_hash, actor_id, note
    ) VALUES (
        p_source_tenant_id, source.id, platform_id, publication_action,
        source.source_provider, source.source_external_id, source.content_hash,
        btrim(p_actor_id), btrim(p_note)
    );
    RETURN platform_id;
END;
$function$;

CREATE OR REPLACE FUNCTION campaign_template_unpublish_reference(
    p_platform_template_id uuid,
    p_actor_id text,
    p_note text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    target public.campaign_templates%ROWTYPE;
BEGIN
    IF p_platform_template_id IS NULL
       OR char_length(btrim(COALESCE(p_actor_id, ''))) NOT BETWEEN 1 AND 512
       OR char_length(btrim(COALESCE(p_note, ''))) NOT BETWEEN 1 AND 2000 THEN
        RAISE EXCEPTION 'valid platform template, actor, and note are required'
            USING ERRCODE = '22023';
    END IF;
    PERFORM set_config('app.catalog_operator', 'true', true);
    UPDATE public.campaign_templates
       SET catalog_unpublished_at = clock_timestamp()
     WHERE id = p_platform_template_id
       AND tenant_id IS NULL
       AND template_kind = 'reference'
       AND catalog_published_at IS NOT NULL
       AND catalog_unpublished_at IS NULL
    RETURNING * INTO target;
    IF NOT FOUND THEN
        RETURN false;
    END IF;
    INSERT INTO public.campaign_template_catalog_publications (
        source_tenant_id, source_template_id, platform_template_id, action,
        source_provider, source_external_id, source_content_hash, actor_id, note
    ) VALUES (
        NULL, NULL, target.id, 'unpublish', target.source_provider,
        target.source_external_id, target.content_hash,
        btrim(p_actor_id), btrim(p_note)
    );
    RETURN true;
END;
$function$;

REVOKE ALL ON TABLE campaign_template_catalog_publications
    FROM PUBLIC, postwave_app;
REVOKE ALL ON FUNCTION campaign_template_publish_reference(
    uuid, uuid, text, text
) FROM PUBLIC, postwave_app;
REVOKE ALL ON FUNCTION campaign_template_unpublish_reference(
    uuid, text, text
) FROM PUBLIC, postwave_app;

COMMENT ON TABLE campaign_template_catalog_publications IS
    'Append-only operator evidence for shared campaign-template reference publication.';
COMMENT ON FUNCTION campaign_template_publish_reference(uuid, uuid, text, text) IS
    'Privileged operator-only promotion of one current adaptation-approved tenant reference into the shared inspiration catalog.';

COMMIT;
