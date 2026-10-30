-- 1959_campaign_report_canonical_projection.sql
--
-- F01 convergence foundation: campaign_report_events remains the compatibility
-- read model, but engagement rows can now be proven to be a projection of the
-- canonical, partitioned subscriber_events ledger instead of an unrelated peer
-- write.  Exact legacy rows are adopted in place; a missing compatibility row
-- is appended once.  Immutable linkage and fingerprints make both paths
-- replay-safe without changing any existing reader or legacy writer yet.
--
-- The projected engagement vocabulary is delivered/opened/clicked/bounced/
-- complained/unsubscribed/replied. sent and conversion do not yet exist in
-- subscriber_events and remain explicit follow-up schema/caller cutovers rather
-- than lossy coercions in this migration.
--
-- rollback-strategy: no-op. Projection links, source/report fingerprints and
-- reconciliation fences are measurement lineage. Older binaries ignore these
-- additive tables/functions and continue using campaign_report_events.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- Add replied without rescanning the partitioned history. The old validated
-- constraint is a strict subset of this one, so PostgreSQL can prove the new
-- NOT VALID constraint from existing partition constraints before the old name
-- is retired. New rows are checked even during the short validation window.
ALTER TABLE campaign_report_events
    ADD CONSTRAINT campaign_report_events_event_type_check_v2 CHECK (
        event_type IN (
            'sent', 'delivered', 'opened', 'clicked', 'bounced',
            'complained', 'unsubscribed', 'conversion', 'replied'
        )
    ) NOT VALID;
ALTER TABLE campaign_report_events
    VALIDATE CONSTRAINT campaign_report_events_event_type_check_v2;
ALTER TABLE campaign_report_events
    DROP CONSTRAINT campaign_report_events_event_type_check;
ALTER TABLE campaign_report_events
    RENAME CONSTRAINT campaign_report_events_event_type_check_v2
    TO campaign_report_events_event_type_check;

-- campaign_report_events is partitioned by at and has primary key (id, at),
-- which cannot include tenant_id without rebuilding every partition.  This
-- narrow identity bridge is populated only by the SECURITY DEFINER projector
-- after it has proved the report row's tenant.  Projection links can therefore
-- use a tenant-safe composite FK without changing the hot compatibility table.
CREATE TABLE campaign_report_event_projection_identities (
    tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_report_event_id bigint NOT NULL,
    campaign_report_event_at timestamptz NOT NULL,
    recorded_at              timestamptz NOT NULL DEFAULT clock_timestamp(),

    PRIMARY KEY (
        tenant_id, campaign_report_event_id, campaign_report_event_at
    ),
    CONSTRAINT campaign_report_projection_identities_report_fk
        FOREIGN KEY (campaign_report_event_id, campaign_report_event_at)
        REFERENCES campaign_report_events (id, at)
        ON DELETE CASCADE
);

