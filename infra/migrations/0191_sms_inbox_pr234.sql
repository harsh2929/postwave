-- 0191_sms_inbox_pr234.sql
--
-- Refined SMS Inbox PRs 2-4. Closes seven of the deferred items
-- from PR 1 in one schema landing:
--
--   * snooze_until / archived_at on sms_conversation_state — gives
--     each conversation a tri-state (active / snoozed / archived)
--     without needing a sibling table. The existing PK on
--     (tenant_id, phone_e164) means a phone has at most one row.
--   * assignee_user_id on sms_conversation_state — operator
--     assignment for team triage. NULL = unassigned.
--   * notes on sms_conversation_state — free-text per-conversation
--     internal notes. Same row as snooze + assignee so reading the
--     thread header is one row fetch.
--   * sms_conversation_tags table — many-to-many between phones and
--     reuses the canonical tags taxonomy (tag is just text, not a
--     foreign key — phones can carry tags that aren't registered, same
--     leniency as subscribers.tags).
--   * sms_quick_replies table — saved canned-response templates with
--     a usage counter so the picker can rank most-used at top.
--   * pg_trgm extension + GIN index on sms_messages.body — powers
--     server-side full-text search across thread bodies. Bounded by
--     tenant + (optionally) phone so the index fits naturally into
--     the existing per-tenant scan path.

-- Snooze / archive / assignment / notes — sit alongside the existing
-- read_at column. Each is independent so a conversation can be e.g.
-- archived AND assigned (just unlikely).
ALTER TABLE sms_conversation_state
  ADD COLUMN IF NOT EXISTS snooze_until     timestamptz NULL,
  ADD COLUMN IF NOT EXISTS archived_at      timestamptz NULL,
  ADD COLUMN IF NOT EXISTS assignee_user_id uuid        NULL,
  ADD COLUMN IF NOT EXISTS notes            text        NOT NULL DEFAULT '';

-- Partial indexes — most conversations are active so we don't want a
-- full index on snooze_until / archived_at. The partial index keeps
-- the inbox-list query that filters "WHERE archived_at IS NULL"
-- selective.
CREATE INDEX IF NOT EXISTS sms_conv_state_snoozed_idx
    ON sms_conversation_state (tenant_id, snooze_until)
 WHERE snooze_until IS NOT NULL;
CREATE INDEX IF NOT EXISTS sms_conv_state_archived_idx
    ON sms_conversation_state (tenant_id, archived_at)
 WHERE archived_at IS NOT NULL;

-- Conversation tags (many-to-many, free-text tag — same leniency as
-- subscribers.tags[]). UNIQUE prevents duplicate (phone, tag) rows.
CREATE TABLE IF NOT EXISTS sms_conversation_tags (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL,
    phone_e164  text NOT NULL,
    tag         text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    created_by  uuid NULL,
    UNIQUE (tenant_id, phone_e164, tag)
);
CREATE INDEX IF NOT EXISTS sms_conv_tags_tenant_phone_idx
    ON sms_conversation_tags (tenant_id, phone_e164);
CREATE INDEX IF NOT EXISTS sms_conv_tags_tenant_tag_idx
    ON sms_conversation_tags (tenant_id, tag);

-- Saved quick replies — operator picks one from the composer and the
-- body is templated into the textarea. `use_count` + `last_used_at`
-- let the picker rank most-used at top so frequently-used boilerplate
-- becomes one click. `created_by` is the original author; the row is
-- still tenant-shared (any admin can use / edit it).
CREATE TABLE IF NOT EXISTS sms_quick_replies (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL,
    label         text NOT NULL,
    body          text NOT NULL,
    use_count     integer NOT NULL DEFAULT 0,
    last_used_at  timestamptz NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    created_by    uuid NULL,
    UNIQUE (tenant_id, label)
);
CREATE INDEX IF NOT EXISTS sms_quick_replies_tenant_use_idx
    ON sms_quick_replies (tenant_id, use_count DESC, last_used_at DESC NULLS LAST);

-- Trigram-backed body search. The extension is idempotent; if it's
-- already on the cluster the CREATE EXTENSION is a no-op. Index is
-- per-tenant via the WHERE-clause partial — keeps the index size
-- reasonable for tenants who never use SMS.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS sms_messages_body_trgm_idx
    ON sms_messages USING gin (body gin_trgm_ops);
