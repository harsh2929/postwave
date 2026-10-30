-- Route42 exact-admin registry read indexes.
--
-- The suppression browse uses stable keyset order by
-- (created_at DESC,id DESC) within one tenant. A reason-filtered browse adds
-- an equality predicate before that order; the exact phone body query already
-- uses the existing UNIQUE (tenant_id,phone_e164) index and needs no duplicate.
-- Keyword-response inventory aggregates historical granted consent events once
-- per tenant by metadata->>'keyword'; the partial expression index contains
-- only rows that can contribute to that grouping.
--
-- These tables may be large or write-active. The migration runner durably
-- records and retries each online index phase; no table-rewrite or constraint
-- adoption follows.
-- migration-execution: phased
-- rollback-strategy: no-op
-- rollback-details: Additive read indexes are safe to leave in place if the Route42 binary is rolled back. Drop them CONCURRENTLY only in a separately reviewed capacity change after confirming no retained reader uses them.

CREATE INDEX CONCURRENTLY IF NOT EXISTS sms_suppressions_tenant_created_id_idx
  ON sms_suppressions (tenant_id, created_at DESC, id DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS sms_suppressions_tenant_reason_created_id_idx
  ON sms_suppressions (tenant_id, reason, created_at DESC, id DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS sms_consent_events_tenant_granted_keyword_idx
  ON sms_consent_events (tenant_id, (metadata->>'keyword'))
  WHERE action = 'granted' AND metadata ? 'keyword';
