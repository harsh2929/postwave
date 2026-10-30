-- 1762_subscriber_pii_durable_coverage.sql
--
-- SUB-071 / Subscribers P1-14 — database-enforced durable Shadow-PII coverage.
-- migration-execution: phased
--
-- The pre-1762 scanner was invoked by a handful of Go repositories after the
-- subscriber transaction committed. Process exit, a transient DB failure, or
-- any direct SQL writer could therefore lose the scan forever. This migration
-- moves the coverage boundary to PostgreSQL:
--
--   * every INSERT and every scan-relevant subscribers UPDATE advances
--     pii_scan_revision (computed analytics-only writes do not create a scan
--     storm);
--   * the same transaction persists/coalesces a tenant-bound scan intent;
--   * subscriber DELETE cascades per-row state/intent evidence and dirties the
--     exact tenant count once per affected tenant statement;
--   * the intent contains UUIDs/revisions/lease metadata only (no values or
--     deterministic value hashes); the worker fetches the current row under
--     tenant scope;
--   * per-subscriber state distinguishes latest observed, latest scanned, and
--     explicitly coalesced (not individually scanned) revisions;
--   * current-profile tenant coverage snapshots are labelled exact only while
--     serialized against the same coverage row every relevant subscribers-row
--     writer dirties;
--   * scanner enable and field-classification changes increment a generation,
--     causing a bounded/resumable reconciliation instead of an unbounded
--     control-plane transaction;
--   * executable scanner/detector/policy/fingerprint provenance is bound to
--     that generation, with a bounded seen-contract rollback fence preventing
--     old and new replicas from oscillating coverage during rolling deploys.
--
-- Current subscriber-profile free-text inventory scanned by the worker:
-- subscribers.custom_fields, merge_fields, first_name, last_name, full_name,
-- display_name, unsubscribe_reason, tags, groups, gdpr_permissions,
-- activity_summary, source_id, source_platform, external_id, timezone, locale,
-- language, country, and region. email/primary_email, phone_e164, signup_ip and
-- consent/GPP protocol fields are declared identifiers/protocol state rather
-- than "shadow" data and are deliberately not emitted as undeclared findings.
-- All current import, merge-field, CDP, bulk, onboarding and compatibility
-- paths ultimately mutate subscribers, so the database boundary covers direct
-- SQL without an application writer registry. A future persisted free-text
-- column must be added to both the projection and revision allow-list; computed
-- analytics columns are intentionally excluded to prevent continuous rescans.
-- Retained subscriber_attribute_history values, subscriber notes, and event /
-- content payload stores are not part of this current-profile snapshot. They
-- remain an explicit release-blocking follow-on inventory, not an implied
-- clean result from this ledger.
--
-- rollback-strategy: no-op. The revision/outbox/coverage ledger is compliance
-- evidence and remains safe if a worker is rolled back. Do not drop it.

BEGIN;

-- Hot-table DDL must fail retryably instead of waiting in the lock queue and
-- then freezing subscriber traffic behind it. The migration runner retries a
-- lock-timeout failure during a quieter window; the resumable IF EXISTS /
-- IF NOT EXISTS shape makes that safe.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';

ALTER TABLE subscribers
    ADD COLUMN IF NOT EXISTS pii_scan_revision bigint NOT NULL DEFAULT 1;

-- A previously interrupted 1762 attempt may have installed DEFAULT 0. Keep
-- physical zeroes as a rolling-upgrade compatibility state, but make every new
-- row start at the logical baseline and use GREATEST(revision,1) everywhere.
ALTER TABLE subscribers
    ALTER COLUMN pii_scan_revision SET DEFAULT 1;

ALTER TABLE subscribers
    DROP CONSTRAINT IF EXISTS subscribers_pii_scan_revision_check,
    ADD CONSTRAINT subscribers_pii_scan_revision_check
        CHECK (pii_scan_revision >= 0) NOT VALID;

CREATE TABLE IF NOT EXISTS tenant_pii_scan_coverage (
    tenant_id                  uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    scan_enabled               boolean NOT NULL DEFAULT false,
    generation                 bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
    seeded_generation          bigint NOT NULL DEFAULT 0 CHECK (
                                   seeded_generation >= 0
                                   AND seeded_generation <= generation
                               ),
    -- Non-secret executable contract for this generation. A scanner,
    -- detector, policy, fingerprint scheme, or fingerprint-key-version change
    -- advances generation and restarts bounded reconciliation exactly once.
    scan_contract              text CHECK (
                                   scan_contract IS NULL
                                   OR octet_length(scan_contract) BETWEEN 1 AND 512
                               ),
    status                     text NOT NULL DEFAULT 'disabled' CHECK (status IN (
                                   'disabled', 'backfill_pending', 'backfilling',
                                   'catching_up', 'caught_up', 'degraded', 'unavailable'
                               )),
    snapshot_exact             boolean NOT NULL DEFAULT false,
    -- Monotonic proof that one enabled DML *statement* dirtied coverage once,
    -- regardless of whether its transition table held 1 or 100,000 rows.
    dirty_epoch                bigint NOT NULL DEFAULT 0 CHECK (dirty_epoch >= 0),
    total_subscribers          bigint NOT NULL DEFAULT 0 CHECK (total_subscribers >= 0),
    covered_subscribers        bigint NOT NULL DEFAULT 0 CHECK (covered_subscribers >= 0),
    pending_subscribers        bigint NOT NULL DEFAULT 0 CHECK (pending_subscribers >= 0),
    retrying_subscribers       bigint NOT NULL DEFAULT 0 CHECK (retrying_subscribers >= 0),
    dead_letter_subscribers    bigint NOT NULL DEFAULT 0 CHECK (dead_letter_subscribers >= 0),
    truncated_subscribers      bigint NOT NULL DEFAULT 0 CHECK (truncated_subscribers >= 0),
    missing_state_subscribers  bigint NOT NULL DEFAULT 0 CHECK (missing_state_subscribers >= 0),
    coalesced_revisions        bigint NOT NULL DEFAULT 0 CHECK (coalesced_revisions >= 0),
    oldest_pending_at          timestamptz,
    enable_requested_at        timestamptz,
    disabled_at                timestamptz,
    backfill_started_at        timestamptz,
    backfill_completed_at      timestamptz,
    reconciliation_requested_at timestamptz,
    last_reconciled_at         timestamptz,
    last_observed_at           timestamptz,
    last_scanned_at            timestamptz,
    reconcile_lease_owner      uuid,
    reconcile_lease_token      uuid,
    reconcile_lease_expires_at timestamptz,
    reconcile_cursor           uuid,
    created_at                 timestamptz NOT NULL DEFAULT now(),
    updated_at                 timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT tenant_pii_scan_coverage_counts_check CHECK (
        covered_subscribers <= total_subscribers
        AND missing_state_subscribers <= total_subscribers
    ),
    CONSTRAINT tenant_pii_scan_coverage_reconcile_lease_check CHECK (
        (reconcile_lease_owner IS NULL AND reconcile_lease_token IS NULL
         AND reconcile_lease_expires_at IS NULL)
        OR
        (reconcile_lease_owner IS NOT NULL AND reconcile_lease_token IS NOT NULL
         AND reconcile_lease_expires_at IS NOT NULL)
    )
);

