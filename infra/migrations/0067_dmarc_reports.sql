-- 0034_dmarc_reports.sql
--
-- Persisted DMARC aggregate ("rua") reports parsed by the deliverability
-- service. Tenant-scoped via the domain owner mapping; we keep tenant_id
-- denormalised onto the report row for query simplicity.

BEGIN;

CREATE TABLE dmarc_reports (
    id           bigserial PRIMARY KEY,
    tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    org_name     text NOT NULL,
    org_email    text NOT NULL DEFAULT '',
    report_id    text NOT NULL,
    domain       text NOT NULL,
    policy_p     text NOT NULL DEFAULT '',
    policy_pct   text NOT NULL DEFAULT '',
    date_begin   timestamptz NOT NULL,
    date_end     timestamptz NOT NULL,
    pass_count   int NOT NULL DEFAULT 0,
    fail_count   int NOT NULL DEFAULT 0,
    raw          jsonb NOT NULL DEFAULT '{}'::jsonb,
    received_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, org_name, report_id)
);

CREATE INDEX dmarc_reports_tenant_domain_idx
    ON dmarc_reports (tenant_id, domain, date_end DESC);

GRANT SELECT, INSERT ON dmarc_reports TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE dmarc_reports_id_seq TO postwave_app;

ALTER TABLE dmarc_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE dmarc_reports FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON dmarc_reports
    AS RESTRICTIVE
    FOR ALL
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

COMMIT;
