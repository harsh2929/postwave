-- 0342_archive_recommendations_network.sql
--
-- Cross-tenant editorial recommendations network — Phase 3 XL follow-up
-- on top of migration 0286_archive_recommendations_network.sql, which
-- shipped the core trio: `tenant_recommendations`, `recommendation_clicks`,
-- `webmentions_inbox`.
--
-- This migration adds ADDITIVE scaffolding that the Phase 3 follow-on
-- work needs but doesn't have yet, so the human engineer who picks up
-- the multi-week portion has every table + index already in place:
--
--   1. `webmention_parser_runs` — bookkeeping for the (still-deferred)
--      async Webmention parser worker. Each row is one worker pass;
--      success/failure + counters power a /healthz tile.
--
--   2. `recommendation_conversions` — append-only conversion log. The
--      click handler already records clicks; this table records the
--      OTHER side of the funnel: when a clicked-through visitor goes on
--      to confirm a subscription on the target publication (or, for
--      in-network targets, on the receiving Postwave tenant). Without
--      this we can show clicks but not conversion rate — Substack's
--      Recommendations dashboard hinges on this ratio.
--
--   3. `recommendation_network_peers` — federation peer table. Lets the
--      cross-tenant discovery job + the open-web Webmention parser
--      record which external hosts have OPTED IN to be promoted into
--      one-click in-app subscribes (Substack's network is opt-in; ours
--      will be too). The job that populates rows from authenticated
--      `/.well-known/postwave-recommendations.json` discovery is
--      DEFERRED — schema is here so it can land independently.
--
--   4. Two new columns on `tenant_recommendations`:
--        - `subscribe_url`  — the canonical one-click subscribe URL
--          when the renderer should hit a known subscribe endpoint
--          (overrides `to_url` on the CTA only).
--        - `discovered_at`  — populated by the cross-tenant discovery
--          job when `to_tenant_id` gets resolved. Lets the slideover
--          surface "auto-upgraded N days ago".
--
-- Standard RLS posture using the project NULLIF GUC idiom — raw cast on
-- an unset `app.tenant_id` crashes; NULLIF returns NULL and the
-- predicate short-circuits cleanly.
--
-- Inspired by 2026 SOTA: Substack (Recommendations Network),
-- beehiiv (Top-4), Ghost (Webmention-based).

BEGIN;

-- ---------------------------------------------------------------------
-- 1. webmention_parser_runs  (DEFERRED parser worker bookkeeping)
-- ---------------------------------------------------------------------
-- One row per worker pass over `webmentions_inbox`. Worker stub lives
-- at apps/api/internal/archive/webmention_worker.go; this table records
-- run state so the operator can see "parser last ran 2 minutes ago,
-- processed 14 mentions, 2 promoted".
CREATE TABLE IF NOT EXISTS webmention_parser_runs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- System-scoped — the parser is platform-shared, not per-tenant.
    -- (RLS therefore admits only the worker-bypass GUC.)
    started_at      timestamptz NOT NULL DEFAULT now(),
    finished_at     timestamptz NULL,
    -- counters
    scanned         int NOT NULL DEFAULT 0,
    parsed_ok       int NOT NULL DEFAULT 0,
    parsed_err      int NOT NULL DEFAULT 0,
    promoted        int NOT NULL DEFAULT 0,
    -- final state of this run
    status          text NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'ok', 'partial', 'failed')),
    -- short tail of the last error (truncated to 4 KB to keep rows tidy)
    last_error      text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS webmention_parser_runs_recent_idx
    ON webmention_parser_runs (started_at DESC);

GRANT SELECT, INSERT, UPDATE ON webmention_parser_runs TO postwave_app;

ALTER TABLE webmention_parser_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE webmention_parser_runs FORCE ROW LEVEL SECURITY;

-- Worker-only. The `app.outbox_worker` GUC is the project's standard
-- "bypass tenant predicate, this is a platform worker" toggle.
CREATE POLICY worker_only ON webmention_parser_runs
    FOR ALL TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

