-- Route40 tenant ownership for every SMS relationship used by inbox,
-- consent, campaigns, broadcasts, click evidence, and worker throttles.
-- PostgreSQL foreign-key lookup bypasses child-table RLS for referential
-- integrity, so an id-only FK does not prove that the referenced row belongs
-- to the same tenant. Build parent ownership keys online, add NOT VALID
-- composite FKs (new writes fail immediately), count historical mismatches
-- without selecting recipient/provider values, then validate.
-- migration-execution: phased

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS sms_sender_profiles_tenant_id_id_uidx
  ON sms_sender_profiles (tenant_id, id);
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS sms_lists_tenant_id_id_uidx
  ON sms_lists (tenant_id, id);
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS sms_campaigns_tenant_id_id_uidx
  ON sms_campaigns (tenant_id, id);

-- Migration 1827 already built users_tenant_id_id_campaign_template_uidx
-- CONCURRENTLY for the same exact reference key. Reuse that proven unique
-- index below instead of adding another full users-table index during this
-- migration.

-- The runner durably records the concurrent-index phase above, then executes
-- every constraint adoption, historical preflight, and validation below in
-- one transaction. A poison row must never strand a partially adopted FK set
-- behind an unapplied migration version.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='sms_sender_profiles'::regclass AND conname='sms_sender_profiles_tenant_id_id_unique') THEN
    ALTER TABLE sms_sender_profiles ADD CONSTRAINT sms_sender_profiles_tenant_id_id_unique UNIQUE USING INDEX sms_sender_profiles_tenant_id_id_uidx;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='sms_lists'::regclass AND conname='sms_lists_tenant_id_id_unique') THEN
    ALTER TABLE sms_lists ADD CONSTRAINT sms_lists_tenant_id_id_unique UNIQUE USING INDEX sms_lists_tenant_id_id_uidx;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='sms_campaigns'::regclass AND conname='sms_campaigns_tenant_id_id_unique') THEN
    ALTER TABLE sms_campaigns ADD CONSTRAINT sms_campaigns_tenant_id_id_unique UNIQUE USING INDEX sms_campaigns_tenant_id_id_uidx;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='users'::regclass AND conname='users_tenant_id_id_unique') THEN
    IF to_regclass('public.users_tenant_id_id_campaign_template_uidx') IS NULL THEN
      RAISE EXCEPTION 'migration 1989 requires the users(tenant_id,id) unique index from migration 1827';
    END IF;
    ALTER TABLE users ADD CONSTRAINT users_tenant_id_id_unique UNIQUE USING INDEX users_tenant_id_id_campaign_template_uidx;
  END IF;
END
$$;

DO $$
DECLARE
  spec text[];
  item text;
  child_table text;
  constraint_name text;
  child_columns text;
  parent_table text;
  delete_action text;
