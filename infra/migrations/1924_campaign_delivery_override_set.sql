-- 1924_campaign_delivery_override_set.sql
--
-- A blocked assurance run can contain several independently governed
-- findings. Migration 1922 retained only one representative override UUID in
-- the delivery receipt even though its trigger required every blocker to have
-- a live waiver. Preserve the complete, sorted waiver set on the immutable
-- send receipt so an audit can prove exactly which decisions authorized the
-- provider boundary.
--
-- `gate_override_id` remains as a compatibility/FK anchor and is always the
-- first UUID in `gate_override_ids`. New code treats the plural set as the
-- authority.
--
-- rollback-strategy: no-op. Removing authorization evidence from an existing
-- delivery receipt would make that receipt materially incomplete.

BEGIN;

ALTER TABLE campaign_send_deliveries
    ADD COLUMN IF NOT EXISTS gate_override_ids uuid[] NOT NULL
        DEFAULT '{}'::uuid[];

-- Existing overridden rows predate exact-set persistence. Preserve their
-- representative receipt so they remain readable, while every post-migration
-- insertion is held to the complete-set trigger below.
ALTER TABLE campaign_send_deliveries
    DISABLE TRIGGER campaign_send_deliveries_lifecycle_guard;

UPDATE campaign_send_deliveries
   SET gate_override_ids = ARRAY[gate_override_id]::uuid[]
 WHERE gate_decision = 'overridden'
   AND gate_override_id IS NOT NULL
   AND cardinality(gate_override_ids) = 0;

ALTER TABLE campaign_send_deliveries
    ENABLE TRIGGER campaign_send_deliveries_lifecycle_guard;

ALTER TABLE campaign_send_deliveries
    DROP CONSTRAINT IF EXISTS campaign_send_deliveries_gate_shape_check;

ALTER TABLE campaign_send_deliveries
    ADD CONSTRAINT campaign_send_deliveries_gate_shape_check CHECK (
        (gate_decision IN ('pass', 'warn')
            AND gate_override_id IS NULL
            AND cardinality(gate_override_ids) = 0)
        OR
        (gate_decision = 'overridden'
            AND gate_override_id IS NOT NULL
            AND cardinality(gate_override_ids) BETWEEN 1 AND 100
            AND gate_override_ids[1] = gate_override_id
            AND array_position(gate_override_ids, NULL) IS NULL)
    );

CREATE OR REPLACE FUNCTION campaign_send_deliveries_gate_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    run_state text;
    run_gate text;
    blocker_count integer;
    live_override_ids uuid[];
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RETURN NEW;
    END IF;

    SELECT state, gate_decision
      INTO run_state, run_gate
      FROM public.campaign_assurance_runs
     WHERE tenant_id = NEW.tenant_id
       AND campaign_id = NEW.campaign_id
       AND id = NEW.assurance_run_id
       AND attempt_count = NEW.assurance_attempt_count
       AND artifact_set_hash = NEW.artifact_set_hash
     FOR SHARE;

    IF NOT FOUND OR run_state <> 'complete' THEN
        RAISE EXCEPTION 'raw delivery requires a completed assurance run'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.gate_decision IN ('pass', 'warn') THEN
        IF run_gate <> NEW.gate_decision OR NEW.gate_override_id IS NOT NULL OR
           cardinality(NEW.gate_override_ids) <> 0 THEN
            RAISE EXCEPTION 'delivery gate decision does not match assurance receipt'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.gate_decision = 'overridden' THEN
        IF run_gate <> 'block' OR NEW.gate_override_id IS NULL OR
           cardinality(NEW.gate_override_ids) = 0 THEN
            RAISE EXCEPTION 'only a blocked run can be overridden for delivery'
                USING ERRCODE = '23514';
        END IF;

        SELECT count(*)::integer
          INTO blocker_count
          FROM public.campaign_assurance_findings AS finding
         WHERE finding.tenant_id = NEW.tenant_id
           AND finding.campaign_id = NEW.campaign_id
           AND finding.run_id = NEW.assurance_run_id
           AND finding.attempt_count = NEW.assurance_attempt_count
           AND finding.blocking;

        SELECT COALESCE(array_agg(latest.id ORDER BY latest.id), '{}'::uuid[])
          INTO live_override_ids
          FROM public.campaign_assurance_findings AS finding
          JOIN LATERAL (
              SELECT candidate.id, candidate.decision,
                     candidate.expires_at, candidate.finding_receipt_hash
                FROM public.campaign_assurance_overrides AS candidate
               WHERE candidate.tenant_id = finding.tenant_id
                 AND candidate.campaign_id = finding.campaign_id
                 AND candidate.run_id = finding.run_id
                 AND candidate.attempt_count = finding.attempt_count
                 AND candidate.artifact_set_hash = NEW.artifact_set_hash
                 AND candidate.finding_id = finding.id
               ORDER BY candidate.created_at DESC, candidate.id DESC
               LIMIT 1
          ) AS latest ON true
         WHERE finding.tenant_id = NEW.tenant_id
           AND finding.campaign_id = NEW.campaign_id
           AND finding.run_id = NEW.assurance_run_id
           AND finding.attempt_count = NEW.assurance_attempt_count
           AND finding.blocking
           AND finding.overridable
           AND latest.decision = 'allow_send'
           AND latest.finding_receipt_hash = finding.receipt_hash
           AND (latest.expires_at IS NULL OR
                latest.expires_at > statement_timestamp());

        IF blocker_count = 0 OR
           cardinality(live_override_ids) <> blocker_count OR
           NEW.gate_override_ids IS DISTINCT FROM live_override_ids OR
           NEW.gate_override_id IS DISTINCT FROM live_override_ids[1] THEN
            RAISE EXCEPTION 'delivery requires the exact complete live override set'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'unsupported delivery gate decision'
        USING ERRCODE = '23514';
END;
$fn$;

-- The 1922 lifecycle guard already rejects any update outside the narrowly
-- enumerated lifecycle shapes. Keep the new identity explicit as defense in
-- depth and as a stable migration-contract assertion.
CREATE OR REPLACE FUNCTION campaign_send_delivery_override_set_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
    IF NEW.gate_override_ids IS DISTINCT FROM OLD.gate_override_ids THEN
        RAISE EXCEPTION 'campaign send delivery override set is immutable'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS campaign_send_delivery_override_set_immutable
    ON campaign_send_deliveries;
CREATE TRIGGER campaign_send_delivery_override_set_immutable
    BEFORE UPDATE ON campaign_send_deliveries
    FOR EACH ROW EXECUTE FUNCTION campaign_send_delivery_override_set_immutable();

COMMENT ON COLUMN campaign_send_deliveries.gate_override_ids IS
    'Complete sorted set of latest live finding-scoped overrides that authorized an overridden provider dispatch.';

COMMIT;
