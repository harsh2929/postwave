-- PROVENANCE for subscriber_event_observations.network_asn (FOUND-2.1).
--
-- network_asn has existed since migration 1934, is carried by every layer of
-- the ingest path, is deliberately RETAINED by the 1949 retention degradation
-- so a degraded row stays re-derivable, and is read by the machine-source
-- registry rule that matches on ASN. It has also been NULL on every row ever
-- written, because no writer ever set it. The classifier's ASN arm has
-- therefore never fired in production.
--
-- Populating it needs no geoip dependency: an authenticated edge already knows
-- the value (Cloudflare exposes ip.src.asnum to transform rules) and can set a
-- header. What it does need is a way for a READER to tell a measured value from
-- an absent one, which is what this column adds.
--
-- WHY A NULL ALONE IS NOT ENOUGH. A NULL ASN is ambiguous in three ways that
-- call for three different operator responses:
--
--   edge_unconfigured  this deployment has no authenticated proxy boundary, so
--                      no ASN header could be honoured for ANY request. The
--                      signal is switched off, which looks exactly like "no bot
--                      traffic this week" if you only see NULLs.
--   unmeasured         a boundary exists; this request produced no usable ASN.
--   edge_measured      a trusted edge reported it. The only value an ingest path
--                      may write alongside a non-NULL ASN.
--
-- A fourth value, legacy_unattributed, exists ONLY as this migration's backfill
-- for rows that already carry an ASN. Nobody can now say how those values were
-- learned. Stamping them 'edge_measured' would manufacture exactly the
-- provenance claim this column exists to make auditable, so they are labelled
-- unknown-origin instead and the application refuses to write that value on any
-- new row.
--
-- WHY NOT A GUESS. internal/audit/ueba/impossible_travel.go deliberately hashes
-- an unknown /16 into a pseudo-coordinate rather than take a MaxMind
-- dependency. That is correct there — a wrong coordinate degrades to a missed
-- flag. It would be actively harmful here: the registry MATCHES on ASN, so a
-- fabricated value that collides with a registry entry classifies a real
-- person's open as machine traffic, and the resulting figure is
-- indistinguishable from a measured one. The CHECK below makes "a number with
-- no measurement behind it" unrepresentable rather than merely discouraged.
--
-- rollback-strategy: no-op
-- migration-execution: phased

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- NOT NULL with a default is a metadata-only change on PG11+. Every existing
-- row has a NULL network_asn, so 'unmeasured' is the truthful backfill and the
-- pairing CHECK below is already satisfied by the whole table.
ALTER TABLE subscriber_event_observations
    ADD COLUMN IF NOT EXISTS network_asn_source text NOT NULL DEFAULT 'unmeasured';

COMMENT ON COLUMN subscriber_event_observations.network_asn_source IS
    'How network_asn was learned: edge_measured (trusted-peer header), unmeasured (boundary exists, nothing usable this request), edge_unconfigured (no authenticated edge in this deployment), legacy_unattributed (pre-1968 row of unknown origin; never written by an ingest path). Never synthesised: a NULL ASN is strictly better than a plausible guess because the machine-source registry matches on ASN.';

-- Honest backfill. Rows that already carry an ASN get the unknown-origin label
-- rather than a manufactured measurement claim. On a deployment where the field
-- was genuinely never populated — the state this migration was written for —
-- this statement updates nothing.
--
-- The table is append-only and its guard trigger rejects every UPDATE that is
-- not a retention degradation, correctly: this backfill is neither, so the
-- trigger is suspended for exactly this one statement rather than the guard
-- being widened to admit a class of update that must never be admitted at
-- runtime. The suspension is transaction-local (the ALTERs take ACCESS
-- EXCLUSIVE inside this BEGIN and are rolled back with everything else on
-- failure), and it is deliberately NOT `session_replication_role = replica`,
-- which would also silence the canonical-event binding trigger.
ALTER TABLE subscriber_event_observations
    DISABLE TRIGGER subscriber_event_observations_append_only;

UPDATE subscriber_event_observations
   SET network_asn_source = 'legacy_unattributed'
 WHERE network_asn IS NOT NULL
   AND network_asn_source = 'unmeasured';

