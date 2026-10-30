-- 1883_web_push_deliveries.sql
--
-- Give web push the delivery record mobile push already has.
--
-- `mobile_push_deliveries` records idempotency_key, status, attempts,
-- next_retry_at, error_code, delivered_at and terminal_at — everything needed
-- to answer "did it arrive, and if not, will we try again". Web push records
-- NOTHING. `SendToUser` walks the user's subscriptions, POSTs to each, and:
--
--   * a transport error is logged and skipped
--   * a 4xx/5xx rejection is logged and skipped
--   * a 404/410 prunes the subscription (the one case handled well)
--   * a success increments a counter that is returned and not stored
--
-- So a browser vendor returning 429 — a rate limit, the most ordinary transient
-- failure there is — drops that notification permanently and silently. The same
-- notification to the same person's phone would be retried. Two channels, two
-- behaviours, and only one of them is recoverable or even visible afterwards.
--
-- WHY THE COLUMNS MIRROR mobile_push_deliveries. The row that asked for this
-- said "with mobile_push_deliveries semantics", and the reason is not tidiness:
-- a per-channel ledger whose vocabularies differ cannot answer "was this person
-- notified" across channels, which is the only question anyone actually asks.
-- Same status values, same terminal/delivered split, same idempotency shape.
--
-- WHAT THIS DOES NOT ADD: a retry worker. Nothing here re-sends. The ledger
-- makes a failure visible and re-sendable, and a worker to act on it is
-- separate work — recording it as done while nothing retries would be the
-- "described in the past tense" failure this ledger keeps catching.

BEGIN;

CREATE TABLE IF NOT EXISTS web_push_deliveries (
    id         uuid        NOT NULL DEFAULT gen_random_uuid(),
    tenant_id  uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id    uuid        NOT NULL,
    -- The endpoint rather than a subscription id: subscriptions are pruned on
    -- 404/410, and the delivery record must outlive the subscription it was
    -- attempted against. A FK here would delete the evidence of the failure at
    -- the moment it becomes most interesting.
    endpoint   text        NOT NULL,
    event_type text        NOT NULL DEFAULT '',
    entity_id  text        NOT NULL DEFAULT '',
    -- Supplied by the caller. Two calls carrying the same key are one
    -- notification, however many times a worker retried the enclosing job.
    idempotency_key text   NOT NULL,
    status     text        NOT NULL DEFAULT 'pending',
    error_code text        NOT NULL DEFAULT '',
    attempts   integer     NOT NULL DEFAULT 0,
    -- Set when the push provider accepted it. NOT proof a human saw it — web
    -- push has no receipt — and named `accepted_at` rather than `delivered_at`
    -- for exactly that reason. mobile_push_deliveries can say `delivered_at`
    -- because Expo returns a receipt; claiming the same word here would assert
    -- something the protocol cannot tell us.
    accepted_at timestamptz,
    -- Set when no further attempt will be made, for any reason.
    terminal_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id),
    CONSTRAINT web_push_deliveries_status_check
        CHECK (status = ANY (ARRAY['pending', 'sent', 'failed', 'expired', 'suppressed'])),
    CONSTRAINT web_push_deliveries_idempotency_len
        CHECK (char_length(idempotency_key) BETWEEN 1 AND 200)
);

COMMENT ON TABLE web_push_deliveries IS
    'One row per web-push send attempt per endpoint, mirroring '
    'mobile_push_deliveries so "was this person notified" can be answered '
    'across channels. accepted_at means the push service took it, not that a '
    'human saw it — web push returns no receipt.';

-- The idempotency contract. Per (tenant, endpoint, key) rather than per
-- (tenant, key): the same notification legitimately goes to every browser the
-- person registered, and a tenant-wide key would deliver to whichever endpoint
-- happened to be attempted first and silently skip the rest.
CREATE UNIQUE INDEX IF NOT EXISTS web_push_deliveries_idempotent_idx
    ON web_push_deliveries (tenant_id, endpoint, idempotency_key);

-- The read a support conversation starts from: what did we try to send this
-- person, and what happened.
CREATE INDEX IF NOT EXISTS web_push_deliveries_user_idx
    ON web_push_deliveries (tenant_id, user_id, created_at DESC);

-- The read a future retry worker needs: what is unfinished.
CREATE INDEX IF NOT EXISTS web_push_deliveries_open_idx
    ON web_push_deliveries (tenant_id, created_at)
    WHERE terminal_at IS NULL;

ALTER TABLE web_push_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE web_push_deliveries FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON web_push_deliveries;
CREATE POLICY tenant_isolation ON web_push_deliveries
    AS RESTRICTIVE
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON web_push_deliveries;
CREATE POLICY tenant_visible ON web_push_deliveries
    FOR ALL TO postwave_app
    USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON web_push_deliveries TO postwave_app;

COMMIT;
