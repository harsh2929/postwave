-- 1930_controlled_seed_registry_and_analytics_exclusion.sql
--
-- Publish the existing deliverability seed registry as an immutable revision
-- ledger and make controlled-seed engagement evidence default-excluded at the
-- canonical analytics boundary.  The ledger contains secret references only;
-- resolved addresses, usernames, passwords, and raw provider identifiers never
-- enter PostgreSQL.
--
-- rollback-strategy: no-op. Registry revisions and seed-origin event evidence
-- are audit provenance. Older binaries ignore the additive nullable columns.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE controlled_seed_registry_versions (
    id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    mailbox_id                 text NOT NULL CHECK (
                                   length(mailbox_id) BETWEEN 1 AND 200
                                   AND mailbox_id !~ '[[:cntrl:]]'
                               ),
    version                    integer NOT NULL CHECK (version > 0),
    registry_schema_version    text NOT NULL CHECK (registry_schema_version = 'postwave.controlled-seed-registry.v1'),
    lifecycle_state            text NOT NULL CHECK (lifecycle_state IN ('active', 'retired')),
    operational_status         text NOT NULL CHECK (operational_status IN ('active', 'flagged', 'banned')),
    warmup_state               text NOT NULL CHECK (warmup_state IN ('unknown', 'cold', 'warming', 'ready', 'paused')),
    health_state               text NOT NULL CHECK (health_state IN ('unknown', 'healthy', 'degraded', 'unhealthy')),

    provider                   text NOT NULL CHECK (provider IN (
                                   'gmail', 'outlook_com', 'o365', 'icloud',
                                   'yahoo', 'proton', 'gmx', 'mailru'
                               )),
    client                     text NOT NULL CHECK (length(client) BETWEEN 1 AND 120),
    device                     text NOT NULL CHECK (length(device) BETWEEN 1 AND 120),
    account_tier               text NOT NULL CHECK (length(account_tier) BETWEEN 1 AND 120),
    region                     text NOT NULL CHECK (length(region) BETWEEN 1 AND 120),
    locale                     text NOT NULL CHECK (length(locale) BETWEEN 1 AND 80),
    timezone                   text NOT NULL CHECK (length(timezone) BETWEEN 1 AND 120),
    language                   text NOT NULL CHECK (length(language) BETWEEN 1 AND 80),
    mpp_enabled                boolean,
    smart_features             jsonb NOT NULL DEFAULT '{}'::jsonb
                               CHECK (jsonb_typeof(smart_features) = 'object'),
    capability_snapshot        jsonb NOT NULL CHECK (jsonb_typeof(capability_snapshot) = 'object'),

    address_secret_ref         text NOT NULL CHECK (
                                   length(address_secret_ref) BETWEEN 5 AND 1000
                                   AND address_secret_ref ~ '^(env|env-json|aws-sm|vault|gcp-sm|azure-kv):(//)?[^[:space:]]+$'
                               ),
    imap_username_secret_ref   text CHECK (
                                   imap_username_secret_ref IS NULL OR (
                                       length(imap_username_secret_ref) BETWEEN 5 AND 1000
                                       AND imap_username_secret_ref ~ '^(env|env-json|aws-sm|vault|gcp-sm|azure-kv):(//)?[^[:space:]]+$'
                                   )
                               ),
    imap_password_secret_ref   text CHECK (
                                   imap_password_secret_ref IS NULL OR (
                                       length(imap_password_secret_ref) BETWEEN 5 AND 1000
                                       AND imap_password_secret_ref ~ '^(env|env-json|aws-sm|vault|gcp-sm|azure-kv):(//)?[^[:space:]]+$'
                                   )
                               ),
    imap_host                  text CHECK (
                                   imap_host IS NULL OR (
                                       length(imap_host) BETWEEN 1 AND 253
                                       AND imap_host !~ '[[:space:]]'
                                   )
                               ),
    imap_port                  integer CHECK (imap_port IS NULL OR imap_port BETWEEN 1 AND 65535),

    retirement_reason_code     text CHECK (
                                   retirement_reason_code IS NULL
                                   OR retirement_reason_code ~ '^[a-z][a-z0-9_]{0,95}$'
                               ),
    config_fingerprint_sha256  text NOT NULL CHECK (config_fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
    recorded_at                timestamptz NOT NULL DEFAULT clock_timestamp(),
    retired_at                 timestamptz,

    CONSTRAINT controlled_seed_registry_versions_identity_unique UNIQUE (mailbox_id, version),
    CONSTRAINT controlled_seed_registry_versions_imap_secret_shape CHECK (
        (imap_username_secret_ref IS NULL) = (imap_password_secret_ref IS NULL)
    ),
    CONSTRAINT controlled_seed_registry_versions_retirement_shape CHECK (
        (lifecycle_state = 'active' AND retirement_reason_code IS NULL AND retired_at IS NULL)
        OR
        (lifecycle_state = 'retired' AND retirement_reason_code IS NOT NULL AND retired_at IS NOT NULL)
    )
);

CREATE INDEX controlled_seed_registry_versions_current_idx
    ON controlled_seed_registry_versions (mailbox_id, version DESC);
CREATE INDEX controlled_seed_registry_versions_health_idx
    ON controlled_seed_registry_versions (lifecycle_state, health_state, warmup_state, provider, mailbox_id);

CREATE OR REPLACE FUNCTION controlled_seed_registry_versions_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
    RAISE EXCEPTION 'controlled_seed_registry_versions is append-only'
        USING ERRCODE = '55000';
END;
$fn$;

CREATE TRIGGER controlled_seed_registry_versions_append_only
    BEFORE UPDATE OR DELETE ON controlled_seed_registry_versions
    FOR EACH ROW EXECUTE FUNCTION controlled_seed_registry_versions_append_only();

COMMENT ON TABLE controlled_seed_registry_versions IS
    'Immutable publication history of the deliverability-owned controlled seed registry; contains secret references, never resolved credentials.';
COMMENT ON COLUMN controlled_seed_registry_versions.mpp_enabled IS
    'Nullable because unknown is distinct from a measured false setting.';

GRANT SELECT, INSERT ON controlled_seed_registry_versions TO postwave_app;
REVOKE UPDATE, DELETE, TRUNCATE ON controlled_seed_registry_versions FROM postwave_app;
ALTER TABLE controlled_seed_registry_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE controlled_seed_registry_versions FORCE ROW LEVEL SECURITY;

CREATE POLICY controlled_seed_registry_versions_worker_select
    ON controlled_seed_registry_versions FOR SELECT TO postwave_app
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.controlled_seed_registry_writer', true) = 'true'
    );
