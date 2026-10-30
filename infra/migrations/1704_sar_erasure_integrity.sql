-- 1704_sar_erasure_integrity.sql
-- Art. 17 erasure integrity.
--
-- The desktop "Right to Erasure" button posts to POST /api/v1/sar/requests --
-- the SAR *export* endpoint. That endpoint's only write was
-- INSERT INTO sar_bundles, i.e. a complete CLEARTEXT snapshot of every piece
-- of PII held on the subject. It deleted nothing and reported success. An
-- erasure executed through the product UI therefore left us holding strictly
-- MORE personal data than before it was pressed.
--
-- The fix (apps/api/internal/sar/sar.go) makes the endpoint branch on a new
-- request `kind`: an erase request now runs privacy.EraseSubscriber inside the
-- same tenant-scoped tx and persists a COUNTS-ONLY receipt. This migration
-- gives sar_bundles the two columns that make an erase row distinguishable and
-- auditable, and exposes the integrity aggregate the ops console watches.
--
-- Existing rows are all exports, hence kind DEFAULT 'access'.
--
-- rollback-strategy: expand-contract - the columns are additive with a safe
-- default; older code ignores them. Drop them and redeploy to roll back.

BEGIN;

ALTER TABLE sar_bundles
    ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'access';

ALTER TABLE sar_bundles
    ADD COLUMN IF NOT EXISTS rows_deleted bigint;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'sar_bundles_kind_check'
    ) THEN
        ALTER TABLE sar_bundles
            ADD CONSTRAINT sar_bundles_kind_check CHECK (kind IN ('access', 'erase'));
    END IF;
END
$$;

COMMENT ON COLUMN sar_bundles.kind IS
    'access = a subject-access export (bundle holds the full disclosure). '
    'erase = an Art. 17 erasure; bundle holds a COUNTS-ONLY receipt and must '
    'never contain the subject''s email or any other PII.';

COMMENT ON COLUMN sar_bundles.rows_deleted IS
    'Rows anonymized/deleted by an erase request. NULL for access rows. A zero '
    'here on an erase row means we told a data subject their data was erased '
    'while retaining it -- watched by the ops check privacy.erasure-integrity.';

-- Fleet read for the ops console. SECURITY DEFINER because sar_bundles is
-- tenant-scoped under FORCE RLS and postwave_ops holds no grant on it; the
-- return type is a bare count, so the function cannot leak a subject.
CREATE OR REPLACE FUNCTION ops_erasure_integrity()
RETURNS TABLE (unerased_fulfilled bigint)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT count(*)::bigint
      FROM sar_bundles
     WHERE kind = 'erase'
       AND requested_at > now() - interval '30 days'
       AND coalesce(rows_deleted, 0) = 0;
$$;

REVOKE ALL     ON FUNCTION ops_erasure_integrity() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ops_erasure_integrity() TO postwave_ops;

COMMIT;
