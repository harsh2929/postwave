-- 1823_campaign_template_design_drafts.sql
--
-- Durable, revision-bound newsletter design work. Generation and adaptation
-- are asynchronous jobs; every successful output is immutable and addressed
-- by (draft_id, revision, output_hash). Saving a template or creating a
-- campaign can therefore use exactly what a human or MCP client reviewed
-- without accepting caller-supplied HTML at the commit boundary.

BEGIN;

CREATE TABLE campaign_template_design_drafts (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    mode                     text NOT NULL CHECK (mode IN ('adapt', 'generate')),
    status                   text NOT NULL DEFAULT 'queued'
                                 CHECK (status IN (
                                     'queued', 'generating', 'ready', 'failed',
                                     'saved', 'campaign_created', 'archived'
                                 )),
    source_template_id       uuid REFERENCES campaign_templates(id) ON DELETE RESTRICT,
    reference_template_ids   uuid[] NOT NULL DEFAULT '{}'::uuid[]
                                 CHECK (cardinality(reference_template_ids) <= 3),
    request_payload          jsonb NOT NULL DEFAULT '{}'::jsonb
                                 CHECK (jsonb_typeof(request_payload) = 'object'),
    request_hash             bytea NOT NULL CHECK (octet_length(request_hash) = 32),
    idempotency_key_hash     bytea CHECK (
                                 idempotency_key_hash IS NULL
                                 OR octet_length(idempotency_key_hash) = 32
                             ),
    actor_type               text NOT NULL DEFAULT 'user'
                                 CHECK (actor_type IN ('user', 'api_key', 'service')),
    actor_id                 text NOT NULL DEFAULT ''
                                 CHECK (char_length(actor_id) <= 512),
    current_revision         integer NOT NULL DEFAULT 0 CHECK (current_revision >= 0),
    pending_operation        text NOT NULL DEFAULT 'initial'
                                 CHECK (pending_operation IN ('initial', 'refine', 'repair')),
    pending_payload          jsonb NOT NULL DEFAULT '{}'::jsonb
                                 CHECK (jsonb_typeof(pending_payload) = 'object'),
    pending_base_revision    integer CHECK (
                                 pending_base_revision IS NULL
                                 OR pending_base_revision >= 1
                             ),
    attempt_count            integer NOT NULL DEFAULT 0
                                 CHECK (attempt_count BETWEEN 0 AND 20),
    next_attempt_at          timestamptz NOT NULL DEFAULT now(),
    claim_token              uuid,
    lease_expires_at         timestamptz,
    last_error_code          text NOT NULL DEFAULT '',
    last_error_message       text NOT NULL DEFAULT '',
    saved_template_id        uuid REFERENCES campaign_templates(id) ON DELETE SET NULL,
    saved_revision           integer CHECK (saved_revision IS NULL OR saved_revision >= 1),
    created_campaign_id      uuid REFERENCES campaigns(id) ON DELETE SET NULL,
    campaign_revision        integer CHECK (campaign_revision IS NULL OR campaign_revision >= 1),
    expires_at               timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT campaign_template_design_source_mode_chk CHECK (
        (mode = 'adapt' AND source_template_id IS NOT NULL)
        OR (mode = 'generate')
    ),
    CONSTRAINT campaign_template_design_lease_chk CHECK (
        (claim_token IS NULL AND lease_expires_at IS NULL)
        OR (claim_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    ),
    CONSTRAINT campaign_template_design_saved_pair_chk CHECK (
        (saved_template_id IS NULL AND saved_revision IS NULL)
        OR (saved_template_id IS NOT NULL AND saved_revision IS NOT NULL)
    ),
    CONSTRAINT campaign_template_design_campaign_pair_chk CHECK (
        (created_campaign_id IS NULL AND campaign_revision IS NULL)
        OR (created_campaign_id IS NOT NULL AND campaign_revision IS NOT NULL)
    ),
    CONSTRAINT campaign_template_design_expiry_chk CHECK (expires_at > created_at)
);

CREATE TABLE campaign_template_design_revisions (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    draft_id                 uuid NOT NULL
                                 REFERENCES campaign_template_design_drafts(id)
                                 ON DELETE CASCADE,
    revision                 integer NOT NULL CHECK (revision >= 1),
    operation                text NOT NULL
                                 CHECK (operation IN ('initial', 'refine', 'repair')),
    base_revision            integer CHECK (base_revision IS NULL OR base_revision >= 1),
    output                   jsonb NOT NULL CHECK (jsonb_typeof(output) = 'object'),
    output_hash              text NOT NULL
                                 CHECK (output_hash ~ '^[0-9a-f]{64}$'),
    validation               jsonb NOT NULL DEFAULT '{}'::jsonb
                                 CHECK (jsonb_typeof(validation) = 'object'),
    warnings                 jsonb NOT NULL DEFAULT '[]'::jsonb
                                 CHECK (jsonb_typeof(warnings) = 'array'),
    created_at               timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, draft_id, revision),
    CONSTRAINT campaign_template_design_revision_base_chk CHECK (
        (revision = 1 AND base_revision IS NULL)
        OR (revision > 1 AND base_revision IS NOT NULL AND base_revision < revision)
    )
);

