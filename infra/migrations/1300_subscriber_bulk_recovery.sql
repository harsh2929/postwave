-- 1300_subscriber_bulk_recovery.sql
--
-- SUB-099 — Undo for bulk suppress / tag / delete.
--
-- A bulk operation (delete / tag / untag / unsubscribe) is destructive at
-- scale: a mis-targeted bulk delete erases thousands of subscriber rows in
-- one transaction, and the operator has no per-row "Undo" the way the
-- single-subscriber surface does. This table is the durable reverse-operation
-- ledger that powers a time-boxed undo:
--
--   * The bulk handler INSERTs ONE recovery row per operation, carrying a
--     newly-minted recovery_token and a JSON snapshot of everything needed to
--     reverse the op (for delete: the full deleted rows; for tag/untag: the
--     affected ids + the tag; for unsubscribe: the affected ids + prior
--     status). recovery_until pins the redemption deadline.
--   * POST /subscribers/bulk/recover validates the token, checks
--     recovery_until > now() AND redeemed_at IS NULL, then replays the
--     snapshot to restore the prior state and stamps redeemed_at so the token
--     is single-use.
--
-- Window policy (enforced in the handler, not the schema, so it can be tuned
-- without a migration): delete snapshots are retained 24h (recovery audit
-- row); tag / untag / unsubscribe snapshots are retained 10s–10m of "toast"
-- undo. The DEFAULT here is the conservative 24h; the handler overrides
-- recovery_until per operation.
--
-- Tenant-scoped + RLS-gated on app.tenant_id, following the shape of
-- 0303_subscriber_signup_source.sql / 0264_subscriber_view_prefs.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS subscriber_bulk_recovery (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    recovery_token      text NOT NULL,
    operation           text NOT NULL CHECK (operation IN (
                            'delete',
                            'tag',
                            'untag',
                            'unsubscribe'
                        )),
    -- subscriber_snapshot is the reverse-operation payload. Shape varies by
    -- operation (see the handler), but it is always a JSON object so the
    -- replay code can switch on `operation` and read the keys it needs.
    subscriber_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
    affected_count      integer NOT NULL DEFAULT 0,
    deleted_at          timestamptz NOT NULL DEFAULT now(),
    recovery_until      timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
    redeemed_at         timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now()
);

-- Token lookup is the hot path for redemption; scope it per tenant so the
-- RLS-narrowed query plan hits the index directly. Tokens are random 32-byte
-- hex so a global UNIQUE would also work, but the tenant-scoped UNIQUE keeps
-- the isolation explicit.
CREATE UNIQUE INDEX IF NOT EXISTS subscriber_bulk_recovery_token_idx
    ON subscriber_bulk_recovery (tenant_id, recovery_token);

-- Expiry sweep + per-tenant listing.
CREATE INDEX IF NOT EXISTS subscriber_bulk_recovery_tenant_until_idx
    ON subscriber_bulk_recovery (tenant_id, recovery_until);

GRANT SELECT, INSERT, UPDATE, DELETE ON subscriber_bulk_recovery TO postwave_app;

ALTER TABLE subscriber_bulk_recovery ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_bulk_recovery FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON subscriber_bulk_recovery;
CREATE POLICY tenant_isolation ON subscriber_bulk_recovery
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
