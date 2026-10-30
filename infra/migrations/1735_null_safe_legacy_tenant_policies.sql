-- 1735_null_safe_legacy_tenant_policies.sql
--
-- Earlier migrations created tenant policies that cast the tenant GUC
-- directly to uuid. PostgreSQL represents an unset custom setting as an empty
-- string in several connection-pool paths, so evaluating any one of those
-- policies can fail with SQLSTATE 22P02 instead of simply denying access.
--
-- Those applied migrations are immutable. Repair their effective policies
-- here, in one append-only migration, instead of changing historical bytes.
-- The catalog expressions are PostgreSQL-generated SQL; identifiers are
-- quoted separately and the replacement is deliberately exact.
--
-- rollback-strategy: no-op - the null-safe expression remains tenant-bound
-- and only turns an unset tenant context into no matching tenant rows.

BEGIN;

DO $policy_repair$
DECLARE
    policy_row record;
    repaired_qual text;
    repaired_check text;
    unsafe_cast constant text :=
        '(current_setting(''app.tenant_id''::text, true))::uuid';
    safe_cast constant text :=
        '(NULLIF(current_setting(''app.tenant_id''::text, true), ''''::text))::uuid';
BEGIN
    FOR policy_row IN
        SELECT
            policy.polname,
            namespace.nspname,
            relation.relname,
            pg_get_expr(policy.polqual, policy.polrelid) AS qual,
            pg_get_expr(policy.polwithcheck, policy.polrelid) AS with_check
        FROM pg_policy AS policy
        JOIN pg_class AS relation ON relation.oid = policy.polrelid
        JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND (
              COALESCE(pg_get_expr(policy.polqual, policy.polrelid), '')
                  LIKE '%' || unsafe_cast || '%'
              OR COALESCE(pg_get_expr(policy.polwithcheck, policy.polrelid), '')
                  LIKE '%' || unsafe_cast || '%'
          )
        ORDER BY relation.relname, policy.polname
    LOOP
        repaired_qual := replace(policy_row.qual, unsafe_cast, safe_cast);
        repaired_check := replace(policy_row.with_check, unsafe_cast, safe_cast);

        IF policy_row.qual IS NOT NULL AND policy_row.with_check IS NOT NULL THEN
            EXECUTE format(
                'ALTER POLICY %I ON %I.%I USING (%s) WITH CHECK (%s)',
                policy_row.polname,
                policy_row.nspname,
                policy_row.relname,
                repaired_qual,
                repaired_check
            );
        ELSIF policy_row.qual IS NOT NULL THEN
            EXECUTE format(
                'ALTER POLICY %I ON %I.%I USING (%s)',
                policy_row.polname,
                policy_row.nspname,
                policy_row.relname,
                repaired_qual
            );
        ELSIF policy_row.with_check IS NOT NULL THEN
            EXECUTE format(
                'ALTER POLICY %I ON %I.%I WITH CHECK (%s)',
                policy_row.polname,
                policy_row.nspname,
                policy_row.relname,
                repaired_check
            );
        END IF;
    END LOOP;

    IF EXISTS (
        SELECT 1
        FROM pg_policy AS policy
        JOIN pg_class AS relation ON relation.oid = policy.polrelid
        JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND (
              COALESCE(pg_get_expr(policy.polqual, policy.polrelid), '')
                  LIKE '%' || unsafe_cast || '%'
              OR COALESCE(pg_get_expr(policy.polwithcheck, policy.polrelid), '')
                  LIKE '%' || unsafe_cast || '%'
          )
    ) THEN
        RAISE EXCEPTION
            'legacy tenant policy repair left a direct app.tenant_id uuid cast';
    END IF;
END
$policy_repair$;

COMMIT;
