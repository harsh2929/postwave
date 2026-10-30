-- 0043_send_time_opt.sql
--
-- Per-subscriber best-send-hour cache. The nightly worker computes the
-- modal hour-of-week (0-167) at which a subscriber has historically opened
-- email and writes it back here. Cold subscribers (less than 5 opens) are
-- left NULL and resolved at send time to the tenant's global mean.

BEGIN;

ALTER TABLE subscribers
    ADD COLUMN best_send_hour    smallint,
    ADD COLUMN best_send_hour_at timestamptz;

CREATE INDEX subscribers_best_hour_stale_idx
    ON subscribers (tenant_id, best_send_hour_at NULLS FIRST);

COMMIT;
