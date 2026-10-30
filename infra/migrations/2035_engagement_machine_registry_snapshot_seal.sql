-- 2035_engagement_machine_registry_snapshot_seal.sql
--
-- A registry-version string was previously only a row prefix. Migration 1976
-- appended twelve rows under the v1 name created by migration 1934, and the
-- application writer could append another row later while keeping the same
-- configuration/calibration identity. This migration makes one registry
-- version mean one complete, immutable, hash-addressed snapshot.
--
-- Historical v1 is hash-recorded only as the ledger state observed at this
-- migration; it remains provenance-ambiguous, is not an admissible sealed
-- snapshot, and cannot be used for new classifications, methodology,
-- calibration, or reach release. Canonical v2 and future versions published by
-- the governed whole-set function are `sealed_snapshot` evidence.
--
-- rollback-strategy: no-op. Removing the manifest, foreign key, or sealed-row
-- guards would let an old calibration authorize a different rule set.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

LOCK TABLE public.engagement_machine_registry_entries
    IN SHARE ROW EXCLUSIVE MODE;

-- These helper names are new in this migration. Remove untrusted schema-create
-- authority before declaring them, then use CREATE (not OR REPLACE) so an
-- object squatted by an older cluster configuration aborts the migration
-- instead of preserving an attacker's ownership and ACL.
REVOKE CREATE ON SCHEMA public FROM PUBLIC, postwave_app, postwave_public;

CREATE TABLE public.engagement_machine_registry_versions (
    registry_version        text PRIMARY KEY CHECK (
                                registry_version ~ '^[a-z0-9][a-z0-9_.-]{0,95}$'
                            ),
    entry_count             integer NOT NULL CHECK (entry_count BETWEEN 1 AND 4096),
    snapshot_schema_version text NOT NULL CHECK (
                                snapshot_schema_version =
                                'postwave.machine-source-registry-snapshot.v1'
                            ),
    snapshot_fingerprint    text NOT NULL UNIQUE CHECK (
                                snapshot_fingerprint ~ '^[0-9a-f]{64}$'
                            ),
    provenance_state        text NOT NULL CHECK (provenance_state IN (
                                'legacy_append_ambiguous', 'sealed_snapshot'
                            )),
    publication_kind        text NOT NULL CHECK (publication_kind IN (
                                'migration_backfill', 'migration_canonical',
                                'governed_function'
                            )),
    sealed_at               timestamptz NOT NULL DEFAULT clock_timestamp()
);

COMMENT ON TABLE public.engagement_machine_registry_versions IS
    'Append-only whole-snapshot manifest. A sealed_snapshot version has one C-ordered hash over every immutable entry fingerprint; legacy_append_ambiguous is inspectable evidence but cannot authorize new classifier output.';

CREATE FUNCTION public.engagement_machine_registry_entry_fingerprint(
    p_registry_version text,
    p_entry_id text,
    p_matcher_type text,
    p_matcher_value text,
    p_machine_subtype text,
    p_confidence numeric,
    p_source_note text,
    p_last_verified date
)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public, pg_temp
AS $function$
    SELECT pg_catalog.encode(
        public.digest(
            pg_catalog.convert_to(
                pg_catalog.concat_ws(E'\x1f',
                    p_registry_version,
                    p_entry_id,
                    p_matcher_type,
                    p_matcher_value,
                    p_machine_subtype,
                    trim(
                        trailing '.' from trim(
                            trailing '0' from p_confidence::numeric(5,4)::text
                        )
                    ),
                    p_source_note,
                    pg_catalog.lpad(extract(year FROM p_last_verified)::integer::text, 4, '0') ||
                        '-' || pg_catalog.lpad(extract(month FROM p_last_verified)::integer::text, 2, '0') ||
                        '-' || pg_catalog.lpad(extract(day FROM p_last_verified)::integer::text, 2, '0')
                ),
                'UTF8'
            ),
            'sha256'
        ),
        'hex'
    )
$function$;

