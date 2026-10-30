-- 0051_api_key_rate_limit.sql
--
-- Per-API-key rate limit configuration. Three columns added to
-- api_keys:
--
--   rate_limit_per_min — requests per 60-second sliding window.
--                         NULL = unlimited (existing default).
--   rate_limit_per_day — long-window cap. NULL = unlimited.
--                         Exists alongside per_min for "10 req/sec
--                         is fine but no more than 50k/day total".
--   rate_limit_burst   — short-burst allowance (extra over per_min).
--                         NULL = no burst (per_min is hard).
--
-- The middleware reads these on every authenticated request, hits
-- Redis with the per-key counter key, returns 429 when exceeded.
-- Redis is the same one asynq uses; sharing infra rather than
-- bringing up a second instance.

BEGIN;

ALTER TABLE api_keys
    ADD COLUMN IF NOT EXISTS rate_limit_per_min int,
    ADD COLUMN IF NOT EXISTS rate_limit_per_day int,
    ADD COLUMN IF NOT EXISTS rate_limit_burst   int;

COMMIT;