ALTER TABLE campaigns
    ADD COLUMN source_template_design_draft_id uuid
        REFERENCES campaign_template_design_drafts(id) ON DELETE SET NULL,
    ADD COLUMN source_template_design_revision integer,
    ADD COLUMN source_template_design_output_hash text,
    ADD CONSTRAINT campaigns_template_design_lineage_chk CHECK (
        (
            source_template_design_draft_id IS NULL
            AND source_template_design_revision IS NULL
            AND source_template_design_output_hash IS NULL
        )
        OR (
            source_template_design_draft_id IS NOT NULL
            AND source_template_design_revision >= 1
            AND source_template_design_output_hash ~ '^[0-9a-f]{64}$'
        )
    );

-- campaigns already carries production writes. Build the lineage uniqueness
-- guard without blocking writers for the full index scan; the phased
-- migration runner records this retry-safe step.
COMMIT;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
    campaigns_template_design_once_idx
    ON campaigns (tenant_id, source_template_design_draft_id)
    WHERE source_template_design_draft_id IS NOT NULL;

BEGIN;

CREATE TRIGGER campaign_template_design_drafts_set_updated_at
    BEFORE UPDATE ON campaign_template_design_drafts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION prevent_campaign_template_design_revision_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'campaign template design revisions are immutable'
        USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER campaign_template_design_revisions_immutable
    BEFORE UPDATE ON campaign_template_design_revisions
    FOR EACH ROW EXECUTE FUNCTION prevent_campaign_template_design_revision_update();

CREATE UNIQUE INDEX campaign_template_design_idempotency_idx
    ON campaign_template_design_drafts (tenant_id, idempotency_key_hash)
    WHERE idempotency_key_hash IS NOT NULL;

CREATE INDEX campaign_template_design_queue_idx
    ON campaign_template_design_drafts (next_attempt_at, created_at, id)
    WHERE status = 'queued';

CREATE INDEX campaign_template_design_expiry_idx
    ON campaign_template_design_drafts (expires_at, id)
    WHERE status <> 'archived';

CREATE INDEX campaign_template_design_revisions_latest_idx
    ON campaign_template_design_revisions (tenant_id, draft_id, revision DESC);

-- One reviewed draft may mint at most one saved template even when separate
-- clients race with different slugs or idempotency keys.
COMMIT;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
    campaign_templates_design_draft_once_idx
    ON campaign_templates (
        tenant_id,
        (generation_metadata ->> 'design_draft_id')
    )
    WHERE tenant_id IS NOT NULL
      AND btrim(generation_metadata ->> 'design_draft_id') <> '';

BEGIN;

GRANT SELECT, INSERT, UPDATE ON campaign_template_design_drafts TO postwave_app;
GRANT SELECT, INSERT ON campaign_template_design_revisions TO postwave_app;

ALTER TABLE campaign_template_design_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_template_design_drafts FORCE ROW LEVEL SECURITY;
ALTER TABLE campaign_template_design_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_template_design_revisions FORCE ROW LEVEL SECURITY;

CREATE POLICY campaign_template_design_drafts_tenant_isolation
    ON campaign_template_design_drafts
    FOR ALL
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

CREATE POLICY campaign_template_design_drafts_worker
    ON campaign_template_design_drafts
    FOR ALL
    USING (
        current_setting('app.outbox_worker', true) = 'true'
    )
    WITH CHECK (
        current_setting('app.outbox_worker', true) = 'true'
    );

CREATE POLICY campaign_template_design_revisions_tenant_isolation
    ON campaign_template_design_revisions
    FOR ALL
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

CREATE POLICY campaign_template_design_revisions_worker
    ON campaign_template_design_revisions
    FOR ALL
    USING (
        current_setting('app.outbox_worker', true) = 'true'
    )
    WITH CHECK (
        current_setting('app.outbox_worker', true) = 'true'
    );

COMMIT;
