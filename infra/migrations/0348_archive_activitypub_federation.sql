-- 0348_archive_activitypub_federation.sql
--
-- Phase 3 XL `archive-activitypub-federation` — extends the v1 ActivityPub
-- scaffold (migration 0287) with the data model the multi-week federation
-- engine needs to interoperate cleanly with Mastodon / Threads / Bluesky
-- bridges / WordPress.
--
-- The v1 migration shipped:
--   - activitypub_actors          (per-tenant fediverse identity + RSA keys)
--   - activitypub_followers       (remote Actors with pending/accepted Follows)
--   - activitypub_outbox          (outbound Create{Article} envelopes)
--   - activitypub_inbox           (incoming Activity envelopes)
--   - activitypub_delivery_queue  (per-(envelope, follower) attempt log)
--
-- What was *intentionally deferred* and is now scaffolded:
--
--   1. activitypub_remote_actors  — cache of dereferenced remote actor
--      JSON-LD (icon, display_name, sharedInbox, public_key_pem). The
--      v1 inbox handler stores the remote actor URL verbatim from the
--      Follow envelope but never fetches the actor; this is how
--      Mastodon-style remote-profile cards become possible.
--
--   2. activitypub_signature_keys — log of per-tenant signing key
--      rotations. The v1 actor row holds the *current* RSA keypair; a
--      rotation publishes a new key with a fresh #main-key fragment
--      and keeps the prior key around long enough for in-flight
--      Mastodon servers to verify the trailing envelopes.
--
--   3. activitypub_delivery_worker_state — singleton leader-lease row
--      the delivery worker takes when it starts a tick. Mirrors how
--      audit-sink / replay worker tick state is persisted; lets a
--      future multi-replica deploy elect a single worker without an
--      external lock service.
--
--   4. activitypub_inbox.linked_comment_id   (FK → archive_comments)
--      activitypub_inbox.linked_campaign_id  (FK → campaigns)
--      — two-way linking from incoming Create{Note inReplyTo=...} into
--      the archive_comments thread. The two columns are nullable +
--      unindexed-until-populated so the join is cheap when the linking
--      worker eventually runs.
--
--   5. activitypub_outbox.signature_state    (text)
--      activitypub_outbox.signed_at          (timestamptz)
--      — observability of the HTTP-Signature signing path. The
--      delivery worker stamps `signed` once the rsa-sha256 signature
--      header has been computed; UI surfaces "unsigned outbox" as a
--      warning state.
--
--   6. activitypub_delivery_queue.signature_header  (text)
--      activitypub_delivery_queue.last_status_code   (int)
--      — the signed header is computed once per (outbox, inbox) tuple
--      and re-used across retries; persisting it keeps a 429-retried
--      POST byte-identical, which Mastodon's signature cache requires.
--
-- Inspired by 2026 SOTA from:
--   Ghost (built-in ActivityPub since 6.0)
--   Substack Notes (in-platform federation variant)

BEGIN;

-- 1. Remote actor cache --------------------------------------------------
--    Keyed by the remote actor URL. Tenant-scoped because the same
--    remote actor that follows two of our tenants needs two cache rows
--    (no shared row -> no cross-tenant leakage if one tenant decides
--    to block this follower).
CREATE TABLE IF NOT EXISTS activitypub_remote_actors (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- Canonical id of the remote actor (e.g. https://mastodon.social/users/foo).
    actor_url            text NOT NULL,
    -- Dereferenced inbox + sharedInbox so the delivery worker doesn't
    -- need to refetch the actor JSON-LD before every POST.
    inbox_url            text,
    shared_inbox_url     text,
    -- Profile metadata copied from the remote actor JSON-LD. Refreshed
    -- on a TTL (default 7d) by the actor-fetch worker.
    display_name         text,
    handle               text,
    icon_url             text,
    summary              text,
    -- Remote public key PEM. Required to verify rsa-sha256 signatures
    -- on inbound activities from this actor. NULL until the fetch
    -- worker dereferences the actor.
    public_key_pem       text,
    public_key_id        text,
    -- Soft-fail counter. After N consecutive 4xx/5xx fetches, the
    -- fetch worker stops retrying until manually re-enabled. Mirrors
    -- the Mastodon `unreachable` flag.
    fetch_failures       int NOT NULL DEFAULT 0,
    last_fetch_error     text,
    last_fetched_at      timestamptz,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, actor_url)
);

CREATE INDEX IF NOT EXISTS activitypub_remote_actors_stale_idx
    ON activitypub_remote_actors (last_fetched_at NULLS FIRST)
    WHERE fetch_failures < 5;

GRANT SELECT, INSERT, UPDATE, DELETE ON activitypub_remote_actors TO postwave_app;

ALTER TABLE activitypub_remote_actors ENABLE ROW LEVEL SECURITY;
ALTER TABLE activitypub_remote_actors FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON activitypub_remote_actors
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- The delivery + fetch workers run with `app.outbox_worker = 'true'`
-- and walk remote actors across all tenants. Permissive SELECT/UPDATE
-- gated by the worker GUC mirrors how audit_alerts/operators.go
-- crosses tenants.
CREATE POLICY remote_actors_worker_rw ON activitypub_remote_actors
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (NULLIF(current_setting('app.outbox_worker', true), '') = 'true')
    WITH CHECK (NULLIF(current_setting('app.outbox_worker', true), '') = 'true');

