-- Exact per-message read evidence for the SMS inbox. A wall-clock read_at
-- marker can incorrectly hide an inbound transaction that began earlier but
-- committed after the operator loaded the thread. Receipts name only inbound
-- messages the client successfully decoded and explicitly acknowledged.

-- sms_messages can be large. Build the redundant tenant ownership key online;
-- the migration runner verifies/retries concurrent index phases before the
-- brief constraint-attachment transaction below.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS sms_messages_tenant_id_id_unique_idx
  ON sms_messages (tenant_id, id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.sms_messages'::regclass
       AND conname = 'sms_messages_tenant_id_id_unique'
  ) THEN
    ALTER TABLE sms_messages
      ADD CONSTRAINT sms_messages_tenant_id_id_unique
      UNIQUE USING INDEX sms_messages_tenant_id_id_unique_idx;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS sms_message_read_receipts (
  tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  message_id  uuid        NOT NULL,
  read_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, message_id),
  CONSTRAINT sms_message_read_receipts_message_fk
    FOREIGN KEY (tenant_id, message_id)
    REFERENCES sms_messages (tenant_id, id)
    ON DELETE CASCADE
);

-- Preserve the meaning of historical conversation read_at markers once the
-- projection switches to exact receipts. This is a one-time bounded migration
-- over retained inbound messages; new writes never infer visibility by time.
INSERT INTO sms_message_read_receipts (tenant_id, message_id, read_at)
SELECT m.tenant_id, m.id, st.read_at
  FROM sms_messages m
  JOIN sms_conversation_state st
    ON st.tenant_id = m.tenant_id AND st.phone_e164 = m.phone_e164
 WHERE m.direction = 'inbound'
   AND st.read_at IS NOT NULL
   AND m.created_at <= st.read_at
ON CONFLICT (tenant_id, message_id) DO NOTHING;

ALTER TABLE sms_message_read_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_message_read_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sms_message_read_receipts_tenant_isolation ON sms_message_read_receipts;
CREATE POLICY sms_message_read_receipts_tenant_isolation
  ON sms_message_read_receipts
  FOR ALL
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT ON sms_message_read_receipts TO postwave_app;

COMMENT ON TABLE sms_message_read_receipts IS
  'Exact inbound SMS records acknowledged by an operator. Subject identity remains in the referenced message and cascades on message deletion.';
