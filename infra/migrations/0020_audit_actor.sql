-- 0020_audit_actor.sql
--
-- Augments audit_log with the acting identity's type (human / agent / system)
-- and a free-form label. Human actors keep the legacy default; agent rows are
-- written by the apikey middleware when a key with actor_type='agent' fires.

BEGIN;

ALTER TABLE audit_log
    ADD COLUMN actor_type  text NOT NULL DEFAULT 'human'
        CHECK (actor_type IN ('human', 'agent', 'system')),
    ADD COLUMN actor_label text;

CREATE INDEX audit_log_tenant_actor_at_idx
    ON audit_log (tenant_id, actor_type, at DESC);

COMMIT;
