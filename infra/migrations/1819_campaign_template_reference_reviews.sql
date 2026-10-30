-- 1819_campaign_template_reference_reviews.sql
--
-- Explicit, append-only rights review for external campaign-template
-- references. A review may allow an original adaptation without granting
-- direct execution of captured third-party HTML. The source license string is
-- snapshotted for evidence and is never rewritten by the decision.
--
-- rollback-strategy: no-op
-- rollback-details: review receipts and their current-state pointers are
-- durable rights evidence. Reference rows remain immutable; older binaries
-- can continue reading them and importing through the trusted functions.

BEGIN;

CREATE TABLE campaign_template_reference_review_decisions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    template_id         uuid NOT NULL REFERENCES campaign_templates(id) ON DELETE RESTRICT,
    decision            text NOT NULL
                            CHECK (decision IN ('approve', 'reject')),
    adaptation_allowed  boolean NOT NULL DEFAULT false,
    direct_use_allowed  boolean NOT NULL DEFAULT false,
    note                text NOT NULL
                            CHECK (char_length(btrim(note)) BETWEEN 1 AND 2000),
    source_content_hash text NOT NULL DEFAULT '',
    source_license_status text NOT NULL DEFAULT '',
    actor_type          text NOT NULL
                            CHECK (actor_type IN ('user', 'api_key', 'service')),
    actor_id            text NOT NULL
                            CHECK (char_length(btrim(actor_id)) BETWEEN 1 AND 512),
    actor_label         text NOT NULL DEFAULT ''
                            CHECK (char_length(actor_label) <= 512),
    created_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, template_id),
    CONSTRAINT campaign_template_reference_review_rejection_chk CHECK (
        decision <> 'reject'
        OR (adaptation_allowed = false AND direct_use_allowed = false)
    ),
    CONSTRAINT campaign_template_reference_review_approval_chk CHECK (
        decision <> 'approve'
        OR adaptation_allowed = true
        OR direct_use_allowed = true
    )
);

ALTER TABLE campaign_templates
    ADD COLUMN reference_adaptation_allowed boolean NOT NULL DEFAULT false,
    ADD COLUMN reference_direct_use_allowed boolean NOT NULL DEFAULT false,
    ADD COLUMN reference_review_decision_id uuid,
    ADD COLUMN reference_reviewed_at timestamptz,
    ADD CONSTRAINT campaign_templates_reference_review_decision_fk
        FOREIGN KEY (reference_review_decision_id, id)
        REFERENCES campaign_template_reference_review_decisions(id, template_id)
        ON DELETE RESTRICT,
    ADD CONSTRAINT campaign_templates_reference_review_state_chk CHECK (
        (
            reference_review_decision_id IS NULL
            AND reference_adaptation_allowed = false
            AND reference_direct_use_allowed = false
            AND reference_reviewed_at IS NULL
        )
        OR (
            template_kind = 'reference'
            AND reference_review_decision_id IS NOT NULL
            AND reference_reviewed_at IS NOT NULL
        )
    );

-- No pre-migration reference is grandfathered into executable or adaptation
-- rights without an audit receipt. Editable Postwave-owned templates continue
-- to use their existing approved+owned direct-use gate.
UPDATE campaign_templates
   SET review_status = 'pending',
       reference_adaptation_allowed = false,
       reference_direct_use_allowed = false,
       reference_review_decision_id = NULL,
       reference_reviewed_at = NULL
 WHERE template_kind = 'reference';

CREATE OR REPLACE FUNCTION validate_campaign_template_reference_review_decision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_tenant uuid;
    target_kind text;
    target_license text;
    target_hash text;
BEGIN
    SELECT tenant_id, template_kind, source_license_status, content_hash
      INTO target_tenant, target_kind, target_license, target_hash
      FROM campaign_templates
     WHERE id = NEW.template_id
     FOR KEY SHARE;

    IF NOT FOUND
       OR target_tenant IS NULL
       OR target_tenant <> NEW.tenant_id
       OR target_kind <> 'reference' THEN
        RAISE EXCEPTION 'reference review target is missing, shared, or not a tenant reference'
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

CREATE TRIGGER campaign_template_reference_review_validate
    BEFORE INSERT ON campaign_template_reference_review_decisions
    FOR EACH ROW EXECUTE FUNCTION validate_campaign_template_reference_review_decision();

