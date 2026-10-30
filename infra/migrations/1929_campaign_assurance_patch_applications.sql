-- 1929_campaign_assurance_patch_applications.sql
--
-- Applying a Campaign Assurance remediation is a content-authoring action,
-- never a mutation of the historical finding or certified artifact.  This
-- append-only ledger binds one deterministic typed patch to the immutable
-- source revision it was evaluated against and to the immutable revision that
-- resulted.  The application transaction also advances the mutable campaign
-- draft and marks the originating run stale.
--
-- rollback-strategy: no-op.  Application receipts are evidence for content
-- revisions already shown to customers and must survive application rollback.

BEGIN;

CREATE TABLE campaign_assurance_patch_applications (
    id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id                 uuid NOT NULL,
    run_id                      uuid NOT NULL,
    attempt_count               integer NOT NULL CHECK (attempt_count >= 1),
    finding_id                  uuid NOT NULL,
    request_id                  uuid NOT NULL,
    request_hash                text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    finding_receipt_hash        text NOT NULL CHECK (finding_receipt_hash ~ '^[0-9a-f]{64}$'),
    typed_patch_hash            text NOT NULL CHECK (typed_patch_hash ~ '^[0-9a-f]{64}$'),
    typed_patch_schema_version  integer NOT NULL CHECK (typed_patch_schema_version = 1),
    base_content_revision_id    uuid NOT NULL,
    created_content_revision_id uuid NOT NULL,
    actor_id                    uuid NOT NULL,
    campaign_updated_at         timestamptz NOT NULL,
    created_at                  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT campaign_assurance_patch_applications_campaign_fk
        FOREIGN KEY (tenant_id, campaign_id)
        REFERENCES campaigns (tenant_id, id)
        ON DELETE CASCADE,
    CONSTRAINT campaign_assurance_patch_applications_run_fk
        FOREIGN KEY (tenant_id, campaign_id, run_id)
        REFERENCES campaign_assurance_runs (tenant_id, campaign_id, id)
        ON DELETE CASCADE,
    CONSTRAINT campaign_assurance_patch_applications_finding_fk
        FOREIGN KEY (
            tenant_id, campaign_id, run_id, attempt_count, finding_id,
            finding_receipt_hash
        )
        REFERENCES campaign_assurance_findings (
            tenant_id, campaign_id, run_id, attempt_count, id, receipt_hash
        )
        ON DELETE CASCADE,
    CONSTRAINT campaign_assurance_patch_applications_base_revision_fk
        FOREIGN KEY (tenant_id, campaign_id, base_content_revision_id)
        REFERENCES campaign_content_revisions (tenant_id, campaign_id, id),
    CONSTRAINT campaign_assurance_patch_applications_created_revision_fk
        FOREIGN KEY (tenant_id, campaign_id, created_content_revision_id)
        REFERENCES campaign_content_revisions (tenant_id, campaign_id, id),
    CONSTRAINT campaign_assurance_patch_applications_revision_change_check
        CHECK (base_content_revision_id <> created_content_revision_id),

    UNIQUE (tenant_id, request_id),
    UNIQUE (tenant_id, finding_id),
    UNIQUE (tenant_id, id)
);

CREATE INDEX campaign_assurance_patch_applications_campaign_created_idx
    ON campaign_assurance_patch_applications (
        tenant_id, campaign_id, created_at DESC, id DESC
    );

-- A direct UPDATE or DELETE must never rewrite an application receipt.  A
-- parent campaign/tenant cascade remains possible; otherwise tenant deletion
-- would be blocked by the evidence guard itself.
CREATE OR REPLACE FUNCTION campaign_assurance_patch_applications_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NOT EXISTS (
            SELECT 1
              FROM public.campaign_assurance_runs AS runs
              JOIN public.campaign_assurance_findings AS findings
                ON findings.tenant_id = runs.tenant_id
               AND findings.campaign_id = runs.campaign_id
               AND findings.run_id = runs.id
               AND findings.attempt_count = NEW.attempt_count
               AND findings.id = NEW.finding_id
               AND findings.receipt_hash = NEW.finding_receipt_hash
             WHERE runs.tenant_id = NEW.tenant_id
               AND runs.campaign_id = NEW.campaign_id
               AND runs.id = NEW.run_id
               AND runs.content_revision_id = NEW.base_content_revision_id
               AND runs.attempt_count = NEW.attempt_count
               AND runs.state = 'stale'
               AND findings.source_class = 'deterministic'
               AND findings.typed_patch IS NOT NULL
               AND findings.typed_patch_schema_version = NEW.typed_patch_schema_version
               AND findings.typed_patch_hash = NEW.typed_patch_hash
        ) THEN
            RAISE EXCEPTION 'patch application does not match an exact stale deterministic finding'
                USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' AND NOT EXISTS (
        SELECT 1
          FROM public.campaigns
         WHERE tenant_id = OLD.tenant_id AND id = OLD.campaign_id
    ) THEN
        RETURN OLD;
    END IF;

    RAISE EXCEPTION 'campaign assurance patch applications are immutable'
        USING ERRCODE = '55000';
END;
$fn$;

CREATE TRIGGER campaign_assurance_patch_applications_immutable
    BEFORE INSERT OR UPDATE OR DELETE ON campaign_assurance_patch_applications
    FOR EACH ROW EXECUTE FUNCTION campaign_assurance_patch_applications_guard();

ALTER TABLE campaign_assurance_patch_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_assurance_patch_applications FORCE ROW LEVEL SECURITY;

CREATE POLICY campaign_assurance_patch_applications_scope_boundary
    ON campaign_assurance_patch_applications
    AS RESTRICTIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY campaign_assurance_patch_applications_tenant_select
    ON campaign_assurance_patch_applications
    FOR SELECT TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY campaign_assurance_patch_applications_principal_insert
    ON campaign_assurance_patch_applications
    FOR INSERT TO postwave_app
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND actor_id = NULLIF(current_setting('app.user_id', true), '')::uuid
        AND EXISTS (
            SELECT 1
              FROM users
             WHERE users.tenant_id = campaign_assurance_patch_applications.tenant_id
               AND users.id = campaign_assurance_patch_applications.actor_id
               AND users.role IN ('owner', 'admin', 'editor')
        )
    );

GRANT SELECT, INSERT ON campaign_assurance_patch_applications TO postwave_app;
REVOKE UPDATE, DELETE, TRUNCATE ON campaign_assurance_patch_applications FROM postwave_app;

COMMENT ON TABLE campaign_assurance_patch_applications IS
    'Append-only audit receipts for exact deterministic assurance patches applied to mutable drafts and frozen as new immutable revisions.';

COMMIT;