-- 2. Signing-key rotation log -------------------------------------------
--    One row per (tenant, key-id). The v1 actor row keeps the active
--    key; this table keeps the audit + the "still-trusted-during-grace"
--    set so we can rotate without breaking Mastodon caches.
CREATE TABLE IF NOT EXISTS activitypub_signature_keys (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- The #fragment Mastodon stores; defaults to '#main-key' but a
    -- rotation increments the suffix ('#main-key-2', ...).
    key_id               text NOT NULL,
    public_key_pem       text NOT NULL,
    -- Private key is encrypted at rest with the platform KMS key.
    -- The plaintext PEM never lives in the row store. Application
    -- code calls byok.Decrypt before signing.
    private_key_ciphertext bytea NOT NULL,
    -- active | retired | revoked.
    state                text NOT NULL DEFAULT 'active',
    activated_at         timestamptz NOT NULL DEFAULT now(),
    retired_at           timestamptz,
    UNIQUE (tenant_id, key_id)
);

CREATE INDEX IF NOT EXISTS activitypub_signature_keys_active_idx
    ON activitypub_signature_keys (tenant_id, state, activated_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON activitypub_signature_keys TO postwave_app;

ALTER TABLE activitypub_signature_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE activitypub_signature_keys FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON activitypub_signature_keys
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 3. Delivery worker tick state ----------------------------------------
--    Singleton row per platform (tenant_id IS NULL). The delivery
--    worker takes the lease, walks every pending delivery_queue row
--    across all tenants in `app.outbox_worker` scope, and releases on
--    exit. Tracks last-success metrics so the admin "Federation
--    health" panel surfaces "last delivered at <X> ago".
CREATE TABLE IF NOT EXISTS activitypub_delivery_worker_state (
    id                   text PRIMARY KEY DEFAULT 'singleton',
    lease_holder         text,
    lease_expires_at     timestamptz,
    last_tick_at         timestamptz,
    last_tick_delivered  int NOT NULL DEFAULT 0,
    last_tick_failed     int NOT NULL DEFAULT 0,
    last_tick_error      text,
    updated_at           timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON activitypub_delivery_worker_state TO postwave_app;

-- Seed the singleton row BEFORE row-level security is enabled.
--
-- THE ORDER HERE IS LOAD-BEARING, and the original order could not apply to
-- a fresh database. `FORCE ROW LEVEL SECURITY` subjects the TABLE OWNER to
-- RLS as well, and the only policy below names `postwave_app`. The migrator
-- is neither: `infra/aws/PRODUCTION_DEPLOY_RUNBOOK.md` runs it under the RDS
-- master/schema-owner credential ("the migrator needs the schema
-- owner/master credential; the API must never receive it"). With FORCE on and
-- no policy naming that role, the default is deny, so the seed INSERT required
-- the migrator to bypass RLS -- that is, to be a superuser. Reproduced as a
-- non-superuser owner:
--
--   ERROR: new row violates row-level security policy
--          for table "activitypub_delivery_worker_state"
--
-- It went unnoticed because a replay is typically run by a superuser, which
-- bypasses RLS entirely -- including FORCE. Migration 1738 does independently
-- require a superuser migrator (it creates a BYPASSRLS role), so this was not
-- necessarily deploy-blocking on its own. The point is narrower and still
-- worth fixing: seeding one row never needed that privilege.
--
-- Seeding first needs no policy exemption and leaves an identical end state:
-- same row, same grants, same policies. Verified that the worker role WITH
-- `app.outbox_worker` sees the row and WITHOUT it sees nothing, so the
-- isolation contract is unchanged.
INSERT INTO activitypub_delivery_worker_state (id) VALUES ('singleton')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE activitypub_delivery_worker_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE activitypub_delivery_worker_state FORCE  ROW LEVEL SECURITY;

-- The singleton row is platform-global. Only worker-scoped sessions
-- may read/write it.
CREATE POLICY worker_only ON activitypub_delivery_worker_state
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (NULLIF(current_setting('app.outbox_worker', true), '') = 'true')
    WITH CHECK (NULLIF(current_setting('app.outbox_worker', true), '') = 'true');

-- 4. Two-way inbox -> archive linking ----------------------------------
--    A Create{Note inReplyTo=<our outbox activity>} envelope arrives
--    in the inbox today; the inbox row persists but no UI surfaces it
--    on the issue page. These columns let the linking worker join the
--    inbox row back to the campaign + (optionally) the archive_comments
--    thread.
ALTER TABLE activitypub_inbox
    ADD COLUMN IF NOT EXISTS linked_campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS linked_comment_id  uuid;

-- archive_comments is in a downstream package; we keep this as a soft
-- FK (no REFERENCES) so the migration order doesn't matter. The Go
-- repo enforces existence at write time.

CREATE INDEX IF NOT EXISTS activitypub_inbox_linked_campaign_idx
    ON activitypub_inbox (tenant_id, linked_campaign_id, created_at DESC)
    WHERE linked_campaign_id IS NOT NULL;

-- 5. Outbox signature observability ------------------------------------
ALTER TABLE activitypub_outbox
    ADD COLUMN IF NOT EXISTS signature_state text NOT NULL DEFAULT 'unsigned',
    ADD COLUMN IF NOT EXISTS signed_at       timestamptz;

CREATE INDEX IF NOT EXISTS activitypub_outbox_unsigned_idx
    ON activitypub_outbox (tenant_id, signature_state)
    WHERE signature_state = 'unsigned';

-- 6. Delivery queue signature cache + status -----------------------------
ALTER TABLE activitypub_delivery_queue
    ADD COLUMN IF NOT EXISTS signature_header text,
    ADD COLUMN IF NOT EXISTS last_status_code int;

COMMIT;
