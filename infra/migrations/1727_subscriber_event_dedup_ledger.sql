-- subscriber_events became range-partitioned by `at` in migration 0339.
-- PostgreSQL cannot enforce the former global uniqueness key
-- (tenant_id, source, source_event_id) on a partitioned table unless the
-- partition key is also part of the index. The API writers nevertheless kept
-- using that old key as an ON CONFLICT arbiter, so every idempotent event write
-- failed on a fresh schema. Keep the time-series table partitioned and move the
-- global provider key into this small, unpartitioned tenant-scoped ledger.

BEGIN;

CREATE TABLE IF NOT EXISTS subscriber_event_dedup_keys (
    tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    source          text        NOT NULL,
    source_event_id text        NOT NULL,
    event_id        bigint,
    event_at        timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, source, source_event_id),
    CONSTRAINT subscriber_event_dedup_keys_source_nonempty
        CHECK (btrim(source) <> ''),
    CONSTRAINT subscriber_event_dedup_keys_event_id_nonempty
        CHECK (btrim(source_event_id) <> ''),
    CONSTRAINT subscriber_event_dedup_keys_event_pointer_pair
        CHECK ((event_id IS NULL) = (event_at IS NULL))
);

-- Preserve the earliest canonical row for keys written before this forward
-- repair. DISTINCT ON also makes the migration safe if the partitioned period
-- admitted duplicates after migration 0339.
INSERT INTO subscriber_event_dedup_keys (
    tenant_id, source, source_event_id, event_id, event_at, created_at
)
SELECT DISTINCT ON (tenant_id, source, source_event_id)
       tenant_id, source, source_event_id, id, at, at
  FROM subscriber_events
 WHERE source IS NOT NULL
   AND btrim(source) <> ''
   AND source_event_id IS NOT NULL
   AND btrim(source_event_id) <> ''
 ORDER BY tenant_id, source, source_event_id, at, id
ON CONFLICT (tenant_id, source, source_event_id) DO NOTHING;

GRANT SELECT, INSERT, UPDATE (event_id, event_at)
    ON subscriber_event_dedup_keys TO postwave_app;

ALTER TABLE subscriber_event_dedup_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_event_dedup_keys FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS subscriber_event_dedup_keys_tenant_isolation
    ON subscriber_event_dedup_keys;
CREATE POLICY subscriber_event_dedup_keys_tenant_isolation
    ON subscriber_event_dedup_keys
    AS PERMISSIVE
    FOR ALL
    TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

COMMIT;
