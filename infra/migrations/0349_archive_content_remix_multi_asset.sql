-- 0349_archive_content_remix_multi_asset.sql
--
-- Phase 3 XL feature `archive-content-remix-multi-asset`. HubSpot Content
-- Remix takes up to 6 source assets (a campaign, an archive page, a long-
-- form blog) and emits up to 6 *derived* assets across formats (social
-- post, podcast episode, SMS, email follow-up, ...). Substack and beehiiv
-- ship narrower versions of the same idea (AI clips, AI translator). This
-- migration lays down the persistence layer; the worker/handlers are
-- scaffolded under apps/api/internal/archive_content_remix/.
--
-- Tables
--   content_remix_jobs           one row per "remix request" (campaign +
--                                selected derived-asset kinds). Job is
--                                the top-level concept the user sees.
--   content_remix_assets         one row per *derived* asset (queued,
--                                generating, ready, failed). FK to job.
--   content_remix_tts_jobs       TTS-specific child rows for podcast
--                                kinds — keeps voice / duration / vendor
--                                metadata separate from the generic
--                                asset row so TTS provider can swap
--                                without schema churn.
--
-- Design notes
--   * `kind` on content_remix_assets is an open enum encoded as text so
--     we can ship new formats (twitter_thread, linkedin_carousel,
--     instagram_caption, ...) without a migration each time. The Go
--     layer holds the canonical enum.
--   * `status` is a small state machine: pending → generating → ready
--     | failed. The worker takes pending rows under FOR UPDATE SKIP
--     LOCKED (same pattern as outbox worker).
--   * `source_campaign_id` is the *primary* anchor. A future iteration
--     will add a `content_remix_sources` join table so a job can
--     reference up to N source assets (HubSpot allows 6). For v1 we
--     wire a single source — the schema reserves space via the
--     `extra_source_ids uuid[]` column so the multi-source feature
--     doesn't need a new migration.
--   * Tenant scoping: every table FKs to tenants(id) ON DELETE CASCADE
--     and enforces RLS with the standard NULLIF GUC idiom.
--   * Indexes:
--       * (tenant_id, created_at DESC) for the job-list view
--       * (status, scheduled_at) for the worker claim query
--       * (source_campaign_id) for the "show me all remixes of this
--         campaign" affordance on the campaign detail view
--   * Derived assets save as drafts (status='ready', draft_campaign_id
--     populated for email/sms kinds; for social/podcast a JSON payload
--     is the deliverable). The "save as draft" path is wired into the
--     campaigns table — for non-email kinds the column stays NULL.

BEGIN;

-- Parent job. One row per user-initiated remix request.
CREATE TABLE IF NOT EXISTS content_remix_jobs (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- Primary anchor: the campaign whose body/subject we remix.
    source_campaign_id  uuid REFERENCES campaigns(id) ON DELETE SET NULL,
    -- Reserved for future multi-source remixes (HubSpot allows up to 6
    -- source assets). Empty array on v1.
    extra_source_ids    uuid[] NOT NULL DEFAULT '{}',
    -- Operator-facing label ("Spring launch → social + podcast").
    name                text NOT NULL,
    -- Operator brief that the LLM uses to bias all derived assets.
    brief               text NOT NULL DEFAULT '',
    -- Lifecycle: pending → generating → completed | failed | cancelled.
    -- We track completion at the job level via a sweep that flips to
    -- 'completed' once every child asset is ready/failed.
    status              text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','generating','completed','failed','cancelled')),
    -- Optional error code surfaced when the entire job aborts before
    -- any asset is produced (e.g. source_campaign deleted).
    last_error          text,
    requested_kinds     text[] NOT NULL DEFAULT '{}',
    -- Who triggered the remix (user id, api key id, or 'system').
    actor               text NOT NULL DEFAULT 'system',
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    completed_at        timestamptz
);

CREATE INDEX IF NOT EXISTS idx_content_remix_jobs_tenant_created
    ON content_remix_jobs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_remix_jobs_source
    ON content_remix_jobs (source_campaign_id);
CREATE INDEX IF NOT EXISTS idx_content_remix_jobs_status
    ON content_remix_jobs (status) WHERE status IN ('pending','generating');

GRANT SELECT, INSERT, UPDATE, DELETE ON content_remix_jobs TO postwave_app;

ALTER TABLE content_remix_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_remix_jobs FORCE  ROW LEVEL SECURITY;

CREATE POLICY content_remix_jobs_select ON content_remix_jobs
    FOR SELECT TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.outbox_worker', true) = 'true');
CREATE POLICY content_remix_jobs_insert ON content_remix_jobs
    FOR INSERT TO postwave_app
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
                OR current_setting('app.outbox_worker', true) = 'true');
CREATE POLICY content_remix_jobs_update ON content_remix_jobs
    FOR UPDATE TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
                OR current_setting('app.outbox_worker', true) = 'true');
CREATE POLICY content_remix_jobs_delete ON content_remix_jobs
    FOR DELETE TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.outbox_worker', true) = 'true');