CREATE POLICY controlled_seed_registry_versions_worker_insert
    ON controlled_seed_registry_versions FOR INSERT TO postwave_app
    WITH CHECK (
        current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.controlled_seed_registry_writer', true) = 'true'
    );

-- Freeze the exact registry revision and normalized RFC Message-ID alongside
-- every controlled dispatch. Both columns are nullable for rolling-deploy and
-- historical compatibility; feature-on publication fills the registry link.
ALTER TABLE inbox_reality_seed_dispatches
    ADD COLUMN seed_registry_version_id uuid REFERENCES controlled_seed_registry_versions(id),
    ADD COLUMN source_message_id_sha256 text CHECK (
        source_message_id_sha256 IS NULL OR source_message_id_sha256 ~ '^[0-9a-f]{64}$'
    );

CREATE OR REPLACE FUNCTION inbox_reality_seed_dispatch_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.test_id IS DISTINCT FROM OLD.test_id
       OR NEW.command_id IS DISTINCT FROM OLD.command_id
       OR NEW.mailbox_id IS DISTINCT FROM OLD.mailbox_id
       OR NEW.provider IS DISTINCT FROM OLD.provider
       OR NEW.capability_snapshot IS DISTINCT FROM OLD.capability_snapshot
       OR NEW.artifact_mime_hash IS DISTINCT FROM OLD.artifact_mime_hash
       OR NEW.dispatched_mime_hash IS DISTINCT FROM OLD.dispatched_mime_hash
       OR NEW.seed_registry_version_id IS DISTINCT FROM OLD.seed_registry_version_id
       OR NEW.source_message_id_sha256 IS DISTINCT FROM OLD.source_message_id_sha256
       OR NEW.max_attempts IS DISTINCT FROM OLD.max_attempts
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Inbox Reality seed dispatch identity is immutable'
            USING ERRCODE = '55000';
    END IF;
    IF OLD.state IN ('accepted', 'rejected', 'indeterminate', 'expired', 'cancelled')
       AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'terminal Inbox Reality seed dispatch is immutable'
            USING ERRCODE = '55000';
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
        (OLD.state IN ('prepared', 'retry_wait') AND NEW.state IN (
            'dispatching', 'rejected', 'expired', 'cancelled'
        ))
        OR (OLD.state = 'dispatching' AND NEW.state IN (
            'retry_wait', 'accepted', 'rejected', 'indeterminate'
        ))
    ) THEN
        RAISE EXCEPTION 'invalid Inbox Reality seed dispatch transition: % -> %', OLD.state, NEW.state
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$fn$;

ALTER TABLE seed_message_observations
    ADD COLUMN seed_registry_version_id uuid REFERENCES controlled_seed_registry_versions(id);