CREATE FUNCTION public.engagement_machine_registry_snapshot(
    p_registry_version text
)
RETURNS TABLE (
    entry_count integer,
    snapshot_fingerprint text
)
LANGUAGE sql
STABLE
STRICT
SET search_path = pg_catalog, public, pg_temp
ROWS 1
AS $function$
    WITH snapshot_rows AS (
        SELECT entry.entry_id, entry.entry_fingerprint
          FROM public.engagement_machine_registry_entries AS entry
         WHERE entry.registry_version = p_registry_version
    ), aggregated AS (
        SELECT pg_catalog.count(*)::integer AS entry_count,
               pg_catalog.string_agg(
                   entry_id || E'\x1f' || entry_fingerprint,
                   E'\x1e'
                   ORDER BY entry_id COLLATE "C"
               ) AS joined_entries
          FROM snapshot_rows
    )
    SELECT aggregated.entry_count,
           pg_catalog.encode(
               public.digest(
                   pg_catalog.convert_to(
                       pg_catalog.concat_ws(E'\x1f',
                           'postwave.machine-source-registry-snapshot.v1',
                           p_registry_version,
                           aggregated.entry_count::text,
                           coalesce(aggregated.joined_entries, '')
                       ),
                       'UTF8'
                   ),
                   'sha256'
               ),
               'hex'
           )
      FROM aggregated
$function$;

CREATE FUNCTION public.engagement_machine_registry_manifest_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $guard$
DECLARE
    actual_count integer;
    actual_fingerprint text;
