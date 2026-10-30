-- 2007_webhook_playground_fire_receipts.sql
--
-- A simulator fire is a real external side effect. Reserve a caller-known fire
-- identity before dispatch so a lost connection can be reconciled without
-- sending a second event. The inspection receipt is envelope-encrypted; after
-- the tenant retention window only the payload-free identity fence remains.
--
-- migration-execution: phased
-- rollback-strategy: expand-contract
-- rollback-details: Roll application images back first, but keep the online
-- unique index/constraint, config_version column, compatibility trigger, and
-- fire ledger. Dropping any of them while either old or new writers remain can
-- reopen duplicate dispatch or stale-snapshot races. A later contract migration
-- may remove the legacy auto-bump branch only after every pre-2007 API, worker,
-- maintenance job, and ad-hoc writer is drained and that absence is attested.
--
-- Rollout/lock sequence:
--   1. Run duplicate/index-definition preflight on a production-sized restore.
--   2. This first phase builds the parent ownership key CONCURRENTLY. An
--      interrupted build is repaired/attested by the migration runner.
--   3. The transactional phase uses lock_timeout=5s. A timeout is a clean stop:
--      do not raise/disable it under load; let traffic drain and retry the exact
--      immutable migration so the valid concurrent index is reused.
--   4. Deploy config_version-aware writers, drain every older API/worker task,
--      and prove no old task definition or maintenance writer remains before a
--      future strict contract migration removes the compatibility branch.

-- PostgreSQL requires a unique key with the same column order as the
-- tenant-composite foreign key below. Build it online before taking the brief
-- lock needed to adopt it as a constraint; id remains the global primary key.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS outbound_webhooks_tenant_id_id_key
    ON outbound_webhooks (tenant_id,id);

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- updated_at also records delivery health and therefore cannot be used as an
-- endpoint-configuration revision. Writers increment config_version only when
-- an actual delivery capability changes.
ALTER TABLE outbound_webhooks
    ADD COLUMN config_version bigint NOT NULL DEFAULT 1 CHECK (
        config_version BETWEEN 1 AND 9007199254740991
    );

-- Adopting a valid concurrent index is metadata-only. Do not replace this with
-- `UNIQUE (tenant_id,id)`: that form builds a non-concurrent index while holding
-- the table lock for the duration of the scan.
ALTER TABLE outbound_webhooks
    ADD CONSTRAINT outbound_webhooks_tenant_id_id_key
    UNIQUE USING INDEX outbound_webhooks_tenant_id_id_key;

-- Make config_version a database invariant rather than an application
-- convention without making migrate-before-roll unsafe. A pre-2007 writer does
-- not mention config_version, so PostgreSQL presents OLD.config_version in NEW;
-- the compatibility branch advances it exactly once. Updated writers may
-- advance it explicitly by exactly one. Every other transition still fails.
-- Keep the compatibility branch through rollback and old-writer drain; remove
-- it only in a later, separately attested contract migration.
CREATE OR REPLACE FUNCTION guard_outbound_webhook_config_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
    capability_changed boolean;
BEGIN
    capability_changed :=
        -- Once an endpoint is already tombstoned, later ciphertext cleanup is
        -- not a delivery capability. The delete transition itself still is.
        (OLD.deleted_at IS NULL OR NEW.deleted_at IS NULL)
        AND (
            NEW.url IS DISTINCT FROM OLD.url OR
            NEW.events IS DISTINCT FROM OLD.events OR
            NEW.active IS DISTINCT FROM OLD.active OR
            NEW.secret_envelope IS DISTINCT FROM OLD.secret_envelope OR
            NEW.signing_algorithm IS DISTINCT FROM OLD.signing_algorithm OR
            NEW.signing_public_key IS DISTINCT FROM OLD.signing_public_key OR
            NEW.secondary_secret_envelope IS DISTINCT FROM OLD.secondary_secret_envelope OR
            NEW.secondary_public_key IS DISTINCT FROM OLD.secondary_public_key OR
            NEW.secondary_expires_at IS DISTINCT FROM OLD.secondary_expires_at OR
            NEW.environment IS DISTINCT FROM OLD.environment OR
            NEW.list_id IS DISTINCT FROM OLD.list_id OR
            NEW.auth_config IS DISTINCT FROM OLD.auth_config OR
            NEW.auth_config_envelope IS DISTINCT FROM OLD.auth_config_envelope OR
            NEW.auth_config_state IS DISTINCT FROM OLD.auth_config_state OR
            NEW.auth_config_restore_active IS DISTINCT FROM OLD.auth_config_restore_active OR
            NEW.url_envelope IS DISTINCT FROM OLD.url_envelope OR
            NEW.url_state IS DISTINCT FROM OLD.url_state OR
            NEW.url_restore_active IS DISTINCT FROM OLD.url_restore_active OR
            NEW.filter_expression IS DISTINCT FROM OLD.filter_expression OR
            NEW.transform_template IS DISTINCT FROM OLD.transform_template OR
            NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
        );

    IF capability_changed THEN
        IF NEW.config_version IS NOT DISTINCT FROM OLD.config_version THEN
            -- Rolling-deploy bridge for writers built before config_version
            -- existed. The database, not an application convention, preserves
            -- the monotonic revision invariant during migrate-before-roll.
            NEW.config_version := OLD.config_version + 1;
        ELSIF NEW.config_version IS DISTINCT FROM OLD.config_version + 1 THEN
            RAISE EXCEPTION 'outbound webhook capability mutation must increment config_version exactly once';
        END IF;
    ELSIF NEW.config_version IS DISTINCT FROM OLD.config_version THEN
        RAISE EXCEPTION 'outbound webhook config_version changed without a capability mutation';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER outbound_webhooks_guard_config_version
    BEFORE UPDATE ON outbound_webhooks
    FOR EACH ROW EXECUTE FUNCTION guard_outbound_webhook_config_version();

