-- 0164_subscribers_deliverability_resolver.sql
--
-- Follow-up to the SES bounce/complaint flow: the deliverability
-- webhook handler needs to resolve a tenant from a recipient email
-- when the SES notification carries no `X-Postwave-Tenant` header AND
-- no `esp_message_id → tenant` mapping exists (e.g. the message was
-- sent via Listmonk's shared-SMTP relay that can't tag per-tenant).
--
-- The handler does a cross-tenant SELECT against `subscribers`. That
-- table has FORCE RLS with tenant_isolation; bare cross-tenant reads
-- return zero rows. Add a PERMISSIVE SELECT bypass policy gated on
-- a new GUC `app.deliverability_resolver = 'true'`.
--
-- The handler binds this GUC inside a short read-only tx around the
-- recipient lookup; once the tenant is resolved, the rest of the
-- per-tenant work (suppression insert, event log) runs under the
-- normal tenant-scoped tx.

BEGIN;

CREATE POLICY subscribers_deliverability_resolver
    ON subscribers
    AS PERMISSIVE FOR SELECT TO postwave_app
    USING (current_setting('app.deliverability_resolver', true) = 'true');

COMMIT;
