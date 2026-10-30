-- Durable intent-before-mutation ledger for migration Listmonk writes, plus
-- bounded retention for subscriber-level verifier evidence.
-- rollback-strategy: expand-contract - older application releases ignore the
-- additive intent table and verifier expiry column. Preserve both on an
-- application rollback so crash-window ownership evidence is never erased.
-- rollback-details: remove only after every migration job is outside its
-- rollback window and no active application version reads these structures.

BEGIN;

CREATE TABLE migration_external_write_intents (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    job_id              uuid NOT NULL,
    resource_type       text NOT NULL CHECK (resource_type IN ('subscriber', 'list', 'template')),
    intent_key          text NOT NULL,
    source_platform     text NOT NULL,
    source_id           text NOT NULL DEFAULT '',
    destination_type    text NOT NULL CHECK (destination_type IN ('listmonk_subscriber', 'listmonk_list', 'listmonk_template')),
    lookup_key          text NOT NULL,
    payload             jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT migration_external_write_intents_tenant_job_fk
        FOREIGN KEY (tenant_id, job_id)
        REFERENCES migration_jobs (tenant_id, id)
        ON DELETE CASCADE,
    CONSTRAINT migration_external_write_intents_identity_unique
        UNIQUE (tenant_id, job_id, resource_type, intent_key),
    CONSTRAINT migration_external_write_intents_destination_pair CHECK (
        (resource_type = 'subscriber' AND destination_type = 'listmonk_subscriber') OR
        (resource_type = 'list' AND destination_type = 'listmonk_list') OR
        (resource_type = 'template' AND destination_type = 'listmonk_template')
    )
);

CREATE INDEX migration_external_write_intents_job_idx
    ON migration_external_write_intents (tenant_id, job_id, resource_type, created_at, id);

ALTER TABLE migration_external_write_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_external_write_intents FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON migration_external_write_intents
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Intent evidence is immutable. The application may append, reconcile/read,
-- and delete an exact row after its normal ledger commit, but never rewrite a
-- crash-window payload in place.
GRANT SELECT, INSERT, DELETE ON migration_external_write_intents TO postwave_app;

-- Raw subscriber JSON is needed only while a verification run is resumable.
-- Terminal handlers erase it immediately; this expiry is the bounded fallback
-- for a crashed worker that never reaches terminal cleanup.
ALTER TABLE migration_verifier_subscriber_observations
    ADD COLUMN expires_at timestamptz;

UPDATE migration_verifier_subscriber_observations
   SET expires_at = created_at + interval '24 hours'
 WHERE expires_at IS NULL;

ALTER TABLE migration_verifier_subscriber_observations
    ALTER COLUMN expires_at SET DEFAULT (now() + interval '24 hours'),
    ALTER COLUMN expires_at SET NOT NULL;

-- The application may append immutable observations and physically erase
-- them, but it must not rewrite raw evidence or extend its expiry. Column-level
-- INSERT excludes both server-owned timestamps.
REVOKE INSERT, UPDATE ON migration_verifier_subscriber_observations FROM postwave_app;
GRANT INSERT (tenant_id, job_id, observation_key, email, subscriber)
    ON migration_verifier_subscriber_observations TO postwave_app;

COMMIT;
