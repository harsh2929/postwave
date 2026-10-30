-- 1964_campaign_report_projection_mutations.sql
--
-- F01 projection mutation protocol. Canonical subscriber events retain a small
-- set of legitimate identity/privacy mutations: subscriber merge, canonical
-- email rotation, anonymous-to-known stitching, and Art. 17 redaction. Once a
-- row has been projected by migration 1959, those mutations must move the
-- compatibility report row in the same transaction without discarding the
-- original projection fingerprint.
--
-- This migration keeps the projected-row immutability trigger strict. The app
-- role loses direct UPDATE authority on subscriber_events identity/privacy
-- columns and receives only purpose-specific SECURITY DEFINER functions. A
-- private, one-transaction authorization row lets those functions update or
-- tombstone the exact linked report/head row; callers cannot mint that row.
-- Every projected change appends a chained before/after (or tombstone) receipt.
--
-- Historical links are adopted lazily after their original source/report
-- fingerprints are re-proven. This avoids an unbounded migration-time backfill
-- and fails closed if a pre-1964 projection had already diverged.
--
-- rollback-strategy: no-op. Mutation receipts and tombstones are measurement
-- lineage. Older binaries cannot safely regain direct subscriber-event UPDATE
-- authority after projected rows have begun accumulating mutation history.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE campaign_report_projection_mutation_requests (
    tenant_id                  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    request_id                 uuid NOT NULL,
    purpose                    text NOT NULL CHECK (purpose IN (
                                   'privacy_erasure', 'subscriber_merge',
                                   'email_rotation', 'anonymous_stitch',
                                   'migration_rollback'
                               )),
    operation                  text NOT NULL CHECK (operation IN (
                                   'identity_update', 'privacy_redaction',
                                   'rollback_tombstone'
                               )),
    parameter_fingerprint      text NOT NULL CHECK (
                                   parameter_fingerprint ~ '^[0-9a-f]{64}$'
                               ),
    source_rows_affected       bigint NOT NULL CHECK (source_rows_affected >= 0),
    report_rows_affected       bigint NOT NULL CHECK (report_rows_affected >= 0),
    projected_rows_affected    bigint NOT NULL CHECK (projected_rows_affected >= 0),
    recorded_at                timestamptz NOT NULL DEFAULT clock_timestamp(),
    request_fingerprint        text NOT NULL CHECK (
                                   request_fingerprint ~ '^[0-9a-f]{64}$'
                               ),

    PRIMARY KEY (tenant_id, request_id),
    CONSTRAINT campaign_report_projection_mutation_request_counts CHECK (
        projected_rows_affected <= source_rows_affected
        OR operation = 'rollback_tombstone'
    )
);

-- Receipts deliberately do not reference the projection/source/report rows:
-- a rollback tombstone removes all three, while its proof must survive.
CREATE TABLE campaign_report_projection_mutation_receipts (
    id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    request_id                 uuid NOT NULL,
    purpose                    text NOT NULL CHECK (purpose IN (
                                   'privacy_erasure', 'subscriber_merge',
                                   'email_rotation', 'anonymous_stitch',
                                   'migration_rollback'
                               )),
    operation                  text NOT NULL CHECK (operation IN (
                                   'update', 'tombstone', 'legacy_tombstone'
                               )),
    subscriber_event_id        bigint,
    subscriber_event_at        timestamptz,
    campaign_report_event_id   bigint NOT NULL,
    campaign_report_event_at   timestamptz NOT NULL,
    projection_version         text CHECK (
                                   projection_version IS NULL OR
                                   projection_version ~ '^[a-z0-9][a-z0-9_.-]{0,95}$'
                               ),
    original_projection_fingerprint text CHECK (
                                   original_projection_fingerprint IS NULL OR
                                   original_projection_fingerprint ~ '^[0-9a-f]{64}$'
                               ),
    mutation_sequence          bigint NOT NULL CHECK (mutation_sequence > 0),
    changed_fields             jsonb NOT NULL CHECK (
                                   jsonb_typeof(changed_fields) = 'array'
                                   AND jsonb_array_length(changed_fields) > 0
                                   AND octet_length(changed_fields::text) <= 2048
                               ),
    before_source_fingerprint  text CHECK (
                                   before_source_fingerprint IS NULL OR
                                   before_source_fingerprint ~ '^[0-9a-f]{64}$'
                               ),
    after_source_fingerprint   text CHECK (
                                   after_source_fingerprint IS NULL OR
                                   after_source_fingerprint ~ '^[0-9a-f]{64}$'
                               ),
    before_report_fingerprint  text NOT NULL CHECK (
                                   before_report_fingerprint ~ '^[0-9a-f]{64}$'
                               ),
    after_report_fingerprint   text CHECK (
                                   after_report_fingerprint IS NULL OR
                                   after_report_fingerprint ~ '^[0-9a-f]{64}$'
                               ),
    previous_chain_hash        text NOT NULL CHECK (
                                   previous_chain_hash ~ '^[0-9a-f]{64}$'
                               ),
    recorded_at                timestamptz NOT NULL DEFAULT clock_timestamp(),
    receipt_fingerprint        text NOT NULL CHECK (
                                   receipt_fingerprint ~ '^[0-9a-f]{64}$'
                               ),

    UNIQUE (tenant_id, request_id, campaign_report_event_id,
            campaign_report_event_at),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, receipt_fingerprint),
    CONSTRAINT campaign_report_projection_mutation_receipt_request_fk
        FOREIGN KEY (tenant_id, request_id)
        REFERENCES campaign_report_projection_mutation_requests (
            tenant_id, request_id
        ) DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT campaign_report_projection_mutation_receipt_source_shape CHECK (
        (subscriber_event_id IS NULL) = (subscriber_event_at IS NULL)
        AND (subscriber_event_id IS NULL) = (projection_version IS NULL)
        AND (subscriber_event_id IS NULL) =
            (original_projection_fingerprint IS NULL)
        AND (subscriber_event_id IS NULL) =
            (before_source_fingerprint IS NULL)
    ),
    CONSTRAINT campaign_report_projection_mutation_receipt_operation_shape CHECK (
        (operation = 'update'
            AND subscriber_event_id IS NOT NULL
            AND after_source_fingerprint IS NOT NULL
            AND after_report_fingerprint IS NOT NULL)
        OR
        (operation = 'tombstone'
            AND subscriber_event_id IS NOT NULL
            AND after_source_fingerprint IS NULL
            AND after_report_fingerprint IS NULL)
        OR
        (operation = 'legacy_tombstone'
            AND subscriber_event_id IS NULL
            AND after_source_fingerprint IS NULL
            AND after_report_fingerprint IS NULL)
    )
);

CREATE INDEX campaign_report_projection_mutation_receipts_source_idx
    ON campaign_report_projection_mutation_receipts (
        tenant_id, subscriber_event_at, subscriber_event_id, mutation_sequence
    ) WHERE subscriber_event_id IS NOT NULL;

-- The head is mutable only through the private authorization consumed by the
-- receipt-writing function. It preserves the original immutable projection
-- fingerprint while identifying the exact state that a replay must verify now.
CREATE TABLE campaign_report_event_projection_heads (
    tenant_id                    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_event_id          bigint NOT NULL,
    subscriber_event_at          timestamptz NOT NULL,
    campaign_report_event_id     bigint NOT NULL,
    campaign_report_event_at     timestamptz NOT NULL,
    projection_version           text NOT NULL CHECK (
                                     projection_version ~ '^[a-z0-9][a-z0-9_.-]{0,95}$'
                                 ),
    original_projection_fingerprint text NOT NULL CHECK (
                                     original_projection_fingerprint ~ '^[0-9a-f]{64}$'
                                 ),
    current_source_fingerprint   text NOT NULL CHECK (
                                     current_source_fingerprint ~ '^[0-9a-f]{64}$'
                                 ),
    current_report_fingerprint   text NOT NULL CHECK (
                                     current_report_fingerprint ~ '^[0-9a-f]{64}$'
                                 ),
    current_projection_fingerprint text NOT NULL CHECK (
                                     current_projection_fingerprint ~ '^[0-9a-f]{64}$'
                                 ),
    mutation_sequence            bigint NOT NULL DEFAULT 0 CHECK (mutation_sequence >= 0),
    chain_hash                   text NOT NULL CHECK (chain_hash ~ '^[0-9a-f]{64}$'),
    last_receipt_id              uuid,
    last_request_id              uuid,
    created_at                   timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at                   timestamptz NOT NULL DEFAULT clock_timestamp(),

    PRIMARY KEY (tenant_id, subscriber_event_id, subscriber_event_at),
    UNIQUE (tenant_id, campaign_report_event_id, campaign_report_event_at),
    CONSTRAINT campaign_report_projection_heads_projection_fk
        FOREIGN KEY (tenant_id, subscriber_event_id, subscriber_event_at)
        REFERENCES campaign_report_event_projections (
            tenant_id, subscriber_event_id, subscriber_event_at
        ) ON DELETE CASCADE,
    CONSTRAINT campaign_report_projection_heads_receipt_shape CHECK (
        (mutation_sequence = 0 AND last_receipt_id IS NULL AND last_request_id IS NULL)
        OR
        (mutation_sequence > 0 AND last_receipt_id IS NOT NULL AND last_request_id IS NOT NULL)
    )
);

