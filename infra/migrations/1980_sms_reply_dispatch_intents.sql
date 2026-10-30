-- Durable pre-provider intent for inbox replies. The key is the
-- principal-scoped one-way storage key produced by idempotency.Process, never
-- the caller's raw Idempotency-Key.

ALTER TABLE sms_messages
  ADD COLUMN IF NOT EXISTS dispatch_idempotency_key text,
  ADD COLUMN IF NOT EXISTS dispatch_state text;

ALTER TABLE sms_messages
  DROP CONSTRAINT IF EXISTS sms_messages_dispatch_idempotency_key_check;
ALTER TABLE sms_messages
  ADD CONSTRAINT sms_messages_dispatch_idempotency_key_check CHECK (
    dispatch_idempotency_key IS NULL OR
    dispatch_idempotency_key ~ '^scope-v1:[0-9a-f]{64}$'
  );

ALTER TABLE sms_messages
  DROP CONSTRAINT IF EXISTS sms_messages_dispatch_state_check;
ALTER TABLE sms_messages
  ADD CONSTRAINT sms_messages_dispatch_state_check CHECK (
    dispatch_state IS NULL OR dispatch_state IN (
      'reserved',
      'persisted',
      'provider_failed',
      'reconciliation_required'
    )
  );

COMMENT ON COLUMN sms_messages.dispatch_idempotency_key IS
  'Principal-scoped one-way replay key. Raw Idempotency-Key values are forbidden.';
COMMENT ON COLUMN sms_messages.dispatch_state IS
  'Durable inbox reply provider-boundary state; reconciliation_required is non-retriable.';

-- The potentially large-table indexes for these columns are built
-- CONCURRENTLY by migration 1987 after its duplicate preflight. Keeping them
-- out of this transactional migration avoids blocking sms_messages writers.