CREATE OR REPLACE FUNCTION prevent_campaign_template_reference_review_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'campaign template reference review decisions are append-only'
        USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER campaign_template_reference_review_immutable
    BEFORE UPDATE OR DELETE ON campaign_template_reference_review_decisions
    FOR EACH ROW EXECUTE FUNCTION prevent_campaign_template_reference_review_mutation();

CREATE OR REPLACE FUNCTION validate_campaign_template_current_reference_review()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    receipt_decision text;
    receipt_adaptation boolean;
    receipt_direct boolean;
    receipt_created_at timestamptz;
BEGIN
    IF NEW.reference_review_decision_id IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT decision, adaptation_allowed, direct_use_allowed, created_at
      INTO receipt_decision, receipt_adaptation, receipt_direct, receipt_created_at
      FROM campaign_template_reference_review_decisions
     WHERE id = NEW.reference_review_decision_id
       AND template_id = NEW.id;
    IF NOT FOUND
       OR NEW.template_kind <> 'reference'
       OR NEW.reference_adaptation_allowed IS DISTINCT FROM receipt_adaptation
       OR NEW.reference_direct_use_allowed IS DISTINCT FROM receipt_direct
       OR NEW.reference_reviewed_at IS DISTINCT FROM receipt_created_at
       OR NEW.review_status IS DISTINCT FROM (
          CASE receipt_decision WHEN 'approve' THEN 'approved' ELSE 'rejected' END
       ) THEN
        RAISE EXCEPTION 'campaign template current reference review does not match its audit receipt'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER campaign_template_current_reference_review_validate
    BEFORE INSERT OR UPDATE OF
        template_kind, review_status, reference_adaptation_allowed,
        reference_direct_use_allowed, reference_review_decision_id,
        reference_reviewed_at
    ON campaign_templates
    FOR EACH ROW EXECUTE FUNCTION validate_campaign_template_current_reference_review();

-- Runtime SQL may create tenant-owned reference rows, but once created it may
-- neither rewrite protected content/provenance/governance nor delete them
-- directly. Operational counters and curation state (usage_count,
-- last_used_at, is_featured) may still advance. Only the fixed-shape import
-- and review functions below execute as the migration owner and can change
-- protected fields. Editable templates retain their ordinary CRUD behavior.
CREATE OR REPLACE FUNCTION prevent_campaign_template_reference_row_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF current_user = 'postwave_app' THEN
        IF TG_OP = 'DELETE' AND OLD.template_kind = 'reference' THEN
            RAISE EXCEPTION 'campaign template references are immutable'
                USING ERRCODE = '55000';
        END IF;
        IF TG_OP = 'UPDATE'
           AND (OLD.template_kind = 'reference' OR NEW.template_kind = 'reference')
           AND ROW(
               OLD.id, OLD.tenant_id, OLD.slug, OLD.name, OLD.description,
               OLD.category, OLD.subject, OLD.preview_text, OLD.body_html,
               OLD.body_mjml, OLD.variables, OLD.tags, OLD.goal, OLD.created_by,
               OLD.created_at, OLD.template_kind, OLD.source_provider,
               OLD.source_external_id, OLD.source_url, OLD.source_brand,
               OLD.thumbnail_url, OLD.source_captured_at,
               OLD.source_license_status, OLD.source_metadata, OLD.industry,
               OLD.style, OLD.layout, OLD.design_metadata, OLD.review_status,
               OLD.quality_score, OLD.content_hash, OLD.imported_at,
               OLD.reference_template_ids, OLD.generation_metadata,
               OLD.reference_adaptation_allowed,
               OLD.reference_direct_use_allowed,
               OLD.reference_review_decision_id, OLD.reference_reviewed_at
           ) IS DISTINCT FROM ROW(
               NEW.id, NEW.tenant_id, NEW.slug, NEW.name, NEW.description,
               NEW.category, NEW.subject, NEW.preview_text, NEW.body_html,
               NEW.body_mjml, NEW.variables, NEW.tags, NEW.goal, NEW.created_by,
               NEW.created_at, NEW.template_kind, NEW.source_provider,
               NEW.source_external_id, NEW.source_url, NEW.source_brand,
               NEW.thumbnail_url, NEW.source_captured_at,
               NEW.source_license_status, NEW.source_metadata, NEW.industry,
               NEW.style, NEW.layout, NEW.design_metadata, NEW.review_status,
               NEW.quality_score, NEW.content_hash, NEW.imported_at,
               NEW.reference_template_ids, NEW.generation_metadata,
               NEW.reference_adaptation_allowed,
               NEW.reference_direct_use_allowed,
               NEW.reference_review_decision_id, NEW.reference_reviewed_at
           ) THEN
            RAISE EXCEPTION 'campaign template reference content and provenance are immutable'
                USING ERRCODE = '55000';
        END IF;
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER campaign_template_reference_row_immutable
    BEFORE UPDATE OR DELETE ON campaign_templates
    FOR EACH ROW EXECUTE FUNCTION prevent_campaign_template_reference_row_mutation();