-- A run captures an id-sequence fence at creation time. Filtering source rows
-- by id <= fence_event_id excludes late/backdated inserts, which an at-only
-- high-water mark cannot do. The (at,id) cursor remains deterministic across
-- partitions and advances in the same transaction as every projected page.
CREATE TABLE campaign_report_projection_runs (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    request_id               uuid NOT NULL,
    request_hash             text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    projection_version       text NOT NULL CHECK (
                                 projection_version ~ '^[a-z0-9][a-z0-9_.-]{0,95}$'
                             ),
    event_window_start       timestamptz NOT NULL,
    event_window_end         timestamptz NOT NULL,
    fence_event_id           bigint NOT NULL CHECK (fence_event_id >= 0),
    fence_captured_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
    cursor_event_at          timestamptz,
    cursor_event_id          bigint,
    candidate_count          bigint NOT NULL CHECK (candidate_count >= 0),
    processed_count          bigint NOT NULL DEFAULT 0 CHECK (processed_count >= 0),
    inserted_count           bigint NOT NULL DEFAULT 0 CHECK (inserted_count >= 0),
    adopted_count            bigint NOT NULL DEFAULT 0 CHECK (adopted_count >= 0),
    replayed_count           bigint NOT NULL DEFAULT 0 CHECK (replayed_count >= 0),
    state                    text NOT NULL DEFAULT 'queued' CHECK (
                                 state IN ('queued', 'running', 'completed', 'failed')
                             ),
    worker_id                text CHECK (
                                 worker_id IS NULL OR (
                                     length(worker_id) BETWEEN 1 AND 200
                                     AND worker_id !~ '[[:cntrl:]]'
                                 )
                             ),
    lease_token              uuid,
    lease_expires_at         timestamptz,
    heartbeat_at             timestamptz,
    attempt_count            integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    error_code               text CHECK (
                                 error_code IS NULL OR
                                 error_code ~ '^[a-z][a-z0-9_.-]{0,95}$'
                             ),
    created_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
    started_at               timestamptz,
    completed_at             timestamptz,
    updated_at               timestamptz NOT NULL DEFAULT clock_timestamp(),

    UNIQUE (tenant_id, request_id),
    UNIQUE (tenant_id, id),
    CONSTRAINT campaign_report_projection_runs_window_check CHECK (
        event_window_end > event_window_start
    ),
    CONSTRAINT campaign_report_projection_runs_cursor_shape CHECK (
        (cursor_event_at IS NULL) = (cursor_event_id IS NULL)
        AND (cursor_event_id IS NULL OR cursor_event_id > 0)
    ),
    CONSTRAINT campaign_report_projection_runs_counter_shape CHECK (
        processed_count = inserted_count + adopted_count + replayed_count
        AND processed_count <= candidate_count
        AND (state <> 'completed' OR processed_count = candidate_count)
    ),
    CONSTRAINT campaign_report_projection_runs_state_shape CHECK (
        (state = 'queued'
            AND worker_id IS NULL AND lease_token IS NULL
            AND lease_expires_at IS NULL AND heartbeat_at IS NULL
            AND started_at IS NULL AND completed_at IS NULL
            AND attempt_count = 0 AND error_code IS NULL)
        OR
        (state = 'running'
            AND worker_id IS NOT NULL AND lease_token IS NOT NULL
            AND lease_expires_at IS NOT NULL AND heartbeat_at IS NOT NULL
            AND lease_expires_at > heartbeat_at
            AND started_at IS NOT NULL AND completed_at IS NULL
            AND attempt_count > 0 AND error_code IS NULL)
        OR
        (state = 'completed'
            AND worker_id IS NOT NULL AND lease_token IS NOT NULL
            AND lease_expires_at IS NOT NULL AND heartbeat_at IS NOT NULL
            AND started_at IS NOT NULL AND completed_at IS NOT NULL
            AND attempt_count > 0 AND error_code IS NULL)
        OR
        (state = 'failed'
            AND worker_id IS NOT NULL AND lease_token IS NOT NULL
            AND lease_expires_at IS NOT NULL AND heartbeat_at IS NOT NULL
            AND started_at IS NOT NULL AND completed_at IS NOT NULL
            AND attempt_count > 0 AND error_code IS NOT NULL)
    )
);

CREATE INDEX campaign_report_projection_runs_tenant_state_idx
    ON campaign_report_projection_runs (
        tenant_id, state, lease_expires_at, created_at, id
    );