-- One deployment-wide provenance fence avoids an O(tenant-count) compatibility
-- probe on every worker tick and gives mixed-version replicas one authoritative
-- active contract. The bounded recent-history window prevents an already-seen
-- old replica from rolling the contract backward during any supported rolling
-- overlap without making the 33rd legitimate contract impossible to activate.
CREATE TABLE IF NOT EXISTS pii_scan_runtime_contract (
    singleton              boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    scan_contract          text CHECK (
                               scan_contract IS NULL
                               OR octet_length(scan_contract) BETWEEN 1 AND 512
                           ),
    scan_contract_history  text[] NOT NULL DEFAULT '{}'::text[] CHECK (
                               cardinality(scan_contract_history) <= 32
                               AND array_position(scan_contract_history, NULL) IS NULL
                               AND (
                                   scan_contract IS NULL
                                   OR scan_contract = ANY(scan_contract_history)
                               )
                           ),
    availability_status    text NOT NULL DEFAULT 'unknown' CHECK (
                               availability_status IN ('unknown', 'available', 'unavailable')
                           ),
    last_available_at      timestamptz,
    updated_at             timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pii_scan_runtime_contract_availability_check CHECK (
        availability_status <> 'available' OR last_available_at IS NOT NULL
    )
);

INSERT INTO pii_scan_runtime_contract (singleton)
VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS subscriber_pii_scan_states (
    tenant_id                  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id              uuid NOT NULL,
    observed_revision          bigint NOT NULL CHECK (observed_revision >= 1),
    scanned_revision           bigint NOT NULL DEFAULT 0 CHECK (scanned_revision >= 0),
    scanned_generation         bigint NOT NULL DEFAULT 0 CHECK (scanned_generation >= 0),
    state                      text NOT NULL CHECK (state IN (
                                   'disabled', 'pending', 'leased', 'retry_wait',
                                   'scanned', 'findings', 'truncated',
                                   'dead_letter', 'unavailable'
                               )),
    coalesced_revisions        bigint NOT NULL DEFAULT 0 CHECK (coalesced_revisions >= 0),
    last_outcome               text CHECK (last_outcome IN ('clean', 'findings', 'truncated')),
    last_error_code            text CHECK (last_error_code IN (
                                   'scanner_unavailable', 'database_unavailable',
                                   'detector_failure', 'scan_truncated', 'lease_lost',
                                   'invalid_subscriber_snapshot', 'internal_failure'
                               )),
    fields_scanned             integer NOT NULL DEFAULT 0 CHECK (fields_scanned >= 0),
    fields_declared            integer NOT NULL DEFAULT 0 CHECK (fields_declared >= 0),
    fields_reserved            integer NOT NULL DEFAULT 0 CHECK (fields_reserved >= 0),
    fields_over_limit          integer NOT NULL DEFAULT 0 CHECK (fields_over_limit >= 0),
    detections_retained        integer NOT NULL DEFAULT 0 CHECK (detections_retained >= 0),
    scanner_name               text,
    scanner_version            text,
    detector_name              text,
    detector_version           text,
    policy_name                text,
    policy_version             text,
    fingerprint_scheme         text,
    fingerprint_key_version    text,
    first_observed_at          timestamptz NOT NULL DEFAULT now(),
    last_observed_at           timestamptz NOT NULL DEFAULT now(),
    last_attempt_at            timestamptz,
    last_scanned_at            timestamptz,
    last_failure_at            timestamptz,
    -- Random internal batching marker; never subscriber data or a value hash.
    last_observed_write_token  uuid,
    created_at                 timestamptz NOT NULL DEFAULT now(),
    updated_at                 timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, subscriber_id),
    CONSTRAINT subscriber_pii_scan_states_subscriber_fk
        FOREIGN KEY (tenant_id, subscriber_id)
        REFERENCES subscribers (tenant_id, id)
        ON DELETE CASCADE,
    CONSTRAINT subscriber_pii_scan_states_revision_check
        CHECK (scanned_revision <= observed_revision),
    CONSTRAINT subscriber_pii_scan_states_provenance_check CHECK (
        (last_outcome IS NULL
         AND scanner_name IS NULL AND scanner_version IS NULL
         AND detector_name IS NULL AND detector_version IS NULL
         AND policy_name IS NULL AND policy_version IS NULL
         AND fingerprint_scheme IS NULL AND fingerprint_key_version IS NULL)
        OR
        (last_outcome IS NOT NULL
         AND NULLIF(btrim(scanner_name), '') IS NOT NULL
         AND NULLIF(btrim(scanner_version), '') IS NOT NULL
         AND NULLIF(btrim(detector_name), '') IS NOT NULL
         AND NULLIF(btrim(detector_version), '') IS NOT NULL
         AND NULLIF(btrim(policy_name), '') IS NOT NULL
         AND NULLIF(btrim(policy_version), '') IS NOT NULL
         AND fingerprint_scheme = 'hmac-sha256-v1'
         AND fingerprint_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
         AND fingerprint_key_version <> 'legacy')
    )
);

CREATE TABLE IF NOT EXISTS subscriber_pii_scan_intents (
    tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id          uuid NOT NULL,
    target_revision        bigint NOT NULL CHECK (target_revision >= 1),
    target_generation      bigint NOT NULL DEFAULT 0 CHECK (target_generation >= 0),
    status                 text NOT NULL DEFAULT 'pending' CHECK (status IN (
                               'pending', 'leased', 'retry_wait', 'dead_letter'
                           )),
    attempts               integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts           integer NOT NULL DEFAULT 8 CHECK (max_attempts BETWEEN 1 AND 32),
    available_at           timestamptz NOT NULL DEFAULT now(),
    lease_owner            uuid,
    lease_token            uuid,
    lease_expires_at       timestamptz,
    claimed_revision       bigint,
    claimed_generation     bigint,
    last_error_code        text CHECK (last_error_code IN (
                               'scanner_unavailable', 'database_unavailable',
                               'detector_failure', 'scan_truncated', 'lease_lost',
                               'invalid_subscriber_snapshot', 'internal_failure'
                           )),
    first_enqueued_at      timestamptz NOT NULL DEFAULT now(),
    last_enqueued_at       timestamptz NOT NULL DEFAULT now(),
    last_claimed_at        timestamptz,
    dead_lettered_at       timestamptz,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, subscriber_id),
    CONSTRAINT subscriber_pii_scan_intents_subscriber_fk
        FOREIGN KEY (tenant_id, subscriber_id)
        REFERENCES subscribers (tenant_id, id)
        ON DELETE CASCADE,
    CONSTRAINT subscriber_pii_scan_intents_lease_check CHECK (
        (status = 'leased'
         AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL
         AND claimed_revision IS NOT NULL AND claimed_generation IS NOT NULL)
        OR
        (status <> 'leased'
         AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL
         AND claimed_revision IS NULL AND claimed_generation IS NULL)
    ),
    CONSTRAINT subscriber_pii_scan_intents_dead_letter_check CHECK (
        (status = 'dead_letter' AND dead_lettered_at IS NOT NULL AND last_error_code IS NOT NULL)
        OR
        (status <> 'dead_letter' AND dead_lettered_at IS NULL)
    )
);

