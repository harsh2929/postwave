-- Rolling-deploy compatibility for the two historical merge-field stores.
-- migration-execution: phased
--
-- subscribers.merge_fields is used by imports, bulk/profile updates, search,
-- exports, and rendering. merge_field_values is the schema editor's typed
-- sidecar. Older application instances can still write the sidecar directly,
-- while newer and compatibility paths write canonical JSONB. These small,
-- changed-key triggers mirror writes in both directions and use a shared
-- per-(tenant,key) advisory lock plus schema row lock. Schema mutations take
-- the exclusive form of the same lock in application code and in the database
-- guard below.
--
-- This migration intentionally performs no global data rewrite. Existing
-- canonical/sidecar disagreement is ambiguous and must not be "reconciled" by
-- resurrecting a possibly deleted value, so a strict preflight blocks rollout
-- until an operator-reviewed reconciliation reports zero drift.
-- rollback-strategy: no-op - removing compatibility triggers can reintroduce stale-value resurrection during a rolling deploy.

BEGIN;

-- Do not queue a production outage behind a long-running transaction. The
-- migration runner can retry this additive migration after the hot-table DDL
-- lock becomes available or during the reviewed maintenance window.
SET LOCAL lock_timeout = '5s';

ALTER TABLE subscribers
    DROP CONSTRAINT IF EXISTS subscribers_merge_fields_object_check;

ALTER TABLE subscribers
    ADD CONSTRAINT subscribers_merge_fields_object_check
    CHECK (jsonb_typeof(merge_fields) = 'object') NOT VALID;

ALTER TABLE merge_field_values
    DROP CONSTRAINT IF EXISTS merge_field_values_tenant_subscriber_fkey;

ALTER TABLE merge_field_values
    ADD CONSTRAINT merge_field_values_tenant_subscriber_fkey
    FOREIGN KEY (tenant_id, subscriber_id)
    REFERENCES subscribers (tenant_id, id)
    ON DELETE CASCADE
    NOT VALID;

CREATE OR REPLACE FUNCTION merge_field_advisory_key(p_tenant_id uuid, p_key text)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
    SELECT hashtextextended(p_tenant_id::text || ':' || upper(btrim(p_key)), 0);
$$;

