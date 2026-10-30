-- 0040_voice_sequence_jobs.sql
--
-- Pillar 3 (Voice) sequence-generation job persistence.
--
-- Closes the synchronous-handler limitation in
-- services/voice/internal/handlers/sequences.go: today the
-- POST /v1/voice/sequences endpoint blocks 10-30s while Claude
-- generates each email. iOS backgrounds requests at ~30s, mobile
-- networks bounce, and the user has no progress signal.
--
-- Same shape as voice_ingest_jobs (0037): a row tracks one generation
-- run from pending → running → succeeded / failed, with the resulting
-- sequence_id stamped on success so the polling endpoint can return
-- both the job state AND a pointer to the generated rows.
--
-- Design notes:
--
--   * sequence_id is nullable: NULL while pending/running, populated
--     on succeeded. The CHECK constraint enforces "succeeded → has
--     sequence_id" so a half-baked succeeded row can't slip past.
--
--   * regeneration jobs use the same table — RegenerateRequest jobs
--     reference an existing sequence_id, but the row also carries
--     email_position. That field is NULL for first-generation jobs.
--
--   * RLS + force RLS, same pattern as the rest of the voice tables.
--     The cross-tenant outbox-worker policy is NOT needed here because
--     this table is only written under tenant context (the voice
--     service's own goroutine sets app.tenant_id when it dispatches).

BEGIN;

CREATE TABLE voice_sequence_jobs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- For first-generation jobs: NULL until succeeded, then points at
    -- the produced sequence row. For regeneration jobs: pre-set to the
    -- target sequence_id at create time (the regenerated email lands
    -- back inside the same sequence row).
    sequence_id     uuid REFERENCES voice_sequences(id) ON DELETE SET NULL,
    -- For regeneration jobs only: which 0-indexed email to regenerate.
    -- NULL for first-generation jobs.
    email_position  int,
    -- Snapshot of the GenerateRequest / RegenerateRequest body so the
    -- worker can pick up the job after a restart. We don't carry this
    -- on the asynq queue because long Claude runs blow past asynq's
    -- visibility timeout.
    request         jsonb NOT NULL DEFAULT '{}'::jsonb,
    status          text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','running','succeeded','failed')),
    error_message   text,
    started_at      timestamptz,
    finished_at     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    -- "succeeded → has sequence_id". Lets the polling endpoint return a
    -- usable result whenever it sees status='succeeded' without an
    -- additional null-check in the application layer.
    CHECK (status <> 'succeeded' OR sequence_id IS NOT NULL)
);

CREATE INDEX voice_sequence_jobs_tenant_status_idx
    ON voice_sequence_jobs (tenant_id, status, created_at DESC);

CREATE INDEX voice_sequence_jobs_sequence_idx
    ON voice_sequence_jobs (sequence_id)
    WHERE sequence_id IS NOT NULL;

CREATE TRIGGER voice_sequence_jobs_set_updated_at
    BEFORE UPDATE ON voice_sequence_jobs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON voice_sequence_jobs TO postwave_app;

ALTER TABLE voice_sequence_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_sequence_jobs FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON voice_sequence_jobs
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