BEGIN
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
            'engagement-machine-registry:' || NEW.registry_version,
            0
        )
    );

    IF NEW.provenance_state = 'legacy_append_ambiguous' AND (
        NEW.registry_version <> 'postwave.machine-source-registry.v1' OR
        NEW.publication_kind <> 'migration_backfill'
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '22023',
            MESSAGE = 'legacy registry provenance is reserved for the observed v1 ledger';
    END IF;

    IF NEW.provenance_state = 'sealed_snapshot' AND EXISTS (
        SELECT 1
          FROM public.engagement_machine_registry_entries AS entry
         WHERE entry.registry_version = NEW.registry_version
           AND entry.entry_fingerprint <>
               public.engagement_machine_registry_entry_fingerprint(
                   entry.registry_version,
                   entry.entry_id,
                   entry.matcher_type,
                   entry.matcher_value,
                   entry.machine_subtype,
                   entry.confidence,
                   entry.source_note,
                   entry.last_verified
               )
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '22023',
            MESSAGE = 'machine registry contains an invalid entry fingerprint';
    END IF;

    SELECT snapshot.entry_count, snapshot.snapshot_fingerprint
      INTO actual_count, actual_fingerprint
      FROM public.engagement_machine_registry_snapshot(NEW.registry_version)
           AS snapshot;

    IF actual_count IS DISTINCT FROM NEW.entry_count OR
       actual_fingerprint IS DISTINCT FROM NEW.snapshot_fingerprint THEN
        RAISE EXCEPTION USING
            ERRCODE = '22023',
            MESSAGE = 'machine registry manifest does not match its complete snapshot';
    END IF;
    RETURN NEW;
END
$guard$;

CREATE TRIGGER engagement_machine_registry_versions_manifest_guard
    BEFORE INSERT ON public.engagement_machine_registry_versions
    FOR EACH ROW
    EXECUTE FUNCTION public.engagement_machine_registry_manifest_guard();

DO $canonical$
DECLARE
    versions text[];
    v1_count integer;
    v2_count integer;
    v2_fingerprint text;
BEGIN
    SELECT pg_catalog.array_agg(
               registry_version
               ORDER BY registry_version COLLATE "C"
           )
      INTO versions
      FROM (
          SELECT DISTINCT registry_version
            FROM public.engagement_machine_registry_entries
      ) AS registry_versions;
    IF versions IS DISTINCT FROM ARRAY[
        'postwave.machine-source-registry.v1',
        'postwave.machine-source-registry.v2'
    ]::text[] THEN
        RAISE EXCEPTION 'unexpected pre-seal machine registry versions: %', versions;
    END IF;

    SELECT entry_count
      INTO v1_count
      FROM public.engagement_machine_registry_snapshot(
          'postwave.machine-source-registry.v1'
      );
    SELECT entry_count, snapshot_fingerprint
      INTO v2_count, v2_fingerprint
      FROM public.engagement_machine_registry_snapshot(
          'postwave.machine-source-registry.v2'
      );

    IF v1_count <> 18 THEN
        RAISE EXCEPTION 'legacy v1 observed-state row count drifted: count %',
            v1_count;
    END IF;
    IF v2_count <> 18 OR
       v2_fingerprint <> '91cfb8bdc5a837e4fa90809b84ab0e125b8410930dae0b631dcf01566567db1b' THEN
        RAISE EXCEPTION 'canonical v2 sealed snapshot drifted: count %, fingerprint %',
            v2_count, v2_fingerprint;
    END IF;
END
$canonical$;

INSERT INTO public.engagement_machine_registry_versions (
    registry_version,
    entry_count,
    snapshot_schema_version,
    snapshot_fingerprint,
    provenance_state,
    publication_kind
) VALUES
    (
        'postwave.machine-source-registry.v1',
        18,
        'postwave.machine-source-registry-snapshot.v1',
        (
            SELECT snapshot_fingerprint
              FROM public.engagement_machine_registry_snapshot(
                  'postwave.machine-source-registry.v1'
              )
        ),
        'legacy_append_ambiguous',
        'migration_backfill'
    ),
    (
        'postwave.machine-source-registry.v2',
        18,
        'postwave.machine-source-registry-snapshot.v1',
        '91cfb8bdc5a837e4fa90809b84ab0e125b8410930dae0b631dcf01566567db1b',
        'sealed_snapshot',
        'migration_canonical'
    );

CREATE FUNCTION public.engagement_machine_registry_entry_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $guard$
BEGIN
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
            'engagement-machine-registry:' || NEW.registry_version,
            0
        )
    );
    IF EXISTS (
        SELECT 1
          FROM public.engagement_machine_registry_versions AS version
         WHERE version.registry_version = NEW.registry_version
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = 'PWR01',
            MESSAGE = 'machine registry version is already sealed';
    END IF;
    RETURN NEW;
END
$guard$;

CREATE TRIGGER engagement_machine_registry_entries_sealed_insert_guard
    BEFORE INSERT ON public.engagement_machine_registry_entries
    FOR EACH ROW
    EXECUTE FUNCTION public.engagement_machine_registry_entry_insert_guard();

CREATE TRIGGER engagement_machine_registry_versions_append_only
    BEFORE UPDATE OR DELETE ON public.engagement_machine_registry_versions
    FOR EACH ROW
    EXECUTE FUNCTION public.engagement_evidence_append_only_guard();

ALTER TABLE public.engagement_machine_registry_entries
    ADD CONSTRAINT engagement_machine_registry_entries_sealed_version_fk
    FOREIGN KEY (registry_version)
    REFERENCES public.engagement_machine_registry_versions (registry_version)
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
    NOT VALID;

ALTER TABLE public.engagement_machine_registry_entries
    VALIDATE CONSTRAINT engagement_machine_registry_entries_sealed_version_fk;

ALTER TABLE public.engagement_classifier_methodology_versions
    ADD CONSTRAINT engagement_classifier_methodology_registry_manifest_fk
    FOREIGN KEY (registry_version)
    REFERENCES public.engagement_machine_registry_versions (registry_version)
    ON DELETE RESTRICT
    NOT VALID;

ALTER TABLE public.engagement_classifier_methodology_versions
    VALIDATE CONSTRAINT engagement_classifier_methodology_registry_manifest_fk;

CREATE FUNCTION public.require_sealed_engagement_machine_registry()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $guard$
DECLARE
    state text;
BEGIN
    SELECT version.provenance_state
      INTO state
      FROM public.engagement_machine_registry_versions AS version
     WHERE version.registry_version = NEW.registry_version;
    IF state IS DISTINCT FROM 'sealed_snapshot' THEN
        RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'classifier lineage requires a sealed registry snapshot';
    END IF;
    RETURN NEW;
END
$guard$;

CREATE TRIGGER engagement_classifier_methodology_sealed_registry
    BEFORE INSERT ON public.engagement_classifier_methodology_versions
    FOR EACH ROW
    EXECUTE FUNCTION public.require_sealed_engagement_machine_registry();

CREATE TRIGGER engagement_classifier_calibration_sealed_registry
    BEFORE INSERT ON public.engagement_classifier_calibration_reports
    FOR EACH ROW
    EXECUTE FUNCTION public.require_sealed_engagement_machine_registry();

CREATE TRIGGER event_classifications_sealed_registry
    BEFORE INSERT ON public.event_classifications
    FOR EACH ROW
    EXECUTE FUNCTION public.require_sealed_engagement_machine_registry();

CREATE TRIGGER engagement_reach_cutover_sealed_registry
    BEFORE INSERT ON public.engagement_classifier_reach_cutover_approvals
    FOR EACH ROW
    EXECUTE FUNCTION public.require_sealed_engagement_machine_registry();

DO $role$
DECLARE
    publisher pg_catalog.pg_roles%ROWTYPE;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles
         WHERE rolname = 'postwave_registry_publisher'
    ) THEN
        CREATE ROLE postwave_registry_publisher
            NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
            NOREPLICATION NOBYPASSRLS;
    END IF;

    SELECT * INTO publisher
      FROM pg_catalog.pg_roles
     WHERE rolname = 'postwave_registry_publisher';
    IF publisher.rolcanlogin OR publisher.rolsuper OR publisher.rolcreatedb OR
       publisher.rolcreaterole OR publisher.rolinherit OR
       publisher.rolreplication OR publisher.rolbypassrls THEN
        RAISE EXCEPTION 'postwave_registry_publisher has unsafe role attributes';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_auth_members
         WHERE member = publisher.oid OR roleid = publisher.oid
    ) THEN
        RAISE EXCEPTION 'postwave_registry_publisher must have no memberships or members';
    END IF;
