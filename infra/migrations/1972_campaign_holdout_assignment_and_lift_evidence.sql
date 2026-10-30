-- Frozen campaign holdout assignments and finalized lift evidence (PRD F02).
--
-- Migration 0144 stored only two aggregate counts.  That is not enough to
-- measure a control arm: held-out recipients have no campaign send/event rows,
-- so an on-demand query cannot reconstruct who was actually suppressed.  This
-- migration makes the assignment itself durable, freezes the exact set in the
-- queue transaction, and records each closed-window result as immutable
-- evidence.  Historical decided holdouts remain readable but deliberately
-- have assignment_ledger_version = NULL and cannot be represented as audited
-- lift experiments.
--
-- rollback-strategy: no-op
-- The ledgers are append-only evidence.  Rolling application code back simply
-- stops writing the additive objects; dropping them would destroy experiment
-- provenance and is therefore not an acceptable automatic rollback.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE campaign_holdouts
    ADD COLUMN IF NOT EXISTS outcome_metric text NOT NULL DEFAULT 'any_conversion',
    ADD COLUMN IF NOT EXISTS conversion_window_days smallint NOT NULL DEFAULT 7,
    ADD COLUMN IF NOT EXISTS minimum_relative_effect double precision NOT NULL DEFAULT 0.10,
    ADD COLUMN IF NOT EXISTS assignment_ledger_version text,
    ADD COLUMN IF NOT EXISTS assignment_ledger_sha256 text;

ALTER TABLE campaign_holdouts
    DROP CONSTRAINT IF EXISTS campaign_holdouts_outcome_metric_check,
    ADD CONSTRAINT campaign_holdouts_outcome_metric_check
        CHECK (outcome_metric ~ '^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$'),
    DROP CONSTRAINT IF EXISTS campaign_holdouts_conversion_window_days_check,
    ADD CONSTRAINT campaign_holdouts_conversion_window_days_check
        CHECK (conversion_window_days BETWEEN 1 AND 30),
    DROP CONSTRAINT IF EXISTS campaign_holdouts_minimum_relative_effect_check,
    ADD CONSTRAINT campaign_holdouts_minimum_relative_effect_check
        CHECK (minimum_relative_effect > 0 AND minimum_relative_effect <= 1),
    DROP CONSTRAINT IF EXISTS campaign_holdouts_assignment_ledger_shape_check,
    ADD CONSTRAINT campaign_holdouts_assignment_ledger_shape_check CHECK (
        (assignment_ledger_version IS NULL AND assignment_ledger_sha256 IS NULL)
        OR
        (assignment_ledger_version = 'postwave.holdout-assignment.v2'
         AND assignment_ledger_sha256 ~ '^[0-9a-f]{64}$')
    );

CREATE UNIQUE INDEX IF NOT EXISTS campaign_holdouts_tenant_campaign_uniq
    ON campaign_holdouts (tenant_id, campaign_id);

