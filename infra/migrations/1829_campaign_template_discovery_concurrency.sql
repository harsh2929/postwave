-- 1829_campaign_template_discovery_concurrency.sql
--
-- Durable create idempotency and optimistic concurrency for user-private
-- campaign-template collections and saved searches. A monotonic version backs
-- strong ETags; create keys are retained on the resource so an ambiguous retry
-- remains recoverable after the shared short-lived HTTP replay cache expires.
--
-- rollback-strategy: no-op
-- rollback-details: version and create-operation identity are additive safety
-- metadata. Removing them would reintroduce duplicate creates and lost updates.

BEGIN;

ALTER TABLE campaign_template_collections
    ADD COLUMN version bigint NOT NULL DEFAULT 1,
    ADD COLUMN create_idempotency_key text,
    ADD COLUMN create_request_hash text,
    ADD CONSTRAINT campaign_template_collections_version_check
        CHECK (version > 0),
    ADD CONSTRAINT campaign_template_collections_create_identity_check
        CHECK (
            (create_idempotency_key IS NULL AND create_request_hash IS NULL)
            OR (
                create_idempotency_key IS NOT NULL
                AND create_request_hash IS NOT NULL
                AND octet_length(create_idempotency_key) BETWEEN 1 AND 255
                AND create_request_hash ~ '^[0-9a-f]{64}$'
            )
        );

COMMIT;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
    campaign_template_collections_create_key_uidx
    ON campaign_template_collections
       (tenant_id, user_id, create_idempotency_key)
    WHERE create_idempotency_key IS NOT NULL;

BEGIN;

ALTER TABLE campaign_template_saved_searches
    ADD COLUMN version bigint NOT NULL DEFAULT 1,
    ADD COLUMN create_idempotency_key text,
    ADD COLUMN create_request_hash text,
    ADD CONSTRAINT campaign_template_saved_searches_version_check
        CHECK (version > 0),
    ADD CONSTRAINT campaign_template_saved_searches_create_identity_check
        CHECK (
            (create_idempotency_key IS NULL AND create_request_hash IS NULL)
            OR (
                create_idempotency_key IS NOT NULL
                AND create_request_hash IS NOT NULL
                AND octet_length(create_idempotency_key) BETWEEN 1 AND 255
                AND create_request_hash ~ '^[0-9a-f]{64}$'
            )
        );

COMMIT;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
    campaign_template_saved_searches_create_key_uidx
    ON campaign_template_saved_searches
       (tenant_id, user_id, create_idempotency_key)
    WHERE create_idempotency_key IS NOT NULL;

BEGIN;

CREATE FUNCTION campaign_template_discovery_bump_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.version := OLD.version + 1;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION campaign_template_discovery_bump_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION campaign_template_discovery_bump_version()
    TO postwave_app;

CREATE TRIGGER campaign_template_collections_bump_version
    BEFORE UPDATE ON campaign_template_collections
    FOR EACH ROW EXECUTE FUNCTION campaign_template_discovery_bump_version();

CREATE TRIGGER campaign_template_saved_searches_bump_version
    BEFORE UPDATE ON campaign_template_saved_searches
    FOR EACH ROW EXECUTE FUNCTION campaign_template_discovery_bump_version();

COMMENT ON COLUMN campaign_template_collections.version IS
    'Monotonic strong-ETag version incremented by trigger on every committed update.';
COMMENT ON COLUMN campaign_template_collections.create_idempotency_key IS
    'Durable caller operation key for ambiguous create recovery; private under table RLS.';
COMMENT ON COLUMN campaign_template_saved_searches.version IS
    'Monotonic strong-ETag version incremented by trigger on every committed update.';
COMMENT ON COLUMN campaign_template_saved_searches.create_idempotency_key IS
    'Durable caller operation key for ambiguous create recovery; private under table RLS.';

COMMIT;