CREATE TABLE outbound_webhook_playground_fires (
    tenant_id                  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    fire_id                    uuid NOT NULL,
    -- webhook_id is immutable historical identity. webhook_ref_id is the live
    -- integrity edge and is the only column nulled if the endpoint is removed.
    webhook_id                 uuid NOT NULL,
    webhook_ref_id             uuid,
    config_version             bigint NOT NULL CHECK (
        config_version BETWEEN 1 AND 9007199254740991
    ),
    idempotency_key_sha256     text NOT NULL CHECK (idempotency_key_sha256 ~ '^[0-9a-f]{64}$'),
    request_sha256             text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
    event_type                 text NOT NULL CHECK (
        octet_length(event_type) BETWEEN 1 AND 200
        AND event_type = btrim(event_type)
    ),
    state                      text NOT NULL DEFAULT 'pending'
                               CHECK (state IN ('pending','completed','ambiguous','receipt_expired')),
    outcome                    text CHECK (
        outcome IS NULL OR outcome IN ('filtered','receiver_responded','transport_ambiguous')
    ),
    receiver_status_code       integer CHECK (
        receiver_status_code IS NULL OR receiver_status_code BETWEEN 0 AND 599
    ),
    response_body_truncated    boolean NOT NULL DEFAULT false,
    receipt_envelope           bytea CHECK (
        receipt_envelope IS NULL OR octet_length(receipt_envelope) BETWEEN 1 AND 2097152
    ),
    receipt_sha256             text CHECK (
        receipt_sha256 IS NULL OR receipt_sha256 ~ '^[0-9a-f]{64}$'
    ),
    -- Searchable privacy locator for conventional email addresses found in the
    -- exact encrypted receipt plaintext. It contains digests only, is capped,
    -- and is cryptoshredded with the receipt; it is never part of the permanent
    -- side-effect identity fence.
    subject_email_sha256s      text[] NOT NULL DEFAULT '{}'::text[] CHECK (
        cardinality(subject_email_sha256s) <= 512
        AND array_position(subject_email_sha256s, NULL) IS NULL
        AND COALESCE(array_ndims(subject_email_sha256s), 1) = 1
        AND array_to_string(subject_email_sha256s, ',') ~ '^([0-9a-f]{64})(,[0-9a-f]{64})*$|^$'
    ),
    created_at                 timestamptz NOT NULL DEFAULT now(),
    completed_at               timestamptz,
    receipt_expired_at         timestamptz,
    CONSTRAINT outbound_webhook_playground_fires_pkey
        PRIMARY KEY (tenant_id,fire_id),
    CONSTRAINT outbound_webhook_playground_fire_key_unique
        UNIQUE (tenant_id,idempotency_key_sha256),
    CONSTRAINT outbound_webhook_playground_fire_webhook_ref_matches
        CHECK (webhook_ref_id IS NULL OR webhook_ref_id=webhook_id),
    CONSTRAINT outbound_webhook_playground_fire_webhook_tenant_fkey
        FOREIGN KEY (tenant_id,webhook_ref_id)
        REFERENCES outbound_webhooks(tenant_id,id)
        ON DELETE SET NULL (webhook_ref_id),
    CONSTRAINT outbound_webhook_playground_fire_state_consistency CHECK (
        (state='pending' AND outcome IS NULL AND receiver_status_code IS NULL
            AND receipt_envelope IS NOT NULL AND receipt_sha256 IS NOT NULL
            AND completed_at IS NULL AND receipt_expired_at IS NULL
            AND response_body_truncated=false)
        OR
        (state='completed' AND outcome IN ('filtered','receiver_responded')
            AND receiver_status_code IS NOT NULL AND receipt_envelope IS NOT NULL
            AND receipt_sha256 IS NOT NULL AND completed_at IS NOT NULL
            AND receipt_expired_at IS NULL)
        OR
        (state='ambiguous' AND outcome='transport_ambiguous'
            AND receiver_status_code=0 AND receipt_envelope IS NOT NULL
            AND receipt_sha256 IS NOT NULL AND completed_at IS NOT NULL
            AND receipt_expired_at IS NULL)
        OR
        (state='receipt_expired' AND outcome IS NOT NULL
            AND receiver_status_code IS NOT NULL AND receipt_envelope IS NULL
            AND receipt_sha256 IS NULL AND completed_at IS NOT NULL
            AND receipt_expired_at IS NOT NULL
            AND cardinality(subject_email_sha256s)=0)
    ),
    CONSTRAINT outbound_webhook_playground_fire_outcome_status CHECK (
        (outcome IS NULL)
        OR (outcome='filtered' AND receiver_status_code=204)
        OR (outcome='receiver_responded' AND receiver_status_code BETWEEN 100 AND 599)
        OR (outcome='transport_ambiguous' AND receiver_status_code=0)
    )
);

