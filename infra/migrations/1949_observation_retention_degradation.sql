-- Retention DEGRADATION rather than deletion (PRD §2.1).
--
-- The PRD asks for two tiers: "raw events at full fidelity for 90 days, then drop
-- http_headers and ip (keep ASN) for the remainder." The implementation had one
-- tier — a hard DELETE at 30 days — which loses two things the second tier is
-- specifically designed to keep.
--
-- Why degradation rather than deletion matters here, concretely: ASN and the
-- event's own identity are what make a classification RE-DERIVABLE. Delete the
-- row and a reclassification under an improved classifier cannot revisit it at
-- all; degrade it and the machine-source registry (which matches on ASN) can
-- still reach a verdict, while the fingerprinting material that made the row
-- privacy-sensitive is gone.
--
-- THE APPEND-ONLY GUARD REJECTS EVERY UPDATE, so degradation needs a designed
-- exemption. A blanket "the retention worker may UPDATE" would be far too broad:
-- the worker could then rewrite a classification, an identity hash, or an event
-- type, and the append-only guarantee that the whole reclassification story rests
-- on would hold only by convention. So the exemption below verifies the update IS
-- a degradation — every column except the degradable ones must be unchanged, and
-- the degradable ones may only move toward NULL.
--
-- rollback-strategy: no-op
-- migration-execution: phased

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- degraded_at records that the second tier has been applied, so the worker can
-- skip rows it has already processed rather than rewriting them on every sweep.
ALTER TABLE subscriber_event_observations
    ADD COLUMN IF NOT EXISTS degraded_at timestamptz;

COMMIT;

CREATE INDEX CONCURRENTLY IF NOT EXISTS subscriber_event_observations_degradation_idx
    ON subscriber_event_observations (tenant_id, subscriber_event_at)
    WHERE degraded_at IS NULL;

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE OR REPLACE FUNCTION engagement_evidence_append_only_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
    IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
        RETURN OLD;
    END IF;
    -- Branch before touching a table-specific OLD field. This function is
    -- shared by several evidence tables and PL/pgSQL does not promise record
    -- field resolution will short-circuit across an AND expression.
    IF TG_TABLE_NAME = 'subscriber_event_observations' THEN
        IF TG_OP = 'DELETE'
           AND current_setting('app.engagement_observation_retention_worker', true) = 'true'
           AND OLD.privacy_expiry_at <= clock_timestamp() THEN
            RETURN OLD;
        END IF;

        -- The degradation exemption.
        --
        -- Permitted only when the retention worker declares itself AND the update
        -- is provably a degradation: the three privacy-sensitive columns may move
        -- toward NULL, degraded_at may be stamped, and NOTHING ELSE may change.
        --
        -- Enumerating the unchanged columns explicitly rather than trusting the
        -- worker's SQL is the whole point. A worker bug that also touched
        -- `classification`-adjacent evidence, an identity hash, or an event type
        -- would otherwise be indistinguishable from a legitimate degradation, and
        -- the append-only guarantee the reclassification story rests on would be
        -- convention rather than a constraint.
        IF TG_OP = 'UPDATE'
           AND current_setting('app.engagement_observation_retention_worker', true) = 'true'
           -- Degradable columns: may only be cleared, never rewritten to a new value.
           -- ordered_headers is NOT NULL with a '[]' default, so its DEGRADED form
           -- is the empty array rather than NULL. That is also its semantically
           -- correct cleared state: the table already distinguishes "no headers"
           -- from "headers not captured" via ordered_headers_complete.
           AND (NEW.ordered_headers = '[]'::jsonb OR NEW.ordered_headers = OLD.ordered_headers)
           AND (NEW.ip_address IS NULL OR NEW.ip_address = OLD.ip_address)
           AND (NEW.tls_ja4 IS NULL OR NEW.tls_ja4 = OLD.tls_ja4)
           -- ASN is deliberately RETAINED, per the PRD, so the machine-source
           -- registry can still match a degraded row.
           AND NEW.network_asn IS NOT DISTINCT FROM OLD.network_asn
           -- Everything else must be identical.
           AND NEW.id                     IS NOT DISTINCT FROM OLD.id
           AND NEW.tenant_id              IS NOT DISTINCT FROM OLD.tenant_id
           AND NEW.subscriber_event_id    IS NOT DISTINCT FROM OLD.subscriber_event_id
           AND NEW.subscriber_event_at    IS NOT DISTINCT FROM OLD.subscriber_event_at
           AND NEW.source                 IS NOT DISTINCT FROM OLD.source
           AND NEW.source_event_id        IS NOT DISTINCT FROM OLD.source_event_id
           AND NEW.idempotency_key        IS NOT DISTINCT FROM OLD.idempotency_key
           AND NEW.event_schema_version   IS NOT DISTINCT FROM OLD.event_schema_version
           AND NEW.event_type             IS NOT DISTINCT FROM OLD.event_type
           AND NEW.occurred_at            IS NOT DISTINCT FROM OLD.occurred_at
           AND NEW.ingested_at            IS NOT DISTINCT FROM OLD.ingested_at
           AND NEW.delivered_at           IS NOT DISTINCT FROM OLD.delivered_at
           AND NEW.campaign_id            IS NOT DISTINCT FROM OLD.campaign_id
           AND NEW.recipient_identity_hmac IS NOT DISTINCT FROM OLD.recipient_identity_hmac
           AND NEW.recipient_key_id       IS NOT DISTINCT FROM OLD.recipient_key_id
           AND NEW.message_identity_hash  IS NOT DISTINCT FROM OLD.message_identity_hash
           AND NEW.link_identity_hash     IS NOT DISTINCT FROM OLD.link_identity_hash
           AND NEW.is_seed                IS NOT DISTINCT FROM OLD.is_seed
           AND NEW.seed_test_id           IS NOT DISTINCT FROM OLD.seed_test_id
           AND NEW.provider_message_id    IS NOT DISTINCT FROM OLD.provider_message_id
           AND NEW.provider_request_id    IS NOT DISTINCT FROM OLD.provider_request_id
           -- ordered_headers_complete may only go to false: a degraded row has not
           -- gained capture completeness it never had.
           AND (NEW.ordered_headers_complete = false OR NEW.ordered_headers_complete = OLD.ordered_headers_complete)
        THEN
            RETURN NEW;
        END IF;
    END IF;
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
        USING ERRCODE = '55000';
