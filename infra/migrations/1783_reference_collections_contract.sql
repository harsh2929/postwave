-- 1783_reference_collections_contract.sql
--
-- Harden SUB-014 operator reference data at the database boundary. These
-- rows are NOT the deployable discount coupon pools in coupon_pools and are
-- not an automation/personalization runtime until a consumer contract exists.
--
-- The application bounds the submitted compact JSON and the database enforces
-- the 1 MiB ceiling again on PostgreSQL's canonical jsonb representation. That
-- canonical form can be larger for exponent-form numbers; the repository maps
-- this stricter database rejection to deterministic invalid_data rather than a
-- 500. The recursive size function avoids jsonb::text presentation spaces and
-- accounts for Go's mandatory U+2028/U+2029 escaping while preserving those
-- legitimate characters in cell text.
--
-- migration-execution: phased
-- rollback-strategy: no-op
-- rollback-details: Keep the additive constraints, stable-page index, and timestamp trigger during application rollback.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION reference_collection_name_is_safe(value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT char_length(value) BETWEEN 1 AND 200
       AND value = btrim(value, U&' \0009\000A\000B\000C\000D\0085\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000')
       AND value !~ '[[:cntrl:]]'
       AND strpos(value, U&'\061C') = 0
       AND strpos(value, U&'\200E') = 0
       AND strpos(value, U&'\200F') = 0
       AND strpos(value, U&'\2028') = 0
       AND strpos(value, U&'\2029') = 0
       AND strpos(value, U&'\202A') = 0
       AND strpos(value, U&'\202B') = 0
       AND strpos(value, U&'\202C') = 0
       AND strpos(value, U&'\202D') = 0
       AND strpos(value, U&'\202E') = 0
       AND strpos(value, U&'\2066') = 0
       AND strpos(value, U&'\2067') = 0
       AND strpos(value, U&'\2068') = 0
       AND strpos(value, U&'\2069') = 0;
$$;

CREATE OR REPLACE FUNCTION reference_collection_compact_json_size_at_depth(value jsonb, depth integer)
RETURNS bigint
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    kind text := jsonb_typeof(value);
    total bigint;
    string_value text;
BEGIN
    -- The root data array is depth 0, its row object is depth 1, and a
    -- top-level cell value is depth 2. Application value depth 8 therefore
    -- ends at depth 9 here. Return an over-limit sentinel before descending
    -- farther so hostile legacy jsonb cannot exhaust the database stack.
    IF depth > 9 THEN
        RETURN 1048577;
    END IF;
    CASE kind
    WHEN 'array' THEN
        SELECT 2
             + GREATEST(count(*) - 1, 0)
             + COALESCE(sum(public.reference_collection_compact_json_size_at_depth(item, depth + 1)), 0)
          INTO total
          FROM jsonb_array_elements(value) AS elements(item);
        RETURN total;
    WHEN 'object' THEN
        SELECT 2
             + GREATEST(count(*) - 1, 0)
             + COALESCE(sum(
                   public.reference_collection_compact_json_size_at_depth(to_jsonb(entry.key), depth + 1)
                   + 1
                   + public.reference_collection_compact_json_size_at_depth(entry.value, depth + 1)
               ), 0)
          INTO total
          FROM jsonb_each(value) AS entry(key, value);
        RETURN total;
    WHEN 'string' THEN
        string_value := value #>> '{}';
        RETURN octet_length(value::text)
             + 3 * (char_length(string_value) - char_length(replace(string_value, U&'\2028', '')))
             + 3 * (char_length(string_value) - char_length(replace(string_value, U&'\2029', '')));
    ELSE
        RETURN octet_length(value::text);
    END CASE;
END;
$$;

CREATE OR REPLACE FUNCTION reference_collection_compact_json_size(value jsonb)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT public.reference_collection_compact_json_size_at_depth(value, 0);
$$;

CREATE OR REPLACE FUNCTION reference_collection_field_name_is_safe(value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT char_length(value) BETWEEN 1 AND 128
       AND btrim(value, U&' \0009\000A\000B\000C\000D\0085\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000') <> ''
       AND value !~ '[[:cntrl:]]'
       AND strpos(value, U&'\061C') = 0
       AND strpos(value, U&'\200E') = 0
       AND strpos(value, U&'\200F') = 0
       AND strpos(value, U&'\2028') = 0
       AND strpos(value, U&'\2029') = 0
       AND strpos(value, U&'\202A') = 0
       AND strpos(value, U&'\202B') = 0
       AND strpos(value, U&'\202C') = 0
       AND strpos(value, U&'\202D') = 0
       AND strpos(value, U&'\202E') = 0
       AND strpos(value, U&'\2066') = 0
       AND strpos(value, U&'\2067') = 0
       AND strpos(value, U&'\2068') = 0
       AND strpos(value, U&'\2069') = 0
       AND value NOT IN ('__proto__', 'constructor', 'prototype');
$$;

-- Returns the number of JSON value nodes, or -1 when the value violates the
-- application contract. The explicit depth guard runs before recursion, so a
-- directly-written pathological document cannot exhaust the function stack.
CREATE OR REPLACE FUNCTION reference_collection_value_node_count(value jsonb, depth integer)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    kind text;
    member_count integer;
    total integer := 1;
    child_count integer;
    string_value text;
    number_value numeric;
    entry record;
BEGIN
    IF depth > 8 THEN
        RETURN -1;
    END IF;

    kind := jsonb_typeof(value);
    CASE kind
    WHEN 'null', 'boolean' THEN
        RETURN total;
    WHEN 'string' THEN
        string_value := value #>> '{}';
        IF octet_length(string_value) > 65536 THEN
            RETURN -1;
        END IF;
        RETURN total;
    WHEN 'number' THEN
        number_value := (value #>> '{}')::numeric;
        IF number_value <> 0
           AND (abs(number_value) < 1e-300::numeric
                OR abs(number_value) > 1e300::numeric) THEN
            RETURN -1;
        END IF;
        IF trunc(number_value) = number_value
           AND abs(number_value) > 9007199254740991::numeric THEN
            RETURN -1;
        END IF;
        RETURN total;
    WHEN 'array' THEN
        member_count := jsonb_array_length(value);
        IF member_count > 1000 THEN
            RETURN -1;
        END IF;
        FOR entry IN SELECT item FROM jsonb_array_elements(value) AS elements(item) LOOP
            child_count := public.reference_collection_value_node_count(entry.item, depth + 1);
            IF child_count < 0 THEN
                RETURN -1;
            END IF;
            total := total + child_count;
            IF total > 250000 THEN
                RETURN total;
            END IF;
        END LOOP;
        RETURN total;
    WHEN 'object' THEN
        SELECT count(*)::integer INTO member_count FROM jsonb_each(value);
        IF member_count > 1000 THEN
            RETURN -1;
        END IF;
        FOR entry IN SELECT key, child FROM jsonb_each(value) AS members(key, child) LOOP
            IF NOT public.reference_collection_field_name_is_safe(entry.key) THEN
                RETURN -1;
            END IF;
            child_count := public.reference_collection_value_node_count(entry.child, depth + 1);
            IF child_count < 0 THEN
                RETURN -1;
            END IF;
            total := total + child_count;
            IF total > 250000 THEN
                RETURN total;
            END IF;
        END LOOP;
        RETURN total;
    ELSE
        RETURN -1;
    END CASE;
END;
$$;

CREATE OR REPLACE FUNCTION reference_collection_data_is_safe(value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    row_value jsonb;
    entry record;
    member_count integer;
    total_nodes integer := 0;
    child_count integer;
BEGIN
    IF jsonb_typeof(value) <> 'array'
       OR jsonb_array_length(value) > 50000
       OR public.reference_collection_compact_json_size(value) > 1048576 THEN
        RETURN false;
    END IF;

    FOR row_value IN SELECT item FROM jsonb_array_elements(value) AS rows(item) LOOP
        IF jsonb_typeof(row_value) <> 'object'
           OR public.reference_collection_compact_json_size(row_value) > 262144 THEN
            RETURN false;
        END IF;
        SELECT count(*)::integer INTO member_count FROM jsonb_each(row_value);
        IF member_count > 100 THEN
            RETURN false;
        END IF;

        total_nodes := total_nodes + 1;
        FOR entry IN SELECT key, child FROM jsonb_each(row_value) AS fields(key, child) LOOP
            IF NOT public.reference_collection_field_name_is_safe(entry.key) THEN
                RETURN false;
            END IF;
            child_count := public.reference_collection_value_node_count(entry.child, 1);
            IF child_count < 0 THEN
                RETURN false;
            END IF;
            total_nodes := total_nodes + child_count;
            IF total_nodes > 250000 THEN
                RETURN false;
            END IF;
        END LOOP;
    END LOOP;
    RETURN true;
END;
$$;

COMMIT;

-- From this point each statement/DO block commits independently. Adding the
-- NOT VALID checks takes only the short schema-lock phase; the compatibility
-- preflight and VALIDATE scans do not retain that lock and remain compatible
-- with normal row writes.
SET lock_timeout = '5s';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'reference_collections'::regclass
           AND conname = 'reference_collections_name_length_check'
    ) THEN
        ALTER TABLE reference_collections
            ADD CONSTRAINT reference_collections_name_length_check
            CHECK (reference_collection_name_is_safe(name)) NOT VALID;
    ELSIF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'reference_collections'::regclass
           AND conname = 'reference_collections_name_length_check'
           AND contype = 'c'
           AND strpos(pg_get_constraintdef(oid), 'reference_collection_name_is_safe(name)') > 0
    ) THEN
        RAISE EXCEPTION 'reference_collections_name_length_check exists with an unexpected definition; reconcile it before retrying migration 1783';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'reference_collections'::regclass
           AND conname = 'reference_collections_data_shape_check'
    ) THEN
        ALTER TABLE reference_collections
            ADD CONSTRAINT reference_collections_data_shape_check
            CHECK (reference_collection_data_is_safe(data)) NOT VALID;
    ELSIF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'reference_collections'::regclass
           AND conname = 'reference_collections_data_shape_check'
           AND contype = 'c'
           AND strpos(pg_get_constraintdef(oid), 'reference_collection_data_is_safe(data)') > 0
    ) THEN
        RAISE EXCEPTION 'reference_collections_data_shape_check exists with an unexpected definition; reconcile it before retrying migration 1783';
    END IF;