-- One canonical subscriber event may materialize exactly one compatibility
-- report row, and one compatibility row may derive from exactly one canonical
-- event. Both sides include tenant_id in their enforced identity edge.
CREATE TABLE campaign_report_event_projections (
    tenant_id                  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_event_id        bigint NOT NULL,
    subscriber_event_at        timestamptz NOT NULL,
    campaign_report_event_id   bigint NOT NULL,
    campaign_report_event_at   timestamptz NOT NULL,
    projection_version         text NOT NULL CHECK (
                                   projection_version ~ '^[a-z0-9][a-z0-9_.-]{0,95}$'
                               ),
    materialization_method     text NOT NULL CHECK (
                                   materialization_method IN (
                                       'inserted_projection', 'adopted_legacy'
                                   )
                               ),
    source_event_fingerprint   text NOT NULL CHECK (
                                   source_event_fingerprint ~ '^[0-9a-f]{64}$'
                               ),
    report_event_fingerprint   text NOT NULL CHECK (
                                   report_event_fingerprint ~ '^[0-9a-f]{64}$'
                               ),
    projection_fingerprint     text NOT NULL CHECK (
                                   projection_fingerprint ~ '^[0-9a-f]{64}$'
                               ),
    reconciliation_run_id      uuid,
    recorded_at                timestamptz NOT NULL DEFAULT clock_timestamp(),

    PRIMARY KEY (tenant_id, subscriber_event_id, subscriber_event_at),
    UNIQUE (
        tenant_id, campaign_report_event_id, campaign_report_event_at
    ),
    CONSTRAINT campaign_report_event_projections_source_fk
        FOREIGN KEY (tenant_id, subscriber_event_id, subscriber_event_at)
        REFERENCES subscriber_event_engagement_identities (
            tenant_id, subscriber_event_id, subscriber_event_at
        )
        ON DELETE CASCADE,
    CONSTRAINT campaign_report_event_projections_report_fk
        FOREIGN KEY (
            tenant_id, campaign_report_event_id, campaign_report_event_at
        )
        REFERENCES campaign_report_event_projection_identities (
            tenant_id, campaign_report_event_id, campaign_report_event_at
        )
        ON DELETE CASCADE,
    CONSTRAINT campaign_report_event_projections_run_fk
        FOREIGN KEY (tenant_id, reconciliation_run_id)
        REFERENCES campaign_report_projection_runs (tenant_id, id)
        ON DELETE SET NULL
);

CREATE INDEX campaign_report_event_projections_run_idx
    ON campaign_report_event_projections (
        tenant_id, reconciliation_run_id, subscriber_event_at,
        subscriber_event_id
    ) WHERE reconciliation_run_id IS NOT NULL;

-- Projection evidence is immutable. Nested deletes are tenant/event cascade
-- erasure, matching the established engagement-evidence convention.
CREATE OR REPLACE FUNCTION campaign_report_projection_append_only_guard()
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

CREATE TRIGGER campaign_report_projection_identities_append_only
    BEFORE UPDATE OR DELETE ON campaign_report_event_projection_identities
    FOR EACH ROW EXECUTE FUNCTION campaign_report_projection_append_only_guard();
CREATE TRIGGER campaign_report_event_projections_append_only
    BEFORE UPDATE OR DELETE ON campaign_report_event_projections
    FOR EACH ROW EXECUTE FUNCTION campaign_report_projection_append_only_guard();

-- Once a report row has been bound as a canonical projection, its materialized
-- payload is also immutable. Existing unlinked legacy rows retain their prior
-- behavior. Nested cascade deletes remain possible for tenant erasure.
CREATE OR REPLACE FUNCTION campaign_report_projected_row_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
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

CREATE TRIGGER campaign_report_events_projected_row_immutable
    BEFORE UPDATE OR DELETE ON campaign_report_events
    FOR EACH ROW EXECUTE FUNCTION campaign_report_projected_row_immutable_guard();