-- One row per *derived* asset (the things the worker generates).
CREATE TABLE IF NOT EXISTS content_remix_assets (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    job_id              uuid NOT NULL REFERENCES content_remix_jobs(id) ON DELETE CASCADE,
    -- Free-form kind: 'email_followup', 'sms_blast', 'twitter_thread',
    -- 'linkedin_post', 'instagram_caption', 'podcast_episode',
    -- 'blog_excerpt', ... The Go layer holds the canonical enum.
    kind                text NOT NULL,
    -- Lifecycle: pending → generating → ready | failed.
    status              text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','generating','ready','failed')),
    -- The generated payload, kind-specific.
    --   email_followup → {subject, body_html, body_text, preview_text}
    --   sms_blast      → {body, segments_estimate}
    --   twitter_thread → {tweets: ["...","..."]}
    --   podcast_episode→ {script, audio_url, duration_seconds, voice}
    --   blog_excerpt   → {title, body_md}
    payload             jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- For email_followup / sms_blast we save the derived asset as a
    -- DRAFT campaign so the operator can edit + schedule. Null for
    -- non-campaign kinds.
    draft_campaign_id   uuid REFERENCES campaigns(id) ON DELETE SET NULL,
    -- Per-asset retry counter — bounded by the worker (default 3).
    attempts            integer NOT NULL DEFAULT 0,
    last_error          text,
    -- The worker leases pending rows via UPDATE ... RETURNING and sets
    -- this so a crashed worker doesn't strand the row forever.
    leased_until        timestamptz,
    -- Scheduled_at lets us implement back-off without a separate table:
    -- a failed row gets rescheduled forward and is invisible to the
    -- claim query until the timestamp passes.
    scheduled_at        timestamptz NOT NULL DEFAULT now(),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    completed_at        timestamptz
);

CREATE INDEX IF NOT EXISTS idx_content_remix_assets_job
    ON content_remix_assets (job_id);
CREATE INDEX IF NOT EXISTS idx_content_remix_assets_tenant_created
    ON content_remix_assets (tenant_id, created_at DESC);
-- Worker claim index: (status, scheduled_at) lets the worker SELECT ...
-- FOR UPDATE SKIP LOCKED rows that are due. Partial index keeps the
-- working set small.
CREATE INDEX IF NOT EXISTS idx_content_remix_assets_claim
    ON content_remix_assets (scheduled_at)
    WHERE status = 'pending';

GRANT SELECT, INSERT, UPDATE, DELETE ON content_remix_assets TO postwave_app;

ALTER TABLE content_remix_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_remix_assets FORCE  ROW LEVEL SECURITY;

CREATE POLICY content_remix_assets_select ON content_remix_assets
    FOR SELECT TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.outbox_worker', true) = 'true');
CREATE POLICY content_remix_assets_insert ON content_remix_assets
    FOR INSERT TO postwave_app
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
                OR current_setting('app.outbox_worker', true) = 'true');
CREATE POLICY content_remix_assets_update ON content_remix_assets
    FOR UPDATE TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
                OR current_setting('app.outbox_worker', true) = 'true');
CREATE POLICY content_remix_assets_delete ON content_remix_assets
    FOR DELETE TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.outbox_worker', true) = 'true');

-- TTS-specific child rows. Kept separate so the TTS vendor (ElevenLabs,
-- OpenAI tts-1, Azure Speech, Play.ht, ...) can swap by changing only
-- this table; the asset row stays vendor-agnostic.
CREATE TABLE IF NOT EXISTS content_remix_tts_jobs (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    asset_id            uuid NOT NULL UNIQUE REFERENCES content_remix_assets(id) ON DELETE CASCADE,
    -- One of the six named voices. The Go layer holds the canonical
    -- enum mapping to vendor voice IDs.
    voice               text NOT NULL,
    -- Vendor identifier the worker used (elevenlabs, openai-tts, azure,
    -- playht, ...) and the vendor's job/request id for retries +
    -- support escalation.
    vendor              text NOT NULL DEFAULT 'stub',
    vendor_job_id       text,
    -- Where the rendered MP3 lives once the vendor returns it. We store
    -- the *internal* asset key (assets table) rather than a public URL
    -- so signed-URL minting stays cheap.
    audio_asset_id      uuid,
    -- Final duration in milliseconds; populated post-render.
    duration_ms         integer,
    -- Lifecycle: queued → submitted → rendering → ready | failed.
    status              text NOT NULL DEFAULT 'queued'
                          CHECK (status IN ('queued','submitted','rendering','ready','failed')),
    last_error          text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    completed_at        timestamptz
);

CREATE INDEX IF NOT EXISTS idx_content_remix_tts_jobs_tenant
    ON content_remix_tts_jobs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_remix_tts_jobs_status
    ON content_remix_tts_jobs (status)
    WHERE status IN ('queued','submitted','rendering');

GRANT SELECT, INSERT, UPDATE, DELETE ON content_remix_tts_jobs TO postwave_app;

ALTER TABLE content_remix_tts_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_remix_tts_jobs FORCE  ROW LEVEL SECURITY;

CREATE POLICY content_remix_tts_jobs_select ON content_remix_tts_jobs
    FOR SELECT TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.outbox_worker', true) = 'true');
CREATE POLICY content_remix_tts_jobs_insert ON content_remix_tts_jobs
    FOR INSERT TO postwave_app
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
                OR current_setting('app.outbox_worker', true) = 'true');
CREATE POLICY content_remix_tts_jobs_update ON content_remix_tts_jobs
    FOR UPDATE TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
                OR current_setting('app.outbox_worker', true) = 'true');
CREATE POLICY content_remix_tts_jobs_delete ON content_remix_tts_jobs
    FOR DELETE TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.outbox_worker', true) = 'true');

COMMIT;