CREATE INDEX outbound_webhook_playground_fires_recent_idx
    ON outbound_webhook_playground_fires (tenant_id,created_at DESC,fire_id);
CREATE INDEX outbound_webhook_playground_fires_webhook_idx
    ON outbound_webhook_playground_fires (tenant_id,webhook_id,created_at DESC);
-- Child-side support for the composite ON DELETE SET NULL lookup. The
-- permanent fence grows monotonically, so allowing endpoint purge/tenant
-- cascade to scan the whole ledger would become an unbounded lock hazard.
CREATE INDEX outbound_webhook_playground_fires_webhook_ref_idx
    ON outbound_webhook_playground_fires (tenant_id,webhook_ref_id)
    WHERE webhook_ref_id IS NOT NULL;
CREATE INDEX outbound_webhook_playground_fires_terminal_retention_idx
    ON outbound_webhook_playground_fires (tenant_id,created_at)
    WHERE state IN ('completed','ambiguous');
CREATE INDEX outbound_webhook_playground_fires_stale_pending_idx
    ON outbound_webhook_playground_fires (tenant_id,created_at)
    WHERE state='pending';
CREATE INDEX outbound_webhook_playground_fires_subject_email_idx
    ON outbound_webhook_playground_fires USING gin (subject_email_sha256s)
    WHERE cardinality(subject_email_sha256s) > 0;