CREATE OR REPLACE FUNCTION campaign_report_projection_run_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF pg_trigger_depth() > 1 THEN
            RETURN OLD;
        END IF;
        RAISE EXCEPTION 'campaign report projection runs cannot be deleted directly'
            USING ERRCODE = '55000';
    END IF;
    IF OLD.id IS DISTINCT FROM NEW.id
       OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
       OR OLD.request_id IS DISTINCT FROM NEW.request_id
       OR OLD.request_hash IS DISTINCT FROM NEW.request_hash
       OR OLD.projection_version IS DISTINCT FROM NEW.projection_version
       OR OLD.event_window_start IS DISTINCT FROM NEW.event_window_start
       OR OLD.event_window_end IS DISTINCT FROM NEW.event_window_end
       OR OLD.fence_event_id IS DISTINCT FROM NEW.fence_event_id
       OR OLD.fence_captured_at IS DISTINCT FROM NEW.fence_captured_at
       OR OLD.candidate_count IS DISTINCT FROM NEW.candidate_count
       OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
        RAISE EXCEPTION 'campaign report projection run identity/fence is immutable'
            USING ERRCODE = '55000';
    END IF;
    IF OLD.state IN ('completed', 'failed') AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'terminal campaign report projection run is immutable'
            USING ERRCODE = '55000';
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
        (OLD.state = 'queued' AND NEW.state = 'running')
        OR (OLD.state = 'running' AND NEW.state IN ('completed', 'failed'))
    ) THEN
        RAISE EXCEPTION 'invalid campaign report projection transition: % -> %',
            OLD.state, NEW.state USING ERRCODE = '55000';
    END IF;
    IF NEW.processed_count < OLD.processed_count
       OR NEW.inserted_count < OLD.inserted_count
       OR NEW.adopted_count < OLD.adopted_count
       OR NEW.replayed_count < OLD.replayed_count THEN
        RAISE EXCEPTION 'campaign report projection counters must be monotonic'
            USING ERRCODE = '55000';
    END IF;
    IF OLD.cursor_event_at IS NOT NULL AND (
        NEW.cursor_event_at IS NULL
        OR (NEW.cursor_event_at, NEW.cursor_event_id)
           < (OLD.cursor_event_at, OLD.cursor_event_id)
    ) THEN
        RAISE EXCEPTION 'campaign report projection cursor cannot move backwards'
            USING ERRCODE = '55000';
    END IF;
    IF OLD.state = 'queued' AND NEW.state = 'running'
       AND NEW.attempt_count <> 1 THEN
        RAISE EXCEPTION 'initial campaign report projection lease must be attempt 1'
            USING ERRCODE = '55000';
    END IF;
    IF OLD.state = 'running' AND NEW.state = 'running' THEN
        IF NEW.lease_token IS DISTINCT FROM OLD.lease_token THEN
            IF OLD.lease_expires_at > statement_timestamp()
               OR NEW.attempt_count <> OLD.attempt_count + 1 THEN
                RAISE EXCEPTION 'active campaign report projection lease cannot be stolen'
                    USING ERRCODE = '55000';
            END IF;
        ELSE
            IF NEW.attempt_count IS DISTINCT FROM OLD.attempt_count
               OR NEW.worker_id IS DISTINCT FROM OLD.worker_id THEN
                RAISE EXCEPTION 'campaign report projection lease identity changed without fencing'
                    USING ERRCODE = '55000';
            END IF;
        END IF;
        IF NEW.heartbeat_at <= OLD.heartbeat_at
           OR NEW.lease_expires_at <= NEW.heartbeat_at
           OR NEW.lease_expires_at <= OLD.lease_expires_at THEN
            RAISE EXCEPTION 'campaign report projection lease renewal must advance'
                USING ERRCODE = '55000';
        END IF;
    END IF;
    IF OLD.state = 'running' AND NEW.state IN ('completed', 'failed')
       AND (NEW.worker_id IS DISTINCT FROM OLD.worker_id
            OR NEW.lease_token IS DISTINCT FROM OLD.lease_token
            OR NEW.attempt_count IS DISTINCT FROM OLD.attempt_count) THEN
        RAISE EXCEPTION 'terminal campaign report projection write lost its fence'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$fn$;

CREATE TRIGGER campaign_report_projection_runs_guard
    BEFORE UPDATE OR DELETE ON campaign_report_projection_runs
    FOR EACH ROW EXECUTE FUNCTION campaign_report_projection_run_guard();