-- Typed, server-resolved origin lives on both current canonical ledgers. The
-- trigger owns the PRD's is_seed marker while the explicit origin/method/version
-- fields retain honest provenance.
ALTER TABLE subscriber_events
    ADD COLUMN event_origin text NOT NULL DEFAULT 'recipient',
    ADD COLUMN controlled_seed_test_id uuid,
    ADD COLUMN seed_origin_method text,
    ADD COLUMN event_origin_version text NOT NULL DEFAULT 'postwave.event-origin.v1',
    ADD COLUMN is_seed boolean NOT NULL DEFAULT false;

ALTER TABLE subscriber_events
    ADD CONSTRAINT subscriber_events_origin_check CHECK (event_origin IN ('recipient', 'controlled_seed')) NOT VALID,
    ADD CONSTRAINT subscriber_events_seed_origin_shape_check CHECK (
        (event_origin = 'recipient' AND NOT is_seed
            AND controlled_seed_test_id IS NULL AND seed_origin_method IS NULL)
        OR
        (event_origin = 'controlled_seed' AND is_seed AND (
            (controlled_seed_test_id IS NOT NULL
                AND seed_origin_method IN ('rfc_message_id', 'provider_message_id'))
            OR
            (controlled_seed_test_id IS NULL AND seed_origin_method = 'rfc_message_id_ambiguous')
        ))
    ) NOT VALID;

ALTER TABLE subscriber_events
    VALIDATE CONSTRAINT subscriber_events_origin_check,
    VALIDATE CONSTRAINT subscriber_events_seed_origin_shape_check;

ALTER TABLE campaign_report_events
    ADD COLUMN event_origin text NOT NULL DEFAULT 'recipient',
    ADD COLUMN controlled_seed_test_id uuid,
    ADD COLUMN seed_origin_method text,
    ADD COLUMN event_origin_version text NOT NULL DEFAULT 'postwave.event-origin.v1',
    ADD COLUMN is_seed boolean NOT NULL DEFAULT false;

ALTER TABLE campaign_report_events
    ADD CONSTRAINT campaign_report_events_origin_check CHECK (event_origin IN ('recipient', 'controlled_seed')) NOT VALID,
    ADD CONSTRAINT campaign_report_events_seed_origin_shape_check CHECK (
        (event_origin = 'recipient' AND NOT is_seed
            AND controlled_seed_test_id IS NULL AND seed_origin_method IS NULL)
        OR
        (event_origin = 'controlled_seed' AND is_seed AND (
            (controlled_seed_test_id IS NOT NULL
                AND seed_origin_method IN ('rfc_message_id', 'provider_message_id'))
            OR
            (controlled_seed_test_id IS NULL AND seed_origin_method = 'rfc_message_id_ambiguous')
        ))
    ) NOT VALID;

ALTER TABLE campaign_report_events
    VALIDATE CONSTRAINT campaign_report_events_origin_check,
    VALIDATE CONSTRAINT campaign_report_events_seed_origin_shape_check;

CREATE OR REPLACE FUNCTION classify_controlled_seed_event_origin()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    normalized_message_id text;
    normalized_message_hash text;
    raw_message_hash text;
    matched_test_id uuid;
    matched_method text;
    matched_test_count integer;
BEGIN
    -- Caller-supplied origin fields are never trusted. Classification is
    -- derived exclusively from an accepted/frozen controlled dispatch.
    NEW.event_origin := 'recipient';
    NEW.is_seed := false;
    NEW.controlled_seed_test_id := NULL;
    NEW.seed_origin_method := NULL;
    NEW.event_origin_version := 'postwave.event-origin.v1';

    IF NEW.message_id IS NULL OR btrim(NEW.message_id) = '' THEN
        RETURN NEW;
    END IF;

    normalized_message_id := lower(btrim(NEW.message_id));
    IF normalized_message_id ~ '^<[^<>]+>$' THEN
        normalized_message_id := substr(normalized_message_id, 2, length(normalized_message_id) - 2);
    END IF;
    normalized_message_hash := encode(digest(convert_to(normalized_message_id, 'UTF8'), 'sha256'), 'hex');
    raw_message_hash := encode(digest(convert_to(btrim(NEW.message_id), 'UTF8'), 'sha256'), 'hex');

    -- A provider receipt is unique to one accepted provider call and therefore
    -- wins over the source RFC Message-ID shared by every mailbox in a test.
    SELECT dispatch.test_id, 'provider_message_id'
      INTO matched_test_id, matched_method
      FROM public.inbox_reality_seed_dispatches dispatch
     WHERE dispatch.tenant_id = NEW.tenant_id
       AND dispatch.provider_message_id_sha256 IN (raw_message_hash, normalized_message_hash)
     ORDER BY dispatch.created_at, dispatch.id
     LIMIT 1;

    IF matched_test_id IS NOT NULL THEN
        NEW.event_origin := 'controlled_seed';
        NEW.is_seed := true;
        NEW.controlled_seed_test_id := matched_test_id;
        NEW.seed_origin_method := matched_method;
        RETURN NEW;
    END IF;

    -- The same frozen artifact can be tested more than once, so its RFC
    -- Message-ID may prove seed origin without uniquely proving which test.
    -- Preserve that honest ambiguity instead of choosing an arbitrary run.
    SELECT count(DISTINCT dispatch.test_id)::integer,
           min(dispatch.test_id::text)::uuid
      INTO matched_test_count, matched_test_id
      FROM public.inbox_reality_seed_dispatches dispatch
     WHERE dispatch.tenant_id = NEW.tenant_id
       AND dispatch.source_message_id_sha256 = normalized_message_hash;
    IF matched_test_count > 0 THEN
        NEW.event_origin := 'controlled_seed';
        NEW.is_seed := true;
        IF matched_test_count = 1 THEN
            NEW.controlled_seed_test_id := matched_test_id;
            NEW.seed_origin_method := 'rfc_message_id';
        ELSE
            NEW.controlled_seed_test_id := NULL;
            NEW.seed_origin_method := 'rfc_message_id_ambiguous';
        END IF;
    END IF;
    RETURN NEW;
