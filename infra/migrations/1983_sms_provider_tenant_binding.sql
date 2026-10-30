-- Route40: a provider receiver/application identity belongs to exactly one
-- tenant. Count-only preflight makes ambiguity explicit before either
-- concurrent unique-index build begins. This file must remain outside an
-- explicit transaction because PostgreSQL requires that for CONCURRENTLY.
DO $$
DECLARE
  phone_conflicts bigint;
  profile_conflicts bigint;
BEGIN
  SELECT COUNT(*) INTO phone_conflicts
    FROM (
      SELECT provider, phone_number
        FROM sms_sender_profiles
       WHERE phone_number IS NOT NULL AND btrim(phone_number) <> ''
       GROUP BY provider, phone_number
      HAVING COUNT(*) > 1
    ) conflicts;

  SELECT COUNT(*) INTO profile_conflicts
    FROM (
      SELECT provider, messaging_service_sid
        FROM sms_sender_profiles
       WHERE messaging_service_sid IS NOT NULL AND btrim(messaging_service_sid) <> ''
       GROUP BY provider, messaging_service_sid
      HAVING COUNT(*) > 1
    ) conflicts;

  IF phone_conflicts > 0 OR profile_conflicts > 0 THEN
    RAISE EXCEPTION
      'sms provider receiver ownership preflight failed: % duplicate provider/phone group(s), % duplicate provider/profile group(s); resolve ownership before retrying migration 1983',
      phone_conflicts,
      profile_conflicts;
  END IF;
END
$$;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS sms_sender_profiles_provider_phone_unique
  ON sms_sender_profiles (provider, phone_number)
  WHERE phone_number IS NOT NULL AND btrim(phone_number) <> '';

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS sms_sender_profiles_provider_profile_unique
  ON sms_sender_profiles (provider, messaging_service_sid)
  WHERE messaging_service_sid IS NOT NULL AND btrim(messaging_service_sid) <> '';

COMMENT ON INDEX sms_sender_profiles_provider_phone_unique IS
  'Cross-tenant webhook receiver ownership boundary; ambiguous provider phone identities are forbidden.';
COMMENT ON INDEX sms_sender_profiles_provider_profile_unique IS
  'Cross-tenant Telnyx messaging-profile/Bandwidth application ownership boundary.';