-- append_campaign_report_event_projection is the only write authority for the
-- immutable identity/link tables. It derives every report field from the
-- canonical row, adopts only a single byte-for-byte semantic match, and rejects
-- both ambiguous adoption and any non-exact replay.
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
    linked public.campaign_report_event_projections%ROWTYPE;
    actual_report public.campaign_report_events%ROWTYPE;
    candidate record;
    candidate_count integer := 0;
    selected_report_id bigint;
    selected_report_at timestamptz;
    selected_method text;
    source_fingerprint text;
    expected_report_fingerprint text;
    actual_report_fingerprint text;
    expected_projection_fingerprint text;
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

    -- A stable collision merely over-serializes two unrelated events; it can
    -- never allow duplicate linkage. The row/unique constraints remain the
    -- final correctness boundary.
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        p_tenant_id::text || E'\x1f' || p_subscriber_event_id::text ||
        E'\x1f' || p_subscriber_event_at::text,
        1959
    ));

    SELECT event.*
      INTO canonical
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
       ]::text[]) THEN
        RAISE EXCEPTION 'canonical subscriber event is not projectable in v1'
            USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.campaigns AS campaign
         WHERE campaign.tenant_id = p_tenant_id
           AND campaign.id = canonical.campaign_id
    ) THEN
        RAISE EXCEPTION 'canonical subscriber event campaign is not tenant-owned'
            USING ERRCODE = '23503';
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
        -- Bind lineage to the exact live lease and immutable run scope. The
        -- cursor predicate still permits every row in the current page because
        -- page progress advances only after all projections commit.
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

    source_fingerprint := encode(digest(convert_to(jsonb_build_object(
        'schema', 'postwave.canonical-subscriber-event.v1',
        'id', canonical.id,
        'tenant_id', canonical.tenant_id,
        'subscriber_email', canonical.subscriber_email::text,
        'event_type', canonical.event_type,
        'campaign_id', canonical.campaign_id,
        'link_url', canonical.link_url,
        'user_agent', canonical.user_agent,
        'ip', canonical.ip::text,
        'at', canonical.at,
        'source', canonical.source,
        'provider_event_id', canonical.provider_event_id,
        'message_id', canonical.message_id,
        'metadata', canonical.metadata,
        'bounce_type', canonical.bounce_type,
        'country', canonical.country,
        'stream', canonical.stream,
        'source_event_id', canonical.source_event_id,
        'event_origin', canonical.event_origin,
        'controlled_seed_test_id', canonical.controlled_seed_test_id,
        'seed_origin_method', canonical.seed_origin_method,
        'event_origin_version', canonical.event_origin_version,
        'is_seed', canonical.is_seed
    )::text, 'UTF8'), 'sha256'), 'hex');

    expected_report_fingerprint := encode(digest(convert_to(jsonb_build_object(
        'schema', 'postwave.campaign-report-event.v1',
        'tenant_id', canonical.tenant_id,
        'campaign_id', canonical.campaign_id,
        'subscriber_email', canonical.subscriber_email::text,
        'event_type', canonical.event_type,
        'link_url', canonical.link_url,
        'user_agent', canonical.user_agent,
        'ip', canonical.ip::text,
        'country', canonical.country,
        'region', NULL,
        'city', NULL,
        'device', NULL,
        'client', NULL,
        'revenue_cents', 0,
        'metadata', canonical.metadata,
        'at', canonical.at,
        'source', canonical.source,
        'provider_event_id', canonical.provider_event_id,
        'message_id', canonical.message_id,
        'event_origin', canonical.event_origin,
        'controlled_seed_test_id', canonical.controlled_seed_test_id,
        'seed_origin_method', canonical.seed_origin_method,
        'event_origin_version', canonical.event_origin_version,
        'is_seed', canonical.is_seed
    )::text, 'UTF8'), 'sha256'), 'hex');

    expected_projection_fingerprint := encode(digest(convert_to(
        jsonb_build_object(
            'schema', 'postwave.campaign-report-projection.v1',
            'projection_version', p_projection_version,
            'source_event_fingerprint', source_fingerprint,
            'report_event_fingerprint', expected_report_fingerprint
        )::text,
        'UTF8'
    ), 'sha256'), 'hex');

    SELECT projection.*
      INTO linked
      FROM public.campaign_report_event_projections AS projection
     WHERE projection.tenant_id = p_tenant_id
       AND projection.subscriber_event_id = p_subscriber_event_id
       AND projection.subscriber_event_at = p_subscriber_event_at;
    IF FOUND THEN
        SELECT report.*
          INTO actual_report
          FROM public.campaign_report_events AS report
         WHERE report.tenant_id = linked.tenant_id
           AND report.id = linked.campaign_report_event_id
           AND report.at = linked.campaign_report_event_at;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'linked campaign report projection row is missing'
                USING ERRCODE = '23503';
        END IF;
        actual_report_fingerprint := encode(digest(convert_to(jsonb_build_object(
            'schema', 'postwave.campaign-report-event.v1',
            'tenant_id', actual_report.tenant_id,
            'campaign_id', actual_report.campaign_id,
            'subscriber_email', actual_report.subscriber_email::text,
            'event_type', actual_report.event_type,
            'link_url', actual_report.link_url,
            'user_agent', actual_report.user_agent,
            'ip', actual_report.ip::text,
            'country', actual_report.country,
            'region', actual_report.region,
            'city', actual_report.city,
            'device', actual_report.device,
            'client', actual_report.client,
            'revenue_cents', actual_report.revenue_cents,
            'metadata', actual_report.metadata,
            'at', actual_report.at,
            'source', actual_report.source,
            'provider_event_id', actual_report.provider_event_id,
            'message_id', actual_report.message_id,
            'event_origin', actual_report.event_origin,
            'controlled_seed_test_id', actual_report.controlled_seed_test_id,
            'seed_origin_method', actual_report.seed_origin_method,
            'event_origin_version', actual_report.event_origin_version,
            'is_seed', actual_report.is_seed
        )::text, 'UTF8'), 'sha256'), 'hex');
        IF linked.projection_version IS DISTINCT FROM p_projection_version
           OR linked.source_event_fingerprint IS DISTINCT FROM source_fingerprint
           OR linked.report_event_fingerprint IS DISTINCT FROM actual_report_fingerprint
           OR actual_report_fingerprint IS DISTINCT FROM expected_report_fingerprint
           OR linked.projection_fingerprint IS DISTINCT FROM
              expected_projection_fingerprint THEN
            RAISE EXCEPTION 'campaign report projection replay conflicts with immutable evidence'
                USING ERRCODE = '23505';
        END IF;
        RETURN QUERY SELECT linked.campaign_report_event_id,
            linked.campaign_report_event_at, linked.materialization_method, false;
        RETURN;
    END IF;

    -- Adopt an exact unlinked legacy peer row if and only if there is one.
    -- Multiple matches are evidence ambiguity and must not be guessed through.
    FOR candidate IN
        SELECT report.id, report.at
          FROM public.campaign_report_events AS report
         WHERE report.tenant_id = p_tenant_id
           AND report.campaign_id = canonical.campaign_id
           AND report.subscriber_email IS NOT DISTINCT FROM canonical.subscriber_email
           AND report.event_type = canonical.event_type
           AND report.link_url IS NOT DISTINCT FROM canonical.link_url
           AND report.user_agent IS NOT DISTINCT FROM canonical.user_agent
           AND report.ip IS NOT DISTINCT FROM canonical.ip
           AND report.country IS NOT DISTINCT FROM canonical.country
           AND report.region IS NULL
           AND report.city IS NULL
           AND report.device IS NULL
           AND report.client IS NULL
           AND report.revenue_cents = 0
           AND report.metadata = canonical.metadata
           AND report.at = canonical.at
           AND report.source = canonical.source
           AND report.provider_event_id IS NOT DISTINCT FROM canonical.provider_event_id
           AND report.message_id IS NOT DISTINCT FROM canonical.message_id
           AND report.event_origin = canonical.event_origin
           AND report.controlled_seed_test_id IS NOT DISTINCT FROM
               canonical.controlled_seed_test_id
           AND report.seed_origin_method IS NOT DISTINCT FROM canonical.seed_origin_method
           AND report.event_origin_version = canonical.event_origin_version
           AND report.is_seed = canonical.is_seed
           AND NOT EXISTS (
                SELECT 1
                  FROM public.campaign_report_event_projections AS projection
                 WHERE projection.tenant_id = report.tenant_id
                   AND projection.campaign_report_event_id = report.id
                   AND projection.campaign_report_event_at = report.at
           )
         ORDER BY report.id
         LIMIT 2
    LOOP
        candidate_count := candidate_count + 1;
        IF candidate_count = 1 THEN
            selected_report_id := candidate.id;
            selected_report_at := candidate.at;
        END IF;
    END LOOP;
    IF candidate_count > 1 THEN
        RAISE EXCEPTION 'multiple exact legacy campaign report rows match canonical event'
            USING ERRCODE = '21000';
    END IF;

    IF candidate_count = 1 THEN
        selected_method := 'adopted_legacy';
    ELSE
        INSERT INTO public.campaign_report_events (
            tenant_id, campaign_id, subscriber_email, event_type, link_url,
            user_agent, ip, country, region, city, device, client,
            revenue_cents, metadata, at, source, provider_event_id, message_id,
            event_origin, controlled_seed_test_id, seed_origin_method,
            event_origin_version, is_seed
        ) VALUES (
            canonical.tenant_id, canonical.campaign_id,
            canonical.subscriber_email, canonical.event_type,
            canonical.link_url, canonical.user_agent, canonical.ip,
            canonical.country, NULL, NULL, NULL, NULL, 0,
            canonical.metadata, canonical.at, canonical.source,
            canonical.provider_event_id, canonical.message_id,
            canonical.event_origin, canonical.controlled_seed_test_id,
            canonical.seed_origin_method, canonical.event_origin_version,
            canonical.is_seed
        ) RETURNING id, at INTO selected_report_id, selected_report_at;
        selected_method := 'inserted_projection';
    END IF;

    -- Re-read after triggers and prove the materialization before recording its
    -- immutable identity. A registry-origin disagreement fails closed.
    SELECT report.*
      INTO actual_report
      FROM public.campaign_report_events AS report
     WHERE report.tenant_id = p_tenant_id
       AND report.id = selected_report_id
       AND report.at = selected_report_at;
    actual_report_fingerprint := encode(digest(convert_to(jsonb_build_object(
        'schema', 'postwave.campaign-report-event.v1',
        'tenant_id', actual_report.tenant_id,
        'campaign_id', actual_report.campaign_id,
        'subscriber_email', actual_report.subscriber_email::text,
        'event_type', actual_report.event_type,
        'link_url', actual_report.link_url,
        'user_agent', actual_report.user_agent,
        'ip', actual_report.ip::text,
        'country', actual_report.country,
        'region', actual_report.region,
        'city', actual_report.city,
        'device', actual_report.device,
        'client', actual_report.client,
        'revenue_cents', actual_report.revenue_cents,
        'metadata', actual_report.metadata,
        'at', actual_report.at,
        'source', actual_report.source,
        'provider_event_id', actual_report.provider_event_id,
        'message_id', actual_report.message_id,
        'event_origin', actual_report.event_origin,
        'controlled_seed_test_id', actual_report.controlled_seed_test_id,
        'seed_origin_method', actual_report.seed_origin_method,
        'event_origin_version', actual_report.event_origin_version,
        'is_seed', actual_report.is_seed
    )::text, 'UTF8'), 'sha256'), 'hex');
    IF actual_report_fingerprint IS DISTINCT FROM expected_report_fingerprint THEN
        RAISE EXCEPTION 'campaign report materialization does not match canonical event'
            USING ERRCODE = '23514';
    END IF;

    INSERT INTO public.subscriber_event_engagement_identities (
        tenant_id, subscriber_event_id, subscriber_event_at
    ) VALUES (
        p_tenant_id, p_subscriber_event_id, p_subscriber_event_at
    ) ON CONFLICT (
        tenant_id, subscriber_event_id, subscriber_event_at
    ) DO NOTHING;

    INSERT INTO public.campaign_report_event_projection_identities (
        tenant_id, campaign_report_event_id, campaign_report_event_at
    ) VALUES (
        p_tenant_id, selected_report_id, selected_report_at
    ) ON CONFLICT ON CONSTRAINT
        campaign_report_event_projection_identities_pkey DO NOTHING;

    INSERT INTO public.campaign_report_event_projections (
        tenant_id, subscriber_event_id, subscriber_event_at,
        campaign_report_event_id, campaign_report_event_at,
        projection_version, materialization_method,
        source_event_fingerprint, report_event_fingerprint,
        projection_fingerprint, reconciliation_run_id
    ) VALUES (
        p_tenant_id, p_subscriber_event_id, p_subscriber_event_at,
        selected_report_id, selected_report_at, p_projection_version,
        selected_method, source_fingerprint, actual_report_fingerprint,
        expected_projection_fingerprint, p_reconciliation_run_id
    );

    RETURN QUERY SELECT selected_report_id, selected_report_at,
        selected_method, true;
