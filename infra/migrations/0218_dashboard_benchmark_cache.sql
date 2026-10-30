-- 0218_dashboard_benchmark_cache.sql
--
-- Refined Dashboard PR 4 follow-up: caches platform-wide aggregate
-- benchmarks (anonymous, no tenant breakouts) so /api/v1/dashboard/
-- benchmarks can serve real data instead of illustrative averages.
--
-- One row per (metric, window_days). Recomputed daily by the
-- BenchmarkAggregator worker. The endpoint reads from this table when
-- a row is present; falls back to hardcoded illustrative averages
-- when empty (e.g. a fresh deploy before the first aggregator tick).
--
-- We do NOT use RLS here — this is platform-wide data; every tenant
-- gets the same numbers.

BEGIN;

CREATE TABLE dashboard_benchmark_cache (
    metric        text NOT NULL,             -- 'opens' | 'clicks' | 'bounces' | 'unsubs'
    window_days   int  NOT NULL,             -- 30 today; future: 7, 90
    average       double precision NOT NULL, -- 0..1 rate across all tenants
    sample_size   int  NOT NULL,             -- # of campaigns aggregated
    computed_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (metric, window_days)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON dashboard_benchmark_cache TO postwave_app;

COMMIT;
