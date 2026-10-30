-- 0288_archive_private_podcast_rss.sql
--
-- Per-subscriber tokenized private podcast RSS (gap feature
-- `archive-private-podcast-rss`, P3, surface=archive). Substack ships
-- per-paid-subscriber tokenized RSS URLs with entitlement-aware
-- filtering; Ghost integrates Transistor.fm; Postwave had no podcast
-- surface at all. This migration adds the schema groundwork:
--
--   1. campaigns.podcast_audio_url + companion columns — every
--      published campaign can optionally carry one audio episode.
--      Lives on campaigns (rather than a sibling `podcast_episodes`
--      table) because the archive surface is the canonical "published
--      issues" projection — keeping the audio fields inline avoids a
--      join on every feed render and matches the same shape we use
--      for archive_hero_image / archive_author_name.
--
--   2. campaigns.podcast_required_tier + podcast_public — entitlement
--      gating. `podcast_public=true` means the episode is included in
--      the unauthenticated public podcast feed; `podcast_required_tier`
--      lets operators gate premium episodes behind a paid_subs.plan_id
--      (empty string = "any active paid subscription unlocks").
--
--   3. subscriber_podcast_tokens — per-subscriber HMAC-bound token.
--      The token is base64url-encoded random bytes joined with the
--      subscriber id, so the public RSS handler can:
--         a) authenticate the requester in O(1) via the unique-index
--            lookup (no per-request HMAC verify needed on the hot path);
--         b) revoke a single subscriber's feed (e.g. churn) by
--            deleting the row without invalidating every other token;
--         c) rotate the token on demand without re-issuing the URL to
--            every subscriber (each row is independent).
--
-- Inspired by 2026 SOTA: Substack (per-paid-subscriber RSS), Ghost
-- (Members-only podcasts via Transistor), Spotify Open Access
-- (entitlement-bearing token URLs).

BEGIN;

-- 1. Per-issue podcast metadata. NOT NULL DEFAULT '' on the URL keeps
--    the column additive — every existing campaign reads as "no audio"
--    until an operator uploads one. duration_seconds=0 is the same
--    sentinel (RFC 4287 / iTunes <itunes:duration> tolerates 0 for
--    "unknown length"). podcast_enabled is the explicit toggle so an
--    operator can pre-stage an audio URL without flipping the episode
--    live in subscribers' feed readers.
ALTER TABLE campaigns
    ADD COLUMN IF NOT EXISTS podcast_audio_url        text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS podcast_audio_mime       text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS podcast_audio_bytes      bigint NOT NULL DEFAULT 0 CHECK (podcast_audio_bytes >= 0),
    ADD COLUMN IF NOT EXISTS podcast_duration_seconds integer NOT NULL DEFAULT 0 CHECK (podcast_duration_seconds >= 0),
    ADD COLUMN IF NOT EXISTS podcast_enabled          boolean NOT NULL DEFAULT false,
    -- '' = include in the unauthenticated public feed (free episode).
    -- Anything non-empty = require a subscriber token whose subscriber
    -- has an active paid_subs row. A non-empty value that doesn't
    -- match any paid_subs.plan_id means "require any active paid sub"
    -- (the resolver treats unknown tiers as "any-tier" gating, NOT as
    -- "permanently locked", so operators can rename plans without
    -- silently locking out subscribers).
    ADD COLUMN IF NOT EXISTS podcast_required_tier    text NOT NULL DEFAULT '',
    -- Explicit "include in public RSS" flag. Defaults to false because
    -- the per-subscriber tokenized feed is the canonical surface; the
    -- public feed is opt-in (operators commonly host a free trailer +
    -- gate the rest).
    ADD COLUMN IF NOT EXISTS podcast_public           boolean NOT NULL DEFAULT false;

-- Index for the public podcast feed's "give me the N most-recent
-- enabled episodes" query. Partial on (archive_public, podcast_enabled)
-- so it stays tiny — most campaigns are text-only, no audio.
CREATE INDEX IF NOT EXISTS campaigns_podcast_feed_idx
    ON campaigns (tenant_id, finished_at DESC)
    WHERE archive_public = true
      AND podcast_enabled = true;

