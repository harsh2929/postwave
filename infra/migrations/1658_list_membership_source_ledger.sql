-- 1658_list_membership_source_ledger.sql
-- Multi-owner ledger for native list memberships plus CRM scan state.

BEGIN;

CREATE TABLE IF NOT EXISTS list_subscriber_sources (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    list_id               uuid NOT NULL,
    subscriber_id         uuid NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    email                 citext,
    source                text NOT NULL,
    owner_key             text NOT NULL,
    provider              text NOT NULL DEFAULT '',
    integration_id        uuid REFERENCES crm_integrations(id) ON DELETE CASCADE,
    provider_segment_type text NOT NULL DEFAULT '',
    provider_segment_id   text NOT NULL DEFAULT '',
    provider_member_id    text NOT NULL DEFAULT '',
    source_ref            text NOT NULL DEFAULT '',
    first_seen_at         timestamptz NOT NULL DEFAULT now(),
    last_seen_at          timestamptz NOT NULL DEFAULT now(),
    removed_at            timestamptz,
    metadata              jsonb NOT NULL DEFAULT '{}',
    CONSTRAINT list_subscriber_sources_source_check
      CHECK (source IN ('form','api','csv','integration','admin','migration','listmonk_event')),
    CONSTRAINT list_subscriber_sources_owner_unique
      UNIQUE (tenant_id, list_id, subscriber_id, owner_key)
);

CREATE INDEX IF NOT EXISTS list_subscriber_sources_active_membership_idx
    ON list_subscriber_sources (tenant_id, list_id, subscriber_id)
    WHERE removed_at IS NULL;

CREATE INDEX IF NOT EXISTS list_subscriber_sources_crm_owner_idx
    ON list_subscriber_sources (
        tenant_id, integration_id, provider, provider_segment_type,
        provider_segment_id, list_id, last_seen_at
    )
    WHERE removed_at IS NULL AND source = 'integration';

CREATE TABLE IF NOT EXISTS crm_list_membership_scans (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    integration_id        uuid NOT NULL REFERENCES crm_integrations(id) ON DELETE CASCADE,
    provider              text NOT NULL,
    provider_segment_type text NOT NULL,
    provider_segment_id   text NOT NULL,
    native_list_id        uuid NOT NULL,
    status                text NOT NULL DEFAULT 'running',
    started_at            timestamptz NOT NULL DEFAULT now(),
    completed_at          timestamptz,
    members_seen          integer NOT NULL DEFAULT 0,
    members_repaired      integer NOT NULL DEFAULT 0,
    metadata              jsonb NOT NULL DEFAULT '{}',
    updated_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT crm_list_membership_scans_status_check
      CHECK (status IN ('running', 'completed', 'failed', 'abandoned')),
    CONSTRAINT crm_list_membership_scans_scope_unique
      UNIQUE (
        tenant_id, integration_id, provider, provider_segment_type,
        provider_segment_id, native_list_id
      )
);

CREATE INDEX IF NOT EXISTS crm_list_membership_scans_tenant_idx
    ON crm_list_membership_scans (tenant_id, integration_id, updated_at DESC);

INSERT INTO list_subscriber_sources (
    tenant_id, list_id, subscriber_id, email, source, owner_key,
    first_seen_at, last_seen_at, removed_at, metadata
)
SELECT ls.tenant_id,
       ls.list_id,
       ls.subscriber_id,
       ls.email,
       COALESCE(NULLIF(ls.source, ''), 'migration'),
       'legacy:' || COALESCE(NULLIF(ls.source, ''), 'migration'),
       COALESCE(ls.added_at, now()),
       COALESCE(ls.added_at, now()),
       ls.removed_at,
       jsonb_build_object('legacy_list_subscribers_source', COALESCE(NULLIF(ls.source, ''), 'migration'))
  FROM list_subscribers ls
ON CONFLICT (tenant_id, list_id, subscriber_id, owner_key) DO NOTHING;

GRANT SELECT, INSERT, UPDATE, DELETE ON list_subscriber_sources TO postwave_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON crm_list_membership_scans TO postwave_app;

ALTER TABLE list_subscriber_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE list_subscriber_sources FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON list_subscriber_sources;
CREATE POLICY tenant_isolation ON list_subscriber_sources
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE crm_list_membership_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_list_membership_scans FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON crm_list_membership_scans;
CREATE POLICY tenant_isolation ON crm_list_membership_scans
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
