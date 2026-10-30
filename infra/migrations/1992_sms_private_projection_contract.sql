-- Route40 strict private-projection and consent-evidence contract.
--
-- The constraints are NOT VALID so every new write is contained immediately.
-- Migration 1993 performs a count-only privileged historical preflight before
-- validation. No recipient text, phone, provider receipt, or proof is emitted
-- by either phase.

CREATE OR REPLACE FUNCTION public.sms_contract_text_valid(
  p_value text,
  p_max_chars integer,
  p_max_bytes integer,
  p_allow_empty boolean,
  p_require_trim boolean
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
DECLARE
  i integer;
  cp integer;
  ch text;
  is_space boolean;
  visible boolean := false;
BEGIN
  IF char_length(p_value) > p_max_chars OR octet_length(p_value) > p_max_bytes THEN
    RETURN false;
  END IF;
  FOR i IN 1..char_length(p_value) LOOP
    ch := substr(p_value, i, 1);
    cp := ascii(ch);
    -- Unicode Cc and Cf. These values mirror unicode.IsControl/Cf in the Go
    -- materializer and block bidi/format spoofing in operator-visible fields.
    IF cp <= 31 OR (cp BETWEEN 127 AND 159) OR cp IN (173,1564,1807,6158,65279) OR
       (cp BETWEEN 1536 AND 1541) OR cp = 1757 OR (cp BETWEEN 2192 AND 2193) OR cp = 2274 OR
       (cp BETWEEN 8203 AND 8207) OR (cp BETWEEN 8234 AND 8238) OR
       (cp BETWEEN 8288 AND 8292) OR (cp BETWEEN 8294 AND 8303) OR
       (cp BETWEEN 65529 AND 65531) OR cp IN (69821,69837) OR
       (cp BETWEEN 78896 AND 78911) OR (cp BETWEEN 113824 AND 113827) OR
       (cp BETWEEN 119155 AND 119162) OR cp = 917505 OR (cp BETWEEN 917536 AND 917631) THEN
      RETURN false;
    END IF;
    is_space := cp IN (9,10,11,12,13,32,133,160,5760,8232,8233,8239,8287,12288)
      OR (cp BETWEEN 8192 AND 8202);
    IF p_require_trim AND is_space AND (i = 1 OR i = char_length(p_value)) THEN
      RETURN false;
    END IF;
    visible := visible OR NOT is_space;
  END LOOP;
  RETURN p_allow_empty OR visible;
END
$$;

CREATE OR REPLACE FUNCTION public.sms_uuid_v4_valid(p_value uuid) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
  SELECT p_value::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
$$;

CREATE OR REPLACE FUNCTION public.sms_timestamp_valid(p_value timestamptz) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
  SELECT p_value >= TIMESTAMPTZ '2000-01-01T00:00:00Z'
     AND p_value <  TIMESTAMPTZ '2100-01-01T00:00:00Z'
$$;

CREATE OR REPLACE FUNCTION public.sms_uuid_v4_array_valid(p_values uuid[], p_max integer) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
DECLARE
  item uuid;
  seen uuid[] := ARRAY[]::uuid[];
BEGIN
  IF cardinality(p_values) > p_max THEN
    RETURN false;
  END IF;
  FOREACH item IN ARRAY p_values LOOP
    IF item IS NULL OR NOT public.sms_uuid_v4_valid(item) OR item = ANY(seen) THEN
      RETURN false;
    END IF;
    seen := array_append(seen, item);
  END LOOP;
  RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION public.sms_weekdays_valid(p_values integer[]) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
DECLARE
  item integer;
  previous integer := -1;
BEGIN
  IF cardinality(p_values) NOT BETWEEN 1 AND 7 THEN
    RETURN false;
  END IF;
  FOREACH item IN ARRAY p_values LOOP
    IF item NOT BETWEEN 0 AND 6 OR item <= previous THEN
      RETURN false;
    END IF;
    previous := item;
  END LOOP;
  RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION public.sms_proof_contract_valid(p_proof jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
  SELECT COALESCE(jsonb_typeof(p_proof) = 'object'
     AND octet_length(p_proof::text) <= 8192
     AND p_proof->>'evidence_type' IN
       ('carrier_keyword','tap_to_text','web_form','signed_import','operator_attestation')
     AND jsonb_typeof(p_proof->'evidence_id') = 'string'
     AND length(p_proof->>'evidence_id') BETWEEN 1 AND 256
     AND (p_proof->>'evidence_id') ~ '^[A-Za-z0-9_.:-]+$', false)
$$;

CREATE OR REPLACE FUNCTION public.sms_sender_metadata_structurally_valid(p_metadata jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
  SELECT COALESCE(jsonb_typeof(p_metadata) = 'object'
     AND octet_length(p_metadata::text) <= 8192
     AND (
       NOT (p_metadata ? 'quiet_hours') OR p_metadata->'quiet_hours' = 'null'::jsonb OR (
         jsonb_typeof(p_metadata->'quiet_hours') = 'object' AND
         (p_metadata->'quiet_hours'->>'start') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND
         (p_metadata->'quiet_hours'->>'end') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND
         COALESCE(public.sms_contract_text_valid(p_metadata->'quiet_hours'->>'timezone', 128, 512, false, true), false)
       )
     ), false)
$$;

CREATE OR REPLACE FUNCTION public.sms_subscription_evidence_structurally_valid(
  p_status text,
  p_source text,
  p_consent_text text,
  p_consent_at timestamptz,
  p_proof jsonb
) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
  SELECT COALESCE(p_status = 'opted_in'
     AND p_source IN ('keyword','form','import','api','manual')
     AND p_consent_at IS NOT NULL
     AND public.sms_timestamp_valid(p_consent_at)
     AND public.sms_contract_text_valid(p_consent_text, 512, 2048, false, true)
     AND public.sms_proof_contract_valid(p_proof), false)
$$;

-- Authorization predicate used by every dispatch/audience/context/projection
-- reader. Structural proof is necessary but not sufficient: a matching
-- immutable grant event in the same tenant/list/phone evidence domain must
-- exist, and future-dated evidence never authorizes a send.
CREATE OR REPLACE FUNCTION public.sms_subscription_send_eligible(
  p_tenant_id uuid,
  p_list_id uuid,
  p_phone_e164 text,
  p_status text,
  p_source text,
  p_consent_text text,
  p_consent_at timestamptz,
  p_proof jsonb
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
  SELECT public.sms_subscription_evidence_structurally_valid(
           p_status, p_source, p_consent_text, p_consent_at, p_proof)
     AND p_consent_at <= statement_timestamp()
     AND EXISTS (
       SELECT 1
         FROM public.sms_consent_events e
        WHERE e.tenant_id = p_tenant_id
          AND e.list_id = p_list_id
          AND e.phone_e164 = p_phone_e164
          AND e.action = 'granted'
          AND e.source = p_source
          AND e.proof_text = p_consent_text
          AND e.metadata = p_proof
          AND e.created_at BETWEEN p_consent_at - interval '10 minutes'
                               AND p_consent_at + interval '10 minutes'
     )
$$;

ALTER TABLE sms_sender_profiles
  ADD CONSTRAINT sms_sender_profiles_private_projection_check CHECK (
    public.sms_uuid_v4_valid(id) AND public.sms_uuid_v4_valid(tenant_id) AND
    (phone_number IS NULL OR phone_number ~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$') AND
    (phone_number IS NOT NULL OR messaging_service_sid IS NOT NULL) AND
    (messaging_service_sid IS NULL OR (length(messaging_service_sid) BETWEEN 1 AND 256 AND messaging_service_sid ~ '^[A-Za-z0-9_.:-]+$')) AND
    (brand_registration_sid IS NULL OR (length(brand_registration_sid) BETWEEN 1 AND 256 AND brand_registration_sid ~ '^[A-Za-z0-9_.:-]+$')) AND
    (campaign_registration_sid IS NULL OR (length(campaign_registration_sid) BETWEEN 1 AND 256 AND campaign_registration_sid ~ '^[A-Za-z0-9_.:-]+$')) AND
    jsonb_typeof(capabilities) = 'object' AND octet_length(capabilities::text) <= 8192 AND
    public.sms_sender_metadata_structurally_valid(metadata) AND
    public.sms_timestamp_valid(created_at) AND public.sms_timestamp_valid(updated_at) AND updated_at >= created_at
  ) NOT VALID;

ALTER TABLE sms_lists
  ADD CONSTRAINT sms_lists_private_projection_check CHECK (
    public.sms_uuid_v4_valid(id) AND public.sms_uuid_v4_valid(tenant_id) AND
    (sender_profile_id IS NULL OR public.sms_uuid_v4_valid(sender_profile_id)) AND
    public.sms_contract_text_valid(name, 256, 1024, false, true) AND
    public.sms_contract_text_valid(description, 2048, 8192, true, false) AND
    (keyword IS NULL OR public.sms_contract_text_valid(keyword, 64, 256, false, true)) AND
    public.sms_timestamp_valid(created_at) AND public.sms_timestamp_valid(updated_at) AND updated_at >= created_at
  ) NOT VALID;

ALTER TABLE sms_subscriptions
  ADD CONSTRAINT sms_subscriptions_private_projection_check CHECK (
    public.sms_uuid_v4_valid(id) AND public.sms_uuid_v4_valid(tenant_id) AND public.sms_uuid_v4_valid(list_id) AND
    phone_e164 ~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$' AND
    (subscriber_email IS NULL OR public.sms_contract_text_valid(subscriber_email::text, 320, 1280, false, true)) AND
    public.sms_contract_text_valid(consent_text, 512, 2048, true, false) AND
    jsonb_typeof(proof) = 'object' AND octet_length(proof::text) <= 8192 AND
    public.sms_timestamp_valid(created_at) AND public.sms_timestamp_valid(updated_at) AND updated_at >= created_at AND
    (consent_at IS NULL OR public.sms_timestamp_valid(consent_at)) AND
    (opt_out_at IS NULL OR public.sms_timestamp_valid(opt_out_at)) AND
    CASE status
      WHEN 'opted_in' THEN opt_out_at IS NULL AND public.sms_subscription_evidence_structurally_valid(status, consent_source, consent_text, consent_at, proof)
      WHEN 'opted_out' THEN consent_at IS NULL AND opt_out_at IS NOT NULL
      WHEN 'pending' THEN consent_at IS NULL AND opt_out_at IS NULL
      ELSE false
    END
  ) NOT VALID;

ALTER TABLE sms_consent_events
  ADD CONSTRAINT sms_consent_events_private_projection_check CHECK (
    public.sms_uuid_v4_valid(id) AND public.sms_uuid_v4_valid(tenant_id) AND
    (list_id IS NULL OR public.sms_uuid_v4_valid(list_id)) AND
    phone_e164 ~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$' AND
    (subscriber_email IS NULL OR public.sms_contract_text_valid(subscriber_email::text, 320, 1280, false, true)) AND
    public.sms_contract_text_valid(proof_text, 512, 2048, true, false) AND
    (provider_event_id IS NULL OR (length(provider_event_id) BETWEEN 1 AND 256 AND provider_event_id ~ '^[A-Za-z0-9_.:-]+$')) AND
    jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 8192 AND
    public.sms_timestamp_valid(created_at)
  ) NOT VALID;

ALTER TABLE sms_suppressions
  ADD CONSTRAINT sms_suppressions_private_projection_check CHECK (
    public.sms_uuid_v4_valid(id) AND public.sms_uuid_v4_valid(tenant_id) AND
    phone_e164 ~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$' AND
    (phone IS NULL OR phone = phone_e164) AND
    (source_event_id IS NULL OR (length(source_event_id) BETWEEN 1 AND 256 AND source_event_id ~ '^[A-Za-z0-9_.:-]+$')) AND
    jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 8192 AND
    public.sms_timestamp_valid(created_at) AND
    (expires_at IS NULL OR public.sms_timestamp_valid(expires_at))
  ) NOT VALID;

ALTER TABLE sms_conversation_state
  ADD CONSTRAINT sms_conversation_state_private_projection_check CHECK (
    public.sms_uuid_v4_valid(tenant_id) AND
    phone_e164 ~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$' AND
    public.sms_contract_text_valid(notes, 4000, 16000, true, false) AND
    (assignee_user_id IS NULL OR public.sms_uuid_v4_valid(assignee_user_id)) AND
    public.sms_timestamp_valid(updated_at) AND
    (read_at IS NULL OR public.sms_timestamp_valid(read_at)) AND
    (snooze_until IS NULL OR public.sms_timestamp_valid(snooze_until)) AND
    (archived_at IS NULL OR public.sms_timestamp_valid(archived_at))
  ) NOT VALID;

ALTER TABLE sms_conversation_tags
  ADD CONSTRAINT sms_conversation_tags_private_projection_check CHECK (
    public.sms_uuid_v4_valid(id) AND public.sms_uuid_v4_valid(tenant_id) AND
    phone_e164 ~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$' AND
    public.sms_contract_text_valid(tag, 64, 256, false, true) AND
    (created_by IS NULL OR public.sms_uuid_v4_valid(created_by)) AND
    public.sms_timestamp_valid(created_at)
  ) NOT VALID;

ALTER TABLE sms_quick_replies
  ADD CONSTRAINT sms_quick_replies_private_projection_check CHECK (
    public.sms_uuid_v4_valid(id) AND public.sms_uuid_v4_valid(tenant_id) AND
    public.sms_contract_text_valid(label, 80, 320, false, true) AND
    octet_length(body) <= 16384 AND char_length(body) <= 4800 AND body ~ '[^[:space:]]' AND
    use_count >= 0 AND (created_by IS NULL OR public.sms_uuid_v4_valid(created_by)) AND
    public.sms_timestamp_valid(created_at) AND public.sms_timestamp_valid(updated_at) AND updated_at >= created_at AND
    (last_used_at IS NULL OR (public.sms_timestamp_valid(last_used_at) AND last_used_at >= created_at))
  ) NOT VALID;

ALTER TABLE sms_broadcasts
  ADD CONSTRAINT sms_broadcasts_private_projection_check CHECK (
    public.sms_uuid_v4_valid(id) AND public.sms_uuid_v4_valid(tenant_id) AND
    (sender_profile_id IS NULL OR public.sms_uuid_v4_valid(sender_profile_id)) AND
    (campaign_id IS NULL OR public.sms_uuid_v4_valid(campaign_id)) AND
    (segment_id IS NULL OR public.sms_uuid_v4_valid(segment_id)) AND
    public.sms_contract_text_valid(name, 256, 1024, false, true) AND
    octet_length(body) <= 16384 AND char_length(body) <= 4800 AND
    (tag IS NULL OR public.sms_contract_text_valid(tag, 64, 256, false, true)) AND
    public.sms_uuid_v4_array_valid(list_ids, 100) AND
    ((cardinality(list_ids) > 0)::int + (segment_id IS NOT NULL)::int + (tag IS NOT NULL)::int) <= 1 AND
    sent_count >= 0 AND failed_count >= 0 AND held_count >= 0 AND
    public.sms_timestamp_valid(created_at) AND public.sms_timestamp_valid(updated_at) AND updated_at >= created_at AND
    (scheduled_at IS NULL OR public.sms_timestamp_valid(scheduled_at))
  ) NOT VALID;

ALTER TABLE sms_quiet_hours
  ADD CONSTRAINT sms_quiet_hours_private_projection_check CHECK (
    public.sms_uuid_v4_valid(id) AND public.sms_uuid_v4_valid(tenant_id) AND
    public.sms_contract_text_valid(label, 128, 512, true, false) AND
    country_code IN ('','US','CA') AND
    start_minute BETWEEN 0 AND 1439 AND end_minute BETWEEN 0 AND 1439 AND
    public.sms_weekdays_valid(days) AND
    public.sms_contract_text_valid(timezone, 128, 512, false, true) AND
    public.sms_timestamp_valid(created_at) AND public.sms_timestamp_valid(updated_at) AND updated_at >= created_at
  ) NOT VALID;

ALTER TABLE sms_keyword_responses
  ADD CONSTRAINT sms_keyword_responses_private_projection_check CHECK (
    public.sms_uuid_v4_valid(id) AND public.sms_uuid_v4_valid(tenant_id) AND
    char_length(keyword) BETWEEN 1 AND 80 AND octet_length(keyword) <= 320 AND
    keyword = upper(btrim(keyword)) AND keyword ~ '^[A-Z0-9_.:-]+$' AND
    keyword NOT IN ('STOP','STOPALL','UNSUBSCRIBE','END','QUIT','REVOKE','OPTOUT','CANCEL','START','UNSTOP','HELP') AND
    octet_length(response_body) <= 16384 AND char_length(response_body) <= 4800 AND response_body ~ '[^[:space:]]' AND
    action IN ('reply_only','opt_out') AND
    public.sms_timestamp_valid(created_at) AND public.sms_timestamp_valid(updated_at) AND updated_at >= created_at
  ) NOT VALID;

ALTER TABLE sms_campaigns
  ADD CONSTRAINT sms_campaigns_private_projection_check CHECK (
    public.sms_uuid_v4_valid(id) AND public.sms_uuid_v4_valid(tenant_id) AND
    (sender_profile_id IS NULL OR public.sms_uuid_v4_valid(sender_profile_id)) AND
    (list_id IS NULL OR public.sms_uuid_v4_valid(list_id)) AND
    public.sms_contract_text_valid(name, 256, 1024, false, true) AND
    octet_length(body) <= 16384 AND char_length(body) <= 4800 AND body ~ '[^[:space:]]' AND
    (media_url IS NULL OR (
      octet_length(media_url) <= 2048 AND media_url ~* '^https://[^/@[:space:]]+(/[^#[:space:]]*)?$'
      AND media_url !~ '#')) AND
    status IN ('draft','scheduled','sending','sent','paused','failed','cancelled') AND
    jsonb_typeof(stats) = 'object' AND octet_length(stats::text) <= 8192 AND
    jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 8192 AND
    public.sms_timestamp_valid(created_at) AND public.sms_timestamp_valid(updated_at) AND updated_at >= created_at AND
    (scheduled_at IS NULL OR (public.sms_timestamp_valid(scheduled_at) AND scheduled_at >= created_at)) AND
    (sent_at IS NULL OR (public.sms_timestamp_valid(sent_at) AND sent_at >= created_at)) AND
    (status <> 'scheduled' OR scheduled_at IS NOT NULL) AND
    (status <> 'sent' OR sent_at IS NOT NULL)
  ) NOT VALID;

-- PostgreSQL cannot put a catalog lookup in an immutable CHECK. Enforce the
-- actual IANA domain on every new write with a narrowly owned trigger, and run
-- the same catalog predicate in the count-only historical preflight.
CREATE OR REPLACE FUNCTION public.sms_quiet_hours_timezone_owned() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='sms quiet-hours timezone must be an IANA timezone';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.sms_quiet_hours_timezone_owned() FROM PUBLIC, postwave_app;
DROP TRIGGER IF EXISTS sms_quiet_hours_timezone_owned_trigger ON sms_quiet_hours;
CREATE TRIGGER sms_quiet_hours_timezone_owned_trigger
BEFORE INSERT OR UPDATE OF timezone ON sms_quiet_hours
FOR EACH ROW EXECUTE FUNCTION public.sms_quiet_hours_timezone_owned();

-- CHECK constraints cannot query the owning tenant's list table. A narrowly
-- scoped trigger enforces ownership for the uuid[] until the audience is
-- normalized into a child table.
CREATE OR REPLACE FUNCTION public.sms_broadcast_list_ids_owned() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM unnest(NEW.list_ids) AS requested(id)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.sms_lists l
        WHERE l.tenant_id = NEW.tenant_id AND l.id = requested.id)) THEN
    RAISE EXCEPTION USING ERRCODE='23503', MESSAGE='sms broadcast list_ids must belong to the broadcast tenant';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.sms_broadcast_list_ids_owned() FROM PUBLIC;
DROP TRIGGER IF EXISTS sms_broadcast_list_ids_owned_trigger ON sms_broadcasts;
CREATE TRIGGER sms_broadcast_list_ids_owned_trigger
BEFORE INSERT OR UPDATE OF tenant_id, list_ids ON sms_broadcasts
FOR EACH ROW EXECUTE FUNCTION public.sms_broadcast_list_ids_owned();

-- Replace the final 1866 projection implementation so every downstream
-- omnichannel gate uses the same evidence predicate as reply/broadcast.
CREATE OR REPLACE FUNCTION public.sms_consent_recompute_for_email(
    p_tenant_id uuid,
    p_email citext
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
DECLARE
    v_identity text;
    v_withdrawn boolean;
BEGIN
    SELECT x.phone_e164 INTO v_identity
      FROM public.sms_subscriptions x
     WHERE x.tenant_id = p_tenant_id
       AND x.subscriber_email = p_email
       AND public.sms_subscription_send_eligible(
             x.tenant_id, x.list_id, x.phone_e164, x.status,
             x.consent_source, x.consent_text, x.consent_at, x.proof)
       AND public.sms_binding_not_contradicted(p_tenant_id, p_email, x.phone_e164)
       AND NOT EXISTS (
           SELECT 1 FROM public.sms_suppressions p
            WHERE p.tenant_id = x.tenant_id AND p.phone_e164 = x.phone_e164
              AND (p.expires_at IS NULL OR p.expires_at > now()))
     ORDER BY x.consent_at DESC, x.phone_e164
     LIMIT 1;

    IF v_identity IS NOT NULL THEN
        UPDATE public.subscribers s
           SET consent_sms_marketing_at = COALESCE(s.consent_sms_marketing_at, now()),
               sms_send_identity = v_identity,
               updated_at = now()
         WHERE s.tenant_id = p_tenant_id AND s.email = p_email
           AND (s.consent_sms_marketing_at IS NULL OR s.sms_send_identity IS DISTINCT FROM v_identity);
        RETURN;
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM public.sms_subscriptions x
         WHERE x.tenant_id = p_tenant_id AND x.subscriber_email = p_email
           AND public.sms_binding_not_contradicted(p_tenant_id, p_email, x.phone_e164)
		   AND (x.status = 'opted_out' OR EXISTS (
                    SELECT 1 FROM public.sms_suppressions p
                     WHERE p.tenant_id = x.tenant_id AND p.phone_e164 = x.phone_e164
                       AND (p.expires_at IS NULL OR p.expires_at > now()))))
    INTO v_withdrawn;

    IF v_withdrawn THEN
        UPDATE public.subscribers s
           SET consent_sms_marketing_at = NULL, sms_send_identity = NULL, updated_at = now()
         WHERE s.tenant_id = p_tenant_id AND s.email = p_email
           AND (s.consent_sms_marketing_at IS NOT NULL OR s.sms_send_identity IS NOT NULL);
	ELSE
		-- A weak/legacy status row must close only a vector this projection
		-- previously derived. A non-SMS consent timestamp with no derived send
		-- identity belongs to another evidence plane and is not ours to erase.
		UPDATE public.subscribers s
		   SET consent_sms_marketing_at = NULL, sms_send_identity = NULL, updated_at = now()
		 WHERE s.tenant_id = p_tenant_id AND s.email = p_email
		   AND s.sms_send_identity IS NOT NULL;
    END IF;
END
$$;

REVOKE ALL ON FUNCTION public.sms_consent_recompute_for_email(uuid, citext) FROM PUBLIC, postwave_app;
REVOKE ALL ON FUNCTION public.sms_binding_not_contradicted(uuid, citext, text) FROM PUBLIC, postwave_app;
REVOKE ALL ON FUNCTION public.sms_subscriptions_project_consent() FROM PUBLIC, postwave_app;
REVOKE ALL ON FUNCTION public.sms_suppressions_project_consent() FROM PUBLIC, postwave_app;

-- Consent event and subscription writes occur in one transaction. Defer the
-- projection until commit so the immutable event is visible before an opt-in
-- can open the derived activation vector.
DROP TRIGGER IF EXISTS sms_subscriptions_project_consent_trg ON sms_subscriptions;
CREATE CONSTRAINT TRIGGER sms_subscriptions_project_consent_trg
AFTER INSERT OR UPDATE OR DELETE ON sms_subscriptions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.sms_subscriptions_project_consent();

-- Privileged count-only historical release gate. This is deliberately in the
-- same transaction that creates the predicates, checks, ownership trigger and
-- consent projection above. A failed preflight rolls all of those changes
-- back; no older API binary is stranded behind a partial private contract.
DO $$
DECLARE
  item text;
  spec text[];
  table_name text;
  constraint_name text;
  predicate text;
  invalid_count bigint;
  failures jsonb := '{}'::jsonb;
  invalid_broadcast_list_owners bigint;
  invalid_opted_in_evidence bigint;
BEGIN
  FOREACH item IN ARRAY ARRAY[
    'sms_sender_profiles|sms_sender_profiles_private_projection_check',
    'sms_lists|sms_lists_private_projection_check',
    'sms_subscriptions|sms_subscriptions_private_projection_check',
    'sms_consent_events|sms_consent_events_private_projection_check',
    'sms_suppressions|sms_suppressions_private_projection_check',
    'sms_conversation_state|sms_conversation_state_private_projection_check',
    'sms_conversation_tags|sms_conversation_tags_private_projection_check',
    'sms_quick_replies|sms_quick_replies_private_projection_check',
    'sms_broadcasts|sms_broadcasts_private_projection_check',
    'sms_quiet_hours|sms_quiet_hours_private_projection_check',
    'sms_keyword_responses|sms_keyword_responses_private_projection_check',
    'sms_campaigns|sms_campaigns_private_projection_check'
  ] LOOP
    spec := string_to_array(item, '|');
    table_name := spec[1];
    constraint_name := spec[2];
    SELECT pg_get_expr(c.conbin, c.conrelid) INTO predicate
      FROM pg_constraint c
     WHERE c.conrelid = table_name::regclass AND c.conname = constraint_name;
    IF predicate IS NULL THEN
      RAISE EXCEPTION 'missing Route40 projection constraint % on %', constraint_name, table_name;
    END IF;
    EXECUTE format('SELECT count(*) FROM %I WHERE NOT (%s)', table_name, predicate)
      INTO invalid_count;
    failures := failures || jsonb_build_object(table_name, invalid_count);
  END LOOP;

  SELECT count(*) INTO invalid_broadcast_list_owners
    FROM sms_broadcasts b
   WHERE EXISTS (
     SELECT 1 FROM unnest(b.list_ids) AS requested(id)
      WHERE NOT EXISTS (
        SELECT 1 FROM sms_lists l
         WHERE l.tenant_id = b.tenant_id AND l.id = requested.id));
  failures := failures || jsonb_build_object('sms_broadcasts_list_ownership', invalid_broadcast_list_owners);

  SELECT count(*) INTO invalid_opted_in_evidence
    FROM sms_subscriptions s
   WHERE s.status = 'opted_in'
     AND NOT public.sms_subscription_send_eligible(
       s.tenant_id, s.list_id, s.phone_e164, s.status,
       s.consent_source, s.consent_text, s.consent_at, s.proof);
  failures := failures || jsonb_build_object('sms_subscriptions_missing_matching_grant_event', invalid_opted_in_evidence);

  SELECT count(*) INTO invalid_count
    FROM sms_quiet_hours q
   WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name = q.timezone);
  failures := failures || jsonb_build_object('sms_quiet_hours_invalid_iana_timezone', invalid_count);

  SELECT coalesce(sum(value::text::bigint), 0) INTO invalid_count FROM jsonb_each(failures);
  IF invalid_count > 0 THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Route40 SMS private projection historical preflight failed',
      DETAIL = failures::text || '; run a reviewed evidence-preserving remediation before retrying migration 1992';
  END IF;
END
$$;

-- Clear SMS-derived activation identities that are not reachable from any
-- evidence-sufficient current subscription (including orphan subscribers
-- whose source subscription was removed). A consent timestamp with no
-- sms_send_identity belongs to another evidence plane and is untouched.
UPDATE subscribers s
   SET consent_sms_marketing_at = NULL,
       sms_send_identity = NULL,
       updated_at = now()
 WHERE s.sms_send_identity IS NOT NULL
   AND NOT EXISTS (
     SELECT 1
       FROM sms_subscriptions x
      WHERE x.tenant_id = s.tenant_id
        AND x.subscriber_email = s.email
        AND x.phone_e164 = s.sms_send_identity
        AND public.sms_subscription_send_eligible(
              x.tenant_id, x.list_id, x.phone_e164, x.status,
              x.consent_source, x.consent_text, x.consent_at, x.proof)
        AND NOT EXISTS (
          SELECT 1 FROM sms_suppressions p
           WHERE p.tenant_id = x.tenant_id AND p.phone_e164 = x.phone_e164
             AND (p.expires_at IS NULL OR p.expires_at > now()))
   );

ALTER TABLE sms_sender_profiles VALIDATE CONSTRAINT sms_sender_profiles_private_projection_check;
ALTER TABLE sms_lists VALIDATE CONSTRAINT sms_lists_private_projection_check;
ALTER TABLE sms_subscriptions VALIDATE CONSTRAINT sms_subscriptions_private_projection_check;
ALTER TABLE sms_consent_events VALIDATE CONSTRAINT sms_consent_events_private_projection_check;
ALTER TABLE sms_suppressions VALIDATE CONSTRAINT sms_suppressions_private_projection_check;
ALTER TABLE sms_conversation_state VALIDATE CONSTRAINT sms_conversation_state_private_projection_check;
ALTER TABLE sms_conversation_tags VALIDATE CONSTRAINT sms_conversation_tags_private_projection_check;
ALTER TABLE sms_quick_replies VALIDATE CONSTRAINT sms_quick_replies_private_projection_check;
ALTER TABLE sms_broadcasts VALIDATE CONSTRAINT sms_broadcasts_private_projection_check;
ALTER TABLE sms_quiet_hours VALIDATE CONSTRAINT sms_quiet_hours_private_projection_check;
ALTER TABLE sms_keyword_responses VALIDATE CONSTRAINT sms_keyword_responses_private_projection_check;
ALTER TABLE sms_campaigns VALIDATE CONSTRAINT sms_campaigns_private_projection_check;

-- Recompute the derived subscriber gate from the newly validated source of
-- truth. This emits no identifiers and never preserves a stale open vector:
-- missing/weak evidence clears both consent and the derived send identity.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT tenant_id, subscriber_email
      FROM sms_subscriptions
     WHERE subscriber_email IS NOT NULL
  LOOP
    PERFORM public.sms_consent_recompute_for_email(r.tenant_id, r.subscriber_email);
  END LOOP;
END
$$;