-- This table is an unforgeable, transaction-scoped bridge between the
-- SECURITY DEFINER mutation function and the existing projected-row trigger.
-- It has no app privileges or RLS policy. Rows are deleted before the function
-- returns and roll back with the transaction on every failure path.
CREATE TABLE campaign_report_projection_mutation_authorizations (
    backend_pid                  integer NOT NULL,
    transaction_id              bigint NOT NULL,
    tenant_id                    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_event_id          bigint,
    subscriber_event_at          timestamptz,
    campaign_report_event_id     bigint NOT NULL,
    campaign_report_event_at     timestamptz NOT NULL,
    allowed_operation            text NOT NULL CHECK (
                                     allowed_operation IN ('update', 'delete')
                                 ),
    request_id                   uuid NOT NULL,
    created_at                   timestamptz NOT NULL DEFAULT clock_timestamp(),

    PRIMARY KEY (
        backend_pid, transaction_id, tenant_id,
        campaign_report_event_id, campaign_report_event_at,
        allowed_operation
    ),
    CONSTRAINT campaign_report_projection_mutation_authorization_source_shape CHECK (
        (subscriber_event_id IS NULL) = (subscriber_event_at IS NULL)
    )
);

REVOKE ALL ON campaign_report_projection_mutation_authorizations
    FROM PUBLIC, postwave_app;

-- FORCE RLS even on the no-grant bridge so a future privilege mistake cannot
-- turn it into an authorization-minting surface. The only permissive policy is
-- dynamically bound to the table owner; SECURITY DEFINER protocol functions
-- run as that owner, while postwave_app can neither satisfy the policy nor use
-- the table privileges directly.
ALTER TABLE campaign_report_projection_mutation_authorizations
    ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_report_projection_mutation_authorizations
    FORCE ROW LEVEL SECURITY;
CREATE POLICY campaign_report_projection_mutation_auth_owner_internal
    ON campaign_report_projection_mutation_authorizations
    AS PERMISSIVE FOR ALL TO PUBLIC
    USING (
        current_user = pg_catalog.pg_get_userbyid((
            SELECT relation.relowner
              FROM pg_catalog.pg_class AS relation
             WHERE relation.oid =
                   'public.campaign_report_projection_mutation_authorizations'::regclass
        ))
    )
    WITH CHECK (
        current_user = pg_catalog.pg_get_userbyid((
            SELECT relation.relowner
              FROM pg_catalog.pg_class AS relation
             WHERE relation.oid =
                   'public.campaign_report_projection_mutation_authorizations'::regclass
        ))
    );

-- Fingerprint helpers deliberately reproduce migration 1959 byte-for-byte.
-- They are centralized here so head verification, receipts, and replay cannot
-- drift into three subtly different definitions.
CREATE OR REPLACE FUNCTION campaign_report_projection_source_fingerprint(
    p_event subscriber_events
)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public, pg_temp
AS $fn$
SELECT encode(digest(convert_to(jsonb_build_object(
    'schema', 'postwave.canonical-subscriber-event.v1',
    'id', p_event.id,
    'tenant_id', p_event.tenant_id,
    'subscriber_email', p_event.subscriber_email::text,
    'event_type', p_event.event_type,
    'campaign_id', p_event.campaign_id,
    'link_url', p_event.link_url,
    'user_agent', p_event.user_agent,
    'ip', p_event.ip::text,
    'at', p_event.at,
    'source', p_event.source,
    'provider_event_id', p_event.provider_event_id,
    'message_id', p_event.message_id,
    'metadata', p_event.metadata,
    'bounce_type', p_event.bounce_type,
    'country', p_event.country,
    'stream', p_event.stream,
    'source_event_id', p_event.source_event_id,
    'event_origin', p_event.event_origin,
    'controlled_seed_test_id', p_event.controlled_seed_test_id,
    'seed_origin_method', p_event.seed_origin_method,
    'event_origin_version', p_event.event_origin_version,
    'is_seed', p_event.is_seed
)::text, 'UTF8'), 'sha256'), 'hex')
$fn$;

CREATE OR REPLACE FUNCTION campaign_report_projection_report_fingerprint(
    p_event campaign_report_events
)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public, pg_temp
AS $fn$
SELECT encode(digest(convert_to(jsonb_build_object(
    'schema', 'postwave.campaign-report-event.v1',
    'tenant_id', p_event.tenant_id,
    'campaign_id', p_event.campaign_id,
    'subscriber_email', p_event.subscriber_email::text,
    'event_type', p_event.event_type,
    'link_url', p_event.link_url,
    'user_agent', p_event.user_agent,
    'ip', p_event.ip::text,
    'country', p_event.country,
    'region', p_event.region,
    'city', p_event.city,
    'device', p_event.device,
    'client', p_event.client,
    'revenue_cents', p_event.revenue_cents,
    'metadata', p_event.metadata,
    'at', p_event.at,
    'source', p_event.source,
    'provider_event_id', p_event.provider_event_id,
    'message_id', p_event.message_id,
    'event_origin', p_event.event_origin,
    'controlled_seed_test_id', p_event.controlled_seed_test_id,
    'seed_origin_method', p_event.seed_origin_method,
    'event_origin_version', p_event.event_origin_version,
    'is_seed', p_event.is_seed
)::text, 'UTF8'), 'sha256'), 'hex')
$fn$;

