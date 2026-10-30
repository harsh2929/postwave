-- 1877_campaign_edit_leases.sql
--
-- One writer at a time on a campaign being edited.
--
-- The row this closes pairs "single-writer editing leases" with the approval
-- fingerprint, and they answer different questions. The fingerprint DETECTS a
-- change after the fact — it tells the send gate that what is about to go out
-- is not what was approved. Optimistic concurrency (If-Match on
-- `campaigns.version`) detects a collision at write time. Both are after two
-- people have already done the work, and one of them is about to lose it.
--
-- A lease prevents the second person starting. That is a different and cheaper
-- kind of correct: nobody spends twenty minutes rewriting a subject line that
-- is going to be discarded.
--
-- WHY A TTL AND NOT A LOCK. A held lease with no expiry is a campaign nobody
-- can edit after someone closes their laptop, and the only cure is an admin.
-- Every lease expires; the holder renews while they are actually editing. The
-- failure mode of a TTL is a rare double-edit at the boundary, which the
-- fingerprint and If-Match both still catch — the layers are complementary, so
-- this one is allowed to be soft.
--
-- ONE ROW PER CAMPAIGN, by primary key. An acquire is an upsert that succeeds
-- only when the lease is free, expired, or already yours; expressing that as a
-- conditional UPDATE means two simultaneous acquires are resolved by the
-- database rather than by a read-then-write race in the application.

BEGIN;

CREATE TABLE IF NOT EXISTS campaign_edit_leases (
    tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id uuid        NOT NULL,
    -- Who holds it. Not FK'd to users: a lease outliving a deleted user must
    -- expire on its own rather than block the DELETE or vanish silently.
    holder_id    text        NOT NULL,
    -- Shown to the person who is refused. Without it the refusal reads
    -- "someone else is editing this", which is not actionable.
    holder_label text        NOT NULL DEFAULT '',
    acquired_at  timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    PRIMARY KEY (tenant_id, campaign_id),
    -- Single-column FK because `campaigns` has no (tenant_id, id) unique
    -- constraint — its primary key is `id` alone. Tenant isolation therefore
    -- comes from the RLS policy below plus this table's own composite primary
    -- key, not from the foreign key; the FK's job here is only to make a lease
    -- disappear with the campaign it locks.
    FOREIGN KEY (campaign_id) REFERENCES campaigns (id) ON DELETE CASCADE
);

COMMENT ON TABLE campaign_edit_leases IS
    'One writer at a time on a campaign being edited. Advisory and TTL-bounded: '
    'the approval fingerprint and If-Match version still catch what slips past '
    'the boundary, so this layer is allowed to be soft rather than a hard lock '
    'that an admin has to break.';

CREATE INDEX IF NOT EXISTS campaign_edit_leases_expiry_idx
    ON campaign_edit_leases (expires_at);

ALTER TABLE campaign_edit_leases ENABLE ROW LEVEL SECURITY;
-- FORCE, matching 612 of the 617 RLS tables in this schema.
--
-- Without it the policy is bypassed for the table's OWNER — migrations, ops
-- tooling, and any future SECURITY DEFINER function — while every neighbouring
-- table enforces it. The first version of this migration omitted it and the
-- isolation tests still passed, because they run as `postwave_app`, which is
-- not the owner: the gap is invisible to exactly the test you would write to
-- look for it. `scripts/check-rls-policies.sh` does not catch it either.
ALTER TABLE campaign_edit_leases FORCE ROW LEVEL SECURITY;

-- RESTRICTIVE isolation + a PERMISSIVE grant, the shape `flow_runs` uses.
--
-- A single permissive policy is an OR: any later policy added to this table
-- would widen access on its own. A restrictive one ANDs with everything, so the
-- tenant predicate cannot be widened by addition — only the permissive layer
-- decides WHO, and the restrictive layer always decides WHICH ROWS.
DROP POLICY IF EXISTS tenant_isolation ON campaign_edit_leases;
CREATE POLICY tenant_isolation ON campaign_edit_leases
    AS RESTRICTIVE
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON campaign_edit_leases;
CREATE POLICY tenant_visible ON campaign_edit_leases
    FOR ALL TO postwave_app
    USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_edit_leases TO postwave_app;

COMMIT;
