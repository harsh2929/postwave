-- 1766_subscriber_email_consent_terminal_hardening.sql
--
-- P0-04 / P0-05 / SUB-016 / SUB-041 / SUB-042 / SUB-044 / SUB-121
--
-- Migration 1765 made new per-address subscription writes fail closed, but it
-- intentionally grandfathered existing rows and accepted any non-empty JSON
-- object as a consent-record proof.  It also treated an event's occurred time
-- as its recording time and allowed an already-subscribed row to bypass the
-- proof fold.  Those shortcuts are not a production consent boundary.
--
-- This expand/contract migration adds the terminal-state layer:
--
--   * every existing subscriber_emails row is classified in bounded,
--     resumable batches before this migration can be marked applied;
--   * a release gate remains blocked until no address is pending and every
--     subscribed address has an exact, current, structured proof;
--   * grants are accepted only through a source-specific consent event/record
--     pair (or the immutable 1761 import approval/receipt chain) bound to the
--     exact tenant, subscriber, address, email, event, and policy;
--   * occurred_at and immutable recorded_at are kept separately, and the
--     projection folds the latest exact terminal decision with non-grants
--     winning ambiguous chronology;
--   * all consent, per-address state, raw subscriber purpose, external sync
--     ledger, and email-suppression mutations share a bounded advisory lock on
--     the normalized (tenant,email) key;
--   * every such decision advances an exact-address generation and ETag.
--
-- migration-execution: phased
-- rollback-strategy: no-op
-- rollback-details: leave the fail-closed contract, chronology, reconciliation
-- ledger, and generation state installed.  A code rollback remains safe because
-- existing columns and APIs are preserved.  Removing these guards would
-- re-enable fabricated/grandfathered consent and requires security approval.
-- preflight: drain legacy positive-consent writers and pause outbound campaign
-- activation.  The runner commits the additive contract, builds online indexes,
-- calls the resumable reconciler in <=250-row transactions, and opens the gate
-- only after its exact postcheck.  A timeout/crash is safe: rerun the same
-- checksum-bound migration and the procedure resumes the active run.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- A volatile DEFAULT is intentionally installed only for future rows.  Existing
-- ledger rows stay NULL and are interpreted conservatively through their actual
-- storage-created timestamp during reconciliation; no table rewrite is needed.
ALTER TABLE public.consent_events
    ADD COLUMN IF NOT EXISTS recorded_at timestamptz;
ALTER TABLE public.consent_events
    ALTER COLUMN recorded_at SET DEFAULT clock_timestamp();

ALTER TABLE public.consent_records
    ADD COLUMN IF NOT EXISTS recorded_at timestamptz;
ALTER TABLE public.consent_records
    ALTER COLUMN recorded_at SET DEFAULT clock_timestamp();

ALTER TABLE public.subscriber_emails
    ADD COLUMN IF NOT EXISTS consent_reconciliation_state text
        NOT NULL DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS consent_reconciliation_generation bigint
        NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS consent_decision_checksum text,
    ADD COLUMN IF NOT EXISTS consent_classified_at timestamptz,
    ADD COLUMN IF NOT EXISTS consent_terminal_occurred_at timestamptz,
    ADD COLUMN IF NOT EXISTS consent_terminal_recorded_at timestamptz,
    ADD COLUMN IF NOT EXISTS consent_proof_expires_at timestamptz;

ALTER TABLE public.subscriber_emails
    ADD CONSTRAINT subscriber_emails_consent_reconciliation_state_check
    CHECK (consent_reconciliation_state IN (
        'pending', 'proven', 'failed_closed'
    )) NOT VALID,
    ADD CONSTRAINT subscriber_emails_consent_reconciliation_generation_check
    CHECK (consent_reconciliation_generation >= 0) NOT VALID,
    ADD CONSTRAINT subscriber_emails_consent_decision_checksum_check
    CHECK (
        consent_decision_checksum IS NULL OR
        consent_decision_checksum ~ '^[0-9a-f]{64}$'
    ) NOT VALID;

COMMENT ON COLUMN public.consent_events.recorded_at IS
    'Immutable database recording chronology. created_at remains the asserted occurrence time for the legacy event shape.';
COMMENT ON COLUMN public.consent_records.recorded_at IS
    'Immutable database recording chronology, separate from captured_at occurrence time.';
COMMENT ON COLUMN public.subscriber_emails.consent_reconciliation_state IS
    '1766 exact-address classification: pending is never release-eligible; proven requires the latest exact structured grant; failed_closed is non-sendable.';

CREATE TABLE public.subscriber_email_consent_release_gate (
    singleton                 boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    contract_version          text NOT NULL,
    status                    text NOT NULL CHECK (status IN ('blocked', 'open')),
    active_run_id             uuid,
    rows_total                bigint NOT NULL DEFAULT 0 CHECK (rows_total >= 0),
    rows_processed            bigint NOT NULL DEFAULT 0 CHECK (rows_processed >= 0),
    rows_proven               bigint NOT NULL DEFAULT 0 CHECK (rows_proven >= 0),
    rows_failed_closed        bigint NOT NULL DEFAULT 0 CHECK (rows_failed_closed >= 0),
    postcheck_checksum        text CHECK (
                                  postcheck_checksum IS NULL OR
                                  postcheck_checksum ~ '^[0-9a-f]{64}$'
                              ),
    blocked_at                timestamptz NOT NULL DEFAULT clock_timestamp(),
    opened_at                 timestamptz,
    updated_at                timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (
        (status = 'blocked' AND opened_at IS NULL) OR
        (status = 'open' AND opened_at IS NOT NULL AND postcheck_checksum IS NOT NULL)
    )
);

CREATE TABLE public.subscriber_email_consent_reconciliation_runs (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    contract_version          text NOT NULL,
    status                    text NOT NULL CHECK (status IN (
                                  'running', 'complete', 'failed'
                              )),
    batch_limit               integer NOT NULL CHECK (batch_limit BETWEEN 1 AND 500),
    rows_total                bigint NOT NULL CHECK (rows_total >= 0),
    rows_processed            bigint NOT NULL DEFAULT 0 CHECK (rows_processed >= 0),
    rows_proven               bigint NOT NULL DEFAULT 0 CHECK (rows_proven >= 0),
    rows_failed_closed        bigint NOT NULL DEFAULT 0 CHECK (rows_failed_closed >= 0),
    last_partition            uuid,
    last_address_id           uuid,
    rolling_checksum          text NOT NULL CHECK (rolling_checksum ~ '^[0-9a-f]{64}$'),
    postcheck_checksum        text CHECK (
                                  postcheck_checksum IS NULL OR
                                  postcheck_checksum ~ '^[0-9a-f]{64}$'
                              ),
    started_at                timestamptz NOT NULL DEFAULT clock_timestamp(),
    heartbeat_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
    completed_at              timestamptz,
    last_error_code           text,
    CHECK (
        (status = 'complete' AND completed_at IS NOT NULL AND postcheck_checksum IS NOT NULL) OR
        (status <> 'complete' AND completed_at IS NULL)
    )
);

ALTER TABLE public.subscriber_email_consent_release_gate
    ADD CONSTRAINT subscriber_email_consent_release_gate_run_fk
    FOREIGN KEY (active_run_id)
    REFERENCES public.subscriber_email_consent_reconciliation_runs(id)
    ON DELETE RESTRICT NOT VALID;

CREATE TABLE public.subscriber_email_consent_address_state (
    tenant_id                 uuid NOT NULL,
    normalized_email          text NOT NULL CHECK (
                                  normalized_email = lower(btrim(normalized_email)) AND
                                  normalized_email <> ''
                              ),
    generation                bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
    etag                      text NOT NULL CHECK (etag ~ '^[0-9a-f]{64}$'),
    last_source_table         text NOT NULL,
    last_source_id            text,
    last_recorded_at          timestamptz NOT NULL,
    updated_at                timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, normalized_email)
);

ALTER TABLE public.subscriber_email_consent_address_state
    ADD CONSTRAINT subscriber_email_consent_address_state_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

GRANT SELECT ON public.subscriber_email_consent_address_state TO postwave_app;
REVOKE ALL ON
    public.subscriber_email_consent_release_gate,
    public.subscriber_email_consent_reconciliation_runs
    FROM PUBLIC, postwave_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON
    public.subscriber_email_consent_address_state FROM PUBLIC, postwave_app;

-- The application needs a release decision, not fleet-wide reconciliation
-- counts, run UUIDs, failure details, or operational timestamps.  Keep those
-- tables owner-only and expose one deliberately narrow boolean predicate to
-- the restrictive subscriber_emails policy.
CREATE OR REPLACE FUNCTION public.subscriber_email_consent_release_open()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
    SELECT COALESCE((
        SELECT gate.status = 'open' AND
               gate.opened_at IS NOT NULL AND
               gate.rows_processed = gate.rows_total AND
               gate.postcheck_checksum IS NOT NULL
          FROM public.subscriber_email_consent_release_gate AS gate
         WHERE gate.singleton
    ), false)
$function$;

REVOKE ALL ON FUNCTION public.subscriber_email_consent_release_open()
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.subscriber_email_consent_release_open()
    TO postwave_app;

ALTER TABLE public.subscriber_email_consent_address_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriber_email_consent_address_state FORCE ROW LEVEL SECURITY;
CREATE POLICY subscriber_email_consent_address_state_tenant_isolation
    ON public.subscriber_email_consent_address_state
    AS RESTRICTIVE FOR ALL
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );
CREATE POLICY subscriber_email_consent_address_state_tenant_visible
    ON public.subscriber_email_consent_address_state
    AS PERMISSIVE FOR SELECT TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

-- A proof can be valid when projected and expire later without another write.
-- Campaign/segment activation already requires an exact subscriber_emails
-- EXISTS under postwave_app.  A positive row is therefore visible to that role
-- only after the global reconciliation gate is open and only while the exact
-- address remains proven, checksummed, and non-expired.  This makes the gate an
-- enforced release boundary instead of observational metadata.  Non-positive
-- rows remain visible and mutable; security-definer reconciliation/admin
-- evidence can still inspect and demote retained unsafe rows.
DROP POLICY IF EXISTS subscriber_emails_nonexpired_positive_visibility
    ON public.subscriber_emails;
CREATE POLICY subscriber_emails_nonexpired_positive_visibility
    ON public.subscriber_emails
    AS RESTRICTIVE FOR SELECT TO postwave_app
    USING (
        consent_status <> 'subscribed' OR
        (
            consent_reconciliation_state = 'proven' AND
            consent_decision_checksum IS NOT NULL AND
            (
                consent_proof_expires_at IS NULL OR
                consent_proof_expires_at > pg_catalog.clock_timestamp()
            ) AND
            public.subscriber_email_consent_release_open()
        )
    );

