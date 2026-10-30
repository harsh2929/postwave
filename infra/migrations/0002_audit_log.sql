-- 0002_audit_log.sql
--
-- Append-only audit trail. Every mutating request should write at least one
-- row here. The middleware writes a best-effort fallback row; handlers are
-- encouraged to call `db.Audit()` directly with a precise action label.

BEGIN;

CREATE TABLE audit_log (
    id              bigserial PRIMARY KEY,
    tenant_id       uuid NOT NULL,
    user_id         uuid,
    action          text NOT NULL,           -- e.g. 'subscriber.create', 'migration.start'
    resource_type   text,
    resource_id     text,
    metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
    ip              inet,
    user_agent      text,
    at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_tenant_at_idx        ON audit_log (tenant_id, at DESC);
CREATE INDEX audit_log_tenant_action_at_idx ON audit_log (tenant_id, action, at DESC);

GRANT SELECT, INSERT ON audit_log TO postwave_app;
GRANT USAGE, SELECT  ON SEQUENCE audit_log_id_seq TO postwave_app;

-- RLS: scope to the per-transaction tenant id. We FORCE so the owner role
-- cannot accidentally read across tenants either.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON audit_log
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