END;
$fn$;

REVOKE ALL ON FUNCTION append_campaign_report_event_projection(
    uuid, bigint, timestamptz, text, uuid, uuid, integer
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION append_campaign_report_event_projection(
    uuid, bigint, timestamptz, text, uuid, uuid, integer
) TO postwave_app;

-- Immutable evidence is readable only inside a tenant-bound projection worker
-- transaction. The generic worker flag alone and the purpose flag alone each
-- expose zero rows. Direct evidence writes remain revoked; only the projector
-- function owns them.
REVOKE ALL ON campaign_report_event_projection_identities,
    campaign_report_event_projections,
    campaign_report_projection_runs FROM PUBLIC, postwave_app;
GRANT SELECT ON campaign_report_event_projection_identities,
    campaign_report_event_projections TO postwave_app;
GRANT SELECT, INSERT, UPDATE ON campaign_report_projection_runs TO postwave_app;

ALTER TABLE campaign_report_event_projection_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_report_event_projection_identities FORCE ROW LEVEL SECURITY;
ALTER TABLE campaign_report_event_projections ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_report_event_projections FORCE ROW LEVEL SECURITY;
ALTER TABLE campaign_report_projection_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_report_projection_runs FORCE ROW LEVEL SECURITY;

CREATE POLICY campaign_report_projection_identities_worker_select
    ON campaign_report_event_projection_identities
    AS PERMISSIVE FOR SELECT TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.campaign_report_projection_worker', true) = 'true'
    );

