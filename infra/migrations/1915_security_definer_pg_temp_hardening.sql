-- 1915_security_definer_pg_temp_hardening.sql
--
-- Every SECURITY DEFINER function in this schema was a privilege-escalation
-- primitive, because none of them named `pg_temp` in its search_path.
--
-- THE MECHANISM. `SET search_path = pg_catalog, public` looks exhaustive and is
-- not. When `pg_temp` is not named explicitly, PostgreSQL still searches the
-- caller's temporary schema — and searches it FIRST for relation and TYPE
-- names. So every unqualified type or table name in a definer function body is
-- resolvable to an object the CALLER created. Naming `pg_temp` explicitly, at
-- the END of the list, is what moves it from implicitly-first to
-- explicitly-last.
--
-- IT WAS EXPLOITED, not theorised. A review of migration 1913 built the attack
-- against a function owned by a NOLOGIN/BYPASSRLS role, as `postwave_app`:
--
--     CREATE FUNCTION pg_temp.evil(text) RETURNS boolean AS $$ ...any SQL... $$;
--     CREATE DOMAIN pg_temp.uuid AS text CHECK (pg_temp.evil(VALUE));
--     SELECT the_definer_function('...', '...');
--
-- The body's `DECLARE session_tenant uuid` bound to the caller's temp domain, so
-- the domain's CHECK executed inside the SECURITY DEFINER context. The injected
-- statement counted 283 subscribers across 159 distinct tenants; the identical
-- read as `postwave_app` under RLS returns 2 rows and 1 tenant. Adding
-- `pg_temp` last, and nothing else, closed it — verified by re-running the same
-- attack against a deliberately unhardened copy (fires) and the hardened
-- function (does not).
--
-- 1913 FIXED ITSELF; THIS FIXES THE OTHER FIFTY-TWO. The reviewer noted the
-- class and it is worse than the instance: of the SECURITY DEFINER functions in
-- `public`, 52 omitted `pg_temp`, and one — `enqueue_list_joined_flow_runs` —
-- carried NO search_path setting at all, which is the same hole with nothing
-- narrowing it. Several are owned by `harshbishnoi`, a SUPERUSER, so the ceiling
-- there is not BYPASSRLS but superuser.
--
-- ALTER, NOT CREATE OR REPLACE. The bodies are not touched. `CREATE OR REPLACE
-- FUNCTION` resets unspecified attributes — this repo has already lost
-- `SECURITY DEFINER` and `SET search_path` that way once — and re-emitting 52
-- bodies from `prosrc` would risk a transcription error in every one of them.
-- `ALTER FUNCTION ... SET search_path` changes exactly one setting and leaves
-- ownership, volatility, security attribute and any sibling settings
-- (`lock_timeout`, `statement_timeout` on two of these) alone.
--
-- APPENDING IS BEHAVIOUR-PRESERVING, and that was checked rather than assumed.
-- `pg_temp` was already being searched, just first; moving it last can only
-- narrow what resolves there. The one way it could change behaviour is a
-- function that deliberately creates and then reads a temp object by
-- unqualified name — so every definer body was scanned for `CREATE TEMP` and
-- `pg_temp`, and zero matched.
--
-- A MIGRATION CANNOT HOLD THIS INVARIANT ON ITS OWN. This runs once, at its
-- point in the ordering; a definer function added by a later migration is not
-- covered. The durable half is the test that asserts the invariant over the
-- live catalogue, so a new unhardened function fails rather than waits to be
-- noticed. See `TestEverySecurityDefinerFunctionNamesPgTemp` in
-- apps/api/internal/db.

BEGIN;

DO $harden$
DECLARE
    fn record;
    current_path text;
    new_path text;
    hardened integer := 0;
BEGIN
    FOR fn IN
        SELECT p.oid,
               p.oid::regprocedure::text AS signature,
               p.proconfig
          FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         WHERE p.prosecdef
           AND n.nspname NOT IN ('pg_catalog', 'information_schema')
           AND n.nspname NOT LIKE 'pg_toast%'
         ORDER BY p.oid::regprocedure::text
    LOOP
        SELECT substring(setting FROM 'search_path=(.*)$')
          INTO current_path
          FROM unnest(COALESCE(fn.proconfig, ARRAY[]::text[])) AS setting
         WHERE setting LIKE 'search_path=%'
         LIMIT 1;

        IF current_path IS NOT NULL AND current_path ILIKE '%pg_temp%' THEN
            CONTINUE;
        END IF;

        IF current_path IS NULL THEN
            -- No search_path at all. This is the least safe state of the three,
            -- so it gets the explicit default rather than only an appended
            -- pg_temp: an unset search_path means the CALLER's whole list
            -- applies inside the definer context.
            new_path := 'pg_catalog, public, pg_temp';
        ELSE
            new_path := current_path || ', pg_temp';
        END IF;

        EXECUTE format('ALTER FUNCTION %s SET search_path = %s',
                       fn.signature, new_path);
        hardened := hardened + 1;
    END LOOP;

    RAISE NOTICE '1915: hardened % SECURITY DEFINER function(s) with pg_temp', hardened;

    -- Fail the migration rather than report success over a partial sweep. If any
    -- definer function still lacks pg_temp after the loop, the loop's own
    -- predicate is wrong and the escalation is still reachable.
    IF EXISTS (
        SELECT 1
          FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         WHERE p.prosecdef
           AND n.nspname NOT IN ('pg_catalog', 'information_schema')
           AND n.nspname NOT LIKE 'pg_toast%'
           AND NOT EXISTS (
               SELECT 1 FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) AS setting
                WHERE setting LIKE 'search_path=%' AND setting ILIKE '%pg_temp%'
           )
    ) THEN
        RAISE EXCEPTION
            '1915: a SECURITY DEFINER function still has no pg_temp in its search_path';
    END IF;
END
$harden$;

COMMIT;
