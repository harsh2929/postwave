-- 1849_deliverability_degradation_claims.sql
--
-- Durable, replica-safe Deliverability Hub sampling and degradation delivery:
--   * one effective snapshot per tenant/model/worker cadence;
--   * one qualified >=60 -> <60 transition per healthy source snapshot;
--   * customer-webhook intent committed with the transition;
--   * leased, retryable operator delivery with an immutable incident identity;
--   * complete worker discovery for the 30-day score model and repair state.
--
-- rollback-strategy: no-op - retain immutable transition evidence, delivery
-- state, cadence ownership, and the bounded discovery function on rollback.
-- rollback-details: older code ignores the additive columns/table/function;
-- removing them can duplicate notifications, erase claims, and restore worker
-- blind spots. Restore only from the preflight backup after an incident review.

BEGIN;

ALTER TABLE public.deliverability_hub_snapshots
    ADD COLUMN IF NOT EXISTS observation_bucket_at timestamptz;

-- Snapshot and repair rows are security/audit evidence. Application code may
-- append/select snapshots and clear an override through its two explicit
-- fields, but may not erase evidence or rewrite the cap decision.
REVOKE DELETE ON public.deliverability_hub_snapshots FROM postwave_app;
REVOKE INSERT, UPDATE, DELETE ON public.deliverability_repair_overrides
    FROM postwave_app;
GRANT INSERT ON public.deliverability_repair_overrides TO postwave_app;
GRANT UPDATE (cleared_at, cleared_by)
    ON public.deliverability_repair_overrides TO postwave_app;

COMMIT;

-- Worker discovery filters globally by time before grouping by tenant. The
-- per-tenant cohort index from 1847 serves score calculation; this reversed
-- key order serves the fleet inventory without a full historical scan.
CREATE INDEX CONCURRENTLY IF NOT EXISTS
    campaign_recipients_deliverability_inventory_idx
    ON public.campaign_recipients (sent_at DESC, tenant_id)
    WHERE status = 'sent' AND sent_at IS NOT NULL;

-- These redundant-looking unique keys let claim foreign keys prove tenant,
-- model, score and sample qualification against the referenced snapshots.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
    deliverability_hub_snapshots_claim_evidence_uidx
    ON public.deliverability_hub_snapshots
       (tenant_id, model_version, id, score, sample_qualified);

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
    deliverability_hub_snapshots_cadence_uidx
    ON public.deliverability_hub_snapshots
       (tenant_id, model_version, observation_bucket_at)
    WHERE observation_bucket_at IS NOT NULL;

BEGIN;

