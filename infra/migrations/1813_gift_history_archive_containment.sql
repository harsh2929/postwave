-- 1813_gift_history_archive_containment.sql
--
-- Align the historical gift archive with the lifecycle already represented
-- by the API and its dormant expiry worker. The original 0074 CHECK omitted
-- `expired`, so an expiry transition could never commit. Add the bounded
-- archive indexes used by the release-safe read projection; no mutation or
-- public redemption route is enabled by this migration.
--
-- migration-execution: phased
-- rollback-strategy: no-op
-- rollback-details: Keep the widened lifecycle constraint and additive read
-- indexes during an application rollback. Older binaries can continue writing
-- every previously accepted state; merely admitting `expired` does not force
-- its use. Removing the constraint or indexes would not restore data.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE gift_subscriptions
    ADD CONSTRAINT gift_subscriptions_status_check_v2
    CHECK (
        status IN (
            'pending',
            'paid',
            'granted',
            'refunded',
            'canceled',
            'expired'
        )
    )
    NOT VALID;

COMMIT;

-- Validation takes the weaker ShareUpdateExclusive lock and is isolated from
-- the short AccessExclusive add/swap phases. A populated archive therefore
-- never holds AccessExclusive for the duration of the validation scan.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE gift_subscriptions
    VALIDATE CONSTRAINT gift_subscriptions_status_check_v2;

COMMIT;

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE gift_subscriptions
    DROP CONSTRAINT IF EXISTS gift_subscriptions_status_check;

ALTER TABLE gift_subscriptions
    RENAME CONSTRAINT gift_subscriptions_status_check_v2
    TO gift_subscriptions_status_check;

COMMIT;

-- Existing installations may already hold a large archive. Build the two
-- read indexes without blocking writes; these statements intentionally live
-- outside the transaction above.
CREATE INDEX CONCURRENTLY IF NOT EXISTS gift_subscriptions_history_created_idx
    ON gift_subscriptions (tenant_id, created_at DESC, id DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS gift_subscriptions_history_status_idx
    ON gift_subscriptions (tenant_id, status, created_at DESC, id DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS gift_subscriptions_history_duration_idx
    ON gift_subscriptions (
        tenant_id,
        duration_months DESC,
        created_at DESC,
        id DESC
    );

-- UUID-prefix lookup is implemented as an indexable UUID range rather than a
-- per-row text transformation. Eight hexadecimal characters is the minimum
-- accepted prefix, so this range remains highly selective.
CREATE INDEX CONCURRENTLY IF NOT EXISTS gift_subscriptions_history_id_idx
    ON gift_subscriptions (tenant_id, id);