CREATE OR REPLACE FUNCTION guard_outbound_webhook_playground_fire_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF NEW.webhook_ref_id IS NULL OR
       NEW.webhook_ref_id IS DISTINCT FROM NEW.webhook_id THEN
        RAISE EXCEPTION 'webhook playground fire requires a live tenant-scoped endpoint reference';
    END IF;
    RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION guard_outbound_webhook_playground_fire_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF NEW.fire_id IS DISTINCT FROM OLD.fire_id OR
       NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR
       NEW.webhook_id IS DISTINCT FROM OLD.webhook_id OR
       NEW.config_version IS DISTINCT FROM OLD.config_version OR
       NEW.idempotency_key_sha256 IS DISTINCT FROM OLD.idempotency_key_sha256 OR
       NEW.request_sha256 IS DISTINCT FROM OLD.request_sha256 OR
       NEW.event_type IS DISTINCT FROM OLD.event_type OR
       NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'webhook playground fire identity is immutable';
    END IF;

    -- The live endpoint reference may only disappear; historical webhook_id
    -- remains immutable. This also permits the FK's ON DELETE SET NULL action.
    IF NEW.webhook_ref_id IS DISTINCT FROM OLD.webhook_ref_id AND NOT (
        OLD.webhook_ref_id=OLD.webhook_id AND NEW.webhook_ref_id IS NULL
    ) THEN
        RAISE EXCEPTION 'invalid webhook playground fire reference transition';
    END IF;
    IF NEW.webhook_ref_id IS DISTINCT FROM OLD.webhook_ref_id AND EXISTS (
        SELECT 1 FROM public.outbound_webhooks
         WHERE tenant_id=OLD.tenant_id AND id=OLD.webhook_ref_id
    ) THEN
        RAISE EXCEPTION 'live webhook playground fire reference is immutable';
    END IF;

    IF NEW.state IS DISTINCT FROM OLD.state OR
       NEW.outcome IS DISTINCT FROM OLD.outcome OR
       NEW.receiver_status_code IS DISTINCT FROM OLD.receiver_status_code OR
       NEW.response_body_truncated IS DISTINCT FROM OLD.response_body_truncated OR
       NEW.receipt_envelope IS DISTINCT FROM OLD.receipt_envelope OR
       NEW.receipt_sha256 IS DISTINCT FROM OLD.receipt_sha256 OR
       NEW.subject_email_sha256s IS DISTINCT FROM OLD.subject_email_sha256s OR
       NEW.completed_at IS DISTINCT FROM OLD.completed_at OR
       NEW.receipt_expired_at IS DISTINCT FROM OLD.receipt_expired_at THEN
        IF NOT (
            -- Completion replaces the reserved envelope, digest, and email
            -- locator as one unit. The terminal locator is the exact set found
            -- in the new terminal plaintext; it must not retain stale hashes
            -- merely because they appeared in the reserved skeleton.
            (OLD.state='pending' AND NEW.state IN ('completed','ambiguous'))
            OR
    -- Supported email-address erasure may race an in-flight receiver call.
    -- It reaches only receipts whose conventional-email locator matches the
    -- requested/current alias. Treat such an unresolved fire conservatively as
    -- transport-ambiguous, consume it permanently, and wipe only its private
    -- receipt/locator.
            (OLD.state='pending' AND NEW.state='receipt_expired'
                AND NEW.outcome='transport_ambiguous'
                AND NEW.receiver_status_code=0
                AND NEW.response_body_truncated=false
                AND NEW.completed_at IS NOT NULL
                AND NEW.receipt_envelope IS NULL AND NEW.receipt_sha256 IS NULL
                AND cardinality(NEW.subject_email_sha256s)=0
                AND NEW.receipt_expired_at IS NOT NULL)
            OR
            (OLD.state IN ('completed','ambiguous') AND NEW.state='receipt_expired'
                AND NEW.outcome IS NOT DISTINCT FROM OLD.outcome
                AND NEW.receiver_status_code IS NOT DISTINCT FROM OLD.receiver_status_code
                AND NEW.response_body_truncated IS NOT DISTINCT FROM OLD.response_body_truncated
                AND NEW.completed_at IS NOT DISTINCT FROM OLD.completed_at
                AND NEW.receipt_envelope IS NULL AND NEW.receipt_sha256 IS NULL
                AND cardinality(NEW.subject_email_sha256s)=0
                AND NEW.receipt_expired_at IS NOT NULL)
        ) THEN
            RAISE EXCEPTION 'invalid webhook playground fire transition';
        END IF;
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER outbound_webhook_playground_fires_guard_insert
    BEFORE INSERT ON outbound_webhook_playground_fires
    FOR EACH ROW EXECUTE FUNCTION guard_outbound_webhook_playground_fire_insert();
CREATE TRIGGER outbound_webhook_playground_fires_guard_update
    BEFORE UPDATE ON outbound_webhook_playground_fires
    FOR EACH ROW EXECUTE FUNCTION guard_outbound_webhook_playground_fire_update();

ALTER TABLE outbound_webhook_playground_fires ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_webhook_playground_fires FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON outbound_webhook_playground_fires AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON outbound_webhook_playground_fires AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON FUNCTION guard_outbound_webhook_playground_fire_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_outbound_webhook_playground_fire_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_outbound_webhook_config_version() FROM PUBLIC;
-- Deliberately omit DELETE: an application request may expire receipt payloads
-- but cannot remove the identity fence. The tenants(id) FK cascade still owns
-- workspace erasure as an internal referential action.
GRANT SELECT,INSERT,UPDATE ON outbound_webhook_playground_fires TO postwave_app;

COMMENT ON TABLE outbound_webhook_playground_fires IS
    'Tenant-scoped permanent simulator side-effect identities with bounded encrypted receipts; retention wipes only the receipt payload.';
COMMENT ON COLUMN outbound_webhook_playground_fires.receipt_envelope IS
    'Envelope-encrypted bounded v1 playground receipt bound to tenant/fire/webhook/event/request/key/config identity; never plaintext JSONB.';
COMMENT ON COLUMN outbound_webhook_playground_fires.subject_email_sha256s IS
    'Exact bounded set of SHA-256 locators for conventional lowercased email addresses found in the current encrypted receipt plaintext; replaced with each envelope and cleared with receipt retention or subject erasure.';
COMMENT ON COLUMN outbound_webhook_playground_fires.webhook_ref_id IS
    'Nullable live tenant-composite integrity edge; historical webhook_id survives endpoint removal.';

COMMIT;