CREATE TABLE IF NOT EXISTS public.deliverability_degradation_claims (
    tenant_id                 uuid NOT NULL
        REFERENCES public.tenants(id) ON DELETE CASCADE,
    model_version             text NOT NULL CHECK (btrim(model_version) <> ''),
    from_snapshot_id          bigint NOT NULL,
    to_snapshot_id            bigint NOT NULL,
    previous_score            integer NOT NULL,
    current_score             integer NOT NULL,
    previous_sample_qualified boolean NOT NULL DEFAULT true
        CHECK (previous_sample_qualified),
    current_sample_qualified  boolean NOT NULL DEFAULT true
        CHECK (current_sample_qualified),
    current_grade             text NOT NULL CHECK (current_grade ~ '^[A-F]$'),
    top_breach_code           text NOT NULL DEFAULT '',
    top_breach_title          text NOT NULL DEFAULT '',
    breach_count              integer NOT NULL DEFAULT 0 CHECK (breach_count >= 0),
    claimed_at                timestamptz NOT NULL DEFAULT now(),
    webhook_enqueued_at       timestamptz NOT NULL,
    operator_notified_at      timestamptz,
    operator_attempt_count    integer NOT NULL DEFAULT 0
        CHECK (operator_attempt_count >= 0),
    operator_next_attempt_at  timestamptz DEFAULT now(),
    operator_lease_token      uuid,
    operator_lease_expires_at timestamptz,
    operator_last_error       text,
    PRIMARY KEY (tenant_id, model_version, from_snapshot_id),
    UNIQUE (tenant_id, to_snapshot_id),
    CONSTRAINT deliverability_degradation_claims_crossing_chk
        CHECK (previous_score >= 60 AND current_score < 60),
    CONSTRAINT deliverability_degradation_claims_distinct_snapshots_chk
        CHECK (from_snapshot_id <> to_snapshot_id),
    CONSTRAINT deliverability_degradation_claims_lease_pair_chk
        CHECK ((operator_lease_token IS NULL) =
               (operator_lease_expires_at IS NULL)),
    CONSTRAINT deliverability_degradation_claims_completion_chk
        CHECK (operator_notified_at IS NULL OR
               (operator_next_attempt_at IS NULL AND
                operator_lease_token IS NULL AND
                operator_lease_expires_at IS NULL)),
    CONSTRAINT deliverability_degradation_claims_from_snapshot_fk
        FOREIGN KEY (
            tenant_id, model_version, from_snapshot_id,
            previous_score, previous_sample_qualified
        ) REFERENCES public.deliverability_hub_snapshots
            (tenant_id, model_version, id, score, sample_qualified)
        ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT deliverability_degradation_claims_to_snapshot_fk
        FOREIGN KEY (
            tenant_id, model_version, to_snapshot_id,
            current_score, current_sample_qualified
        ) REFERENCES public.deliverability_hub_snapshots
            (tenant_id, model_version, id, score, sample_qualified)
        ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS deliverability_degradation_claims_operator_due_idx
    ON public.deliverability_degradation_claims
       (operator_next_attempt_at, claimed_at)
    WHERE operator_notified_at IS NULL;

REVOKE ALL ON public.deliverability_degradation_claims FROM postwave_app;
GRANT SELECT, INSERT ON public.deliverability_degradation_claims TO postwave_app;
GRANT UPDATE (
    operator_notified_at,
    operator_attempt_count,
    operator_next_attempt_at,
    operator_lease_token,
    operator_lease_expires_at,
    operator_last_error
) ON public.deliverability_degradation_claims TO postwave_app;

ALTER TABLE public.deliverability_degradation_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deliverability_degradation_claims FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deliverability_degradation_worker_all
    ON public.deliverability_degradation_claims;
CREATE POLICY deliverability_degradation_worker_all
    ON public.deliverability_degradation_claims
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

-- Worker inventory crosses tenant RLS without exposing subscriber/campaign
-- rows. The NOLOGIN/BYPASSRLS owner receives only the columns required to
-- return candidate tenant UUIDs.
DO $migration$
DECLARE
    definer pg_catalog.pg_roles%ROWTYPE;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles
         WHERE rolname = 'postwave_deliverability_discovery_definer'
    ) THEN
        CREATE ROLE postwave_deliverability_discovery_definer
            NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
            NOREPLICATION BYPASSRLS;
    END IF;

    SELECT * INTO definer FROM pg_catalog.pg_roles
     WHERE rolname = 'postwave_deliverability_discovery_definer';
    IF definer.rolcanlogin OR definer.rolsuper OR definer.rolcreatedb OR
       definer.rolcreaterole OR definer.rolinherit OR definer.rolreplication OR
       NOT definer.rolbypassrls THEN
        RAISE EXCEPTION
            'postwave_deliverability_discovery_definer has unsafe role attributes';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_auth_members
         WHERE member = definer.oid OR roleid = definer.oid
    ) THEN
        RAISE EXCEPTION
            'postwave_deliverability_discovery_definer must have no memberships';
    END IF;
    IF pg_catalog.has_schema_privilege(
        'postwave_deliverability_discovery_definer', 'public', 'CREATE'
    ) THEN
        RAISE EXCEPTION
            'postwave_deliverability_discovery_definer unexpectedly has CREATE on public';
    END IF;
    IF pg_catalog.to_regprocedure(
        'public.deliverability_hub_worker_tenants(timestamp with time zone,bigint)'
    ) IS NOT NULL THEN
        RAISE EXCEPTION
            'deliverability_hub_worker_tenants(timestamptz,bigint) exists out of band';
    END IF;
END;
$migration$;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
    FROM postwave_deliverability_discovery_definer;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public
    FROM postwave_deliverability_discovery_definer;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public
    FROM postwave_deliverability_discovery_definer;
