-- 0046_api_keys_ip_allowlist.sql
--
-- Per-API-key IP/CIDR allowlist. NULL or empty = no restriction (the
-- default; matches existing keys' behaviour). Non-empty array means
-- the bearer token only authenticates from one of the listed addresses.
--
-- Why inet[] not text[]:
--   - Native CIDR comparison via the <<= containment operator means we
--     can support `192.0.2.0/24` entries without parsing in Go.
--   - Postgres normalizes representation (192.000.002.001 == 192.0.2.1)
--     so duplicate detection is trivial.
--
-- Why this lives on api_keys, not tenants:
--   - Different keys for the same tenant often have different deployment
--     postures. The CI key locked to GitHub Actions IP ranges should be
--     stricter than the dev's machine-bound key with no allowlist.

BEGIN;

ALTER TABLE api_keys
    ADD COLUMN IF NOT EXISTS allowed_ips inet[] NOT NULL DEFAULT '{}';

-- Index the column so the middleware's "row + check IP" path is one
-- planner step. We don't actually need a btree on inet[] for that —
-- the existing key_hash index gets us to the row, and the IP check is
-- a single in-memory array contains. Skip the index.

COMMIT;
