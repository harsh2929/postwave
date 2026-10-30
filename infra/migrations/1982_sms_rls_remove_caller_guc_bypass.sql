-- Route40 release hold: an ordinary application session can set arbitrary
-- custom GUCs, so app.sms_worker/app.sms_click_redirect are not identities.
-- Remove every permissive cross-tenant policy. Queue draining, scheduled
-- discovery, and click redirect remain intentionally unavailable until the
-- deployment supplies a separate least-privilege database principal.
BEGIN;

DROP POLICY IF EXISTS sms_worker_campaigns ON sms_campaigns;
DROP POLICY IF EXISTS sms_worker_recipients ON sms_campaign_recipients;
DROP POLICY IF EXISTS sms_worker_messages ON sms_messages;
DROP POLICY IF EXISTS sms_worker_broadcasts ON sms_broadcasts;
DROP POLICY IF EXISTS sms_worker_sender_profiles ON sms_sender_profiles;
DROP POLICY IF EXISTS sms_worker_throttle_state ON sms_send_throttle_state;

DROP POLICY IF EXISTS sms_click_redirect_lookup ON sms_link_tokens;
DROP POLICY IF EXISTS sms_click_redirect_insert ON sms_link_clicks;

COMMENT ON TABLE sms_campaign_recipients IS
  'Tenant-RLS only. Cross-tenant SMS worker discovery is release-held until a dedicated DB identity is provisioned; caller-settable GUCs confer no access.';
COMMENT ON TABLE sms_link_tokens IS
  'Tenant-RLS only. Public redirect lookup is release-held until a dedicated bounded resolver identity/function is provisioned; caller-settable GUCs confer no access.';

COMMIT;
