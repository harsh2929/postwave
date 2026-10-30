-- 1893_action_tickets.sql
--
-- Let a person act on a notification from a place that has no session.
--
-- `notifications.ActionsForEvent` (migration 1891) now tells every surface what
-- can be done about a notification — Approve, Reject, Review devices. That works
-- in-app, where a session exists. It does nothing for the surface most likely to
-- reach somebody who is not at their desk: an email, a Slack message, a push
-- notification tapped from a lock screen. Those can only offer a link, and a
-- link into an authenticated app is a request to log in first, which is exactly
-- the friction the notification was trying to remove.
--
-- A ticket is a server-minted, single-use, short-lived proof that the BEARER may
-- perform ONE named action on ONE resource. It is not a session and cannot
-- become one: redeeming it authorises that action and nothing else.
--
-- WHAT IS STORED IS A HASH. The ticket secret goes in the link and is never
-- persisted, so a database disclosure does not hand over usable tickets — the
-- same reason `auth_sessions` stores a verifier hash rather than the verifier.
--
-- SINGLE USE IS ENFORCED IN THE DATABASE, not by a read-then-write in Go. Two
-- clicks on the same emailed button race, and a lost update there approves
-- something twice. The redeem is one conditional UPDATE whose WHERE clause is
-- the single-use rule.
--
-- SHORT LIVED BY DEFAULT. An approval link that works for a month is a
-- credential sitting in an inbox, forwarded, quoted in a reply chain, and
-- indexed by whatever scans that mailbox.

BEGIN;

CREATE TABLE IF NOT EXISTS action_tickets (
    id         uuid        NOT NULL DEFAULT gen_random_uuid(),
    tenant_id  uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- Who the ticket was minted FOR. Redemption records the same id, so an
    -- audit trail can say who acted and not merely that somebody did.
    user_id    uuid        NOT NULL,
    -- The action id from notifications.ActionsForEvent — a ticket may only name
    -- an action the catalog knows, so minting cannot invent an affordance no
    -- surface would ever render.
    action     text        NOT NULL,
    -- What it acts on. Deliberately (kind, id) rather than a bare id: a ticket
    -- for approval "42" must not redeem against campaign "42".
    resource_kind text     NOT NULL,
    resource_id   text     NOT NULL,
    -- SHA-256 of the ticket secret. The secret itself lives only in the link.
    secret_hash bytea      NOT NULL,
    expires_at timestamptz NOT NULL,
    -- Set exactly once, by the conditional UPDATE that redeems it.
    used_at    timestamptz,
    -- Recorded at redemption for the audit trail: which address clicked.
    used_ip    text        NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id),
    CONSTRAINT action_tickets_action_len CHECK (char_length(action) BETWEEN 1 AND 64),
    CONSTRAINT action_tickets_resource_len
        CHECK (char_length(resource_kind) BETWEEN 1 AND 64
           AND char_length(resource_id) BETWEEN 1 AND 128),
    CONSTRAINT action_tickets_secret_len CHECK (octet_length(secret_hash) = 32)
);

COMMENT ON TABLE action_tickets IS
    'Single-use, short-lived authorisation for ONE action on ONE resource, so a '
    'notification delivered outside the app (email, Slack, lock screen) can be '
    'acted on without a session. Stores a hash, never the secret. Redemption is '
    'a conditional UPDATE so two clicks cannot both succeed.';

-- The redeem path looks a ticket up by its hash, which is all the bearer proves.
CREATE UNIQUE INDEX IF NOT EXISTS action_tickets_secret_idx
    ON action_tickets (secret_hash);

-- The sweep: expired-and-unused tickets are noise, and a used one is only
-- interesting for as long as the audit window.
CREATE INDEX IF NOT EXISTS action_tickets_expiry_idx
    ON action_tickets (expires_at);

ALTER TABLE action_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_tickets FORCE ROW LEVEL SECURITY;

-- Redemption arrives with NO tenant context — the whole point is that the
-- bearer has no session — so the lookup runs under the resolver capability the
-- auth layer already uses for pre-tenant work, exactly as session lookup does.
DROP POLICY IF EXISTS tenant_isolation ON action_tickets;
CREATE POLICY tenant_isolation ON action_tickets
    AS RESTRICTIVE
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.session_resolver', true) = 'true'
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.session_resolver', true) = 'true'
    );

DROP POLICY IF EXISTS tenant_visible ON action_tickets;
CREATE POLICY tenant_visible ON action_tickets
    FOR ALL TO postwave_app
    USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON action_tickets TO postwave_app;

COMMIT;