END
$role$;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
    FROM postwave_registry_publisher;
GRANT USAGE, CREATE ON SCHEMA public
    TO postwave_registry_publisher;
GRANT SELECT, INSERT ON public.engagement_machine_registry_entries
    TO postwave_registry_publisher;
GRANT SELECT, INSERT ON public.engagement_machine_registry_versions
    TO postwave_registry_publisher;

ALTER TABLE public.engagement_machine_registry_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.engagement_machine_registry_versions FORCE ROW LEVEL SECURITY;

CREATE POLICY engagement_machine_registry_versions_worker_select
    ON public.engagement_machine_registry_versions
    FOR SELECT TO postwave_app
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.engagement_classifier_worker', true) = 'true'
    );
CREATE POLICY engagement_machine_registry_versions_publisher_select
    ON public.engagement_machine_registry_versions
    FOR SELECT TO postwave_registry_publisher
    USING (true);
CREATE POLICY engagement_machine_registry_versions_publisher_insert
    ON public.engagement_machine_registry_versions
    FOR INSERT TO postwave_registry_publisher
    WITH CHECK (true);
CREATE POLICY engagement_machine_registry_entries_publisher_select
    ON public.engagement_machine_registry_entries
    FOR SELECT TO postwave_registry_publisher
    USING (true);
CREATE POLICY engagement_machine_registry_entries_publisher_insert
    ON public.engagement_machine_registry_entries
    FOR INSERT TO postwave_registry_publisher
    WITH CHECK (true);

DROP POLICY IF EXISTS engagement_machine_registry_worker_insert
    ON public.engagement_machine_registry_entries;
REVOKE INSERT ON public.engagement_machine_registry_entries FROM postwave_app;
GRANT SELECT ON public.engagement_machine_registry_versions TO postwave_app;