-- PostgreSQL runs same-event RI cascade triggers by trigger name. Recreate the
-- two subscriber child FKs in the queue -> state order used by every scanner
-- mutation; otherwise DELETE can hold state while completion holds intent and
-- the two transactions deadlock. NOT VALID keeps the catalog-lock phase brief;
-- validation runs after COMMIT with DML-compatible locks.
ALTER TABLE subscriber_pii_scan_states
    DROP CONSTRAINT IF EXISTS subscriber_pii_scan_states_subscriber_fk;
ALTER TABLE subscriber_pii_scan_intents
    DROP CONSTRAINT IF EXISTS subscriber_pii_scan_intents_subscriber_fk;
ALTER TABLE subscriber_pii_scan_intents
    ADD CONSTRAINT subscriber_pii_scan_intents_subscriber_fk
    FOREIGN KEY (tenant_id, subscriber_id)
    REFERENCES subscribers (tenant_id, id)
    ON DELETE CASCADE NOT VALID;
ALTER TABLE subscriber_pii_scan_states
    ADD CONSTRAINT subscriber_pii_scan_states_subscriber_fk
    FOREIGN KEY (tenant_id, subscriber_id)
    REFERENCES subscribers (tenant_id, id)
    ON DELETE CASCADE NOT VALID;

COMMENT ON TABLE subscriber_pii_scan_intents IS
    'Durable coalescing Shadow-PII scan intents. Contains tenant/subscriber UUIDs, revisions, generations, leases and closed error codes only; never subscriber values or value hashes.';
COMMENT ON COLUMN subscriber_pii_scan_states.coalesced_revisions IS
    'Count of superseded intermediate revisions that were intentionally not claimed as individually scanned. Only the latest durable snapshot is the coverage invariant.';
COMMENT ON COLUMN subscriber_pii_scan_states.last_outcome IS
    'Outcome for the bounded current subscribers-row profile projection. clean never certifies retained history, notes, attachments, or event/content payload stores.';
COMMENT ON COLUMN tenant_pii_scan_coverage.snapshot_exact IS
    'True only for the current subscribers-row profile projection when counts were refreshed while holding the coverage row lock. Every scan-relevant subscribers/config/schema mutation for that projection dirties this row. Retained history, notes, and event/content payload stores are not certified.';
COMMENT ON COLUMN tenant_pii_scan_coverage.scan_contract IS
    'Non-secret scanner/detector/policy/fingerprint provenance contract bound to generation. Contains identifiers, key version, and a one-way HMAC key commitment used to fence misconfigured replicas; never key material or subscriber values. Dedicated peppers require at least 256 bits of random entropy.';
COMMENT ON TABLE pii_scan_runtime_contract IS
    'Deployment-wide non-secret scanner provenance, bounded rollback fence, and healthy-active-worker heartbeat. Contains identifiers, key versions, and a one-way HMAC key commitment (not key material); dedicated peppers require at least 256 bits of random entropy.';

CREATE INDEX IF NOT EXISTS subscriber_pii_scan_intents_claim_idx
    ON subscriber_pii_scan_intents (available_at, first_enqueued_at, tenant_id, subscriber_id)
    WHERE status IN ('pending', 'retry_wait', 'leased');
CREATE INDEX IF NOT EXISTS subscriber_pii_scan_intents_dead_letter_idx
    ON subscriber_pii_scan_intents (tenant_id, dead_lettered_at, subscriber_id)
    WHERE status = 'dead_letter';
CREATE INDEX IF NOT EXISTS subscriber_pii_scan_states_gap_idx
    ON subscriber_pii_scan_states (tenant_id, state, last_observed_at, subscriber_id)
    WHERE state IN ('pending', 'leased', 'retry_wait', 'truncated', 'dead_letter', 'unavailable');
CREATE INDEX IF NOT EXISTS tenant_pii_scan_coverage_reconcile_idx
    ON tenant_pii_scan_coverage (status, reconciliation_requested_at, tenant_id)
    WHERE scan_enabled;
CREATE INDEX IF NOT EXISTS tenant_pii_scan_coverage_contract_idx
    ON tenant_pii_scan_coverage (scan_contract, tenant_id)
    WHERE scan_enabled;

-- API requests use tenant scope; the background worker uses the narrow,
-- transaction-local app.outbox_worker scope and then re-enters tenant scope
-- before fetching any subscriber values. No policy exposes queue contents to
-- an unscoped connection.
ALTER TABLE tenant_pii_scan_coverage ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_pii_scan_coverage FORCE ROW LEVEL SECURITY;
ALTER TABLE pii_scan_runtime_contract ENABLE ROW LEVEL SECURITY;
ALTER TABLE pii_scan_runtime_contract FORCE ROW LEVEL SECURITY;
ALTER TABLE subscriber_pii_scan_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_pii_scan_states FORCE ROW LEVEL SECURITY;
ALTER TABLE subscriber_pii_scan_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_pii_scan_intents FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_visible ON tenant_pii_scan_coverage;
CREATE POLICY tenant_visible ON tenant_pii_scan_coverage
    FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS worker_visible ON tenant_pii_scan_coverage;
CREATE POLICY worker_visible ON tenant_pii_scan_coverage
    FOR ALL TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

DROP POLICY IF EXISTS worker_visible ON pii_scan_runtime_contract;
CREATE POLICY worker_visible ON pii_scan_runtime_contract
    FOR ALL TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');
DROP POLICY IF EXISTS tenant_runtime_visible ON pii_scan_runtime_contract;
CREATE POLICY tenant_runtime_visible ON pii_scan_runtime_contract
    FOR SELECT TO postwave_app
    USING (NULLIF(current_setting('app.tenant_id', true), '') IS NOT NULL);

