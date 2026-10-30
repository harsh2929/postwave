-- 1979_consent_evidence_read_integrity.sql
--
-- Route38 consent evidence hardening:
--   * give consent_receipts a database-owned recording chronology without
--     rewriting the historical table;
--   * stamp all new ledger rows with the top-level xid8 that recorded them so
--     stateless snapshot traversal remains correct across subtransactions;
--   * bind the three consent_events rows emitted for one public browser
--     decision to one immutable decision identity and request fingerprint;
--   * remove the generic app.outbox_worker cross-tenant escape from the
--     sensitive consent_receipts RLS policy; and
--   * add online indexes for snapshot/keyset evidence reads.
--
-- Existing consent_receipts.recorded_at values intentionally remain NULL.
-- Reads use COALESCE(recorded_at, at) for those legacy rows. Future inserts are
-- stamped by a trigger with the database clock even if a caller tries to pass a
-- different value, keeping asserted occurrence time (`at`) distinct from the
-- evidence recording chronology.
--
-- rollback-strategy: restore. The chronology, decision grouping, and stricter
-- tenant boundary are evidence-integrity controls and must survive an older
-- application image.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE public.consent_receipts
    ADD COLUMN IF NOT EXISTS recorded_at timestamptz,
    ADD COLUMN IF NOT EXISTS recorded_xid xid8;
ALTER TABLE public.consent_receipts
    ALTER COLUMN recorded_at SET DEFAULT clock_timestamp();

ALTER TABLE public.consent_records
    ADD COLUMN IF NOT EXISTS recorded_xid xid8;

ALTER TABLE public.consent_events
    ADD COLUMN IF NOT EXISTS recorded_xid xid8;

COMMENT ON COLUMN public.consent_receipts.recorded_at IS
    'Immutable database recording chronology. Legacy NULL values are read as the historical at value; at remains asserted occurrence time.';
COMMENT ON COLUMN public.consent_receipts.recorded_xid IS
    'Top-level xid8 that recorded this row. Legacy NULL means committed before the migration boundary and is always visible to later evidence cursors.';
COMMENT ON COLUMN public.consent_records.recorded_xid IS
    'Top-level xid8 that recorded this row. Legacy NULL means committed before the migration boundary and is always visible to later evidence cursors.';
COMMENT ON COLUMN public.consent_events.recorded_xid IS
    'Top-level xid8 that recorded this row. Legacy NULL means committed before the migration boundary and is always visible to later evidence cursors.';

CREATE OR REPLACE FUNCTION public.consent_receipts_stamp_recorded_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.recorded_at := pg_catalog.clock_timestamp();
        RETURN NEW;
    END IF;
    IF NEW.recorded_at IS DISTINCT FROM OLD.recorded_at THEN
        RAISE EXCEPTION 'consent receipt recording chronology is immutable'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.consent_receipts_stamp_recorded_at() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consent_receipts_stamp_recorded_at() TO postwave_app;

DROP TRIGGER IF EXISTS aa_1979_consent_receipts_recorded_chronology
    ON public.consent_receipts;
CREATE TRIGGER aa_1979_consent_receipts_recorded_chronology
    BEFORE INSERT OR UPDATE ON public.consent_receipts
    FOR EACH ROW EXECUTE FUNCTION public.consent_receipts_stamp_recorded_at();

-- Tuple xmin can be a subtransaction xid. PostgreSQL explicitly does not
-- resolve subtransaction ids in pg_visible_in_snapshot(), so using xmin can
-- admit a row whose parent transaction committed only after page one. Record
-- pg_current_xact_id() instead: it is the epoch-bearing TOP-LEVEL xid even
-- while this trigger runs inside a SAVEPOINT. The ACCESS EXCLUSIVE locks taken
-- by the ALTERs above wait out pre-existing writers; therefore a NULL value can
-- only belong to a row committed before this migration boundary and is safe to
-- treat as visible to every cursor minted by the post-migration application.
CREATE OR REPLACE FUNCTION public.consent_evidence_stamp_recorded_xid()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.recorded_xid := pg_catalog.pg_current_xact_id();
        RETURN NEW;
    END IF;
    IF NEW.recorded_xid IS DISTINCT FROM OLD.recorded_xid THEN
        RAISE EXCEPTION 'consent evidence recording transaction is immutable'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.consent_evidence_stamp_recorded_xid() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consent_evidence_stamp_recorded_xid() TO postwave_app;