CREATE FUNCTION public.publish_engagement_machine_registry(
    p_registry_version text,
    p_entries jsonb
)
RETURNS TABLE (
    published_entry_count integer,
    published_snapshot_fingerprint text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    proposed_count integer;
    proposed_fingerprint text;
    existing_count integer;
    existing_fingerprint text;
    existing_state text;
BEGIN
    IF p_registry_version IS NULL OR
       p_registry_version !~ '^[a-z0-9][a-z0-9_.-]{0,95}$' THEN
        RAISE EXCEPTION USING
            ERRCODE = '22023',
            MESSAGE = 'machine registry version is invalid';
    END IF;
    IF p_entries IS NULL OR pg_catalog.jsonb_typeof(p_entries) <> 'array' THEN
        RAISE EXCEPTION USING
            ERRCODE = '22023',
            MESSAGE = 'machine registry publication must be a JSON array';
    END IF;
    IF pg_catalog.octet_length(p_entries::text) > 16777216 THEN
        RAISE EXCEPTION USING
            ERRCODE = '22023',
            MESSAGE = 'machine registry publication exceeds 16 MiB';
    END IF;
    proposed_count := pg_catalog.jsonb_array_length(p_entries);
    IF proposed_count < 1 OR proposed_count > 4096 THEN
        RAISE EXCEPTION USING
            ERRCODE = '22023',
            MESSAGE = 'machine registry publication size is outside 1..4096';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM pg_catalog.jsonb_array_elements(p_entries) AS item(value)
         WHERE pg_catalog.jsonb_typeof(item.value) <> 'object'
            OR (
                SELECT pg_catalog.array_agg(key ORDER BY key COLLATE "C")
                  FROM pg_catalog.jsonb_object_keys(item.value) AS keys(key)
            ) IS DISTINCT FROM ARRAY[
                'confidence', 'entry_id', 'last_verified',
                'machine_subtype', 'matcher_type', 'matcher_value',
                'source_note'
            ]::text[]
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '22023',
            MESSAGE = 'machine registry entry keys are invalid';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM pg_catalog.jsonb_array_elements(p_entries) AS item(value)
         WHERE pg_catalog.jsonb_typeof(item.value->'entry_id') <> 'string'
            OR pg_catalog.jsonb_typeof(item.value->'matcher_type') <> 'string'
            OR pg_catalog.jsonb_typeof(item.value->'matcher_value') <> 'string'
            OR pg_catalog.jsonb_typeof(item.value->'machine_subtype') <> 'string'
            OR pg_catalog.jsonb_typeof(item.value->'confidence') <> 'number'
            OR pg_catalog.jsonb_typeof(item.value->'source_note') <> 'string'
            OR pg_catalog.jsonb_typeof(item.value->'last_verified') <> 'string'
            OR item.value->>'entry_id' !~ '^R_[A-Z0-9_]{2,94}$'
            OR item.value->>'matcher_type' NOT IN (
                'asn', 'cidr', 'ua_substring', 'ua_regex',
                'reverse_dns_suffix', 'provider_flag', 'source'
            )
            OR pg_catalog.octet_length(item.value->>'matcher_value') NOT BETWEEN 1 AND 1000
            OR item.value->>'matcher_value' <>
               pg_catalog.btrim(item.value->>'matcher_value')
            OR item.value->>'matcher_value' ~
               '(^[[:space:]])|([[:space:]]$)'
            OR item.value->>'matcher_value' ~ '[[:cntrl:]]'
            OR item.value->>'machine_subtype' NOT IN (
                'apple_mpp', 'gmail_proxy', 'outlook_safelinks',
                'seg_scanner', 'prefetcher', 'seed_automation',
                'link_checker', 'ai_summarizer', 'unknown_bot'
            )
            OR (item.value->>'confidence')::numeric < 0
            OR (item.value->>'confidence')::numeric > 1
            OR (item.value->>'confidence')::numeric <>
               pg_catalog.round((item.value->>'confidence')::numeric, 4)
            OR pg_catalog.octet_length(item.value->>'source_note') NOT BETWEEN 1 AND 2000
            OR item.value->>'source_note' <> pg_catalog.btrim(item.value->>'source_note')
            OR item.value->>'source_note' ~
               '(^[[:space:]])|([[:space:]]$)'
            OR item.value->>'source_note' ~ '[[:cntrl:]]'
            OR item.value->>'last_verified' !~ '^\d{4}-\d{2}-\d{2}$'
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '22023',
            MESSAGE = 'machine registry entry values are invalid';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM pg_catalog.jsonb_array_elements(p_entries) AS item(value)
         GROUP BY item.value->>'entry_id'
        HAVING pg_catalog.count(*) > 1
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '22023',
            MESSAGE = 'machine registry publication contains a duplicate entry id';
    END IF;

    WITH normalized AS (
        SELECT item.value->>'entry_id' AS entry_id,
               item.value->>'matcher_type' AS matcher_type,
               item.value->>'matcher_value' AS matcher_value,
               item.value->>'machine_subtype' AS machine_subtype,
               (item.value->>'confidence')::numeric(5,4) AS confidence,
               item.value->>'source_note' AS source_note,
               (item.value->>'last_verified')::date AS last_verified
          FROM pg_catalog.jsonb_array_elements(p_entries) AS item(value)
    ), fingerprinted AS (
        SELECT normalized.*,
               public.engagement_machine_registry_entry_fingerprint(
                   p_registry_version,
                   normalized.entry_id,
                   normalized.matcher_type,
                   normalized.matcher_value,
                   normalized.machine_subtype,
                   normalized.confidence,
                   normalized.source_note,
                   normalized.last_verified
               ) AS entry_fingerprint
          FROM normalized
    )
    SELECT pg_catalog.count(*)::integer,
           pg_catalog.encode(
               public.digest(
                   pg_catalog.convert_to(
                       pg_catalog.concat_ws(E'\x1f',
                           'postwave.machine-source-registry-snapshot.v1',
                           p_registry_version,
                           pg_catalog.count(*)::text,
                           pg_catalog.string_agg(
                               entry_id || E'\x1f' || entry_fingerprint,
                               E'\x1e'
                               ORDER BY entry_id COLLATE "C"
                           )
                       ),
                       'UTF8'
                   ),
                   'sha256'
               ),
               'hex'
           )
      INTO proposed_count, proposed_fingerprint
      FROM fingerprinted;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
            'engagement-machine-registry:' || p_registry_version,
            0
        )
    );

    SELECT version.entry_count,
           version.snapshot_fingerprint,
           version.provenance_state
      INTO existing_count, existing_fingerprint, existing_state
      FROM public.engagement_machine_registry_versions AS version
     WHERE version.registry_version = p_registry_version;
    IF FOUND THEN
        IF existing_state = 'sealed_snapshot' AND
           existing_count = proposed_count AND
           existing_fingerprint = proposed_fingerprint THEN
            RETURN QUERY SELECT existing_count, existing_fingerprint;
            RETURN;
        END IF;
        RAISE EXCEPTION USING
            ERRCODE = 'PWR01',
            MESSAGE = 'machine registry version conflicts with a sealed snapshot';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM public.engagement_machine_registry_entries AS entry
         WHERE entry.registry_version = p_registry_version
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = 'PWR01',
            MESSAGE = 'machine registry version has an incomplete unsealed publication';
    END IF;

    -- The caller controls the transaction's current constraint mode. Restore
    -- this publication edge to its required deferred mode explicitly so an
    -- earlier SET CONSTRAINTS ALL IMMEDIATE cannot make the governed API fail
    -- merely because entries are inserted before their sealed manifest.
    SET CONSTRAINTS engagement_machine_registry_entries_sealed_version_fk DEFERRED;

    INSERT INTO public.engagement_machine_registry_entries (
        registry_version,
        entry_id,
        matcher_type,
        matcher_value,
        machine_subtype,
        confidence,
        source_note,
        last_verified,
        entry_fingerprint
    )
    SELECT p_registry_version,
           item.value->>'entry_id',
           item.value->>'matcher_type',
           item.value->>'matcher_value',
           item.value->>'machine_subtype',
           (item.value->>'confidence')::numeric(5,4),
           item.value->>'source_note',
           (item.value->>'last_verified')::date,
           public.engagement_machine_registry_entry_fingerprint(
               p_registry_version,
               item.value->>'entry_id',
               item.value->>'matcher_type',
               item.value->>'matcher_value',
               item.value->>'machine_subtype',
               (item.value->>'confidence')::numeric(5,4),
               item.value->>'source_note',
               (item.value->>'last_verified')::date
           )
      FROM pg_catalog.jsonb_array_elements(p_entries) AS item(value);

    INSERT INTO public.engagement_machine_registry_versions (
        registry_version,
        entry_count,
        snapshot_schema_version,
        snapshot_fingerprint,
        provenance_state,
        publication_kind
    ) VALUES (
        p_registry_version,
        proposed_count,
        'postwave.machine-source-registry-snapshot.v1',
        proposed_fingerprint,
        'sealed_snapshot',
        'governed_function'
    );

    RETURN QUERY SELECT proposed_count, proposed_fingerprint;