CREATE OR REPLACE FUNCTION campaign_report_projection_state_fingerprint(
    p_projection_version text,
    p_source_fingerprint text,
    p_report_fingerprint text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public, pg_temp
AS $fn$
SELECT encode(digest(convert_to(jsonb_build_object(
    'schema', 'postwave.campaign-report-projection.v1',
    'projection_version', p_projection_version,
    'source_event_fingerprint', p_source_fingerprint,
    'report_event_fingerprint', p_report_fingerprint
)::text, 'UTF8'), 'sha256'), 'hex')
$fn$;

REVOKE ALL ON FUNCTION campaign_report_projection_source_fingerprint(
    subscriber_events
) FROM PUBLIC, postwave_app;
REVOKE ALL ON FUNCTION campaign_report_projection_report_fingerprint(
    campaign_report_events
) FROM PUBLIC, postwave_app;
REVOKE ALL ON FUNCTION campaign_report_projection_state_fingerprint(
    text, text, text
) FROM PUBLIC, postwave_app;

CREATE OR REPLACE FUNCTION campaign_report_projection_mutation_evidence_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
    IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
        USING ERRCODE = '55000';
END;
$fn$;

CREATE TRIGGER campaign_report_projection_mutation_requests_append_only
    BEFORE UPDATE OR DELETE
    ON campaign_report_projection_mutation_requests
    FOR EACH ROW EXECUTE FUNCTION campaign_report_projection_mutation_evidence_guard();

CREATE TRIGGER campaign_report_projection_mutation_receipts_append_only
    BEFORE UPDATE OR DELETE
    ON campaign_report_projection_mutation_receipts
    FOR EACH ROW EXECUTE FUNCTION campaign_report_projection_mutation_evidence_guard();

-- Trigger functions are invoked by PostgreSQL without checking caller EXECUTE
-- privilege. Leaving PUBLIC EXECUTE in place would only expose an unnecessary
-- internal surface (and would let the application call a trigger function
-- directly to probe implementation details), so keep every trigger authority
-- unavailable to the runtime role, including the two inherited from 1959.
REVOKE ALL ON FUNCTION campaign_report_projection_mutation_evidence_guard()
    FROM PUBLIC, postwave_app;
REVOKE ALL ON FUNCTION campaign_report_projection_append_only_guard()
    FROM PUBLIC, postwave_app;
REVOKE ALL ON FUNCTION campaign_report_projection_run_guard()
    FROM PUBLIC, postwave_app;

-- A head can advance only while the exact report mutation authorization exists
-- on this backend and in this transaction. Nested FK/tenant cascades remain
-- possible and remove only the mutable head; immutable receipts survive.
CREATE OR REPLACE FUNCTION campaign_report_projection_head_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
    IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
        RETURN OLD;
    END IF;
    IF TG_OP = 'UPDATE' AND EXISTS (
        SELECT 1
          FROM public.campaign_report_projection_mutation_authorizations AS authz
         WHERE authz.backend_pid = pg_backend_pid()
           AND authz.transaction_id = txid_current()
           AND authz.tenant_id = OLD.tenant_id
           AND authz.subscriber_event_id = OLD.subscriber_event_id
           AND authz.subscriber_event_at = OLD.subscriber_event_at
           AND authz.campaign_report_event_id = OLD.campaign_report_event_id
           AND authz.campaign_report_event_at = OLD.campaign_report_event_at
           AND authz.allowed_operation = 'update'
    ) THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'campaign report projection head is internally mutable only'
        USING ERRCODE = '55000';
END;
$fn$;

REVOKE ALL ON FUNCTION campaign_report_projection_head_guard()
    FROM PUBLIC, postwave_app;

CREATE TRIGGER campaign_report_projection_heads_guard
    BEFORE UPDATE OR DELETE ON campaign_report_event_projection_heads
    FOR EACH ROW EXECUTE FUNCTION campaign_report_projection_head_guard();

-- Replace the 1959 report guard without weakening it generally. A linked row
-- remains immutable unless the private authorization names this exact row,
-- backend, transaction, and operation.
CREATE OR REPLACE FUNCTION campaign_report_projected_row_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    expected_operation text;
BEGIN
    IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
        RETURN OLD;
    END IF;
    IF EXISTS (
        SELECT 1
          FROM public.campaign_report_event_projections AS projection
         WHERE projection.tenant_id = OLD.tenant_id
           AND projection.campaign_report_event_id = OLD.id
           AND projection.campaign_report_event_at = OLD.at
    ) THEN
        expected_operation := CASE WHEN TG_OP = 'DELETE' THEN 'delete' ELSE 'update' END;
        IF EXISTS (
            SELECT 1
              FROM public.campaign_report_projection_mutation_authorizations AS authz
             WHERE authz.backend_pid = pg_backend_pid()
               AND authz.transaction_id = txid_current()
               AND authz.tenant_id = OLD.tenant_id
               AND authz.campaign_report_event_id = OLD.id
               AND authz.campaign_report_event_at = OLD.at
               AND authz.allowed_operation = expected_operation
        ) THEN
            IF TG_OP = 'DELETE' THEN
                RETURN OLD;
            END IF;
            RETURN NEW;
        END IF;
        RAISE EXCEPTION 'projected campaign report event is immutable'
            USING ERRCODE = '55000';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$fn$;

REVOKE ALL ON FUNCTION campaign_report_projected_row_immutable_guard()
    FROM PUBLIC, postwave_app;

-- Lazily adopt the current state of an exact 1959 link. A pre-existing
-- divergence is not blessed as a head: the migration leaves it visible as an
-- explicit conflict for operator reconciliation.
CREATE OR REPLACE FUNCTION campaign_report_projection_ensure_head(
    p_tenant_id uuid,
    p_subscriber_event_id bigint,
    p_subscriber_event_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET TimeZone = 'UTC'
AS $fn$
DECLARE
    projection public.campaign_report_event_projections%ROWTYPE;
    canonical public.subscriber_events%ROWTYPE;
    report public.campaign_report_events%ROWTYPE;
    source_fingerprint text;
    report_fingerprint text;
    projection_fingerprint text;
    initial_chain_hash text;
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.campaign_report_event_projection_heads AS head
         WHERE head.tenant_id = p_tenant_id
           AND head.subscriber_event_id = p_subscriber_event_id
           AND head.subscriber_event_at = p_subscriber_event_at
    ) THEN
        RETURN;
    END IF;

    SELECT link.* INTO projection
      FROM public.campaign_report_event_projections AS link
     WHERE link.tenant_id = p_tenant_id
       AND link.subscriber_event_id = p_subscriber_event_id
       AND link.subscriber_event_at = p_subscriber_event_at
     FOR SHARE;
    IF NOT FOUND THEN
        RETURN;
    END IF;
    SELECT event.* INTO canonical
      FROM public.subscriber_events AS event
     WHERE event.tenant_id = p_tenant_id
       AND event.id = p_subscriber_event_id
       AND event.at = p_subscriber_event_at
     FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'projected canonical subscriber event is missing'
            USING ERRCODE = '23503';
    END IF;
    SELECT event.* INTO report
      FROM public.campaign_report_events AS event
     WHERE event.tenant_id = p_tenant_id
       AND event.id = projection.campaign_report_event_id
       AND event.at = projection.campaign_report_event_at
     FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'projected campaign report event is missing'
            USING ERRCODE = '23503';
    END IF;

    source_fingerprint := public.campaign_report_projection_source_fingerprint(canonical);
    report_fingerprint := public.campaign_report_projection_report_fingerprint(report);
    projection_fingerprint := public.campaign_report_projection_state_fingerprint(
        projection.projection_version, source_fingerprint, report_fingerprint
    );
    IF source_fingerprint IS DISTINCT FROM projection.source_event_fingerprint
       OR report_fingerprint IS DISTINCT FROM projection.report_event_fingerprint
       OR projection_fingerprint IS DISTINCT FROM projection.projection_fingerprint THEN
        RAISE EXCEPTION 'existing campaign report projection diverged before mutation-head adoption'
            USING ERRCODE = '23505';
    END IF;
    initial_chain_hash := encode(digest(convert_to(jsonb_build_object(
        'schema', 'postwave.campaign-report-projection-mutation-chain.v1',
        'tenant_id', projection.tenant_id,
        'subscriber_event_id', projection.subscriber_event_id,
        'subscriber_event_at', projection.subscriber_event_at,
        'campaign_report_event_id', projection.campaign_report_event_id,
        'campaign_report_event_at', projection.campaign_report_event_at,
        'original_projection_fingerprint', projection.projection_fingerprint
    )::text, 'UTF8'), 'sha256'), 'hex');

    INSERT INTO public.campaign_report_event_projection_heads (
        tenant_id, subscriber_event_id, subscriber_event_at,
        campaign_report_event_id, campaign_report_event_at,
        projection_version, original_projection_fingerprint,
        current_source_fingerprint, current_report_fingerprint,
        current_projection_fingerprint, chain_hash
    ) VALUES (
        projection.tenant_id, projection.subscriber_event_id,
        projection.subscriber_event_at, projection.campaign_report_event_id,
        projection.campaign_report_event_at, projection.projection_version,
        projection.projection_fingerprint, source_fingerprint,
        report_fingerprint, projection_fingerprint, initial_chain_hash
    ) ON CONFLICT (
        tenant_id, subscriber_event_id, subscriber_event_at
    ) DO NOTHING;
END;
$fn$;

REVOKE ALL ON FUNCTION campaign_report_projection_ensure_head(
    uuid, bigint, timestamptz
) FROM PUBLIC, postwave_app;

CREATE OR REPLACE FUNCTION campaign_report_projection_create_head()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
    PERFORM public.campaign_report_projection_ensure_head(
        NEW.tenant_id, NEW.subscriber_event_id, NEW.subscriber_event_at
    );
    RETURN NEW;
END;
$fn$;

REVOKE ALL ON FUNCTION campaign_report_projection_create_head()
    FROM PUBLIC, postwave_app;

CREATE TRIGGER campaign_report_event_projections_create_head
    AFTER INSERT ON campaign_report_event_projections
    FOR EACH ROW EXECUTE FUNCTION campaign_report_projection_create_head();

CREATE OR REPLACE FUNCTION campaign_report_projection_apply_identity_mutation(
    p_tenant_id uuid,
    p_subscriber_event_id bigint,
    p_subscriber_event_at timestamptz,
    p_new_email citext,
    p_clear_privacy_fields boolean,
    p_purpose text,
    p_request_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET TimeZone = 'UTC'
AS $fn$
DECLARE
    canonical public.subscriber_events%ROWTYPE;
    updated_canonical public.subscriber_events%ROWTYPE;
    projection public.campaign_report_event_projections%ROWTYPE;
    head public.campaign_report_event_projection_heads%ROWTYPE;
    report public.campaign_report_events%ROWTYPE;
    updated_report public.campaign_report_events%ROWTYPE;
    before_source_fingerprint text;
    before_report_fingerprint text;
    before_projection_fingerprint text;
    after_source_fingerprint text;
    after_report_fingerprint text;
    after_projection_fingerprint text;
    changed_fields jsonb := '[]'::jsonb;
    receipt_id uuid := gen_random_uuid();
    mutation_at timestamptz := clock_timestamp();
    receipt_fingerprint text;
BEGIN
    SELECT event.* INTO canonical
      FROM public.subscriber_events AS event
     WHERE event.tenant_id = p_tenant_id
       AND event.id = p_subscriber_event_id
       AND event.at = p_subscriber_event_at
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'subscriber event selected for projection mutation is missing'
            USING ERRCODE = '23503';
    END IF;

    SELECT link.* INTO projection
      FROM public.campaign_report_event_projections AS link
     WHERE link.tenant_id = p_tenant_id
       AND link.subscriber_event_id = p_subscriber_event_id
       AND link.subscriber_event_at = p_subscriber_event_at
     FOR SHARE;

    IF FOUND THEN
        PERFORM public.campaign_report_projection_ensure_head(
            p_tenant_id, p_subscriber_event_id, p_subscriber_event_at
        );
        SELECT current_head.* INTO head
          FROM public.campaign_report_event_projection_heads AS current_head
         WHERE current_head.tenant_id = p_tenant_id
           AND current_head.subscriber_event_id = p_subscriber_event_id
           AND current_head.subscriber_event_at = p_subscriber_event_at
         FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'campaign report projection mutation head is missing'
                USING ERRCODE = '23503';
        END IF;
        SELECT event.* INTO report
          FROM public.campaign_report_events AS event
         WHERE event.tenant_id = p_tenant_id
           AND event.id = projection.campaign_report_event_id
           AND event.at = projection.campaign_report_event_at
         FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'linked campaign report event is missing'
                USING ERRCODE = '23503';
        END IF;
        before_source_fingerprint :=
            public.campaign_report_projection_source_fingerprint(canonical);
        before_report_fingerprint :=
            public.campaign_report_projection_report_fingerprint(report);
        before_projection_fingerprint :=
            public.campaign_report_projection_state_fingerprint(
                projection.projection_version,
                before_source_fingerprint,
                before_report_fingerprint
            );
        IF head.campaign_report_event_id IS DISTINCT FROM
                projection.campaign_report_event_id
           OR head.campaign_report_event_at IS DISTINCT FROM
                projection.campaign_report_event_at
           OR head.projection_version IS DISTINCT FROM projection.projection_version
           OR head.original_projection_fingerprint IS DISTINCT FROM
                projection.projection_fingerprint
           OR head.current_source_fingerprint IS DISTINCT FROM
                before_source_fingerprint
           OR head.current_report_fingerprint IS DISTINCT FROM
                before_report_fingerprint
           OR head.current_projection_fingerprint IS DISTINCT FROM
                before_projection_fingerprint THEN
            RAISE EXCEPTION 'campaign report projection mutation head conflicts with current rows'
                USING ERRCODE = '23505';
        END IF;
    END IF;

    IF canonical.subscriber_email IS DISTINCT FROM p_new_email THEN
        changed_fields := changed_fields || jsonb_build_array('subscriber_email');
    END IF;
    IF p_clear_privacy_fields AND canonical.user_agent IS NOT NULL THEN
        changed_fields := changed_fields || jsonb_build_array('user_agent');
    END IF;
    IF p_clear_privacy_fields AND canonical.ip IS NOT NULL THEN
        changed_fields := changed_fields || jsonb_build_array('ip');
    END IF;
    IF jsonb_array_length(changed_fields) = 0 THEN
        RETURN projection.tenant_id IS NOT NULL;
    END IF;

    UPDATE public.subscriber_events AS event
       SET subscriber_email = p_new_email,
           user_agent = CASE WHEN p_clear_privacy_fields THEN NULL ELSE event.user_agent END,
           ip = CASE WHEN p_clear_privacy_fields THEN NULL ELSE event.ip END
     WHERE event.tenant_id = p_tenant_id
       AND event.id = p_subscriber_event_id
       AND event.at = p_subscriber_event_at
    RETURNING event.* INTO updated_canonical;

    IF projection.tenant_id IS NULL THEN
        RETURN false;
    END IF;

    INSERT INTO public.campaign_report_projection_mutation_authorizations (
        backend_pid, transaction_id, tenant_id,
        subscriber_event_id, subscriber_event_at,
        campaign_report_event_id, campaign_report_event_at,
        allowed_operation, request_id
    ) VALUES (
        pg_backend_pid(), txid_current(), p_tenant_id,
        p_subscriber_event_id, p_subscriber_event_at,
        projection.campaign_report_event_id,
        projection.campaign_report_event_at, 'update', p_request_id
    );

    UPDATE public.campaign_report_events AS event
       SET subscriber_email = updated_canonical.subscriber_email,
           user_agent = updated_canonical.user_agent,
           ip = updated_canonical.ip
     WHERE event.tenant_id = p_tenant_id
       AND event.id = projection.campaign_report_event_id
       AND event.at = projection.campaign_report_event_at
    RETURNING event.* INTO updated_report;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'linked campaign report event disappeared during mutation'
            USING ERRCODE = '23503';
    END IF;

    after_source_fingerprint :=
        public.campaign_report_projection_source_fingerprint(updated_canonical);
    after_report_fingerprint :=
        public.campaign_report_projection_report_fingerprint(updated_report);
    after_projection_fingerprint :=
        public.campaign_report_projection_state_fingerprint(
            projection.projection_version,
            after_source_fingerprint,
            after_report_fingerprint
        );
    receipt_fingerprint := encode(digest(convert_to(jsonb_build_object(
        'schema', 'postwave.campaign-report-projection-mutation-receipt.v1',
        'id', receipt_id,
        'tenant_id', p_tenant_id,
        'request_id', p_request_id,
        'purpose', p_purpose,
        'operation', 'update',
        'subscriber_event_id', p_subscriber_event_id,
        'subscriber_event_at', p_subscriber_event_at,
        'campaign_report_event_id', projection.campaign_report_event_id,
        'campaign_report_event_at', projection.campaign_report_event_at,
        'projection_version', projection.projection_version,
        'original_projection_fingerprint', projection.projection_fingerprint,
        'mutation_sequence', head.mutation_sequence + 1,
        'changed_fields', changed_fields,
        'before_source_fingerprint', before_source_fingerprint,
        'after_source_fingerprint', after_source_fingerprint,
        'before_report_fingerprint', before_report_fingerprint,
        'after_report_fingerprint', after_report_fingerprint,
        'previous_chain_hash', head.chain_hash,
        'recorded_at', mutation_at
    )::text, 'UTF8'), 'sha256'), 'hex');

    INSERT INTO public.campaign_report_projection_mutation_receipts (
        id, tenant_id, request_id, purpose, operation,
        subscriber_event_id, subscriber_event_at,
        campaign_report_event_id, campaign_report_event_at,
        projection_version, original_projection_fingerprint,
        mutation_sequence, changed_fields,
        before_source_fingerprint, after_source_fingerprint,
        before_report_fingerprint, after_report_fingerprint,
        previous_chain_hash, recorded_at, receipt_fingerprint
    ) VALUES (
        receipt_id, p_tenant_id, p_request_id, p_purpose, 'update',
        p_subscriber_event_id, p_subscriber_event_at,
        projection.campaign_report_event_id,
        projection.campaign_report_event_at,
        projection.projection_version, projection.projection_fingerprint,
        head.mutation_sequence + 1, changed_fields,
        before_source_fingerprint, after_source_fingerprint,
        before_report_fingerprint, after_report_fingerprint,
        head.chain_hash, mutation_at, receipt_fingerprint
    );

    UPDATE public.campaign_report_event_projection_heads AS current_head
       SET current_source_fingerprint = after_source_fingerprint,
           current_report_fingerprint = after_report_fingerprint,
           current_projection_fingerprint = after_projection_fingerprint,
           mutation_sequence = head.mutation_sequence + 1,
           chain_hash = receipt_fingerprint,
           last_receipt_id = receipt_id,
           last_request_id = p_request_id,
           updated_at = mutation_at
     WHERE current_head.tenant_id = p_tenant_id
       AND current_head.subscriber_event_id = p_subscriber_event_id
       AND current_head.subscriber_event_at = p_subscriber_event_at;

    DELETE FROM public.campaign_report_projection_mutation_authorizations
     WHERE backend_pid = pg_backend_pid()
       AND transaction_id = txid_current()
       AND tenant_id = p_tenant_id
       AND campaign_report_event_id = projection.campaign_report_event_id
       AND campaign_report_event_at = projection.campaign_report_event_at
       AND allowed_operation = 'update';
    RETURN true;
END;
$fn$;

REVOKE ALL ON FUNCTION campaign_report_projection_apply_identity_mutation(
    uuid, bigint, timestamptz, citext, boolean, text, uuid
) FROM PUBLIC, postwave_app;

CREATE OR REPLACE FUNCTION campaign_report_projection_mutate_subscriber_events(
    p_tenant_id uuid,
    p_from_emails citext[],
    p_new_email citext,
    p_clear_privacy_fields boolean,
    p_purpose text,
    p_operation text,
    p_request_id uuid
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET TimeZone = 'UTC'
AS $fn$
DECLARE
    normalized_from text[];
    normalized_target citext;
    parameter_fingerprint text;
    request_fingerprint text;
    mutation_at timestamptz := clock_timestamp();
    existing public.campaign_report_projection_mutation_requests%ROWTYPE;
    event_ref record;
    source_count bigint := 0;
    projected_count bigint := 0;
    projected boolean;
BEGIN
    IF p_tenant_id IS NULL
       OR p_tenant_id::text IS DISTINCT FROM
          NULLIF(current_setting('app.tenant_id', true), '') THEN
        RAISE EXCEPTION 'campaign report projection mutation tenant scope mismatch'
            USING ERRCODE = '42501';
    END IF;
    IF p_request_id IS NULL OR p_new_email IS NULL
       OR p_purpose IS NULL OR p_operation IS NULL THEN
        RAISE EXCEPTION 'campaign report projection mutation identity is incomplete'
            USING ERRCODE = '22023';
    END IF;
    IF (p_operation = 'identity_update' AND p_clear_privacy_fields)
       OR (p_operation = 'privacy_redaction' AND NOT p_clear_privacy_fields)
       OR p_operation NOT IN ('identity_update', 'privacy_redaction') THEN
        RAISE EXCEPTION 'campaign report projection mutation operation/field contract is invalid'
            USING ERRCODE = '22023';
    END IF;
    IF (p_operation = 'privacy_redaction' AND p_purpose <> 'privacy_erasure')
       OR (p_operation = 'identity_update' AND p_purpose NOT IN (
            'subscriber_merge', 'email_rotation', 'anonymous_stitch'
       )) THEN
        RAISE EXCEPTION 'campaign report projection mutation purpose is invalid'
            USING ERRCODE = '22023';
    END IF;

    normalized_target := lower(btrim(p_new_email::text))::citext;
    IF length(normalized_target::text) NOT BETWEEN 3 AND 320
       OR normalized_target::text !~ '^[^[:space:][:cntrl:]@]+@[^[:space:][:cntrl:]@]+$' THEN
        RAISE EXCEPTION 'campaign report projection mutation target email is invalid'
            USING ERRCODE = '22023';
    END IF;
    SELECT COALESCE(array_agg(value ORDER BY value), ARRAY[]::text[])
      INTO normalized_from
      FROM (
          SELECT DISTINCT lower(btrim(email::text)) AS value
            FROM unnest(COALESCE(p_from_emails, ARRAY[]::citext[])) AS email
           WHERE email IS NOT NULL AND btrim(email::text) <> ''
      ) AS normalized;
    IF cardinality(normalized_from) = 0
       OR EXISTS (
           SELECT 1 FROM unnest(normalized_from) AS source_email
            WHERE length(source_email) > 320
               OR source_email !~ '^[^[:space:][:cntrl:]@]+@[^[:space:][:cntrl:]@]+$'
       ) THEN
        RAISE EXCEPTION 'campaign report projection mutation source emails are invalid'
            USING ERRCODE = '22023';
    END IF;
    IF p_operation = 'privacy_redaction'
       AND normalized_target::text !~ '@erased\.invalid$' THEN
        RAISE EXCEPTION 'privacy projection mutation requires a non-routable erased.invalid target'
            USING ERRCODE = '22023';
    END IF;

    parameter_fingerprint := encode(digest(convert_to(jsonb_build_object(
        'schema', 'postwave.campaign-report-projection-mutation-parameters.v1',
        'purpose', p_purpose,
        'operation', p_operation,
        'source_emails', normalized_from,
        'target_email', normalized_target::text,
        'clear_privacy_fields', p_clear_privacy_fields
    )::text, 'UTF8'), 'sha256'), 'hex');

    PERFORM pg_advisory_xact_lock(pg_catalog.hashtextextended(
        p_tenant_id::text || E'\x1f' || p_request_id::text, 1964
    ));
    SELECT request.* INTO existing
      FROM public.campaign_report_projection_mutation_requests AS request
     WHERE request.tenant_id = p_tenant_id
       AND request.request_id = p_request_id;
    IF FOUND THEN
        IF existing.purpose IS DISTINCT FROM p_purpose
           OR existing.operation IS DISTINCT FROM p_operation
           OR existing.parameter_fingerprint IS DISTINCT FROM parameter_fingerprint THEN
            RAISE EXCEPTION 'campaign report projection mutation request replay conflicts'
                USING ERRCODE = '23505';
        END IF;
        RETURN existing.source_rows_affected;
    END IF;

    FOR event_ref IN
        SELECT event.id, event.at
          FROM public.subscriber_events AS event
         WHERE event.tenant_id = p_tenant_id
           AND lower(event.subscriber_email::text) = ANY(normalized_from)
           AND (
               event.subscriber_email IS DISTINCT FROM normalized_target
               OR (p_clear_privacy_fields
                   AND (event.user_agent IS NOT NULL OR event.ip IS NOT NULL))
           )
         ORDER BY event.at, event.id
         FOR UPDATE
    LOOP
        projected := public.campaign_report_projection_apply_identity_mutation(
            p_tenant_id, event_ref.id, event_ref.at, normalized_target,
            p_clear_privacy_fields, p_purpose, p_request_id
        );
        source_count := source_count + 1;
        IF projected THEN
            projected_count := projected_count + 1;
        END IF;
    END LOOP;

    request_fingerprint := encode(digest(convert_to(jsonb_build_object(
        'schema', 'postwave.campaign-report-projection-mutation-request.v1',
        'tenant_id', p_tenant_id,
        'request_id', p_request_id,
        'purpose', p_purpose,
        'operation', p_operation,
        'parameter_fingerprint', parameter_fingerprint,
        'source_rows_affected', source_count,
        'report_rows_affected', projected_count,
        'projected_rows_affected', projected_count,
        'recorded_at', mutation_at
    )::text, 'UTF8'), 'sha256'), 'hex');
    INSERT INTO public.campaign_report_projection_mutation_requests (
        tenant_id, request_id, purpose, operation, parameter_fingerprint,
        source_rows_affected, report_rows_affected,
        projected_rows_affected, recorded_at, request_fingerprint
    ) VALUES (
        p_tenant_id, p_request_id, p_purpose, p_operation,
        parameter_fingerprint, source_count, projected_count,
        projected_count, mutation_at, request_fingerprint
    );

    RETURN source_count;
END;
$fn$;

REVOKE ALL ON FUNCTION campaign_report_projection_mutate_subscriber_events(
    uuid, citext[], citext, boolean, text, text, uuid
) FROM PUBLIC, postwave_app;

CREATE OR REPLACE FUNCTION campaign_report_projection_repoint_subscriber_events(
    p_tenant_id uuid,
    p_from_emails citext[],
    p_new_email citext,
    p_purpose text,
    p_request_id uuid
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
    IF p_purpose NOT IN ('subscriber_merge', 'email_rotation', 'anonymous_stitch') THEN
        RAISE EXCEPTION 'unsupported subscriber-event identity mutation purpose'
            USING ERRCODE = '22023';
    END IF;
    RETURN public.campaign_report_projection_mutate_subscriber_events(
        p_tenant_id, p_from_emails, p_new_email, false,
        p_purpose, 'identity_update', p_request_id
    );
END;
$fn$;

CREATE OR REPLACE FUNCTION campaign_report_projection_privacy_erase_subscriber_events(
    p_tenant_id uuid,
    p_from_emails citext[],
    p_erased_email citext,
    p_request_id uuid
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
    RETURN public.campaign_report_projection_mutate_subscriber_events(
        p_tenant_id, p_from_emails, p_erased_email, true,
        'privacy_erasure', 'privacy_redaction', p_request_id
    );
END;
$fn$;

REVOKE ALL ON FUNCTION campaign_report_projection_repoint_subscriber_events(
    uuid, citext[], citext, text, uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION campaign_report_projection_privacy_erase_subscriber_events(
    uuid, citext[], citext, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION campaign_report_projection_repoint_subscriber_events(
    uuid, citext[], citext, text, uuid
) TO postwave_app;
GRANT EXECUTE ON FUNCTION campaign_report_projection_privacy_erase_subscriber_events(
    uuid, citext[], citext, uuid
) TO postwave_app;

-- All legitimate runtime UPDATE paths are composed into the functions above.
-- Keeping a direct column grant would let a caller change the canonical row
-- without a mirrored report mutation or receipt.
REVOKE UPDATE (subscriber_email, user_agent, ip)
    ON subscriber_events FROM postwave_app;

-- Tracked migration rollback remains compatible for report-only legacy rows.
-- A linked row is tombstoned only when the canonical event itself carries the
-- preallocated imported-resource and job identities, proving the rollback owns
-- both sides. Current report-only imports remain unlinked and take the legacy
-- branch; future canonical import composition must write that ownership before
-- projecting.
CREATE OR REPLACE FUNCTION campaign_report_projection_rollback_delete(
    p_tenant_id uuid,
    p_campaign_report_event_id bigint,
    p_imported_resource_id uuid,
    p_request_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET TimeZone = 'UTC'
AS $fn$
DECLARE
    ledger public.migration_imported_resources%ROWTYPE;
    existing public.campaign_report_projection_mutation_requests%ROWTYPE;
    report_ats timestamptz[];
    report public.campaign_report_events%ROWTYPE;
    projection public.campaign_report_event_projections%ROWTYPE;
    canonical public.subscriber_events%ROWTYPE;
    head public.campaign_report_event_projection_heads%ROWTYPE;
    parameter_fingerprint text;
    request_fingerprint text;
    before_source_fingerprint text;
    before_report_fingerprint text;
    before_projection_fingerprint text;
    destination_after_fingerprint text;
    destination_after_timezone text;
    previous_chain_hash text;
    receipt_fingerprint text;
    receipt_id uuid := gen_random_uuid();
    mutation_at timestamptz := clock_timestamp();
    operation_name text;
    changed_fields jsonb;
    source_count bigint := 0;
    projected_count bigint := 0;
BEGIN
    IF p_tenant_id IS NULL
       OR p_tenant_id::text IS DISTINCT FROM
          NULLIF(current_setting('app.tenant_id', true), '') THEN
        RAISE EXCEPTION 'campaign report rollback tenant scope mismatch'
            USING ERRCODE = '42501';
    END IF;
    IF p_campaign_report_event_id IS NULL OR p_campaign_report_event_id <= 0
       OR p_imported_resource_id IS NULL OR p_request_id IS NULL THEN
        RAISE EXCEPTION 'campaign report rollback identity is incomplete'
            USING ERRCODE = '22023';
    END IF;
    parameter_fingerprint := encode(digest(convert_to(jsonb_build_object(
        'schema', 'postwave.campaign-report-projection-rollback-parameters.v1',
        'campaign_report_event_id', p_campaign_report_event_id,
        'imported_resource_id', p_imported_resource_id
    )::text, 'UTF8'), 'sha256'), 'hex');

    PERFORM pg_advisory_xact_lock(pg_catalog.hashtextextended(
        p_tenant_id::text || E'\x1f' || p_request_id::text, 1964
    ));
    SELECT request.* INTO existing
      FROM public.campaign_report_projection_mutation_requests AS request
     WHERE request.tenant_id = p_tenant_id
       AND request.request_id = p_request_id;
    IF FOUND THEN
        IF existing.purpose <> 'migration_rollback'
           OR existing.operation <> 'rollback_tombstone'
           OR existing.parameter_fingerprint IS DISTINCT FROM parameter_fingerprint THEN
            RAISE EXCEPTION 'campaign report rollback request replay conflicts'
                USING ERRCODE = '23505';
        END IF;
        RETURN 'replayed';
    END IF;

    SELECT resource.* INTO ledger
      FROM public.migration_imported_resources AS resource
     WHERE resource.tenant_id = p_tenant_id
       AND resource.id = p_imported_resource_id
       AND resource.resource_type = 'campaign_report_event'
       AND resource.destination_type = 'postwave_campaign_report_event'
       AND resource.destination_id = p_campaign_report_event_id::text
       AND resource.rolled_back_at IS NULL
     FOR UPDATE;
    IF NOT FOUND OR ledger.destination_metadata ->> 'operation' <> 'created' THEN
        RAISE EXCEPTION 'campaign report rollback lacks an active exact create ledger'
            USING ERRCODE = '42501';
    END IF;

    SELECT array_agg(candidate.at ORDER BY candidate.at)
      INTO report_ats
      FROM (
          SELECT event.at
            FROM public.campaign_report_events AS event
           WHERE event.tenant_id = p_tenant_id
             AND event.id = p_campaign_report_event_id
           ORDER BY event.at
           LIMIT 2
           FOR UPDATE
      ) AS candidate;
    IF cardinality(report_ats) IS NULL OR cardinality(report_ats) = 0 THEN
        RAISE EXCEPTION 'tracked campaign report rollback row is missing'
            USING ERRCODE = '23503';
    END IF;
    IF cardinality(report_ats) > 1 THEN
        RAISE EXCEPTION 'tracked campaign report rollback id is ambiguous across partitions'
            USING ERRCODE = '21000';
    END IF;
    SELECT event.* INTO report
      FROM public.campaign_report_events AS event
     WHERE event.tenant_id = p_tenant_id
       AND event.id = p_campaign_report_event_id
       AND event.at = report_ats[1]
     FOR UPDATE;

    -- This function is the only report-row delete authority, so it must also
    -- own the after-image proof under the same row lock. The generic migration
    -- preflight cannot use SELECT ... FOR UPDATE here without granting the app
    -- role UPDATE on the compatibility report, which would defeat the 1959
    -- immutability boundary. RecordImportedResource fingerprints exactly
    -- to_jsonb(destination_row)::text, including the session-zone rendering of
    -- timestamptz. New ledgers record that zone; old ledgers safely fall back
    -- to the caller's pre-function TimeZone (pg_settings.reset_val while this
    -- function's SET TimeZone=UTC frame is active).
    destination_after_timezone := NULLIF(
        ledger.destination_metadata ->> 'destination_after_timezone', ''
    );
    IF destination_after_timezone IS NULL THEN
        SELECT setting.reset_val
          INTO destination_after_timezone
          FROM pg_catalog.pg_settings AS setting
         WHERE setting.name = 'TimeZone';
    END IF;
    IF destination_after_timezone IS NULL
       OR length(destination_after_timezone) > 128 THEN
        RAISE EXCEPTION 'tracked campaign report rollback snapshot timezone is invalid'
            USING ERRCODE = '22023';
    END IF;
    PERFORM set_config('TimeZone', destination_after_timezone, true);
    SELECT encode(digest(convert_to(
               to_jsonb(event.*)::text, 'UTF8'
           ), 'sha256'), 'hex')
      INTO destination_after_fingerprint
      FROM public.campaign_report_events AS event
     WHERE event.tenant_id = p_tenant_id
       AND event.id = p_campaign_report_event_id
       AND event.at = report_ats[1];
    PERFORM set_config('TimeZone', 'UTC', true);
    IF ledger.destination_metadata ->> 'destination_after_sha256' IS NULL
       OR ledger.destination_metadata ->> 'destination_after_sha256'
            !~ '^[0-9a-f]{64}$'
       OR ledger.destination_metadata ->> 'destination_after_sha256'
            IS DISTINCT FROM destination_after_fingerprint THEN
        RAISE EXCEPTION 'tracked campaign report rollback destination changed after import'
            USING ERRCODE = '23505';
    END IF;

    before_report_fingerprint :=
        public.campaign_report_projection_report_fingerprint(report);

    SELECT link.* INTO projection
      FROM public.campaign_report_event_projections AS link
     WHERE link.tenant_id = p_tenant_id
       AND link.campaign_report_event_id = report.id
       AND link.campaign_report_event_at = report.at
     FOR SHARE;
    IF FOUND THEN
        PERFORM public.campaign_report_projection_ensure_head(
            projection.tenant_id, projection.subscriber_event_id,
            projection.subscriber_event_at
        );
        SELECT current_head.* INTO head
          FROM public.campaign_report_event_projection_heads AS current_head
         WHERE current_head.tenant_id = projection.tenant_id
           AND current_head.subscriber_event_id = projection.subscriber_event_id
           AND current_head.subscriber_event_at = projection.subscriber_event_at
         FOR UPDATE;
        SELECT event.* INTO canonical
          FROM public.subscriber_events AS event
         WHERE event.tenant_id = projection.tenant_id
           AND event.id = projection.subscriber_event_id
           AND event.at = projection.subscriber_event_at
         FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'linked rollback canonical event is missing'
                USING ERRCODE = '23503';
        END IF;
        IF canonical.metadata ->> 'migration_imported_resource_id'
                IS DISTINCT FROM p_imported_resource_id::text
           OR canonical.metadata ->> 'migration_job_id'
                IS DISTINCT FROM ledger.job_id::text THEN
            RAISE EXCEPTION 'linked rollback canonical event lacks exact migration ownership'
                USING ERRCODE = '42501';
        END IF;
        before_source_fingerprint :=
            public.campaign_report_projection_source_fingerprint(canonical);
        before_projection_fingerprint :=
            public.campaign_report_projection_state_fingerprint(
                projection.projection_version,
                before_source_fingerprint,
                before_report_fingerprint
            );
        IF head.current_source_fingerprint IS DISTINCT FROM before_source_fingerprint
           OR head.current_report_fingerprint IS DISTINCT FROM before_report_fingerprint
           OR head.current_projection_fingerprint IS DISTINCT FROM
                before_projection_fingerprint
           OR head.original_projection_fingerprint IS DISTINCT FROM
                projection.projection_fingerprint THEN
            RAISE EXCEPTION 'linked rollback projection head conflicts with current rows'
                USING ERRCODE = '23505';
        END IF;
        source_count := 1;
        projected_count := 1;
        operation_name := 'tombstone';
        changed_fields := jsonb_build_array(
            'canonical_source', 'compatibility_report', 'projection_link'
        );
        previous_chain_hash := head.chain_hash;
    ELSE
        operation_name := 'legacy_tombstone';
        changed_fields := jsonb_build_array('compatibility_report');
        previous_chain_hash := encode(digest(convert_to(jsonb_build_object(
            'schema', 'postwave.campaign-report-legacy-tombstone-chain.v1',
            'tenant_id', p_tenant_id,
            'campaign_report_event_id', report.id,
            'campaign_report_event_at', report.at,
            'before_report_fingerprint', before_report_fingerprint
        )::text, 'UTF8'), 'sha256'), 'hex');
    END IF;

    receipt_fingerprint := encode(digest(convert_to(jsonb_build_object(
        'schema', 'postwave.campaign-report-projection-mutation-receipt.v1',
        'id', receipt_id,
        'tenant_id', p_tenant_id,
        'request_id', p_request_id,
        'purpose', 'migration_rollback',
        'operation', operation_name,
        'subscriber_event_id', projection.subscriber_event_id,
        'subscriber_event_at', projection.subscriber_event_at,
        'campaign_report_event_id', report.id,
        'campaign_report_event_at', report.at,
        'projection_version', projection.projection_version,
        'original_projection_fingerprint', projection.projection_fingerprint,
        'mutation_sequence', COALESCE(head.mutation_sequence, 0) + 1,
        'changed_fields', changed_fields,
        'before_source_fingerprint', before_source_fingerprint,
        'after_source_fingerprint', NULL,
        'before_report_fingerprint', before_report_fingerprint,
        'after_report_fingerprint', NULL,
        'previous_chain_hash', previous_chain_hash,
        'recorded_at', mutation_at
    )::text, 'UTF8'), 'sha256'), 'hex');

    INSERT INTO public.campaign_report_projection_mutation_receipts (
        id, tenant_id, request_id, purpose, operation,
        subscriber_event_id, subscriber_event_at,
        campaign_report_event_id, campaign_report_event_at,
        projection_version, original_projection_fingerprint,
        mutation_sequence, changed_fields,
        before_source_fingerprint, after_source_fingerprint,
        before_report_fingerprint, after_report_fingerprint,
        previous_chain_hash, recorded_at, receipt_fingerprint
    ) VALUES (
        receipt_id, p_tenant_id, p_request_id, 'migration_rollback',
        operation_name, projection.subscriber_event_id,
        projection.subscriber_event_at, report.id, report.at,
        projection.projection_version, projection.projection_fingerprint,
        COALESCE(head.mutation_sequence, 0) + 1, changed_fields,
        before_source_fingerprint, NULL, before_report_fingerprint, NULL,
        previous_chain_hash, mutation_at, receipt_fingerprint
    );

    IF projection.tenant_id IS NOT NULL THEN
        INSERT INTO public.campaign_report_projection_mutation_authorizations (
            backend_pid, transaction_id, tenant_id,
            subscriber_event_id, subscriber_event_at,
            campaign_report_event_id, campaign_report_event_at,
            allowed_operation, request_id
        ) VALUES (
            pg_backend_pid(), txid_current(), p_tenant_id,
            projection.subscriber_event_id, projection.subscriber_event_at,
            report.id, report.at, 'delete', p_request_id
        );
    END IF;
    DELETE FROM public.campaign_report_events AS event
     WHERE event.tenant_id = p_tenant_id
       AND event.id = report.id
       AND event.at = report.at;
    IF projection.tenant_id IS NOT NULL THEN
        DELETE FROM public.subscriber_events AS event
         WHERE event.tenant_id = projection.tenant_id
           AND event.id = projection.subscriber_event_id
           AND event.at = projection.subscriber_event_at;
        DELETE FROM public.campaign_report_projection_mutation_authorizations
         WHERE backend_pid = pg_backend_pid()
           AND transaction_id = txid_current()
           AND tenant_id = p_tenant_id
           AND campaign_report_event_id = report.id
           AND campaign_report_event_at = report.at
           AND allowed_operation = 'delete';
    END IF;

    request_fingerprint := encode(digest(convert_to(jsonb_build_object(
        'schema', 'postwave.campaign-report-projection-mutation-request.v1',
        'tenant_id', p_tenant_id,
        'request_id', p_request_id,
        'purpose', 'migration_rollback',
        'operation', 'rollback_tombstone',
        'parameter_fingerprint', parameter_fingerprint,
        'source_rows_affected', source_count,
        'report_rows_affected', 1,
        'projected_rows_affected', projected_count,
        'recorded_at', mutation_at
    )::text, 'UTF8'), 'sha256'), 'hex');
    INSERT INTO public.campaign_report_projection_mutation_requests (
        tenant_id, request_id, purpose, operation, parameter_fingerprint,
        source_rows_affected, report_rows_affected,
        projected_rows_affected, recorded_at, request_fingerprint
    ) VALUES (
        p_tenant_id, p_request_id, 'migration_rollback',
        'rollback_tombstone', parameter_fingerprint, source_count, 1,
        projected_count, mutation_at, request_fingerprint
    );
    RETURN operation_name || '_deleted';
END;
$fn$;

REVOKE ALL ON FUNCTION campaign_report_projection_rollback_delete(
    uuid, bigint, uuid, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION campaign_report_projection_rollback_delete(
    uuid, bigint, uuid, uuid
) TO postwave_app;

-- Preserve the public 1959 function signature while making replay aware of a
-- receipt-backed current head. New materializations still delegate to the
-- original, independently tested exact projector.
ALTER FUNCTION append_campaign_report_event_projection(
    uuid, bigint, timestamptz, text, uuid, uuid, integer
) RENAME TO append_campaign_report_event_projection_immutable_v1;

REVOKE ALL ON FUNCTION append_campaign_report_event_projection_immutable_v1(
    uuid, bigint, timestamptz, text, uuid, uuid, integer
) FROM PUBLIC, postwave_app;

CREATE OR REPLACE FUNCTION append_campaign_report_event_projection(
    p_tenant_id uuid,
    p_subscriber_event_id bigint,
    p_subscriber_event_at timestamptz,
    p_projection_version text,
    p_reconciliation_run_id uuid DEFAULT NULL,
    p_reconciliation_lease_token uuid DEFAULT NULL,
    p_reconciliation_attempt integer DEFAULT NULL
)
RETURNS TABLE (
    campaign_report_event_id bigint,
    campaign_report_event_at timestamptz,
    materialization_method text,
    projection_inserted boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET TimeZone = 'UTC'
AS $fn$
DECLARE
    canonical public.subscriber_events%ROWTYPE;
    projection public.campaign_report_event_projections%ROWTYPE;
    head public.campaign_report_event_projection_heads%ROWTYPE;
    report public.campaign_report_events%ROWTYPE;
    last_receipt public.campaign_report_projection_mutation_receipts%ROWTYPE;
    source_fingerprint text;
    report_fingerprint text;
    projection_fingerprint text;
BEGIN
    IF current_setting('app.outbox_worker', true) IS DISTINCT FROM 'true'
       OR current_setting('app.campaign_report_projection_worker', true)
          IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'campaign report projection requires worker capabilities'
            USING ERRCODE = '42501';
    END IF;
    IF p_tenant_id IS NULL
       OR p_tenant_id::text IS DISTINCT FROM
          NULLIF(current_setting('app.tenant_id', true), '') THEN
        RAISE EXCEPTION 'campaign report projection tenant scope mismatch'
            USING ERRCODE = '42501';
    END IF;
    IF p_subscriber_event_id IS NULL OR p_subscriber_event_id <= 0
       OR p_subscriber_event_at IS NULL
       OR p_projection_version IS NULL
       OR p_projection_version !~ '^[a-z0-9][a-z0-9_.-]{0,95}$' THEN
        RAISE EXCEPTION 'invalid campaign report projection identity/version'
            USING ERRCODE = '22023';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        p_tenant_id::text || E'\x1f' || p_subscriber_event_id::text ||
        E'\x1f' || p_subscriber_event_at::text,
        1959
    ));
    SELECT link.* INTO projection
      FROM public.campaign_report_event_projections AS link
     WHERE link.tenant_id = p_tenant_id
       AND link.subscriber_event_id = p_subscriber_event_id
       AND link.subscriber_event_at = p_subscriber_event_at;
    IF NOT FOUND THEN
        RETURN QUERY
        SELECT *
          FROM public.append_campaign_report_event_projection_immutable_v1(
              p_tenant_id, p_subscriber_event_id, p_subscriber_event_at,
              p_projection_version, p_reconciliation_run_id,
              p_reconciliation_lease_token, p_reconciliation_attempt
          );
        RETURN;
    END IF;

    SELECT event.* INTO canonical
      FROM public.subscriber_events AS event
     WHERE event.tenant_id = p_tenant_id
       AND event.id = p_subscriber_event_id
       AND event.at = p_subscriber_event_at;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'canonical subscriber event does not exist'
            USING ERRCODE = '23503';
    END IF;
    IF canonical.campaign_id IS NULL
       OR canonical.event_type <> ALL (ARRAY[
            'delivered', 'opened', 'clicked', 'bounced',
            'complained', 'unsubscribed', 'replied'
       ]::text[])
       OR NOT EXISTS (
            SELECT 1 FROM public.campaigns AS campaign
             WHERE campaign.tenant_id = p_tenant_id
               AND campaign.id = canonical.campaign_id
       ) THEN
        RAISE EXCEPTION 'canonical subscriber event is not projectable in v1'
            USING ERRCODE = '22023';
    END IF;
    IF p_reconciliation_run_id IS NULL THEN
        IF p_reconciliation_lease_token IS NOT NULL
           OR p_reconciliation_attempt IS NOT NULL THEN
            RAISE EXCEPTION 'direct projection cannot carry a reconciliation lease'
                USING ERRCODE = '22023';
        END IF;
    ELSE
        IF p_reconciliation_lease_token IS NULL
           OR p_reconciliation_attempt IS NULL
           OR p_reconciliation_attempt <= 0 THEN
            RAISE EXCEPTION 'run-owned projection requires a complete lease fence'
                USING ERRCODE = '22023';
        END IF;
        PERFORM 1
          FROM public.campaign_report_projection_runs AS run
         WHERE run.tenant_id = p_tenant_id
           AND run.id = p_reconciliation_run_id
           AND run.projection_version = p_projection_version
           AND run.state = 'running'
           AND run.lease_token = p_reconciliation_lease_token
           AND run.attempt_count = p_reconciliation_attempt
           AND run.lease_expires_at > clock_timestamp()
           AND canonical.at >= run.event_window_start
           AND canonical.at < run.event_window_end
           AND canonical.id <= run.fence_event_id
           AND (
               run.cursor_event_at IS NULL
               OR (canonical.at, canonical.id) >
                  (run.cursor_event_at, run.cursor_event_id)
           )
         FOR SHARE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'projection event is outside the active run lease/fence'
                USING ERRCODE = '55000';
        END IF;
    END IF;
    IF projection.projection_version IS DISTINCT FROM p_projection_version THEN
        RAISE EXCEPTION 'campaign report projection replay conflicts with immutable evidence'
            USING ERRCODE = '23505';
    END IF;

    PERFORM public.campaign_report_projection_ensure_head(
        p_tenant_id, p_subscriber_event_id, p_subscriber_event_at
    );
    SELECT current_head.* INTO head
      FROM public.campaign_report_event_projection_heads AS current_head
     WHERE current_head.tenant_id = p_tenant_id
       AND current_head.subscriber_event_id = p_subscriber_event_id
       AND current_head.subscriber_event_at = p_subscriber_event_at;
    SELECT event.* INTO report
      FROM public.campaign_report_events AS event
     WHERE event.tenant_id = p_tenant_id
       AND event.id = projection.campaign_report_event_id
       AND event.at = projection.campaign_report_event_at;
    IF head.tenant_id IS NULL OR report.tenant_id IS NULL THEN
        RAISE EXCEPTION 'campaign report projection replay state is incomplete'
            USING ERRCODE = '23503';
    END IF;
    source_fingerprint :=
        public.campaign_report_projection_source_fingerprint(canonical);
    report_fingerprint :=
        public.campaign_report_projection_report_fingerprint(report);
    projection_fingerprint :=
        public.campaign_report_projection_state_fingerprint(
            projection.projection_version,
            source_fingerprint,
            report_fingerprint
        );
    IF head.original_projection_fingerprint IS DISTINCT FROM
            projection.projection_fingerprint
       OR head.current_source_fingerprint IS DISTINCT FROM source_fingerprint
       OR head.current_report_fingerprint IS DISTINCT FROM report_fingerprint
       OR head.current_projection_fingerprint IS DISTINCT FROM projection_fingerprint THEN
        RAISE EXCEPTION 'campaign report projection replay conflicts with mutation head'
            USING ERRCODE = '23505';
    END IF;
    IF head.mutation_sequence > 0 THEN
        SELECT receipt.* INTO last_receipt
          FROM public.campaign_report_projection_mutation_receipts AS receipt
         WHERE receipt.tenant_id = p_tenant_id
           AND receipt.id = head.last_receipt_id;
        IF NOT FOUND
           OR last_receipt.request_id IS DISTINCT FROM head.last_request_id
           OR last_receipt.mutation_sequence IS DISTINCT FROM head.mutation_sequence
           OR last_receipt.receipt_fingerprint IS DISTINCT FROM head.chain_hash
           OR last_receipt.after_source_fingerprint IS DISTINCT FROM
                head.current_source_fingerprint
           OR last_receipt.after_report_fingerprint IS DISTINCT FROM
                head.current_report_fingerprint THEN
            RAISE EXCEPTION 'campaign report projection mutation receipt chain is incomplete'
                USING ERRCODE = '23505';
        END IF;
    END IF;

    RETURN QUERY SELECT projection.campaign_report_event_id,
        projection.campaign_report_event_at,
        projection.materialization_method, false;
END;
$fn$;

REVOKE ALL ON FUNCTION append_campaign_report_event_projection(
    uuid, bigint, timestamptz, text, uuid, uuid, integer
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION append_campaign_report_event_projection(
    uuid, bigint, timestamptz, text, uuid, uuid, integer
) TO postwave_app;

REVOKE ALL ON campaign_report_projection_mutation_requests,
    campaign_report_projection_mutation_receipts,
    campaign_report_event_projection_heads
    FROM PUBLIC, postwave_app;
GRANT SELECT ON campaign_report_projection_mutation_requests,
    campaign_report_projection_mutation_receipts,
    campaign_report_event_projection_heads
    TO postwave_app;

ALTER TABLE campaign_report_projection_mutation_requests
    ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_report_projection_mutation_requests
    FORCE ROW LEVEL SECURITY;
ALTER TABLE campaign_report_projection_mutation_receipts
    ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_report_projection_mutation_receipts
    FORCE ROW LEVEL SECURITY;
ALTER TABLE campaign_report_event_projection_heads
    ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_report_event_projection_heads
    FORCE ROW LEVEL SECURITY;

CREATE POLICY campaign_report_projection_mutation_requests_evidence_select
    ON campaign_report_projection_mutation_requests
    AS PERMISSIVE FOR SELECT TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND current_setting('app.outbox_worker', true) = 'true'
        AND current_setting(
            'app.campaign_report_projection_mutation_reader', true
        ) = 'true'
    );

CREATE POLICY campaign_report_projection_mutation_receipts_evidence_select
    ON campaign_report_projection_mutation_receipts
    AS PERMISSIVE FOR SELECT TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND current_setting('app.outbox_worker', true) = 'true'
        AND current_setting(
            'app.campaign_report_projection_mutation_reader', true
        ) = 'true'
    );

CREATE POLICY campaign_report_projection_heads_evidence_select
    ON campaign_report_event_projection_heads
    AS PERMISSIVE FOR SELECT TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND current_setting('app.outbox_worker', true) = 'true'
        AND current_setting(
            'app.campaign_report_projection_mutation_reader', true
        ) = 'true'
    );

COMMENT ON TABLE campaign_report_projection_mutation_requests IS
    'Immutable, content-free idempotency summaries for governed canonical/report projection mutations.';
COMMENT ON TABLE campaign_report_projection_mutation_receipts IS
    'Immutable chained before/after or tombstone fingerprints for every linked campaign-report projection mutation.';
COMMENT ON TABLE campaign_report_event_projection_heads IS
    'Current verified fingerprint head for a 1959 projection; original projection fingerprint remains immutable.';
COMMENT ON FUNCTION campaign_report_projection_repoint_subscriber_events(
    uuid, citext[], citext, text, uuid
) IS
    'Tenant-bound purpose-specific subscriber event identity repoint; mirrors linked report rows and appends chained receipts.';
COMMENT ON FUNCTION campaign_report_projection_privacy_erase_subscriber_events(
    uuid, citext[], citext, uuid
) IS
    'Tenant-bound Art. 17 subscriber-event redaction; mirrors linked report PII fields and appends chained receipts.';
COMMENT ON FUNCTION campaign_report_projection_rollback_delete(
    uuid, bigint, uuid, uuid
) IS
    'Tracked migration rollback delete; preserves legacy unlinked deletion and requires exact canonical ownership for linked tombstones.';

COMMIT;
