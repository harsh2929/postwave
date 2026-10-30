-- 1728_tenants_worker_select_policy.sql
--
-- Phase 4 hardening (p4a-mig-tenants-worker-bypass): restore the
-- ability for cross-tenant background workers to enumerate the
-- `tenants` table after migration 0333 silently narrowed it.
--
-- Background
-- ----------
-- 0001_init_tenants.sql shipped with a wide-open SELECT policy on
-- tenants (USING (true)). That was deliberately permissive because
-- pre-tenant request paths (slug -> id, API-key -> tenant id, ...)
-- must look up rows BEFORE `app.tenant_id` is bound.
--
-- 0333_tenants_rls_split.sql tightened that surface by replacing the
-- single wide policy with two narrower PERMISSIVE policies:
--
--   * tenant_resolver_select  - gated on app.tenant_resolver = 'true'
--   * tenant_isolation_select - gated on id = app.tenant_id
--
-- That is correct for request-scoped traffic, but it broke a class
-- of background workers that legitimately need to fan out across
-- *every* tenant in the deployment. These workers run outside the
-- request lifecycle, never have an X-Tenant-Slug to resolve, and do
-- not (and must not) pin `app.tenant_id` before enumerating tenants
-- -- the whole point is to iterate the list and then bind tenant_id
-- per inner unit of work.
--
-- Two production call sites regressed silently when 0333 deployed:
--
--   * apps/api/internal/admin/kms_rewrap.go
--       `SELECT id::text FROM tenants ORDER BY id` (KMS key rotation
--       enumerates all tenants and re-encrypts each tenant's rows).
--   * apps/api/internal/referrals/verification_worker.go
--       `SELECT id::text FROM tenants ORDER BY created_at ASC`
--       (referral verification fan-out across tenants).
--
-- After 0333 both queries return zero rows under postwave_app because
-- neither path sets app.tenant_resolver nor binds app.tenant_id at
-- the outer SELECT. The workers continued to "succeed" (no error,
-- empty result set), so the regression went unnoticed and silently
-- stopped honouring KMS rewrap / referral verification for the whole
-- fleet.
--
-- Design
-- ------
-- Add a third PERMISSIVE policy on tenants that opens the read gate
-- when -- and only when -- the caller has explicitly entered worker
-- scope by setting `app.outbox_worker = 'true'` on the transaction.
-- Because PERMISSIVE policies are ORed, this composes additively
-- with the resolver / isolation policies from 0333 without
-- re-widening either gate.
--
-- Why piggy-back on `app.outbox_worker` instead of a new GUC?
--   * It is the canonical "I am a background worker, not a request"
--     marker already used by the outbox processor and other cron
--     workers throughout the codebase (see WithWorkerScope in
--     apps/api/internal/db/db.go).
--   * The AfterRelease hook in apps/api/internal/db/db.go already
--     RESETs `app.outbox_worker` when a connection returns to the
--     pool, so a misbehaving caller cannot leak worker scope into
--     the next checkout (Phase 0 hardening).
--   * Adding yet-another tenant-scope GUC for the same semantic
--     ("this is not a request") would duplicate the reset surface
--     and create a new way to forget the cleanup.
--
-- Caller contract (what workers MUST do)
-- --------------------------------------
-- Any worker that needs to enumerate the tenants table cross-tenant
-- MUST open its outer transaction with:
--
--     BEGIN;
--     SET LOCAL app.outbox_worker = 'true';
--     SELECT id FROM tenants ORDER BY ...;
--     -- per-tenant inner work goes here, each binding app.tenant_id
--     COMMIT;
--
-- The `WithWorkerScope` helper in apps/api/internal/db/db.go does
-- exactly this and is the preferred entry point. Bare pool.Query
-- against `SELECT ... FROM tenants` outside worker scope will (now
-- correctly) return zero rows.
--
-- Idempotency: DROP POLICY IF EXISTS guards re-application against a
-- tenant that received a hand-patched fix. ENABLE / FORCE RLS are
-- defensive no-ops.

BEGIN;

-- Defensive: 0001 / 0333 already enabled+forced RLS on tenants.
-- Re-asserting is a no-op if already set.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE  ROW LEVEL SECURITY;

-- Permissive policy #3: background-worker fan-out path.
-- Gated on app.outbox_worker = 'true'. Outside worker scope the GUC
-- is unset (NULL = 'true' is false), so this policy denies access.
-- The literal-string comparison is defence-in-depth so unrelated GUC
-- values (e.g. a fuzzed boolean-like string) cannot accidentally
-- widen the gate.
DROP POLICY IF EXISTS tenant_worker_select ON tenants;
CREATE POLICY tenant_worker_select ON tenants
    AS PERMISSIVE
    FOR SELECT
    TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true');

COMMIT;

