-- Route41 Helpdesk tenant ownership, immutable source evidence, and bounded
-- projections. Canonical read/mutation audit and privacy lifecycle remain
-- release-held: this migration deliberately does not create tables that could
-- be mistaken for evidence without fail-closed runtime writers.
-- migration-execution: phased

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS support_channels_tenant_id_id_uidx
  ON support_channels (tenant_id, id);
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS support_conversations_tenant_id_id_uidx
  ON support_conversations (tenant_id, id);
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS support_messages_tenant_id_id_uidx
  ON support_messages (tenant_id, id);
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS support_tickets_tenant_id_id_uidx
  ON support_tickets (tenant_id, id);
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS support_integrations_tenant_id_id_uidx
  ON support_integrations (tenant_id, id);

-- Migration 1989 adopts the users(tenant_id,id) unique reference target.
-- Route41 reuses that ordered prerequisite rather than building a duplicate
-- users-table index in this later online phase.

-- The runner records the online-index phase above. Everything below is one
-- transaction: a count-only poison preflight cannot strand a partially
-- adopted FK/check set or a migration version.
BEGIN;

-- Every support-provider callback and worker is Route41 release-held. Remove
-- the legacy permissive lookup policies that trusted caller-settable app.*
-- GUCs; the shared postwave_app role can set those values itself, so they are
-- not an authorization boundary. Only the exact tenant_isolation policy may
-- remain on provider configuration rows.
DO $$
DECLARE policy_name text;
BEGIN
  FOR policy_name IN
    SELECT polname
      FROM pg_policy
     WHERE polrelid='support_integrations'::regclass
       AND polname<>'tenant_isolation'
  LOOP
    EXECUTE format('DROP POLICY %I ON support_integrations', policy_name);
  END LOOP;
END
$$;

ALTER TABLE support_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_integrations FORCE ROW LEVEL SECURITY;

ALTER TABLE support_conversations
  ADD COLUMN IF NOT EXISTS assigned_to_user_id uuid;
ALTER TABLE support_assignments
  ADD COLUMN IF NOT EXISTS assigned_to_user_id uuid;

