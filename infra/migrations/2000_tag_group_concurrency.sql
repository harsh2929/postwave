-- 2000_tag_group_concurrency.sql
--
-- Tag groups were the last audience-registry records whose update/delete
-- surface had no committed-state concurrency token.  A stale editor could
-- therefore rename/reorder a group after another operator had changed it, and
-- a delayed DELETE could ungroup tags without proving which revision the
-- operator reviewed.
--
-- The trigger owns both fields so direct SQL and every application writer have
-- identical semantics.  It advances only when a user-visible group attribute
-- changes; a no-op UPDATE cannot manufacture a fresh version.

BEGIN;

ALTER TABLE public.tag_groups
    ADD COLUMN IF NOT EXISTS updated_at timestamptz,
    ADD COLUMN IF NOT EXISTS version bigint;

UPDATE public.tag_groups
   SET updated_at = COALESCE(updated_at, created_at, clock_timestamp()),
       version = COALESCE(version, 1)
 WHERE updated_at IS NULL
    OR version IS NULL;

ALTER TABLE public.tag_groups
    ALTER COLUMN updated_at SET DEFAULT now(),
    ALTER COLUMN updated_at SET NOT NULL,
    ALTER COLUMN version SET DEFAULT 1,
    ALTER COLUMN version SET NOT NULL;

ALTER TABLE public.tag_groups
    DROP CONSTRAINT IF EXISTS tag_groups_positive_version_2000,
    ADD CONSTRAINT tag_groups_positive_version_2000 CHECK (version > 0);

CREATE OR REPLACE FUNCTION public.tag_groups_assign_version_2000()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.version := 1;
        NEW.updated_at := COALESCE(NEW.updated_at, NEW.created_at, clock_timestamp());
        RETURN NEW;
    END IF;

    IF ROW(NEW.name, NEW.color, NEW.sort_order)
       IS DISTINCT FROM
       ROW(OLD.name, OLD.color, OLD.sort_order) THEN
        NEW.version := OLD.version + 1;
        NEW.updated_at := clock_timestamp();
    ELSE
        NEW.version := OLD.version;
        NEW.updated_at := OLD.updated_at;
    END IF;
    RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.tag_groups_assign_version_2000() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tag_groups_assign_version_2000() TO postwave_app;

DROP TRIGGER IF EXISTS tag_groups_assign_version_2000 ON public.tag_groups;
CREATE TRIGGER tag_groups_assign_version_2000
BEFORE INSERT OR UPDATE ON public.tag_groups
FOR EACH ROW EXECUTE FUNCTION public.tag_groups_assign_version_2000();

COMMENT ON COLUMN public.tag_groups.version IS
    'Positive monotonic revision used by strong ETags and exact update/delete preconditions.';
COMMENT ON COLUMN public.tag_groups.updated_at IS
    'Server-owned semantic mutation timestamp; preserved by no-op updates.';

COMMIT;
