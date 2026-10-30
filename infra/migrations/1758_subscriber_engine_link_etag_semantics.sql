-- Persisting the internal Listmonk identity happens after the user-visible
-- subscriber write commits. The generic set_updated_at() trigger used to make
-- that internal-only JSONB marker change advance subscribers.updated_at,
-- immediately invalidating the ETag returned by the successful API request.
-- Give subscribers a table-specific trigger function that preserves the old
-- timestamp only when _listmonk_id is the sole durable delta. Every visible
-- field change, including any other custom_fields key, retains the historical
-- now() semantics.
-- rollback-strategy: expand-contract
-- rollback-details: restore subscribers_set_updated_at to execute the shared
-- set_updated_at() function; doing so is safe but reintroduces spurious ETag
-- invalidation after an asynchronous engine-link write.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION subscribers_set_updated_at_preserving_engine_link()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    old_user_custom_fields jsonb := COALESCE(OLD.custom_fields, '{}'::jsonb) - '_listmonk_id';
    new_user_custom_fields jsonb := COALESCE(NEW.custom_fields, '{}'::jsonb) - '_listmonk_id';
    -- PostgreSQL exposes stored generated columns as NULL in NEW during a
    -- BEFORE trigger, while OLD contains the previously materialized value.
    -- search_tsv is the subscribers table's sole generated column, so exclude
    -- it from this source-field comparison; PostgreSQL recomputes it after the
    -- trigger from the unchanged source columns.
    old_visible_row jsonb := to_jsonb(OLD) - 'updated_at' - 'custom_fields' - 'search_tsv';
    new_visible_row jsonb := to_jsonb(NEW) - 'updated_at' - 'custom_fields' - 'search_tsv';
BEGIN
    IF new_user_custom_fields = old_user_custom_fields
       AND new_visible_row = old_visible_row
       AND (NEW.custom_fields -> '_listmonk_id')
           IS DISTINCT FROM (OLD.custom_fields -> '_listmonk_id')
    THEN
        NEW.updated_at = OLD.updated_at;
    ELSE
        NEW.updated_at = now();
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS subscribers_set_updated_at ON subscribers;

CREATE TRIGGER subscribers_set_updated_at
    BEFORE UPDATE ON subscribers
    FOR EACH ROW EXECUTE FUNCTION subscribers_set_updated_at_preserving_engine_link();

COMMIT;
