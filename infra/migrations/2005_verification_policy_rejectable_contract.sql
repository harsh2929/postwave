-- 2005_verification_policy_rejectable_contract.sql
--
-- The policy API advertises a closed rejection vocabulary. `valid` is a
-- canonical verification result, but it is evidence for admission and must
-- never become a configurable rejection rule. Migration 1850 intentionally
-- validated only the broader result vocabulary, so add the narrower contract
-- now that all writers and readers enforce it.
--
-- The constraint is NOT VALID to contain every new/update write without making
-- deployment depend on historical operator data. Runtime reads independently
-- reject a malformed legacy row with a constant, non-reflective error.
--
-- migration-execution: phased
-- rollback-strategy: expand-contract
-- rollback-details: Drop only after every writer and read-side gate has an
-- equivalent exact rejection-status allowlist.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE verification_policy
    ADD CONSTRAINT verification_policy_rejectable_statuses_contract_check CHECK (
        cardinality(forms_reject_statuses) BETWEEN 1 AND 6
        AND array_position(forms_reject_statuses, NULL) IS NULL
        AND forms_reject_statuses <@ ARRAY[
            'invalid', 'catch_all', 'spamtrap',
            'abuse', 'do_not_mail', 'unknown'
        ]::text[]
    ) NOT VALID;

COMMENT ON CONSTRAINT verification_policy_rejectable_statuses_contract_check
    ON verification_policy IS
    'Signup rejection rules exclude valid evidence and are bounded to the API-advertised closed set; legacy rows fail closed at runtime.';

COMMIT;
