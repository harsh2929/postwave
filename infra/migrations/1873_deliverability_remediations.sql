-- 1873_deliverability_remediations.sql
--
-- Record the automatic throttle decisions, and what triggered them.
--
-- `observeAndMaybeAutoThrottle` installs a repair override after a sustained low
-- score, and (since migration 1869) lifts it again after a sustained recovery.
-- Both happen with no human involved and nothing written down: an operator sees
-- their sending rate halve and later un-halve, and the only trace is a mutated
-- `deliverability_overrides` row that the release then clears. There is no way
-- to answer "when were we capped, why, and when did it lift" after the fact —
-- which is the question asked during exactly the incident the cap exists for.
--
-- FK'd to the triggering snapshot rather than copying the score, so the
-- justification cannot drift from the evidence: the row points at the exact
-- `deliverability_hub_snapshots` observation that crossed the threshold, with
-- its model_version, sample_size and qualification intact.
--
-- ONE ROW PER EPISODE, not per transition. `applied_at` and `released_at` are
-- columns on the same row because "capped from T1 to T2" is one fact about one
-- period; two rows would make an unfinished episode indistinguishable from a
-- missing release, and would need a join to answer the only question anyone
-- asks. `released_at IS NULL` means the cap is still on.

BEGIN;

CREATE TABLE IF NOT EXISTS deliverability_remediations (
    id                    bigserial   PRIMARY KEY,
    tenant_id             uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- The observation that crossed the entry threshold.
    applied_snapshot_id   bigint      NOT NULL REFERENCES deliverability_hub_snapshots(id) ON DELETE RESTRICT,
    applied_at            timestamptz NOT NULL DEFAULT now(),
    applied_score         integer     NOT NULL,
    -- The observation that cleared the recovery bar. NULL while capped.
    released_snapshot_id  bigint      REFERENCES deliverability_hub_snapshots(id) ON DELETE RESTRICT,
    released_at           timestamptz,
    released_score        integer,
    -- Which override this episode installed, so the record can be tied back to
    -- the cap that was actually in force.
    override_id           bigint,
    CONSTRAINT deliverability_remediations_release_complete CHECK (
        (released_at IS NULL AND released_snapshot_id IS NULL AND released_score IS NULL)
        OR (released_at IS NOT NULL AND released_snapshot_id IS NOT NULL AND released_score IS NOT NULL)
    )
);

-- One open episode per tenant. A second automatic cap while one is already in
-- force would mean the release path had lost track of the first, and silently
-- recording two is worse than refusing.
CREATE UNIQUE INDEX IF NOT EXISTS deliverability_remediations_open_idx
    ON deliverability_remediations (tenant_id)
 WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS deliverability_remediations_tenant_applied_idx
    ON deliverability_remediations (tenant_id, applied_at DESC);

COMMENT ON TABLE deliverability_remediations IS
    'Automatic sending-throttle episodes: when a tenant was capped for a '
    'sustained low deliverability score, and when the cap lifted. One row per '
    'episode; released_at IS NULL means still capped. FK''d to the snapshots '
    'that triggered each transition so the justification cannot drift from the '
    'evidence.';

ALTER TABLE deliverability_remediations ENABLE ROW LEVEL SECURITY;
ALTER TABLE deliverability_remediations FORCE ROW LEVEL SECURITY;

CREATE POLICY deliverability_remediations_tenant_isolation
    ON deliverability_remediations
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON deliverability_remediations TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE deliverability_remediations_id_seq TO postwave_app;

COMMIT;
