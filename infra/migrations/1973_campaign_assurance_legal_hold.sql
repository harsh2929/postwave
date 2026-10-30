-- 1973_campaign_assurance_legal_hold.sql
--
-- Legal hold for Campaign Assurance evidence.
--
-- Retention sweeps delete assurance evidence on schedule: raster and OCR
-- evidence when `expires_at` passes, raw model output when
-- `raw_output_expires_at` passes, seed MIME on its own clock. That is correct
-- until someone has to preserve it — a regulator request, litigation, a
-- disputed send. This adds the ledger that suspends those sweeps, and the one
-- predicate every sweep must call.
--
-- WHY ONE SQL FUNCTION RATHER THAN A COLUMN PER TABLE
--
-- The repo's existing legal-hold idiom (0271_audit_retention) is a `legal_hold`
-- boolean on the retained table. That works when the hold is placed on a row.
-- Here the hold is placed on a CAMPAIGN or a TENANT, before anyone knows which
-- rows will exist — evidence written after the hold has to be covered too. A
-- per-row flag cannot express that without a backfill on every write.
--
-- One STABLE function also means the predicate has a single definition. The
-- failure mode of copying it into four sweeps is that three get updated and the
-- fourth keeps deleting, which nobody notices until the evidence is asked for.
--
-- WHY A NULL CAMPAIGN ARGUMENT MEANS "ANY HOLD FOR THIS TENANT"
--
-- campaign_image_raster_evidence and campaign_image_ocr_cache_entries are keyed
-- by content hash and carry NO campaign column — a raster is deduplicated
-- across campaigns by design. A sweep over them therefore cannot prove a given
-- row does not belong to the held campaign. Passing NULL asks "is anything held
-- for this tenant", and the answer suspends the sweep for that tenant. That is
-- deliberately conservative: over-retaining evidence is recoverable, deleting
-- evidence under hold is not.

BEGIN;

CREATE TABLE IF NOT EXISTS campaign_assurance_legal_holds (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    -- NULL means the whole tenant. A campaign-scoped hold names one campaign;
    -- there is no FK to campaigns because a hold must survive the campaign row
    -- being removed — that is exactly when the evidence matters most.
    campaign_id         uuid,

    reason              text NOT NULL CHECK (
                            length(btrim(reason)) BETWEEN 1 AND 2000
                        ),
    placed_by_user_id   uuid,
    placed_at           timestamptz NOT NULL DEFAULT now(),

    released_at         timestamptz,
    released_by_user_id uuid,
    release_reason      text CHECK (
                            release_reason IS NULL
                            OR length(btrim(release_reason)) BETWEEN 1 AND 2000
                        ),

    -- A release must be explicable. Recording the timestamp without the reason
    -- leaves the audit question ("why did preservation stop?") unanswerable.
    CONSTRAINT campaign_assurance_legal_holds_release_shape CHECK (
        (released_at IS NULL AND release_reason IS NULL)
        OR (released_at IS NOT NULL AND release_reason IS NOT NULL)
    ),
    CONSTRAINT campaign_assurance_legal_holds_release_order CHECK (
        released_at IS NULL OR released_at >= placed_at
    )
);

-- One ACTIVE hold per scope. Two would make release ambiguous: releasing the
-- one an operator can see would leave the evidence held by one they cannot,
-- and the sweep would stay suspended for reasons nobody can find.
CREATE UNIQUE INDEX IF NOT EXISTS campaign_assurance_legal_holds_active_campaign_key
    ON campaign_assurance_legal_holds (tenant_id, campaign_id)
    WHERE released_at IS NULL AND campaign_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS campaign_assurance_legal_holds_active_tenant_key
    ON campaign_assurance_legal_holds (tenant_id)
    WHERE released_at IS NULL AND campaign_id IS NULL;

-- The predicate's access path: sweeps call it per batch, so it must not scan.
CREATE INDEX IF NOT EXISTS campaign_assurance_legal_holds_active_lookup_idx
    ON campaign_assurance_legal_holds (tenant_id, campaign_id)
    WHERE released_at IS NULL;

ALTER TABLE campaign_assurance_legal_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_assurance_legal_holds FORCE ROW LEVEL SECURITY;

CREATE POLICY campaign_assurance_legal_holds_tenant_select
    ON campaign_assurance_legal_holds
    FOR SELECT TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY campaign_assurance_legal_holds_tenant_insert
    ON campaign_assurance_legal_holds
    FOR INSERT TO postwave_app
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Retention sweeps run under db.WithWorkerScope, which sets app.outbox_worker
-- and NOT app.tenant_id — they operate across tenants by design. Without this
-- policy the tenant SELECT above matches nothing for them, the predicate
-- returns false for every row, and the sweeps delete evidence that is under
-- hold while the ledger still shows the hold as active.
--
-- That is a fail-OPEN default and the single most dangerous shape this feature
-- could take, so it is READ-ONLY and asserted by
-- TestTheSweepWorkerCanSeeHolds. A worker can see that a hold exists; it can
-- neither place nor release one.
CREATE POLICY campaign_assurance_legal_holds_worker_select
    ON campaign_assurance_legal_holds
    FOR SELECT TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true');

-- Release is an UPDATE, not a DELETE: the row is the evidence that evidence was
-- preserved. There is deliberately no DELETE policy for the application role.
CREATE POLICY campaign_assurance_legal_holds_tenant_release
    ON campaign_assurance_legal_holds
    FOR UPDATE TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON campaign_assurance_legal_holds TO postwave_app;

-- The single predicate. SECURITY INVOKER (the default) on purpose: it must see
-- exactly the rows its caller may see, so a sweep running as the application
-- role cannot be tricked into reading another tenant's holds — and a sweep with
-- no tenant GUC set reads nothing and therefore deletes nothing.
--
-- STABLE, not IMMUTABLE: the answer changes when a hold is placed or released.
CREATE OR REPLACE FUNCTION campaign_assurance_legal_hold_active(
    p_tenant_id uuid,
    p_campaign_id uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM campaign_assurance_legal_holds h
         WHERE h.tenant_id = p_tenant_id
           AND h.released_at IS NULL
           -- A NULL campaign argument asks "is ANYTHING held for this tenant",
           -- which is what un-attributable evidence (content-addressed rasters,
           -- the OCR cache) has to ask. A named campaign matches a tenant-wide
           -- hold or its own campaign-scoped hold.
           AND (
                p_campaign_id IS NULL
                OR h.campaign_id IS NULL
                OR h.campaign_id = p_campaign_id
           )
    );
$$;

GRANT EXECUTE ON FUNCTION campaign_assurance_legal_hold_active(uuid, uuid) TO postwave_app;

COMMENT ON TABLE campaign_assurance_legal_holds IS
    'Suspends Campaign Assurance retention sweeps for a tenant or one campaign. Released holds are retained: the row is the record that evidence was preserved.';

COMMIT;
