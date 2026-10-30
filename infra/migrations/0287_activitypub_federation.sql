-- 0287_activitypub_federation.sql
--
-- ActivityPub server scaffolding so every Postwave publication is a
-- fediverse actor followable from Mastodon, Threads, Bluesky-bridges
-- and WordPress. Long-form archive issues federate out as Article
-- objects.
--
-- Five tables layered into a single migration:
--
--   1. activitypub_actors — one row per tenant; the row IS the actor.
--      Holds the RSA keypair (PEM) that signs outbound activities, the
--      preferred username (defaults to tenant_archive_slug), and the
--      display/profile metadata Mastodon renders in its profile card.
--
--   2. activitypub_followers — remote Actors who have sent us a Follow
--      we accepted. Inbox URL is stored verbatim so the delivery
--      worker can POST signed Create{Article} envelopes without a
--      second WebFinger round-trip.
--
--   3. activitypub_outbox — outbound Activity envelopes (Create,
--      Update, Delete, Announce). Append-only; one envelope per
--      published archive issue + revision. The delivery worker fans
--      these out to followers asynchronously.
--
--   4. activitypub_inbox — incoming Activity envelopes (Follow, Undo,
--      Like, Announce, Reply / Create{Note} mentioning the actor).
--      Persists the raw JSON-LD plus a denormalised `kind` so the
--      admin can list "new follower" / "new like" without parsing.
--
--   5. activitypub_delivery_queue — per-(envelope, follower) delivery
--      attempt log so retries are idempotent + bounded. Mirrors how
--      Mastodon's sidekiq job table tracks deliveries.
--
-- Inspired by 2026 SOTA from: Ghost (built-in ActivityPub since 6.0),
-- Substack Notes (in-platform federation variant).

BEGIN;

-- 1. Actor row — the tenant's fediverse identity. Created on demand
--    the first time a federation endpoint is hit, or eagerly via the
--    admin "Enable federation" toggle.
CREATE TABLE IF NOT EXISTS activitypub_actors (
    tenant_id            uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    -- Preferred username — what users type after the @ in
    -- "@foo@archive.postwave.com". Defaults to tenant_archive_slug
    -- when the actor is auto-provisioned. citext for case-insensitive
    -- WebFinger lookup parity with Mastodon's `acct:` resolver.
    preferred_username   citext NOT NULL,
    -- Domain published in the actor's `id` URL. Mirrors
    -- tenant_public_settings.archive_domain when a custom domain is
    -- configured, otherwise the platform default (set at runtime).
    -- Stored so a tenant moving custom domains doesn't break the
    -- federation contract — Mastodon caches actor.id forever.
    domain               citext NOT NULL,
    -- Profile metadata rendered in the Mastodon profile card.
    display_name         text,
    summary              text,
    icon_url             text,
    image_url            text,
    -- RSA-2048 keypair PEM. Public key is published in the actor
    -- JSON-LD; private key signs outbound HTTP requests. Generated
    -- once at actor-provision time.
    public_key_pem       text NOT NULL,
    private_key_pem      text NOT NULL,
    -- Soft-disable so an admin can pause federation without dropping
    -- the row (which would orphan every follower's cached actor).
    enabled              boolean NOT NULL DEFAULT true,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    -- Username has to be unique within a domain — WebFinger resolves
    -- by (acct, host) tuple and Mastodon's federation database
    -- considers (preferred_username, domain) the actor's identity.
    UNIQUE (domain, preferred_username)
);

CREATE INDEX IF NOT EXISTS activitypub_actors_username_idx
    ON activitypub_actors (preferred_username);

GRANT SELECT, INSERT, UPDATE, DELETE ON activitypub_actors TO postwave_app;

ALTER TABLE activitypub_actors ENABLE ROW LEVEL SECURITY;
ALTER TABLE activitypub_actors FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON activitypub_actors
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- The WebFinger + actor JSON-LD endpoints are public; they look up
-- the row by (preferred_username, domain) without a tenant GUC bound
-- (the caller IS the public). Permissive SELECT policy for the app
-- role mirrors what tenant_public_settings does for the public slug
-- lookup. The actor handler reads ONLY public-safe fields.
CREATE POLICY actor_public_lookup ON activitypub_actors
    AS PERMISSIVE FOR SELECT
    TO postwave_app
    USING (enabled = true);

-- 2. Followers — remote Actors who have a pending or accepted Follow.
CREATE TABLE IF NOT EXISTS activitypub_followers (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- Remote actor URL — e.g. https://mastodon.social/users/foo. This
    -- is the canonical id of the follower; we never trust the
    -- preferredUsername/host pair on its own.
    actor_url            text NOT NULL,
    -- Inbox URL discovered from the remote actor's JSON-LD. The
    -- delivery worker POSTs signed envelopes here.
    inbox_url            text NOT NULL,
    -- "shared inbox" optimisation (Mastodon-style): if a server
    -- exposes a sharedInbox the delivery worker can fan multiple
    -- followers on the same host into a single POST.
    shared_inbox_url     text,
    -- Cached display fields so the admin "Followers" list renders
    -- without resolving every actor on every render.
    display_name         text,
    handle               text,
    -- accepted | pending | revoked. We accept-on-receipt by default
    -- (no manual approval) but the column leaves room for a future
    -- "approve follows" admin toggle.
    state                text NOT NULL DEFAULT 'accepted',
    follow_activity_id   text,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, actor_url)
);

CREATE INDEX IF NOT EXISTS activitypub_followers_state_idx
    ON activitypub_followers (tenant_id, state, created_at DESC);