-- 2. Tenant-level podcast channel metadata. Lives on
--    tenant_public_settings so the public RSS handler can resolve a
--    tenant_slug → channel title / author / cover image in the same
--    round-trip that resolves the tenant_id. Additive ALTER (the table
--    already exists from 0071_archive.sql).
ALTER TABLE tenant_public_settings
    ADD COLUMN IF NOT EXISTS podcast_title            text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS podcast_description      text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS podcast_author           text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS podcast_cover_image_url  text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS podcast_language         text NOT NULL DEFAULT 'en',
    -- iTunes <itunes:category> — free-text top-level category. Empty
    -- = no category emitted (validators tolerate this).
    ADD COLUMN IF NOT EXISTS podcast_category         text NOT NULL DEFAULT '',
    -- iTunes <itunes:explicit> yes/no. Default 'no' matches the
    -- Apple Podcasts safe-default for unspecified content.
    ADD COLUMN IF NOT EXISTS podcast_explicit         boolean NOT NULL DEFAULT false;

-- 3. Per-subscriber token. Each (tenant, subscriber_email) gets ONE
--    active token at a time; rotating means updating `token_secret`
--    in place so the old URL 404s as soon as the new one is minted.
--    The "one row per subscriber" invariant is enforced by the
--    UNIQUE (tenant_id, subscriber_email) constraint — POSTing a new
--    token while one already exists does INSERT ... ON CONFLICT (...)
--    DO UPDATE SET token_secret = EXCLUDED.token_secret which
--    atomically rotates without leaving an orphaned row.
CREATE TABLE IF NOT EXISTS subscriber_podcast_tokens (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- Soft-link to subscribers via email (not subscriber.id) because
    -- the email is the canonical identity the paid_subs row also uses
    -- (paid_subs.subscriber_email). Pre-import flows can create a
    -- token before the listmonk-mirrored subscribers row exists.
    subscriber_email    citext NOT NULL,
    -- 32 random bytes base64url-encoded → 43-char URL-safe opaque
    -- token. Compared verbatim by the public handler; never hashed
    -- on the read path so feed-reader retries stay O(1) index lookups.
    -- Stored as `text` rather than `bytea` so SQL clients can copy it
    -- around without hex-mangling.
    token_secret        text NOT NULL,
    -- last_used_at is updated best-effort by the public handler so the
    -- dashboard can show "last fetched" and so the operator-facing
    -- list can sort by activity. Nullable because a freshly-minted
    -- token has never been used.
    last_used_at        timestamptz,
    -- Optional revocation timestamp. When set the public handler
    -- returns 401; rotating overwrites token_secret AND nulls this.
    revoked_at          timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, subscriber_email)
);

-- Lookup index for the public read path: token → row in O(1). The
-- UNIQUE constraint above already gives us the (tenant, email) lookup
-- the rotate / lookup-by-subscriber paths need.
CREATE UNIQUE INDEX IF NOT EXISTS subscriber_podcast_tokens_secret_idx
    ON subscriber_podcast_tokens (token_secret);

CREATE TRIGGER subscriber_podcast_tokens_set_updated_at
    BEFORE UPDATE ON subscriber_podcast_tokens
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON subscriber_podcast_tokens TO postwave_app;

ALTER TABLE subscriber_podcast_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_podcast_tokens FORCE ROW LEVEL SECURITY;

-- Tenant-isolation: standard NULLIF idiom. The public read path opens
-- the lookup tx with SET LOCAL app.tenant_id = '' (unset), so the
-- NULLIF returns NULL and this RESTRICTIVE policy short-circuits —
-- the public handler must bypass via a server-side credential. We
-- handle that by always opening the lookup transaction with the
-- tenant id resolved from tenant_slug FIRST, then doing the token
-- comparison inside the tenant-scoped tx.
CREATE POLICY tenant_isolation ON subscriber_podcast_tokens
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON subscriber_podcast_tokens
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
