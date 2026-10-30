-- One unresolved provider-bound reply per tenant/recipient. Canonical writers
-- also take the same tenant+phone advisory lock, but this partial unique index
-- makes the invariant survive raw/alternate/future writers that omit it.

DO $$
DECLARE
  duplicate_groups bigint;
  duplicate_keys bigint;
BEGIN
  SELECT COUNT(*) INTO duplicate_groups
    FROM (
      SELECT tenant_id, phone_e164
        FROM sms_messages
       WHERE direction = 'outbound'
         AND dispatch_state IN ('reserved','reconciliation_required')
       GROUP BY tenant_id, phone_e164
      HAVING COUNT(*) > 1
    ) conflicts;
  IF duplicate_groups > 0 THEN
    RAISE EXCEPTION
      'sms unresolved-reply preflight failed: % tenant/phone group(s) have multiple reserved/reconciliation rows; reconcile without resending before retrying migration 1987',
      duplicate_groups;
  END IF;

  SELECT COUNT(*) INTO duplicate_keys
    FROM (
      SELECT tenant_id, dispatch_idempotency_key
        FROM sms_messages
       WHERE dispatch_idempotency_key IS NOT NULL
       GROUP BY tenant_id, dispatch_idempotency_key
      HAVING COUNT(*) > 1
    ) conflicts;
  IF duplicate_keys > 0 THEN
    RAISE EXCEPTION
      'sms reply-intent preflight failed: % tenant/scoped-key group(s) are duplicated; reconcile without resending before retrying migration 1987',
      duplicate_keys;
  END IF;
END
$$;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS sms_messages_dispatch_intent_unique
  ON sms_messages (tenant_id, dispatch_idempotency_key)
  WHERE dispatch_idempotency_key IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS sms_messages_dispatch_reconciliation_idx
  ON sms_messages (tenant_id, created_at)
  WHERE dispatch_state = 'reconciliation_required';

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS sms_messages_one_unresolved_reply_per_phone
  ON sms_messages (tenant_id, phone_e164)
  WHERE direction = 'outbound'
    AND dispatch_state IN ('reserved','reconciliation_required');
