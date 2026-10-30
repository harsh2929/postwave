-- 1748_campaign_template_reference_library.sql
--
-- Reference-aware visual campaign template library. External inspiration
-- records are deliberately distinguishable from Postwave-authored editable
-- templates so provenance, review state, and production licensing decisions
-- survive ingestion instead of being hidden in free-form tags.

BEGIN;

ALTER TABLE campaign_templates
    ADD COLUMN template_kind         text        NOT NULL DEFAULT 'editable',
    ADD COLUMN source_provider       text        NOT NULL DEFAULT 'postwave',
    ADD COLUMN source_external_id    text,
    ADD COLUMN source_url            text        NOT NULL DEFAULT '',
    ADD COLUMN source_brand          text        NOT NULL DEFAULT '',
    ADD COLUMN thumbnail_url         text        NOT NULL DEFAULT '',
    ADD COLUMN source_captured_at    timestamptz,
    ADD COLUMN source_license_status text        NOT NULL DEFAULT 'owned',
    ADD COLUMN source_metadata       jsonb       NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN industry              text        NOT NULL DEFAULT '',
    ADD COLUMN style                 text        NOT NULL DEFAULT '',
    ADD COLUMN layout                text        NOT NULL DEFAULT '',
    ADD COLUMN design_metadata       jsonb       NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN review_status         text        NOT NULL DEFAULT 'approved',
    ADD COLUMN quality_score         numeric(4,3) NOT NULL DEFAULT 0.500,
    ADD COLUMN content_hash          text        NOT NULL DEFAULT '',
    ADD COLUMN imported_at           timestamptz,
    ADD COLUMN reference_template_ids uuid[]     NOT NULL DEFAULT '{}'::uuid[],
    ADD COLUMN generation_metadata   jsonb       NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE campaign_templates
    ADD CONSTRAINT campaign_templates_kind_chk
        CHECK (template_kind IN ('editable', 'reference')),
    ADD CONSTRAINT campaign_templates_review_status_chk
        CHECK (review_status IN ('pending', 'approved', 'rejected')),
    ADD CONSTRAINT campaign_templates_quality_score_chk
        CHECK (quality_score >= 0 AND quality_score <= 1),
    ADD CONSTRAINT campaign_templates_source_pair_chk
        CHECK (
            (source_external_id IS NULL OR btrim(source_external_id) <> '')
            AND btrim(source_provider) <> ''
        );

-- Existing checked-in templates were authored by Postwave and remain editable.
UPDATE campaign_templates
   SET source_provider = 'postwave',
       source_license_status = 'owned',
       template_kind = 'editable',
       review_status = 'approved',
       quality_score = CASE WHEN is_featured THEN 0.900 ELSE 0.750 END
 WHERE source_provider = 'postwave';

-- Drafts created from the catalog retain enough lineage for analytics and for
-- a future source-rights audit. reference_template_ids captures the many-source
-- generation path while source_template_id is the primary selected template.
ALTER TABLE campaigns
    ADD COLUMN source_template_id uuid REFERENCES campaign_templates(id) ON DELETE SET NULL,
    ADD COLUMN source_template_updated_at timestamptz,
    ADD COLUMN reference_template_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
    ADD COLUMN template_variables jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMIT;

-- These relations already carry production traffic, so build every new index
-- outside the DDL transaction and without blocking reads/writes for the full
-- table scan.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS campaign_templates_platform_source_external_idx
    ON campaign_templates (source_provider, source_external_id)
    WHERE tenant_id IS NULL AND source_external_id IS NOT NULL;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS campaign_templates_tenant_source_external_idx
    ON campaign_templates (tenant_id, source_provider, source_external_id)
    WHERE tenant_id IS NOT NULL AND source_external_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_templates_catalog_facets_idx
    ON campaign_templates (template_kind, review_status, industry, style, layout);

CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_templates_quality_idx
    ON campaign_templates (quality_score DESC, usage_count DESC, created_at DESC)
    WHERE review_status = 'approved';

CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_templates_tags_gin_idx
    ON campaign_templates USING gin (tags);

CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_templates_reference_ids_gin_idx
    ON campaign_templates USING gin (reference_template_ids);

CREATE INDEX CONCURRENTLY IF NOT EXISTS campaigns_source_template_idx
    ON campaigns (tenant_id, source_template_id, created_at DESC)
    WHERE source_template_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS campaigns_reference_templates_gin_idx
    ON campaigns USING gin (reference_template_ids);
