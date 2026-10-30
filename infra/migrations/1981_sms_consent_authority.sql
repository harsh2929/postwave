-- Route40: truthful carrier provenance and irreversible STOP authority.
BEGIN;

-- Historical Telnyx/Bandwidth consent events were projected as `product`
-- even though the provider column retains enough evidence to repair them.
ALTER TABLE sms_consent_events
  DROP CONSTRAINT IF EXISTS sms_consent_events_source_check;

UPDATE sms_consent_events
   SET source = provider
 WHERE source = 'product'
   AND provider IN ('telnyx', 'bandwidth');

ALTER TABLE sms_consent_events
  ADD CONSTRAINT sms_consent_events_source_check CHECK (source IN (
    'keyword','form','import','api','manual','twilio','telnyx','bandwidth','product'
  ));

-- Provider is an evidence domain, not a convenient non-null default. Repair
-- rows whose non-carrier source had the legacy implicit Twilio value, then
-- make future product/form/import/manual writes explicitly non-carrier.
UPDATE sms_consent_events
   SET provider = 'product', provider_event_id = NULL
 WHERE (
         source IN ('form','import','api','manual','product') OR
         (source = 'keyword' AND provider_event_id IS NULL)
       )
   AND provider IN ('twilio','telnyx','bandwidth');

ALTER TABLE sms_consent_events ALTER COLUMN provider SET DEFAULT 'product';
ALTER TABLE sms_consent_events
  DROP CONSTRAINT IF EXISTS sms_consent_events_provider_check;
ALTER TABLE sms_consent_events
  ADD CONSTRAINT sms_consent_events_provider_check
  CHECK (provider IN ('twilio','telnyx','bandwidth','product'));
ALTER TABLE sms_consent_events
  ADD CONSTRAINT sms_consent_events_provider_authority_check
  CHECK (
    (provider = 'product' AND provider_event_id IS NULL AND source IN ('keyword','form','import','api','manual','product')) OR
    (provider IN ('twilio','telnyx','bandwidth') AND source IN (provider, 'keyword') AND provider_event_id IS NOT NULL)
  );

ALTER TABLE sms_suppressions
  DROP CONSTRAINT IF EXISTS sms_suppressions_source_check;

-- A stable provider event id lets us prove provenance by joining the consent
-- ledger. Rows without such evidence remain conservatively labelled as their
-- historical source; this migration never guesses a carrier.
UPDATE sms_suppressions s
   SET source = e.provider
  FROM sms_consent_events e
 WHERE s.tenant_id = e.tenant_id
   AND s.source = 'api'
   AND s.source_event_id IS NOT NULL
   AND s.source_event_id = e.provider_event_id
   AND e.provider IN ('telnyx', 'bandwidth');

ALTER TABLE sms_suppressions
  ADD CONSTRAINT sms_suppressions_source_check CHECK (source IN (
    'twilio','telnyx','bandwidth','manual','api','import'
  ));

-- Tenant-defined opt-in words cannot restore a statutory carrier opt-out.
-- Disable and demote historical rows before narrowing the DB enum so a raw
-- writer cannot reintroduce the bypass behind API validation.
UPDATE sms_keyword_responses
   SET enabled = false, action = 'reply_only', updated_at = now()
 WHERE action = 'opt_in';

ALTER TABLE sms_keyword_responses
  DROP CONSTRAINT IF EXISTS sms_keyword_responses_action_check;
ALTER TABLE sms_keyword_responses
  ADD CONSTRAINT sms_keyword_responses_action_check
  CHECK (action IN ('reply_only','opt_out'));

ALTER TABLE sms_keyword_responses
  DROP CONSTRAINT IF EXISTS sms_keyword_responses_keyword_not_reserved_check;
ALTER TABLE sms_keyword_responses
  ADD CONSTRAINT sms_keyword_responses_keyword_not_reserved_check
  CHECK (keyword NOT IN (
    'STOP','STOPALL','UNSUBSCRIBE','END','QUIT','REVOKE','OPTOUT','CANCEL',
    'START','UNSTOP','HELP'
  ));

COMMIT;
