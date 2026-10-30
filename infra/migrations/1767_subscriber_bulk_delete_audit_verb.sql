-- 1767_subscriber_bulk_delete_audit_verb.sql
--
-- A privacy-grade bulk subscriber deletion is intentionally irreversible and
-- writes both the generic compliance audit and the operator-facing bulk
-- activity ledger. Migration 1301 omitted `delete` from that ledger's verb
-- vocabulary, so the hardened path could not commit its mandatory activity
-- record. Widen only that CHECK; no rows are rewritten.
--
-- rollback-strategy: no-op
-- rollback-details: leave the widened vocabulary in place. Older code ignores
-- `delete`; narrowing could invalidate retained compliance-audit evidence.

BEGIN;

ALTER TABLE public.subscriber_bulk_operations_audit
    DROP CONSTRAINT IF EXISTS subscriber_bulk_operations_audit_verb_check;

ALTER TABLE public.subscriber_bulk_operations_audit
    ADD CONSTRAINT subscriber_bulk_operations_audit_verb_check
    CHECK (verb IN (
        'delete',
        'resubscribe',
        'add_to_list',
        'set_custom_field',
        'update_merge_field',
        'grant_consent',
        'revoke_consent',
        'export_by_segment'
    )) NOT VALID;

ALTER TABLE public.subscriber_bulk_operations_audit
    VALIDATE CONSTRAINT subscriber_bulk_operations_audit_verb_check;

COMMENT ON CONSTRAINT subscriber_bulk_operations_audit_verb_check
    ON public.subscriber_bulk_operations_audit IS
    'Operator-facing bulk activity vocabulary, including irreversible privacy deletion.';

COMMIT;