CREATE OR REPLACE FUNCTION validate_declared_merge_field_value(
    p_key text,
    p_type text,
    p_required boolean,
    p_raw_value jsonb
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
DECLARE
    value_kind text := jsonb_typeof(p_raw_value);
    normalized_value text;
    parsed_date date;
BEGIN
    IF p_raw_value IS NULL OR value_kind = 'null' THEN
        normalized_value := '';
    ELSIF value_kind = 'string' THEN
        normalized_value := btrim(p_raw_value #>> '{}');
    ELSIF value_kind IN ('number', 'boolean') THEN
        normalized_value := p_raw_value::text;
    ELSE
        RAISE EXCEPTION USING
            ERRCODE = 'PW001',
            MESSAGE = format('merge field %s must be a scalar value', p_key);
    END IF;

    IF char_length(normalized_value) > 4096 THEN
        RAISE EXCEPTION USING
            ERRCODE = 'PW001',
            MESSAGE = format('merge field %s exceeds 4096 characters', p_key);
    END IF;

    IF normalized_value = '' THEN
        IF p_required THEN
            RAISE EXCEPTION USING
                ERRCODE = 'PW001',
                MESSAGE = format('required merge field %s cannot be empty', p_key);
        END IF;
        RETURN '';
    END IF;

    IF p_type IN ('text', 'address', 'phone') AND value_kind <> 'string' THEN
        RAISE EXCEPTION USING
            ERRCODE = 'PW001',
            MESSAGE = format('merge field %s must be text', p_key);
    ELSIF p_type = 'number' THEN
        IF lower(normalized_value) IN (
            'nan', 'infinity', '+infinity', '-infinity',
            'inf', '+inf', '-inf'
        ) THEN
            RAISE EXCEPTION USING
                ERRCODE = 'PW001',
                MESSAGE = format('merge field %s must be a finite number', p_key);
        END IF;
        BEGIN
            PERFORM normalized_value::double precision;
        EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN
            RAISE EXCEPTION USING
                ERRCODE = 'PW001',
                MESSAGE = format('merge field %s must be a finite number', p_key);
        END;
    ELSIF p_type = 'boolean' AND normalized_value NOT IN ('true', 'false') THEN
        RAISE EXCEPTION USING
            ERRCODE = 'PW001',
            MESSAGE = format('merge field %s must be true or false', p_key);
    ELSIF p_type = 'date' THEN
        IF normalized_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
            RAISE EXCEPTION USING
                ERRCODE = 'PW001',
                MESSAGE = format('merge field %s must use YYYY-MM-DD', p_key);
        END IF;
        BEGIN
            parsed_date := make_date(
                substring(normalized_value FROM 1 FOR 4)::integer,
                substring(normalized_value FROM 6 FOR 2)::integer,
                substring(normalized_value FROM 9 FOR 2)::integer
            );
        EXCEPTION WHEN datetime_field_overflow THEN
            RAISE EXCEPTION USING
                ERRCODE = 'PW001',
                MESSAGE = format('merge field %s must be a real calendar date', p_key);
        END;
        IF to_char(parsed_date, 'YYYY-MM-DD') <> normalized_value THEN
            RAISE EXCEPTION USING
                ERRCODE = 'PW001',
                MESSAGE = format('merge field %s must be a real calendar date', p_key);
        END IF;
    END IF;

    RETURN normalized_value;
END;
$$;

CREATE OR REPLACE FUNCTION normalize_subscriber_merge_fields()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    old_fields jsonb := '{}'::jsonb;
    new_fields jsonb := COALESCE(NEW.merge_fields, '{}'::jsonb);
    changed_key text;
    declared_type text;
    is_required boolean;
    normalized_value text;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        old_fields := COALESCE(OLD.merge_fields, '{}'::jsonb);
    END IF;

    FOR changed_key IN
        SELECT changed.key
          FROM (
              SELECT jsonb_object_keys(old_fields) AS key
              UNION
              SELECT jsonb_object_keys(new_fields) AS key
          ) changed
         WHERE old_fields -> changed.key IS DISTINCT FROM new_fields -> changed.key
         ORDER BY changed.key
    LOOP
        declared_type := NULL;
        is_required := false;
        SELECT schema.type, schema.required
          INTO declared_type, is_required
          FROM merge_field_schema schema
         WHERE schema.tenant_id = NEW.tenant_id
           AND schema.key = changed_key
         FOR SHARE;
        IF NOT FOUND THEN
            PERFORM pg_advisory_xact_lock_shared(
                merge_field_advisory_key(NEW.tenant_id, changed_key)
            );
            SELECT schema.type, schema.required
              INTO declared_type, is_required
              FROM merge_field_schema schema
             WHERE schema.tenant_id = NEW.tenant_id
               AND schema.key = changed_key
             FOR SHARE;
        ELSE
            PERFORM pg_advisory_xact_lock_shared(
                merge_field_advisory_key(NEW.tenant_id, changed_key)
            );
        END IF;
        IF NOT FOUND THEN
            CONTINUE;
        END IF;

        normalized_value := validate_declared_merge_field_value(
            changed_key,
            declared_type,
            is_required,
            new_fields -> changed_key
        );
        IF normalized_value = '' THEN
            new_fields := new_fields - changed_key;
        END IF;
    END LOOP;

    NEW.merge_fields := new_fields;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION sync_subscriber_merge_field_sidecar()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    old_fields jsonb := '{}'::jsonb;
    new_fields jsonb := COALESCE(NEW.merge_fields, '{}'::jsonb);
    changed_key text;
    declared_type text;
    is_required boolean;
    normalized_value text;
BEGIN
    -- A sidecar-originated compatibility write already owns synchronization.
    IF pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' THEN
        old_fields := COALESCE(OLD.merge_fields, '{}'::jsonb);
    END IF;

    FOR changed_key IN
        SELECT changed.key
          FROM (
              SELECT jsonb_object_keys(old_fields) AS key
              UNION
              SELECT jsonb_object_keys(new_fields) AS key
          ) changed
         WHERE old_fields -> changed.key IS DISTINCT FROM new_fields -> changed.key
         ORDER BY changed.key
    LOOP
        declared_type := NULL;
        is_required := false;
        SELECT schema.type, schema.required
          INTO declared_type, is_required
          FROM merge_field_schema schema
         WHERE schema.tenant_id = NEW.tenant_id
           AND schema.key = changed_key
         FOR SHARE;
        IF NOT FOUND THEN
            -- A concurrent schema create cannot be row-locked before the row
            -- exists. Share-lock the stable key, then recheck after any creator
            -- holding the exclusive form has committed.
            PERFORM pg_advisory_xact_lock_shared(
                merge_field_advisory_key(NEW.tenant_id, changed_key)
            );
            SELECT schema.type, schema.required
              INTO declared_type, is_required
              FROM merge_field_schema schema
             WHERE schema.tenant_id = NEW.tenant_id
               AND schema.key = changed_key
             FOR SHARE;
        ELSE
            -- Existing keys always lock schema row first and advisory key
            -- second. Schema UPDATE/DELETE follows the same order.
            PERFORM pg_advisory_xact_lock_shared(
                merge_field_advisory_key(NEW.tenant_id, changed_key)
            );
        END IF;
        IF NOT FOUND THEN
            CONTINUE;
        END IF;

        normalized_value := validate_declared_merge_field_value(
            changed_key,
            declared_type,
            is_required,
            new_fields -> changed_key
        );
        IF normalized_value = '' THEN
            DELETE FROM merge_field_values value
             WHERE value.tenant_id = NEW.tenant_id
               AND value.subscriber_id = NEW.id
               AND value.key = changed_key;
        ELSE
            INSERT INTO merge_field_values (tenant_id, subscriber_id, key, value)
            VALUES (NEW.tenant_id, NEW.id, changed_key, normalized_value)
            ON CONFLICT (tenant_id, subscriber_id, key) DO UPDATE
               SET value = EXCLUDED.value,
                   updated_at = now();
        END IF;
    END LOOP;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION sync_merge_field_sidecar_to_canonical()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    row_tenant_id uuid;
    row_subscriber_id uuid;
    row_key text;
    declared_type text;
    is_required boolean;
    normalized_value text;
    subscriber_locked boolean := false;
    subscriber_exists boolean := false;
BEGIN
    -- Sidecar identity is part of the canonical JSON address. Historical
    -- writers may change only `value`; moving a row to another tenant,
    -- subscriber, or key would otherwise strand the OLD canonical entry and
    -- create a second source of truth. Reject the move atomically.
    IF TG_OP = 'UPDATE'
       AND (
           OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
           OR OLD.subscriber_id IS DISTINCT FROM NEW.subscriber_id
           OR OLD.key IS DISTINCT FROM NEW.key
       ) THEN
        RAISE EXCEPTION USING
            ERRCODE = 'PW001',
            MESSAGE = 'merge-field value identity is immutable';
    END IF;
    -- A canonical-originated write already owns synchronization.
    IF pg_trigger_depth() > 1 THEN
        IF TG_OP = 'DELETE' THEN
            RETURN OLD;
        END IF;
        RETURN NEW;
    END IF;
    -- Administrative tenant erasure intentionally removes both stores and the
    -- subscriber itself in one transaction. It must not be mistaken for an
    -- operator clearing a required field.
    IF current_setting('app.tenant_cascade_delete', true) = 'on' THEN
        IF TG_OP = 'DELETE' THEN
            RETURN OLD;
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
        row_tenant_id := OLD.tenant_id;
        row_subscriber_id := OLD.subscriber_id;
        row_key := OLD.key;
    ELSE
        row_tenant_id := NEW.tenant_id;
        row_subscriber_id := NEW.subscriber_id;
        row_key := NEW.key;
    END IF;

    SELECT schema.type, schema.required
      INTO declared_type, is_required
      FROM merge_field_schema schema
     WHERE schema.tenant_id = row_tenant_id
       AND schema.key = row_key
     FOR SHARE;
    IF FOUND THEN
        PERFORM pg_advisory_xact_lock_shared(
            merge_field_advisory_key(row_tenant_id, row_key)
        );
    END IF;

    -- Old instances lock the sidecar row before this trigger runs. Never wait
    -- here for a subscriber row owned by a canonical writer: that writer may
    -- be waiting to mirror into this same sidecar row. Failing with a standard
    -- serialization code rolls the old write back cleanly and makes retry the
    -- only outcome, rather than deadlocking or committing divergent stores.
    SELECT true
      INTO subscriber_locked
      FROM subscribers
     WHERE tenant_id = row_tenant_id
       AND id = row_subscriber_id
     FOR UPDATE SKIP LOCKED;
    IF NOT COALESCE(subscriber_locked, false) THEN
        SELECT EXISTS (
            SELECT 1
              FROM subscribers
             WHERE tenant_id = row_tenant_id
               AND id = row_subscriber_id
        ) INTO subscriber_exists;
        IF subscriber_exists THEN
            RAISE EXCEPTION USING
                ERRCODE = '40001',
                MESSAGE = 'concurrent subscriber update; retry merge-field write';
        END IF;
        -- The subscriber is being/has been deleted and its FK cascade owns
        -- cleanup. There is no canonical row left to mirror.
        IF TG_OP = 'DELETE' THEN
            RETURN OLD;
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' OR NULLIF(btrim(NEW.value), '') IS NULL THEN
        IF is_required THEN
            PERFORM validate_declared_merge_field_value(
                row_key,
                declared_type,
                is_required,
                'null'::jsonb
            );
        END IF;
        -- Historical writers documented an empty value as a clear. Normalize
        -- an empty UPDATE into physical absence so usage counts stay truthful.
        IF TG_OP <> 'DELETE' THEN
            DELETE FROM merge_field_values value
             WHERE value.tenant_id = row_tenant_id
               AND value.subscriber_id = row_subscriber_id
               AND value.key = row_key;
        END IF;
        UPDATE subscribers
           SET merge_fields = COALESCE(merge_fields, '{}'::jsonb) - row_key
         WHERE tenant_id = row_tenant_id
           AND id = row_subscriber_id;
    ELSE
        normalized_value := validate_declared_merge_field_value(
            row_key,
            declared_type,
            is_required,
            to_jsonb(NEW.value)
        );
        UPDATE subscribers
           SET merge_fields = COALESCE(merge_fields, '{}'::jsonb)
                              || jsonb_build_object(row_key, normalized_value)
         WHERE tenant_id = row_tenant_id
           AND id = row_subscriber_id;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_merge_field_schema_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    row_tenant_id uuid;
    row_key text;
    stored_value_count bigint;
    existing_value record;
BEGIN
    IF TG_OP = 'DELETE' THEN
        row_tenant_id := OLD.tenant_id;
        row_key := OLD.key;
    ELSE
        row_tenant_id := NEW.tenant_id;
        row_key := NEW.key;
    END IF;

    IF TG_OP = 'DELETE'
       AND current_setting('app.tenant_cascade_delete', true) = 'on' THEN
        RETURN OLD;
    END IF;

    IF TG_OP <> 'DELETE' THEN
        PERFORM validate_declared_merge_field_value(
            row_key,
            NEW.type,
            false,
            to_jsonb(NEW.default_value)
        );
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.type IS NOT DISTINCT FROM OLD.type THEN
        RETURN NEW;
    END IF;

    PERFORM pg_advisory_xact_lock(
        merge_field_advisory_key(row_tenant_id, row_key)
    );

    IF TG_OP = 'INSERT' THEN
        FOR existing_value IN
            SELECT subscriber.merge_fields -> row_key AS raw_value
              FROM subscribers subscriber
             WHERE subscriber.tenant_id = row_tenant_id
               AND jsonb_typeof(subscriber.merge_fields) = 'object'
               AND subscriber.merge_fields ? row_key
        LOOP
            PERFORM validate_declared_merge_field_value(
                row_key,
                NEW.type,
                false,
                existing_value.raw_value
            );
        END LOOP;
        RETURN NEW;
    END IF;

    SELECT count(*)
      INTO stored_value_count
      FROM (
          SELECT subscriber.id AS subscriber_id
            FROM subscribers subscriber
           WHERE subscriber.tenant_id = row_tenant_id
             AND jsonb_typeof(subscriber.merge_fields) = 'object'
             AND subscriber.merge_fields ? row_key
          UNION
          SELECT value.subscriber_id
            FROM merge_field_values value
           WHERE value.tenant_id = row_tenant_id
             AND value.key = row_key
      ) stored_values;
    IF stored_value_count > 0 THEN
        RAISE EXCEPTION USING
            ERRCODE = 'PW002',
            MESSAGE = format('merge field %s has stored subscriber values', row_key);
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION backfill_new_merge_field_sidecar()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    -- A schema can be declared after imports or compatibility paths already
    -- populated the canonical JSON key. Materialize those validated values in
    -- the sidecar inside the schema transaction so older readers see the field
    -- immediately when the schema row becomes visible.
    INSERT INTO merge_field_values (tenant_id, subscriber_id, key, value)
    SELECT NEW.tenant_id,
           subscriber.id,
           NEW.key,
           validate_declared_merge_field_value(
               NEW.key,
               NEW.type,
               false,
               subscriber.merge_fields -> NEW.key
           )
      FROM subscribers subscriber
     WHERE subscriber.tenant_id = NEW.tenant_id
       AND jsonb_typeof(subscriber.merge_fields) = 'object'
       AND subscriber.merge_fields ? NEW.key
       AND validate_declared_merge_field_value(
               NEW.key,
               NEW.type,
               false,
               subscriber.merge_fields -> NEW.key
           ) <> ''
    ON CONFLICT (tenant_id, subscriber_id, key) DO UPDATE
       SET value = EXCLUDED.value,
           updated_at = now();

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS subscribers_sync_merge_field_sidecar_insert ON subscribers;
DROP TRIGGER IF EXISTS subscribers_sync_merge_field_sidecar_update ON subscribers;
DROP TRIGGER IF EXISTS subscribers_normalize_merge_fields_insert ON subscribers;
DROP TRIGGER IF EXISTS subscribers_normalize_merge_fields_update ON subscribers;
DROP TRIGGER IF EXISTS merge_field_values_sync_canonical ON merge_field_values;
DROP TRIGGER IF EXISTS merge_field_schema_guard_insert ON merge_field_schema;
DROP TRIGGER IF EXISTS merge_field_schema_guard_type_update ON merge_field_schema;
DROP TRIGGER IF EXISTS merge_field_schema_guard_definition_update ON merge_field_schema;
DROP TRIGGER IF EXISTS merge_field_schema_guard_delete ON merge_field_schema;
DROP TRIGGER IF EXISTS merge_field_schema_backfill_insert ON merge_field_schema;

CREATE TRIGGER subscribers_normalize_merge_fields_insert
    BEFORE INSERT ON subscribers
    FOR EACH ROW
    EXECUTE FUNCTION normalize_subscriber_merge_fields();

CREATE TRIGGER subscribers_normalize_merge_fields_update
    BEFORE UPDATE OF merge_fields ON subscribers
    FOR EACH ROW
    WHEN (OLD.merge_fields IS DISTINCT FROM NEW.merge_fields)
    EXECUTE FUNCTION normalize_subscriber_merge_fields();

CREATE TRIGGER subscribers_sync_merge_field_sidecar_insert
    AFTER INSERT ON subscribers
    FOR EACH ROW
    EXECUTE FUNCTION sync_subscriber_merge_field_sidecar();

CREATE TRIGGER subscribers_sync_merge_field_sidecar_update
    AFTER UPDATE OF merge_fields ON subscribers
    FOR EACH ROW
    WHEN (OLD.merge_fields IS DISTINCT FROM NEW.merge_fields)
    EXECUTE FUNCTION sync_subscriber_merge_field_sidecar();

CREATE TRIGGER merge_field_values_sync_canonical
    AFTER INSERT OR UPDATE OR DELETE ON merge_field_values
    FOR EACH ROW
    EXECUTE FUNCTION sync_merge_field_sidecar_to_canonical();

CREATE TRIGGER merge_field_schema_guard_insert
    BEFORE INSERT ON merge_field_schema
    FOR EACH ROW
    EXECUTE FUNCTION guard_merge_field_schema_mutation();

CREATE TRIGGER merge_field_schema_guard_definition_update
    BEFORE UPDATE OF type, default_value ON merge_field_schema
    FOR EACH ROW
    WHEN (
        OLD.type IS DISTINCT FROM NEW.type
        OR OLD.default_value IS DISTINCT FROM NEW.default_value
    )
    EXECUTE FUNCTION guard_merge_field_schema_mutation();

CREATE TRIGGER merge_field_schema_guard_delete
    BEFORE DELETE ON merge_field_schema
    FOR EACH ROW
    EXECUTE FUNCTION guard_merge_field_schema_mutation();

CREATE TRIGGER merge_field_schema_backfill_insert
    AFTER INSERT ON merge_field_schema
    FOR EACH ROW
    EXECUTE FUNCTION backfill_new_merge_field_sidecar();

COMMIT;

-- From this point every new write is normalized and mirrored. The phased
-- runner committed the brief hot-table DDL swap above before these fleet-wide
-- scans begin, so subscriber traffic is not held behind an AccessExclusive
-- lock. If preflight fails, the safe triggers remain active and a checksum-
-- bound phase marker makes the operator's repair + retry restartable.
SET lock_timeout = '5s';

DO $merge_field_preflight$
DECLARE
    drift_count bigint;
BEGIN
    IF EXISTS (
        SELECT 1
          FROM subscribers
         WHERE jsonb_typeof(merge_fields) IS DISTINCT FROM 'object'
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'merge-field rollout blocked: subscribers.merge_fields contains a non-object value';
    END IF;

    -- Direct/legacy schema writes predate typed-default enforcement. Calling
    -- the validator here turns any invalid default into PW001 before the
    -- migration is attested complete.
    PERFORM validate_declared_merge_field_value(
        schema.key,
        schema.type,
        false,
        to_jsonb(schema.default_value)
    )
      FROM merge_field_schema schema;

    WITH canonical_values AS MATERIALIZED (
        SELECT schema.tenant_id,
               subscriber.id AS subscriber_id,
               schema.key,
               validate_declared_merge_field_value(
                   schema.key,
                   schema.type,
                   schema.required,
                   subscriber.merge_fields -> schema.key
               ) AS value
          FROM merge_field_schema schema
          JOIN subscribers subscriber
            ON subscriber.tenant_id = schema.tenant_id
           AND subscriber.merge_fields ? schema.key
    ),
    sidecar_values AS MATERIALIZED (
        SELECT value.tenant_id,
               value.subscriber_id,
               value.key,
               validate_declared_merge_field_value(
                   value.key,
                   schema.type,
                   schema.required,
                   to_jsonb(value.value)
               ) AS value
          FROM merge_field_values value
          JOIN merge_field_schema schema
            ON schema.tenant_id = value.tenant_id
           AND schema.key = value.key
    )
    SELECT count(*)
      INTO drift_count
      FROM canonical_values canonical
      FULL JOIN sidecar_values sidecar
        ON sidecar.tenant_id = canonical.tenant_id
       AND sidecar.subscriber_id = canonical.subscriber_id
       AND sidecar.key = canonical.key
     WHERE canonical.subscriber_id IS NULL
        OR sidecar.subscriber_id IS NULL
        OR canonical.value IS DISTINCT FROM sidecar.value;

    IF drift_count > 0 THEN
        RAISE EXCEPTION USING
            ERRCODE = 'P0001',
            MESSAGE = format(
                'merge-field rollout blocked: %s declared values disagree between canonical and sidecar stores; reconcile explicitly before retrying',
                drift_count
            );
    END IF;
END;
$merge_field_preflight$;

-- VALIDATE takes a DML-compatible lock and scans outside the trigger-swap
-- transaction. The NOT VALID forms above have enforced every new write since
-- the first phase committed.
ALTER TABLE subscribers
    VALIDATE CONSTRAINT subscribers_merge_fields_object_check;

ALTER TABLE merge_field_values
    VALIDATE CONSTRAINT merge_field_values_tenant_subscriber_fkey;

RESET lock_timeout;
