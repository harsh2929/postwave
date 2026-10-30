-- Tenant-safe subscriber/list migration materialization and retry identity.
-- rollback-strategy: expand-contract - older application releases ignore the
-- additive observation table and indexes; keep the widened source-state and
-- resource-type checks applied during an application rollback.
-- rollback-details: restore from the preflight backup only if validation finds
-- corrupted ownership data; otherwise leave the tenant/FK integrity repair in
-- place and redeploy the previous compatible application image.

BEGIN;

ALTER TABLE migration_imported_resources
    DROP CONSTRAINT IF EXISTS migration_imported_resources_resource_type_check;

ALTER TABLE migration_imported_resources
    ADD CONSTRAINT migration_imported_resources_resource_type_check
    CHECK (resource_type IN (
        'subscriber',
        'list',
        'segment',
        'automation',
        'campaign_archive',
        'campaign',
        'campaign_report_event',
        'template',
        'paid_subscription',
        'source_archive',
        'automation_journey',
		'popup_form',
		'landing_page',
		'commerce_integration'
	)) NOT VALID;

COMMENT ON COLUMN migration_imported_resources.destination_metadata IS
    'Rollback contract: operation=create|update plus destination before-images for updates; destructive rollback refuses rows without a safe marker.';

-- Mailchimp's member endpoint also returns pending and transactional. Preserve
-- those exact source states while the canonical status remains conservatively
-- unconfirmed/disabled.
ALTER TABLE subscribers
    DROP CONSTRAINT IF EXISTS subscribers_mailchimp_status_check;

ALTER TABLE subscribers
    ADD CONSTRAINT subscribers_mailchimp_status_check
	CHECK (mailchimp_status IN (
		'subscribed', 'unsubscribed', 'non_subscribed', 'cleaned',
		'pending', 'transactional', 'archived', 'deleted'
	)) NOT VALID;

-- Subscriber-level verifier evidence is linear in contact count and must not
-- be serialized into migration_jobs.cursor on every page. This tenant/job
-- table makes page retries exact without quadratic job-row amplification.
CREATE TABLE IF NOT EXISTS migration_verifier_subscriber_observations (
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    job_id          uuid NOT NULL,
    observation_key text NOT NULL,
    email           citext NOT NULL,
    subscriber      jsonb NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, job_id, observation_key)
);

CREATE INDEX IF NOT EXISTS migration_verifier_subscriber_observations_email_idx
    ON migration_verifier_subscriber_observations (tenant_id, job_id, email);

-- Do not expose writes until the tenant/job ownership FK is installed. The
-- REVOKE also closes the gap on a retry from an earlier partial 1736.
REVOKE INSERT, UPDATE, DELETE ON migration_verifier_subscriber_observations FROM postwave_app;
GRANT SELECT ON migration_verifier_subscriber_observations TO postwave_app;

ALTER TABLE migration_verifier_subscriber_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_verifier_subscriber_observations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON migration_verifier_subscriber_observations;
CREATE POLICY tenant_isolation ON migration_verifier_subscriber_observations
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;

-- NOT VALID keeps the short DDL transaction from scanning large subscriber
-- and rollback-ledger tables under ACCESS EXCLUSIVE locks. New writes are
-- already checked; validate existing rows with the lighter validation lock.
ALTER TABLE migration_imported_resources
    VALIDATE CONSTRAINT migration_imported_resources_resource_type_check;

ALTER TABLE subscribers
    VALIDATE CONSTRAINT subscribers_mailchimp_status_check;