END;
$fn$;

CREATE TRIGGER subscriber_events_classify_controlled_seed_origin
    BEFORE INSERT ON subscriber_events
    FOR EACH ROW EXECUTE FUNCTION classify_controlled_seed_event_origin();
CREATE TRIGGER campaign_report_events_classify_controlled_seed_origin
    BEFORE INSERT ON campaign_report_events
    FOR EACH ROW EXECUTE FUNCTION classify_controlled_seed_event_origin();

CREATE OR REPLACE FUNCTION canonical_event_origin_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
    IF NEW.event_origin IS DISTINCT FROM OLD.event_origin
       OR NEW.controlled_seed_test_id IS DISTINCT FROM OLD.controlled_seed_test_id
       OR NEW.seed_origin_method IS DISTINCT FROM OLD.seed_origin_method
       OR NEW.event_origin_version IS DISTINCT FROM OLD.event_origin_version
       OR NEW.is_seed IS DISTINCT FROM OLD.is_seed THEN
        RAISE EXCEPTION 'canonical event origin is immutable'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$fn$;

CREATE TRIGGER subscriber_events_origin_immutable
    BEFORE UPDATE ON subscriber_events
    FOR EACH ROW EXECUTE FUNCTION canonical_event_origin_immutable();
CREATE TRIGGER campaign_report_events_origin_immutable
    BEFORE UPDATE ON campaign_report_events
    FOR EACH ROW EXECUTE FUNCTION canonical_event_origin_immutable();

-- Restrictive SELECT policies are a default-safe analytics boundary: every
-- existing and future query through postwave_app excludes controlled seeds.
-- Raw evidence access is deliberately two-factor and transaction-local.
CREATE POLICY subscriber_events_controlled_seed_exclusion
    ON subscriber_events AS RESTRICTIVE FOR SELECT TO postwave_app
    USING (
        NOT is_seed
        OR current_setting('app.controlled_seed_event_ingester', true) = 'true'
        OR (
            current_setting('app.outbox_worker', true) = 'true'
            AND current_setting('app.controlled_seed_evidence_reader', true) = 'true'
        )
    );
CREATE POLICY campaign_report_events_controlled_seed_exclusion
    ON campaign_report_events AS RESTRICTIVE FOR SELECT TO postwave_app
    USING (
        NOT is_seed
        OR current_setting('app.controlled_seed_event_ingester', true) = 'true'
        OR (
            current_setting('app.outbox_worker', true) = 'true'
            AND current_setting('app.controlled_seed_evidence_reader', true) = 'true'
        )
    );

COMMENT ON COLUMN subscriber_events.is_seed IS
    'Server-derived marker for controlled-seed evidence; default analytics RLS excludes true rows.';
COMMENT ON COLUMN campaign_report_events.is_seed IS
    'Server-derived marker for controlled-seed evidence; default analytics RLS excludes true rows.';

COMMIT;

-- The dispatch tables may already contain production receipts. Build lookup
-- indexes without holding a table-wide write lock.
CREATE INDEX CONCURRENTLY IF NOT EXISTS inbox_reality_seed_dispatches_source_message_idx
    ON inbox_reality_seed_dispatches (tenant_id, source_message_id_sha256)
    WHERE source_message_id_sha256 IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS inbox_reality_seed_dispatches_provider_message_idx
    ON inbox_reality_seed_dispatches (tenant_id, provider_message_id_sha256)
    WHERE provider_message_id_sha256 IS NOT NULL;
