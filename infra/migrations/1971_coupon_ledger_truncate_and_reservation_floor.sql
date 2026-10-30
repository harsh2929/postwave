-- Close two holes in the coupon-allocation safety work (PRD F04 prerequisites).
--
-- Both were found by adversarial review of migration 1970, and both are the same
-- kind of mistake: a guarantee asserted in prose that the schema did not
-- actually enforce.
--
-- 1. TRUNCATE ERASED THE APPEND-ONLY LEDGER SILENTLY.
--    1970 claims coupon_entitlement_events is append-only "three independent
--    ways", and that its trigger "binds the table owner and any superuser
--    statement, which privileges alone do not". That was false for one verb.
--    coupon_entitlement_events_write_guard is FOR EACH ROW; a row-level trigger
--    CANNOT fire on TRUNCATE (pg_trigger.tgtype = 31, and the TRUNCATE bit is
--    32), and REVOKE TRUNCATE binds only postwave_app. A reviewer proved it: as
--    the table owner, UPDATE and DELETE both raised, and TRUNCATE erased every
--    receipt and reported success.
--    That is precisely the outcome the entitlement ledger exists to prevent —
--    "we think we sent them a code" is not an answer to a chargeback, and an
--    audit trail that one ordinary statement removes without a guard-disabling
--    gesture is not an audit trail.
--
-- 2. A 'reserved' ROW COULD HAVE NO DEADLINE, AND NOTHING NOTICED.
--    Nothing tied status='reserved' to reserved_until IS NOT NULL. Both legs of
--    the expiry sweeper require reserved_until IS NOT NULL, and so does the
--    reconciliation drift check for a reservation past its deadline. So a
--    'reserved' row with a NULL deadline is held FOREVER, is never swept, and is
--    reported by NONE of the eight drift kinds — reconciliation returns Healthy
--    while the code is permanently lost inventory. That is verbatim the failure
--    the prerequisite was written to close.
--    The guarantee rested entirely on one Go call site always setting the
--    deadline, which is exactly what the rest of this work deliberately refused
--    to rely on: "this package is not the only writer, and a bound that only
--    exists in one caller is not a bound".
--
-- rollback-strategy: no-op. Dropping either guard re-opens a silent data-loss
-- path; roll back the application instead.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- 1. A STATEMENT-level TRUNCATE guard, which is the only shape that can refuse
-- TRUNCATE at all. Deliberately unconditional: there is no legitimate TRUNCATE
-- of an entitlement ledger, so unlike the retention exemptions elsewhere in this
-- schema there is no GUC that permits it.
CREATE OR REPLACE FUNCTION coupon_entitlement_events_truncate_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
    -- PWL02, the SAME code the row-level guard raises. A caller branching on
    -- "the ledger refused a mutation" must not have to know WHICH verb was
    -- attempted; a second code would mean every such caller had to learn both.
    RAISE EXCEPTION 'coupon entitlement receipts are append-only; TRUNCATE is refused'
        USING ERRCODE = 'PWL02';
END;
$fn$;

DROP TRIGGER IF EXISTS coupon_entitlement_events_truncate_guard
    ON coupon_entitlement_events;
CREATE TRIGGER coupon_entitlement_events_truncate_guard
    BEFORE TRUNCATE ON coupon_entitlement_events
    FOR EACH STATEMENT
    EXECUTE FUNCTION coupon_entitlement_events_truncate_guard();

-- 2. A reserved row must carry its deadline.
--
-- NOT VALID then VALIDATE, so the existing rows are checked without an
-- ACCESS EXCLUSIVE full-table lock. Any pre-existing violation would surface at
-- VALIDATE rather than being silently grandfathered — which is the point: a
-- reservation already stuck without a deadline is exactly the lost inventory
-- this constraint exists to reveal.
DO $$
BEGIN
    ALTER TABLE coupon_assignments
        DROP CONSTRAINT IF EXISTS coupon_assignments_reserved_has_deadline;
    ALTER TABLE coupon_assignments
        ADD CONSTRAINT coupon_assignments_reserved_has_deadline
        CHECK (status <> 'reserved' OR reserved_until IS NOT NULL) NOT VALID;

    ALTER TABLE coupon_codes
        DROP CONSTRAINT IF EXISTS coupon_codes_reserved_has_deadline;
    ALTER TABLE coupon_codes
        ADD CONSTRAINT coupon_codes_reserved_has_deadline
        CHECK (status <> 'reserved' OR reserved_until IS NOT NULL) NOT VALID;
END
$$;

ALTER TABLE coupon_assignments VALIDATE CONSTRAINT coupon_assignments_reserved_has_deadline;
ALTER TABLE coupon_codes VALIDATE CONSTRAINT coupon_codes_reserved_has_deadline;
