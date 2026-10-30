-- 1969_campaign_delivery_reply_correlation.sql
--
-- Bind the exact outbound Reply-To correlation identity to the same immutable
-- delivery receipt that already binds Message-ID and outbound MIME bytes.
-- Historical v1 rows remain readable with NULL correlation columns. A v2
-- transport receipt is impossible to insert unless every correlation field is
-- complete; partial identities are rejected for every contract version.
--
-- The address contains an opaque, signed token. Cross-tenant inbound routing
-- gets only a tenant UUID for an exact 256-bit token commitment through a
-- fixed SECURITY DEFINER function. Its NOLOGIN/NOBYPASSRLS owner can read only
-- the five delivery columns required for that decision.
--
-- rollback-strategy: no-op. Reply-correlation fields are delivery evidence and
-- can already be referenced by inbound replies after this migration lands.
-- migration-execution: phased

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

ALTER TABLE public.campaign_send_deliveries
    ADD COLUMN IF NOT EXISTS reply_to text,
    ADD COLUMN IF NOT EXISTS reply_correlation_version smallint,
    ADD COLUMN IF NOT EXISTS reply_correlation_key_id text,
    ADD COLUMN IF NOT EXISTS reply_correlation_expires_at timestamptz,
    ADD COLUMN IF NOT EXISTS reply_correlation_token_hash text;

ALTER TABLE public.campaign_send_deliveries
    DROP CONSTRAINT IF EXISTS campaign_send_deliveries_reply_correlation_shape_check;

ALTER TABLE public.campaign_send_deliveries
    ADD CONSTRAINT campaign_send_deliveries_reply_correlation_shape_check CHECK (
        (
            reply_to IS NULL
            AND reply_correlation_version IS NULL
            AND reply_correlation_key_id IS NULL
            AND reply_correlation_expires_at IS NULL
            AND reply_correlation_token_hash IS NULL
            AND transport_contract_version <> 'postwave.campaign-transport.v2'
        )
        OR
        (
            reply_to IS NOT NULL
            AND length(reply_to) BETWEEN 3 AND 254
            AND reply_to = lower(reply_to)
            AND position(E'\n' in reply_to) = 0
            AND position(E'\r' in reply_to) = 0
            AND reply_correlation_version = 1
            AND reply_correlation_key_id ~ '^[a-z0-9_-]{1,32}$'
            AND reply_correlation_expires_at > created_at
            AND reply_correlation_token_hash ~ '^[0-9a-f]{64}$'
            AND transport_contract_version = 'postwave.campaign-transport.v2'
        )
    ) NOT VALID;

CREATE OR REPLACE FUNCTION public.campaign_send_delivery_reply_correlation_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
    IF TG_OP = 'UPDATE' AND (
        NEW.reply_to IS DISTINCT FROM OLD.reply_to OR
        NEW.reply_correlation_version IS DISTINCT FROM OLD.reply_correlation_version OR
        NEW.reply_correlation_key_id IS DISTINCT FROM OLD.reply_correlation_key_id OR
        NEW.reply_correlation_expires_at IS DISTINCT FROM OLD.reply_correlation_expires_at OR
        NEW.reply_correlation_token_hash IS DISTINCT FROM OLD.reply_correlation_token_hash
    ) THEN
        RAISE EXCEPTION 'campaign send delivery reply correlation is immutable'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS campaign_send_delivery_reply_correlation_guard
    ON public.campaign_send_deliveries;
CREATE TRIGGER campaign_send_delivery_reply_correlation_guard
    BEFORE UPDATE ON public.campaign_send_deliveries
    FOR EACH ROW EXECUTE FUNCTION public.campaign_send_delivery_reply_correlation_guard();

COMMIT;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS campaign_send_deliveries_reply_correlation_token_uidx
    ON public.campaign_send_deliveries (reply_correlation_token_hash)
    WHERE reply_correlation_token_hash IS NOT NULL;

BEGIN;