DROP TRIGGER IF EXISTS aa_1979_consent_receipts_recorded_xid
    ON public.consent_receipts;
CREATE TRIGGER aa_1979_consent_receipts_recorded_xid
    BEFORE INSERT OR UPDATE ON public.consent_receipts
    FOR EACH ROW EXECUTE FUNCTION public.consent_evidence_stamp_recorded_xid();

DROP TRIGGER IF EXISTS aa_1979_consent_records_recorded_xid
    ON public.consent_records;
CREATE TRIGGER aa_1979_consent_records_recorded_xid
    BEFORE INSERT OR UPDATE ON public.consent_records
    FOR EACH ROW EXECUTE FUNCTION public.consent_evidence_stamp_recorded_xid();

DROP TRIGGER IF EXISTS aa_1979_consent_events_recorded_xid
    ON public.consent_events;
CREATE TRIGGER aa_1979_consent_events_recorded_xid
    BEFORE INSERT OR UPDATE ON public.consent_events
    FOR EACH ROW EXECUTE FUNCTION public.consent_evidence_stamp_recorded_xid();

ALTER TABLE public.consent_events
    ADD COLUMN IF NOT EXISTS decision_id uuid,
    ADD COLUMN IF NOT EXISTS request_fingerprint text;

COMMENT ON COLUMN public.consent_events.decision_id IS
    'Immutable identity shared by every category row produced from one public consent decision.';
COMMENT ON COLUMN public.consent_events.request_fingerprint IS
    'SHA-256 of stable, normalized client decision semantics. Excludes IP, user-agent, and resolver policy so exact retries replay original evidence.';

DO $block$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_constraint
         WHERE conrelid = 'public.consent_events'::pg_catalog.regclass
           AND conname = 'consent_events_decision_fingerprint_pair'
    ) THEN
        ALTER TABLE public.consent_events
            ADD CONSTRAINT consent_events_decision_fingerprint_pair
            CHECK (
                (decision_id IS NULL AND request_fingerprint IS NULL) OR
                (decision_id IS NOT NULL AND
                 request_fingerprint ~ '^[0-9a-f]{64}$')
            ) NOT VALID;
    END IF;
END;
$block$;

CREATE OR REPLACE FUNCTION public.consent_events_decision_identity_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
    IF NEW.decision_id IS DISTINCT FROM OLD.decision_id OR
       NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint THEN
        RAISE EXCEPTION 'public consent decision identity is immutable'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.consent_events_decision_identity_immutable()
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consent_events_decision_identity_immutable()
    TO postwave_app;

DROP TRIGGER IF EXISTS aa_1979_consent_events_decision_identity_immutable
    ON public.consent_events;
CREATE TRIGGER aa_1979_consent_events_decision_identity_immutable
    BEFORE UPDATE ON public.consent_events
    FOR EACH ROW EXECUTE FUNCTION public.consent_events_decision_identity_immutable();

