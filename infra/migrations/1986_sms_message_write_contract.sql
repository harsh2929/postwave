-- Route40 canonical sms_messages write contract. NOT VALID is deliberate:
-- every new insert/update is checked immediately, while historical poison is
-- surfaced by the inbox as an explicit omitted-body state instead of turning
-- one legacy row into a whole-page outage. A privileged preflight must clear
-- the remaining historical violations before these constraints are validated.

ALTER TABLE sms_messages
  ADD CONSTRAINT sms_messages_id_contract_check
  CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') NOT VALID;

ALTER TABLE sms_messages
  ADD CONSTRAINT sms_messages_tenant_id_contract_check
  CHECK (tenant_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') NOT VALID;

ALTER TABLE sms_messages
  ADD CONSTRAINT sms_messages_optional_ids_contract_check
  CHECK (
    (campaign_id IS NULL OR campaign_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') AND
    (sender_profile_id IS NULL OR sender_profile_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
  ) NOT VALID;

ALTER TABLE sms_messages
  ADD CONSTRAINT sms_messages_phone_e164_contract_check
  CHECK (phone_e164 ~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$') NOT VALID;

ALTER TABLE sms_messages
  ADD CONSTRAINT sms_messages_provider_contract_check
  CHECK (provider IN ('twilio','telnyx','bandwidth')) NOT VALID;

ALTER TABLE sms_messages
  ADD CONSTRAINT sms_messages_provider_message_id_contract_check
  CHECK (
    provider_message_id IS NULL OR
    (length(provider_message_id) BETWEEN 1 AND 256 AND provider_message_id ~ '^[A-Za-z0-9_.:-]+$')
  ) NOT VALID;

ALTER TABLE sms_messages
  ADD CONSTRAINT sms_messages_body_contract_check
  CHECK (octet_length(body) <= 16384 AND char_length(body) <= 4800 AND body ~ '[^[:space:]]') NOT VALID;

ALTER TABLE sms_messages
  ADD CONSTRAINT sms_messages_numeric_contract_check
  CHECK (segments BETWEEN 1 AND 1000 AND cost_micros >= 0) NOT VALID;

ALTER TABLE sms_messages
  ADD CONSTRAINT sms_messages_metadata_contract_check
  CHECK (jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 8192) NOT VALID;

ALTER TABLE sms_messages
  ADD CONSTRAINT sms_messages_error_contract_check
  CHECK (
    (error_code IS NULL OR (length(error_code) BETWEEN 1 AND 64 AND error_code ~ '^[A-Za-z0-9_-]+$')) AND
    (error_message IS NULL OR (
      octet_length(error_message) <= 2048 AND char_length(error_message) <= 512 AND
      error_message !~ '[[:cntrl:]]' AND
      error_message !~ '[​‌‍‎‏‪‫‬‭‮⁠⁡⁢⁣⁤⁦⁧⁨⁩﻿]'
    ))
  ) NOT VALID;

ALTER TABLE sms_messages
  ADD CONSTRAINT sms_messages_timestamp_contract_check
  CHECK (
    created_at >= TIMESTAMPTZ '2000-01-01T00:00:00Z' AND
    created_at < TIMESTAMPTZ '2100-01-01T00:00:00Z' AND
    (sent_at IS NULL OR (sent_at >= TIMESTAMPTZ '2000-01-01T00:00:00Z' AND sent_at < TIMESTAMPTZ '2100-01-01T00:00:00Z')) AND
    (delivered_at IS NULL OR (delivered_at >= TIMESTAMPTZ '2000-01-01T00:00:00Z' AND delivered_at < TIMESTAMPTZ '2100-01-01T00:00:00Z')) AND
    (received_at IS NULL OR (received_at >= TIMESTAMPTZ '2000-01-01T00:00:00Z' AND received_at < TIMESTAMPTZ '2100-01-01T00:00:00Z')) AND
    (sent_at IS NULL OR sent_at >= created_at) AND
    (received_at IS NULL OR received_at >= created_at) AND
    (delivered_at IS NULL OR delivered_at >= COALESCE(sent_at, created_at))
  ) NOT VALID;

ALTER TABLE sms_messages
  ADD CONSTRAINT sms_messages_media_url_contract_check
  CHECK (
    media_url IS NULL OR (
      octet_length(media_url) <= 2048 AND
      media_url ~* '^https://[^[:space:]]+$' AND
      media_url !~ '[[:cntrl:]]' AND
      media_url !~* '^https://[^/]*@' AND
      position('#' in media_url) = 0
    )
  ) NOT VALID;

ALTER TABLE sms_messages
  ADD CONSTRAINT sms_messages_dispatch_relation_contract_check
  CHECK (
    (
      dispatch_idempotency_key IS NULL AND
      dispatch_request_hash IS NULL AND
      dispatch_state IS NULL
    ) OR (
      dispatch_idempotency_key IS NOT NULL AND
      dispatch_request_hash IS NOT NULL AND
      dispatch_state IS NOT NULL AND
      direction = 'outbound' AND
      sender_profile_id IS NOT NULL AND
      (dispatch_state <> 'persisted' OR provider_message_id IS NOT NULL)
    )
  ) NOT VALID;

COMMENT ON CONSTRAINT sms_messages_body_contract_check ON sms_messages IS
  'New-write bound shared by inbound, reply, broadcast, desktop, mobile, and web inbox projections: valid PostgreSQL UTF-8 text, <=16384 bytes and <=4800 Unicode code points.';

COMMENT ON CONSTRAINT sms_messages_metadata_contract_check ON sms_messages IS
  'New-write metadata must be a bounded JSON object. Provider webhook writers persist a strict evidence allowlist, never raw envelopes.';

COMMENT ON CONSTRAINT sms_messages_error_contract_check ON sms_messages IS
  'Provider failures are bounded safe evidence: a tokenized code and a small control/format-free message; raw provider response bodies are not canonical sms_messages fields.';

COMMENT ON CONSTRAINT sms_messages_dispatch_relation_contract_check ON sms_messages IS
  'Reply intent key, exact request hash and lifecycle are one relational unit; intent state is outbound-only and persisted requires a provider receipt id.';

-- Count-only historical release gate. It runs in this same migration
-- transaction as the NOT VALID constraints above: any poison aborts and rolls
-- back the new-write contract instead of stranding an old binary behind a
-- partially applied schema. No phone/body/provider value is selected.
DO $$
DECLARE
  invalid_identity bigint;
  invalid_phone bigint;
  invalid_provider bigint;
  invalid_provider_id bigint;
  invalid_body bigint;
  invalid_media bigint;
  invalid_numeric bigint;
  invalid_metadata bigint;
  invalid_error bigint;
  invalid_timestamp bigint;
  invalid_dispatch bigint;
BEGIN
  SELECT
    COUNT(*) FILTER (WHERE
      id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' OR
      tenant_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' OR
      (campaign_id IS NOT NULL AND campaign_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') OR
      (sender_profile_id IS NOT NULL AND sender_profile_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')),
    COUNT(*) FILTER (WHERE phone_e164 !~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$'),
    COUNT(*) FILTER (WHERE provider NOT IN ('twilio','telnyx','bandwidth')),
    COUNT(*) FILTER (WHERE provider_message_id IS NOT NULL AND NOT (
      length(provider_message_id) BETWEEN 1 AND 256 AND provider_message_id ~ '^[A-Za-z0-9_.:-]+$')),
    COUNT(*) FILTER (WHERE octet_length(body) > 16384 OR char_length(body) > 4800 OR body !~ '[^[:space:]]'),
    COUNT(*) FILTER (WHERE media_url IS NOT NULL AND NOT (
      octet_length(media_url) <= 2048 AND media_url ~* '^https://[^[:space:]]+$' AND
      media_url !~ '[[:cntrl:]]' AND media_url !~* '^https://[^/]*@' AND position('#' in media_url) = 0)),
    COUNT(*) FILTER (WHERE segments NOT BETWEEN 1 AND 1000 OR cost_micros < 0),
    COUNT(*) FILTER (WHERE jsonb_typeof(metadata) <> 'object' OR octet_length(metadata::text) > 8192),
    COUNT(*) FILTER (WHERE
      (error_code IS NOT NULL AND NOT (length(error_code) BETWEEN 1 AND 64 AND error_code ~ '^[A-Za-z0-9_-]+$')) OR
      (error_message IS NOT NULL AND NOT (
        octet_length(error_message) <= 2048 AND char_length(error_message) <= 512 AND
        error_message !~ '[[:cntrl:]]' AND
        error_message !~ '[​‌‍‎‏‪‫‬‭‮⁠⁡⁢⁣⁤⁦⁧⁨⁩﻿]'))),
    COUNT(*) FILTER (WHERE
      created_at < TIMESTAMPTZ '2000-01-01T00:00:00Z' OR created_at >= TIMESTAMPTZ '2100-01-01T00:00:00Z' OR
      (sent_at IS NOT NULL AND (sent_at < TIMESTAMPTZ '2000-01-01T00:00:00Z' OR sent_at >= TIMESTAMPTZ '2100-01-01T00:00:00Z')) OR
      (delivered_at IS NOT NULL AND (delivered_at < TIMESTAMPTZ '2000-01-01T00:00:00Z' OR delivered_at >= TIMESTAMPTZ '2100-01-01T00:00:00Z')) OR
      (received_at IS NOT NULL AND (received_at < TIMESTAMPTZ '2000-01-01T00:00:00Z' OR received_at >= TIMESTAMPTZ '2100-01-01T00:00:00Z')) OR
      (sent_at IS NOT NULL AND sent_at < created_at) OR
      (received_at IS NOT NULL AND received_at < created_at) OR
      (delivered_at IS NOT NULL AND delivered_at < COALESCE(sent_at, created_at))),
    COUNT(*) FILTER (WHERE NOT (
      (dispatch_idempotency_key IS NULL AND dispatch_request_hash IS NULL AND dispatch_state IS NULL) OR
      (dispatch_idempotency_key IS NOT NULL AND dispatch_request_hash IS NOT NULL AND dispatch_state IS NOT NULL AND
       direction = 'outbound' AND sender_profile_id IS NOT NULL AND
       (dispatch_state <> 'persisted' OR provider_message_id IS NOT NULL))
    ))
  INTO invalid_identity, invalid_phone, invalid_provider, invalid_provider_id,
       invalid_body, invalid_media, invalid_numeric, invalid_metadata, invalid_error, invalid_timestamp, invalid_dispatch
  FROM sms_messages;

  IF invalid_identity + invalid_phone + invalid_provider + invalid_provider_id +
     invalid_body + invalid_media + invalid_numeric + invalid_metadata + invalid_error + invalid_timestamp + invalid_dispatch > 0 THEN
    RAISE EXCEPTION USING
      MESSAGE = 'sms_messages Route40 historical contract preflight failed',
      DETAIL = format(
        'identity=%s phone=%s provider=%s provider_id=%s body=%s media=%s numeric=%s metadata=%s error=%s timestamp=%s dispatch=%s; run a reviewed evidence-preserving remediation before retrying migration 1986',
        invalid_identity, invalid_phone, invalid_provider, invalid_provider_id,
        invalid_body, invalid_media, invalid_numeric, invalid_metadata, invalid_error, invalid_timestamp, invalid_dispatch
      );
  END IF;
END
$$;

ALTER TABLE sms_messages VALIDATE CONSTRAINT sms_messages_id_contract_check;
ALTER TABLE sms_messages VALIDATE CONSTRAINT sms_messages_tenant_id_contract_check;
ALTER TABLE sms_messages VALIDATE CONSTRAINT sms_messages_optional_ids_contract_check;
ALTER TABLE sms_messages VALIDATE CONSTRAINT sms_messages_phone_e164_contract_check;
ALTER TABLE sms_messages VALIDATE CONSTRAINT sms_messages_provider_contract_check;
ALTER TABLE sms_messages VALIDATE CONSTRAINT sms_messages_provider_message_id_contract_check;
ALTER TABLE sms_messages VALIDATE CONSTRAINT sms_messages_body_contract_check;
ALTER TABLE sms_messages VALIDATE CONSTRAINT sms_messages_numeric_contract_check;
ALTER TABLE sms_messages VALIDATE CONSTRAINT sms_messages_metadata_contract_check;
ALTER TABLE sms_messages VALIDATE CONSTRAINT sms_messages_error_contract_check;
ALTER TABLE sms_messages VALIDATE CONSTRAINT sms_messages_timestamp_contract_check;
ALTER TABLE sms_messages VALIDATE CONSTRAINT sms_messages_media_url_contract_check;
ALTER TABLE sms_messages VALIDATE CONSTRAINT sms_messages_dispatch_relation_contract_check;