END;
$$;

-- Name identity is an operator-visible key. Never choose a winner silently:
-- an existing ambiguous catalog requires explicit tenant-owned remediation
-- before this migration can proceed.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM reference_collections
         WHERE NOT reference_collection_name_is_safe(name)
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'reference_collections contains names outside the normalized text-safety contract; repair them before applying migration 1783';
    END IF;
    IF EXISTS (
        SELECT 1 FROM reference_collections
         WHERE NOT reference_collection_data_is_safe(data)
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'reference_collections contains data outside the bounded row/value contract; repair it before applying migration 1783';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM reference_collections
         GROUP BY tenant_id, lower(name)
        HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '23505',
            MESSAGE = 'reference_collections contains duplicate tenant/name identities; reconcile them before applying migration 1783';
    END IF;
END;
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgrelid = 'reference_collections'::regclass
           AND tgname = 'reference_collections_set_updated_at'
           AND NOT tgisinternal
    ) THEN
        CREATE TRIGGER reference_collections_set_updated_at
            BEFORE UPDATE ON reference_collections
            FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    ELSIF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgrelid = 'reference_collections'::regclass
           AND tgname = 'reference_collections_set_updated_at'
           AND NOT tgisinternal
           AND strpos(pg_get_triggerdef(oid), 'BEFORE UPDATE ON public.reference_collections') > 0
           AND strpos(pg_get_triggerdef(oid), 'EXECUTE FUNCTION set_updated_at()') > 0
    ) THEN
        RAISE EXCEPTION 'reference_collections_set_updated_at exists with an unexpected definition; reconcile it before retrying migration 1783';
    END IF;