-- The read surface deliberately fails a whole page when one row violates its
-- evidence contract. Enforce that same contract at the database boundary so a
-- raw INSERT outside the Go package cannot create a new poison row. NOT VALID
-- avoids an unbounded deployment scan; validating these constraints against
-- historical rows remains an explicit pre-release data-quality gate.
CREATE OR REPLACE FUNCTION public.consent_evidence_unicode_trim(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
    -- Match Go strings.TrimSpace / Unicode White_Space exactly. PostgreSQL's
    -- one-argument btrim removes ASCII space only, which previously let NBSP
    -- and other Unicode-only whitespace poison strict read materialization.
    SELECT pg_catalog.btrim(
        value,
        U&'\0009\000A\000B\000C\000D\0020\0085\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000'
    )
$function$;

CREATE OR REPLACE FUNCTION public.consent_evidence_token_is_safe(
    value text,
    max_bytes integer
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
    SELECT value IS NULL OR value = '' OR (
        value = public.consent_evidence_unicode_trim(value) AND
        pg_catalog.octet_length(value) <= max_bytes AND
        pg_catalog.char_length(value) <= max_bytes AND
        value !~ '[[:cntrl:]]' AND
        pg_catalog.strpos(value, U&'\061C') = 0 AND
        pg_catalog.strpos(value, U&'\200E') = 0 AND
        pg_catalog.strpos(value, U&'\200F') = 0 AND
        pg_catalog.strpos(value, U&'\202A') = 0 AND
        pg_catalog.strpos(value, U&'\202B') = 0 AND
        pg_catalog.strpos(value, U&'\202C') = 0 AND
        pg_catalog.strpos(value, U&'\202D') = 0 AND
        pg_catalog.strpos(value, U&'\202E') = 0 AND
        pg_catalog.strpos(value, U&'\2066') = 0 AND
        pg_catalog.strpos(value, U&'\2067') = 0 AND
        pg_catalog.strpos(value, U&'\2068') = 0 AND
        pg_catalog.strpos(value, U&'\2069') = 0 AND
        pg_catalog.strpos(value, U&'\206A') = 0 AND
        pg_catalog.strpos(value, U&'\206B') = 0 AND
        pg_catalog.strpos(value, U&'\206C') = 0 AND
        pg_catalog.strpos(value, U&'\206D') = 0 AND
        pg_catalog.strpos(value, U&'\206E') = 0 AND
        pg_catalog.strpos(value, U&'\206F') = 0 AND
        pg_catalog.strpos(value, U&'\FEFF') = 0
    )
$function$;

CREATE OR REPLACE FUNCTION public.consent_evidence_narrative_is_safe(
    value text,
    max_bytes integer
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
    SELECT value IS NULL OR value = '' OR (
        public.consent_evidence_unicode_trim(value) <> '' AND
        pg_catalog.octet_length(value) <= max_bytes AND
        pg_catalog.char_length(value) <= max_bytes AND
        pg_catalog.strpos(value, U&'\061C') = 0 AND
        pg_catalog.strpos(value, U&'\200E') = 0 AND
        pg_catalog.strpos(value, U&'\200F') = 0 AND
        pg_catalog.strpos(value, U&'\202A') = 0 AND
        pg_catalog.strpos(value, U&'\202B') = 0 AND
        pg_catalog.strpos(value, U&'\202C') = 0 AND
        pg_catalog.strpos(value, U&'\202D') = 0 AND
        pg_catalog.strpos(value, U&'\202E') = 0 AND
        pg_catalog.strpos(value, U&'\2066') = 0 AND
        pg_catalog.strpos(value, U&'\2067') = 0 AND
        pg_catalog.strpos(value, U&'\2068') = 0 AND
        pg_catalog.strpos(value, U&'\2069') = 0 AND
        pg_catalog.strpos(value, U&'\206A') = 0 AND
        pg_catalog.strpos(value, U&'\206B') = 0 AND
        pg_catalog.strpos(value, U&'\206C') = 0 AND
        pg_catalog.strpos(value, U&'\206D') = 0 AND
        pg_catalog.strpos(value, U&'\206E') = 0 AND
        pg_catalog.strpos(value, U&'\206F') = 0 AND
        pg_catalog.strpos(value, U&'\FEFF') = 0
    )
$function$;

CREATE OR REPLACE FUNCTION public.consent_evidence_email_is_safe(value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
    SELECT public.consent_evidence_token_is_safe(value, 320) AND
           pg_catalog.length(value) - pg_catalog.length(pg_catalog.replace(value, '@', '')) = 1 AND
           pg_catalog.strpos(value, '@') > 1 AND
           pg_catalog.strpos(value, '@') < pg_catalog.length(value)
$function$;

CREATE OR REPLACE FUNCTION public.consent_evidence_timestamp_is_safe(
    value timestamptz
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
    -- time.Time's JSON/RFC3339 encoder accepts years 0000..9999, while
    -- PostgreSQL timestamptz also accepts infinities, BC dates, and years
    -- beyond four digits. PostgreSQL has no year zero, and the one remaining
    -- zero-value representation must be excluded because the strict reader
    -- treats it as missing chronology.
    SELECT value IS NOT NULL AND
           pg_catalog.isfinite(value) AND
           value > TIMESTAMPTZ '0001-01-01 00:00:00+00' AND
           value < TIMESTAMPTZ '10000-01-01 00:00:00+00'
$function$;

CREATE OR REPLACE FUNCTION public.consent_evidence_uuid_is_safe(value uuid)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
    -- Match google/uuid plus the strict desktop/mobile/OpenAPI identity shape:
    -- non-nil, RFC variant, and an assigned/accepted version from 1 through 8.
    SELECT value IS NOT NULL AND
           value <> '00000000-0000-0000-0000-000000000000'::uuid AND
           pg_catalog.substr(value::text, 15, 1) ~ '^[1-8]$' AND
           pg_catalog.substr(value::text, 20, 1) ~ '^[89ab]$'
$function$;

REVOKE ALL ON FUNCTION public.consent_evidence_unicode_trim(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.consent_evidence_token_is_safe(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.consent_evidence_narrative_is_safe(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.consent_evidence_email_is_safe(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.consent_evidence_timestamp_is_safe(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.consent_evidence_uuid_is_safe(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consent_evidence_unicode_trim(text) TO postwave_app;
GRANT EXECUTE ON FUNCTION public.consent_evidence_token_is_safe(text, integer) TO postwave_app;
GRANT EXECUTE ON FUNCTION public.consent_evidence_narrative_is_safe(text, integer) TO postwave_app;
GRANT EXECUTE ON FUNCTION public.consent_evidence_email_is_safe(text) TO postwave_app;
GRANT EXECUTE ON FUNCTION public.consent_evidence_timestamp_is_safe(timestamptz) TO postwave_app;
GRANT EXECUTE ON FUNCTION public.consent_evidence_uuid_is_safe(uuid) TO postwave_app;

ALTER TABLE public.consent_events
    ADD CONSTRAINT consent_events_read_contract_bounds
    CHECK (
        public.consent_evidence_uuid_is_safe(id) AND
        (decision_id IS NULL OR public.consent_evidence_uuid_is_safe(decision_id)) AND
        ((subject_id IS NOT NULL AND subject_id <> '') OR subject_email IS NOT NULL) AND
        public.consent_evidence_token_is_safe(subject_id, 512) AND
        (subject_email IS NULL OR public.consent_evidence_email_is_safe(subject_email::text)) AND
        source IS NOT NULL AND source <> '' AND
        public.consent_evidence_token_is_safe(source, 512) AND
        policy_version IS NOT NULL AND policy_version <> '' AND
        public.consent_evidence_token_is_safe(policy_version, 256) AND
        public.consent_evidence_narrative_is_safe(proof_text, 65536) AND
        public.consent_evidence_token_is_safe(user_agent, 2048) AND
        preferences IS NOT NULL AND
        pg_catalog.jsonb_typeof(preferences) = 'object' AND
        pg_catalog.octet_length(preferences::text) <= 65536 AND
        public.consent_evidence_timestamp_is_safe(created_at) AND
        public.consent_evidence_timestamp_is_safe(COALESCE(recorded_at, created_at))
    ) NOT VALID;

ALTER TABLE public.consent_receipts
    ADD CONSTRAINT consent_receipts_read_contract_bounds
    CHECK (
        id IS NOT NULL AND id > 0 AND
        subscriber_email IS NOT NULL AND
        public.consent_evidence_email_is_safe(subscriber_email) AND
        public.consent_evidence_token_is_safe(prev_state, 128) AND
        source IS NOT NULL AND source <> '' AND
        public.consent_evidence_token_is_safe(source, 512) AND
        public.consent_evidence_narrative_is_safe(source_detail, 16384) AND
        public.consent_evidence_token_is_safe(user_agent, 2048) AND
        public.consent_evidence_token_is_safe(privacy_policy_version, 256) AND
        public.consent_evidence_narrative_is_safe(captured_text, 65536) AND
        public.consent_evidence_timestamp_is_safe(at) AND
        public.consent_evidence_timestamp_is_safe(COALESCE(recorded_at, at))
    ) NOT VALID;

ALTER TABLE public.consent_records
    ADD CONSTRAINT consent_records_read_contract_bounds
    CHECK (
        public.consent_evidence_uuid_is_safe(id) AND
        email IS NOT NULL AND
        public.consent_evidence_email_is_safe(email::text) AND
        source IS NOT NULL AND source <> '' AND
        public.consent_evidence_token_is_safe(source, 512) AND
        public.consent_evidence_narrative_is_safe(source_url, 16384) AND
        public.consent_evidence_token_is_safe(user_agent, 2048) AND
        evidence IS NOT NULL AND
        pg_catalog.octet_length(evidence::text) <= 65536 AND
        public.consent_evidence_timestamp_is_safe(captured_at) AND
        public.consent_evidence_timestamp_is_safe(COALESCE(recorded_at, created_at))
    ) NOT VALID;

-- The original 0140 policy allowed every transaction carrying the generic
-- outbox-worker GUC to enumerate and insert receipts for every tenant. No
-- consent-receipt worker requires that authority. Pair a restrictive predicate
-- with the normal permissive app policy so missing/foreign tenant scope is
-- denied even if an unrelated worker capability is present.
DROP POLICY IF EXISTS tenant_visible ON public.consent_receipts;
DROP POLICY IF EXISTS consent_receipts_tenant_isolation
    ON public.consent_receipts;
CREATE POLICY consent_receipts_tenant_isolation
    ON public.consent_receipts AS RESTRICTIVE FOR ALL TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

CREATE POLICY tenant_visible
    ON public.consent_receipts AS PERMISSIVE FOR ALL TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

ALTER TABLE public.consent_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.consent_receipts FORCE ROW LEVEL SECURITY;

COMMIT;

-- These ledgers can be large. Build the snapshot/keyset access paths online;
-- never backfill or lock the entire evidence history during deploy.
SET lock_timeout = '5s';
SET statement_timeout = '30min';

CREATE INDEX CONCURRENTLY IF NOT EXISTS consent_receipts_recorded_page_idx
    ON public.consent_receipts (
        tenant_id,
        (COALESCE(recorded_at, at)) DESC,
        id DESC
    );

CREATE INDEX CONCURRENTLY IF NOT EXISTS consent_records_recorded_page_idx
    ON public.consent_records (
        tenant_id,
        (COALESCE(recorded_at, created_at)) DESC,
        id DESC
    );

CREATE INDEX CONCURRENTLY IF NOT EXISTS consent_events_recorded_page_idx
    ON public.consent_events (
        tenant_id,
        (COALESCE(recorded_at, created_at)) DESC,
        id DESC
    );

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS consent_events_decision_category_uidx
    ON public.consent_events (tenant_id, decision_id, category)
    WHERE decision_id IS NOT NULL;

RESET statement_timeout;
RESET lock_timeout;