DROP POLICY IF EXISTS tenant_visible ON subscriber_pii_scan_states;
CREATE POLICY tenant_visible ON subscriber_pii_scan_states
    FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS worker_visible ON subscriber_pii_scan_states;
CREATE POLICY worker_visible ON subscriber_pii_scan_states
    FOR ALL TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

DROP POLICY IF EXISTS tenant_visible ON subscriber_pii_scan_intents;
CREATE POLICY tenant_visible ON subscriber_pii_scan_intents
    FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS worker_visible ON subscriber_pii_scan_intents;
CREATE POLICY worker_visible ON subscriber_pii_scan_intents
    FOR ALL TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_pii_scan_coverage TO postwave_app;
GRANT SELECT, UPDATE ON pii_scan_runtime_contract TO postwave_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON subscriber_pii_scan_states TO postwave_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON subscriber_pii_scan_intents TO postwave_app;

-- All-writer resource boundary for persisted profile documents. The scanner
-- deliberately handles at most 500 fields / 64 KiB per field, but those
-- transport caps are not sufficient if a writer can persist a compression
-- bomb, millions of keys, or pathological nesting first. New/changed JSON is
-- therefore rejected above a 2 MiB logical document, 1,024 children per
-- container, 16 levels, or 1,024 bytes per object key. Existing rows remain
-- deployable; the reader independently quarantines physically oversized
-- legacy values as truncated without serializing them.
CREATE OR REPLACE FUNCTION subscriber_pii_jsonb_depth_within(
    document jsonb,
    remaining_depth integer,
    max_children integer,
    max_key_bytes integer
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    child jsonb;
    child_key text;
    child_count integer := 0;
    kind text;
BEGIN
    IF remaining_depth < 1 THEN
        RETURN false;
    END IF;
    kind := jsonb_typeof(document);
    IF kind = 'object' THEN
        FOR child_key, child IN SELECT key, value FROM jsonb_each(document)
        LOOP
            child_count := child_count + 1;
            IF child_count > max_children OR octet_length(child_key) > max_key_bytes THEN
                RETURN false;
            END IF;
            IF NOT subscriber_pii_jsonb_depth_within(
                child, remaining_depth - 1, max_children, max_key_bytes
            ) THEN
                RETURN false;
            END IF;
        END LOOP;
    ELSIF kind = 'array' THEN
        FOR child IN SELECT value FROM jsonb_array_elements(document)
        LOOP
            child_count := child_count + 1;
            IF child_count > max_children THEN
                RETURN false;
            END IF;
            IF NOT subscriber_pii_jsonb_depth_within(
                child, remaining_depth - 1, max_children, max_key_bytes
            ) THEN
                RETURN false;
            END IF;
        END LOOP;
    END IF;
    RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION subscriber_pii_jsonb_within_limits(
    document jsonb,
    expected_kind text
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF jsonb_typeof(document) IS DISTINCT FROM expected_kind THEN
        RETURN false;
    END IF;
    -- Short-circuit before walking the tree. This serialization occurs only
    -- on INSERT or when that JSON column changes, never on analytics-only
    -- subscriber updates or worker reads.
    IF octet_length(document::text) > 2097152 THEN
        RETURN false;
    END IF;
    RETURN subscriber_pii_jsonb_depth_within(document, 16, 1024, 1024);
END;
$$;

CREATE OR REPLACE FUNCTION subscriber_pii_advance_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF TG_OP = 'INSERT'
       OR NEW.custom_fields IS DISTINCT FROM OLD.custom_fields
       OR NEW.merge_fields IS DISTINCT FROM OLD.merge_fields
       OR NEW.groups IS DISTINCT FROM OLD.groups
       OR NEW.gdpr_permissions IS DISTINCT FROM OLD.gdpr_permissions
       OR NEW.activity_summary IS DISTINCT FROM OLD.activity_summary
    THEN
        IF NOT subscriber_pii_jsonb_within_limits(NEW.custom_fields, 'object')
           OR NOT subscriber_pii_jsonb_within_limits(NEW.merge_fields, 'object')
           OR NOT subscriber_pii_jsonb_within_limits(NEW.groups, 'array')
           OR NOT subscriber_pii_jsonb_within_limits(NEW.gdpr_permissions, 'array')
           OR NOT subscriber_pii_jsonb_within_limits(NEW.activity_summary, 'object')
        THEN
            RAISE EXCEPTION 'subscriber profile JSON exceeds the durable PII projection boundary'
                USING ERRCODE = 'check_violation',
                      CONSTRAINT = 'subscribers_pii_projection_json_bounds';
        END IF;
    END IF;
    IF TG_OP = 'INSERT' OR NEW.tags IS DISTINCT FROM OLD.tags THEN
        IF cardinality(NEW.tags) > 1024
           OR COALESCE((
               SELECT sum(octet_length(tag)) > 2097152
                 FROM unnest(NEW.tags) tag
           ), false)
           OR EXISTS (
               SELECT 1 FROM unnest(NEW.tags) tag
                WHERE octet_length(tag) > 262144
           )
        THEN
            RAISE EXCEPTION 'subscriber tags exceed the durable PII projection boundary'
                USING ERRCODE = 'check_violation',
                      CONSTRAINT = 'subscribers_pii_projection_tags_bounds';
        END IF;
    END IF;
    IF TG_OP = 'INSERT'
       OR NEW.first_name IS DISTINCT FROM OLD.first_name
       OR NEW.last_name IS DISTINCT FROM OLD.last_name
       OR NEW.full_name IS DISTINCT FROM OLD.full_name
       OR NEW.display_name IS DISTINCT FROM OLD.display_name
       OR NEW.unsubscribe_reason IS DISTINCT FROM OLD.unsubscribe_reason
       OR NEW.source_id IS DISTINCT FROM OLD.source_id
       OR NEW.source_platform IS DISTINCT FROM OLD.source_platform
       OR NEW.external_id IS DISTINCT FROM OLD.external_id
       OR NEW.timezone IS DISTINCT FROM OLD.timezone
       OR NEW.locale IS DISTINCT FROM OLD.locale
       OR NEW.language IS DISTINCT FROM OLD.language
       OR NEW.country IS DISTINCT FROM OLD.country
       OR NEW.region IS DISTINCT FROM OLD.region
    THEN
        IF octet_length(COALESCE(NEW.first_name, '')) > 262144
           OR octet_length(COALESCE(NEW.last_name, '')) > 262144
           OR octet_length(COALESCE(NEW.full_name, '')) > 262144
           OR octet_length(COALESCE(NEW.display_name, '')) > 262144
           OR octet_length(COALESCE(NEW.unsubscribe_reason, '')) > 262144
           OR octet_length(COALESCE(NEW.source_id, '')) > 262144
           OR octet_length(COALESCE(NEW.source_platform, '')) > 262144
           OR octet_length(COALESCE(NEW.external_id, '')) > 262144
           OR octet_length(COALESCE(NEW.timezone, '')) > 262144
           OR octet_length(COALESCE(NEW.locale, '')) > 262144
           OR octet_length(COALESCE(NEW.language, '')) > 262144
           OR octet_length(COALESCE(NEW.country, '')) > 262144
           OR octet_length(COALESCE(NEW.region, '')) > 262144
        THEN
            RAISE EXCEPTION 'subscriber text exceeds the durable PII projection boundary'
                USING ERRCODE = 'check_violation',
                      CONSTRAINT = 'subscribers_pii_projection_text_bounds';
        END IF;
    END IF;

    IF TG_OP = 'INSERT' THEN
        -- Callers cannot forge a future coverage watermark on insert.
        NEW.pii_scan_revision := 1;
    ELSE
        -- The allow-list is the same persisted Shadow-PII inventory projected by
        -- LoadSubscriberSnapshot. High-frequency computed writes (engagement
        -- scoring, analytics timestamps, delivery counters, and similar state)
        -- must not continuously rescan an otherwise unchanged subscriber.
        IF NEW.custom_fields IS DISTINCT FROM OLD.custom_fields
           OR NEW.merge_fields IS DISTINCT FROM OLD.merge_fields
           OR NEW.first_name IS DISTINCT FROM OLD.first_name
           OR NEW.last_name IS DISTINCT FROM OLD.last_name
           OR NEW.full_name IS DISTINCT FROM OLD.full_name
           OR NEW.display_name IS DISTINCT FROM OLD.display_name
           OR NEW.unsubscribe_reason IS DISTINCT FROM OLD.unsubscribe_reason
           OR NEW.tags IS DISTINCT FROM OLD.tags
           OR NEW.groups IS DISTINCT FROM OLD.groups
           OR NEW.gdpr_permissions IS DISTINCT FROM OLD.gdpr_permissions
           OR NEW.activity_summary IS DISTINCT FROM OLD.activity_summary
           OR NEW.source_id IS DISTINCT FROM OLD.source_id
           OR NEW.source_platform IS DISTINCT FROM OLD.source_platform
           OR NEW.external_id IS DISTINCT FROM OLD.external_id
           OR NEW.timezone IS DISTINCT FROM OLD.timezone
           OR NEW.locale IS DISTINCT FROM OLD.locale
           OR NEW.language IS DISTINCT FROM OLD.language
           OR NEW.country IS DISTINCT FROM OLD.country
           OR NEW.region IS DISTINCT FROM OLD.region
        THEN
            NEW.pii_scan_revision := GREATEST(OLD.pii_scan_revision, 1) + 1;
        ELSE
            NEW.pii_scan_revision := GREATEST(OLD.pii_scan_revision, 1);
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION subscriber_pii_enqueue_statement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    write_token uuid;
    update_is_relevant boolean := true;
BEGIN
    -- Computed/analytics-only UPDATE statements do not advance the revision and
    -- can return before any tenant/config fence. INSERT is always relevant. The
    -- OLD transition relation exists only for the UPDATE trigger, so keep this
    -- fixed, non-user-controlled query dynamic: PostgreSQL otherwise resolves
    -- old_rows while planning an INSERT invocation and rejects the statement.
    IF TG_OP = 'UPDATE' THEN
        EXECUTE $query$
            SELECT EXISTS (
                SELECT 1
                  FROM new_rows rows
                  JOIN old_rows old
                    ON old.tenant_id = rows.tenant_id AND old.id = rows.id
                 WHERE GREATEST(rows.pii_scan_revision, 1)
                     > GREATEST(old.pii_scan_revision, 1)
                 LIMIT 1
            )
        $query$ INTO update_is_relevant;
        IF NOT update_is_relevant THEN
            RETURN NULL;
        END IF;
    END IF;

    -- Fence every relevant write even while scanning is disabled. Existing
    -- config rows serialize with enable/disable through FOR SHARE. The tenant
    -- parent lock closes the no-config race: a concurrent config INSERT takes
    -- FOR UPDATE in its transition trigger and cannot reconcile until this
    -- writer commits. Shared tenant locks do not serialize subscriber writers.
    PERFORM tenant.id
      FROM public.tenants tenant
      JOIN (SELECT DISTINCT tenant_id FROM new_rows) changed
        ON changed.tenant_id = tenant.id
     ORDER BY tenant.id
     FOR KEY SHARE OF tenant;

    PERFORM config.tenant_id
      FROM public.tenant_pii_scan_config config
      JOIN (SELECT DISTINCT tenant_id FROM new_rows) changed
        ON changed.tenant_id = config.tenant_id
     ORDER BY config.tenant_id
     FOR SHARE OF config;

    -- Disabled/no-config writes allocate no token and execute no queue, state,
    -- or tenant-coverage mutation. A concurrent enable now runs either wholly
    -- before this check (so it queues below) or after commit (so reconciliation
    -- sees the subscriber).
    IF NOT EXISTS (
        SELECT 1
          FROM new_rows rows
          JOIN public.tenant_pii_scan_config config
            ON config.tenant_id = rows.tenant_id AND config.scan_enabled
          LEFT JOIN public.subscriber_pii_scan_states state
            ON state.tenant_id = rows.tenant_id AND state.subscriber_id = rows.id
         WHERE state.subscriber_id IS NULL
            OR GREATEST(rows.pii_scan_revision, 1) > state.observed_revision
         LIMIT 1
    ) THEN
        RETURN NULL;
    END IF;
    write_token := gen_random_uuid();

    -- Queue -> state -> coverage is the common mutation lock order used by the
    -- trigger and worker. The coverage row is touched once per changed tenant
    -- per statement, after set-based per-subscriber work. A reconciler holding
    -- the coverage lock sees the pre-write MVCC snapshot and the writer then
    -- commits snapshot_exact=false, preserving the exactness invariant without
    -- a per-row tenant hot lock.
    INSERT INTO public.subscriber_pii_scan_intents (
        tenant_id, subscriber_id, target_revision, target_generation,
        status, attempts, available_at, last_enqueued_at
    )
    SELECT rows.tenant_id, rows.id, GREATEST(rows.pii_scan_revision, 1),
           COALESCE(coverage.generation, 1),
           'pending', 0, now(), now()
      FROM new_rows rows
      JOIN public.tenant_pii_scan_config config
        ON config.tenant_id = rows.tenant_id AND config.scan_enabled
      LEFT JOIN public.tenant_pii_scan_coverage coverage
        ON coverage.tenant_id = rows.tenant_id
      LEFT JOIN public.subscriber_pii_scan_states state
        ON state.tenant_id = rows.tenant_id AND state.subscriber_id = rows.id
     WHERE state.subscriber_id IS NULL
        OR GREATEST(rows.pii_scan_revision, 1) > state.observed_revision
    ON CONFLICT (tenant_id, subscriber_id) DO UPDATE SET
        target_revision = GREATEST(
            public.subscriber_pii_scan_intents.target_revision,
            EXCLUDED.target_revision
        ),
        target_generation = GREATEST(
            public.subscriber_pii_scan_intents.target_generation,
            EXCLUDED.target_generation
        ),
        -- Preserve an active lease. Completion compares the claimed snapshot
        -- with the latest target and leaves the newer target pending.
        status = CASE
            WHEN public.subscriber_pii_scan_intents.status = 'leased'
                THEN 'leased'
            ELSE 'pending'
        END,
        attempts = CASE
            WHEN public.subscriber_pii_scan_intents.status = 'leased'
                THEN public.subscriber_pii_scan_intents.attempts
            ELSE 0
        END,
        available_at = CASE
            WHEN public.subscriber_pii_scan_intents.status = 'leased'
                THEN public.subscriber_pii_scan_intents.available_at
            ELSE now()
        END,
        lease_owner = CASE WHEN public.subscriber_pii_scan_intents.status = 'leased' THEN public.subscriber_pii_scan_intents.lease_owner ELSE NULL END,
        lease_token = CASE WHEN public.subscriber_pii_scan_intents.status = 'leased' THEN public.subscriber_pii_scan_intents.lease_token ELSE NULL END,
        lease_expires_at = CASE WHEN public.subscriber_pii_scan_intents.status = 'leased' THEN public.subscriber_pii_scan_intents.lease_expires_at ELSE NULL END,
        claimed_revision = CASE WHEN public.subscriber_pii_scan_intents.status = 'leased' THEN public.subscriber_pii_scan_intents.claimed_revision ELSE NULL END,
        claimed_generation = CASE WHEN public.subscriber_pii_scan_intents.status = 'leased' THEN public.subscriber_pii_scan_intents.claimed_generation ELSE NULL END,
        last_error_code = NULL,
        dead_lettered_at = NULL,
        last_enqueued_at = now(),
        updated_at = now();

    INSERT INTO public.subscriber_pii_scan_states (
        tenant_id, subscriber_id, observed_revision, state, last_observed_at,
        last_observed_write_token
    )
    SELECT rows.tenant_id, rows.id, GREATEST(rows.pii_scan_revision, 1), 'pending',
           statement_timestamp(), write_token
      FROM new_rows rows
      JOIN public.tenant_pii_scan_config config
        ON config.tenant_id = rows.tenant_id AND config.scan_enabled
      LEFT JOIN public.subscriber_pii_scan_states state
        ON state.tenant_id = rows.tenant_id AND state.subscriber_id = rows.id
     WHERE state.subscriber_id IS NULL
        OR GREATEST(rows.pii_scan_revision, 1) > state.observed_revision
    ON CONFLICT (tenant_id, subscriber_id) DO UPDATE SET
        coalesced_revisions = public.subscriber_pii_scan_states.coalesced_revisions + CASE
            WHEN public.subscriber_pii_scan_states.observed_revision < EXCLUDED.observed_revision
             AND public.subscriber_pii_scan_states.observed_revision > public.subscriber_pii_scan_states.scanned_revision
             AND NOT EXISTS (
                 SELECT 1
                   FROM public.subscriber_pii_scan_intents active
                  WHERE active.tenant_id = EXCLUDED.tenant_id
                    AND active.subscriber_id = EXCLUDED.subscriber_id
                    AND active.status = 'leased'
                    AND active.claimed_revision >= public.subscriber_pii_scan_states.observed_revision
             )
            THEN 1 ELSE 0
        END,
        observed_revision = GREATEST(
            public.subscriber_pii_scan_states.observed_revision,
            EXCLUDED.observed_revision
        ),
        state = CASE
            WHEN public.subscriber_pii_scan_states.state = 'leased' THEN 'leased'
            ELSE 'pending'
        END,
        last_observed_at = statement_timestamp(),
        last_observed_write_token = write_token,
        last_error_code = CASE
            WHEN public.subscriber_pii_scan_states.state = 'leased'
                THEN public.subscriber_pii_scan_states.last_error_code
            ELSE NULL
        END,
        updated_at = now();

    -- The early gate guarantees at least one qualifying row. Only tenants with
    -- state rows stamped by this invocation are dirtied below.
    INSERT INTO public.tenant_pii_scan_coverage (
        tenant_id, scan_enabled, generation, status, snapshot_exact,
        dirty_epoch, reconciliation_requested_at, last_observed_at
    )
    SELECT changed.tenant_id, true, 1, 'catching_up', false, 1, now(), now()
      FROM (
          SELECT DISTINCT rows.tenant_id
            FROM new_rows rows
            JOIN public.tenant_pii_scan_config config
              ON config.tenant_id = rows.tenant_id AND config.scan_enabled
            JOIN public.subscriber_pii_scan_states state
              ON state.tenant_id = rows.tenant_id AND state.subscriber_id = rows.id
             AND state.last_observed_write_token = write_token
           ORDER BY rows.tenant_id
      ) changed
    ON CONFLICT (tenant_id) DO UPDATE SET
        scan_enabled = true,
        status = CASE
            WHEN public.tenant_pii_scan_coverage.status = 'unavailable' THEN 'unavailable'
            ELSE 'catching_up'
        END,
        snapshot_exact = false,
        dirty_epoch = public.tenant_pii_scan_coverage.dirty_epoch + 1,
        reconciliation_requested_at = COALESCE(public.tenant_pii_scan_coverage.reconciliation_requested_at, now()),
        last_observed_at = now(),
        updated_at = now();

    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION tenant_pii_scan_config_coverage_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    row_tenant_id uuid;
    was_enabled boolean := false;
    now_enabled boolean := false;
    active_scan_contract text;
    runtime_availability text := 'unknown';
BEGIN
    IF TG_OP = 'DELETE' THEN
        row_tenant_id := OLD.tenant_id;
        was_enabled := OLD.scan_enabled;
        now_enabled := false;
    ELSE
        row_tenant_id := NEW.tenant_id;
        now_enabled := NEW.scan_enabled;
    END IF;
    IF TG_OP = 'UPDATE' THEN
        was_enabled := OLD.scan_enabled;
    END IF;
    IF TG_OP = 'INSERT' THEN
        -- A subscriber write that started while no config existed holds the
        -- matching tenant row FOR KEY SHARE. Wait for it to commit before the
        -- first enable can reconcile and publish an exact snapshot.
        PERFORM tenant.id
          FROM public.tenants tenant
         WHERE tenant.id = row_tenant_id
         FOR UPDATE;
    END IF;
    IF now_enabled THEN
        -- Bind newly enabled/re-enabled tenants to the deployment-wide
        -- executable contract inside the config transaction. This means the
        -- worker's steady-state tick only repairs indexed unavailable rows;
        -- it never needs an O(tenant-count) mismatch sweep.
        SELECT runtime.scan_contract, runtime.availability_status
          INTO active_scan_contract, runtime_availability
          FROM public.pii_scan_runtime_contract runtime
         WHERE runtime.singleton
         FOR SHARE;
    END IF;

    -- Revoke active row leases before disabling coverage. This keeps the
    -- queue -> state -> coverage mutation order used by claim/completion and
    -- makes opt-out linearizable: an old worker cannot renew or commit after
    -- this config transaction. Disabling is not a scan failure, so return the
    -- claim attempt to the retry budget.
    IF NOT now_enabled THEN
        -- Cross-tenant claimers take the matching transaction-level shared
        -- fence before touching an intent. Taking the exclusive side here
        -- closes the uncommitted-claim visibility race: pre-existing claims
        -- commit and become revocable before this continues, while new claims
        -- wait until the disabled config/coverage state is committed.
        PERFORM pg_advisory_xact_lock(
            hashtextextended(row_tenant_id::text, 1762)
        );

        WITH locked AS (
            SELECT intent.tenant_id, intent.subscriber_id
              FROM public.subscriber_pii_scan_intents intent
             WHERE intent.tenant_id = row_tenant_id
               AND intent.status = 'leased'
             ORDER BY intent.available_at, intent.first_enqueued_at,
                      intent.tenant_id, intent.subscriber_id
             FOR UPDATE OF intent
        )
        UPDATE public.subscriber_pii_scan_intents intent
           SET status = 'pending',
               attempts = GREATEST(intent.attempts - 1, 0),
               available_at = now(),
               lease_owner = NULL,
               lease_token = NULL,
               lease_expires_at = NULL,
               claimed_revision = NULL,
               claimed_generation = NULL,
               last_error_code = NULL,
               dead_lettered_at = NULL,
               updated_at = now()
          FROM locked
         WHERE intent.tenant_id = locked.tenant_id
           AND intent.subscriber_id = locked.subscriber_id;

        UPDATE public.subscriber_pii_scan_states state
           SET state = 'pending',
               last_error_code = NULL,
               updated_at = now()
         WHERE state.tenant_id = row_tenant_id
           AND state.state = 'leased';
    END IF;

    INSERT INTO public.tenant_pii_scan_coverage (
        tenant_id, scan_enabled, generation, scan_contract, status, snapshot_exact,
        enable_requested_at, disabled_at, reconciliation_requested_at
    )
    VALUES (
        row_tenant_id,
        now_enabled,
        CASE WHEN now_enabled THEN 1 ELSE 0 END,
        active_scan_contract,
        CASE
            WHEN NOT now_enabled THEN 'disabled'
            WHEN runtime_availability = 'unavailable' THEN 'unavailable'
            ELSE 'backfill_pending'
        END,
        false,
        CASE WHEN now_enabled THEN now() ELSE NULL END,
        CASE WHEN now_enabled THEN NULL ELSE now() END,
        CASE WHEN now_enabled THEN now() ELSE NULL END
    )
    ON CONFLICT (tenant_id) DO UPDATE SET
        scan_enabled = now_enabled,
        scan_contract = CASE
            WHEN now_enabled THEN active_scan_contract
            ELSE public.tenant_pii_scan_coverage.scan_contract
        END,
        generation = CASE
            WHEN now_enabled AND NOT was_enabled
                THEN public.tenant_pii_scan_coverage.generation + 1
            ELSE public.tenant_pii_scan_coverage.generation
        END,
        status = CASE
            WHEN NOT now_enabled THEN 'disabled'
            WHEN runtime_availability = 'unavailable' THEN 'unavailable'
            ELSE 'backfill_pending'
        END,
        snapshot_exact = false,
        dirty_epoch = public.tenant_pii_scan_coverage.dirty_epoch + 1,
        enable_requested_at = CASE
            WHEN now_enabled AND NOT was_enabled THEN now()
            ELSE public.tenant_pii_scan_coverage.enable_requested_at
        END,
        disabled_at = CASE WHEN now_enabled THEN NULL ELSE now() END,
        backfill_started_at = CASE
            WHEN now_enabled AND NOT was_enabled THEN NULL
            ELSE public.tenant_pii_scan_coverage.backfill_started_at
        END,
        backfill_completed_at = CASE
            WHEN now_enabled AND NOT was_enabled THEN NULL
            ELSE public.tenant_pii_scan_coverage.backfill_completed_at
        END,
        reconciliation_requested_at = CASE
            WHEN now_enabled THEN now()
            ELSE public.tenant_pii_scan_coverage.reconciliation_requested_at
        END,
        reconcile_lease_owner = NULL,
        reconcile_lease_token = NULL,
        reconcile_lease_expires_at = NULL,
        reconcile_cursor = CASE
            WHEN now_enabled AND was_enabled THEN public.tenant_pii_scan_coverage.reconcile_cursor
            ELSE NULL
        END,
        updated_at = now();

    -- Disabling does not delete queued evidence. Revoked work resumes only
    -- after a new enabled generation has been seeded.
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION subscriber_pii_delete_statement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    -- Composite FKs have already cascaded state/intents. Lock tenant coverage
    -- in stable order and invalidate exact totals once per affected tenant,
    -- preserving unavailable as a fail-closed systemic state.
    WITH changed AS (
        SELECT coverage.tenant_id
          FROM public.tenant_pii_scan_coverage coverage
          JOIN (SELECT DISTINCT tenant_id FROM old_rows) deleted
            ON deleted.tenant_id = coverage.tenant_id
         WHERE coverage.scan_enabled
         ORDER BY coverage.tenant_id
         FOR UPDATE OF coverage
    )
    UPDATE public.tenant_pii_scan_coverage coverage
       SET status = CASE
               WHEN coverage.status = 'unavailable' THEN 'unavailable'
               ELSE 'catching_up'
           END,
           snapshot_exact = false,
           dirty_epoch = coverage.dirty_epoch + 1,
           reconciliation_requested_at = CASE
               WHEN coverage.status = 'unavailable'
                   THEN coverage.reconciliation_requested_at
               ELSE now()
           END,
           last_observed_at = now(),
           updated_at = now()
      FROM changed
     WHERE coverage.tenant_id = changed.tenant_id;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION tenant_pii_field_policy_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    row_tenant_id uuid;
    enabled boolean := false;
BEGIN
    row_tenant_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
    SELECT COALESCE((
        SELECT config.scan_enabled
          FROM public.tenant_pii_scan_config config
         WHERE config.tenant_id = row_tenant_id
    ), false)
      INTO enabled;

    -- Classification changes while disabled require no row-level bookkeeping;
    -- the next enable generation performs a bounded full reconciliation.
    IF NOT enabled THEN
        IF TG_OP = 'DELETE' THEN
            RETURN OLD;
        END IF;
        RETURN NEW;
    END IF;

    INSERT INTO public.tenant_pii_scan_coverage (
        tenant_id, scan_enabled, generation, status, snapshot_exact,
        reconciliation_requested_at
    )
    VALUES (
        row_tenant_id, true, 1, 'backfill_pending', false, now()
    )
    ON CONFLICT (tenant_id) DO UPDATE SET
        generation = public.tenant_pii_scan_coverage.generation + 1,
        status = CASE
            WHEN public.tenant_pii_scan_coverage.scan_enabled THEN 'backfill_pending'
            ELSE 'disabled'
        END,
        snapshot_exact = false,
        dirty_epoch = public.tenant_pii_scan_coverage.dirty_epoch + 1,
        reconciliation_requested_at = CASE
            WHEN public.tenant_pii_scan_coverage.scan_enabled THEN now()
            ELSE public.tenant_pii_scan_coverage.reconciliation_requested_at
        END,
        backfill_completed_at = NULL,
        reconcile_lease_owner = NULL,
        reconcile_lease_token = NULL,
        reconcile_lease_expires_at = NULL,
        reconcile_cursor = NULL,
        updated_at = now();

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION subscriber_pii_enqueue_statement() FROM PUBLIC;
REVOKE ALL ON FUNCTION subscriber_pii_delete_statement() FROM PUBLIC;
REVOKE ALL ON FUNCTION tenant_pii_scan_config_coverage_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION tenant_pii_field_policy_changed() FROM PUBLIC;

DROP TRIGGER IF EXISTS subscribers_pii_advance_revision ON subscribers;
CREATE TRIGGER subscribers_pii_advance_revision
    BEFORE INSERT OR UPDATE ON subscribers
    FOR EACH ROW EXECUTE FUNCTION subscriber_pii_advance_revision();

DROP TRIGGER IF EXISTS subscribers_pii_enqueue_revision ON subscribers;
DROP TRIGGER IF EXISTS subscribers_pii_enqueue_insert ON subscribers;
DROP TRIGGER IF EXISTS subscribers_pii_enqueue_update ON subscribers;
DROP TRIGGER IF EXISTS subscribers_pii_delete ON subscribers;
CREATE TRIGGER subscribers_pii_enqueue_insert
    AFTER INSERT ON subscribers
    REFERENCING NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION subscriber_pii_enqueue_statement();
CREATE TRIGGER subscribers_pii_enqueue_update
    AFTER UPDATE ON subscribers
    REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION subscriber_pii_enqueue_statement();
CREATE TRIGGER subscribers_pii_delete
    AFTER DELETE ON subscribers
    REFERENCING OLD TABLE AS old_rows
    FOR EACH STATEMENT EXECUTE FUNCTION subscriber_pii_delete_statement();

DROP TRIGGER IF EXISTS tenant_pii_scan_config_coverage_transition ON tenant_pii_scan_config;
DROP TRIGGER IF EXISTS tenant_pii_scan_config_coverage_insert_delete ON tenant_pii_scan_config;
DROP TRIGGER IF EXISTS tenant_pii_scan_config_coverage_update ON tenant_pii_scan_config;
CREATE TRIGGER tenant_pii_scan_config_coverage_insert_delete
    AFTER INSERT OR DELETE ON tenant_pii_scan_config
    FOR EACH ROW EXECUTE FUNCTION tenant_pii_scan_config_coverage_transition();
CREATE TRIGGER tenant_pii_scan_config_coverage_update
    AFTER UPDATE OF scan_enabled ON tenant_pii_scan_config
    FOR EACH ROW
    WHEN (OLD.scan_enabled IS DISTINCT FROM NEW.scan_enabled)
    EXECUTE FUNCTION tenant_pii_scan_config_coverage_transition();

DROP TRIGGER IF EXISTS tenant_custom_fields_pii_policy_changed ON tenant_custom_fields;
DROP TRIGGER IF EXISTS tenant_custom_fields_pii_policy_insert_delete ON tenant_custom_fields;
DROP TRIGGER IF EXISTS tenant_custom_fields_pii_policy_update ON tenant_custom_fields;
CREATE TRIGGER tenant_custom_fields_pii_policy_insert_delete
    AFTER INSERT OR DELETE ON tenant_custom_fields
    FOR EACH ROW EXECUTE FUNCTION tenant_pii_field_policy_changed();
CREATE TRIGGER tenant_custom_fields_pii_policy_update
    AFTER UPDATE OF key, config ON tenant_custom_fields
    FOR EACH ROW
    WHEN (OLD.key IS DISTINCT FROM NEW.key OR OLD.config IS DISTINCT FROM NEW.config)
    EXECUTE FUNCTION tenant_pii_field_policy_changed();

-- Existing opt-ins need a resumable current-profile reconciliation. This is
-- intentionally O(tenant count), not O(subscriber count), inside migration.
INSERT INTO tenant_pii_scan_coverage (
    tenant_id, scan_enabled, generation, status, snapshot_exact,
    enable_requested_at, disabled_at, reconciliation_requested_at
)
SELECT config.tenant_id,
       config.scan_enabled,
       CASE WHEN config.scan_enabled THEN 1 ELSE 0 END,
       CASE WHEN config.scan_enabled THEN 'backfill_pending' ELSE 'disabled' END,
       false,
       CASE WHEN config.scan_enabled THEN COALESCE(config.updated_at, now()) ELSE NULL END,
       CASE WHEN config.scan_enabled THEN NULL ELSE COALESCE(config.updated_at, now()) END,
       CASE WHEN config.scan_enabled THEN now() ELSE NULL END
  FROM tenant_pii_scan_config config
ON CONFLICT (tenant_id) DO NOTHING;

COMMIT;

SET lock_timeout = '5s';
SET statement_timeout = '15min';
ALTER TABLE subscribers
    VALIDATE CONSTRAINT subscribers_pii_scan_revision_check;
ALTER TABLE subscriber_pii_scan_intents
    VALIDATE CONSTRAINT subscriber_pii_scan_intents_subscriber_fk;
ALTER TABLE subscriber_pii_scan_states
    VALIDATE CONSTRAINT subscriber_pii_scan_states_subscriber_fk;
RESET statement_timeout;
RESET lock_timeout;