-- Import refreshes may change only external-source provenance and invalidate
-- all earlier rights. Review/kind/license/lineage claims are fixed here rather
-- than accepted as function arguments.
CREATE OR REPLACE FUNCTION campaign_template_refresh_reference_metadata(
    p_tenant_id uuid,
    p_template_id uuid,
    p_source_provider text,
    p_source_external_id text,
    p_source_url text,
    p_source_brand text,
    p_thumbnail_url text,
    p_source_captured_at timestamptz,
    p_source_metadata jsonb,
    p_industry text,
    p_style text,
    p_layout text,
    p_design_metadata jsonb,
    p_quality_score numeric,
    p_content_hash text,
    p_imported_at timestamptz
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
    IF p_tenant_id IS NULL
       OR p_tenant_id IS DISTINCT FROM
          NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid THEN
        RAISE EXCEPTION 'campaign template import tenant scope mismatch'
            USING ERRCODE = '42501';
    END IF;
    IF btrim(COALESCE(p_source_provider, '')) = ''
       OR lower(btrim(p_source_provider)) = 'postwave'
       OR btrim(COALESCE(p_source_external_id, '')) = '' THEN
        RAISE EXCEPTION 'campaign template import requires an external source identity'
            USING ERRCODE = '22023';
    END IF;

    UPDATE public.campaign_templates AS template
       SET template_kind = 'reference',
           source_provider = lower(btrim(p_source_provider)),
           source_external_id = btrim(p_source_external_id),
           source_url = btrim(COALESCE(p_source_url, '')),
           source_brand = btrim(COALESCE(p_source_brand, '')),
           thumbnail_url = btrim(COALESCE(p_thumbnail_url, '')),
           source_captured_at = p_source_captured_at,
           source_license_status = 'personal-use-unreviewed',
           source_metadata = COALESCE(p_source_metadata, '{}'::jsonb),
           industry = btrim(COALESCE(p_industry, '')),
           style = btrim(COALESCE(p_style, '')),
           layout = btrim(COALESCE(p_layout, '')),
           design_metadata = COALESCE(p_design_metadata, '{}'::jsonb),
           review_status = 'pending',
           quality_score = p_quality_score,
           content_hash = btrim(COALESCE(p_content_hash, '')),
           imported_at = COALESCE(p_imported_at, clock_timestamp()),
           reference_template_ids = '{}'::uuid[],
           generation_metadata = '{}'::jsonb,
           reference_adaptation_allowed = false,
           reference_direct_use_allowed = false,
           reference_review_decision_id = NULL,
           reference_reviewed_at = NULL
     WHERE template.tenant_id = p_tenant_id
       AND template.id = p_template_id
       AND template.template_kind = 'reference';
    RETURN FOUND;
END;
$function$;

-- Content refresh is independently invalidating so a review raced between the
-- metadata and content phases cannot survive. imported_at is advanced at the
-- final write, which also prevents a historical receipt being re-applied.
CREATE OR REPLACE FUNCTION campaign_template_refresh_reference_content(
    p_tenant_id uuid,
    p_template_id uuid,
    p_name text,
    p_description text,
    p_category text,
    p_subject text,
    p_preview_text text,
    p_body_html text,
    p_body_mjml text,
    p_variables jsonb,
    p_tags text[],
    p_goal text,
    p_industry text,
    p_style text,
    p_layout text,
    p_thumbnail_url text,
    p_design_metadata jsonb
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
    IF p_tenant_id IS NULL
       OR p_tenant_id IS DISTINCT FROM
          NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid THEN
        RAISE EXCEPTION 'campaign template import tenant scope mismatch'
            USING ERRCODE = '42501';
    END IF;

    UPDATE public.campaign_templates AS template
       SET name = btrim(p_name),
           description = NULLIF(btrim(COALESCE(p_description, '')), ''),
           category = NULLIF(btrim(COALESCE(p_category, '')), ''),
           subject = COALESCE(p_subject, ''),
           preview_text = COALESCE(p_preview_text, ''),
           body_html = COALESCE(p_body_html, ''),
           body_mjml = COALESCE(p_body_mjml, ''),
           variables = COALESCE(p_variables, '[]'::jsonb),
           tags = COALESCE(p_tags, '{}'::text[]),
           goal = NULLIF(btrim(COALESCE(p_goal, '')), ''),
           industry = btrim(COALESCE(p_industry, '')),
           style = btrim(COALESCE(p_style, '')),
           layout = btrim(COALESCE(p_layout, '')),
           thumbnail_url = btrim(COALESCE(p_thumbnail_url, '')),
           design_metadata = COALESCE(p_design_metadata, '{}'::jsonb),
           source_license_status = 'personal-use-unreviewed',
           review_status = 'pending',
           imported_at = clock_timestamp(),
           reference_adaptation_allowed = false,
           reference_direct_use_allowed = false,
           reference_review_decision_id = NULL,
           reference_reviewed_at = NULL
     WHERE template.tenant_id = p_tenant_id
       AND template.id = p_template_id
       AND template.template_kind = 'reference';
    RETURN FOUND;
END;
$function$;

-- Applying a receipt is deliberately narrower than an arbitrary UPDATE. The
-- evidence must still describe the current source state and must be newer than
-- the last row mutation, so an import refresh permanently invalidates it.
CREATE OR REPLACE FUNCTION campaign_template_apply_reference_review(
    p_tenant_id uuid,
    p_template_id uuid,
    p_decision_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    affected integer;
BEGIN
    IF p_tenant_id IS NULL
       OR p_tenant_id IS DISTINCT FROM
          NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid THEN
        RAISE EXCEPTION 'campaign template review tenant scope mismatch'
            USING ERRCODE = '42501';
    END IF;

    UPDATE public.campaign_templates AS template
       SET review_status =
               CASE decision.decision WHEN 'approve' THEN 'approved' ELSE 'rejected' END,
           reference_adaptation_allowed = decision.adaptation_allowed,
           reference_direct_use_allowed = decision.direct_use_allowed,
           reference_review_decision_id = decision.id,
           reference_reviewed_at = decision.created_at
      FROM public.campaign_template_reference_review_decisions AS decision
     WHERE template.tenant_id = p_tenant_id
       AND template.id = p_template_id
       AND template.template_kind = 'reference'
       AND decision.tenant_id = p_tenant_id
       AND decision.template_id = template.id
       AND decision.id = p_decision_id
       AND decision.source_content_hash IS NOT DISTINCT FROM template.content_hash
       AND decision.source_license_status IS NOT DISTINCT FROM template.source_license_status
       AND decision.created_at >= template.updated_at
       AND decision.created_at >= COALESCE(template.imported_at, '-infinity'::timestamptz);
    GET DIAGNOSTICS affected = ROW_COUNT;
    RETURN affected = 1;
END;
$function$;

REVOKE ALL ON FUNCTION campaign_template_refresh_reference_metadata(
    uuid, uuid, text, text, text, text, text, timestamptz, jsonb,
    text, text, text, jsonb, numeric, text, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION campaign_template_refresh_reference_content(
    uuid, uuid, text, text, text, text, text, text, text, jsonb,
    text[], text, text, text, text, text, jsonb
) FROM PUBLIC;
REVOKE ALL ON FUNCTION campaign_template_apply_reference_review(uuid, uuid, uuid)
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION campaign_template_refresh_reference_metadata(
    uuid, uuid, text, text, text, text, text, timestamptz, jsonb,
    text, text, text, jsonb, numeric, text, timestamptz
) TO postwave_app;
GRANT EXECUTE ON FUNCTION campaign_template_refresh_reference_content(
    uuid, uuid, text, text, text, text, text, text, text, jsonb,
    text[], text, text, text, text, text, jsonb
) TO postwave_app;
GRANT EXECUTE ON FUNCTION campaign_template_apply_reference_review(uuid, uuid, uuid)
    TO postwave_app;

GRANT SELECT, INSERT ON campaign_template_reference_review_decisions TO postwave_app;

ALTER TABLE campaign_template_reference_review_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_template_reference_review_decisions FORCE ROW LEVEL SECURITY;

CREATE POLICY campaign_template_reference_review_tenant_isolation
    ON campaign_template_reference_review_decisions
    FOR ALL
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

CREATE INDEX campaign_template_reference_reviews_template_created_idx
    ON campaign_template_reference_review_decisions
       (tenant_id, template_id, created_at DESC, id DESC);

COMMIT;
