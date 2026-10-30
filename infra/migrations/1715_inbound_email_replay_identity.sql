-- 1715_inbound_email_replay_identity.sql
-- rollback-strategy: expand-contract
-- rollback-details: leave nullable replay columns and their unique index in
-- place during application rollback; old releases ignore them.
--
-- Atomic replay claim for the signed inbound-email receiver. The application
-- stores only SHA-256 identifiers/hashes here, never provider tokens or raw
-- signature material. Existing rows stay NULL and therefore do not collide.

ALTER TABLE inbound_emails
    ADD COLUMN IF NOT EXISTS ingest_key text,
    ADD COLUMN IF NOT EXISTS ingest_body_sha256 text;

-- DROP + CREATE makes the non-transactional phase crash-retryable. PostgreSQL
-- can leave an invalid same-name shell when a concurrent build is interrupted,
-- while a process can also die after a valid build but before the runner phase
-- marker commits. Restart from the DROP in either case.
DROP INDEX CONCURRENTLY IF EXISTS inbound_emails_tenant_ingest_key_uniq;

CREATE UNIQUE INDEX CONCURRENTLY inbound_emails_tenant_ingest_key_uniq
    ON inbound_emails (tenant_id, ingest_key)
    WHERE ingest_key IS NOT NULL;
