-- 2036_deliverability_remediation_release_kinds.sql
--
-- Keep the Hub remediation episode in the same durable transaction as the
-- override/cap release without inventing recovery evidence for a human clear.
-- Automatic release names the exact snapshot and score that crossed the
-- sustained recovery threshold; manual release is explicitly discriminated
-- and intentionally leaves those two evidence columns NULL.
--
-- rollback-strategy: no-op. Removing release_kind would make manual clears
-- indistinguishable from incomplete automatic episodes and would reintroduce
-- false attribution.
--
-- DEPLOYMENT PRECONDITION (the schema cannot identify process generations):
--   1. Quiesce sending-cap PUT/repair admissions and Hub workers.
--   2. Hard-drain every pre-Route46 API/worker task; verify zero remain.
--   3. Apply 2034 and this migration while admissions remain quiesced.
--   4. Start only the homogeneous Route46 task set, then reopen admissions
--      after PostgreSQL receipts and the Redis cap authority are healthy.
-- A rolling old/new overlap is forbidden. Old tasks do not participate in the
-- cap fence and can also recreate an orphan remediation after this one-time
-- reconciliation has run.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- Some pre-release environments may already have run the first 2034 draft.
-- Receipts are outcome evidence, not the cap-validation boundary, so accept
-- the exact legacy integer already stored in tenant_sending_settings.
ALTER TABLE tenant_sending_cap_mutation_receipts
    DROP CONSTRAINT IF EXISTS tenant_sending_cap_mutation_receipts_committed_cap_check;

ALTER TABLE deliverability_remediations
    ADD COLUMN IF NOT EXISTS release_kind text;

-- Before assigning a truthful discriminator, prove the historical snapshot
-- references carry the exact tenant/score and policy evidence claimed by the
-- remediation. The former cadence-reuse path could pair one replica's
-- canonical snapshot ID with another replica's computed score/qualification;
-- an ID-only foreign key cannot detect that corruption. Never relabel such a
-- row as automatic recovery: stop for exact operator reconciliation.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM deliverability_remediations AS remediation
          LEFT JOIN deliverability_hub_snapshots AS snapshot
            ON snapshot.id = remediation.applied_snapshot_id
         WHERE snapshot.id IS NULL
            OR snapshot.tenant_id IS DISTINCT FROM remediation.tenant_id
            OR snapshot.score IS DISTINCT FROM remediation.applied_score
            OR snapshot.sample_qualified IS DISTINCT FROM TRUE
            OR snapshot.model_version IS DISTINCT FROM 'campaign-cohort-v2-2026-08-02'
            OR snapshot.score >= 50
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'deliverability remediation has invalid automatic-apply snapshot evidence',
            HINT = 'Reconcile applied_snapshot_id/applied_score to the exact qualified current-model tenant snapshot below score 50 before retrying migration 2036.';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM deliverability_remediations AS remediation
          LEFT JOIN deliverability_hub_snapshots AS snapshot
            ON snapshot.id = remediation.released_snapshot_id
         WHERE remediation.released_at IS NOT NULL
           AND (
                snapshot.id IS NULL
                OR snapshot.tenant_id IS DISTINCT FROM remediation.tenant_id
                OR snapshot.score IS DISTINCT FROM remediation.released_score
                OR snapshot.sample_qualified IS DISTINCT FROM TRUE
                OR snapshot.model_version IS DISTINCT FROM 'campaign-cohort-v2-2026-08-02'
                OR snapshot.score < 65
           )
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'deliverability remediation has invalid automatic-release snapshot evidence',
            HINT = 'Reconcile released_snapshot_id/released_score to the exact qualified current-model tenant snapshot at or above score 65 before retrying migration 2036.';
    END IF;
END $$;

-- Every historical complete release was produced by the former automatic
-- recovery path, whose existing constraint already required snapshot+score.
UPDATE deliverability_remediations
   SET release_kind = 'automatic_recovery'
 WHERE released_at IS NOT NULL
   AND release_kind IS NULL;

ALTER TABLE deliverability_remediations
    DROP CONSTRAINT IF EXISTS deliverability_remediations_release_complete;

-- Early remediation rows can predate override_id attribution. Tenant-level
-- uniqueness does NOT prove that an old open row belongs to the tenant's
-- current active override: a former orphan can survive while a later apply
-- reuses the one-open slot. Never infer episode identity from tenant alone;
-- the preflight below stops on NULL/mismatched attribution for exact operator
-- reconciliation.