CREATE OR REPLACE FUNCTION public.subscriber_email_consent_normalize_email(
    p_email text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
    SELECT pg_catalog.lower(pg_catalog.btrim(p_email))
$function$;

REVOKE ALL ON FUNCTION public.subscriber_email_consent_normalize_email(text)
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.subscriber_email_consent_normalize_email(text)
    TO postwave_app;

-- lower(email) uniqueness inherited from 0452 does not collapse whitespace
-- aliases, while every 1766 lock/fold/generation key deliberately does.  Abort
-- before committing phased DDL when retained aliases would make exact-address
-- selection ambiguous.  The matching concurrent unique index below closes the
-- race for all future writers; if a writer races this preflight, index creation
-- fails while the newly installed release gate remains blocked.
DO $normalized_identity_preflight$
DECLARE
    collision_groups bigint;
BEGIN
    SELECT pg_catalog.count(*) INTO collision_groups
      FROM (
          SELECT address.tenant_id,
                 public.subscriber_email_consent_normalize_email(
                     address.email::text
                 ) AS normalized_email
            FROM public.subscriber_emails AS address
           GROUP BY address.tenant_id,
                    public.subscriber_email_consent_normalize_email(
                        address.email::text
                    )
          HAVING pg_catalog.count(*) > 1
      ) AS collisions;
    IF collision_groups <> 0 THEN
        RAISE EXCEPTION 'subscriber email normalized identity collisions require review'
            USING ERRCODE = '23505',
                  DETAIL = collision_groups::text ||
                      ' tenant/address alias group(s) conflict after lower+trim normalization.',
                  HINT = 'Resolve aliases under outbound pause, then rerun migration 1766.';
    END IF;
END;
$normalized_identity_preflight$;

-- pg_try_advisory_xact_lock plus a small fixed retry budget avoids an
-- unbounded wait when a hostile writer holds the exact-address mutex.  OLD and
-- NEW keys are sorted before acquisition, so rotations cannot invert order.
CREATE OR REPLACE FUNCTION public.subscriber_email_consent_lock_one(
    p_tenant_id uuid,
    p_email text
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
    normalized text;
    lock_key bigint;
    attempt integer;
BEGIN
    normalized := public.subscriber_email_consent_normalize_email(p_email);
    IF normalized = '' THEN
        RAISE EXCEPTION 'consent lock requires a non-empty email identity'
            USING ERRCODE = '22023';
    END IF;
    lock_key := pg_catalog.hashtextextended(
        p_tenant_id::text || ':' || normalized,
        1766
    );
    FOR attempt IN 1..50 LOOP
        IF pg_catalog.pg_try_advisory_xact_lock(lock_key) THEN
            RETURN;
        END IF;
        PERFORM pg_catalog.pg_sleep(0.01);
    END LOOP;
    RAISE EXCEPTION 'timed out serializing consent for exact address'
        USING ERRCODE = '55P03',
              HINT = 'Retry the complete transaction with bounded backoff.';
END;
$function$;

CREATE OR REPLACE FUNCTION public.subscriber_email_consent_lock_pair(
    p_old_tenant_id uuid,
    p_old_email text,
    p_new_tenant_id uuid,
    p_new_email text
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
    old_key text;
    new_key text;
BEGIN
    IF p_old_tenant_id IS NOT NULL AND p_old_email IS NOT NULL THEN
        old_key := p_old_tenant_id::text || ':' ||
            public.subscriber_email_consent_normalize_email(p_old_email);
    END IF;
    IF p_new_tenant_id IS NOT NULL AND p_new_email IS NOT NULL THEN
        new_key := p_new_tenant_id::text || ':' ||
            public.subscriber_email_consent_normalize_email(p_new_email);
    END IF;
    IF old_key IS NULL THEN
        PERFORM public.subscriber_email_consent_lock_one(
            p_new_tenant_id, p_new_email
        );
    ELSIF new_key IS NULL OR old_key = new_key THEN
        PERFORM public.subscriber_email_consent_lock_one(
            p_old_tenant_id, p_old_email
        );
    ELSIF old_key COLLATE "C" < new_key COLLATE "C" THEN
        PERFORM public.subscriber_email_consent_lock_one(
            p_old_tenant_id, p_old_email
        );
        PERFORM public.subscriber_email_consent_lock_one(
            p_new_tenant_id, p_new_email
        );
    ELSE
        PERFORM public.subscriber_email_consent_lock_one(
            p_new_tenant_id, p_new_email
        );
        PERFORM public.subscriber_email_consent_lock_one(
            p_old_tenant_id, p_old_email
        );
    END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.subscriber_email_consent_lock_one(uuid, text),
    public.subscriber_email_consent_lock_pair(uuid, text, uuid, text)
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.subscriber_email_consent_lock_one(uuid, text),
    public.subscriber_email_consent_lock_pair(uuid, text, uuid, text)
    TO postwave_app;

-- The restrictive send-visibility policy intentionally hides a retained
-- positive while the release gate is blocked or its proof has expired.  A
-- reviewed revoke/renewal writer still needs a narrow way to resolve and
-- serialize that exact stored row.  This function bypasses SELECT RLS only
-- after binding the requested tenant to app.tenant_id and the exact
-- subscriber/address identity.  It deliberately does not take a row lock:
-- the exact advisory mutex is acquired first, and the caller must retain the
-- transaction while appending its terminal evidence.  Omitting FOR UPDATE
-- avoids an advisory->row order that would invert the row->advisory order of
-- legacy direct writers.  The evidence trigger re-enters the same advisory
-- mutex and projects the final row without making this lookup send-visible.
CREATE OR REPLACE FUNCTION public.subscriber_email_consent_lock_for_repair(
    p_tenant_id uuid,
    p_subscriber_id uuid,
    p_email text
)
RETURNS TABLE (
    address_id uuid,
    stored_email text,
    is_primary boolean,
    consent_status text,
    suppressed boolean,
    last_engaged_at timestamptz,
    created_at timestamptz,
    updated_at timestamptz,
    reconciliation_state text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    configured_tenant uuid;
    normalized text;
BEGIN
    configured_tenant := NULLIF(
        pg_catalog.current_setting('app.tenant_id', true), ''
    )::uuid;
    IF configured_tenant IS NULL OR configured_tenant <> p_tenant_id THEN
        RAISE EXCEPTION 'consent repair tenant scope is missing or mismatched'
            USING ERRCODE = '42501';
    END IF;
    normalized := public.subscriber_email_consent_normalize_email(p_email);
    PERFORM public.subscriber_email_consent_lock_one(
        p_tenant_id, normalized
    );
    RETURN QUERY
        SELECT address.id,
               address.email::text,
               address.is_primary,
               address.consent_status,
               address.suppressed,
               address.last_engaged_at,
               address.created_at,
               address.updated_at,
               address.consent_reconciliation_state
          FROM public.subscriber_emails AS address
         WHERE address.tenant_id = p_tenant_id
           AND address.subscriber_id = p_subscriber_id
           AND public.subscriber_email_consent_normalize_email(
                   address.email::text
               ) = normalized;
END;
$function$;

REVOKE ALL ON FUNCTION public.subscriber_email_consent_lock_for_repair(
    uuid, uuid, text
) FROM PUBLIC, postwave_app;
GRANT EXECUTE ON FUNCTION public.subscriber_email_consent_lock_for_repair(
    uuid, uuid, text
) TO postwave_app;

-- Secondary-address PATCH/DELETE writers have an immutable address UUID and
-- must not resolve through the subscriber's canonical email.  Resolve that
-- exact tenant/subscriber/address tuple under the definer, acquire the same
-- normalized-email mutex, then re-check the identity before returning.  A
-- concurrent address rotation can therefore produce an empty result for a
-- safe caller retry, but can never return a row protected by a different key.
CREATE OR REPLACE FUNCTION public.subscriber_email_consent_lock_for_repair_by_id(
    p_tenant_id uuid,
    p_subscriber_id uuid,
    p_address_id uuid
)
RETURNS TABLE (
    address_id uuid,
    stored_email text,
    is_primary boolean,
    consent_status text,
    suppressed boolean,
    last_engaged_at timestamptz,
    created_at timestamptz,
    updated_at timestamptz,
    reconciliation_state text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    configured_tenant uuid;
    resolved_email text;
    normalized text;
BEGIN
    configured_tenant := NULLIF(
        pg_catalog.current_setting('app.tenant_id', true), ''
    )::uuid;
    IF configured_tenant IS NULL OR configured_tenant <> p_tenant_id THEN
        RAISE EXCEPTION 'consent repair tenant scope is missing or mismatched'
            USING ERRCODE = '42501';
    END IF;

    SELECT address.email::text
      INTO resolved_email
      FROM public.subscriber_emails AS address
     WHERE address.tenant_id = p_tenant_id
       AND address.subscriber_id = p_subscriber_id
       AND address.id = p_address_id;
    IF NOT FOUND THEN
        RETURN;
    END IF;

    normalized := public.subscriber_email_consent_normalize_email(
        resolved_email
    );
    PERFORM public.subscriber_email_consent_lock_one(
        p_tenant_id, normalized
    );
    RETURN QUERY
        SELECT address.id,
               address.email::text,
               address.is_primary,
               address.consent_status,
               address.suppressed,
               address.last_engaged_at,
               address.created_at,
               address.updated_at,
               address.consent_reconciliation_state
          FROM public.subscriber_emails AS address
         WHERE address.tenant_id = p_tenant_id
           AND address.subscriber_id = p_subscriber_id
           AND address.id = p_address_id
           AND public.subscriber_email_consent_normalize_email(
                   address.email::text
               ) = normalized;
END;
$function$;

REVOKE ALL ON FUNCTION public.subscriber_email_consent_lock_for_repair_by_id(
    uuid, uuid, uuid
) FROM PUBLIC, postwave_app;
GRANT EXECUTE ON FUNCTION public.subscriber_email_consent_lock_for_repair_by_id(
    uuid, uuid, uuid
) TO postwave_app;

-- RLS-hidden positives also make an ordinary app-role suppression-only UPDATE
-- affect zero rows.  This is the sole privileged projection writer exposed to
-- the application: it may change only subscriber_emails.suppressed, only for
-- an exact tenant/subscriber/address identity, and only at the exact revision
-- returned by a repair resolver.  Suppression evidence remains authoritative:
-- callers must append an active exact-email evidence row before setting true,
-- and must remove every active unified hold before setting false.  The
-- normalized-email uniqueness invariant binds that evidence to this one
-- address inside the tenant.  Suppression-table generation triggers acquire
-- this same mutex but do not mutate subscriber_emails.updated_at, so the
-- resolver revision remains valid across the reviewed evidence write.
CREATE OR REPLACE FUNCTION public.subscriber_email_consent_set_suppressed_for_repair_by_id(
    p_tenant_id uuid,
    p_subscriber_id uuid,
    p_address_id uuid,
    p_expected_updated_at timestamptz,
    p_suppressed boolean
)
RETURNS TABLE (
    outcome text,
    address_id uuid,
    stored_email text,
    is_primary boolean,
    consent_status text,
    suppressed boolean,
    last_engaged_at timestamptz,
    created_at timestamptz,
    updated_at timestamptz,
    reconciliation_state text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET lock_timeout = '1s'
AS $function$
DECLARE
    configured_tenant uuid;
    resolved_email text;
    normalized text;
    address_row record;
    active_suppression boolean;
BEGIN
    configured_tenant := NULLIF(
        pg_catalog.current_setting('app.tenant_id', true), ''
    )::uuid;
    IF configured_tenant IS NULL OR configured_tenant <> p_tenant_id THEN
        RAISE EXCEPTION 'consent repair tenant scope is missing or mismatched'
            USING ERRCODE = '42501';
    END IF;
    IF p_expected_updated_at IS NULL OR p_suppressed IS NULL THEN
        RAISE EXCEPTION 'consent suppression repair revision and value are required'
            USING ERRCODE = '22023';
    END IF;

    SELECT address.email::text
      INTO resolved_email
      FROM public.subscriber_emails AS address
     WHERE address.tenant_id = p_tenant_id
       AND address.subscriber_id = p_subscriber_id
       AND address.id = p_address_id;
    IF NOT FOUND THEN
        RETURN QUERY SELECT
            'not_found'::text,
            NULL::uuid,
            NULL::text,
            NULL::boolean,
            NULL::text,
            NULL::boolean,
            NULL::timestamptz,
            NULL::timestamptz,
            NULL::timestamptz,
            NULL::text;
        RETURN;
    END IF;

    normalized := public.subscriber_email_consent_normalize_email(
        resolved_email
    );
    PERFORM public.subscriber_email_consent_lock_one(
        p_tenant_id, normalized
    );

    SELECT address.id,
           address.email::text AS stored_email,
           address.is_primary,
           address.consent_status,
           address.suppressed,
           address.last_engaged_at,
           address.created_at,
           address.updated_at,
           address.consent_reconciliation_state AS reconciliation_state
      INTO address_row
      FROM public.subscriber_emails AS address
     WHERE address.tenant_id = p_tenant_id
       AND address.subscriber_id = p_subscriber_id
       AND address.id = p_address_id;
    IF NOT FOUND THEN
        RETURN QUERY SELECT
            'stale'::text,
            NULL::uuid,
            NULL::text,
            NULL::boolean,
            NULL::text,
            NULL::boolean,
            NULL::timestamptz,
            NULL::timestamptz,
            NULL::timestamptz,
            NULL::text;
        RETURN;
    END IF;
    IF public.subscriber_email_consent_normalize_email(
           address_row.stored_email
       ) IS DISTINCT FROM normalized THEN
        RETURN QUERY SELECT
            'stale'::text,
            address_row.id,
            address_row.stored_email,
            address_row.is_primary,
            address_row.consent_status,
            address_row.suppressed,
            address_row.last_engaged_at,
            address_row.created_at,
            address_row.updated_at,
            address_row.reconciliation_state;
        RETURN;
    END IF;
    IF address_row.updated_at IS DISTINCT FROM p_expected_updated_at THEN
        RETURN QUERY SELECT
            'stale'::text,
            address_row.id,
            address_row.stored_email,
            address_row.is_primary,
            address_row.consent_status,
            address_row.suppressed,
            address_row.last_engaged_at,
            address_row.created_at,
            address_row.updated_at,
            address_row.reconciliation_state;
        RETURN;
    END IF;

    SELECT EXISTS (
        SELECT 1
          FROM public.suppressions AS evidence
         WHERE evidence.tenant_id = p_tenant_id
           AND public.subscriber_email_consent_normalize_email(
                   evidence.email::text
               ) = normalized
        UNION ALL
        SELECT 1
          FROM public.subscriber_suppressions AS evidence
         WHERE evidence.tenant_id = p_tenant_id
           AND public.subscriber_email_consent_normalize_email(
                   evidence.email::text
               ) = normalized
           AND (
               evidence.expires_at IS NULL OR
               evidence.expires_at > pg_catalog.clock_timestamp()
           )
        UNION ALL
        SELECT 1
          FROM public.email_suppressions AS evidence
         WHERE evidence.tenant_id = p_tenant_id
           AND public.subscriber_email_consent_normalize_email(
                   evidence.email::text
               ) = normalized
           AND (
               evidence.expires_at IS NULL OR
               evidence.expires_at > pg_catalog.clock_timestamp()
           )
    ) INTO active_suppression;
    IF p_suppressed IS DISTINCT FROM active_suppression THEN
        RAISE EXCEPTION 'consent suppression repair must match active exact-address evidence'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'subscriber_email_suppressed_requires_exact_evidence';
    END IF;

    UPDATE public.subscriber_emails AS address
       SET suppressed = p_suppressed,
           updated_at = pg_catalog.clock_timestamp()
     WHERE address.tenant_id = p_tenant_id
       AND address.subscriber_id = p_subscriber_id
       AND address.id = p_address_id
       AND address.updated_at = p_expected_updated_at
       AND public.subscriber_email_consent_normalize_email(
               address.email::text
           ) = normalized
    RETURNING address.id,
              address.email::text,
              address.is_primary,
              address.consent_status,
              address.suppressed,
              address.last_engaged_at,
              address.created_at,
              address.updated_at,
              address.consent_reconciliation_state
         INTO address_row;
    IF NOT FOUND THEN
        RETURN QUERY SELECT
            'stale'::text,
            NULL::uuid,
            NULL::text,
            NULL::boolean,
            NULL::text,
            NULL::boolean,
            NULL::timestamptz,
            NULL::timestamptz,
            NULL::timestamptz,
            NULL::text;
        RETURN;
    END IF;

    RETURN QUERY SELECT
        'updated'::text,
        address_row.id,
        address_row.email,
        address_row.is_primary,
        address_row.consent_status,
        address_row.suppressed,
        address_row.last_engaged_at,
        address_row.created_at,
        address_row.updated_at,
        address_row.consent_reconciliation_state;
END;
$function$;

REVOKE ALL ON FUNCTION public.subscriber_email_consent_set_suppressed_for_repair_by_id(
    uuid, uuid, uuid, timestamptz, boolean
) FROM PUBLIC, postwave_app;
GRANT EXECUTE ON FUNCTION public.subscriber_email_consent_set_suppressed_for_repair_by_id(
    uuid, uuid, uuid, timestamptz, boolean
) TO postwave_app;

-- The 1765 deferred canonical-identity trigger ran as the invoking app role.
-- Once 1766 deliberately hides a gate-blocked or expired positive, that
-- trigger could not see the already-existing exact address and attempted a
-- duplicate insert at COMMIT.  Keep RLS strict for application SQL and move
-- only this trigger's exact identity reconciliation behind a purpose-built
-- definer.  The function cannot be called by application roles, validates its
-- trigger relation/operation and any configured tenant scope, and never reads
-- or writes outside NEW's exact tenant/subscriber identity.
CREATE OR REPLACE FUNCTION public.subscriber_email_consent_reconcile_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    configured_tenant uuid;
    canonical_email text;
    normalized_email text;
    purpose_granted boolean;
    target_id uuid;
    replacement_id uuid;
    sibling_count integer;
    target_status text := 'never_subscribed';
BEGIN
    IF TG_RELID <> 'public.subscribers'::pg_catalog.regclass OR
       TG_OP NOT IN ('INSERT', 'UPDATE') THEN
        RAISE EXCEPTION 'subscriber email identity reconciliation trigger context is invalid'
            USING ERRCODE = '42501';
    END IF;
    IF NEW.tenant_id IS NULL OR NEW.id IS NULL OR NEW.email IS NULL THEN
        RAISE EXCEPTION 'subscriber email identity reconciliation requires exact identity'
            USING ERRCODE = '23502';
    END IF;
    IF TG_OP = 'UPDATE' AND (
        NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR
        NEW.id IS DISTINCT FROM OLD.id
    ) THEN
        RAISE EXCEPTION 'subscriber email identity reconciliation cannot move tenant or subscriber identity'
            USING ERRCODE = '23514';
    END IF;

    configured_tenant := NULLIF(
        pg_catalog.current_setting('app.tenant_id', true), ''
    )::uuid;
    IF configured_tenant IS NOT NULL AND
       configured_tenant <> NEW.tenant_id THEN
        RAISE EXCEPTION 'subscriber email identity reconciliation tenant scope is mismatched'
            USING ERRCODE = '42501';
    END IF;

    SELECT subscriber.email::text,
           subscriber.status = 'enabled'
           AND subscriber.consent_email_marketing_at IS NOT NULL
           AND subscriber.archived_at IS NULL
      INTO canonical_email, purpose_granted
      FROM public.subscribers AS subscriber
     WHERE subscriber.tenant_id = NEW.tenant_id
       AND subscriber.id = NEW.id;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    normalized_email := public.subscriber_email_consent_normalize_email(
        canonical_email
    );

    -- Preserve 1765's subscriber-scoped serialization while the 1766 BEFORE
    -- trigger independently holds the ordered exact-email mutex.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
            NEW.tenant_id::text || ':' || NEW.id::text,
            1765
        )
    );

    SELECT address.id
      INTO target_id
      FROM public.subscriber_emails AS address
     WHERE address.tenant_id = NEW.tenant_id
       AND address.subscriber_id = NEW.id
       AND public.subscriber_email_consent_normalize_email(
               address.email::text
           ) = normalized_email
     ORDER BY address.id
     LIMIT 1;

    IF target_id IS NOT NULL THEN
        UPDATE public.subscriber_emails AS address
           SET is_primary = false,
               updated_at = pg_catalog.clock_timestamp()
         WHERE address.tenant_id = NEW.tenant_id
           AND address.subscriber_id = NEW.id
           AND address.is_primary
           AND address.id <> target_id;
        UPDATE public.subscriber_emails AS address
           SET is_primary = true,
               updated_at = pg_catalog.clock_timestamp()
         WHERE address.tenant_id = NEW.tenant_id
           AND address.subscriber_id = NEW.id
           AND address.id = target_id
           AND NOT address.is_primary;
        RETURN NULL;
    END IF;

    IF purpose_granted AND
       public.subscriber_email_latest_decision(
           NEW.tenant_id, NEW.id, NULL, canonical_email
       ) = 'granted' THEN
        target_status := 'subscribed';
    END IF;

    IF TG_OP = 'UPDATE' THEN
        SELECT address.id
          INTO replacement_id
          FROM public.subscriber_emails AS address
         WHERE address.tenant_id = NEW.tenant_id
           AND address.subscriber_id = NEW.id
           AND public.subscriber_email_consent_normalize_email(
                   address.email::text
               ) = public.subscriber_email_consent_normalize_email(
                   OLD.email::text
               )
         ORDER BY address.id
         LIMIT 1;
    END IF;
    IF replacement_id IS NULL THEN
        SELECT address.id
          INTO replacement_id
          FROM public.subscriber_emails AS address
         WHERE address.tenant_id = NEW.tenant_id
           AND address.subscriber_id = NEW.id
           AND address.is_primary
         ORDER BY address.created_at, address.id
         LIMIT 1;
    END IF;

    UPDATE public.subscriber_emails AS address
       SET is_primary = false,
           updated_at = pg_catalog.clock_timestamp()
     WHERE address.tenant_id = NEW.tenant_id
       AND address.subscriber_id = NEW.id
       AND address.is_primary
       AND (replacement_id IS NULL OR address.id <> replacement_id);

    IF replacement_id IS NOT NULL THEN
        UPDATE public.subscriber_emails AS address
           SET email = canonical_email,
               is_primary = true,
               consent_status = target_status,
               suppressed = false,
               last_engaged_at = NULL,
               updated_at = pg_catalog.clock_timestamp()
         WHERE address.tenant_id = NEW.tenant_id
           AND address.subscriber_id = NEW.id
           AND address.id = replacement_id;
        RETURN NULL;
    END IF;

    SELECT pg_catalog.count(*)::integer
      INTO sibling_count
      FROM public.subscriber_emails AS address
     WHERE address.tenant_id = NEW.tenant_id
       AND address.subscriber_id = NEW.id;
    IF sibling_count >= 5 THEN
        RAISE EXCEPTION 'subscriber email address limit reached during identity reconciliation'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'subscriber_emails_max_five';
    END IF;

    INSERT INTO public.subscriber_emails (
        tenant_id, subscriber_id, email, is_primary, consent_status
    ) VALUES (
        NEW.tenant_id, NEW.id, canonical_email, true, target_status
    );
    RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS subscribers_reconcile_email_identity
    ON public.subscribers;
CREATE CONSTRAINT TRIGGER subscribers_reconcile_email_identity
    AFTER INSERT OR UPDATE OF email
    ON public.subscribers
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION public.subscriber_email_consent_reconcile_identity();

REVOKE ALL ON FUNCTION public.subscriber_email_consent_reconcile_identity()
    FROM PUBLIC, postwave_app;
REVOKE ALL ON FUNCTION public.reconcile_subscriber_email_identity()
    FROM PUBLIC, postwave_app;

CREATE OR REPLACE FUNCTION public.subscriber_email_consent_bump_generation(
    p_tenant_id uuid,
    p_email text,
    p_source_table text,
    p_source_id text,
    p_recorded_at timestamptz DEFAULT clock_timestamp()
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    normalized text;
    next_generation bigint;
BEGIN
    normalized := public.subscriber_email_consent_normalize_email(p_email);
    PERFORM public.subscriber_email_consent_lock_one(p_tenant_id, normalized);
    BEGIN
        INSERT INTO public.subscriber_email_consent_address_state AS state (
            tenant_id, normalized_email, generation, etag,
            last_source_table, last_source_id, last_recorded_at, updated_at
        ) VALUES (
            p_tenant_id,
            normalized,
            1,
            pg_catalog.encode(public.digest(
                p_tenant_id::text || ':' || normalized || ':1', 'sha256'
            ), 'hex'),
            p_source_table,
            p_source_id,
            COALESCE(p_recorded_at, pg_catalog.clock_timestamp()),
            pg_catalog.clock_timestamp()
        )
        ON CONFLICT (tenant_id, normalized_email) DO UPDATE
           SET generation = state.generation + 1,
               etag = pg_catalog.encode(public.digest(
                   p_tenant_id::text || ':' || normalized || ':' ||
                   (state.generation + 1)::text,
                   'sha256'
               ), 'hex'),
               last_source_table = EXCLUDED.last_source_table,
               last_source_id = EXCLUDED.last_source_id,
               last_recorded_at = EXCLUDED.last_recorded_at,
               updated_at = pg_catalog.clock_timestamp()
        RETURNING generation INTO next_generation;
    EXCEPTION
        WHEN foreign_key_violation THEN
            -- A tenant erasure cascades through every guarded child table.
            -- Those AFTER DELETE triggers must not recreate derived address
            -- state while the parent tenant is being removed.  This table's
            -- only foreign key is tenant_id, so the safe terminal action is to
            -- leave no generation row for the deleted tenant.
            RETURN 0;
    END;
    RETURN next_generation;
END;
$function$;

REVOKE ALL ON FUNCTION public.subscriber_email_consent_bump_generation(
    uuid, text, text, text, timestamptz
) FROM PUBLIC, postwave_app;

-- Regular grants must be a paired event + proof record.  The pair is bound by
-- immutable UUID, exact address/subscriber/email, policy, occurrence time, and
-- duplicated structured fields.  The CASE is intentionally source-specific;
-- an API/admin label cannot impersonate double opt-in or a signed form.
-- Import grants use the stronger 1761 approval/row-receipt chain instead.
CREATE OR REPLACE FUNCTION public.subscriber_email_consent_record_proof_valid(
    p_record_id uuid,
    p_address_id uuid,
    p_as_of timestamptz DEFAULT clock_timestamp()
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $function$
    SELECT COALESCE(
        EXISTS (
            SELECT 1
              FROM public.consent_records AS record
              JOIN public.subscriber_emails AS address
                ON address.id = p_address_id
               AND address.tenant_id = record.tenant_id
               AND address.subscriber_id = record.subscriber_id
               AND public.subscriber_email_consent_normalize_email(
                       address.email::text
                   ) = public.subscriber_email_consent_normalize_email(
                       record.email::text
                   )
              JOIN public.consent_events AS event
                ON event.id::text = record.evidence ->> 'event_id'
               AND event.tenant_id = record.tenant_id
               AND event.subject_type = 'subscriber'
               AND event.subject_id = address.id::text
               AND event.category = 'email_marketing'
               AND event.action = 'granted'
               AND public.subscriber_email_consent_normalize_email(
                       event.subject_email::text
                   ) = public.subscriber_email_consent_normalize_email(
                       address.email::text
                   )
             WHERE record.id = p_record_id
               AND record.channel = 'email'
               AND record.consent_status = 'granted'
               AND pg_catalog.jsonb_typeof(record.evidence) = 'object'
               AND record.evidence ->> 'address_id' = address.id::text
               AND event.preferences ->> 'legal_basis' = 'consent'
               AND record.evidence ->> 'legal_basis' = 'consent'
               AND pg_catalog.btrim(COALESCE(
                       event.preferences ->> 'jurisdiction', ''
                   )) <> ''
               AND record.evidence ->> 'jurisdiction' =
                   event.preferences ->> 'jurisdiction'
               AND pg_catalog.btrim(COALESCE(
                       event.preferences ->> 'reason', ''
                   )) <> ''
               AND record.evidence ->> 'reason' =
                   event.preferences ->> 'reason'
               AND pg_catalog.btrim(event.policy_version) <> ''
               AND record.evidence ->> 'policy_version' =
                   event.policy_version
               AND pg_catalog.btrim(COALESCE(event.proof_text, '')) <> ''
               AND pg_catalog.char_length(event.proof_text) <= 2048
               AND record.evidence ->> 'evidence' = event.proof_text
               AND record.captured_at = event.created_at
               AND record.captured_at <= p_as_of + interval '5 minutes'
               AND COALESCE(record.recorded_at, record.created_at) <=
                   p_as_of + interval '5 minutes'
               AND COALESCE(event.recorded_at, event.created_at) <=
                   p_as_of + interval '5 minutes'
               AND (record.expires_at IS NULL OR record.expires_at > p_as_of)
               AND CASE event.source
                       WHEN 'double_optin' THEN
                           record.source = 'double_optin' AND
                           event.channel IN ('email', 'web', 'api')
                       WHEN 'single_optin' THEN
                           record.source = 'single_optin' AND
                           event.channel IN ('email', 'web', 'api')
                       WHEN 'signed_form' THEN
                           record.source = 'form' AND
                           event.channel IN ('web', 'import', 'api')
                       WHEN 'preference_center' THEN
                           record.source = 'preference_center' AND
                           event.channel IN ('web', 'email', 'api')
                       WHEN 'direct_request' THEN
                           record.source = 'admin' AND
                           event.channel IN ('desktop', 'api', 'email')
                       ELSE false
                   END
        ) OR EXISTS (
            SELECT 1
              FROM public.consent_records AS record
              JOIN public.subscriber_emails AS address
                ON address.id = p_address_id
               AND address.tenant_id = record.tenant_id
               AND address.subscriber_id = record.subscriber_id
               AND public.subscriber_email_consent_normalize_email(
                       address.email::text
                   ) = public.subscriber_email_consent_normalize_email(
                       record.email::text
                   )
              JOIN public.subscriber_import_consent_receipts AS receipt
                ON receipt.tenant_id = record.tenant_id
               AND receipt.subscriber_id = record.subscriber_id
               AND receipt.consent_record_id = record.id
              JOIN public.subscriber_import_consent_approvals AS approval
                ON approval.tenant_id = receipt.tenant_id
               AND approval.id = receipt.approval_id
               AND approval.import_id = receipt.import_id
             WHERE record.id = p_record_id
               AND record.channel = 'email'
               AND record.consent_status = 'granted'
               AND pg_catalog.jsonb_typeof(record.evidence) = 'object'
               AND record.evidence ->> 'import_id' = receipt.import_id::text
               AND record.evidence ->> 'approval_id' = receipt.approval_id::text
               AND record.evidence ->> 'source_row_fingerprint' =
                   receipt.source_row_fingerprint
               AND record.evidence ->> 'evidence_fingerprint' =
                   receipt.evidence_fingerprint
               AND receipt.source_file_fingerprint =
                   approval.source_file_fingerprint
               AND record.captured_at = approval.captured_at
               AND record.source = CASE approval.consent_source
                       WHEN 'signed_form' THEN 'form'
                       WHEN 'direct_request' THEN 'admin'
                       ELSE approval.consent_source
                   END
               AND approval.scope = 'email_marketing'
               AND approval.contract_version = 'subscriber-import-consent/v1'
               AND approval.legal_basis = 'consent'
               AND pg_catalog.btrim(approval.policy_version) <> ''
               AND pg_catalog.btrim(approval.evidence_reference) <> ''
               AND approval.captured_at <= p_as_of + interval '5 minutes'
               AND approval.approved_at <= p_as_of + interval '5 minutes'
               AND receipt.applied_at <= p_as_of + interval '5 minutes'
               AND COALESCE(record.recorded_at, record.created_at) <=
                   p_as_of + interval '5 minutes'
               AND (record.expires_at IS NULL OR record.expires_at > p_as_of)
        ),
        false
    )
$function$;

REVOKE ALL ON FUNCTION public.subscriber_email_consent_record_proof_valid(
    uuid, uuid, timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.subscriber_email_consent_record_proof_valid(
    uuid, uuid, timestamptz
) TO postwave_app;

-- Jurisdiction re-confirmation predates the per-address consent_records writer,
-- but it already commits an immutable consent event and a durable legal
-- receipt in the same transaction.  Accept that source only through its own
-- exact receipt chain; a source label, event JSON, or receipt by itself is not
-- enough.  Relational joins bind tenant, subscriber, canonical address, email,
-- event, receipt, policy, occurrence time, decision, regime, and captured copy.
CREATE OR REPLACE FUNCTION public.subscriber_email_consent_jurisdiction_proof_valid(
    p_event_id uuid,
    p_address_id uuid,
    p_as_of timestamptz DEFAULT clock_timestamp()
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $function$
    SELECT COALESCE(EXISTS (
        SELECT 1
          FROM public.consent_events AS event
          JOIN public.subscriber_emails AS address
            ON address.id = p_address_id
           AND address.tenant_id = event.tenant_id
           AND address.subscriber_id::text = event.subject_id
           AND public.subscriber_email_consent_normalize_email(
                   address.email::text
               ) = public.subscriber_email_consent_normalize_email(
                   event.subject_email::text
               )
          JOIN public.consent_receipts AS receipt
            ON receipt.tenant_id = event.tenant_id
           AND receipt.subscriber_id = address.subscriber_id
           AND receipt.id::text = event.preferences ->> 'consent_receipt_id'
           AND public.subscriber_email_consent_normalize_email(
                   receipt.subscriber_email
               ) = public.subscriber_email_consent_normalize_email(
                   address.email::text
               )
         WHERE event.id = p_event_id
           AND event.subject_type = 'subscriber'
           AND event.category = 'email_marketing'
           AND event.action = 'granted'
           AND event.source = 'jurisdiction_reconfirm'
           AND event.channel = 'api'
           AND event.preferences ->> 'operation' =
               'jurisdiction_reconfirmation'
           AND event.preferences ->> 'decision' = 'accepted'
           AND pg_catalog.btrim(COALESCE(
                   event.preferences ->> 'regime', ''
               )) <> ''
           AND pg_catalog.btrim(COALESCE(
                   event.preferences ->> 'detected_jurisdiction', ''
               )) <> ''
           AND pg_catalog.btrim(COALESCE(
                   event.preferences ->> 'jurisdiction_changed_at', ''
               )) <> ''
           AND receipt.source = 'jurisdiction_reconfirm'
           AND receipt.new_state = 'subscribed'
           AND receipt.at = event.created_at
           AND pg_catalog.btrim(COALESCE(
                   receipt.privacy_policy_version, ''
               )) <> ''
           AND receipt.privacy_policy_version = event.policy_version
           AND pg_catalog.btrim(COALESCE(receipt.captured_text, '')) <> ''
           AND pg_catalog.char_length(receipt.captured_text) <= 16384
           AND receipt.captured_text = event.proof_text
           AND receipt.source_detail IS NOT NULL
           AND receipt.source_detail::jsonb ->> 'decision' = 'accepted'
           AND receipt.source_detail::jsonb ->> 'regime' =
               event.preferences ->> 'regime'
           AND receipt.at <= p_as_of + interval '5 minutes'
           AND COALESCE(event.recorded_at, event.created_at) <=
               p_as_of + interval '5 minutes'
    ), false)
$function$;

REVOKE ALL ON FUNCTION public.subscriber_email_consent_jurisdiction_proof_valid(
    uuid, uuid, timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.subscriber_email_consent_jurisdiction_proof_valid(
    uuid, uuid, timestamptz
) TO postwave_app;

CREATE OR REPLACE FUNCTION public.subscriber_email_latest_decision_detail(
    p_tenant_id uuid,
    p_subscriber_id uuid,
    p_address_id uuid,
    p_email text,
    p_as_of timestamptz DEFAULT clock_timestamp()
)
RETURNS TABLE (
    decision text,
    occurred_at timestamptz,
    recorded_at timestamptz,
    decision_id text,
    policy_version text,
    proof_expires_at timestamptz,
    evidence_checksum text
)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $function$
    WITH record_candidates AS (
        SELECT CASE
                   WHEN record.consent_status = 'granted' AND
                        public.subscriber_email_consent_record_proof_valid(
                            record.id, p_address_id, p_as_of
                        ) THEN 'granted'
                   WHEN record.consent_status = 'granted' THEN 'invalid_grant'
                   WHEN record.consent_status = 'withdrawn' THEN 'revoked'
                   ELSE record.consent_status
               END AS decision,
               record.captured_at AS occurred_at,
               COALESCE(record.recorded_at, record.created_at) AS recorded_at,
               'consent_records:' || record.id::text AS decision_id,
               COALESCE(
                   record.evidence ->> 'policy_version',
                   approval.policy_version,
                   ''
               ) AS policy_version,
               record.expires_at AS proof_expires_at,
               pg_catalog.encode(public.digest(
                   pg_catalog.concat_ws(
                       ':',
                       'subscriber-email-consent-decision/v2',
                       record.tenant_id::text,
                       record.subscriber_id::text,
                       p_address_id::text,
                       public.subscriber_email_consent_normalize_email(
                           record.email::text
                       ),
                       record.id::text,
                       record.consent_status,
                       COALESCE(
                           record.evidence ->> 'policy_version',
                           approval.policy_version,
                           ''
                       ),
                       record.captured_at::text,
                       COALESCE(record.recorded_at, record.created_at)::text
                   ),
                   'sha256'
               ), 'hex') AS evidence_checksum
          FROM public.consent_records AS record
          LEFT JOIN public.subscriber_import_consent_receipts AS receipt
            ON receipt.tenant_id = record.tenant_id
           AND receipt.consent_record_id = record.id
           AND receipt.subscriber_id = record.subscriber_id
          LEFT JOIN public.subscriber_import_consent_approvals AS approval
            ON approval.tenant_id = receipt.tenant_id
           AND approval.id = receipt.approval_id
         WHERE record.tenant_id = p_tenant_id
           AND record.subscriber_id = p_subscriber_id
           AND record.channel = 'email'
           AND public.subscriber_email_consent_normalize_email(
                   record.email::text
               ) = public.subscriber_email_consent_normalize_email(p_email)
    ),
    event_candidates AS (
        SELECT CASE
                   WHEN event.action = 'granted' AND
                        public.subscriber_email_consent_jurisdiction_proof_valid(
                            event.id, p_address_id, p_as_of
                        ) THEN 'granted'
                   WHEN event.action IN ('granted', 'imported')
                       THEN 'invalid_grant'
                   WHEN event.action IN ('revoked', 'opted_out')
                       THEN 'revoked'
                   ELSE event.action
               END AS decision,
               event.created_at AS occurred_at,
               COALESCE(event.recorded_at, event.created_at) AS recorded_at,
               'consent_events:' || event.id::text AS decision_id,
               event.policy_version,
               NULL::timestamptz AS proof_expires_at,
               pg_catalog.encode(public.digest(
                   pg_catalog.concat_ws(
                       ':',
                       'subscriber-email-consent-decision/v2',
                       event.tenant_id::text,
                       p_subscriber_id::text,
                       p_address_id::text,
                       public.subscriber_email_consent_normalize_email(
                           event.subject_email::text
                       ),
                       event.id::text,
                       event.action,
                       event.policy_version,
                       event.created_at::text,
                       COALESCE(event.recorded_at, event.created_at)::text
                   ),
                   'sha256'
               ), 'hex') AS evidence_checksum
          FROM public.consent_events AS event
         WHERE event.tenant_id = p_tenant_id
           AND event.subject_type = 'subscriber'
           AND event.category IN ('email_marketing', 'marketing')
           AND public.subscriber_email_consent_normalize_email(
                   event.subject_email::text
               ) = public.subscriber_email_consent_normalize_email(p_email)
           AND event.subject_id IN (
                   p_subscriber_id::text,
                   COALESCE(p_address_id::text, '')
               )
           -- A normal proven grant is represented once, by its paired record.
           -- Jurisdiction re-confirmation is the sole source-specific event
           -- candidate accepted directly, and only through the exact legal
           -- receipt validator above.  Every other event-only grant remains
           -- invalid and fails closed instead of exposing an older grant.
           AND NOT (
               event.action = 'granted' AND EXISTS (
                   SELECT 1
                     FROM public.consent_records AS paired
                    WHERE paired.tenant_id = event.tenant_id
                      AND paired.subscriber_id = p_subscriber_id
                      AND paired.channel = 'email'
                      AND paired.consent_status = 'granted'
                      AND paired.evidence ->> 'event_id' = event.id::text
                      AND public.subscriber_email_consent_normalize_email(
                              paired.email::text
                          ) = public.subscriber_email_consent_normalize_email(
                              p_email
                          )
                      AND public.subscriber_email_consent_record_proof_valid(
                              paired.id, p_address_id, p_as_of
                          )
               )
           )
    ),
    candidates AS (
        SELECT * FROM record_candidates
        UNION ALL
        SELECT * FROM event_candidates
    ),
    eligible_candidates AS (
        SELECT candidate.*
          FROM candidates AS candidate
         WHERE candidate.decision <> 'granted'
            OR NOT EXISTS (
                SELECT 1
                  FROM candidates AS blocker
                 WHERE blocker.decision <> 'granted'
                   AND (
                       blocker.occurred_at >= candidate.occurred_at OR
                       blocker.recorded_at >= candidate.recorded_at
                   )
            )
    )
    SELECT eligible_candidates.decision,
           eligible_candidates.occurred_at,
           eligible_candidates.recorded_at,
           eligible_candidates.decision_id,
           eligible_candidates.policy_version,
           eligible_candidates.proof_expires_at,
           eligible_candidates.evidence_checksum
      FROM eligible_candidates
     -- Occurrence and immutable recording chronology form a conservative
     -- partial order.  A non-grant blocks a grant when it is later in either
     -- chronology.  A grant can supersede that terminal decision only when it
     -- is genuinely later in both, preventing both backdated re-grants and
     -- late-arriving backdated opt-outs from producing a sendable ambiguity.
     ORDER BY eligible_candidates.occurred_at DESC,
              CASE WHEN eligible_candidates.decision = 'granted' THEN 1 ELSE 0 END,
              eligible_candidates.recorded_at DESC,
              eligible_candidates.decision_id DESC
     LIMIT 1
$function$;

REVOKE ALL ON FUNCTION public.subscriber_email_latest_decision_detail(
    uuid, uuid, uuid, text, timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.subscriber_email_latest_decision_detail(
    uuid, uuid, uuid, text, timestamptz
) TO postwave_app;

-- Replace 1765's weak scalar fold without changing its public signature.
CREATE OR REPLACE FUNCTION public.subscriber_email_latest_decision(
    p_tenant_id uuid,
    p_subscriber_id uuid,
    p_address_id uuid,
    p_email text
)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $function$
    SELECT detail.decision
      FROM public.subscriber_email_latest_decision_detail(
          p_tenant_id,
          p_subscriber_id,
          p_address_id,
          p_email,
          pg_catalog.clock_timestamp()
      ) AS detail
$function$;

REVOKE ALL ON FUNCTION public.subscriber_email_latest_decision(
    uuid, uuid, uuid, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.subscriber_email_latest_decision(
    uuid, uuid, uuid, text
) TO postwave_app;

CREATE OR REPLACE FUNCTION public.refresh_subscriber_email_consent_projection(
    p_tenant_id uuid,
    p_subscriber_id uuid,
    p_email text,
    p_recorded_at timestamptz DEFAULT clock_timestamp()
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    address_row record;
    terminal record;
    normalized text;
    projected_status text;
    projected_state text;
    projected_checksum text;
    projected_generation bigint;
BEGIN
    normalized := public.subscriber_email_consent_normalize_email(p_email);
    PERFORM public.subscriber_email_consent_lock_one(p_tenant_id, normalized);

    SELECT address.id,
           address.consent_status,
           address.consent_reconciliation_generation
      INTO address_row
      FROM public.subscriber_emails AS address
     WHERE address.tenant_id = p_tenant_id
       AND address.subscriber_id = p_subscriber_id
       AND public.subscriber_email_consent_normalize_email(
               address.email::text
           ) = normalized
     FOR UPDATE;

    IF NOT FOUND THEN
        RETURN 'missing_address';
    END IF;

    SELECT * INTO terminal
      FROM public.subscriber_email_latest_decision_detail(
          p_tenant_id,
          p_subscriber_id,
          address_row.id,
          normalized,
          pg_catalog.clock_timestamp()
      );

    IF terminal.decision = 'granted' THEN
        projected_status := 'subscribed';
        projected_state := 'proven';
    ELSIF terminal.decision = 'pending' THEN
        projected_status := 'pending';
        projected_state := 'failed_closed';
    ELSIF terminal.decision IN (
        'revoked', 'denied', 'withdrawn', 'opted_out', 'expired'
    ) THEN
        projected_status := 'unsubscribed';
        projected_state := 'failed_closed';
    ELSE
        projected_status := CASE
            WHEN address_row.consent_status IN (
                'unsubscribed', 'pending', 'never_subscribed'
            ) THEN address_row.consent_status
            ELSE 'never_subscribed'
        END;
        projected_state := 'failed_closed';
    END IF;

    projected_generation := address_row.consent_reconciliation_generation + 1;
    projected_checksum := COALESCE(
        terminal.evidence_checksum,
        pg_catalog.encode(public.digest(
            pg_catalog.concat_ws(
                ':',
                'subscriber-email-consent-decision/v2',
                p_tenant_id::text,
                p_subscriber_id::text,
                address_row.id::text,
                normalized,
                'no_valid_terminal_decision',
                projected_generation::text
            ),
            'sha256'
        ), 'hex')
    );

    UPDATE public.subscriber_emails
       SET consent_status = projected_status,
           consent_reconciliation_state = projected_state,
           consent_reconciliation_generation = projected_generation,
           consent_decision_checksum = projected_checksum,
           consent_classified_at = pg_catalog.clock_timestamp(),
           consent_terminal_occurred_at = terminal.occurred_at,
           consent_terminal_recorded_at = terminal.recorded_at,
           consent_proof_expires_at = terminal.proof_expires_at,
           updated_at = pg_catalog.clock_timestamp()
     WHERE tenant_id = p_tenant_id
       AND id = address_row.id;

    -- The canonical raw purpose projection is never trusted independently.
    -- It is folded from the exact address terminal state in the same lock.
    UPDATE public.subscribers AS subscriber
       SET consent_email_marketing_at = CASE
               WHEN terminal.decision = 'granted'
                   THEN terminal.occurred_at
               ELSE NULL
           END,
           updated_at = pg_catalog.clock_timestamp()
     WHERE subscriber.tenant_id = p_tenant_id
       AND subscriber.id = p_subscriber_id
       AND public.subscriber_email_consent_normalize_email(
               subscriber.email::text
           ) = normalized
       AND subscriber.consent_email_marketing_at IS DISTINCT FROM CASE
               WHEN terminal.decision = 'granted'
                   THEN terminal.occurred_at
               ELSE NULL
           END;

    UPDATE public.subscriber_channel_consents AS channel_state
       SET status = CASE
               WHEN terminal.decision = 'granted' THEN 'opted_in'
               WHEN terminal.decision IN (
                   'revoked', 'denied', 'withdrawn', 'opted_out', 'expired'
               ) THEN 'opted_out'
               ELSE 'unknown'
           END,
           consent_timestamp = terminal.occurred_at,
           consent_source = 'subscriber_email_terminal_v2',
           updated_at = pg_catalog.clock_timestamp()
     WHERE channel_state.tenant_id = p_tenant_id
       AND channel_state.subscriber_id = p_subscriber_id
       AND channel_state.channel = 'email'
       -- subscriber_channel_consents is profile-wide and keyed to the
       -- subscriber's canonical email, not to each secondary address.  A
       -- secondary-address decision must not opt the primary channel in or
       -- out; its exact state remains on subscriber_emails.
       AND EXISTS (
           SELECT 1
             FROM public.subscribers AS subscriber
            WHERE subscriber.tenant_id = p_tenant_id
              AND subscriber.id = p_subscriber_id
              AND public.subscriber_email_consent_normalize_email(
                      subscriber.email::text
                  ) = normalized
       )
       AND (
           channel_state.status,
           channel_state.consent_timestamp,
           channel_state.consent_source
       ) IS DISTINCT FROM (
           CASE
               WHEN terminal.decision = 'granted' THEN 'opted_in'
               WHEN terminal.decision IN (
                   'revoked', 'denied', 'withdrawn', 'opted_out', 'expired'
               ) THEN 'opted_out'
               ELSE 'unknown'
           END,
           terminal.occurred_at,
           'subscriber_email_terminal_v2'::text
       );

    PERFORM public.subscriber_email_consent_bump_generation(
        p_tenant_id,
        normalized,
        'terminal_projection',
        terminal.decision_id,
        COALESCE(terminal.recorded_at, p_recorded_at)
    );
    RETURN projected_state;
END;
$function$;

REVOKE ALL ON FUNCTION public.refresh_subscriber_email_consent_projection(
    uuid, uuid, text, timestamptz
) FROM PUBLIC, postwave_app;

-- Keep the non-email purpose behavior from migration 0318, but make email
-- marketing use the exact terminal projection.  The existing trigger keeps
-- calling this same function name.
CREATE OR REPLACE FUNCTION public.consent_events_project_to_subscribers()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    column_name text;
    stamp_value timestamptz;
    sub_uuid uuid;
    target record;
BEGIN
    IF NEW.category IN ('email_marketing', 'marketing') THEN
        FOR target IN
            SELECT subscriber.id, address.email::text
              FROM public.subscribers AS subscriber
              JOIN public.subscriber_emails AS address
                ON address.tenant_id = subscriber.tenant_id
               AND address.subscriber_id = subscriber.id
               AND public.subscriber_email_consent_normalize_email(
                       address.email::text
                   ) = public.subscriber_email_consent_normalize_email(
                       NEW.subject_email::text
                   )
             WHERE subscriber.tenant_id = NEW.tenant_id
               AND (
                   subscriber.id::text = NEW.subject_id OR
                   address.id::text = NEW.subject_id
               )
             ORDER BY subscriber.id
        LOOP
            PERFORM public.refresh_subscriber_email_consent_projection(
                NEW.tenant_id,
                target.id,
                target.email,
                COALESCE(NEW.recorded_at, pg_catalog.clock_timestamp())
            );
        END LOOP;
        RETURN NEW;
    END IF;

    column_name := CASE NEW.category
        WHEN 'analytics' THEN 'consent_profiling_at'
        WHEN 'sale_share' THEN 'consent_targeted_ads_at'
        WHEN 'targeted_advertising' THEN 'consent_targeted_ads_at'
        WHEN 'ai_processing' THEN 'consent_ai_processing_at'
        ELSE NULL
    END;
    IF column_name IS NULL THEN
        RETURN NEW;
    END IF;
    stamp_value := CASE
        WHEN NEW.action = 'granted' THEN NEW.created_at
        ELSE NULL
    END;
    BEGIN
        sub_uuid := NEW.subject_id::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
        sub_uuid := NULL;
    END;
    IF sub_uuid IS NOT NULL THEN
        EXECUTE pg_catalog.format(
            'UPDATE public.subscribers SET %I = $1, updated_at = clock_timestamp() WHERE tenant_id = $2 AND id = $3',
            column_name
        ) USING stamp_value, NEW.tenant_id, sub_uuid;
    END IF;
    IF NEW.subject_email IS NOT NULL THEN
        EXECUTE pg_catalog.format(
            'UPDATE public.subscribers SET %I = $1, updated_at = clock_timestamp() WHERE tenant_id = $2 AND lower(email::text) = lower($3)',
            column_name
        ) USING stamp_value, NEW.tenant_id, NEW.subject_email::text;
    END IF;
    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.consent_events_project_to_subscribers()
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consent_events_project_to_subscribers()
    TO postwave_app;

-- Reassert the pre-existing 0318 projection hook because replacing its
-- function is insufficient on a drifted database where the trigger was
-- disabled or dropped.  Event-only terminal revocations depend on this exact
-- AFTER INSERT row hook.
DROP TRIGGER IF EXISTS consent_events_project_vector
    ON public.consent_events;
CREATE TRIGGER consent_events_project_vector
    AFTER INSERT ON public.consent_events
    FOR EACH ROW EXECUTE FUNCTION public.consent_events_project_to_subscribers();

CREATE OR REPLACE FUNCTION public.subscriber_email_consent_stamp_chronology()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- The database clock, not a caller-supplied value, is the recording
        -- chronology.  Occurrence remains in created_at/captured_at.
        NEW.recorded_at := pg_catalog.clock_timestamp();
        RETURN NEW;
    END IF;
    IF TG_TABLE_NAME = 'consent_events' AND (
        NEW.id IS DISTINCT FROM OLD.id OR
        NEW.recorded_at IS DISTINCT FROM OLD.recorded_at OR
        NEW.created_at IS DISTINCT FROM OLD.created_at OR
        NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR
        NEW.subject_type IS DISTINCT FROM OLD.subject_type OR
        NEW.subject_id IS DISTINCT FROM OLD.subject_id OR
        NEW.subject_email IS DISTINCT FROM OLD.subject_email OR
        NEW.channel IS DISTINCT FROM OLD.channel OR
        NEW.category IS DISTINCT FROM OLD.category OR
        NEW.action IS DISTINCT FROM OLD.action OR
        NEW.source IS DISTINCT FROM OLD.source OR
        NEW.policy_version IS DISTINCT FROM OLD.policy_version OR
        NEW.preferences IS DISTINCT FROM OLD.preferences OR
        NEW.proof_text IS DISTINCT FROM OLD.proof_text OR
        NEW.ip IS DISTINCT FROM OLD.ip OR
        NEW.user_agent IS DISTINCT FROM OLD.user_agent
    ) THEN
        RAISE EXCEPTION 'consent event terminal chronology and evidence are immutable'
            USING ERRCODE = '23514';
    ELSIF TG_TABLE_NAME = 'consent_records' AND (
        NEW.id IS DISTINCT FROM OLD.id OR
        NEW.recorded_at IS DISTINCT FROM OLD.recorded_at OR
        NEW.created_at IS DISTINCT FROM OLD.created_at OR
        NEW.captured_at IS DISTINCT FROM OLD.captured_at OR
        NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR
        NEW.subscriber_id IS DISTINCT FROM OLD.subscriber_id OR
        NEW.email IS DISTINCT FROM OLD.email OR
        NEW.channel IS DISTINCT FROM OLD.channel OR
        NEW.consent_status IS DISTINCT FROM OLD.consent_status OR
        NEW.source IS DISTINCT FROM OLD.source OR
        NEW.source_url IS DISTINCT FROM OLD.source_url OR
        NEW.form_id IS DISTINCT FROM OLD.form_id OR
        NEW.ip_addr IS DISTINCT FROM OLD.ip_addr OR
        NEW.user_agent IS DISTINCT FROM OLD.user_agent OR
        NEW.expires_at IS DISTINCT FROM OLD.expires_at OR
        NEW.evidence IS DISTINCT FROM OLD.evidence
    ) THEN
        RAISE EXCEPTION 'consent record terminal chronology and evidence are immutable'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.subscriber_email_consent_stamp_chronology()
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.subscriber_email_consent_stamp_chronology()
    TO postwave_app;

CREATE OR REPLACE FUNCTION public.subscriber_email_consent_receipt_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
    IF (OLD.source = 'jurisdiction_reconfirm' OR
        NEW.source = 'jurisdiction_reconfirm') AND (
        NEW.id IS DISTINCT FROM OLD.id OR
        NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR
        NEW.subscriber_id IS DISTINCT FROM OLD.subscriber_id OR
        NEW.subscriber_email IS DISTINCT FROM OLD.subscriber_email OR
        NEW.prev_state IS DISTINCT FROM OLD.prev_state OR
        NEW.new_state IS DISTINCT FROM OLD.new_state OR
        NEW.source IS DISTINCT FROM OLD.source OR
        NEW.source_detail IS DISTINCT FROM OLD.source_detail OR
        NEW.ip IS DISTINCT FROM OLD.ip OR
        NEW.user_agent IS DISTINCT FROM OLD.user_agent OR
        NEW.privacy_policy_version IS DISTINCT FROM
            OLD.privacy_policy_version OR
        NEW.captured_text IS DISTINCT FROM OLD.captured_text OR
        NEW.at IS DISTINCT FROM OLD.at
    ) THEN
        RAISE EXCEPTION 'jurisdiction consent receipt evidence is immutable'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.subscriber_email_consent_receipt_immutable()
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.subscriber_email_consent_receipt_immutable()
    TO postwave_app;

CREATE OR REPLACE FUNCTION public.subscriber_email_consent_mutation_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    old_row jsonb;
    new_row jsonb;
    old_tenant uuid;
    new_tenant uuid;
    old_email text;
    new_email text;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        old_row := pg_catalog.to_jsonb(OLD);
        old_tenant := NULLIF(old_row ->> 'tenant_id', '')::uuid;
    END IF;
    IF TG_OP <> 'DELETE' THEN
        new_row := pg_catalog.to_jsonb(NEW);
        new_tenant := NULLIF(new_row ->> 'tenant_id', '')::uuid;
    END IF;

    IF TG_TABLE_NAME = 'consent_events' THEN
        old_email := old_row ->> 'subject_email';
        new_email := new_row ->> 'subject_email';
    ELSIF TG_TABLE_NAME = 'consent_receipts' THEN
        old_email := old_row ->> 'subscriber_email';
        new_email := new_row ->> 'subscriber_email';
    ELSIF TG_TABLE_NAME = 'consent_sync_ledger' THEN
        IF old_row IS NOT NULL THEN
            SELECT subscriber.email::text INTO old_email
              FROM public.subscribers AS subscriber
             WHERE subscriber.tenant_id = old_tenant
               AND subscriber.id = (old_row ->> 'subscriber_id')::uuid;
        END IF;
        IF new_row IS NOT NULL THEN
            SELECT subscriber.email::text INTO new_email
              FROM public.subscribers AS subscriber
             WHERE subscriber.tenant_id = new_tenant
               AND subscriber.id = (new_row ->> 'subscriber_id')::uuid;
        END IF;
    ELSIF TG_TABLE_NAME = 'subscriber_import_consent_receipts' THEN
        IF old_row IS NOT NULL THEN
            SELECT record.email::text INTO old_email
              FROM public.consent_records AS record
             WHERE record.tenant_id = old_tenant
               AND record.id = (old_row ->> 'consent_record_id')::uuid;
        END IF;
        IF new_row IS NOT NULL THEN
            SELECT record.email::text INTO new_email
              FROM public.consent_records AS record
             WHERE record.tenant_id = new_tenant
               AND record.id = (new_row ->> 'consent_record_id')::uuid;
        END IF;
    ELSIF TG_TABLE_NAME = 'subscriber_channel_consents' THEN
        -- email is a denormalized send-time field and can be stale.  The
        -- canonical exact-address mutex is always derived from the referenced
        -- subscriber for email-channel rows; arbitrary denormalized data must
        -- never redirect serialization to another address.
        IF old_row IS NOT NULL AND old_row ->> 'channel' = 'email' THEN
            SELECT subscriber.email::text INTO old_email
              FROM public.subscribers AS subscriber
             WHERE subscriber.tenant_id = old_tenant
               AND subscriber.id = (old_row ->> 'subscriber_id')::uuid;
            old_email := COALESCE(old_email, old_row ->> 'email');
        END IF;
        IF new_row IS NOT NULL AND new_row ->> 'channel' = 'email' THEN
            SELECT subscriber.email::text INTO new_email
              FROM public.subscribers AS subscriber
             WHERE subscriber.tenant_id = new_tenant
               AND subscriber.id = (new_row ->> 'subscriber_id')::uuid;
            new_email := COALESCE(new_email, new_row ->> 'email');
        END IF;
    ELSE
        old_email := old_row ->> 'email';
        new_email := new_row ->> 'email';
    END IF;

    IF old_email IS NOT NULL OR new_email IS NOT NULL THEN
        PERFORM public.subscriber_email_consent_lock_pair(
            old_tenant, old_email, new_tenant, new_email
        );
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

REVOKE ALL ON FUNCTION public.subscriber_email_consent_mutation_identity()
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.subscriber_email_consent_mutation_identity()
    TO postwave_app;

CREATE OR REPLACE FUNCTION public.subscriber_email_consent_generation_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    old_row jsonb;
    new_row jsonb;
    old_tenant uuid;
    new_tenant uuid;
    old_email text;
    new_email text;
    source_id text;
    recorded timestamptz := pg_catalog.clock_timestamp();
BEGIN
    IF TG_OP <> 'INSERT' THEN
        old_row := pg_catalog.to_jsonb(OLD);
        old_tenant := NULLIF(old_row ->> 'tenant_id', '')::uuid;
    END IF;
    IF TG_OP <> 'DELETE' THEN
        new_row := pg_catalog.to_jsonb(NEW);
        new_tenant := NULLIF(new_row ->> 'tenant_id', '')::uuid;
    END IF;
    source_id := COALESCE(new_row ->> 'id', old_row ->> 'id');
    recorded := COALESCE(
        NULLIF(new_row ->> 'recorded_at', '')::timestamptz,
        NULLIF(new_row ->> 'created_at', '')::timestamptz,
        NULLIF(new_row ->> 'updated_at', '')::timestamptz,
        pg_catalog.clock_timestamp()
    );

    IF TG_TABLE_NAME = 'consent_events' THEN
        old_email := old_row ->> 'subject_email';
        new_email := new_row ->> 'subject_email';
    ELSIF TG_TABLE_NAME = 'consent_receipts' THEN
        old_email := old_row ->> 'subscriber_email';
        new_email := new_row ->> 'subscriber_email';
    ELSIF TG_TABLE_NAME = 'consent_sync_ledger' THEN
        IF old_row IS NOT NULL THEN
            SELECT subscriber.email::text INTO old_email
              FROM public.subscribers AS subscriber
             WHERE subscriber.tenant_id = old_tenant
               AND subscriber.id = (old_row ->> 'subscriber_id')::uuid;
        END IF;
        IF new_row IS NOT NULL THEN
            SELECT subscriber.email::text INTO new_email
              FROM public.subscribers AS subscriber
             WHERE subscriber.tenant_id = new_tenant
               AND subscriber.id = (new_row ->> 'subscriber_id')::uuid;
        END IF;
    ELSIF TG_TABLE_NAME = 'subscriber_import_consent_receipts' THEN
        IF old_row IS NOT NULL THEN
            SELECT record.email::text INTO old_email
              FROM public.consent_records AS record
             WHERE record.tenant_id = old_tenant
               AND record.id = (old_row ->> 'consent_record_id')::uuid;
        END IF;
        IF new_row IS NOT NULL THEN
            SELECT record.email::text INTO new_email
              FROM public.consent_records AS record
             WHERE record.tenant_id = new_tenant
               AND record.id = (new_row ->> 'consent_record_id')::uuid;
        END IF;
    ELSIF TG_TABLE_NAME = 'subscriber_channel_consents' THEN
        IF old_row IS NOT NULL AND old_row ->> 'channel' = 'email' THEN
            SELECT subscriber.email::text INTO old_email
              FROM public.subscribers AS subscriber
             WHERE subscriber.tenant_id = old_tenant
               AND subscriber.id = (old_row ->> 'subscriber_id')::uuid;
            old_email := COALESCE(old_email, old_row ->> 'email');
        END IF;
        IF new_row IS NOT NULL AND new_row ->> 'channel' = 'email' THEN
            SELECT subscriber.email::text INTO new_email
              FROM public.subscribers AS subscriber
             WHERE subscriber.tenant_id = new_tenant
               AND subscriber.id = (new_row ->> 'subscriber_id')::uuid;
            new_email := COALESCE(new_email, new_row ->> 'email');
        END IF;
    ELSE
        old_email := old_row ->> 'email';
        new_email := new_row ->> 'email';
    END IF;

    IF old_email IS NOT NULL THEN
        PERFORM public.subscriber_email_consent_bump_generation(
            old_tenant, old_email, TG_TABLE_NAME, source_id, recorded
        );
    END IF;
    IF new_email IS NOT NULL AND (
        old_email IS NULL OR old_tenant IS DISTINCT FROM new_tenant OR
        public.subscriber_email_consent_normalize_email(old_email) IS DISTINCT FROM
        public.subscriber_email_consent_normalize_email(new_email)
    ) THEN
        PERFORM public.subscriber_email_consent_bump_generation(
            new_tenant, new_email, TG_TABLE_NAME, source_id, recorded
        );
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

REVOKE ALL ON FUNCTION public.subscriber_email_consent_generation_trigger()
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.subscriber_email_consent_generation_trigger()
    TO postwave_app;

CREATE OR REPLACE FUNCTION public.initialize_subscriber_email_consent_classification()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
    -- Existing rows received the metadata-only pending default and are consumed
    -- by the bounded reconciler.  A row created after this trigger lands is
    -- classified synchronously as non-sendable, so an already-open release
    -- gate can never accumulate fresh pending work.
    IF NEW.consent_reconciliation_state = 'pending' THEN
        NEW.consent_reconciliation_state := 'failed_closed';
        NEW.consent_reconciliation_generation := 1;
        NEW.consent_decision_checksum := pg_catalog.encode(public.digest(
            pg_catalog.concat_ws(
                ':',
                'subscriber-email-consent-decision/v2',
                NEW.tenant_id::text,
                NEW.subscriber_id::text,
                NEW.id::text,
                public.subscriber_email_consent_normalize_email(
                    NEW.email::text
                ),
                'new_address_without_terminal_grant'
            ),
            'sha256'
        ), 'hex');
        NEW.consent_classified_at := pg_catalog.clock_timestamp();
    END IF;
    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.initialize_subscriber_email_consent_classification()
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.initialize_subscriber_email_consent_classification()
    TO postwave_app;

CREATE OR REPLACE FUNCTION public.subscriber_email_consent_refresh_from_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    subscriber_id uuid;
    email_value text;
    record_id uuid;
BEGIN
    IF TG_TABLE_NAME = 'consent_records' THEN
        subscriber_id := NEW.subscriber_id;
        email_value := NEW.email::text;
    ELSIF TG_TABLE_NAME = 'consent_receipts' AND
          pg_catalog.to_jsonb(NEW) ->> 'source' =
              'jurisdiction_reconfirm' THEN
        subscriber_id := NEW.subscriber_id;
        email_value := NEW.subscriber_email;
    ELSIF TG_TABLE_NAME = 'subscriber_import_consent_receipts' THEN
        record_id := NEW.consent_record_id;
        SELECT record.subscriber_id, record.email::text
          INTO subscriber_id, email_value
          FROM public.consent_records AS record
         WHERE record.tenant_id = NEW.tenant_id
           AND record.id = record_id;
    END IF;
    IF subscriber_id IS NOT NULL AND email_value IS NOT NULL THEN
        PERFORM public.refresh_subscriber_email_consent_projection(
            NEW.tenant_id,
            subscriber_id,
            email_value,
            COALESCE(
                NULLIF(pg_catalog.to_jsonb(NEW) ->> 'recorded_at', '')::timestamptz,
                NULLIF(pg_catalog.to_jsonb(NEW) ->> 'applied_at', '')::timestamptz,
                pg_catalog.clock_timestamp()
            )
        );
    END IF;
    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.subscriber_email_consent_refresh_from_ledger()
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.subscriber_email_consent_refresh_from_ledger()
    TO postwave_app;

-- 1765's already-subscribed early return is deliberately gone.  Every positive
-- row is re-folded at COMMIT, including unrelated identity/status updates.
CREATE OR REPLACE FUNCTION public.require_subscriber_email_grant_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    address_row record;
    latest_action text;
BEGIN
    -- A deferred row trigger can execute once for an early INSERT image and
    -- again for later projection UPDATE images.  NEW is therefore not a safe
    -- representation of the final transaction state.  Re-read the canonical
    -- row by immutable id and validate that final state on every invocation.
    SELECT address.tenant_id,
           address.subscriber_id,
           address.id,
           address.email::text AS email,
           address.consent_status,
           address.consent_reconciliation_state,
           address.consent_decision_checksum
      INTO address_row
      FROM public.subscriber_emails AS address
     WHERE address.id = NEW.id;
    IF NOT FOUND OR address_row.consent_status <> 'subscribed' THEN
        RETURN NEW;
    END IF;
    latest_action := public.subscriber_email_latest_decision(
        address_row.tenant_id,
        address_row.subscriber_id,
        address_row.id,
        address_row.email
    );
    IF latest_action IS DISTINCT FROM 'granted' OR
       address_row.consent_reconciliation_state IS DISTINCT FROM 'proven' OR
       address_row.consent_decision_checksum IS NULL THEN
        RAISE EXCEPTION 'subscribed email address requires latest exact non-expired structured grant evidence'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'subscriber_emails_subscribed_requires_grant';
    END IF;
    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.require_subscriber_email_grant_evidence()
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.require_subscriber_email_grant_evidence()
    TO postwave_app;

DROP TRIGGER IF EXISTS subscriber_emails_require_grant
    ON public.subscriber_emails;
CREATE CONSTRAINT TRIGGER subscriber_emails_require_grant
    AFTER INSERT OR UPDATE OF consent_status, email, subscriber_id, tenant_id,
        consent_reconciliation_state, consent_decision_checksum
    ON public.subscriber_emails
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION public.require_subscriber_email_grant_evidence();

CREATE OR REPLACE FUNCTION public.require_subscriber_email_raw_projection_proof()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    subscriber_row record;
    address_row record;
BEGIN
    -- As above, judge the final row rather than a stale deferred-trigger NEW
    -- image produced before the exact record/event pair was complete.
    SELECT subscriber.tenant_id,
           subscriber.id,
           subscriber.email::text AS email,
           subscriber.consent_email_marketing_at
      INTO subscriber_row
      FROM public.subscribers AS subscriber
     WHERE subscriber.id = NEW.id;
    IF NOT FOUND OR subscriber_row.consent_email_marketing_at IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT address.id,
           address.consent_reconciliation_state,
           address.consent_decision_checksum
      INTO address_row
      FROM public.subscriber_emails AS address
     WHERE address.tenant_id = subscriber_row.tenant_id
       AND address.subscriber_id = subscriber_row.id
       AND public.subscriber_email_consent_normalize_email(
               address.email::text
           ) = public.subscriber_email_consent_normalize_email(
               subscriber_row.email
           )
     LIMIT 1;
    IF address_row.id IS NULL OR
       address_row.consent_reconciliation_state <> 'proven' OR
       address_row.consent_decision_checksum IS NULL OR
       public.subscriber_email_latest_decision(
           subscriber_row.tenant_id,
           subscriber_row.id,
           address_row.id,
           subscriber_row.email
       ) IS DISTINCT FROM 'granted' THEN
        RAISE EXCEPTION 'raw email-marketing purpose projection requires latest exact grant evidence'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'subscribers_email_purpose_requires_exact_grant';
    END IF;
    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.require_subscriber_channel_email_proof()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    channel_row record;
    subscriber_email text;
    address_row record;
BEGIN
    SELECT channel_state.tenant_id,
           channel_state.subscriber_id,
           channel_state.channel,
           channel_state.status
      INTO channel_row
      FROM public.subscriber_channel_consents AS channel_state
     WHERE channel_state.id = NEW.id;
    IF NOT FOUND OR channel_row.channel <> 'email' OR
       channel_row.status <> 'opted_in' THEN
        RETURN NEW;
    END IF;
    SELECT subscriber.email::text INTO subscriber_email
      FROM public.subscribers AS subscriber
     WHERE subscriber.tenant_id = channel_row.tenant_id
       AND subscriber.id = channel_row.subscriber_id;
    SELECT address.id, address.consent_reconciliation_state
      INTO address_row
      FROM public.subscriber_emails AS address
     WHERE address.tenant_id = channel_row.tenant_id
       AND address.subscriber_id = channel_row.subscriber_id
       AND public.subscriber_email_consent_normalize_email(
               address.email::text
           ) = public.subscriber_email_consent_normalize_email(
               subscriber_email
           );
    IF address_row.id IS NULL OR
       address_row.consent_reconciliation_state <> 'proven' OR
       public.subscriber_email_latest_decision(
           channel_row.tenant_id,
           channel_row.subscriber_id,
           address_row.id,
           subscriber_email
       ) IS DISTINCT FROM 'granted' THEN
        RAISE EXCEPTION 'email channel opted_in projection requires latest exact grant evidence'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'subscriber_channel_email_requires_exact_grant';
    END IF;
    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.require_subscriber_email_raw_projection_proof(),
    public.require_subscriber_channel_email_proof() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.require_subscriber_email_raw_projection_proof(),
    public.require_subscriber_channel_email_proof() TO postwave_app;

DROP TRIGGER IF EXISTS subscribers_require_email_purpose_proof
    ON public.subscribers;
CREATE CONSTRAINT TRIGGER subscribers_require_email_purpose_proof
    AFTER INSERT OR UPDATE OF tenant_id, id, email, status,
        consent_email_marketing_at
    ON public.subscribers
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION public.require_subscriber_email_raw_projection_proof();

DROP TRIGGER IF EXISTS subscriber_channel_consents_require_email_proof
    ON public.subscriber_channel_consents;
CREATE CONSTRAINT TRIGGER subscriber_channel_consents_require_email_proof
    AFTER INSERT OR UPDATE OF tenant_id, subscriber_id, channel, status, email
    ON public.subscriber_channel_consents
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION public.require_subscriber_channel_email_proof();

DROP TRIGGER IF EXISTS aa_1766_consent_events_exact_address_lock
    ON public.consent_events;
CREATE TRIGGER aa_1766_consent_events_exact_address_lock
    BEFORE INSERT OR UPDATE OR DELETE ON public.consent_events
    FOR EACH ROW EXECUTE FUNCTION public.subscriber_email_consent_mutation_identity();
DROP TRIGGER IF EXISTS ab_1766_consent_events_recorded_chronology
    ON public.consent_events;
CREATE TRIGGER ab_1766_consent_events_recorded_chronology
    BEFORE INSERT OR UPDATE ON public.consent_events
    FOR EACH ROW EXECUTE FUNCTION public.subscriber_email_consent_stamp_chronology();
DROP TRIGGER IF EXISTS zz_1766_consent_events_generation
    ON public.consent_events;
CREATE TRIGGER zz_1766_consent_events_generation
    AFTER INSERT OR UPDATE OR DELETE ON public.consent_events
    FOR EACH ROW EXECUTE FUNCTION public.subscriber_email_consent_generation_trigger();

DROP TRIGGER IF EXISTS aa_1766_consent_records_exact_address_lock
    ON public.consent_records;
CREATE TRIGGER aa_1766_consent_records_exact_address_lock
    BEFORE INSERT OR UPDATE OR DELETE ON public.consent_records
    FOR EACH ROW EXECUTE FUNCTION public.subscriber_email_consent_mutation_identity();
DROP TRIGGER IF EXISTS ab_1766_consent_records_recorded_chronology
    ON public.consent_records;
CREATE TRIGGER ab_1766_consent_records_recorded_chronology
    BEFORE INSERT OR UPDATE ON public.consent_records
    FOR EACH ROW EXECUTE FUNCTION public.subscriber_email_consent_stamp_chronology();
DROP TRIGGER IF EXISTS zy_1766_consent_records_refresh_projection
    ON public.consent_records;
CREATE TRIGGER zy_1766_consent_records_refresh_projection
    AFTER INSERT ON public.consent_records
    FOR EACH ROW EXECUTE FUNCTION public.subscriber_email_consent_refresh_from_ledger();
DROP TRIGGER IF EXISTS zz_1766_consent_records_generation
    ON public.consent_records;
CREATE TRIGGER zz_1766_consent_records_generation
    AFTER INSERT OR UPDATE OR DELETE ON public.consent_records
    FOR EACH ROW EXECUTE FUNCTION public.subscriber_email_consent_generation_trigger();

DROP TRIGGER IF EXISTS aa_1766_consent_receipts_exact_address_lock
    ON public.consent_receipts;
CREATE TRIGGER aa_1766_consent_receipts_exact_address_lock
    BEFORE INSERT OR UPDATE OR DELETE ON public.consent_receipts
    FOR EACH ROW EXECUTE FUNCTION public.subscriber_email_consent_mutation_identity();
DROP TRIGGER IF EXISTS ab_1766_consent_receipts_immutable
    ON public.consent_receipts;
CREATE TRIGGER ab_1766_consent_receipts_immutable
    BEFORE UPDATE ON public.consent_receipts
    FOR EACH ROW EXECUTE FUNCTION public.subscriber_email_consent_receipt_immutable();
DROP TRIGGER IF EXISTS zy_1766_consent_receipts_refresh_projection
    ON public.consent_receipts;
CREATE TRIGGER zy_1766_consent_receipts_refresh_projection
    AFTER INSERT ON public.consent_receipts
    FOR EACH ROW EXECUTE FUNCTION public.subscriber_email_consent_refresh_from_ledger();
DROP TRIGGER IF EXISTS zz_1766_consent_receipts_generation
    ON public.consent_receipts;
CREATE TRIGGER zz_1766_consent_receipts_generation
    AFTER INSERT OR UPDATE OR DELETE ON public.consent_receipts
    FOR EACH ROW EXECUTE FUNCTION public.subscriber_email_consent_generation_trigger();

DROP TRIGGER IF EXISTS aa_1766_import_receipts_exact_address_lock
    ON public.subscriber_import_consent_receipts;
CREATE TRIGGER aa_1766_import_receipts_exact_address_lock
    BEFORE INSERT OR UPDATE OR DELETE
    ON public.subscriber_import_consent_receipts
    FOR EACH ROW EXECUTE FUNCTION public.subscriber_email_consent_mutation_identity();
DROP TRIGGER IF EXISTS zy_1766_import_receipts_refresh_projection
    ON public.subscriber_import_consent_receipts;
CREATE TRIGGER zy_1766_import_receipts_refresh_projection
    AFTER INSERT ON public.subscriber_import_consent_receipts
    FOR EACH ROW EXECUTE FUNCTION public.subscriber_email_consent_refresh_from_ledger();
DROP TRIGGER IF EXISTS zz_1766_import_receipts_generation
    ON public.subscriber_import_consent_receipts;
CREATE TRIGGER zz_1766_import_receipts_generation
    AFTER INSERT OR UPDATE OR DELETE
    ON public.subscriber_import_consent_receipts
    FOR EACH ROW EXECUTE FUNCTION public.subscriber_email_consent_generation_trigger();

DROP TRIGGER IF EXISTS aa_1766_subscriber_emails_exact_address_lock
    ON public.subscriber_emails;
CREATE TRIGGER aa_1766_subscriber_emails_exact_address_lock
    BEFORE INSERT OR UPDATE OR DELETE ON public.subscriber_emails
    FOR EACH ROW EXECUTE FUNCTION public.subscriber_email_consent_mutation_identity();
DROP TRIGGER IF EXISTS ab_1766_subscriber_emails_initialize_classification
    ON public.subscriber_emails;
CREATE TRIGGER ab_1766_subscriber_emails_initialize_classification
    BEFORE INSERT ON public.subscriber_emails
    FOR EACH ROW EXECUTE FUNCTION public.initialize_subscriber_email_consent_classification();
DROP TRIGGER IF EXISTS zz_1766_subscriber_emails_generation
    ON public.subscriber_emails;
CREATE TRIGGER zz_1766_subscriber_emails_generation
    AFTER INSERT OR UPDATE OR DELETE ON public.subscriber_emails
    FOR EACH ROW EXECUTE FUNCTION public.subscriber_email_consent_generation_trigger();

DROP TRIGGER IF EXISTS aa_1766_subscribers_exact_address_lock
    ON public.subscribers;
CREATE TRIGGER aa_1766_subscribers_exact_address_lock
    BEFORE INSERT OR DELETE OR UPDATE OF email, status,
        consent_email_marketing_at ON public.subscribers
    FOR EACH ROW EXECUTE FUNCTION public.subscriber_email_consent_mutation_identity();
DROP TRIGGER IF EXISTS zz_1766_subscribers_generation
    ON public.subscribers;
CREATE TRIGGER zz_1766_subscribers_generation
    AFTER INSERT OR DELETE OR UPDATE OF email, status,
        consent_email_marketing_at ON public.subscribers
    FOR EACH ROW EXECUTE FUNCTION public.subscriber_email_consent_generation_trigger();

DROP TRIGGER IF EXISTS aa_1766_channel_consents_exact_address_lock
    ON public.subscriber_channel_consents;
CREATE TRIGGER aa_1766_channel_consents_exact_address_lock
    BEFORE INSERT OR DELETE OR UPDATE OF email, status, consent_timestamp,
        consent_source ON public.subscriber_channel_consents
    FOR EACH ROW EXECUTE FUNCTION public.subscriber_email_consent_mutation_identity();
DROP TRIGGER IF EXISTS zz_1766_channel_consents_generation
    ON public.subscriber_channel_consents;
CREATE TRIGGER zz_1766_channel_consents_generation
    AFTER INSERT OR DELETE OR UPDATE OF email, status, consent_timestamp,
        consent_source ON public.subscriber_channel_consents
    FOR EACH ROW EXECUTE FUNCTION public.subscriber_email_consent_generation_trigger();

DROP TRIGGER IF EXISTS aa_1766_sync_ledger_exact_address_lock
    ON public.consent_sync_ledger;
CREATE TRIGGER aa_1766_sync_ledger_exact_address_lock
    BEFORE INSERT OR UPDATE OR DELETE ON public.consent_sync_ledger
    FOR EACH ROW EXECUTE FUNCTION public.subscriber_email_consent_mutation_identity();
DROP TRIGGER IF EXISTS zz_1766_sync_ledger_generation
    ON public.consent_sync_ledger;
CREATE TRIGGER zz_1766_sync_ledger_generation
    AFTER INSERT OR UPDATE OR DELETE ON public.consent_sync_ledger
    FOR EACH ROW EXECUTE FUNCTION public.subscriber_email_consent_generation_trigger();

-- All three retained email-suppression stores participate.  Deletes matter as
-- much as inserts: removing a suppression changes the exact-address decision
-- observed by an external synchronizer and must invalidate its ETag.
DROP TRIGGER IF EXISTS aa_1766_suppressions_exact_address_lock
    ON public.suppressions;
CREATE TRIGGER aa_1766_suppressions_exact_address_lock
    BEFORE INSERT OR UPDATE OR DELETE ON public.suppressions
    FOR EACH ROW EXECUTE FUNCTION public.subscriber_email_consent_mutation_identity();
DROP TRIGGER IF EXISTS zz_1766_suppressions_generation
    ON public.suppressions;
CREATE TRIGGER zz_1766_suppressions_generation
    AFTER INSERT OR UPDATE OR DELETE ON public.suppressions
    FOR EACH ROW EXECUTE FUNCTION public.subscriber_email_consent_generation_trigger();

DROP TRIGGER IF EXISTS aa_1766_email_suppressions_exact_address_lock
    ON public.email_suppressions;
CREATE TRIGGER aa_1766_email_suppressions_exact_address_lock
    BEFORE INSERT OR UPDATE OR DELETE ON public.email_suppressions
    FOR EACH ROW EXECUTE FUNCTION public.subscriber_email_consent_mutation_identity();
DROP TRIGGER IF EXISTS zz_1766_email_suppressions_generation
    ON public.email_suppressions;
CREATE TRIGGER zz_1766_email_suppressions_generation
    AFTER INSERT OR UPDATE OR DELETE ON public.email_suppressions
    FOR EACH ROW EXECUTE FUNCTION public.subscriber_email_consent_generation_trigger();

DROP TRIGGER IF EXISTS aa_1766_subscriber_suppressions_exact_address_lock
    ON public.subscriber_suppressions;
CREATE TRIGGER aa_1766_subscriber_suppressions_exact_address_lock
    BEFORE INSERT OR UPDATE OR DELETE ON public.subscriber_suppressions
    FOR EACH ROW EXECUTE FUNCTION public.subscriber_email_consent_mutation_identity();
DROP TRIGGER IF EXISTS zz_1766_subscriber_suppressions_generation
    ON public.subscriber_suppressions;
CREATE TRIGGER zz_1766_subscriber_suppressions_generation
    AFTER INSERT OR UPDATE OR DELETE ON public.subscriber_suppressions
    FOR EACH ROW EXECUTE FUNCTION public.subscriber_email_consent_generation_trigger();

CREATE OR REPLACE FUNCTION public.start_subscriber_email_consent_reconciliation(
    p_batch_limit integer DEFAULT 250
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    run_id uuid;
    total_rows bigint;
    pending_rows bigint;
    gate_status text;
BEGIN
    IF p_batch_limit < 1 OR p_batch_limit > 500 THEN
        RAISE EXCEPTION 'consent reconciliation batch limit must be between 1 and 500'
            USING ERRCODE = '22023';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
            'subscriber-email-consent-reconciliation/v2', 1766
        )
    );
    SELECT gate.active_run_id, gate.status INTO run_id, gate_status
      FROM public.subscriber_email_consent_release_gate AS gate
     WHERE gate.singleton
     FOR UPDATE;
    IF run_id IS NOT NULL AND EXISTS (
        SELECT 1
          FROM public.subscriber_email_consent_reconciliation_runs AS run
         WHERE run.id = run_id AND run.status = 'running'
    ) THEN
        RETURN run_id;
    END IF;

    SELECT pg_catalog.count(*) INTO total_rows
      FROM public.subscriber_emails;
    SELECT pg_catalog.count(*) INTO pending_rows
      FROM public.subscriber_emails
     WHERE consent_reconciliation_state = 'pending';
    INSERT INTO public.subscriber_email_consent_reconciliation_runs (
        contract_version,
        status,
        batch_limit,
        rows_total,
        rolling_checksum
    ) VALUES (
        'subscriber-email-consent-terminal/v2',
        'running',
        p_batch_limit,
        total_rows,
        pg_catalog.encode(public.digest(
            'subscriber-email-consent-reconciliation/v2', 'sha256'
        ), 'hex')
    ) RETURNING id INTO run_id;

    IF gate_status = 'blocked' OR pending_rows > 0 THEN
        UPDATE public.subscriber_email_consent_release_gate
           SET status = 'blocked',
               active_run_id = run_id,
               rows_total = total_rows,
               rows_processed = 0,
               rows_proven = 0,
               rows_failed_closed = 0,
               postcheck_checksum = NULL,
               blocked_at = pg_catalog.clock_timestamp(),
               opened_at = NULL,
               updated_at = pg_catalog.clock_timestamp()
         WHERE singleton;
    ELSE
        -- Periodic expiry maintenance is already fail-closed at read time for
        -- the exact expired address.  Preserve the previously checksummed open
        -- gate so unrelated proven addresses do not suffer a fleet blackout.
        UPDATE public.subscriber_email_consent_release_gate
           SET active_run_id = run_id,
               updated_at = pg_catalog.clock_timestamp()
         WHERE singleton;
    END IF;
    RETURN run_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.reconcile_subscriber_email_consent_batch(
    p_run_id uuid,
    p_batch_limit integer DEFAULT 250
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET lock_timeout = '2s'
SET statement_timeout = '45s'
AS $function$
DECLARE
    run_row record;
    address_row record;
    classified_state text;
    processed integer := 0;
    proven integer := 0;
    failed_closed integer := 0;
    batch_material text := '';
    pending_count bigint;
    exact_total bigint;
    exact_proven bigint;
    exact_failed bigint;
    state_sum numeric;
    postcheck text;
BEGIN
    IF p_batch_limit < 1 OR p_batch_limit > 500 THEN
        RAISE EXCEPTION 'consent reconciliation batch limit must be between 1 and 500'
            USING ERRCODE = '22023';
    END IF;
    SELECT * INTO run_row
      FROM public.subscriber_email_consent_reconciliation_runs AS run
     WHERE run.id = p_run_id
     FOR UPDATE;
    IF NOT FOUND OR run_row.status <> 'running' THEN
        RAISE EXCEPTION 'consent reconciliation run is not active'
            USING ERRCODE = '55000';
    END IF;

    FOR address_row IN
        SELECT address.tenant_id,
               address.id,
               address.subscriber_id,
               address.email::text
          FROM public.subscriber_emails AS address
         WHERE address.consent_reconciliation_state = 'pending'
            OR (
                address.consent_status = 'subscribed' AND
                address.consent_proof_expires_at IS NOT NULL AND
                address.consent_proof_expires_at <=
                    pg_catalog.clock_timestamp()
            )
         ORDER BY address.tenant_id, address.id
         LIMIT p_batch_limit
         FOR UPDATE SKIP LOCKED
    LOOP
        classified_state := public.refresh_subscriber_email_consent_projection(
            address_row.tenant_id,
            address_row.subscriber_id,
            address_row.email,
            pg_catalog.clock_timestamp()
        );
        processed := processed + 1;
        IF classified_state = 'proven' THEN
            proven := proven + 1;
        ELSE
            failed_closed := failed_closed + 1;
        END IF;
        batch_material := batch_material || ':' || address_row.tenant_id::text ||
            ':' || address_row.id::text || ':' || classified_state;
        run_row.last_partition := address_row.tenant_id;
        run_row.last_address_id := address_row.id;
    END LOOP;

    UPDATE public.subscriber_email_consent_reconciliation_runs
       SET rows_processed = rows_processed + processed,
           rows_proven = rows_proven + proven,
           rows_failed_closed = rows_failed_closed + failed_closed,
           last_partition = run_row.last_partition,
           last_address_id = run_row.last_address_id,
           rolling_checksum = pg_catalog.encode(public.digest(
               rolling_checksum || batch_material,
               'sha256'
           ), 'hex'),
           heartbeat_at = pg_catalog.clock_timestamp()
     WHERE id = p_run_id;

    -- Expiry is work, not merely a final-postcheck error.  This makes a later
    -- operational rerun converge an address that was valid during the initial
    -- migration but expired without another write.  The postwave_app SELECT
    -- policy already withholds it from send-time exact-address gates while the
    -- bounded demotion is waiting to run.
    SELECT pg_catalog.count(*) INTO pending_count
      FROM public.subscriber_emails
     WHERE consent_reconciliation_state = 'pending'
        OR (
            consent_status = 'subscribed' AND
            consent_proof_expires_at IS NOT NULL AND
            consent_proof_expires_at <= pg_catalog.clock_timestamp()
        );

    IF pending_count = 0 THEN
        SELECT pg_catalog.count(*),
               pg_catalog.count(*) FILTER (
                   WHERE consent_reconciliation_state = 'proven'
               ),
               pg_catalog.count(*) FILTER (
                   WHERE consent_reconciliation_state = 'failed_closed'
               ),
               COALESCE(pg_catalog.sum(
                   pg_catalog.hashtextextended(
                       id::text || ':' || COALESCE(consent_decision_checksum, ''),
                       1766
                   )::numeric
               ), 0)
          INTO exact_total, exact_proven, exact_failed, state_sum
          FROM public.subscriber_emails;

        IF EXISTS (
            SELECT 1
              FROM public.subscriber_emails AS address
             WHERE address.consent_status = 'subscribed'
               AND (
                   address.consent_reconciliation_state <> 'proven' OR
                   address.consent_decision_checksum IS NULL OR
                   public.subscriber_email_latest_decision(
                       address.tenant_id,
                       address.subscriber_id,
                       address.id,
                       address.email::text
                   ) IS DISTINCT FROM 'granted'
               )
        ) THEN
            RAISE EXCEPTION 'postcheck found a subscribed address without an exact grant'
                USING ERRCODE = '23514';
        END IF;

        SELECT pg_catalog.encode(public.digest(
            pg_catalog.concat_ws(
                ':',
                'subscriber-email-consent-postcheck/v2',
                run.rolling_checksum,
                exact_total::text,
                exact_proven::text,
                exact_failed::text,
                state_sum::text
            ),
            'sha256'
        ), 'hex')
          INTO postcheck
          FROM public.subscriber_email_consent_reconciliation_runs AS run
         WHERE run.id = p_run_id;

        UPDATE public.subscriber_email_consent_reconciliation_runs
           SET status = 'complete',
               rows_total = exact_total,
               rows_processed = exact_total,
               rows_proven = exact_proven,
               rows_failed_closed = exact_failed,
               postcheck_checksum = postcheck,
               completed_at = pg_catalog.clock_timestamp(),
               heartbeat_at = pg_catalog.clock_timestamp()
         WHERE id = p_run_id;
        UPDATE public.subscriber_email_consent_release_gate
           SET status = 'open',
               rows_total = exact_total,
               rows_processed = exact_total,
               rows_proven = exact_proven,
               rows_failed_closed = exact_failed,
               postcheck_checksum = postcheck,
               opened_at = pg_catalog.clock_timestamp(),
               updated_at = pg_catalog.clock_timestamp()
         WHERE singleton AND active_run_id = p_run_id;
    ELSE
        UPDATE public.subscriber_email_consent_release_gate AS gate
           SET rows_processed = run.rows_processed,
               rows_proven = run.rows_proven,
               rows_failed_closed = run.rows_failed_closed,
               updated_at = pg_catalog.clock_timestamp()
          FROM public.subscriber_email_consent_reconciliation_runs AS run
         WHERE gate.singleton
           AND gate.status = 'blocked'
           AND run.id = p_run_id;
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'run_id', p_run_id,
        'batch_processed', processed,
        'pending', pending_count,
        'complete', pending_count = 0
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.start_subscriber_email_consent_reconciliation(integer),
    public.reconcile_subscriber_email_consent_batch(uuid, integer)
    FROM PUBLIC, postwave_app;

-- CALL runs as a top-level phased-migration statement.  Each <=500-row batch
-- commits independently; a statement timeout or process loss leaves the run
-- resumable and the release gate blocked.
CREATE OR REPLACE PROCEDURE public.complete_subscriber_email_consent_reconciliation(
    p_batch_limit integer DEFAULT 250
)
LANGUAGE plpgsql
AS $procedure$
DECLARE
    run_id uuid;
    progress jsonb;
BEGIN
    run_id := public.start_subscriber_email_consent_reconciliation(
        p_batch_limit
    );
    COMMIT;
    LOOP
        progress := public.reconcile_subscriber_email_consent_batch(
            run_id, p_batch_limit
        );
        COMMIT;
        EXIT WHEN (progress ->> 'complete')::boolean;
    END LOOP;
END;
$procedure$;

REVOKE ALL ON PROCEDURE public.complete_subscriber_email_consent_reconciliation(integer)
    FROM PUBLIC, postwave_app;

INSERT INTO public.subscriber_email_consent_release_gate (
    singleton,
    contract_version,
    status
) VALUES (
    true,
    'subscriber-email-consent-terminal/v2',
    'blocked'
);

COMMIT;

-- These predicates exactly match the terminal fold and release-gate scan.
-- They are online because all target tables may be large in production.
SET lock_timeout = '5s';
SET statement_timeout = '30min';

CREATE INDEX CONCURRENTLY IF NOT EXISTS consent_events_exact_email_terminal_v2_idx
    ON public.consent_events (
        tenant_id,
        (public.subscriber_email_consent_normalize_email(subject_email::text)),
        category,
        subject_type,
        created_at DESC,
        (COALESCE(recorded_at, created_at)) DESC,
        id DESC
    )
    WHERE subject_email IS NOT NULL
      AND subject_type = 'subscriber'
      AND category IN ('email_marketing', 'marketing');

CREATE INDEX CONCURRENTLY IF NOT EXISTS consent_records_exact_email_terminal_v2_idx
    ON public.consent_records (
        tenant_id,
        (public.subscriber_email_consent_normalize_email(email::text)),
        subscriber_id,
        channel,
        captured_at DESC,
        (COALESCE(recorded_at, created_at)) DESC,
        id DESC
    )
    WHERE channel = 'email';

CREATE INDEX CONCURRENTLY IF NOT EXISTS consent_records_event_binding_v2_idx
    ON public.consent_records (
        tenant_id,
        ((evidence ->> 'event_id')),
        subscriber_id,
        (public.subscriber_email_consent_normalize_email(email::text))
    )
    WHERE channel = 'email'
      AND consent_status = 'granted'
      AND evidence ? 'event_id';

CREATE INDEX CONCURRENTLY IF NOT EXISTS subscriber_emails_consent_pending_v2_idx
    ON public.subscriber_emails (tenant_id, id, subscriber_id)
    WHERE consent_reconciliation_state = 'pending';

-- A proof may expire without another row mutation.  Keep the periodic
-- fail-closed reconciliation scan bounded even when pending classification is
-- already empty and the retained address population is very large.
CREATE INDEX CONCURRENTLY IF NOT EXISTS subscriber_emails_consent_expiry_v2_idx
    ON public.subscriber_emails (
        consent_proof_expires_at,
        tenant_id,
        id,
        subscriber_id
    )
    WHERE consent_status = 'subscribed'
      AND consent_proof_expires_at IS NOT NULL;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
    subscriber_emails_canonical_normalized_email_v2_uidx
    ON public.subscriber_emails (
        tenant_id,
        (public.subscriber_email_consent_normalize_email(email::text))
    );

CREATE INDEX CONCURRENTLY IF NOT EXISTS suppressions_exact_email_generation_v2_idx
    ON public.suppressions (tenant_id, (lower(email::text)));

CREATE INDEX CONCURRENTLY IF NOT EXISTS email_suppressions_exact_email_generation_v2_idx
    ON public.email_suppressions (tenant_id, (lower(email::text)));

CREATE INDEX CONCURRENTLY IF NOT EXISTS subscriber_suppressions_exact_email_generation_v2_idx
    ON public.subscriber_suppressions (tenant_id, (lower(email::text)));

RESET statement_timeout;
RESET lock_timeout;

SET lock_timeout = '5s';
SET statement_timeout = '30min';

CALL public.complete_subscriber_email_consent_reconciliation(250);

RESET statement_timeout;
RESET lock_timeout;

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE public.subscriber_emails
    VALIDATE CONSTRAINT subscriber_emails_consent_reconciliation_state_check;
ALTER TABLE public.subscriber_emails
    VALIDATE CONSTRAINT subscriber_emails_consent_reconciliation_generation_check;
ALTER TABLE public.subscriber_emails
    VALIDATE CONSTRAINT subscriber_emails_consent_decision_checksum_check;
ALTER TABLE public.subscriber_email_consent_release_gate
    VALIDATE CONSTRAINT subscriber_email_consent_release_gate_run_fk;

DO $postcheck$
DECLARE
    gate public.subscriber_email_consent_release_gate%ROWTYPE;
    pending_count bigint;
    unsafe_count bigint;
BEGIN
    SELECT * INTO gate
      FROM public.subscriber_email_consent_release_gate
     WHERE singleton;
    SELECT pg_catalog.count(*) INTO pending_count
      FROM public.subscriber_emails
     WHERE consent_reconciliation_state = 'pending';
    SELECT pg_catalog.count(*) INTO unsafe_count
      FROM public.subscriber_emails
     WHERE consent_status = 'subscribed'
       AND (
           consent_reconciliation_state <> 'proven' OR
           consent_decision_checksum IS NULL
       );
    IF gate.status <> 'open' OR gate.opened_at IS NULL OR
       gate.postcheck_checksum !~ '^[0-9a-f]{64}$' OR
       gate.rows_processed <> gate.rows_total OR
       pending_count <> 0 OR unsafe_count <> 0 THEN
        RAISE EXCEPTION '1766 consent release gate did not reach an exact safe terminal state'
            USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_trigger
         WHERE tgrelid = 'public.consent_events'::pg_catalog.regclass
           AND tgname = 'ab_1766_consent_events_recorded_chronology'
           AND tgfoid =
                   'public.subscriber_email_consent_stamp_chronology()'::pg_catalog.regprocedure
           AND tgtype = 23
           AND tgenabled <> 'D'
           AND NOT tgisinternal
    ) OR NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_trigger
         WHERE tgrelid = 'public.consent_events'::pg_catalog.regclass
           AND tgname = 'consent_events_project_vector'
           AND tgfoid =
                   'public.consent_events_project_to_subscribers()'::pg_catalog.regprocedure
           AND tgtype = 5
           AND tgenabled <> 'D'
           AND NOT tgisinternal
    ) OR NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_trigger
         WHERE tgrelid = 'public.consent_records'::pg_catalog.regclass
           AND tgname = 'zy_1766_consent_records_refresh_projection'
           AND tgfoid =
                   'public.subscriber_email_consent_refresh_from_ledger()'::pg_catalog.regprocedure
           AND tgtype = 5
           AND tgenabled <> 'D'
           AND NOT tgisinternal
    ) OR NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_trigger
         WHERE tgrelid = 'public.subscriber_emails'::pg_catalog.regclass
           AND tgname = 'subscriber_emails_require_grant'
           AND tgfoid =
                   'public.require_subscriber_email_grant_evidence()'::pg_catalog.regprocedure
           AND tgtype = 21
           AND tgenabled <> 'D'
           AND tgdeferrable AND tginitdeferred AND NOT tgisinternal
    ) OR NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_trigger
         WHERE tgrelid = 'public.subscribers'::pg_catalog.regclass
           AND tgname = 'subscribers_require_email_purpose_proof'
           AND tgfoid =
                   'public.require_subscriber_email_raw_projection_proof()'::pg_catalog.regprocedure
           AND tgtype = 21
           AND tgenabled <> 'D'
           AND tgdeferrable AND tginitdeferred AND NOT tgisinternal
    ) OR NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_trigger
         WHERE tgrelid =
                   'public.subscriber_channel_consents'::pg_catalog.regclass
           AND tgname = 'subscriber_channel_consents_require_email_proof'
           AND tgfoid =
                   'public.require_subscriber_channel_email_proof()'::pg_catalog.regprocedure
           AND tgtype = 21
           AND tgenabled <> 'D'
           AND tgdeferrable AND tginitdeferred AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION '1766 consent chronology/projection/terminal triggers are incomplete';
    END IF;
    IF (
        SELECT pg_catalog.count(*)
          FROM pg_catalog.pg_proc AS guard
          JOIN pg_catalog.pg_roles AS definer
            ON definer.oid = guard.proowner
         WHERE guard.oid IN (
             'public.subscriber_email_consent_release_open()'::pg_catalog.regprocedure,
             'public.subscriber_email_consent_lock_for_repair(uuid,uuid,text)'::pg_catalog.regprocedure,
             'public.subscriber_email_consent_lock_for_repair_by_id(uuid,uuid,uuid)'::pg_catalog.regprocedure,
             'public.subscriber_email_consent_set_suppressed_for_repair_by_id(uuid,uuid,uuid,timestamp with time zone,boolean)'::pg_catalog.regprocedure,
             'public.subscriber_email_consent_reconcile_identity()'::pg_catalog.regprocedure,
             'public.subscriber_email_consent_bump_generation(uuid,text,text,text,timestamptz)'::pg_catalog.regprocedure,
             'public.refresh_subscriber_email_consent_projection(uuid,uuid,text,timestamptz)'::pg_catalog.regprocedure,
             'public.subscriber_email_consent_mutation_identity()'::pg_catalog.regprocedure,
             'public.subscriber_email_consent_generation_trigger()'::pg_catalog.regprocedure,
             'public.subscriber_email_consent_refresh_from_ledger()'::pg_catalog.regprocedure,
             'public.require_subscriber_email_grant_evidence()'::pg_catalog.regprocedure,
             'public.require_subscriber_email_raw_projection_proof()'::pg_catalog.regprocedure,
             'public.require_subscriber_channel_email_proof()'::pg_catalog.regprocedure,
             'public.start_subscriber_email_consent_reconciliation(integer)'::pg_catalog.regprocedure,
             'public.reconcile_subscriber_email_consent_batch(uuid,integer)'::pg_catalog.regprocedure
         )
           AND guard.prosecdef
           AND (definer.rolsuper OR definer.rolbypassrls)
    ) <> 15 THEN
        RAISE EXCEPTION '1766 terminal guards must bypass app visibility RLS safely; operational security definers require a BYPASSRLS owner';
    END IF;
    IF NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_trigger AS installed
          JOIN pg_catalog.pg_proc AS trigger_function
            ON trigger_function.oid = installed.tgfoid
          JOIN pg_catalog.pg_language AS language
            ON language.oid = trigger_function.prolang
         WHERE installed.tgrelid =
                   'public.subscribers'::pg_catalog.regclass
           AND installed.tgname = 'subscribers_reconcile_email_identity'
           AND installed.tgfoid =
                   'public.subscriber_email_consent_reconcile_identity()'::pg_catalog.regprocedure
           AND installed.tgtype = 21
           AND installed.tgattr::text = (
                   SELECT attribute.attnum::text
                     FROM pg_catalog.pg_attribute AS attribute
                    WHERE attribute.attrelid =
                              'public.subscribers'::pg_catalog.regclass
                      AND attribute.attname = 'email'
                      AND NOT attribute.attisdropped
               )
           AND installed.tgconstraint <> 0
           AND installed.tgdeferrable
           AND installed.tginitdeferred
           AND installed.tgenabled <> 'D'
           AND NOT installed.tgisinternal
           AND trigger_function.prosecdef
           AND NOT trigger_function.proretset
           AND trigger_function.prorettype =
                   'pg_catalog.trigger'::pg_catalog.regtype
           AND trigger_function.proconfig =
                   ARRAY['search_path=pg_catalog, public']::text[]
           AND language.lanname = 'plpgsql'
           AND pg_catalog.strpos(
                   pg_catalog.upper(trigger_function.prosrc), 'EXECUTE'
               ) = 0
    ) OR pg_catalog.has_function_privilege(
        'postwave_app',
        'public.subscriber_email_consent_reconcile_identity()',
        'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
        'public',
        'public.subscriber_email_consent_reconcile_identity()',
        'EXECUTE'
    ) OR EXISTS (
        SELECT 1
          FROM pg_catalog.pg_trigger AS installed
         WHERE installed.tgrelid =
                   'public.subscribers'::pg_catalog.regclass
           AND installed.tgname = 'subscribers_reconcile_email_identity'
           AND installed.tgfoid =
                   'public.reconcile_subscriber_email_identity()'::pg_catalog.regprocedure
    ) THEN
        RAISE EXCEPTION '1766 gate-hidden canonical identity reconciliation boundary is incomplete';
    END IF;
    IF (
        SELECT pg_catalog.count(*)
          FROM (
              VALUES
                ('public.consent_events'::pg_catalog.regclass,
                 'aa_1766_consent_events_exact_address_lock'::name),
                ('public.consent_events'::pg_catalog.regclass,
                 'ab_1766_consent_events_recorded_chronology'::name),
                ('public.consent_events'::pg_catalog.regclass,
                 'zz_1766_consent_events_generation'::name),
                ('public.consent_records'::pg_catalog.regclass,
                 'aa_1766_consent_records_exact_address_lock'::name),
                ('public.consent_records'::pg_catalog.regclass,
                 'ab_1766_consent_records_recorded_chronology'::name),
                ('public.consent_records'::pg_catalog.regclass,
                 'zy_1766_consent_records_refresh_projection'::name),
                ('public.consent_records'::pg_catalog.regclass,
                 'zz_1766_consent_records_generation'::name),
                ('public.consent_receipts'::pg_catalog.regclass,
                 'aa_1766_consent_receipts_exact_address_lock'::name),
                ('public.consent_receipts'::pg_catalog.regclass,
                 'ab_1766_consent_receipts_immutable'::name),
                ('public.consent_receipts'::pg_catalog.regclass,
                 'zy_1766_consent_receipts_refresh_projection'::name),
                ('public.consent_receipts'::pg_catalog.regclass,
                 'zz_1766_consent_receipts_generation'::name),
                ('public.subscriber_import_consent_receipts'::pg_catalog.regclass,
                 'aa_1766_import_receipts_exact_address_lock'::name),
                ('public.subscriber_import_consent_receipts'::pg_catalog.regclass,
                 'zy_1766_import_receipts_refresh_projection'::name),
                ('public.subscriber_import_consent_receipts'::pg_catalog.regclass,
                 'zz_1766_import_receipts_generation'::name),
                ('public.subscriber_emails'::pg_catalog.regclass,
                 'aa_1766_subscriber_emails_exact_address_lock'::name),
                ('public.subscriber_emails'::pg_catalog.regclass,
                 'ab_1766_subscriber_emails_initialize_classification'::name),
                ('public.subscriber_emails'::pg_catalog.regclass,
                 'zz_1766_subscriber_emails_generation'::name),
                ('public.subscribers'::pg_catalog.regclass,
                 'aa_1766_subscribers_exact_address_lock'::name),
                ('public.subscribers'::pg_catalog.regclass,
                 'zz_1766_subscribers_generation'::name),
                ('public.subscriber_channel_consents'::pg_catalog.regclass,
                 'aa_1766_channel_consents_exact_address_lock'::name),
                ('public.subscriber_channel_consents'::pg_catalog.regclass,
                 'zz_1766_channel_consents_generation'::name),
                ('public.consent_sync_ledger'::pg_catalog.regclass,
                 'aa_1766_sync_ledger_exact_address_lock'::name),
                ('public.consent_sync_ledger'::pg_catalog.regclass,
                 'zz_1766_sync_ledger_generation'::name),
                ('public.suppressions'::pg_catalog.regclass,
                 'aa_1766_suppressions_exact_address_lock'::name),
                ('public.suppressions'::pg_catalog.regclass,
                 'zz_1766_suppressions_generation'::name),
                ('public.email_suppressions'::pg_catalog.regclass,
                 'aa_1766_email_suppressions_exact_address_lock'::name),
                ('public.email_suppressions'::pg_catalog.regclass,
                 'zz_1766_email_suppressions_generation'::name),
                ('public.subscriber_suppressions'::pg_catalog.regclass,
                 'aa_1766_subscriber_suppressions_exact_address_lock'::name),
                ('public.subscriber_suppressions'::pg_catalog.regclass,
                 'zz_1766_subscriber_suppressions_generation'::name)
          ) AS required_trigger(relid, trigger_name)
          JOIN pg_catalog.pg_trigger AS installed
            ON installed.tgrelid = required_trigger.relid
           AND installed.tgname = required_trigger.trigger_name
           AND installed.tgenabled <> 'D'
           AND installed.tgtype = CASE
                   WHEN required_trigger.trigger_name::text LIKE 'aa_1766_%'
                       THEN 31
                   WHEN required_trigger.trigger_name::text IN (
                       'ab_1766_consent_events_recorded_chronology',
                       'ab_1766_consent_records_recorded_chronology'
                   ) THEN 23
                   WHEN required_trigger.trigger_name =
                       'ab_1766_consent_receipts_immutable'::name THEN 19
                   WHEN required_trigger.trigger_name =
                       'ab_1766_subscriber_emails_initialize_classification'::name
                       THEN 7
                   WHEN required_trigger.trigger_name::text LIKE 'zy_1766_%'
                       THEN 5
                   WHEN required_trigger.trigger_name::text LIKE 'zz_1766_%'
                       THEN 29
               END
           AND installed.tgfoid = CASE
                   WHEN required_trigger.trigger_name::text LIKE 'aa_1766_%'
                       THEN 'public.subscriber_email_consent_mutation_identity()'::pg_catalog.regprocedure
                   WHEN required_trigger.trigger_name::text IN (
                       'ab_1766_consent_events_recorded_chronology',
                       'ab_1766_consent_records_recorded_chronology'
                   ) THEN 'public.subscriber_email_consent_stamp_chronology()'::pg_catalog.regprocedure
                   WHEN required_trigger.trigger_name =
                       'ab_1766_consent_receipts_immutable'::name
                       THEN 'public.subscriber_email_consent_receipt_immutable()'::pg_catalog.regprocedure
                   WHEN required_trigger.trigger_name =
                       'ab_1766_subscriber_emails_initialize_classification'::name
                       THEN 'public.initialize_subscriber_email_consent_classification()'::pg_catalog.regprocedure
                   WHEN required_trigger.trigger_name::text LIKE 'zy_1766_%'
                       THEN 'public.subscriber_email_consent_refresh_from_ledger()'::pg_catalog.regprocedure
                   WHEN required_trigger.trigger_name::text LIKE 'zz_1766_%'
                       THEN 'public.subscriber_email_consent_generation_trigger()'::pg_catalog.regprocedure
               END
           AND NOT installed.tgisinternal
    ) <> 29 THEN
        RAISE EXCEPTION '1766 exact-address serialization/invalidation triggers are incomplete';
    END IF;
    IF NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_policy AS policy
          JOIN pg_catalog.pg_roles AS app_role
            ON app_role.oid = ANY(policy.polroles)
         WHERE policy.polrelid =
                   'public.subscriber_emails'::pg_catalog.regclass
           AND policy.polname =
                   'subscriber_emails_nonexpired_positive_visibility'
           AND NOT policy.polpermissive
           AND policy.polcmd = 'r'
           AND app_role.rolname = 'postwave_app'
           AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid)
                   LIKE '%subscriber_email_consent_release_open()%'
    ) OR NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_class AS relation
         WHERE relation.oid =
                   'public.subscriber_email_consent_address_state'::pg_catalog.regclass
           AND relation.relrowsecurity
           AND relation.relforcerowsecurity
    ) OR (
        SELECT pg_catalog.count(*)
          FROM (
              VALUES
                ('public.subscriber_email_consent_lock_for_repair(uuid,uuid,text)'::pg_catalog.regprocedure),
                ('public.subscriber_email_consent_lock_for_repair_by_id(uuid,uuid,uuid)'::pg_catalog.regprocedure)
          ) AS expected_helper(oid)
          JOIN pg_catalog.pg_proc AS helper
            ON helper.oid = expected_helper.oid
          JOIN pg_catalog.pg_language AS language
            ON language.oid = helper.prolang
         WHERE helper.prosecdef
           AND helper.proretset
           AND helper.proconfig =
                   ARRAY['search_path=pg_catalog, public']::text[]
           AND language.lanname = 'plpgsql'
           AND pg_catalog.pg_get_function_result(helper.oid) =
                   'TABLE(address_id uuid, stored_email text, is_primary boolean, consent_status text, suppressed boolean, last_engaged_at timestamp with time zone, created_at timestamp with time zone, updated_at timestamp with time zone, reconciliation_state text)'
           AND pg_catalog.strpos(
                   pg_catalog.upper(helper.prosrc), 'EXECUTE'
               ) = 0
    ) <> 2
    OR NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_proc AS setter
          JOIN pg_catalog.pg_language AS language
            ON language.oid = setter.prolang
         WHERE setter.oid =
                   'public.subscriber_email_consent_set_suppressed_for_repair_by_id(uuid,uuid,uuid,timestamp with time zone,boolean)'::pg_catalog.regprocedure
           AND setter.prosecdef
           AND setter.proretset
           AND setter.proconfig = ARRAY[
                   'search_path=pg_catalog, public',
                   'lock_timeout=1s'
               ]::text[]
           AND language.lanname = 'plpgsql'
           AND pg_catalog.pg_get_function_result(setter.oid) =
                   'TABLE(outcome text, address_id uuid, stored_email text, is_primary boolean, consent_status text, suppressed boolean, last_engaged_at timestamp with time zone, created_at timestamp with time zone, updated_at timestamp with time zone, reconciliation_state text)'
           AND pg_catalog.strpos(
                   pg_catalog.upper(setter.prosrc), 'EXECUTE'
               ) = 0
    )
    OR NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_proc AS release_helper
         WHERE release_helper.oid =
                   'public.subscriber_email_consent_release_open()'::pg_catalog.regprocedure
           AND release_helper.prosecdef
    ) OR pg_catalog.has_table_privilege(
        'postwave_app',
        'public.subscriber_email_consent_release_gate',
        'SELECT'
    ) OR pg_catalog.has_table_privilege(
        'postwave_app',
        'public.subscriber_email_consent_reconciliation_runs',
        'SELECT'
    ) OR NOT pg_catalog.has_function_privilege(
        'postwave_app',
        'public.subscriber_email_consent_release_open()',
        'EXECUTE'
    ) OR NOT pg_catalog.has_function_privilege(
        'postwave_app',
        'public.subscriber_email_consent_lock_for_repair(uuid,uuid,text)',
        'EXECUTE'
    ) OR NOT pg_catalog.has_function_privilege(
        'postwave_app',
        'public.subscriber_email_consent_lock_for_repair_by_id(uuid,uuid,uuid)',
        'EXECUTE'
    ) OR NOT pg_catalog.has_function_privilege(
        'postwave_app',
        'public.subscriber_email_consent_set_suppressed_for_repair_by_id(uuid,uuid,uuid,timestamp with time zone,boolean)',
        'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
        'public',
        'public.subscriber_email_consent_release_open()',
        'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
        'public',
        'public.subscriber_email_consent_lock_for_repair(uuid,uuid,text)',
        'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
        'public',
        'public.subscriber_email_consent_lock_for_repair_by_id(uuid,uuid,uuid)',
        'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
        'public',
        'public.subscriber_email_consent_set_suppressed_for_repair_by_id(uuid,uuid,uuid,timestamp with time zone,boolean)',
        'EXECUTE'
    ) OR EXISTS (
        SELECT 1
          FROM pg_catalog.pg_proc AS repair_function
          CROSS JOIN LATERAL pg_catalog.aclexplode(
              COALESCE(
                  repair_function.proacl,
                  pg_catalog.acldefault('f', repair_function.proowner)
              )
          ) AS privilege
         WHERE repair_function.oid IN (
                   'public.subscriber_email_consent_lock_for_repair(uuid,uuid,text)'::pg_catalog.regprocedure,
                   'public.subscriber_email_consent_lock_for_repair_by_id(uuid,uuid,uuid)'::pg_catalog.regprocedure,
                   'public.subscriber_email_consent_set_suppressed_for_repair_by_id(uuid,uuid,uuid,timestamp with time zone,boolean)'::pg_catalog.regprocedure
               )
           AND privilege.privilege_type = 'EXECUTE'
           AND privilege.grantee <> repair_function.proowner
           AND privilege.grantee <> (
                   SELECT role.oid
                     FROM pg_catalog.pg_roles AS role
                    WHERE role.rolname = 'postwave_app'
               )
    ) THEN
        RAISE EXCEPTION '1766 expiry visibility/address-state repair or metadata-isolation contract is incomplete';
    END IF;
    IF (
        SELECT pg_catalog.count(*)
          FROM (
              VALUES
                ('public.consent_events_exact_email_terminal_v2_idx'::pg_catalog.regclass,
                 'public.consent_events'::pg_catalog.regclass, false, 7, '2 0 7 3 15 0 1',
                 'subscriber_email_consent_normalize_email((subject_email)::text), COALESCE(recorded_at, created_at)',
                 '((subject_email IS NOT NULL) AND (subject_type = ''subscriber''::text) AND (category = ANY (ARRAY[''email_marketing''::text, ''marketing''::text])))'),
                ('public.consent_records_exact_email_terminal_v2_idx'::pg_catalog.regclass,
                 'public.consent_records'::pg_catalog.regclass, false, 7, '2 0 3 5 12 0 1',
                 'subscriber_email_consent_normalize_email((email)::text), COALESCE(recorded_at, created_at)',
                 '(channel = ''email''::text)'),
                ('public.consent_records_event_binding_v2_idx'::pg_catalog.regclass,
                 'public.consent_records'::pg_catalog.regclass, false, 4, '2 0 3 0',
                 '(evidence ->> ''event_id''::text), subscriber_email_consent_normalize_email((email)::text)',
                 '((channel = ''email''::text) AND (consent_status = ''granted''::text) AND (evidence ? ''event_id''::text))'),
                ('public.subscriber_emails_consent_pending_v2_idx'::pg_catalog.regclass,
                 'public.subscriber_emails'::pg_catalog.regclass, false, 3, '2 1 3',
                 NULL,
                 '(consent_reconciliation_state = ''pending''::text)'),
                ('public.subscriber_emails_consent_expiry_v2_idx'::pg_catalog.regclass,
                 'public.subscriber_emails'::pg_catalog.regclass, false, 4, '17 2 1 3',
                 NULL,
                 '((consent_status = ''subscribed''::text) AND (consent_proof_expires_at IS NOT NULL))'),
                ('public.subscriber_emails_canonical_normalized_email_v2_uidx'::pg_catalog.regclass,
                 'public.subscriber_emails'::pg_catalog.regclass, true, 2, '2 0',
                 'subscriber_email_consent_normalize_email((email)::text)',
                 NULL),
                ('public.suppressions_exact_email_generation_v2_idx'::pg_catalog.regclass,
                 'public.suppressions'::pg_catalog.regclass, false, 2, '2 0',
                 'lower((email)::text)', NULL),
                ('public.email_suppressions_exact_email_generation_v2_idx'::pg_catalog.regclass,
                 'public.email_suppressions'::pg_catalog.regclass, false, 2, '2 0',
                 'lower((email)::text)', NULL),
                ('public.subscriber_suppressions_exact_email_generation_v2_idx'::pg_catalog.regclass,
                 'public.subscriber_suppressions'::pg_catalog.regclass, false, 2, '2 0',
                 'lower((email)::text)', NULL)
          ) AS expected(
              indexrelid, relid, unique_index, key_count, indkey,
              index_expression, predicate
          )
          JOIN pg_catalog.pg_index AS index_state
            ON index_state.indexrelid = expected.indexrelid
           AND index_state.indrelid = expected.relid
           AND index_state.indisunique = expected.unique_index
           AND index_state.indnkeyatts = expected.key_count
           AND index_state.indnatts = expected.key_count
           AND index_state.indkey::text = expected.indkey
           AND pg_catalog.pg_get_expr(
                   index_state.indexprs, index_state.indrelid
               ) IS NOT DISTINCT FROM expected.index_expression
           AND pg_catalog.pg_get_expr(
                   index_state.indpred, index_state.indrelid
               ) IS NOT DISTINCT FROM expected.predicate
           AND index_state.indisvalid
           AND index_state.indisready
    ) <> 9 THEN
        RAISE EXCEPTION '1766 exact-predicate online index definitions are not exact, valid, and ready';
    END IF;
END;
$postcheck$;

COMMIT;
