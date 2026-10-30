-- 1975_reply_imap_mailboxes.sql
--
-- F05's IMAP reply adapter: tenant-owned mailboxes the platform polls for
-- replies.
--
-- Replies reach the platform two ways today, both PUSH: a provider webhook, or
-- MX delivery to a per-tenant address (inbound_email_endpoints, migration
-- 0066). Neither helps a sender whose customers reply to a mailbox the tenant
-- already owns — support@theirdomain — which is the common case for anyone
-- migrating onto the platform. This is the PULL path for exactly that.
--
-- Credentials are never stored. Only secret REFERENCES are, in the same scheme
-- the controlled seed registry uses (migration 1930): the resolver holds the
-- material, the row holds a pointer, and a database dump is worth nothing to an
-- attacker. The CHECK is copied verbatim from 1930 rather than re-derived, so
-- the two cannot drift into accepting different reference shapes.
--
-- Cursor state lives on the row rather than in a side table. The seed registry
-- separates them because one mailbox has many folders; a reply mailbox polls
-- exactly one, so a second table would buy nothing and add a join to the hot
-- path.
--
-- rollback-strategy: restore. Dropping this table loses the poll cursor, and
-- re-adding it would re-ingest every message above the lost UID as a new
-- reply — duplicate customer replies and duplicate engagement events. Recover
-- the cursor from backup rather than letting the poller rebuild it.

CREATE TABLE IF NOT EXISTS reply_imap_mailboxes (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    label                    text NOT NULL CHECK (length(label) BETWEEN 1 AND 200),

    host                     text NOT NULL CHECK (
                                 length(host) BETWEEN 3 AND 255
                                 AND host !~ '[[:space:]]'
                             ),
    port                     integer NOT NULL DEFAULT 993 CHECK (port BETWEEN 1 AND 65535),
    -- Implicit TLS is the default and downgrading is a deliberate act. A
    -- mailbox polled in clear text ships its password over the wire on every
    -- cycle, so this is stored rather than assumed.
    use_tls                  boolean NOT NULL DEFAULT true,
    folder                   text NOT NULL DEFAULT 'INBOX' CHECK (length(folder) BETWEEN 1 AND 255),

    username_secret_ref      text NOT NULL CHECK (
                                 length(username_secret_ref) BETWEEN 5 AND 1000
                                 AND username_secret_ref ~ '^(env|env-json|aws-sm|vault|gcp-sm|azure-kv):(//)?[^[:space:]]+$'
                             ),
    password_secret_ref      text NOT NULL CHECK (
                                 length(password_secret_ref) BETWEEN 5 AND 1000
                                 AND password_secret_ref ~ '^(env|env-json|aws-sm|vault|gcp-sm|azure-kv):(//)?[^[:space:]]+$'
                             ),

    -- Disabled is the default. A mailbox appears in the table the moment an
    -- operator starts configuring it, and polling someone's live inbox because
    -- a row exists is not a mistake worth making.
    enabled                  boolean NOT NULL DEFAULT false,

    -- Poll cursor. uid_validity 0 means "never polled": a real IMAP
    -- UIDVALIDITY is a non-zero uint32, so the sentinel cannot collide with a
    -- server value.
    uid_validity             bigint NOT NULL DEFAULT 0 CHECK (uid_validity BETWEEN 0 AND 4294967295),
    last_uid                 bigint NOT NULL DEFAULT 0 CHECK (last_uid BETWEEN 0 AND 4294967295),
    -- Bumped whenever the server renumbers the mailbox, so a reader can tell a
    -- cursor reset from ordinary progress without diffing UIDs.
    generation               bigint NOT NULL DEFAULT 1 CHECK (generation >= 1),

    last_polled_at           timestamptz,
    last_error               text CHECK (last_error IS NULL OR length(last_error) <= 2000),
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),

    UNIQUE (tenant_id, host, folder, username_secret_ref)
);

CREATE INDEX IF NOT EXISTS reply_imap_mailboxes_pollable_idx
    ON reply_imap_mailboxes (last_polled_at NULLS FIRST)
    WHERE enabled;

ALTER TABLE reply_imap_mailboxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE reply_imap_mailboxes FORCE ROW LEVEL SECURITY;

-- NULLIF before the cast: current_setting(..., true) returns '' when the GUC is
-- unset, and ''::uuid raises rather than returning no rows, which turns a
-- missing tenant scope into a 500 instead of an empty result.
--
-- PERMISSIVE, not RESTRICTIVE. Restrictive policies only SUBTRACT from what a
-- permissive one already allows, so a table carrying only restrictive policies
-- denies everything — including the tenant INSERT this exists to permit.
DROP POLICY IF EXISTS reply_imap_mailboxes_tenant ON reply_imap_mailboxes;
CREATE POLICY reply_imap_mailboxes_tenant ON reply_imap_mailboxes
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- The poller runs outside any tenant scope: it has to discover which mailboxes
-- are due before it knows whose they are. This mirrors the seed capture cursors
-- (1927) and is the same two-factor shape — outbox worker AND the specific
-- worker flag — so a single leaked GUC does not open the table.
DROP POLICY IF EXISTS reply_imap_mailboxes_worker ON reply_imap_mailboxes;
CREATE POLICY reply_imap_mailboxes_worker ON reply_imap_mailboxes
    AS PERMISSIVE FOR SELECT TO postwave_app
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.reply_imap_worker', true) = 'true'
    );

DROP POLICY IF EXISTS reply_imap_mailboxes_worker_update ON reply_imap_mailboxes;
CREATE POLICY reply_imap_mailboxes_worker_update ON reply_imap_mailboxes
    AS PERMISSIVE FOR UPDATE TO postwave_app
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.reply_imap_worker', true) = 'true'
    )
    WITH CHECK (
        current_setting('app.outbox_worker', true) = 'true'
        AND current_setting('app.reply_imap_worker', true) = 'true'
    );

GRANT SELECT, INSERT, UPDATE, DELETE ON reply_imap_mailboxes TO postwave_app;

-- The cursor may only move forward within a generation. Enforced in the
-- database rather than only in the poller because a cursor that rolls backward
-- re-ingests every message in between as a NEW reply — duplicate customer
-- replies, duplicate engagement events, and a lead score that climbs on
-- replay. A UIDVALIDITY change is the one case that legitimately resets it, and
-- it must bump the generation so the reset is visible.
CREATE OR REPLACE FUNCTION reply_imap_mailbox_cursor_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
    IF NEW.uid_validity = OLD.uid_validity THEN
        IF NEW.last_uid < OLD.last_uid THEN
            RAISE EXCEPTION 'reply IMAP cursor may not move backward within a UIDVALIDITY'
                USING ERRCODE = '55000';
        END IF;
        IF NEW.generation <> OLD.generation THEN
            RAISE EXCEPTION 'reply IMAP generation changed without a UIDVALIDITY reset'
                USING ERRCODE = '55000';
        END IF;
    ELSIF OLD.uid_validity <> 0 AND NEW.generation <= OLD.generation THEN
        RAISE EXCEPTION 'reply IMAP UIDVALIDITY reset must advance the generation'
            USING ERRCODE = '55000';
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS reply_imap_mailbox_cursor_guard ON reply_imap_mailboxes;
CREATE TRIGGER reply_imap_mailbox_cursor_guard
    BEFORE UPDATE ON reply_imap_mailboxes
    FOR EACH ROW EXECUTE FUNCTION reply_imap_mailbox_cursor_guard();

REVOKE ALL ON FUNCTION reply_imap_mailbox_cursor_guard() FROM PUBLIC;