-- The former manual path cleared the linked override/cap but never closed its
-- remediation. cleared_by is always explicit; the automatic worker uses one
-- reserved label, so every other non-null value is truthful manual evidence.
UPDATE deliverability_remediations AS remediation
   SET released_at = override_row.cleared_at,
       release_kind = 'manual_clear',
       released_snapshot_id = NULL,
       released_score = NULL
  FROM deliverability_repair_overrides AS override_row
 WHERE remediation.tenant_id = override_row.tenant_id
   AND remediation.override_id = override_row.id
   AND remediation.released_at IS NULL
   AND override_row.cleared_at IS NOT NULL
   AND override_row.cleared_by IS NOT NULL
   AND override_row.cleared_by <> 'auto: reputation_recovered';

-- A failed old post-commit automatic annotation has no durable pointer to the
-- exact recovery snapshot. Do not guess from a nearby timestamp or fabricate
-- a score. Stop deployment until an operator identifies and records the exact
-- release evidence; otherwise the open-row uniqueness slot would silently
-- suppress the next episode.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM deliverability_remediations AS remediation
         WHERE remediation.released_at IS NULL
           AND NOT EXISTS (
               SELECT 1
                 FROM deliverability_repair_overrides AS override_row
                WHERE override_row.tenant_id = remediation.tenant_id
                  AND override_row.id = remediation.override_id
                  AND override_row.cleared_at IS NULL
           )
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'unresolved or unattributed deliverability remediation requires exact operator reconciliation',
            HINT = 'Attach the exact override identity, or for automatic recovery set the exact released_snapshot_id, released_score, and released_at, before retrying migration 2036; never infer episode identity from tenant alone.';
    END IF;
END $$;

-- Enforce the inverse lifecycle cardinality too: an active override without
-- its exact open episode predates trustworthy
-- lifecycle attribution (or was created by a broken writer). There is no
-- truthful applied snapshot/score to invent here. Refuse the migration until
-- an operator either attaches the exact evidence or explicitly reconciles the
-- override and cap.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM deliverability_repair_overrides AS override_row
         WHERE override_row.cleared_at IS NULL
           AND NOT EXISTS (
               SELECT 1
                 FROM deliverability_remediations AS remediation
                WHERE remediation.tenant_id = override_row.tenant_id
                  AND remediation.override_id = override_row.id
                  AND remediation.released_at IS NULL
           )
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'active deliverability override is missing its exact open remediation episode',
            HINT = 'Attach the exact applied snapshot/score to an open remediation or explicitly reconcile the override and sending cap before retrying migration 2036.';
    END IF;
END $$;

-- The active override must still own the exact cap it installed. New runtime
-- correctly refuses both a stale-baseline clear and a settings PUT that would
-- steal ownership, so shipping a legacy drifted row would otherwise make the
-- episode permanently uncleareable through supported APIs.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM deliverability_repair_overrides AS override_row
          LEFT JOIN tenant_sending_settings AS settings
            ON settings.tenant_id = override_row.tenant_id
         WHERE override_row.cleared_at IS NULL
           AND settings.max_sends_per_hour IS DISTINCT FROM
               override_row.throttled_max_sends_per_hour
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'active deliverability override no longer owns its installed sending cap',
            HINT = 'Reconcile the tenant sending cap to throttled_max_sends_per_hour, or explicitly close the override and exact remediation episode, before retrying migration 2036.';
    END IF;
END $$;

ALTER TABLE deliverability_remediations
    ADD CONSTRAINT deliverability_remediations_release_complete CHECK (
        (
            released_at IS NULL
            AND release_kind IS NULL
            AND released_snapshot_id IS NULL
            AND released_score IS NULL
        )
        OR (
            released_at IS NOT NULL
            AND release_kind = 'automatic_recovery'
            AND released_snapshot_id IS NOT NULL
            AND released_score IS NOT NULL
        )
        OR (
            released_at IS NOT NULL
            AND release_kind = 'manual_clear'
            AND released_snapshot_id IS NULL
            AND released_score IS NULL
        )
        OR (
            -- Defensive decoding for an old automatic annotation already in
            -- flight at the hard-drain boundary. This does NOT authorize a
            -- rolling old/new overlap; see the deployment precondition above.
            -- A later contract migration must backfill any residual row and
            -- remove this compatibility branch.
            released_at IS NOT NULL
            AND release_kind IS NULL
            AND released_snapshot_id IS NOT NULL
            AND released_score IS NOT NULL
        )
    );

ALTER TABLE deliverability_remediations
    ADD CONSTRAINT deliverability_remediations_release_kind_known CHECK (
        release_kind IS NULL
        OR release_kind IN ('automatic_recovery', 'manual_clear')
    );

COMMENT ON COLUMN deliverability_remediations.release_kind IS
    'automatic_recovery requires the exact release snapshot/score; '
    'manual_clear intentionally has neither and is attributed through the linked override/audit row.';

COMMIT;