CREATE TABLE IF NOT EXISTS campaign_holdout_assignments (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id              uuid NOT NULL,
    -- The subscriber UUID is retained as a pseudonymous experiment identity.
    -- No email address or reversible email digest enters this ledger.  There
    -- is intentionally no subscriber FK: erasing the subscriber removes the
    -- only row that maps this random UUID back to contact data while preserving
    -- aggregate experimental evidence.
    recipient_id             uuid NOT NULL,
    arm                      text NOT NULL CHECK (arm IN ('treatment', 'control')),
    bucket                   smallint NOT NULL CHECK (bucket BETWEEN 0 AND 99),
    assignment_reason        text NOT NULL
                                 CHECK (assignment_reason IN ('deterministic', 'rotation_cap')),
    holdout_percent          numeric(5,2) NOT NULL
                                 CHECK (holdout_percent > 0 AND holdout_percent <= 50),
    seed_sha256              text NOT NULL CHECK (seed_sha256 ~ '^[0-9a-f]{64}$'),
    exposure_window_start    timestamptz NOT NULL,
    prior_assignments_90d    integer NOT NULL CHECK (prior_assignments_90d >= 0),
    prior_control_90d        integer NOT NULL CHECK (
                                 prior_control_90d >= 0
                                 AND prior_control_90d <= prior_assignments_90d
                             ),
    assignment_version       text NOT NULL
                                 CHECK (assignment_version = 'postwave.holdout-assignment.v2'),
    assigned_at              timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT campaign_holdout_assignments_tenant_campaign_fkey
        FOREIGN KEY (tenant_id, campaign_id)
        REFERENCES campaign_holdouts (tenant_id, campaign_id)
        ON DELETE CASCADE,
    CONSTRAINT campaign_holdout_assignments_arm_shape_check CHECK (
        (arm = 'control'
         AND assignment_reason = 'deterministic'
         AND bucket < round(holdout_percent)::integer)
        OR
        (arm = 'treatment'
         AND assignment_reason = 'deterministic'
         AND bucket >= round(holdout_percent)::integer)
        OR
        (arm = 'treatment'
         AND assignment_reason = 'rotation_cap'
         AND bucket < round(holdout_percent)::integer)
    ),
    UNIQUE (tenant_id, campaign_id, recipient_id),
    UNIQUE (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS campaign_holdout_assignments_recipient_exposure_idx
    ON campaign_holdout_assignments
       (tenant_id, recipient_id, assigned_at DESC, arm);

CREATE INDEX IF NOT EXISTS campaign_holdout_assignments_campaign_arm_idx
    ON campaign_holdout_assignments (tenant_id, campaign_id, arm, recipient_id);

CREATE OR REPLACE FUNCTION campaign_holdout_assignment_set_sha256(
    p_tenant_id uuid,
    p_campaign_id uuid
) RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $fn$
    SELECT encode(
        digest(
            COALESCE(
                string_agg(
                    concat_ws('|',
                        recipient_id::text,
                        arm,
                        bucket::text,
                        assignment_reason,
                        holdout_percent::text,
                        seed_sha256,
                        to_char(exposure_window_start AT TIME ZONE 'UTC',
                                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                        prior_assignments_90d::text,
                        prior_control_90d::text,
                        assignment_version
                    ),
                    E'\n' ORDER BY recipient_id
                ),
                ''
            ),
            'sha256'
        ),
        'hex'
    )
      FROM public.campaign_holdout_assignments
     WHERE tenant_id = p_tenant_id
       AND campaign_id = p_campaign_id
$fn$;

REVOKE ALL ON FUNCTION campaign_holdout_assignment_set_sha256(uuid, uuid)
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION campaign_holdout_assignment_set_sha256(uuid, uuid)
    TO postwave_app;

CREATE OR REPLACE FUNCTION campaign_holdout_assignment_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    holdout campaign_holdouts%ROWTYPE;
    actual_prior_assignments integer;
    actual_prior_control integer;
    projected_control_rate numeric;
BEGIN
    -- Serialize exposure decisions per tenant/recipient. Two campaigns queued
    -- concurrently must not both observe the same old 90-day history and then
    -- independently place the recipient into control above the rotation cap.
    PERFORM pg_advisory_xact_lock(
        hashtextextended(NEW.tenant_id::text || ':' || NEW.recipient_id::text, 0)
    );
    SELECT * INTO holdout
      FROM public.campaign_holdouts
     WHERE tenant_id = NEW.tenant_id
       AND campaign_id = NEW.campaign_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'campaign holdout does not exist for assignment'
            USING ERRCODE = '23503';
    END IF;
    IF holdout.decided_at IS NOT NULL THEN
        RAISE EXCEPTION 'campaign holdout assignment set is already frozen'
            USING ERRCODE = '55000';
    END IF;
    IF NEW.holdout_percent IS DISTINCT FROM holdout.percent THEN
        RAISE EXCEPTION 'campaign holdout assignment percentage differs from configuration'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.seed_sha256 IS DISTINCT FROM
       encode(digest(holdout.seed, 'sha256'), 'hex') THEN
        RAISE EXCEPTION 'campaign holdout assignment seed differs from configuration'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.exposure_window_start IS DISTINCT FROM
       NEW.assigned_at - interval '90 days' THEN
        RAISE EXCEPTION 'campaign holdout exposure window is not the frozen 90-day window'
            USING ERRCODE = '23514';
    END IF;

    SELECT count(*)::integer,
           count(*) FILTER (WHERE arm = 'control')::integer
      INTO actual_prior_assignments, actual_prior_control
      FROM public.campaign_holdout_assignments
     WHERE tenant_id = NEW.tenant_id
       AND recipient_id = NEW.recipient_id
       AND campaign_id <> NEW.campaign_id
       AND assigned_at >= NEW.exposure_window_start
       AND assigned_at <= NEW.assigned_at;
    IF NEW.prior_assignments_90d IS DISTINCT FROM actual_prior_assignments
       OR NEW.prior_control_90d IS DISTINCT FROM actual_prior_control THEN
        RAISE EXCEPTION 'campaign holdout assignment was planned from stale exposure history'
            USING ERRCODE = '40001';
    END IF;

    IF NEW.bucket < round(NEW.holdout_percent)::integer THEN
        projected_control_rate :=
            (actual_prior_control + 1)::numeric /
            (actual_prior_assignments + 1)::numeric;
        IF NEW.arm = 'control'
           AND actual_prior_assignments > 0
           AND projected_control_rate > 0.15 THEN
            RAISE EXCEPTION 'campaign holdout assignment exceeds the 90-day control exposure cap'
                USING ERRCODE = '23514';
        END IF;
        IF NEW.assignment_reason = 'rotation_cap'
           AND (actual_prior_assignments = 0
                OR projected_control_rate <= 0.15) THEN
            RAISE EXCEPTION 'campaign holdout rotation-cap override is unsupported by exposure history'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END
$fn$;

CREATE TRIGGER campaign_holdout_assignment_insert_guard
    BEFORE INSERT ON campaign_holdout_assignments
    FOR EACH ROW EXECUTE FUNCTION campaign_holdout_assignment_insert_guard();

CREATE OR REPLACE FUNCTION campaign_holdout_configuration_freeze_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    assignment_count integer;
    control_count integer;
    ledger_hash text;
BEGIN
    IF TG_OP = 'DELETE' THEN
        -- Campaign/tenant erasure owns the child evidence lifecycle.  During a
        -- cascaded delete the parent campaign or tenant is already invisible;
        -- a direct deletion still sees both parents and remains forbidden once
        -- the decision has frozen.
        IF NOT EXISTS (
               SELECT 1 FROM public.tenants
                WHERE id = OLD.tenant_id
           ) OR NOT EXISTS (
               SELECT 1 FROM public.campaigns
                WHERE tenant_id = OLD.tenant_id
                  AND id = OLD.campaign_id
           ) THEN
            RETURN OLD;
        END IF;
        IF OLD.decided_at IS NOT NULL THEN
            RAISE EXCEPTION 'a decided campaign holdout is immutable evidence'
                USING ERRCODE = '55000';
        END IF;
        RETURN OLD;
    END IF;

    IF OLD.decided_at IS NOT NULL AND ROW(
        NEW.tenant_id,
        NEW.campaign_id,
        NEW.percent,
        NEW.seed,
        NEW.decided_at,
        NEW.held_out_count,
        NEW.sent_count,
        NEW.outcome_metric,
        NEW.conversion_window_days,
        NEW.minimum_relative_effect,
        NEW.assignment_ledger_version,
        NEW.assignment_ledger_sha256
    ) IS DISTINCT FROM ROW(
        OLD.tenant_id,
        OLD.campaign_id,
        OLD.percent,
        OLD.seed,
        OLD.decided_at,
        OLD.held_out_count,
        OLD.sent_count,
        OLD.outcome_metric,
        OLD.conversion_window_days,
        OLD.minimum_relative_effect,
        OLD.assignment_ledger_version,
        OLD.assignment_ledger_sha256
    ) THEN
        RAISE EXCEPTION 'a decided campaign holdout is immutable evidence'
            USING ERRCODE = '55000';
    END IF;

    IF OLD.decided_at IS NULL AND NEW.decided_at IS NOT NULL THEN
        IF current_setting('app.holdout_assignment_writer', true) <> 'true' THEN
            RAISE EXCEPTION 'campaign holdout decision requires assignment-writer scope'
                USING ERRCODE = '42501';
        END IF;
        IF NEW.assignment_ledger_version IS DISTINCT FROM
           'postwave.holdout-assignment.v2' THEN
            RAISE EXCEPTION 'campaign holdout decision requires the v2 assignment ledger'
                USING ERRCODE = '23514';
        END IF;

        SELECT count(*)::integer,
               count(*) FILTER (WHERE arm = 'control')::integer
          INTO assignment_count, control_count
          FROM public.campaign_holdout_assignments
         WHERE tenant_id = NEW.tenant_id
           AND campaign_id = NEW.campaign_id;
        IF assignment_count <> NEW.held_out_count + NEW.sent_count
           OR control_count <> NEW.held_out_count THEN
            RAISE EXCEPTION 'campaign holdout counts do not match frozen assignments'
                USING ERRCODE = '23514';
        END IF;
        ledger_hash := public.campaign_holdout_assignment_set_sha256(
            NEW.tenant_id, NEW.campaign_id
        );
        IF NEW.assignment_ledger_sha256 IS DISTINCT FROM ledger_hash THEN
            RAISE EXCEPTION 'campaign holdout assignment digest does not match frozen set'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END
$fn$;

CREATE TRIGGER campaign_holdout_configuration_freeze_guard
    BEFORE UPDATE OR DELETE ON campaign_holdouts
    FOR EACH ROW EXECUTE FUNCTION campaign_holdout_configuration_freeze_guard();

CREATE TABLE IF NOT EXISTS campaign_holdout_lift_results (
    id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id                uuid NOT NULL,
    result_version             text NOT NULL
                                   CHECK (result_version = 'postwave.holdout-lift-result.v1'),
    methodology_version        text NOT NULL
                                   CHECK (methodology_version = 'postwave.holdout-lift-methodology.v1'),
    metric                     text NOT NULL
                                   CHECK (metric ~ '^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$'),
    window_start               timestamptz NOT NULL,
    window_end                 timestamptz NOT NULL CHECK (window_end > window_start),
    n_treatment                bigint NOT NULL CHECK (n_treatment >= 0),
    n_control                  bigint NOT NULL CHECK (n_control >= 0),
    conversions_treatment      bigint NOT NULL
                                   CHECK (conversions_treatment BETWEEN 0 AND n_treatment),
    conversions_control        bigint NOT NULL
                                   CHECK (conversions_control BETWEEN 0 AND n_control),
    rate_treatment             double precision NOT NULL
                                   CHECK (rate_treatment BETWEEN 0 AND 1),
    rate_control               double precision NOT NULL
                                   CHECK (rate_control BETWEEN 0 AND 1),
    status                     text NOT NULL CHECK (status IN ('powered', 'underpowered')),
    absolute_lift              double precision,
    relative_lift              double precision,
    incremental_conversions    double precision,
    p_value                    double precision NOT NULL CHECK (p_value BETWEEN 0 AND 1),
    ci_low                     double precision,
    ci_high                    double precision,
    minimum_detectable_effect  double precision NOT NULL
                                   CHECK (minimum_detectable_effect >= 0),
    minimum_relative_effect    double precision NOT NULL
                                   CHECK (minimum_relative_effect > 0 AND minimum_relative_effect <= 1),
    underpowered_reason        text,
    assignment_set_sha256      text NOT NULL CHECK (assignment_set_sha256 ~ '^[0-9a-f]{64}$'),
    conversion_set_sha256      text NOT NULL CHECK (conversion_set_sha256 ~ '^[0-9a-f]{64}$'),
    evidence_sha256            text NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
    methodology_statement      text NOT NULL CHECK (length(methodology_statement) BETWEEN 1 AND 4000),
    generated_at               timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT campaign_holdout_lift_results_tenant_campaign_fkey
        FOREIGN KEY (tenant_id, campaign_id)
        REFERENCES campaign_holdouts (tenant_id, campaign_id)
        ON DELETE CASCADE,
    CONSTRAINT campaign_holdout_lift_results_status_shape_check CHECK (
        (status = 'powered'
         AND absolute_lift IS NOT NULL
         AND incremental_conversions IS NOT NULL
         AND ci_low IS NOT NULL
         AND ci_high IS NOT NULL
         AND ci_low <= absolute_lift
         AND absolute_lift <= ci_high
         AND underpowered_reason IS NULL)
        OR
        (status = 'underpowered'
         AND absolute_lift IS NULL
         AND relative_lift IS NULL
         AND incremental_conversions IS NULL
         AND ci_low IS NULL
         AND ci_high IS NULL
         AND underpowered_reason IS NOT NULL
         AND length(underpowered_reason) BETWEEN 1 AND 1000)
    ),
    UNIQUE (
        tenant_id,
        campaign_id,
        metric,
        window_start,
        window_end,
        methodology_version
    ),
    UNIQUE (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS campaign_holdout_lift_results_lookup_idx
    ON campaign_holdout_lift_results
       (tenant_id, campaign_id, generated_at DESC);

CREATE OR REPLACE FUNCTION campaign_holdout_lift_result_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    holdout campaign_holdouts%ROWTYPE;
BEGIN
    SELECT * INTO holdout
      FROM public.campaign_holdouts
     WHERE tenant_id = NEW.tenant_id
       AND campaign_id = NEW.campaign_id;
    IF NOT FOUND
       OR holdout.decided_at IS NULL
       OR holdout.assignment_ledger_version IS DISTINCT FROM
            'postwave.holdout-assignment.v2' THEN
        RAISE EXCEPTION 'lift result requires a frozen v2 holdout assignment set'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.metric IS DISTINCT FROM holdout.outcome_metric
       OR NEW.window_start IS DISTINCT FROM holdout.decided_at
       OR NEW.window_end IS DISTINCT FROM
            holdout.decided_at + make_interval(days => holdout.conversion_window_days)
       OR NEW.minimum_relative_effect IS DISTINCT FROM holdout.minimum_relative_effect
       OR NEW.assignment_set_sha256 IS DISTINCT FROM holdout.assignment_ledger_sha256 THEN
        RAISE EXCEPTION 'lift result does not match its frozen holdout contract'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.window_end > clock_timestamp() THEN
        RAISE EXCEPTION 'lift result window is not closed'
            USING ERRCODE = '22007';
    END IF;
    RETURN NEW;
END
$fn$;

CREATE TRIGGER campaign_holdout_lift_result_insert_guard
    BEFORE INSERT ON campaign_holdout_lift_results
    FOR EACH ROW EXECUTE FUNCTION campaign_holdout_lift_result_insert_guard();

CREATE OR REPLACE FUNCTION campaign_holdout_evidence_append_only_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF TG_TABLE_NAME = 'campaign_holdout_assignments' THEN
            IF NOT EXISTS (
                SELECT 1 FROM public.campaign_holdouts
                 WHERE tenant_id = OLD.tenant_id
                   AND campaign_id = OLD.campaign_id
            ) THEN
                RETURN OLD;
            END IF;
        ELSIF TG_TABLE_NAME = 'campaign_holdout_lift_results' THEN
            IF NOT EXISTS (
                SELECT 1 FROM public.campaign_holdouts
                 WHERE tenant_id = OLD.tenant_id
                   AND campaign_id = OLD.campaign_id
            ) THEN
                RETURN OLD;
            END IF;
        END IF;
    END IF;
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
        USING ERRCODE = '55000';
END
$fn$;

CREATE TRIGGER campaign_holdout_assignments_append_only
    BEFORE UPDATE OR DELETE ON campaign_holdout_assignments
    FOR EACH ROW EXECUTE FUNCTION campaign_holdout_evidence_append_only_guard();
CREATE TRIGGER campaign_holdout_assignments_no_truncate
    BEFORE TRUNCATE ON campaign_holdout_assignments
    FOR EACH STATEMENT EXECUTE FUNCTION campaign_holdout_evidence_append_only_guard();
CREATE TRIGGER campaign_holdout_lift_results_append_only
    BEFORE UPDATE OR DELETE ON campaign_holdout_lift_results
    FOR EACH ROW EXECUTE FUNCTION campaign_holdout_evidence_append_only_guard();
CREATE TRIGGER campaign_holdout_lift_results_no_truncate
    BEFORE TRUNCATE ON campaign_holdout_lift_results
    FOR EACH STATEMENT EXECUTE FUNCTION campaign_holdout_evidence_append_only_guard();

ALTER TABLE campaign_holdout_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_holdout_assignments FORCE ROW LEVEL SECURITY;
ALTER TABLE campaign_holdout_lift_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_holdout_lift_results FORCE ROW LEVEL SECURITY;

CREATE POLICY campaign_holdout_assignments_tenant_select
    ON campaign_holdout_assignments
    FOR SELECT TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY campaign_holdout_assignments_scoped_insert
    ON campaign_holdout_assignments
    FOR INSERT TO postwave_app
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND current_setting('app.holdout_assignment_writer', true) = 'true'
    );

CREATE POLICY campaign_holdout_lift_results_tenant_select
    ON campaign_holdout_lift_results
    FOR SELECT TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY campaign_holdout_lift_results_scoped_insert
    ON campaign_holdout_lift_results
    FOR INSERT TO postwave_app
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND current_setting('app.holdout_result_writer', true) = 'true'
    );

REVOKE ALL ON campaign_holdout_assignments,
    campaign_holdout_lift_results FROM PUBLIC, postwave_app;
GRANT SELECT, INSERT ON campaign_holdout_assignments,
    campaign_holdout_lift_results TO postwave_app;

COMMENT ON TABLE campaign_holdout_assignments IS
    'Immutable per-recipient intent-to-treat/control assignment evidence; stores no email address or reversible email digest.';
COMMENT ON TABLE campaign_holdout_lift_results IS
    'Immutable closed-window F02 lift result; underpowered rows deliberately contain no lift estimate.';

COMMIT;
