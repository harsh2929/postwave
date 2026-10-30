-- 0173_approvals_two_person_and_token_singleuse.sql
--
-- Closes audit findings (approvals HIGH F5 + CRITICAL F2):
--
--   F5: self-approval allowed. The approvals table had no
--   `requested_by_user_id` column to compare against
--   `decided_by_user_id` — any owner/admin could decide their own
--   request. Add the column + the handler enforces the
--   no-self-approval rule.
--
--   F2: token reusable until ExpiresAt. The verifier had no
--   "this token has been consumed" marker, so within the 24h
--   expiry window a captured token could be replayed against any
--   future-resurrected approval row. Add a small
--   `approval_token_consumption` table that records the SHA-256
--   of each consumed token; the verifier rejects on hit.
--
-- Both changes are additive and back-compat. Existing approvals
-- with NULL requested_by_user_id skip the two-person check
-- (operator's earlier behaviour); new approvals always set it.

BEGIN;

ALTER TABLE approvals
    ADD COLUMN IF NOT EXISTS requested_by_user_id uuid;

-- Token-consumption ledger. Hash, not raw token, so a DB dump
-- doesn't reveal undecided tokens. Same-tenant partial unique
-- index so a future approval-id collision can't replay a token
-- from a different approval.
CREATE TABLE IF NOT EXISTS approval_token_consumption (
    id            bigserial PRIMARY KEY,
    approval_id   uuid        NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
    token_sha256  bytea       NOT NULL,
    consumed_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS approval_token_consumption_uniq
    ON approval_token_consumption (approval_id, token_sha256);

CREATE INDEX IF NOT EXISTS approval_token_consumption_consumed_at_idx
    ON approval_token_consumption (consumed_at);

GRANT SELECT, INSERT ON approval_token_consumption TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE approval_token_consumption_id_seq TO postwave_app;

-- No RLS — the public-decide path doesn't have a tenant context
-- at insert time (the verifier runs pre-tenant), and the table
-- carries no PII (hash + opaque approval id only). Read access
-- via dashboard surfaces happens through approvals JOIN, which
-- IS tenant-scoped at the approvals layer.

COMMIT;
