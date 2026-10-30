-- The signature resolver must be able to find a secret (PRD F03).
--
-- conversion_ingest_secrets carries a `tenant_isolation` policy for ALL commands,
-- keyed on app.tenant_id. But resolving a signature is precisely the step that
-- ESTABLISHES the tenant — there is no tenant bound yet for a policy to filter
-- on — so the resolver's lookup matched zero rows and every signed request was
-- rejected as unsigned.
--
-- RLS filters rather than refuses, so this failed SILENTLY and in the safe
-- direction: requests were denied, not leaked. That is the only reason it was
-- merely broken rather than dangerous, and it is why the unit tests for the
-- signing primitives all passed while the endpoint could never authenticate
-- anyone.
--
-- The fix is an EXPLICIT cross-tenant read, gated on a GUC only the resolver
-- sets, mirroring the retention worker's exemption in migration 1949. Explicit
-- because a cross-tenant read should be visible in the schema rather than an
-- accident of a missing WHERE clause: this policy is the one place a reviewer can
-- see that the secrets table is readable across tenants, and by whom.
--
-- The row it returns is a key id, a tenant id and a secret — used only to verify a
-- MAC the caller already computed. A caller who cannot produce a valid MAC learns
-- nothing, and one who can already holds the secret.
--
-- rollback-strategy: no-op

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DROP POLICY IF EXISTS conversion_ingest_secrets_resolver_select
    ON conversion_ingest_secrets;
CREATE POLICY conversion_ingest_secrets_resolver_select
    ON conversion_ingest_secrets
    FOR SELECT
    USING (current_setting('app.conversion_signature_resolver', true) = 'true');