CREATE POLICY campaign_report_event_projections_worker_select
    ON campaign_report_event_projections
    AS PERMISSIVE FOR SELECT TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.campaign_report_projection_worker', true) = 'true'
    );

CREATE POLICY campaign_report_projection_runs_worker_select
    ON campaign_report_projection_runs
    AS PERMISSIVE FOR SELECT TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.campaign_report_projection_worker', true) = 'true'
    );
CREATE POLICY campaign_report_projection_runs_worker_insert
    ON campaign_report_projection_runs
    AS PERMISSIVE FOR INSERT TO postwave_app
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.campaign_report_projection_worker', true) = 'true'
    );
CREATE POLICY campaign_report_projection_runs_worker_update
    ON campaign_report_projection_runs
    AS PERMISSIVE FOR UPDATE TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.campaign_report_projection_worker', true) = 'true'
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.campaign_report_projection_worker', true) = 'true'
    );

COMMENT ON TABLE campaign_report_event_projections IS
    'Immutable one-to-one lineage proving campaign_report_events rows are canonical subscriber_events projections.';
COMMENT ON COLUMN campaign_report_projection_runs.fence_event_id IS
    'Maximum eligible subscriber_events.id captured when the run is created; excludes late/backdated inserts.';
COMMENT ON FUNCTION append_campaign_report_event_projection(
    uuid, bigint, timestamptz, text, uuid, uuid, integer
) IS
    'Tenant-worker-only exact projector: adopts one exact legacy row or appends one compatibility row, then records immutable canonical lineage.';

COMMIT;
