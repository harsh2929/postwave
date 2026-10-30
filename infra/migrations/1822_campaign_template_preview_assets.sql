-- 1822_campaign_template_preview_assets.sql
--
-- Hosted campaign-template previews are fetched asynchronously from a narrow
-- provider allowlist, sanitized by the asset image boundary, and persisted
-- under content-addressed storage keys. Template/variant source state is kept
-- separate from the immutable shared blob so identical screenshots dedupe and
-- a later upstream 404 never removes the last known-good hosted preview.
-- migration-execution: phased
-- rollback-strategy: expand-contract
-- rollback-details: Additive tables are ignored by older releases. Keep hosted
-- blobs during application rollback; drop only after their storage retention
-- policy has safely removed unreferenced objects.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE campaign_template_preview_blobs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    content_sha256  text NOT NULL,
    storage_key     text NOT NULL,
    public_url      text NOT NULL,
    mime_type       text NOT NULL,
    width           integer NOT NULL,
    height          integer NOT NULL,
    size_bytes      bigint NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT campaign_preview_blobs_sha_chk
        CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT campaign_preview_blobs_storage_key_chk
        CHECK (char_length(storage_key) BETWEEN 1 AND 1024),
    CONSTRAINT campaign_preview_blobs_public_url_chk
        CHECK (char_length(public_url) BETWEEN 1 AND 4096),
    CONSTRAINT campaign_preview_blobs_mime_chk
        CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
    CONSTRAINT campaign_preview_blobs_dimensions_chk
        CHECK (
            width BETWEEN 1 AND 16384
            AND height BETWEEN 1 AND 16384
            AND width::bigint * height::bigint <= 40000000
        ),
    CONSTRAINT campaign_preview_blobs_size_chk
        CHECK (size_bytes BETWEEN 1 AND 10485760),
    CONSTRAINT campaign_preview_blobs_sha_uniq UNIQUE (content_sha256),
    CONSTRAINT campaign_preview_blobs_storage_uniq UNIQUE (storage_key)
);

CREATE TABLE campaign_template_preview_assets (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id         uuid NOT NULL
                            REFERENCES campaign_templates(id) ON DELETE CASCADE,
    variant             text NOT NULL,
    source_provider     text NOT NULL,
    source_url          text NOT NULL,
    source_provenance   jsonb NOT NULL DEFAULT '{}'::jsonb,
    blob_id             uuid
                            REFERENCES campaign_template_preview_blobs(id)
                            ON DELETE RESTRICT,
    status              text NOT NULL DEFAULT 'queued',
    attempts            integer NOT NULL DEFAULT 0,
    max_attempts        integer NOT NULL DEFAULT 6,
    next_attempt_at     timestamptz NOT NULL DEFAULT now(),
    last_attempt_at     timestamptz,
    last_error          text,
    lease_owner         text,
    lease_expires_at    timestamptz,
    source_last_seen_at timestamptz,
    source_missing_at   timestamptz,
    ready_at            timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT campaign_preview_assets_template_variant_uniq
        UNIQUE (template_id, variant),
    CONSTRAINT campaign_preview_assets_variant_chk
        CHECK (variant IN ('desktop', 'mobile', 'card')),
    CONSTRAINT campaign_preview_assets_provider_chk
        CHECK (source_provider = 'really_good_emails'),
    CONSTRAINT campaign_preview_assets_source_url_chk
        CHECK (
            char_length(source_url) BETWEEN 1 AND 4096
            AND source_url ~ '^https://'
        ),
    CONSTRAINT campaign_preview_assets_provenance_chk
        CHECK (jsonb_typeof(source_provenance) = 'object'),
    CONSTRAINT campaign_preview_assets_status_chk
        CHECK (status IN (
            'queued', 'fetching', 'retry', 'ready', 'source_missing', 'failed'
        )),
    CONSTRAINT campaign_preview_assets_attempts_chk
        CHECK (
            attempts >= 0
            AND max_attempts BETWEEN 1 AND 12
            AND attempts <= max_attempts
        ),
    CONSTRAINT campaign_preview_assets_error_chk
        CHECK (last_error IS NULL OR char_length(last_error) <= 2000),
    CONSTRAINT campaign_preview_assets_lease_chk
        CHECK (
            (
                status = 'fetching'
                AND NULLIF(btrim(lease_owner), '') IS NOT NULL
                AND lease_expires_at IS NOT NULL
            )
            OR (
                status <> 'fetching'
                AND lease_owner IS NULL
                AND lease_expires_at IS NULL
            )
        ),
    CONSTRAINT campaign_preview_assets_ready_chk
        CHECK (status <> 'ready' OR (blob_id IS NOT NULL AND ready_at IS NOT NULL))
);

CREATE TRIGGER campaign_template_preview_assets_set_updated_at
    BEFORE UPDATE ON campaign_template_preview_assets
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Once a good hosted blob exists, upstream disappearance or a failed refresh
-- may change source status but cannot erase the retained fallback.
CREATE OR REPLACE FUNCTION prevent_campaign_template_preview_blob_loss()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.blob_id IS NOT NULL AND NEW.blob_id IS NULL THEN
        RAISE EXCEPTION 'hosted campaign-template preview blobs are retained'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER campaign_template_preview_assets_retain_blob
    BEFORE UPDATE OF blob_id ON campaign_template_preview_assets
    FOR EACH ROW EXECUTE FUNCTION prevent_campaign_template_preview_blob_loss();

CREATE INDEX campaign_template_preview_assets_claim_idx
    ON campaign_template_preview_assets
       (next_attempt_at, lease_expires_at, created_at, id)
    WHERE status IN ('queued', 'retry', 'fetching');

CREATE INDEX campaign_template_preview_assets_blob_idx
    ON campaign_template_preview_assets (blob_id)
    WHERE blob_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE
    ON campaign_template_preview_blobs, campaign_template_preview_assets
    TO postwave_app;

ALTER TABLE campaign_template_preview_blobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_template_preview_blobs FORCE ROW LEVEL SECURITY;
ALTER TABLE campaign_template_preview_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_template_preview_assets FORCE ROW LEVEL SECURITY;

-- Hosted blob metadata is globally shared, but only a tenant-bound request or
-- the transaction-local worker scope may read it. No request path can mutate
-- blobs; inserts are reserved for the worker policy below.
CREATE POLICY campaign_preview_blobs_tenant_read
    ON campaign_template_preview_blobs
    FOR SELECT
    USING (
        NULLIF(current_setting('app.tenant_id', true), '') IS NOT NULL
    );

CREATE POLICY campaign_preview_blobs_worker
    ON campaign_template_preview_blobs
    FOR ALL
    USING (current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

-- Tenant reads mirror campaign_templates: platform templates are visible to
-- every bound tenant, while tenant-owned preview rows stay workspace-scoped.
CREATE POLICY campaign_preview_assets_tenant_read
    ON campaign_template_preview_assets
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1
              FROM campaign_templates AS template
             WHERE template.id = campaign_template_preview_assets.template_id
               AND (
                   template.tenant_id IS NULL
                   OR template.tenant_id =
                      NULLIF(current_setting('app.tenant_id', true), '')::uuid
               )
        )
    );

CREATE POLICY campaign_preview_assets_worker
    ON campaign_template_preview_assets
    FOR ALL
    USING (current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

COMMENT ON TABLE campaign_template_preview_blobs IS
    'Globally deduplicated, sanitized, content-addressed campaign-template preview images.';
COMMENT ON TABLE campaign_template_preview_assets IS
    'Per-template/variant preview source jobs retaining their last known-good hosted blob.';

COMMIT;
