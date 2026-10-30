-- 0050_webhook_delivery_payload.sql
--
-- Adds a payload snapshot column on webhook_deliveries so a tenant
-- can replay a past delivery from the dashboard. Without the
-- snapshot, "replay" can only fire a synthetic ping (which is what
-- the existing Test endpoint does); customers who want to retry a
-- bounced delivery against their (now-fixed) endpoint need the
-- original payload.
--
-- payload_bytes is the wire-format JSON body the dispatcher posted
-- (the WireEnvelope shape from apps/api/internal/webhooks/dispatcher.go,
-- before HMAC). It's NULL for old rows that pre-date this migration
-- — the replay endpoint surfaces those as 422 with a clear "payload
-- not retained" code.
--
-- Why store inline rather than envelope-encrypt: the deliveries
-- table is already RLS-tenant-scoped, and the payload is by
-- definition tenant-readable data (the dispatcher already POSTed it
-- to a tenant-controlled URL). Encrypting again at rest would
-- protect against a single threat (DB dump) without changing the
-- production posture (anyone with a DB dump already has every
-- subscriber's email + custom fields).

BEGIN;

ALTER TABLE webhook_deliveries
    ADD COLUMN IF NOT EXISTS payload_bytes bytea;

-- Index lookup-by-webhook stays sufficient; payload column doesn't
-- need its own index.

COMMIT;