ALTER TABLE subscriber_event_observations
    ENABLE TRIGGER subscriber_event_observations_append_only;

ALTER TABLE subscriber_event_observations
    DROP CONSTRAINT IF EXISTS subscriber_event_observations_network_asn_source_vocabulary;
ALTER TABLE subscriber_event_observations
    ADD CONSTRAINT subscriber_event_observations_network_asn_source_vocabulary
    CHECK (network_asn_source IN ('edge_measured', 'unmeasured', 'edge_unconfigured', 'legacy_unattributed'))
    NOT VALID;

-- The pairing invariant. A value-bearing provenance without a value, or a value
-- without one, is exactly the ambiguity this column exists to remove, so it is a
-- constraint rather than a convention.
ALTER TABLE subscriber_event_observations
    DROP CONSTRAINT IF EXISTS subscriber_event_observations_network_asn_provenance;
ALTER TABLE subscriber_event_observations
    ADD CONSTRAINT subscriber_event_observations_network_asn_provenance
    CHECK (
        (network_asn IS NOT NULL)
        = (network_asn_source IN ('edge_measured', 'legacy_unattributed'))
    )
    NOT VALID;

COMMIT;

-- VALIDATE takes SHARE UPDATE EXCLUSIVE rather than the ACCESS EXCLUSIVE an
-- inline CHECK would have held for the length of a full scan.
ALTER TABLE subscriber_event_observations
    VALIDATE CONSTRAINT subscriber_event_observations_network_asn_source_vocabulary;
ALTER TABLE subscriber_event_observations
    VALIDATE CONSTRAINT subscriber_event_observations_network_asn_provenance;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- Extend the 1949 append-only guard to cover the new column.
--
-- The guard enumerates every column that a retention degradation may NOT
-- change, and has no catch-all: a column added afterwards is silently outside
-- the enumeration. The column-level UPDATE grant from 1949 already makes such an
-- update inexpressible for postwave_app, and this is the second half of that
-- defence in depth — the grant makes most bad updates impossible to write, the
-- trigger catches the ones that remain expressible.
--
-- Not SECURITY DEFINER (it runs as the invoker), and search_path keeps pg_temp
-- last exactly as the 1949 definition does.
CREATE OR REPLACE FUNCTION engagement_evidence_append_only_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
    IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
        RETURN OLD;
    END IF;
    IF TG_TABLE_NAME = 'subscriber_event_observations' THEN
        IF TG_OP = 'DELETE'
           AND current_setting('app.engagement_observation_retention_worker', true) = 'true'
           AND OLD.privacy_expiry_at <= clock_timestamp() THEN
            RETURN OLD;
        END IF;

        IF TG_OP = 'UPDATE'
           AND current_setting('app.engagement_observation_retention_worker', true) = 'true'
           AND (NEW.ordered_headers = '[]'::jsonb OR NEW.ordered_headers = OLD.ordered_headers)
           AND (NEW.ip_address IS NULL OR NEW.ip_address = OLD.ip_address)
           AND (NEW.tls_ja4 IS NULL OR NEW.tls_ja4 = OLD.tls_ja4)
           -- ASN is deliberately RETAINED, per the PRD, so the machine-source
           -- registry can still match a degraded row. Its PROVENANCE is
           -- retained with it: a degraded row whose ASN survived but whose
           -- provenance was cleared would be a value nobody could audit, which
           -- is the exact state this migration exists to make unrepresentable.
           AND NEW.network_asn IS NOT DISTINCT FROM OLD.network_asn
           AND NEW.network_asn_source IS NOT DISTINCT FROM OLD.network_asn_source
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
           AND (NEW.ordered_headers_complete = false OR NEW.ordered_headers_complete = OLD.ordered_headers_complete)
        THEN
            RETURN NEW;
        END IF;
    END IF;
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
        USING ERRCODE = '55000';
END;
$fn$;

-- The degradation UPDATE grant is column-level and stays that way: the new
-- column is NOT added to it, so the application role cannot rewrite a
-- provenance even if the trigger were somehow satisfied.

COMMIT;
