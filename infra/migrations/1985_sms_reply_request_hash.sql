-- Exact raw request identity for handler-owned inbox reply replay. This is a
-- SHA-256 digest of method + escaped target + raw body; no phone/body/key is
-- recoverable from it. Existing experimental intent rows cannot be safely
-- reconstructed and remain NULL/fail-closed for recovery.

ALTER TABLE sms_messages
  ADD COLUMN IF NOT EXISTS dispatch_request_hash text;

ALTER TABLE sms_messages
  DROP CONSTRAINT IF EXISTS sms_messages_dispatch_request_hash_check;
ALTER TABLE sms_messages
  ADD CONSTRAINT sms_messages_dispatch_request_hash_check CHECK (
    dispatch_request_hash IS NULL OR dispatch_request_hash ~ '^[0-9a-f]{64}$'
  );

COMMENT ON COLUMN sms_messages.dispatch_request_hash IS
  'Exact SHA-256 request identity for handler-owned reply replay; contains no raw Idempotency-Key or request values.';