-- The observation row's tenant and job must be one ownership identity. Two
-- independent foreign keys would allow tenant A to reference tenant B's job
-- when the caller knows its UUID (referential checks are not an RLS boundary).
-- Build the required referenced key without blocking migration_jobs writes.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS migration_jobs_tenant_id_id_unique
    ON migration_jobs (tenant_id, id);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_class c
		  JOIN pg_namespace n ON n.oid = c.relnamespace
		  JOIN pg_index i ON i.indexrelid = c.oid
		  JOIN pg_am am ON am.oid = c.relam
		 WHERE n.nspname = 'public'
		   AND c.relname = 'migration_jobs_tenant_id_id_unique'
		   AND i.indrelid = 'public.migration_jobs'::regclass
		   AND i.indisvalid
		   AND i.indisready
		   AND i.indisunique
		   AND am.amname = 'btree'
		   AND i.indnkeyatts = 2
		   AND i.indnatts = 2
		   AND i.indexprs IS NULL
		   AND i.indpred IS NULL
		   AND (
			SELECT array_agg(a.attname ORDER BY key_column.ordinality)
			  FROM unnest(i.indkey::smallint[]) WITH ORDINALITY AS key_column(attnum, ordinality)
			  JOIN pg_attribute a
				ON a.attrelid = i.indrelid
			   AND a.attnum = key_column.attnum
			 WHERE key_column.ordinality <= i.indnkeyatts
		   ) = ARRAY['tenant_id', 'id']::name[]
	) THEN
		RAISE EXCEPTION
			'migration_jobs_tenant_id_id_unique is absent, invalid, or has the wrong table/key definition; DROP INDEX CONCURRENTLY IF EXISTS migration_jobs_tenant_id_id_unique and retry';
	END IF;
END
$$;

BEGIN;

-- Existing central migration ledgers also inherited independent tenant/job
-- FKs from 0032. Referential checks are not filtered by RLS, so reject any
-- historical cross-tenant ownership before replacing all three constraints.
DO $$
DECLARE
    mismatch record;
BEGIN
    SELECT ledger, tenant_id, job_id
      INTO mismatch
      FROM (
        SELECT 'migration_imported_resources'::text AS ledger, r.tenant_id, r.job_id
          FROM migration_imported_resources r
          JOIN migration_jobs j ON j.id = r.job_id
         WHERE j.tenant_id <> r.tenant_id
        UNION ALL
        SELECT 'migration_paid_subscriptions'::text, p.tenant_id, p.job_id
          FROM migration_paid_subscriptions p
          JOIN migration_jobs j ON j.id = p.job_id
         WHERE j.tenant_id <> p.tenant_id
      ) ownership_mismatch
     LIMIT 1;

    IF FOUND THEN
        RAISE EXCEPTION
            'cross-tenant migration ledger ownership exists in % for tenant % and job %; reconcile the corrupt row before retrying 1736',
            mismatch.ledger, mismatch.tenant_id, mismatch.job_id;
    END IF;
END
$$;

-- A retry from an earlier partial 1736 may still have the original independent
-- job_id foreign keys. Replace them with tenant-bound ownership constraints.
ALTER TABLE migration_verifier_subscriber_observations
	DROP CONSTRAINT IF EXISTS migration_verifier_subscriber_observations_job_id_fkey;

ALTER TABLE migration_verifier_subscriber_observations
    DROP CONSTRAINT IF EXISTS migration_verifier_subscriber_observations_tenant_job_fk;

ALTER TABLE migration_verifier_subscriber_observations
    ADD CONSTRAINT migration_verifier_subscriber_observations_tenant_job_fk
    FOREIGN KEY (tenant_id, job_id)
    REFERENCES migration_jobs (tenant_id, id)
	ON DELETE CASCADE
	NOT VALID;

ALTER TABLE migration_imported_resources
    DROP CONSTRAINT IF EXISTS migration_imported_resources_job_id_fkey;

ALTER TABLE migration_imported_resources
    DROP CONSTRAINT IF EXISTS migration_imported_resources_tenant_job_fk;

ALTER TABLE migration_imported_resources
    ADD CONSTRAINT migration_imported_resources_tenant_job_fk
    FOREIGN KEY (tenant_id, job_id)
    REFERENCES migration_jobs (tenant_id, id)
    ON DELETE CASCADE
    NOT VALID;

ALTER TABLE migration_paid_subscriptions
    DROP CONSTRAINT IF EXISTS migration_paid_subscriptions_job_id_fkey;

ALTER TABLE migration_paid_subscriptions
    DROP CONSTRAINT IF EXISTS migration_paid_subscriptions_tenant_job_fk;

ALTER TABLE migration_paid_subscriptions
    ADD CONSTRAINT migration_paid_subscriptions_tenant_job_fk
    FOREIGN KEY (tenant_id, job_id)
    REFERENCES migration_jobs (tenant_id, id)
    ON DELETE CASCADE
    NOT VALID;

GRANT SELECT, INSERT, UPDATE, DELETE ON migration_verifier_subscriber_observations TO postwave_app;