END;
$$;

ALTER TABLE reference_collections
    VALIDATE CONSTRAINT reference_collections_name_length_check;

ALTER TABLE reference_collections
    VALIDATE CONSTRAINT reference_collections_data_shape_check;

COMMENT ON TABLE reference_collections IS
    'Workspace-scoped operator reference data only. The legacy coupons type is not the deployable discounts coupon_pools runtime, and no automation/personalization consumer contract is currently wired.';

-- reference_collections can hold up to 1 MiB per row and remains writable while
-- this migration is deployed. Conventional builds would hold write-blocking
-- locks for the full scan, so every additive index is built concurrently in
-- the restartable phase. The migration runner removes interrupted invalid
-- concurrent shells before retrying and attests the final definitions.

CREATE INDEX CONCURRENTLY IF NOT EXISTS reference_collections_tenant_page_idx
    ON reference_collections (tenant_id, created_at DESC, id DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS reference_collections_tenant_type_page_idx
    ON reference_collections (tenant_id, collection_type, created_at DESC, id DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS reference_collections_name_trgm_idx
    ON reference_collections USING GIN (lower(name) gin_trgm_ops);

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS reference_collections_tenant_name_uidx
    ON reference_collections (tenant_id, lower(name));

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_index AS index_state
        JOIN pg_class AS index_relation ON index_relation.oid = index_state.indexrelid
         WHERE index_relation.relname = 'reference_collections_tenant_page_idx'
           AND index_state.indrelid = 'reference_collections'::regclass
           AND index_state.indisvalid
           AND NOT index_state.indisunique
           AND strpos(pg_get_indexdef(index_state.indexrelid), 'USING btree (tenant_id, created_at DESC, id DESC)') > 0
    ) THEN
        RAISE EXCEPTION 'reference_collections_tenant_page_idx is absent, invalid, or has an unexpected definition; drop it concurrently and retry migration 1783';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_index AS index_state
        JOIN pg_class AS index_relation ON index_relation.oid = index_state.indexrelid
         WHERE index_relation.relname = 'reference_collections_tenant_type_page_idx'
           AND index_state.indrelid = 'reference_collections'::regclass
           AND index_state.indisvalid
           AND NOT index_state.indisunique
           AND strpos(pg_get_indexdef(index_state.indexrelid), 'USING btree (tenant_id, collection_type, created_at DESC, id DESC)') > 0
    ) THEN
        RAISE EXCEPTION 'reference_collections_tenant_type_page_idx is absent, invalid, or has an unexpected definition; drop it concurrently and retry migration 1783';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_index AS index_state
        JOIN pg_class AS index_relation ON index_relation.oid = index_state.indexrelid
         WHERE index_relation.relname = 'reference_collections_name_trgm_idx'
           AND index_state.indrelid = 'reference_collections'::regclass
           AND index_state.indisvalid
           AND NOT index_state.indisunique
           AND strpos(pg_get_indexdef(index_state.indexrelid), 'USING gin (lower(name) gin_trgm_ops)') > 0
    ) THEN
        RAISE EXCEPTION 'reference_collections_name_trgm_idx is absent, invalid, or has an unexpected definition; drop it concurrently and retry migration 1783';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_index AS index_state
        JOIN pg_class AS index_relation ON index_relation.oid = index_state.indexrelid
         WHERE index_relation.relname = 'reference_collections_tenant_name_uidx'
           AND index_state.indrelid = 'reference_collections'::regclass
           AND index_state.indisvalid
           AND index_state.indisunique
           AND strpos(pg_get_indexdef(index_state.indexrelid), 'USING btree (tenant_id, lower(name))') > 0
    ) THEN
        RAISE EXCEPTION 'reference_collections_tenant_name_uidx is absent, invalid, or has an unexpected definition; drop it concurrently and retry migration 1783';
    END IF;
END;
$$;

RESET lock_timeout;
