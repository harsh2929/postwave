-- 1806_api_keys_expiry.sql
-- migration-execution: single-phase
-- rollback-strategy: additive
-- rollback-details: Additive nullable column; safe to leave in place.
--
-- Optional API-key expiry (SETC-036). NULL = never expires. Enforced in
-- LookupByHash so an expired key stops authenticating.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS expires_at timestamptz;
