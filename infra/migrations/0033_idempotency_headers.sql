-- 0033_idempotency_headers.sql
--
-- Persist response headers alongside body+status so the idempotency replay
-- path can restore Content-Type, Location, Set-Cookie, etc. byte-identical
-- to the original. Prior schema dropped headers entirely on replay.
--
-- The column is nullable because rows written before this migration have no
-- captured headers; replay falls back to the legacy "set Content-Type if
-- missing" behavior for those rows.

BEGIN;

ALTER TABLE idempotency_records
    ADD COLUMN response_headers jsonb;

COMMIT;