CREATE OR REPLACE FUNCTION helpdesk_active_assignee(p_tenant_id uuid, p_user_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT user_account.id
    FROM public.users AS user_account
   WHERE user_account.tenant_id=p_tenant_id
     AND user_account.id=p_user_id
     AND user_account.status='active'
   LIMIT 1
$$;
REVOKE ALL ON FUNCTION helpdesk_active_assignee(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helpdesk_active_assignee(uuid,uuid) TO postwave_app;

CREATE OR REPLACE FUNCTION helpdesk_codepoint_is_space(p_code integer)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT p_code BETWEEN 9 AND 13 OR p_code IN (32,133,160,5760,8232,8233,8239,8287,12288)
      OR p_code BETWEEN 8192 AND 8202
$$;
REVOKE ALL ON FUNCTION helpdesk_codepoint_is_space(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helpdesk_codepoint_is_space(integer) TO postwave_app;

CREATE OR REPLACE FUNCTION helpdesk_unicode_trimmed(p_value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT p_value IS NOT NULL AND (
    p_value='' OR (
      NOT public.helpdesk_codepoint_is_space(ascii(substr(p_value,1,1))) AND
      NOT public.helpdesk_codepoint_is_space(ascii(substr(p_value,char_length(p_value),1)))
    )
  )
$$;
REVOKE ALL ON FUNCTION helpdesk_unicode_trimmed(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helpdesk_unicode_trimmed(text) TO postwave_app;

CREATE OR REPLACE FUNCTION helpdesk_display_text_valid(
  p_value text,
  p_max_bytes integer,
  p_allow_empty boolean DEFAULT true
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT p_value IS NOT NULL
     AND octet_length(p_value) <= p_max_bytes
     AND (p_allow_empty OR EXISTS (
       SELECT 1
         FROM generate_series(1, char_length(p_value)) AS character_index
        WHERE NOT public.helpdesk_codepoint_is_space(ascii(substr(p_value, character_index, 1)))
     ))
     AND NOT EXISTS (
       SELECT 1
         FROM generate_series(1, char_length(p_value)) AS character_index
        WHERE ascii(substr(p_value, character_index, 1)) BETWEEN 0 AND 8
           OR ascii(substr(p_value, character_index, 1)) IN (11,12)
           OR ascii(substr(p_value, character_index, 1)) BETWEEN 14 AND 31
           OR ascii(substr(p_value, character_index, 1)) BETWEEN 127 AND 159
           OR ascii(substr(p_value, character_index, 1)) = 1564
           OR ascii(substr(p_value, character_index, 1)) BETWEEN 8203 AND 8207
           OR ascii(substr(p_value, character_index, 1)) IN (8232,8233)
           OR ascii(substr(p_value, character_index, 1)) BETWEEN 8234 AND 8238
           OR ascii(substr(p_value, character_index, 1)) BETWEEN 8288 AND 8303
           OR ascii(substr(p_value, character_index, 1)) = 65279
     )
$$;
REVOKE ALL ON FUNCTION helpdesk_display_text_valid(text,integer,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helpdesk_display_text_valid(text,integer,boolean) TO postwave_app;

CREATE OR REPLACE FUNCTION helpdesk_email_valid(p_value text, p_allow_empty boolean DEFAULT true)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
DECLARE
  parts text[];
  local_part text;
  domain_part text;
  label text;
BEGIN
  IF p_value='' THEN RETURN p_allow_empty; END IF;
  IF NOT public.helpdesk_display_text_valid(p_value,320,false) OR NOT public.helpdesk_unicode_trimmed(p_value) THEN
    RETURN false;
  END IF;
  parts := string_to_array(p_value,'@');
  IF cardinality(parts)<>2 THEN RETURN false; END IF;
  local_part := parts[1];
  domain_part := parts[2];
  IF octet_length(local_part)<1 OR octet_length(local_part)>64 OR octet_length(domain_part)<3 OR octet_length(domain_part)>253 OR
     local_part !~ '^[A-Za-z0-9._%+-]+$' OR left(local_part,1)='.' OR right(local_part,1)='.' OR position('..' IN local_part)>0 OR
     position('.' IN domain_part)=0 THEN
    RETURN false;
  END IF;
  FOREACH label IN ARRAY string_to_array(domain_part,'.') LOOP
    IF octet_length(label)<1 OR octet_length(label)>63 OR label !~ '^[A-Za-z0-9-]+$' OR left(label,1)='-' OR right(label,1)='-' THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION helpdesk_email_valid(text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helpdesk_email_valid(text,boolean) TO postwave_app;

CREATE OR REPLACE FUNCTION helpdesk_text_array_valid(
  p_value text[],
  p_max_items integer,
  p_max_bytes integer,
  p_allowed text[] DEFAULT NULL
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT p_value IS NOT NULL
     AND cardinality(p_value) <= p_max_items
     AND NOT EXISTS (
       SELECT 1
         FROM unnest(p_value) AS item(value)
        WHERE NOT public.helpdesk_display_text_valid(item.value,p_max_bytes,false)
           OR NOT public.helpdesk_unicode_trimmed(item.value)
           OR (p_allowed IS NOT NULL AND NOT (item.value = ANY(p_allowed)))
     )
     AND cardinality(p_value) = (SELECT count(DISTINCT item.value) FROM unnest(p_value) AS item(value))
$$;
REVOKE ALL ON FUNCTION helpdesk_text_array_valid(text[],integer,integer,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helpdesk_text_array_valid(text[],integer,integer,text[]) TO postwave_app;

CREATE OR REPLACE FUNCTION helpdesk_jsonb_value_valid(
  p_value jsonb,
  p_depth integer DEFAULT 0
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
DECLARE
  item record;
  item_count integer;
  numeric_value numeric;
BEGIN
  IF p_value IS NULL OR p_depth > 8 THEN
    RETURN false;
  END IF;
  CASE jsonb_typeof(p_value)
    WHEN 'string' THEN
      RETURN public.helpdesk_display_text_valid(p_value #>> '{}',65536,true);
    WHEN 'array' THEN
      IF jsonb_array_length(p_value) > 512 THEN RETURN false; END IF;
      FOR item IN SELECT value FROM jsonb_array_elements(p_value) LOOP
        IF NOT public.helpdesk_jsonb_value_valid(item.value,p_depth+1) THEN RETURN false; END IF;
      END LOOP;
      RETURN true;
    WHEN 'object' THEN
      SELECT count(*) INTO item_count FROM jsonb_object_keys(p_value);
      IF item_count > 512 THEN RETURN false; END IF;
      FOR item IN SELECT key,value FROM jsonb_each(p_value) LOOP
        IF NOT public.helpdesk_display_text_valid(item.key,256,false) OR
           NOT public.helpdesk_jsonb_value_valid(item.value,p_depth+1) THEN
          RETURN false;
        END IF;
      END LOOP;
      RETURN true;
    WHEN 'number' THEN
      numeric_value := (p_value #>> '{}')::numeric;
      RETURN abs(numeric_value) <= 9007199254740991::numeric
         AND (numeric_value=0 OR abs(numeric_value)>=4.9406564584124654e-324::numeric);
    WHEN 'boolean', 'null' THEN RETURN true;
    ELSE RETURN false;
  END CASE;
END
$$;
REVOKE ALL ON FUNCTION helpdesk_jsonb_value_valid(jsonb,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helpdesk_jsonb_value_valid(jsonb,integer) TO postwave_app;

CREATE OR REPLACE FUNCTION helpdesk_jsonb_fanout_count(
  p_value jsonb,
  p_depth integer DEFAULT 0
) RETURNS bigint
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
DECLARE
  item record;
  total bigint := 0;
BEGIN
  IF p_value IS NULL OR p_depth>8 THEN RETURN 1000000000; END IF;
  CASE jsonb_typeof(p_value)
    WHEN 'array' THEN
      total := jsonb_array_length(p_value);
      FOR item IN SELECT value FROM jsonb_array_elements(p_value) LOOP
        total := total + public.helpdesk_jsonb_fanout_count(item.value,p_depth+1);
      END LOOP;
    WHEN 'object' THEN
      SELECT count(*) INTO total FROM jsonb_object_keys(p_value);
      FOR item IN SELECT value FROM jsonb_each(p_value) LOOP
        total := total + public.helpdesk_jsonb_fanout_count(item.value,p_depth+1);
      END LOOP;
    ELSE
      RETURN 0;
  END CASE;
  RETURN total;
END
$$;
REVOKE ALL ON FUNCTION helpdesk_jsonb_fanout_count(jsonb,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helpdesk_jsonb_fanout_count(jsonb,integer) TO postwave_app;

CREATE OR REPLACE FUNCTION helpdesk_jsonb_projection_valid(
  p_value jsonb,
  p_expected_type text,
  p_max_bytes integer,
  p_max_fanout integer
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT p_value IS NOT NULL
     AND jsonb_typeof(p_value)=p_expected_type
     AND octet_length(p_value::text)<=p_max_bytes
     AND public.helpdesk_jsonb_fanout_count(p_value,0)<=p_max_fanout
     AND public.helpdesk_jsonb_value_valid(p_value,0)
$$;
REVOKE ALL ON FUNCTION helpdesk_jsonb_projection_valid(jsonb,text,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helpdesk_jsonb_projection_valid(jsonb,text,integer,integer) TO postwave_app;

CREATE OR REPLACE FUNCTION helpdesk_jsonb_array_projection_valid(
  p_value jsonb,
  p_max_bytes integer,
  p_max_items integer,
  p_max_fanout integer
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN p_value IS NULL OR jsonb_typeof(p_value)<>'array' THEN false
    ELSE octet_length(p_value::text)<=p_max_bytes
      AND jsonb_array_length(p_value)<=p_max_items
      AND public.helpdesk_jsonb_fanout_count(p_value,0)<=p_max_fanout
      AND public.helpdesk_jsonb_value_valid(p_value,0)
  END
$$;
REVOKE ALL ON FUNCTION helpdesk_jsonb_array_projection_valid(jsonb,integer,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION helpdesk_jsonb_array_projection_valid(jsonb,integer,integer,integer) TO postwave_app;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='support_channels'::regclass AND conname='support_channels_tenant_id_id_unique') THEN
    ALTER TABLE support_channels ADD CONSTRAINT support_channels_tenant_id_id_unique UNIQUE USING INDEX support_channels_tenant_id_id_uidx;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='support_conversations'::regclass AND conname='support_conversations_tenant_id_id_unique') THEN
    ALTER TABLE support_conversations ADD CONSTRAINT support_conversations_tenant_id_id_unique UNIQUE USING INDEX support_conversations_tenant_id_id_uidx;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='support_messages'::regclass AND conname='support_messages_tenant_id_id_unique') THEN
    ALTER TABLE support_messages ADD CONSTRAINT support_messages_tenant_id_id_unique UNIQUE USING INDEX support_messages_tenant_id_id_uidx;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='support_tickets'::regclass AND conname='support_tickets_tenant_id_id_unique') THEN
    ALTER TABLE support_tickets ADD CONSTRAINT support_tickets_tenant_id_id_unique UNIQUE USING INDEX support_tickets_tenant_id_id_uidx;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='support_integrations'::regclass AND conname='support_integrations_tenant_id_id_unique') THEN
    ALTER TABLE support_integrations ADD CONSTRAINT support_integrations_tenant_id_id_unique UNIQUE USING INDEX support_integrations_tenant_id_id_uidx;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='users'::regclass AND conname='users_tenant_id_id_unique') THEN
    RAISE EXCEPTION 'migration 1993 requires users_tenant_id_id_unique from migration 1989';
  END IF;
END
$$;

DO $$
DECLARE
  item text;
  spec text[];
BEGIN
  FOREACH item IN ARRAY ARRAY[
    'support_conversations|support_conversations_channel_tenant_fk|tenant_id,channel_id|support_channels|ON DELETE SET NULL (channel_id)',
    'support_conversations|support_conversations_subscriber_tenant_fk|tenant_id,subscriber_id|subscribers|ON DELETE SET NULL (subscriber_id)',
    'support_conversations|support_conversations_assignee_tenant_fk|tenant_id,assigned_to_user_id|users|ON DELETE SET NULL (assigned_to_user_id)',
    'support_messages|support_messages_conversation_tenant_fk|tenant_id,conversation_id|support_conversations|ON DELETE CASCADE',
    'support_tickets|support_tickets_conversation_tenant_fk|tenant_id,conversation_id|support_conversations|ON DELETE SET NULL (conversation_id)',
    'support_assignments|support_assignments_conversation_tenant_fk|tenant_id,conversation_id|support_conversations|ON DELETE CASCADE',
    'support_assignments|support_assignments_ticket_tenant_fk|tenant_id,ticket_id|support_tickets|ON DELETE CASCADE',
    'support_assignments|support_assignments_assignee_tenant_fk|tenant_id,assigned_to_user_id|users|ON DELETE SET NULL (assigned_to_user_id)',
    'support_spam_assessments|support_spam_conversation_tenant_fk|tenant_id,conversation_id|support_conversations|ON DELETE CASCADE',
    'support_spam_assessments|support_spam_message_tenant_fk|tenant_id,message_id|support_messages|ON DELETE CASCADE',
    'support_agent_runs|support_agent_runs_conversation_tenant_fk|tenant_id,conversation_id|support_conversations|ON DELETE SET NULL (conversation_id)',
    'support_agent_runs|support_agent_runs_ticket_tenant_fk|tenant_id,ticket_id|support_tickets|ON DELETE SET NULL (ticket_id)',
    'support_sync_runs|support_sync_runs_integration_tenant_fk|tenant_id,integration_id|support_integrations|ON DELETE CASCADE',
    'support_webhook_events|support_webhook_events_integration_tenant_fk|tenant_id,integration_id|support_integrations|ON DELETE CASCADE'
  ] LOOP
    spec := string_to_array(item, '|');
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=spec[1]::regclass AND conname=spec[2]) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%s) REFERENCES %I (tenant_id,id) %s NOT VALID',
        spec[1], spec[2], spec[3], spec[4], spec[5]
      );
    END IF;
  END LOOP;
END
$$;

DO $$
DECLARE
  mismatches jsonb;
  total bigint;
BEGIN
  SELECT jsonb_build_object(
    'conversation_channel', (SELECT count(*) FROM support_conversations c LEFT JOIN support_channels p ON p.id=c.channel_id WHERE c.channel_id IS NOT NULL AND (p.id IS NULL OR p.tenant_id<>c.tenant_id)),
    'conversation_subscriber', (SELECT count(*) FROM support_conversations c LEFT JOIN subscribers p ON p.id=c.subscriber_id WHERE c.subscriber_id IS NOT NULL AND (p.id IS NULL OR p.tenant_id<>c.tenant_id)),
    'conversation_assignee', (SELECT count(*) FROM support_conversations c LEFT JOIN users p ON p.id=c.assigned_to_user_id WHERE c.assigned_to_user_id IS NOT NULL AND (p.id IS NULL OR p.tenant_id<>c.tenant_id)),
    'message_conversation', (SELECT count(*) FROM support_messages c LEFT JOIN support_conversations p ON p.id=c.conversation_id WHERE p.id IS NULL OR p.tenant_id<>c.tenant_id),
    'ticket_conversation', (SELECT count(*) FROM support_tickets c LEFT JOIN support_conversations p ON p.id=c.conversation_id WHERE c.conversation_id IS NOT NULL AND (p.id IS NULL OR p.tenant_id<>c.tenant_id)),
    'assignment_conversation', (SELECT count(*) FROM support_assignments c LEFT JOIN support_conversations p ON p.id=c.conversation_id WHERE c.conversation_id IS NOT NULL AND (p.id IS NULL OR p.tenant_id<>c.tenant_id)),
    'assignment_ticket', (SELECT count(*) FROM support_assignments c LEFT JOIN support_tickets p ON p.id=c.ticket_id WHERE c.ticket_id IS NOT NULL AND (p.id IS NULL OR p.tenant_id<>c.tenant_id)),
    'assignment_assignee', (SELECT count(*) FROM support_assignments c LEFT JOIN users p ON p.id=c.assigned_to_user_id WHERE c.assigned_to_user_id IS NOT NULL AND (p.id IS NULL OR p.tenant_id<>c.tenant_id)),
    'spam_conversation', (SELECT count(*) FROM support_spam_assessments c LEFT JOIN support_conversations p ON p.id=c.conversation_id WHERE c.conversation_id IS NOT NULL AND (p.id IS NULL OR p.tenant_id<>c.tenant_id)),
    'spam_message', (SELECT count(*) FROM support_spam_assessments c LEFT JOIN support_messages p ON p.id=c.message_id WHERE c.message_id IS NOT NULL AND (p.id IS NULL OR p.tenant_id<>c.tenant_id)),
    'agent_conversation', (SELECT count(*) FROM support_agent_runs c LEFT JOIN support_conversations p ON p.id=c.conversation_id WHERE c.conversation_id IS NOT NULL AND (p.id IS NULL OR p.tenant_id<>c.tenant_id)),
    'agent_ticket', (SELECT count(*) FROM support_agent_runs c LEFT JOIN support_tickets p ON p.id=c.ticket_id WHERE c.ticket_id IS NOT NULL AND (p.id IS NULL OR p.tenant_id<>c.tenant_id)),
    'sync_integration', (SELECT count(*) FROM support_sync_runs c LEFT JOIN support_integrations p ON p.id=c.integration_id WHERE p.id IS NULL OR p.tenant_id<>c.tenant_id),
    'webhook_integration', (SELECT count(*) FROM support_webhook_events c LEFT JOIN support_integrations p ON p.id=c.integration_id WHERE p.id IS NULL OR p.tenant_id<>c.tenant_id),
    'message_bounds', (SELECT count(*) FROM support_messages WHERE
      source_type !~ '^[a-z0-9_-]{1,64}$' OR
      NOT helpdesk_display_text_valid(source_id,1024,true) OR
      NOT helpdesk_display_text_valid(sender,320,true) OR
      NOT helpdesk_display_text_valid(body_text,16384,true) OR
      octet_length(body_html)>262144 OR NOT helpdesk_jsonb_array_projection_valid(attachments,65536,64,512) OR
      NOT helpdesk_jsonb_projection_valid(metadata,'object',65536,512) OR
      sent_at<'2000-01-01'::timestamptz OR
      sent_at>='2100-01-01'::timestamptz OR created_at<'2000-01-01'::timestamptz OR
      created_at>='2100-01-01'::timestamptz OR sent_at>created_at),
    'hub_config_bounds', (SELECT count(*) FROM customer_hub_configs WHERE
      NOT helpdesk_jsonb_array_projection_valid(storefronts,65536,128,512) OR
      NOT helpdesk_jsonb_array_projection_valid(content_blocks,65536,128,512) OR
      NOT helpdesk_jsonb_projection_valid(personalization_rules,'object',65536,512) OR
      NOT helpdesk_jsonb_projection_valid(support_settings,'object',65536,512) OR
      NOT helpdesk_jsonb_projection_valid(styling,'object',65536,512) OR
      NOT helpdesk_jsonb_projection_valid(metadata,'object',65536,512) OR
      created_at<'2000-01-01'::timestamptz OR created_at>='2100-01-01'::timestamptz OR
      updated_at<created_at OR updated_at>='2100-01-01'::timestamptz),
    'channel_bounds', (SELECT count(*) FROM support_channels WHERE
      NOT helpdesk_display_text_valid(name,200,false) OR NOT helpdesk_display_text_valid(external_ref,1024,true) OR
      NOT helpdesk_jsonb_projection_valid(routing_rules,'object',65536,512) OR
      NOT helpdesk_jsonb_projection_valid(agent_settings,'object',65536,512) OR
      NOT helpdesk_jsonb_projection_valid(metadata,'object',65536,512) OR
      created_at<'2000-01-01'::timestamptz OR created_at>='2100-01-01'::timestamptz OR
      updated_at<created_at OR updated_at>='2100-01-01'::timestamptz),
    'support_integration_bounds', (SELECT count(*) FROM support_integrations WHERE
      provider !~ '^[a-z0-9_-]{1,64}$' OR NOT helpdesk_display_text_valid(name,200,false) OR
      status NOT IN ('connected','active','paused','error','disconnected') OR
      created_at<'2000-01-01'::timestamptz OR created_at>='2100-01-01'::timestamptz OR
      updated_at<created_at OR updated_at>='2100-01-01'::timestamptz),
    'conversation_bounds', (SELECT count(*) FROM support_conversations WHERE
      NOT helpdesk_display_text_valid(subject,500,true) OR NOT helpdesk_display_text_valid(requester_name,200,true) OR
      NOT helpdesk_display_text_valid(requester_phone,64,true) OR
      (requester_email IS NOT NULL AND NOT helpdesk_email_valid(requester_email::text,false)) OR
      NOT helpdesk_display_text_valid(external_thread_id,1024,true) OR
      NOT helpdesk_text_array_valid(tags,32,100,NULL) OR
      NOT helpdesk_jsonb_projection_valid(metadata,'object',65536,512) OR
      created_at<'2000-01-01'::timestamptz OR created_at>='2100-01-01'::timestamptz OR
      updated_at<created_at OR updated_at>='2100-01-01'::timestamptz OR
      (last_message_at IS NOT NULL AND (last_message_at<'2000-01-01'::timestamptz OR last_message_at>='2100-01-01'::timestamptz))),
    'ticket_bounds', (SELECT count(*) FROM support_tickets WHERE
      NOT helpdesk_display_text_valid(title,500,false) OR source_channel !~ '^[a-z0-9_-]{1,64}$' OR
      NOT helpdesk_display_text_valid(assignee,320,true) OR
      NOT helpdesk_jsonb_projection_valid(metadata,'object',65536,512) OR
      created_at<'2000-01-01'::timestamptz OR created_at>='2100-01-01'::timestamptz OR
      updated_at<created_at OR updated_at>='2100-01-01'::timestamptz OR
      (due_at IS NOT NULL AND (due_at<created_at OR due_at>='2100-01-01'::timestamptz)) OR
      (resolved_at IS NOT NULL AND (resolved_at<created_at OR resolved_at>='2100-01-01'::timestamptz))),
    'view_bounds', (SELECT count(*) FROM support_views WHERE
      NOT helpdesk_display_text_valid(name,200,false) OR NOT helpdesk_display_text_valid(created_by,320,true) OR
      NOT helpdesk_jsonb_projection_valid(filters,'object',32768,512) OR
      NOT helpdesk_jsonb_projection_valid(sort,'object',32768,512) OR
      created_at<'2000-01-01'::timestamptz OR created_at>='2100-01-01'::timestamptz OR
      updated_at<created_at OR updated_at>='2100-01-01'::timestamptz),
    'macro_bounds', (SELECT count(*) FROM support_macros WHERE
      NOT helpdesk_display_text_valid(name,200,false) OR NOT helpdesk_display_text_valid(body,16384,false) OR
      NOT helpdesk_text_array_valid(channel_types,7,64,ARRAY['web_chat','email','sms','instagram','whatsapp','facebook','generic']) OR
      NOT helpdesk_text_array_valid(tags,32,100,NULL) OR NOT helpdesk_jsonb_projection_valid(metadata,'object',16384,256) OR
      created_at<'2000-01-01'::timestamptz OR created_at>='2100-01-01'::timestamptz OR
      updated_at<created_at OR updated_at>='2100-01-01'::timestamptz OR
      (last_used_at IS NOT NULL AND (last_used_at<created_at OR last_used_at>='2100-01-01'::timestamptz))),
    'assignment_bounds', (SELECT count(*) FROM support_assignments WHERE
      NOT helpdesk_display_text_valid(assigned_to,320,true) OR NOT helpdesk_display_text_valid(assigned_by,320,true) OR
      NOT helpdesk_display_text_valid(reason,1024,true) OR created_at<'2000-01-01'::timestamptz OR created_at>='2100-01-01'::timestamptz),
    'spam_bounds', (SELECT count(*) FROM support_spam_assessments WHERE
      assessed_by !~ '^[a-z0-9_-]{1,64}$' OR NOT helpdesk_jsonb_projection_valid(signals,'object',16384,256) OR
      created_at<'2000-01-01'::timestamptz OR created_at>='2100-01-01'::timestamptz),
    'agent_bounds', (SELECT count(*) FROM support_agent_runs WHERE
      NOT helpdesk_display_text_valid(prompt,4096,true) OR NOT helpdesk_display_text_valid(draft,16384,false) OR
      (model<>'' AND model !~ '^[a-z0-9_-]{1,128}$') OR NOT helpdesk_display_text_valid(handoff_reason,2048,true) OR
      NOT helpdesk_text_array_valid(safety_flags,32,256,NULL) OR
      NOT helpdesk_jsonb_projection_valid(tool_plan,'object',32768,512) OR
      NOT helpdesk_jsonb_projection_valid(metadata,'object',16384,256) OR
      created_at<'2000-01-01'::timestamptz OR created_at>='2100-01-01'::timestamptz OR
      updated_at<created_at OR updated_at>='2100-01-01'::timestamptz)
  ) INTO mismatches;
  SELECT coalesce(sum(value::text::bigint),0) INTO total FROM jsonb_each(mismatches);
  IF total > 0 THEN
    RAISE EXCEPTION USING
      MESSAGE='Route41 Helpdesk tenant/projection preflight failed',
      DETAIL=mismatches::text || '; repair ownership/bounds without copying customer/provider payloads before retrying migration 1993';
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='customer_hub_configs'::regclass AND conname='customer_hub_configs_projection_bounds') THEN
    ALTER TABLE customer_hub_configs ADD CONSTRAINT customer_hub_configs_projection_bounds CHECK (
      helpdesk_jsonb_array_projection_valid(storefronts,65536,128,512) AND
      helpdesk_jsonb_array_projection_valid(content_blocks,65536,128,512) AND
      helpdesk_jsonb_projection_valid(personalization_rules,'object',65536,512) AND
      helpdesk_jsonb_projection_valid(support_settings,'object',65536,512) AND
      helpdesk_jsonb_projection_valid(styling,'object',65536,512) AND
      helpdesk_jsonb_projection_valid(metadata,'object',65536,512) AND
      created_at>='2000-01-01'::timestamptz AND created_at<'2100-01-01'::timestamptz AND
      updated_at>=created_at AND updated_at<'2100-01-01'::timestamptz
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='support_channels'::regclass AND conname='support_channels_projection_bounds') THEN
    ALTER TABLE support_channels ADD CONSTRAINT support_channels_projection_bounds CHECK (
      helpdesk_display_text_valid(name,200,false) AND helpdesk_display_text_valid(external_ref,1024,true) AND
      helpdesk_jsonb_projection_valid(routing_rules,'object',65536,512) AND
      helpdesk_jsonb_projection_valid(agent_settings,'object',65536,512) AND
      helpdesk_jsonb_projection_valid(metadata,'object',65536,512) AND
      created_at>='2000-01-01'::timestamptz AND created_at<'2100-01-01'::timestamptz AND
      updated_at>=created_at AND updated_at<'2100-01-01'::timestamptz
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='support_messages'::regclass AND conname='support_messages_projection_bounds') THEN
    ALTER TABLE support_messages ADD CONSTRAINT support_messages_projection_bounds CHECK (
      source_type ~ '^[a-z0-9_-]{1,64}$' AND
      helpdesk_display_text_valid(source_id,1024,true) AND
      helpdesk_display_text_valid(sender,320,true) AND
      helpdesk_display_text_valid(body_text,16384,true) AND
      octet_length(body_html)<=262144 AND helpdesk_jsonb_array_projection_valid(attachments,65536,64,512) AND
      helpdesk_jsonb_projection_valid(metadata,'object',65536,512) AND sent_at>='2000-01-01'::timestamptz AND
      sent_at<'2100-01-01'::timestamptz AND created_at>='2000-01-01'::timestamptz AND
      created_at<'2100-01-01'::timestamptz AND sent_at<=created_at
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='support_integrations'::regclass AND conname='support_integrations_projection_bounds') THEN
    ALTER TABLE support_integrations ADD CONSTRAINT support_integrations_projection_bounds CHECK (
      provider ~ '^[a-z0-9_-]{1,64}$' AND helpdesk_display_text_valid(name,200,false) AND
      status IN ('connected','active','paused','error','disconnected') AND
      created_at>='2000-01-01'::timestamptz AND created_at<'2100-01-01'::timestamptz AND
      updated_at>=created_at AND updated_at<'2100-01-01'::timestamptz
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='support_conversations'::regclass AND conname='support_conversations_projection_bounds') THEN
    ALTER TABLE support_conversations ADD CONSTRAINT support_conversations_projection_bounds CHECK (
      helpdesk_display_text_valid(subject,500,true) AND helpdesk_display_text_valid(requester_name,200,true) AND
      helpdesk_display_text_valid(requester_phone,64,true) AND
      (requester_email IS NULL OR helpdesk_email_valid(requester_email::text,false)) AND
      helpdesk_display_text_valid(external_thread_id,1024,true) AND
      helpdesk_text_array_valid(tags,32,100,NULL) AND helpdesk_jsonb_projection_valid(metadata,'object',65536,512) AND
      created_at>='2000-01-01'::timestamptz AND created_at<'2100-01-01'::timestamptz AND
      updated_at>=created_at AND updated_at<'2100-01-01'::timestamptz AND
      (last_message_at IS NULL OR (last_message_at>='2000-01-01'::timestamptz AND last_message_at<'2100-01-01'::timestamptz))
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='support_tickets'::regclass AND conname='support_tickets_projection_bounds') THEN
    ALTER TABLE support_tickets ADD CONSTRAINT support_tickets_projection_bounds CHECK (
      helpdesk_display_text_valid(title,500,false) AND source_channel ~ '^[a-z0-9_-]{1,64}$' AND
      helpdesk_display_text_valid(assignee,320,true) AND helpdesk_jsonb_projection_valid(metadata,'object',65536,512) AND
      created_at>='2000-01-01'::timestamptz AND created_at<'2100-01-01'::timestamptz AND
      updated_at>=created_at AND updated_at<'2100-01-01'::timestamptz AND
      (due_at IS NULL OR (due_at>=created_at AND due_at<'2100-01-01'::timestamptz)) AND
      (resolved_at IS NULL OR (resolved_at>=created_at AND resolved_at<'2100-01-01'::timestamptz))
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='support_views'::regclass AND conname='support_views_projection_bounds') THEN
    ALTER TABLE support_views ADD CONSTRAINT support_views_projection_bounds CHECK (
      helpdesk_display_text_valid(name,200,false) AND helpdesk_display_text_valid(created_by,320,true) AND
      helpdesk_jsonb_projection_valid(filters,'object',32768,512) AND helpdesk_jsonb_projection_valid(sort,'object',32768,512) AND
      created_at>='2000-01-01'::timestamptz AND created_at<'2100-01-01'::timestamptz AND
      updated_at>=created_at AND updated_at<'2100-01-01'::timestamptz
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='support_macros'::regclass AND conname='support_macros_projection_bounds') THEN
    ALTER TABLE support_macros ADD CONSTRAINT support_macros_projection_bounds CHECK (
      helpdesk_display_text_valid(name,200,false) AND helpdesk_display_text_valid(body,16384,false) AND
      helpdesk_text_array_valid(channel_types,7,64,ARRAY['web_chat','email','sms','instagram','whatsapp','facebook','generic']) AND
      helpdesk_text_array_valid(tags,32,100,NULL) AND helpdesk_jsonb_projection_valid(metadata,'object',16384,256) AND
      created_at>='2000-01-01'::timestamptz AND created_at<'2100-01-01'::timestamptz AND
      updated_at>=created_at AND updated_at<'2100-01-01'::timestamptz AND
      (last_used_at IS NULL OR (last_used_at>=created_at AND last_used_at<'2100-01-01'::timestamptz))
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='support_assignments'::regclass AND conname='support_assignments_projection_bounds') THEN
    ALTER TABLE support_assignments ADD CONSTRAINT support_assignments_projection_bounds CHECK (
      helpdesk_display_text_valid(assigned_to,320,true) AND helpdesk_display_text_valid(assigned_by,320,true) AND
      helpdesk_display_text_valid(reason,1024,true) AND created_at>='2000-01-01'::timestamptz AND created_at<'2100-01-01'::timestamptz
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='support_spam_assessments'::regclass AND conname='support_spam_projection_bounds') THEN
    ALTER TABLE support_spam_assessments ADD CONSTRAINT support_spam_projection_bounds CHECK (
      assessed_by ~ '^[a-z0-9_-]{1,64}$' AND helpdesk_jsonb_projection_valid(signals,'object',16384,256) AND
      created_at>='2000-01-01'::timestamptz AND created_at<'2100-01-01'::timestamptz
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='support_agent_runs'::regclass AND conname='support_agent_runs_projection_bounds') THEN
    ALTER TABLE support_agent_runs ADD CONSTRAINT support_agent_runs_projection_bounds CHECK (
      helpdesk_display_text_valid(prompt,4096,true) AND helpdesk_display_text_valid(draft,16384,false) AND
      (model='' OR model ~ '^[a-z0-9_-]{1,128}$') AND helpdesk_display_text_valid(handoff_reason,2048,true) AND
      helpdesk_text_array_valid(safety_flags,32,256,NULL) AND
      helpdesk_jsonb_projection_valid(tool_plan,'object',32768,512) AND helpdesk_jsonb_projection_valid(metadata,'object',16384,256) AND
      created_at>='2000-01-01'::timestamptz AND created_at<'2100-01-01'::timestamptz AND
      updated_at>=created_at AND updated_at<'2100-01-01'::timestamptz
    ) NOT VALID;
  END IF;
END
$$;

ALTER TABLE support_conversations VALIDATE CONSTRAINT support_conversations_channel_tenant_fk;
ALTER TABLE support_conversations VALIDATE CONSTRAINT support_conversations_subscriber_tenant_fk;
ALTER TABLE support_conversations VALIDATE CONSTRAINT support_conversations_assignee_tenant_fk;
ALTER TABLE support_messages VALIDATE CONSTRAINT support_messages_conversation_tenant_fk;
ALTER TABLE support_tickets VALIDATE CONSTRAINT support_tickets_conversation_tenant_fk;
ALTER TABLE support_assignments VALIDATE CONSTRAINT support_assignments_conversation_tenant_fk;
ALTER TABLE support_assignments VALIDATE CONSTRAINT support_assignments_ticket_tenant_fk;
ALTER TABLE support_assignments VALIDATE CONSTRAINT support_assignments_assignee_tenant_fk;
ALTER TABLE support_spam_assessments VALIDATE CONSTRAINT support_spam_conversation_tenant_fk;
ALTER TABLE support_spam_assessments VALIDATE CONSTRAINT support_spam_message_tenant_fk;
ALTER TABLE support_agent_runs VALIDATE CONSTRAINT support_agent_runs_conversation_tenant_fk;
ALTER TABLE support_agent_runs VALIDATE CONSTRAINT support_agent_runs_ticket_tenant_fk;
ALTER TABLE support_sync_runs VALIDATE CONSTRAINT support_sync_runs_integration_tenant_fk;
ALTER TABLE support_webhook_events VALIDATE CONSTRAINT support_webhook_events_integration_tenant_fk;
ALTER TABLE customer_hub_configs VALIDATE CONSTRAINT customer_hub_configs_projection_bounds;
ALTER TABLE support_channels VALIDATE CONSTRAINT support_channels_projection_bounds;
ALTER TABLE support_integrations VALIDATE CONSTRAINT support_integrations_projection_bounds;
ALTER TABLE support_messages VALIDATE CONSTRAINT support_messages_projection_bounds;
ALTER TABLE support_conversations VALIDATE CONSTRAINT support_conversations_projection_bounds;
ALTER TABLE support_tickets VALIDATE CONSTRAINT support_tickets_projection_bounds;
ALTER TABLE support_views VALIDATE CONSTRAINT support_views_projection_bounds;
ALTER TABLE support_macros VALIDATE CONSTRAINT support_macros_projection_bounds;
ALTER TABLE support_assignments VALIDATE CONSTRAINT support_assignments_projection_bounds;
ALTER TABLE support_spam_assessments VALIDATE CONSTRAINT support_spam_projection_bounds;
ALTER TABLE support_agent_runs VALIDATE CONSTRAINT support_agent_runs_projection_bounds;

CREATE TABLE support_internal_note_intents (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  intent_key_sha256 text NOT NULL CHECK (intent_key_sha256 ~ '^[0-9a-f]{64}$'),
  principal_sha256 text NOT NULL CHECK (principal_sha256 ~ '^[0-9a-f]{64}$'),
  conversation_sha256 text NOT NULL CHECK (conversation_sha256 ~ '^[0-9a-f]{64}$'),
  binding_sha256 text NOT NULL CHECK (binding_sha256 ~ '^[0-9a-f]{64}$'),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  conversation_id uuid NOT NULL,
  message_id uuid,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','committed','result_erased')),
  created_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz,
  result_erased_at timestamptz,
  PRIMARY KEY (tenant_id, intent_key_sha256),
  CONSTRAINT support_note_intent_state_consistency CHECK (
    (state='pending' AND message_id IS NULL AND committed_at IS NULL AND result_erased_at IS NULL) OR
    (state='committed' AND message_id IS NOT NULL AND committed_at IS NOT NULL AND result_erased_at IS NULL) OR
    (state='result_erased' AND message_id IS NULL AND committed_at IS NOT NULL AND result_erased_at IS NOT NULL)
  ),
  CONSTRAINT support_note_intent_conversation_tenant_fk FOREIGN KEY (tenant_id,conversation_id)
    REFERENCES support_conversations(tenant_id,id),
  CONSTRAINT support_note_intent_message_tenant_fk FOREIGN KEY (tenant_id,message_id)
    REFERENCES support_messages(tenant_id,id)
);

CREATE OR REPLACE FUNCTION guard_support_internal_note_intent_update() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  bound_conversation uuid;
  bound_direction text;
  bound_sender_type text;
  bound_source_type text;
  bound_source_id text;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR
     NEW.intent_key_sha256 IS DISTINCT FROM OLD.intent_key_sha256 OR
     NEW.principal_sha256 IS DISTINCT FROM OLD.principal_sha256 OR
     NEW.conversation_sha256 IS DISTINCT FROM OLD.conversation_sha256 OR
     NEW.binding_sha256 IS DISTINCT FROM OLD.binding_sha256 OR
     NEW.request_sha256 IS DISTINCT FROM OLD.request_sha256 OR
     NEW.conversation_id IS DISTINCT FROM OLD.conversation_id OR
     NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'support internal-note intent identity is immutable';
  END IF;

  IF OLD.state='pending' AND NEW.state='committed' AND
     OLD.message_id IS NULL AND NEW.message_id IS NOT NULL AND
     OLD.committed_at IS NULL AND NEW.committed_at IS NOT NULL AND
     NEW.result_erased_at IS NULL THEN
    SELECT conversation_id,direction,sender_type,source_type,source_id
      INTO bound_conversation,bound_direction,bound_sender_type,bound_source_type,bound_source_id
      FROM support_messages
     WHERE tenant_id=NEW.tenant_id AND id=NEW.message_id;
    IF bound_conversation IS DISTINCT FROM NEW.conversation_id OR
       bound_direction IS DISTINCT FROM 'internal' OR
       bound_sender_type IS DISTINCT FROM 'agent' OR
       bound_source_type IS DISTINCT FROM 'internal_note' OR
       bound_source_id IS DISTINCT FROM 'internal-note:' || NEW.intent_key_sha256 THEN
      RAISE EXCEPTION 'support internal-note result is not bound to its typed intent';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.state='committed' AND NEW.state='result_erased' AND
     OLD.message_id IS NOT NULL AND NEW.message_id IS NULL AND
     NEW.committed_at IS NOT DISTINCT FROM OLD.committed_at AND
     NEW.result_erased_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'invalid support internal-note intent state transition';
END
$$;

CREATE OR REPLACE FUNCTION guard_support_internal_note_intent_insert() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.state <> 'pending' OR NEW.message_id IS NOT NULL OR
     NEW.committed_at IS NOT NULL OR NEW.result_erased_at IS NOT NULL THEN
    RAISE EXCEPTION 'support internal-note intents must begin pending without a result';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER support_internal_note_intents_guard_insert
  BEFORE INSERT ON support_internal_note_intents
  FOR EACH ROW EXECUTE FUNCTION guard_support_internal_note_intent_insert();
CREATE TRIGGER support_internal_note_intents_guard_update
  BEFORE UPDATE ON support_internal_note_intents
  FOR EACH ROW EXECUTE FUNCTION guard_support_internal_note_intent_update();

CREATE OR REPLACE FUNCTION support_create_internal_note_result(
  p_tenant_id uuid,
  p_intent_key_sha256 text,
  p_conversation_id uuid,
  p_sender text,
  p_body text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  bound_conversation uuid;
  created_message_id uuid;
  created_sent_at timestamptz := now();
BEGIN
  IF p_tenant_id IS DISTINCT FROM NULLIF(current_setting('app.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'support internal-note tenant context mismatch';
  END IF;

  IF p_intent_key_sha256 !~ '^[0-9a-f]{64}$' OR
     NOT helpdesk_display_text_valid(p_sender, 200, false) OR
     NOT helpdesk_display_text_valid(p_body, 16384, false) THEN
    RAISE EXCEPTION 'support internal-note projection rejected';
  END IF;

  SELECT conversation_id
    INTO bound_conversation
    FROM support_internal_note_intents
   WHERE tenant_id=p_tenant_id
     AND intent_key_sha256=p_intent_key_sha256
     AND state='pending'
   FOR UPDATE;
  IF NOT FOUND OR bound_conversation IS DISTINCT FROM p_conversation_id THEN
    RAISE EXCEPTION 'support internal-note pending intent not found';
  END IF;

  INSERT INTO support_messages
      (tenant_id,conversation_id,source_type,source_id,direction,sender_type,
       sender,body_text,body_html,attachments,metadata,sent_at)
  VALUES
      (p_tenant_id,p_conversation_id,'internal_note',
       'internal-note:' || p_intent_key_sha256,'internal','agent',p_sender,p_body,
       '','[]'::jsonb,jsonb_build_object('record_kind','internal_note'),created_sent_at)
  RETURNING id INTO created_message_id;

  UPDATE support_internal_note_intents AS intent
     SET state='committed', message_id=created_message_id, committed_at=created_sent_at
   WHERE intent.tenant_id=p_tenant_id
     AND intent.intent_key_sha256=p_intent_key_sha256
     AND intent.state='pending'
     AND intent.conversation_id=p_conversation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'support internal-note commit transition rejected';
  END IF;

  UPDATE support_conversations
     SET last_message_at=GREATEST(COALESCE(last_message_at, '-infinity'::timestamptz), created_sent_at),
         updated_at=created_sent_at
   WHERE tenant_id=p_tenant_id AND id=p_conversation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'support internal-note conversation disappeared';
  END IF;

  RETURN created_message_id;
END
$$;

REVOKE ALL ON FUNCTION guard_support_internal_note_intent_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_support_internal_note_intent_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION support_create_internal_note_result(uuid,text,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION support_create_internal_note_result(uuid,text,uuid,text,text) TO postwave_app;

CREATE TABLE support_ingest_conflicts (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_type text NOT NULL,
  source_id_sha256 text NOT NULL CHECK (source_id_sha256 ~ '^[0-9a-f]{64}$'),
  existing_message_id uuid,
  existing_sha256 text NOT NULL CHECK (existing_sha256 ~ '^[0-9a-f]{64}$'),
  incoming_sha256 text NOT NULL CHECK (incoming_sha256 ~ '^[0-9a-f]{64}$'),
  reason text NOT NULL CHECK (reason IN ('immutable_source_mismatch')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT support_ingest_conflict_message_tenant_fk FOREIGN KEY (tenant_id,existing_message_id)
    REFERENCES support_messages(tenant_id,id) ON DELETE SET NULL (existing_message_id)
);

CREATE INDEX support_internal_note_intents_message_idx ON support_internal_note_intents (tenant_id,message_id);
CREATE INDEX support_ingest_conflicts_recent_idx ON support_ingest_conflicts (tenant_id,created_at DESC);

-- Keep these statements literal: the repository-wide tenant isolation guard
-- attributes RLS to exact table names and must not infer security from a
-- dynamic identifier loop.
ALTER TABLE support_internal_note_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_internal_note_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_internal_note_intents AS RESTRICTIVE FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON support_internal_note_intents AS PERMISSIVE FOR ALL TO postwave_app
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE support_ingest_conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_ingest_conflicts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_ingest_conflicts AS RESTRICTIVE FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON support_ingest_conflicts AS PERMISSIVE FOR ALL TO postwave_app
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT,INSERT ON support_internal_note_intents TO postwave_app;
REVOKE UPDATE,DELETE ON support_internal_note_intents FROM postwave_app;
GRANT SELECT,INSERT ON support_ingest_conflicts TO postwave_app;
GRANT USAGE,SELECT ON SEQUENCE support_ingest_conflicts_id_seq TO postwave_app;

-- Provider/source evidence is immutable to the application. Lifecycle erasure
-- remains a privileged, separately governed operation; Route41 keeps that
-- lifecycle explicitly held until it exists.
REVOKE INSERT,UPDATE,DELETE ON support_messages FROM postwave_app;

CREATE OR REPLACE FUNCTION reject_support_message_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'support_messages are immutable; append a revision/conflict record';
END
$$;
DROP TRIGGER IF EXISTS support_messages_reject_update ON support_messages;
CREATE TRIGGER support_messages_reject_update
  BEFORE UPDATE ON support_messages
  FOR EACH ROW EXECUTE FUNCTION reject_support_message_update();

COMMIT;