BEGIN
  FOREACH item IN ARRAY ARRAY[
    'sms_lists|sms_lists_sender_profile_tenant_fk|tenant_id,sender_profile_id|sms_sender_profiles|ON DELETE SET NULL (sender_profile_id)',
    'sms_subscriptions|sms_subscriptions_list_tenant_fk|tenant_id,list_id|sms_lists|ON DELETE CASCADE',
    'sms_consent_events|sms_consent_events_list_tenant_fk|tenant_id,list_id|sms_lists|ON DELETE SET NULL (list_id)',
    'sms_campaigns|sms_campaigns_sender_profile_tenant_fk|tenant_id,sender_profile_id|sms_sender_profiles|ON DELETE SET NULL (sender_profile_id)',
    'sms_campaigns|sms_campaigns_list_tenant_fk|tenant_id,list_id|sms_lists|ON DELETE SET NULL (list_id)',
    'sms_messages|sms_messages_sender_profile_tenant_fk|tenant_id,sender_profile_id|sms_sender_profiles|ON DELETE SET NULL (sender_profile_id)',
    'sms_messages|sms_messages_campaign_tenant_fk|tenant_id,campaign_id|sms_campaigns|ON DELETE SET NULL (campaign_id)',
    'sms_campaign_recipients|sms_campaign_recipients_sender_profile_tenant_fk|tenant_id,sender_profile_id|sms_sender_profiles|ON DELETE CASCADE',
    'sms_campaign_recipients|sms_campaign_recipients_list_tenant_fk|tenant_id,list_id|sms_lists|ON DELETE CASCADE',
    'sms_campaign_recipients|sms_campaign_recipients_campaign_tenant_fk|tenant_id,campaign_id|sms_campaigns|ON DELETE CASCADE',
    'sms_campaign_recipients|sms_campaign_recipients_message_tenant_fk|tenant_id,message_id|sms_messages|ON DELETE SET NULL (message_id)',
    'sms_broadcasts|sms_broadcasts_sender_profile_tenant_fk|tenant_id,sender_profile_id|sms_sender_profiles|ON DELETE SET NULL (sender_profile_id)',
    'sms_broadcasts|sms_broadcasts_campaign_tenant_fk|tenant_id,campaign_id|sms_campaigns|ON DELETE SET NULL (campaign_id)',
    'sms_broadcasts|sms_broadcasts_segment_tenant_fk|tenant_id,segment_id|segments|ON DELETE SET NULL (segment_id)',
    'sms_link_clicks|sms_link_clicks_message_tenant_fk|tenant_id,message_id|sms_messages|ON DELETE SET NULL (message_id)',
    'sms_link_clicks|sms_link_clicks_campaign_tenant_fk|tenant_id,campaign_id|sms_campaigns|ON DELETE SET NULL (campaign_id)',
    'sms_link_tokens|sms_link_tokens_message_tenant_fk|tenant_id,message_id|sms_messages|ON DELETE SET NULL (message_id)',
    'sms_link_tokens|sms_link_tokens_campaign_tenant_fk|tenant_id,campaign_id|sms_campaigns|ON DELETE CASCADE',
    'sms_send_throttle_state|sms_send_throttle_sender_tenant_fk|tenant_id,sender_profile_id|sms_sender_profiles|ON DELETE CASCADE',
    'social_auto_reply_rules|social_auto_reply_rules_sms_list_tenant_fk|tenant_id,sms_list_id|sms_lists|ON DELETE SET NULL (sms_list_id)',
    'social_auto_reply_rules|social_auto_reply_rules_sender_profile_tenant_fk|tenant_id,sender_profile_id|sms_sender_profiles|ON DELETE SET NULL (sender_profile_id)',
    'tap_to_text_links|tap_to_text_links_sms_list_tenant_fk|tenant_id,sms_list_id|sms_lists|ON DELETE SET NULL (sms_list_id)',
    'tap_to_text_links|tap_to_text_links_sender_profile_tenant_fk|tenant_id,sender_profile_id|sms_sender_profiles|ON DELETE SET NULL (sender_profile_id)',
    'sms_conversation_state|sms_conversation_state_assignee_tenant_fk|tenant_id,assignee_user_id|users|ON DELETE SET NULL (assignee_user_id)',
    'sms_conversation_tags|sms_conversation_tags_creator_tenant_fk|tenant_id,created_by|users|ON DELETE SET NULL (created_by)',
    'sms_quick_replies|sms_quick_replies_creator_tenant_fk|tenant_id,created_by|users|ON DELETE SET NULL (created_by)'
  ] LOOP
    spec := string_to_array(item, '|');
    child_table := spec[1]; constraint_name := spec[2]; child_columns := spec[3]; parent_table := spec[4]; delete_action := spec[5];
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=child_table::regclass AND conname=constraint_name) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%s) REFERENCES %I (tenant_id,id) %s NOT VALID',
        child_table, constraint_name, child_columns, parent_table, delete_action
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
    'lists_sender', (SELECT count(*) FROM sms_lists c JOIN sms_sender_profiles p ON p.id=c.sender_profile_id WHERE c.sender_profile_id IS NOT NULL AND p.tenant_id<>c.tenant_id),
    'subscriptions_list', (SELECT count(*) FROM sms_subscriptions c JOIN sms_lists p ON p.id=c.list_id WHERE p.tenant_id<>c.tenant_id),
    'consent_list', (SELECT count(*) FROM sms_consent_events c JOIN sms_lists p ON p.id=c.list_id WHERE c.list_id IS NOT NULL AND p.tenant_id<>c.tenant_id),
    'campaign_sender', (SELECT count(*) FROM sms_campaigns c JOIN sms_sender_profiles p ON p.id=c.sender_profile_id WHERE p.tenant_id<>c.tenant_id),
    'campaign_list', (SELECT count(*) FROM sms_campaigns c JOIN sms_lists p ON p.id=c.list_id WHERE c.list_id IS NOT NULL AND p.tenant_id<>c.tenant_id),
    'message_sender', (SELECT count(*) FROM sms_messages c JOIN sms_sender_profiles p ON p.id=c.sender_profile_id WHERE c.sender_profile_id IS NOT NULL AND p.tenant_id<>c.tenant_id),
    'message_campaign', (SELECT count(*) FROM sms_messages c JOIN sms_campaigns p ON p.id=c.campaign_id WHERE c.campaign_id IS NOT NULL AND p.tenant_id<>c.tenant_id),
    'recipient_sender', (SELECT count(*) FROM sms_campaign_recipients c JOIN sms_sender_profiles p ON p.id=c.sender_profile_id WHERE p.tenant_id<>c.tenant_id),
    'recipient_list', (SELECT count(*) FROM sms_campaign_recipients c JOIN sms_lists p ON p.id=c.list_id WHERE c.list_id IS NOT NULL AND p.tenant_id<>c.tenant_id),
    'recipient_campaign', (SELECT count(*) FROM sms_campaign_recipients c JOIN sms_campaigns p ON p.id=c.campaign_id WHERE p.tenant_id<>c.tenant_id),
    'recipient_message', (SELECT count(*) FROM sms_campaign_recipients c JOIN sms_messages p ON p.id=c.message_id WHERE c.message_id IS NOT NULL AND p.tenant_id<>c.tenant_id),
    'broadcast_sender', (SELECT count(*) FROM sms_broadcasts c JOIN sms_sender_profiles p ON p.id=c.sender_profile_id WHERE c.sender_profile_id IS NOT NULL AND p.tenant_id<>c.tenant_id),
    'broadcast_campaign', (SELECT count(*) FROM sms_broadcasts c JOIN sms_campaigns p ON p.id=c.campaign_id WHERE c.campaign_id IS NOT NULL AND p.tenant_id<>c.tenant_id),
    'broadcast_segment', (SELECT count(*) FROM sms_broadcasts c JOIN segments p ON p.id=c.segment_id WHERE c.segment_id IS NOT NULL AND p.tenant_id<>c.tenant_id),
    'click_message', (SELECT count(*) FROM sms_link_clicks c JOIN sms_messages p ON p.id=c.message_id WHERE p.tenant_id<>c.tenant_id),
    'click_campaign', (SELECT count(*) FROM sms_link_clicks c JOIN sms_campaigns p ON p.id=c.campaign_id WHERE c.campaign_id IS NOT NULL AND p.tenant_id<>c.tenant_id),
    'token_message', (SELECT count(*) FROM sms_link_tokens c JOIN sms_messages p ON p.id=c.message_id WHERE p.tenant_id<>c.tenant_id),
    'token_campaign', (SELECT count(*) FROM sms_link_tokens c JOIN sms_campaigns p ON p.id=c.campaign_id WHERE c.campaign_id IS NOT NULL AND p.tenant_id<>c.tenant_id),
    'throttle_sender', (SELECT count(*) FROM sms_send_throttle_state c JOIN sms_sender_profiles p ON p.id=c.sender_profile_id WHERE p.tenant_id<>c.tenant_id),
    'social_rule_list', (SELECT count(*) FROM social_auto_reply_rules c JOIN sms_lists p ON p.id=c.sms_list_id WHERE c.sms_list_id IS NOT NULL AND p.tenant_id<>c.tenant_id),
    'social_rule_sender', (SELECT count(*) FROM social_auto_reply_rules c JOIN sms_sender_profiles p ON p.id=c.sender_profile_id WHERE c.sender_profile_id IS NOT NULL AND p.tenant_id<>c.tenant_id),
    'tap_link_list', (SELECT count(*) FROM tap_to_text_links c JOIN sms_lists p ON p.id=c.sms_list_id WHERE c.sms_list_id IS NOT NULL AND p.tenant_id<>c.tenant_id),
    'tap_link_sender', (SELECT count(*) FROM tap_to_text_links c JOIN sms_sender_profiles p ON p.id=c.sender_profile_id WHERE c.sender_profile_id IS NOT NULL AND p.tenant_id<>c.tenant_id),
    'state_assignee', (SELECT count(*) FROM sms_conversation_state c JOIN users p ON p.id=c.assignee_user_id WHERE c.assignee_user_id IS NOT NULL AND p.tenant_id<>c.tenant_id),
    'tag_creator', (SELECT count(*) FROM sms_conversation_tags c JOIN users p ON p.id=c.created_by WHERE c.created_by IS NOT NULL AND p.tenant_id<>c.tenant_id),
    'quick_reply_creator', (SELECT count(*) FROM sms_quick_replies c JOIN users p ON p.id=c.created_by WHERE c.created_by IS NOT NULL AND p.tenant_id<>c.tenant_id)
  ) INTO mismatches;
  SELECT coalesce(sum(value::text::bigint),0) INTO total FROM jsonb_each(mismatches);
  IF total > 0 THEN
    RAISE EXCEPTION USING
      MESSAGE='Route40 SMS tenant-reference preflight failed',
      DETAIL=mismatches::text || '; remediate ownership without copying recipient/provider payloads before retrying migration 1989';
  END IF;