CREATE INDEX IF NOT EXISTS activitypub_followers_shared_inbox_idx
    ON activitypub_followers (tenant_id, shared_inbox_url)
    WHERE shared_inbox_url IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON activitypub_followers TO postwave_app;

ALTER TABLE activitypub_followers ENABLE ROW LEVEL SECURITY;
ALTER TABLE activitypub_followers FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON activitypub_followers
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 3. Outbox — every outbound activity envelope this tenant has emitted.
--    The public /outbox endpoint paginates this table newest-first.
CREATE TABLE IF NOT EXISTS activitypub_outbox (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- The activity kind drives client rendering: Create | Update |
    -- Delete | Announce | Like.
    kind                 text NOT NULL,
    -- The campaign (archive issue) this activity is about, when
    -- applicable. NULL for non-issue activities (a hypothetical
    -- future "boost" / "note" surface).
    campaign_id          uuid REFERENCES campaigns(id) ON DELETE SET NULL,
    -- The fully-rendered JSON-LD envelope. Stored verbatim so a
    -- delivery retry never reconstructs the body (which would
    -- change `published`/`updated` timestamps and break signatures).
    activity_json        jsonb NOT NULL,
    -- The dereferenceable activity id Mastodon caches. Generated as
    -- {actor.id}/activities/{uuid}.
    activity_url         text NOT NULL,
    published_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, activity_url)
);

CREATE INDEX IF NOT EXISTS activitypub_outbox_recent_idx
    ON activitypub_outbox (tenant_id, published_at DESC);
CREATE INDEX IF NOT EXISTS activitypub_outbox_campaign_idx
    ON activitypub_outbox (tenant_id, campaign_id)
    WHERE campaign_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON activitypub_outbox TO postwave_app;

ALTER TABLE activitypub_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE activitypub_outbox FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON activitypub_outbox
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Public collection endpoint reads the outbox without a tenant GUC
-- (the actor's domain identifies the tenant). Permissive SELECT
-- mirrors actor_public_lookup.
CREATE POLICY outbox_public_lookup ON activitypub_outbox
    AS PERMISSIVE FOR SELECT
    TO postwave_app
    USING (true);

-- 4. Inbox — incoming Activity envelopes from remote actors.
--    Append-only; an admin "mark read" updates `read_at` rather than
--    deleting (so we can audit follow/unfollow cycles).
CREATE TABLE IF NOT EXISTS activitypub_inbox (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- Activity kind: Follow | Undo | Like | Announce | Create.
    kind                 text NOT NULL,
    actor_url            text NOT NULL,
    -- For Like/Announce/Create-mention, the dereferenceable id of
    -- the object being acted on (usually one of our outbox activities).
    object_url           text,
    activity_json        jsonb NOT NULL,
    -- Signature verification outcome. "verified" | "unverified" |
    -- "skipped" (skipped is the dev-mode bypass). Operators can
    -- filter the admin inbox to ignore unverified noise.
    sig_state            text NOT NULL DEFAULT 'unverified',
    read_at              timestamptz,
    created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS activitypub_inbox_unread_idx
    ON activitypub_inbox (tenant_id, created_at DESC)
    WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS activitypub_inbox_kind_idx
    ON activitypub_inbox (tenant_id, kind, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON activitypub_inbox TO postwave_app;

ALTER TABLE activitypub_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE activitypub_inbox FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON activitypub_inbox
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Permissive INSERT policy so the public /inbox POST handler can
-- persist incoming envelopes without binding a tenant GUC (the
-- tenant is identified by the URL path, not by an authenticated
-- session). The inbox POST always runs with the resolved tenant_id
-- bound just before the insert, so the RESTRICTIVE policy still
-- gates the row — this PERMISSIVE one only keeps the role-grant
-- layer satisfied.
CREATE POLICY inbox_public_insert ON activitypub_inbox
    AS PERMISSIVE FOR INSERT
    TO postwave_app
    WITH CHECK (true);

-- 5. Delivery queue — per-(envelope, follower) attempt log. Bounded
--    retries with exponential backoff; once `attempts` >= max_attempts
--    or the delivery succeeds we stop touching the row.
CREATE TABLE IF NOT EXISTS activitypub_delivery_queue (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    outbox_id            uuid NOT NULL REFERENCES activitypub_outbox(id) ON DELETE CASCADE,
    -- inbox URL we'll POST to. Denormalised from activitypub_followers
    -- so a follower revoking their Follow doesn't drop the in-flight
    -- queue row (we record `revoked` on the follower and let the
    -- queue drain naturally).
    inbox_url            text NOT NULL,
    attempts             int NOT NULL DEFAULT 0,
    -- next_attempt_at < now() makes the row eligible for the worker.
    next_attempt_at      timestamptz NOT NULL DEFAULT now(),
    last_error           text,
    -- success | failed | pending. `failed` is terminal (exceeded
    -- max_attempts) and tells the admin "this follower is dead".
    state                text NOT NULL DEFAULT 'pending',
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    UNIQUE (outbox_id, inbox_url)
);

CREATE INDEX IF NOT EXISTS activitypub_delivery_pending_idx
    ON activitypub_delivery_queue (next_attempt_at)
    WHERE state = 'pending';

GRANT SELECT, INSERT, UPDATE, DELETE ON activitypub_delivery_queue TO postwave_app;

ALTER TABLE activitypub_delivery_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE activitypub_delivery_queue FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON activitypub_delivery_queue
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
