-- 2067_commercial_usage_allowances.sql
-- Shared monthly hard-stop authority for AI credits, automation runs,
-- tracked events, and authenticated API operations.

BEGIN;

CREATE TABLE commercial_usage_buckets (
    tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    period_start   date NOT NULL,
    resource       text NOT NULL,
    limit_units    bigint NOT NULL CHECK (limit_units >= 0),
    used_units     bigint NOT NULL DEFAULT 0 CHECK (used_units >= 0),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, period_start, resource),
    CONSTRAINT commercial_usage_period_month_check
        CHECK (period_start = date_trunc('month', period_start)::date),
    CONSTRAINT commercial_usage_resource_check CHECK (
        resource IN ('ai_credit_millis', 'automation_runs', 'tracked_events', 'api_operations')
    ),
    CONSTRAINT commercial_usage_within_limit_check CHECK (used_units <= limit_units)
);

CREATE TABLE commercial_usage_reservations (
    tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    period_start     date NOT NULL,
    resource         text NOT NULL,
    idempotency_hash bytea NOT NULL CHECK (octet_length(idempotency_hash) = 32),
    units             bigint NOT NULL CHECK (units > 0),
    source            text NOT NULL DEFAULT '' CHECK (length(source) <= 128),
    created_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, period_start, resource, idempotency_hash),
    CONSTRAINT commercial_usage_reservation_bucket_fk
        FOREIGN KEY (tenant_id, period_start, resource)
        REFERENCES commercial_usage_buckets (tenant_id, period_start, resource)
        ON DELETE RESTRICT
);

CREATE INDEX commercial_usage_reservations_created_idx
    ON commercial_usage_reservations (created_at);

GRANT SELECT, INSERT, UPDATE ON commercial_usage_buckets TO postwave_app;
GRANT SELECT, INSERT ON commercial_usage_reservations TO postwave_app;

ALTER TABLE commercial_usage_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_usage_buckets FORCE ROW LEVEL SECURITY;
ALTER TABLE commercial_usage_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_usage_reservations FORCE ROW LEVEL SECURITY;

CREATE POLICY commercial_usage_buckets_tenant_isolation
    ON commercial_usage_buckets AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY commercial_usage_reservations_tenant_isolation
    ON commercial_usage_reservations AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Keep the admission decision atomic while avoiding five synchronous network
-- round trips on every metered operation. This is deliberately SECURITY
-- INVOKER: the caller's forced RLS policies remain authoritative.
CREATE FUNCTION commercial_usage_reserve(
    p_tenant_id uuid,
    p_period_start date,
    p_resource text,
    p_limit_units bigint,
    p_units bigint,
    p_idempotency_hash bytea,
    p_source text
)
RETURNS TABLE (outcome text, used_units bigint)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
    v_used bigint;
    v_prior_units bigint;
BEGIN
    INSERT INTO public.commercial_usage_buckets
           (tenant_id, period_start, resource, limit_units, used_units, updated_at)
    VALUES (p_tenant_id, p_period_start, p_resource, p_limit_units, 0, now())
    ON CONFLICT (tenant_id, period_start, resource) DO UPDATE
       -- A mid-period downgrade can put existing usage above the new plan
       -- ceiling. Preserve the table invariant while the admission decision
       -- below still uses p_limit_units and returns "exceeded" cleanly.
       SET limit_units = GREATEST(public.commercial_usage_buckets.used_units,
                                  EXCLUDED.limit_units),
           updated_at = now();

    SELECT b.used_units
      INTO v_used
      FROM public.commercial_usage_buckets b
     WHERE b.tenant_id = p_tenant_id
       AND b.period_start = p_period_start
       AND b.resource = p_resource
     FOR UPDATE;

    IF p_idempotency_hash IS NOT NULL THEN
        SELECT r.units
          INTO v_prior_units
          FROM public.commercial_usage_reservations r
         WHERE r.tenant_id = p_tenant_id
           AND r.period_start = p_period_start
           AND r.resource = p_resource
           AND r.idempotency_hash = p_idempotency_hash;

        IF FOUND THEN
            IF v_prior_units = p_units THEN
                RETURN QUERY SELECT 'replay'::text, v_used;
            ELSE
                RETURN QUERY SELECT 'conflict'::text, v_used;
            END IF;
            RETURN;
        END IF;
    END IF;

    IF p_units > p_limit_units - v_used THEN
        RETURN QUERY SELECT 'exceeded'::text, v_used;
        RETURN;
    END IF;

    IF p_idempotency_hash IS NOT NULL THEN
        INSERT INTO public.commercial_usage_reservations
               (tenant_id, period_start, resource, idempotency_hash, units, source)
        VALUES (p_tenant_id, p_period_start, p_resource,
                p_idempotency_hash, p_units, COALESCE(p_source, ''));
    END IF;

    UPDATE public.commercial_usage_buckets b
       SET used_units = b.used_units + p_units,
           updated_at = now()
     WHERE b.tenant_id = p_tenant_id
       AND b.period_start = p_period_start
       AND b.resource = p_resource
    RETURNING b.used_units INTO v_used;

    RETURN QUERY SELECT 'reserved'::text, v_used;
END;
$$;

REVOKE ALL ON FUNCTION public.commercial_usage_reserve(uuid, date, text, bigint, bigint, bytea, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.commercial_usage_reserve(uuid, date, text, bigint, bigint, bytea, text) TO postwave_app;

COMMIT;
