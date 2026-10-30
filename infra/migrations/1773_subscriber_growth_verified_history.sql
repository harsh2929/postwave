-- 1773_subscriber_growth_verified_history.sql
--
-- The original subscriber_growth_history contract cannot be reused for the
-- verified audience-growth report.  Rows already stored there were produced
-- with session-local calendar dates, archived profiles in totals, and an
-- unrelated subscribers.updated_at unsubscribe heuristic.  Relabelling those
-- rows would turn estimates into facts.
--
-- A version column alone is also insufficient during a rolling deployment:
-- an older binary's ON CONFLICT update does not mention that column and could
-- therefore overwrite verified counts while leaving the row marked current.
-- Keep the legacy ledger available to draining/rolled-back binaries and place
-- verified-exact-ledger-v2 snapshots in a physically separate tenant-scoped
-- table.  New API instances read only the verified table; no historical rows
-- are backfilled or inferred.
--
-- rollback-strategy: no-op
-- rollback-details: The additive legacy label and verified ledger are safe for
-- older binaries to ignore.  Retain both on application rollback so a later
-- verified deployment can resume without losing already-produced facts.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

ALTER TABLE public.subscriber_growth_history
    ADD COLUMN metric_contract_version text
        NOT NULL DEFAULT 'legacy-heuristic-v1';

ALTER TABLE public.subscriber_growth_history
    ADD CONSTRAINT subscriber_growth_history_metric_contract_check
    CHECK (metric_contract_version = 'legacy-heuristic-v1') NOT VALID;

ALTER TABLE public.subscriber_growth_history
    VALIDATE CONSTRAINT subscriber_growth_history_metric_contract_check;

COMMENT ON TABLE public.subscriber_growth_history IS
    'Legacy audience-growth snapshots retained for audit and rolling-deploy compatibility. These rows use legacy-heuristic-v1 semantics and must not be returned by the verified growth API.';
COMMENT ON COLUMN public.subscriber_growth_history.metric_contract_version IS
    'Immutable semantic label for legacy rows. The legacy default intentionally protects writes from older application binaries.';

CREATE TABLE public.subscriber_growth_verified_history (
    tenant_id               uuid        NOT NULL
        REFERENCES public.tenants(id) ON DELETE CASCADE,
    snapshot_date           date        NOT NULL,
    evaluated_at            timestamptz NOT NULL,
    total_count             bigint      NOT NULL CHECK (total_count >= 0),
    added_count             bigint      NOT NULL CHECK (added_count >= 0),
    unsubbed_count          bigint      NOT NULL CHECK (unsubbed_count >= 0),
    lapsed_count            bigint      NOT NULL CHECK (lapsed_count = 0),
    metric_contract_version text        NOT NULL
        CHECK (metric_contract_version = 'verified-exact-ledger-v2'),
    PRIMARY KEY (tenant_id, snapshot_date),
    CHECK (snapshot_date = (evaluated_at AT TIME ZONE 'UTC')::date)
);

COMMENT ON TABLE public.subscriber_growth_verified_history IS
    'Daily audience-growth facts written and read only under verified-exact-ledger-v2 semantics; deliberately not backfilled from the legacy heuristic ledger.';
COMMENT ON COLUMN public.subscriber_growth_verified_history.unsubbed_count IS
    'Verified lower-bound count of distinct profile-wide exact-address granted-to-withdrawn transitions for this UTC day; API partial_metrics discloses incomplete source coverage.';
COMMENT ON COLUMN public.subscriber_growth_verified_history.lapsed_count IS
    'Reserved unavailable metric. Must remain zero until a separately versioned canonical lapse definition is introduced.';
COMMENT ON COLUMN public.subscriber_growth_verified_history.metric_contract_version IS
    'Closed semantic contract identifier required by the API and desktop parser.';

REVOKE ALL ON TABLE public.subscriber_growth_verified_history FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE
    ON TABLE public.subscriber_growth_verified_history TO postwave_app;

ALTER TABLE public.subscriber_growth_verified_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriber_growth_verified_history FORCE ROW LEVEL SECURITY;

CREATE POLICY subscriber_growth_verified_history_tenant_isolation
    ON public.subscriber_growth_verified_history
    AS RESTRICTIVE FOR ALL TO postwave_app
    USING (
        tenant_id = NULLIF(
            pg_catalog.current_setting('app.tenant_id', true), ''
        )::uuid
    )
    WITH CHECK (
        tenant_id = NULLIF(
            pg_catalog.current_setting('app.tenant_id', true), ''
        )::uuid
    );

CREATE POLICY subscriber_growth_verified_history_tenant_visible
    ON public.subscriber_growth_verified_history
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (
        tenant_id = NULLIF(
            pg_catalog.current_setting('app.tenant_id', true), ''
        )::uuid
    )
    WITH CHECK (
        tenant_id = NULLIF(
            pg_catalog.current_setting('app.tenant_id', true), ''
        )::uuid
    );

COMMIT;