REVOKE ALL PRIVILEGES ON SCHEMA public
    FROM postwave_deliverability_discovery_definer;

GRANT USAGE, CREATE ON SCHEMA public
    TO postwave_deliverability_discovery_definer;
GRANT SELECT (tenant_id, status, sent_at)
    ON public.campaign_recipients
    TO postwave_deliverability_discovery_definer;
GRANT SELECT (tenant_id, at)
    ON public.subscriber_events
    TO postwave_deliverability_discovery_definer;
GRANT SELECT (tenant_id)
    ON public.sending_identities
    TO postwave_deliverability_discovery_definer;
GRANT SELECT (tenant_id, checked_at)
    ON public.blocklist_observations
    TO postwave_deliverability_discovery_definer;
GRANT SELECT (tenant_id, low_since)
    ON public.deliverability_throttle_state
    TO postwave_deliverability_discovery_definer;
GRANT SELECT (tenant_id, cleared_at)
    ON public.deliverability_repair_overrides
    TO postwave_deliverability_discovery_definer;

CREATE FUNCTION public.deliverability_hub_worker_tenants(
    p_since timestamptz,
    p_minimum_campaign_sends bigint
)
RETURNS TABLE (tenant_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
    -- This is defense in depth within the repository's current same-role/GUC
    -- worker model. A separately credentialed worker DB role is still needed
    -- to make the marker unforgeable by arbitrary SQL running as postwave_app.
    IF current_setting('app.outbox_worker', true) IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'deliverability inventory requires worker scope'
            USING ERRCODE = '42501';
    END IF;
    IF p_since IS NULL OR
       p_since < pg_catalog.statement_timestamp() - INTERVAL '31 days' OR
       p_since > pg_catalog.statement_timestamp() + INTERVAL '5 minutes' THEN
        RAISE EXCEPTION 'p_since must bound the trailing 30-day model window'
            USING ERRCODE = '22023';
    END IF;
    IF p_minimum_campaign_sends IS NULL OR
       p_minimum_campaign_sends < 1000 THEN
        RAISE EXCEPTION 'p_minimum_campaign_sends must be at least 1000'
            USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    WITH qualified_campaign_tenants AS (
        SELECT recipient.tenant_id
          FROM public.campaign_recipients AS recipient
         WHERE recipient.status = 'sent'
           AND recipient.sent_at >= p_since
         GROUP BY recipient.tenant_id
        HAVING count(*) >= p_minimum_campaign_sends
    )
    SELECT candidate.tenant_id
      FROM (
            SELECT qualified.tenant_id
              FROM qualified_campaign_tenants AS qualified
            UNION
            SELECT DISTINCT event.tenant_id
              FROM public.subscriber_events AS event
             WHERE event.at >= p_since
            UNION
            SELECT DISTINCT identity.tenant_id
              FROM public.sending_identities AS identity
            UNION
            SELECT DISTINCT observation.tenant_id
              FROM public.blocklist_observations AS observation
             WHERE observation.checked_at >= p_since
            UNION
            SELECT state.tenant_id
              FROM public.deliverability_throttle_state AS state
             WHERE state.low_since IS NOT NULL
            UNION
            SELECT repair.tenant_id
              FROM public.deliverability_repair_overrides AS repair
             WHERE repair.cleared_at IS NULL
           ) AS candidate;
END;
$function$;

ALTER FUNCTION public.deliverability_hub_worker_tenants(timestamptz, bigint)
    OWNER TO postwave_deliverability_discovery_definer;
REVOKE CREATE ON SCHEMA public
    FROM postwave_deliverability_discovery_definer;
REVOKE ALL ON FUNCTION
    public.deliverability_hub_worker_tenants(timestamptz, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
    public.deliverability_hub_worker_tenants(timestamptz, bigint) TO postwave_app;

COMMENT ON FUNCTION public.deliverability_hub_worker_tenants(timestamptz, bigint)
IS 'Returns only worker-scoped Deliverability Hub candidate tenant UUIDs across the complete model and durable repair inventory.';

COMMIT;
