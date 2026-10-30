-- 1833_campaign_template_atomic_reference_refresh.sql
--
-- Keep an imported reference's source body and its SHA-256 identity in one
-- database write. The former two-phase refresh could interleave concurrent
-- imports for the same source identity, leaving one request's content_hash
-- beside another request's body_html.
--
-- Invalid refresh payloads still revoke any earlier rights through the
-- deliberately narrow governance-demotion function. They do not change
-- content, provenance, or the content hash.
--
-- rollback-strategy: no-op
-- rollback-details: retain the atomic writer and revoked legacy grants.
-- Older binaries depend on the split writers and intentionally fail closed;
-- drain them before this migration or before rolling the application back.

BEGIN;

CREATE OR REPLACE FUNCTION campaign_template_refresh_reference_atomic(
    p_tenant_id uuid,
    p_template_id uuid,
    p_source_provider text,
    p_source_external_id text,
    p_source_url text,
    p_source_brand text,
    p_thumbnail_url text,
    p_source_captured_at timestamptz,
    p_source_metadata jsonb,
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
    p_design_metadata jsonb,
    p_quality_score numeric,
    p_content_hash text,
    p_imported_at timestamptz
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    expected_content_hash text;
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

    expected_content_hash :=
        'sha256:' || pg_catalog.encode(
            public.digest(
                pg_catalog.convert_to(COALESCE(p_body_html, ''), 'UTF8'),
                'sha256'
            ),
            'hex'
        );
    IF btrim(COALESCE(p_content_hash, '')) IS DISTINCT FROM
       expected_content_hash THEN
        RAISE EXCEPTION 'campaign template import content hash mismatch'
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
           name = btrim(p_name),
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
           design_metadata = COALESCE(p_design_metadata, '{}'::jsonb),
           review_status = 'pending',
           quality_score = p_quality_score,
           content_hash = expected_content_hash,
           imported_at = COALESCE(p_imported_at, clock_timestamp()),
           reference_template_ids = '{}'::uuid[],
           generation_metadata = '{}'::jsonb,
           reference_adaptation_allowed = false,
           reference_direct_use_allowed = false,
           reference_review_decision_id = NULL,
           reference_reviewed_at = NULL
     WHERE template.tenant_id = p_tenant_id
       AND template.id = p_template_id
       AND template.template_kind = 'reference'
       AND lower(btrim(template.source_provider)) =
           lower(btrim(p_source_provider))
       AND template.source_external_id = btrim(p_source_external_id);
    RETURN FOUND;
END;
$function$;

CREATE OR REPLACE FUNCTION campaign_template_demote_reference_governance(
    p_tenant_id uuid,
    p_template_id uuid,
    p_source_provider text,
    p_source_external_id text
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
           source_license_status = 'personal-use-unreviewed',
           review_status = 'pending',
           reference_template_ids = '{}'::uuid[],
           generation_metadata = '{}'::jsonb,
           reference_adaptation_allowed = false,
           reference_direct_use_allowed = false,
           reference_review_decision_id = NULL,
           reference_reviewed_at = NULL
     WHERE template.tenant_id = p_tenant_id
       AND template.id = p_template_id
       AND template.template_kind = 'reference'
       AND lower(btrim(template.source_provider)) =
           lower(btrim(p_source_provider))
       AND template.source_external_id = btrim(p_source_external_id);
    RETURN FOUND;
END;
$function$;

REVOKE ALL ON FUNCTION campaign_template_refresh_reference_atomic(
    uuid, uuid, text, text, text, text, text, timestamptz, jsonb,
    text, text, text, text, text, text, text, jsonb, text[], text,
    text, text, text, jsonb, numeric, text, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION campaign_template_demote_reference_governance(
    uuid, uuid, text, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION campaign_template_refresh_reference_atomic(
    uuid, uuid, text, text, text, text, text, timestamptz, jsonb,
    text, text, text, text, text, text, text, jsonb, text[], text,
    text, text, text, jsonb, numeric, text, timestamptz
) TO postwave_app;
GRANT EXECUTE ON FUNCTION campaign_template_demote_reference_governance(
    uuid, uuid, text, text
) TO postwave_app;

-- A mixed fleet must not be able to reintroduce the split write after the
-- atomic path is live. Old application instances fail closed until drained.
REVOKE EXECUTE ON FUNCTION campaign_template_refresh_reference_metadata(
    uuid, uuid, text, text, text, text, text, timestamptz, jsonb,
    text, text, text, jsonb, numeric, text, timestamptz
) FROM postwave_app;
REVOKE EXECUTE ON FUNCTION campaign_template_refresh_reference_content(
    uuid, uuid, text, text, text, text, text, text, text, jsonb,
    text[], text, text, text, text, text, jsonb
) FROM postwave_app;

COMMENT ON FUNCTION campaign_template_refresh_reference_atomic(
    uuid, uuid, text, text, text, text, text, timestamptz, jsonb,
    text, text, text, text, text, text, text, jsonb, text[], text,
    text, text, text, jsonb, numeric, text, timestamptz
) IS
    'Atomically refreshes imported reference content, provenance, governance, and the DB-verified SHA-256 body identity.';
COMMENT ON FUNCTION campaign_template_demote_reference_governance(
    uuid, uuid, text, text
) IS
    'Fail-closed rights demotion for a source-matched reference whose proposed import payload was rejected before refresh.';

COMMIT;
