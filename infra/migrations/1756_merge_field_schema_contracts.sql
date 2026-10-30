-- Bound and validate the canonical audience-field catalog at the storage
-- boundary. Application validation remains the primary operator-facing guard;
-- these constraints prevent legacy workers, compatibility adapters, and
-- direct maintenance SQL from persisting a shape that the editor cannot read.
-- migration-execution: phased
-- rollback-strategy: no-op
-- rollback-details: leave constraints applied; repair any legacy validation failure under reviewed tenant maintenance, then retry the checksum-bound phase.

-- PostgreSQL's btrim accepts an explicit character set. This set covers the
-- Unicode White_Space property plus the byte-order mark, which is commonly
-- pasted into CSV headers and is otherwise visually blank. char_length() then
-- matches Go's rune-count label limit for valid UTF-8 database text.
CREATE OR REPLACE FUNCTION merge_field_trim_unicode_whitespace(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
    SELECT btrim(
        p_value,
        U&'\0009\000A\000B\000C\000D\0020\0085\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'
    );
$$;

BEGIN;

-- Never wait behind an unbounded production lock queue. The additive NOT
-- VALID constraints take only the brief catalog lock needed to begin
-- enforcing new writes; potentially long legacy scans happen after COMMIT.
SET LOCAL lock_timeout = '5s';

ALTER TABLE merge_field_schema
    ADD CONSTRAINT merge_field_schema_key_contract_check
    CHECK (
        char_length(key) BETWEEN 1 AND 32
        AND key COLLATE "C" ~ '^[A-Z][A-Z0-9_]*$'
    ) NOT VALID;

ALTER TABLE merge_field_schema
    ADD CONSTRAINT merge_field_schema_label_contract_check
    CHECK (
        char_length(label) BETWEEN 1 AND 200
        AND label = merge_field_trim_unicode_whitespace(label)
    ) NOT VALID;

ALTER TABLE merge_field_schema
    ADD CONSTRAINT merge_field_schema_position_contract_check
    CHECK (position BETWEEN -1000000 AND 1000000) NOT VALID;

-- validate_declared_merge_field_value is immutable and was installed by 1754.
-- Equality also requires the stored default to be normalized, not merely
-- parseable as its declared type.
ALTER TABLE merge_field_schema
    ADD CONSTRAINT merge_field_schema_default_contract_check
    CHECK (
        default_value = merge_field_trim_unicode_whitespace(default_value)
        AND default_value = validate_declared_merge_field_value(
            key,
            type,
            false,
            to_jsonb(default_value)
        )
    ) NOT VALID;

-- Empty sidecar input means "absent": the compatibility trigger physically
-- removes it (or raises PW001 for a required field), so it must remain legal at
-- the statement boundary. Every nonempty durable value is normalized and
-- bounded, preventing canonical/sidecar whitespace drift. Typed validation
-- stays in the schema-aware trigger because a CHECK constraint cannot safely
-- query merge_field_schema.
ALTER TABLE merge_field_values
    ADD CONSTRAINT merge_field_values_value_contract_check
    CHECK (
        char_length(value) <= 4096
        AND value = merge_field_trim_unicode_whitespace(value)
    ) NOT VALID;

COMMIT;

-- VALIDATE CONSTRAINT scans with a DML-compatible lock. A legacy violation
-- fails the rollout closed while the phase-0 constraints continue protecting
-- every new write; after reviewed repair, the runner resumes at the first
-- uncommitted checksum-bound validation phase.
SET lock_timeout = '5s';

ALTER TABLE merge_field_schema
    VALIDATE CONSTRAINT merge_field_schema_key_contract_check;

ALTER TABLE merge_field_schema
    VALIDATE CONSTRAINT merge_field_schema_label_contract_check;

ALTER TABLE merge_field_schema
    VALIDATE CONSTRAINT merge_field_schema_position_contract_check;

ALTER TABLE merge_field_schema
    VALIDATE CONSTRAINT merge_field_schema_default_contract_check;

ALTER TABLE merge_field_values
    VALIDATE CONSTRAINT merge_field_values_value_contract_check;

RESET lock_timeout;
