-- Expand sms_messages.status for provider-native delivery states that are
-- emitted by Twilio status callbacks and should not collapse to queued.

ALTER TABLE sms_messages
  DROP CONSTRAINT IF EXISTS sms_messages_status_check;

ALTER TABLE sms_messages
  ADD CONSTRAINT sms_messages_status_check CHECK (
    status IN (
      'accepted',
      'scheduled',
      'queued',
      'sent',
      'delivered',
      'failed',
      'undelivered',
      'received',
      'read',
      'partially_delivered',
      'canceled'
    )
  );
