-- 1878_editor_checkpoints.sql
--
-- Server-backed draft checkpoints: resume an unfinished edit on another device.
--
-- `activity_cursor` (migration 1777) already answers "what was I looking at" —
-- it stores ONE (entity_key, entity_id) reference per user, deliberately no
-- content. That is enough to offer "Continue — <entity>" and nothing else: open
-- the campaign on your phone and the half-written subject line from your laptop
-- is not there, because it never left the laptop.
--
-- This stores the in-progress CONTENT, so the resume is a resume rather than a
-- link.
--
-- WHY PER (USER, ENTITY) AND NOT PER ENTITY. A checkpoint is one person's
-- unsaved work, not a shared state. Two people editing the same campaign have
-- two different half-finished thoughts, and merging them — or letting one
-- overwrite the other — would be worse than either losing theirs. The editing
-- lease (migration 1877) is what stops them colliding on the SAVED record; this
-- keeps their drafts apart while they do.
--
-- WHY A VERSION AND NOT LAST-WRITE-WINS. The same person on two devices is the
-- normal case here, and it is exactly when last-write-wins destroys work: the
-- laptop autosaves a stale buffer three seconds after the phone saved a newer
-- one. The version makes the older write fail so the client can ask.
--
-- CONTENT IS CUSTOMER DATA. Unlike the cursor, this holds real text, so it is
-- RLS-isolated per tenant, force-enabled, and swept: a checkpoint is a
-- convenience with a short useful life, and keeping unfinished drafts forever
-- turns it into an undeclared archive of things people chose not to save.

BEGIN;

CREATE TABLE IF NOT EXISTS editor_checkpoints (
    tenant_id  uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id    uuid        NOT NULL,
    -- @postwave/route-map entity key, e.g. 'campaign'. Not FK'd: the route map
    -- is a client-side registry and this table must not need a migration every
    -- time a surface becomes resumable.
    entity_key text        NOT NULL,
    entity_id  text        NOT NULL,
    content    jsonb       NOT NULL,
    -- Bumped on every successful save. A write carrying an older version is
    -- refused rather than applied.
    version    bigint      NOT NULL DEFAULT 1,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, user_id, entity_key, entity_id),
    CONSTRAINT editor_checkpoints_entity_key_len CHECK (char_length(entity_key) BETWEEN 1 AND 64),
    CONSTRAINT editor_checkpoints_entity_id_len  CHECK (char_length(entity_id) BETWEEN 1 AND 128)
);

COMMENT ON TABLE editor_checkpoints IS
    'One in-progress draft per (user, entity). Complements activity_cursor, '
    'which stores only a reference: this stores the content so a resume on '
    'another device restores the half-written edit rather than an empty form.';

-- The sweeper reads by age; the reader reads by primary key.
CREATE INDEX IF NOT EXISTS editor_checkpoints_stale_idx
    ON editor_checkpoints (updated_at);

ALTER TABLE editor_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE editor_checkpoints FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON editor_checkpoints;
CREATE POLICY tenant_isolation ON editor_checkpoints
    AS RESTRICTIVE
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON editor_checkpoints;
CREATE POLICY tenant_visible ON editor_checkpoints
    FOR ALL TO postwave_app
    USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON editor_checkpoints TO postwave_app;

COMMIT;