END
$function$;

ALTER FUNCTION public.publish_engagement_machine_registry(text, jsonb)
    OWNER TO postwave_registry_publisher;
REVOKE CREATE ON SCHEMA public FROM postwave_registry_publisher;
REVOKE ALL ON FUNCTION public.publish_engagement_machine_registry(text, jsonb)
    FROM PUBLIC, postwave_public;
GRANT EXECUTE ON FUNCTION public.publish_engagement_machine_registry(text, jsonb)
    TO postwave_app;

DO $audit$
BEGIN
    IF pg_catalog.has_schema_privilege('public', 'public', 'CREATE') OR
       pg_catalog.has_schema_privilege('postwave_app', 'public', 'CREATE') OR
       pg_catalog.has_schema_privilege('postwave_public', 'public', 'CREATE') THEN
        RAISE EXCEPTION 'untrusted role retained schema CREATE';
    END IF;
    IF pg_catalog.has_schema_privilege(
        'postwave_registry_publisher', 'public', 'CREATE'
    ) THEN
        RAISE EXCEPTION 'registry publisher retained schema CREATE';
    END IF;
    IF pg_catalog.has_table_privilege(
        'postwave_app',
        'public.engagement_machine_registry_entries',
        'INSERT'
    ) THEN
        RAISE EXCEPTION 'postwave_app retained raw registry INSERT';
    END IF;
    IF NOT pg_catalog.has_function_privilege(
        'postwave_app',
        'public.publish_engagement_machine_registry(text,jsonb)',
        'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
        'postwave_public',
        'public.publish_engagement_machine_registry(text,jsonb)',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'registry publisher EXECUTE grants are unsafe';
    END IF;
END
$audit$;

COMMIT;