-- ---------------------------------------------------------------------
-- 2. recommendation_conversions
-- ---------------------------------------------------------------------
-- Append-only conversion log. The recommendation click handler issues a
-- 302 with `?rcid=<click_id>` appended (a deferred change in the public
-- renderer); the destination then pings either:
--   - For in-network targets: the receiving tenant's subscribe-confirm
--     hook fires `/api/public/recommendations/conversion?rcid=...`
--   - For open-web targets: the destination publication can hit the
--     same endpoint with their site key, OR we use a (deferred) pixel
--     on the subscribe-confirm page they embed.
-- Conversion is therefore at-best-effort and intentionally asymmetric —
-- we under-count rather than fabricate. Substack/beehiiv take the same
-- under-counting tradeoff.
CREATE TABLE IF NOT EXISTS recommendation_conversions (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- "From" tenant (the recommender). Drives RLS.
    tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    recommendation_id uuid NOT NULL REFERENCES tenant_recommendations(id) ON DELETE CASCADE,
    -- Optional link back to the click row that started the funnel.
    -- NULL when conversion is reported without click attribution (we
    -- still record the conversion so totals are right).
    click_id          uuid NULL REFERENCES recommendation_clicks(id) ON DELETE SET NULL,
    -- For in-network targets — the receiving tenant (the publication
    -- that gained the subscriber). NULL for open-web.
    to_tenant_id      uuid NULL REFERENCES tenants(id) ON DELETE SET NULL,
    -- "confirmed_double_opt_in" | "single_opt_in" | "open_web_pixel"
    kind              text NOT NULL DEFAULT 'confirmed_double_opt_in',
    -- Truncated source-side referrer host. Symmetric with recommendation_clicks.
    referrer_host     text NOT NULL DEFAULT '',
    converted_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS recommendation_conversions_lookup_idx
    ON recommendation_conversions (tenant_id, recommendation_id, converted_at DESC);

CREATE INDEX IF NOT EXISTS recommendation_conversions_click_idx
    ON recommendation_conversions (click_id)
    WHERE click_id IS NOT NULL;

GRANT SELECT, INSERT ON recommendation_conversions TO postwave_app;

ALTER TABLE recommendation_conversions ENABLE ROW LEVEL SECURITY;
ALTER TABLE recommendation_conversions FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON recommendation_conversions
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON recommendation_conversions
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );

-- ---------------------------------------------------------------------
-- 3. recommendation_network_peers  (federation opt-in registry)
-- ---------------------------------------------------------------------
-- Records the external hosts that have opted in to be promoted to
-- in-app one-click subscribes via the cross-tenant discovery job.
-- Substack's network is opt-in; ours follows the same model. Rows are
-- platform-scoped (no tenant_id) — the discovery job is shared
-- infrastructure, not per-tenant.
--
-- Discovery protocol (DEFERRED): the job fetches
--   https://<host>/.well-known/postwave-recommendations.json
-- and if a valid signed manifest is returned, inserts the host here.
-- The manifest carries a publication_id we can use to dedupe across
-- vanity domains.
CREATE TABLE IF NOT EXISTS recommendation_network_peers (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Canonical host (no scheme, no path). Unique across the platform.
    host            citext NOT NULL UNIQUE,
    -- The publication_id the host published in its manifest.
    -- Allows us to dedupe vanity-domain mirrors (e.g., foo.com and
    -- foo.substack.com pointing at the same publication).
    publication_id  text NOT NULL DEFAULT '',
    -- When the host's manifest was last fetched + verified. NULL on rows
    -- inserted manually by the admin (pre-population of trusted peers).
    last_verified_at timestamptz NULL,
    -- When the host's manifest expires (manifest carries an `expires_at`
    -- claim). The discovery job re-fetches when within 24h of expiry.
    expires_at       timestamptz NULL,
    -- Optional in-network tenant_id, when the peer is itself a Postwave
    -- tenant. Lets the renderer use the tenant's archive_domain directly.
    tenant_id        uuid NULL REFERENCES tenants(id) ON DELETE SET NULL,
    -- "active" | "expired" | "revoked" | "pending_verification"
    status           text NOT NULL DEFAULT 'pending_verification',
    discovered_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS recommendation_network_peers_status_idx
    ON recommendation_network_peers (status, discovered_at DESC);

CREATE INDEX IF NOT EXISTS recommendation_network_peers_tenant_idx
    ON recommendation_network_peers (tenant_id)
    WHERE tenant_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE ON recommendation_network_peers TO postwave_app;

-- Platform-shared table; readable to all tenants (the discovery job
-- and the cross-tenant resolver both need to read this) but writable
-- only by the platform worker.
ALTER TABLE recommendation_network_peers ENABLE ROW LEVEL SECURITY;
ALTER TABLE recommendation_network_peers FORCE ROW LEVEL SECURITY;

CREATE POLICY shared_read ON recommendation_network_peers
    FOR SELECT TO postwave_app
    USING (true);

CREATE POLICY worker_write ON recommendation_network_peers
    FOR INSERT TO postwave_app
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

CREATE POLICY worker_update ON recommendation_network_peers
    FOR UPDATE TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

-- ---------------------------------------------------------------------
-- 4. Additive columns on tenant_recommendations
-- ---------------------------------------------------------------------
-- `subscribe_url` is the optional one-click subscribe URL the renderer
-- uses on the CTA button when it differs from `to_url` (which always
-- remains the canonical landing surface).
--
-- `discovered_at` is the timestamp the cross-tenant discovery job
-- populated `to_tenant_id` — gives the slideover an "auto-upgraded
-- N days ago" badge.
ALTER TABLE tenant_recommendations
    ADD COLUMN IF NOT EXISTS subscribe_url   text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS discovered_at   timestamptz NULL;

COMMIT;