SET LOCAL lock_timeout = '5s';
-- Validation scans historical rows without holding the ACCESS EXCLUSIVE lock
-- that an immediately-valid CHECK would retain for the whole scan. New rows
-- have already been protected since the first transaction committed.
SET LOCAL statement_timeout = '10min';

ALTER TABLE public.campaign_send_deliveries
    VALIDATE CONSTRAINT campaign_send_deliveries_reply_correlation_shape_check;

DO $$
DECLARE
    resolver pg_catalog.pg_roles%ROWTYPE;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles
         WHERE rolname = 'postwave_reply_correlation_resolver'
    ) THEN
        CREATE ROLE postwave_reply_correlation_resolver
            NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
            NOREPLICATION NOBYPASSRLS;
    END IF;

    SELECT * INTO resolver
      FROM pg_catalog.pg_roles
     WHERE rolname = 'postwave_reply_correlation_resolver';

    IF resolver.rolcanlogin OR resolver.rolsuper OR resolver.rolcreatedb OR
       resolver.rolcreaterole OR resolver.rolinherit OR
       resolver.rolreplication OR resolver.rolbypassrls THEN
        RAISE EXCEPTION 'postwave_reply_correlation_resolver has unsafe role attributes';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_auth_members
         WHERE member = resolver.oid OR roleid = resolver.oid
    ) THEN
        RAISE EXCEPTION 'postwave_reply_correlation_resolver must have no memberships or members';
    END IF;
END
$$;

REVOKE ALL PRIVILEGES ON public.campaign_send_deliveries
    FROM postwave_reply_correlation_resolver;
GRANT SELECT (
    tenant_id,
    reply_correlation_token_hash,
    reply_correlation_expires_at,
    state,
    transport_contract_version
) ON public.campaign_send_deliveries TO postwave_reply_correlation_resolver;

DROP POLICY IF EXISTS campaign_send_deliveries_reply_correlation_resolver_select
    ON public.campaign_send_deliveries;
CREATE POLICY campaign_send_deliveries_reply_correlation_resolver_select
    ON public.campaign_send_deliveries
    FOR SELECT TO postwave_reply_correlation_resolver
    USING (true);

GRANT USAGE, CREATE ON SCHEMA public TO postwave_reply_correlation_resolver;

DROP FUNCTION IF EXISTS public.resolve_campaign_reply_correlation_tenant(text);
CREATE FUNCTION public.resolve_campaign_reply_correlation_tenant(p_token_hash pg_catalog.text)
RETURNS pg_catalog.uuid
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
    SELECT delivery.tenant_id
      FROM public.campaign_send_deliveries AS delivery
     WHERE p_token_hash ~ '^[0-9a-f]{64}$'
       AND delivery.reply_correlation_token_hash = p_token_hash
       AND delivery.reply_correlation_expires_at > statement_timestamp()
       AND delivery.state = 'accepted'
       AND delivery.transport_contract_version = 'postwave.campaign-transport.v2'
$function$;

ALTER FUNCTION public.resolve_campaign_reply_correlation_tenant(text)
    OWNER TO postwave_reply_correlation_resolver;
REVOKE CREATE ON SCHEMA public FROM postwave_reply_correlation_resolver;
REVOKE ALL ON FUNCTION public.resolve_campaign_reply_correlation_tenant(text)
    FROM PUBLIC, postwave_reply_correlation_resolver;
GRANT EXECUTE ON FUNCTION public.resolve_campaign_reply_correlation_tenant(text)
    TO postwave_app;

COMMENT ON COLUMN public.campaign_send_deliveries.reply_to IS
    'Exact signed opaque Reply-To compiled into the immutable outbound RFC822 bytes.';
COMMENT ON COLUMN public.campaign_send_deliveries.reply_correlation_token_hash IS
    'SHA-256 commitment to the opaque Reply-To token; globally unique and not reversible.';
COMMENT ON FUNCTION public.resolve_campaign_reply_correlation_tenant(text) IS
    'Pre-tenant resolver for one exact live accepted correlation-token commitment. Returns only tenant UUID; owned by a fixed NOLOGIN/NOBYPASSRLS role.';

COMMIT;