-- Subscriber rollback now locks tag-membership rows while comparing the
-- recorded after-image. PostgreSQL requires UPDATE privilege for SELECT ...
-- FOR UPDATE even though the lock path does not mutate the row. Keep the
-- grant column-scoped; tenant RLS remains forced on subscriber_tags.
GRANT UPDATE (tag_id) ON subscriber_tags TO postwave_app;

COMMIT;

ALTER TABLE migration_verifier_subscriber_observations
	VALIDATE CONSTRAINT migration_verifier_subscriber_observations_tenant_job_fk;

ALTER TABLE migration_imported_resources
    VALIDATE CONSTRAINT migration_imported_resources_tenant_job_fk;

ALTER TABLE migration_paid_subscriptions
    VALIDATE CONSTRAINT migration_paid_subscriptions_tenant_job_fk;

-- Create-only APIs (Listmonk lists/templates) use this source identity to
-- recover after a worker restart without creating a duplicate destination.
-- This table can already be large on an upgraded tenant, so build the index
-- without holding a write-blocking table lock. IF NOT EXISTS makes a runner
-- retry safe when the index completed but the migration ledger write did not.
DO $$
DECLARE
    duplicate_identity record;
BEGIN
    SELECT tenant_id, job_id, resource_type, source_platform, source_id
      INTO duplicate_identity
      FROM migration_imported_resources
     WHERE source_id IS NOT NULL
       AND rolled_back_at IS NULL
       AND resource_type IN ('list', 'template')
     GROUP BY tenant_id, job_id, resource_type, source_platform, source_id
    HAVING count(*) > 1
     LIMIT 1;

    IF FOUND THEN
        RAISE EXCEPTION
            'duplicate active list/template source identity exists for tenant %, job %, type %, platform %, source %; reconcile duplicates before retrying 1736',
            duplicate_identity.tenant_id,
            duplicate_identity.job_id,
            duplicate_identity.resource_type,
            duplicate_identity.source_platform,
            duplicate_identity.source_id;
    END IF;
END
$$;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS migration_imported_resources_active_source_unique
    ON migration_imported_resources
       (tenant_id, job_id, resource_type, source_platform, source_id)
    WHERE source_id IS NOT NULL
      AND rolled_back_at IS NULL
      AND resource_type IN ('list', 'template');

-- A failed concurrent build can leave an invalid index shell which IF NOT
-- EXISTS would otherwise mistake for an enforceable uniqueness guarantee.
-- Fail closed with an operator-actionable error instead of recording 1736.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_class c
		  JOIN pg_namespace n ON n.oid = c.relnamespace
		  JOIN pg_index i ON i.indexrelid = c.oid
		  JOIN pg_am am ON am.oid = c.relam
		 WHERE n.nspname = 'public'
		   AND c.relname = 'migration_imported_resources_active_source_unique'
		   AND i.indrelid = 'public.migration_imported_resources'::regclass
		   AND i.indisvalid
		   AND i.indisready
		   AND i.indisunique
		   AND am.amname = 'btree'
		   AND i.indnkeyatts = 5
		   AND i.indnatts = 5
		   AND i.indexprs IS NULL
		   AND (
			SELECT array_agg(a.attname ORDER BY key_column.ordinality)
			  FROM unnest(i.indkey::smallint[]) WITH ORDINALITY AS key_column(attnum, ordinality)
			  JOIN pg_attribute a
				ON a.attrelid = i.indrelid
			   AND a.attnum = key_column.attnum
			 WHERE key_column.ordinality <= i.indnkeyatts
		   ) = ARRAY['tenant_id', 'job_id', 'resource_type', 'source_platform', 'source_id']::name[]
		   AND pg_get_expr(i.indpred, i.indrelid) =
		       '((source_id IS NOT NULL) AND (rolled_back_at IS NULL) AND (resource_type = ANY (ARRAY[''list''::text, ''template''::text])))'
	) THEN
		RAISE EXCEPTION
			'migration_imported_resources_active_source_unique is absent, invalid, or has the wrong table/key/predicate definition; DROP INDEX CONCURRENTLY IF EXISTS migration_imported_resources_active_source_unique, reconcile duplicate active list/template source identities, and retry';
    END IF;
END
$$;