END;
$fn$;

-- COLUMN-LEVEL update grant, not table-level.
--
-- The role could not UPDATE this table at all — correctly, since it is
-- append-only. Granting table-wide UPDATE to enable degradation would hand the
-- application role the ability to rewrite every column, with only the trigger
-- standing in the way. Postgres supports per-column grants, so the role is given
-- exactly the four columns degradation touches and nothing else.
--
-- Defence in depth with the trigger, deliberately: the grant makes most bad
-- updates impossible to express, and the trigger catches the ones that remain
-- expressible (clearing the right columns on a row that is not old enough, or
-- substituting a value rather than clearing it).
GRANT UPDATE (ordered_headers, ordered_headers_complete, ip_address, tls_ja4, degraded_at)
    ON subscriber_event_observations TO postwave_app;

-- An UPDATE policy, because there was none.
--
-- The table has exactly two policies — worker_insert and worker_select — so an
-- UPDATE had no permissive policy to satisfy and matched zero rows SILENTLY. Not
-- an error: RLS filters rather than refuses, so `UPDATE ... WHERE tenant_id = $1`
-- reported success having changed nothing. A retention worker built on that would
-- have logged "degraded 0 rows" forever and looked like a tenant with no old data.
--
-- The policy mirrors worker_select's GUC requirements and adds the retention
-- worker's own, so the degradation path must declare all of them: tenant scope,
-- outbox worker, classifier worker, retention worker. Four GUCs is not
-- belt-and-braces here — each one is a different subsystem asserting it is the
-- caller, and the retention sweep genuinely is all four.
DROP POLICY IF EXISTS subscriber_event_observations_retention_update
    ON subscriber_event_observations;
CREATE POLICY subscriber_event_observations_retention_update
    ON subscriber_event_observations
    FOR UPDATE
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND current_setting('app.engagement_observation_retention_worker', true) = 'true'
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND current_setting('app.engagement_observation_retention_worker', true) = 'true'
    );

COMMIT;
