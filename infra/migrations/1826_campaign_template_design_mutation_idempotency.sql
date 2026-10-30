-- 1826_campaign_template_design_mutation_idempotency.sql
--
-- The design create operation was already idempotent, but follow-up actions
-- only required an Idempotency-Key at the HTTP edge without persisting it.
-- This ledger makes ambiguous retries of refine, retry, save, campaign
-- creation, and archive deterministic and rejects reuse with different input.
--
-- rollback-strategy: no-op
-- rollback-details: the ledger is operational/audit evidence. Older binaries
-- ignore it safely; retain the rows across an application rollback.

BEGIN;

CREATE TABLE campaign_template_design_mutations (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    draft_id              uuid NOT NULL
                              REFERENCES campaign_template_design_drafts(id)
                              ON DELETE CASCADE,
    operation             text NOT NULL
                              CHECK (operation IN (
                                  'refine', 'retry', 'save',
                                  'create_campaign', 'archive'
                              )),
    idempotency_key_hash  bytea NOT NULL
                              CHECK (octet_length(idempotency_key_hash) = 32),
    request_hash          bytea NOT NULL
                              CHECK (octet_length(request_hash) = 32),
    created_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT campaign_template_design_mutations_tenant_key_uniq
        UNIQUE (tenant_id, idempotency_key_hash)
);

CREATE INDEX campaign_template_design_mutations_draft_created_idx
    ON campaign_template_design_mutations
       (tenant_id, draft_id, created_at DESC, id DESC);

GRANT SELECT, INSERT ON campaign_template_design_mutations TO postwave_app;

ALTER TABLE campaign_template_design_mutations ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_template_design_mutations FORCE ROW LEVEL SECURITY;

CREATE POLICY campaign_template_design_mutations_tenant_isolation
    ON campaign_template_design_mutations
    FOR ALL
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

CREATE OR REPLACE FUNCTION prevent_campaign_template_design_mutation_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'campaign template design mutation identities are immutable'
        USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER campaign_template_design_mutations_immutable
    BEFORE UPDATE OR DELETE ON campaign_template_design_mutations
    FOR EACH ROW
    EXECUTE FUNCTION prevent_campaign_template_design_mutation_change();

COMMENT ON TABLE campaign_template_design_mutations IS
    'Immutable request identities for retry-safe follow-up actions on durable campaign-template designs.';

COMMIT;