END
$$;

ALTER TABLE sms_lists VALIDATE CONSTRAINT sms_lists_sender_profile_tenant_fk;
ALTER TABLE sms_subscriptions VALIDATE CONSTRAINT sms_subscriptions_list_tenant_fk;
ALTER TABLE sms_consent_events VALIDATE CONSTRAINT sms_consent_events_list_tenant_fk;
ALTER TABLE sms_campaigns VALIDATE CONSTRAINT sms_campaigns_sender_profile_tenant_fk;
ALTER TABLE sms_campaigns VALIDATE CONSTRAINT sms_campaigns_list_tenant_fk;
ALTER TABLE sms_messages VALIDATE CONSTRAINT sms_messages_sender_profile_tenant_fk;
ALTER TABLE sms_messages VALIDATE CONSTRAINT sms_messages_campaign_tenant_fk;
ALTER TABLE sms_campaign_recipients VALIDATE CONSTRAINT sms_campaign_recipients_sender_profile_tenant_fk;
ALTER TABLE sms_campaign_recipients VALIDATE CONSTRAINT sms_campaign_recipients_list_tenant_fk;
ALTER TABLE sms_campaign_recipients VALIDATE CONSTRAINT sms_campaign_recipients_campaign_tenant_fk;
ALTER TABLE sms_campaign_recipients VALIDATE CONSTRAINT sms_campaign_recipients_message_tenant_fk;
ALTER TABLE sms_broadcasts VALIDATE CONSTRAINT sms_broadcasts_sender_profile_tenant_fk;
ALTER TABLE sms_broadcasts VALIDATE CONSTRAINT sms_broadcasts_campaign_tenant_fk;
ALTER TABLE sms_broadcasts VALIDATE CONSTRAINT sms_broadcasts_segment_tenant_fk;
ALTER TABLE sms_link_clicks VALIDATE CONSTRAINT sms_link_clicks_message_tenant_fk;
ALTER TABLE sms_link_clicks VALIDATE CONSTRAINT sms_link_clicks_campaign_tenant_fk;
ALTER TABLE sms_link_tokens VALIDATE CONSTRAINT sms_link_tokens_message_tenant_fk;
ALTER TABLE sms_link_tokens VALIDATE CONSTRAINT sms_link_tokens_campaign_tenant_fk;
ALTER TABLE sms_send_throttle_state VALIDATE CONSTRAINT sms_send_throttle_sender_tenant_fk;
ALTER TABLE social_auto_reply_rules VALIDATE CONSTRAINT social_auto_reply_rules_sms_list_tenant_fk;
ALTER TABLE social_auto_reply_rules VALIDATE CONSTRAINT social_auto_reply_rules_sender_profile_tenant_fk;
ALTER TABLE tap_to_text_links VALIDATE CONSTRAINT tap_to_text_links_sms_list_tenant_fk;
ALTER TABLE tap_to_text_links VALIDATE CONSTRAINT tap_to_text_links_sender_profile_tenant_fk;
ALTER TABLE sms_conversation_state VALIDATE CONSTRAINT sms_conversation_state_assignee_tenant_fk;
ALTER TABLE sms_conversation_tags VALIDATE CONSTRAINT sms_conversation_tags_creator_tenant_fk;
ALTER TABLE sms_quick_replies VALIDATE CONSTRAINT sms_quick_replies_creator_tenant_fk;

COMMIT;
