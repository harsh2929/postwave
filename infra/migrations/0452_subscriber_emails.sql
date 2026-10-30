-- 0452_subscriber_emails.sql
--
-- SUB-016 — Multi-email per profile (up to 5).
--
-- A single contact frequently owns more than one address (work + personal,
-- a forwarding alias, a legacy account) and the modern expectation (Klaviyo
-- "additional identifiers", Iterable secondary emails, HubSpot's secondary
-- email property) is that each address carries its OWN consent / suppression /
-- engagement state while still rolling up to one profile.
--
-- Until now the subscribers table modelled exactly one address via
-- UNIQUE(tenant_id, email). This migration:
--   1. Adds a primary_email pointer column to subscribers — the canonical
--      contact address (backfilled from the existing email column). The
--      legacy `email` column is left untouched for back-compat; primary_email
--      is the explicit "which of the N addresses is canonical" marker.
--   2. Creates a subscriber_emails junction table keyed by
--      (tenant_id, subscriber_id, email) that normalises the per-address
--      attributes: is_primary, consent_status, suppressed flag, and a
--      last_engaged_at engagement marker — each independent per address.
--   3. Backfills one subscriber_emails row per existing subscriber from the
--      canonical email so day-one reads are non-empty.
--
-- A per-tenant UNIQUE(tenant_id, lower(email)) keeps a given address owned by
-- at most one profile (mirroring the canonical subscribers UNIQUE), so a
-- suppression/consent lookup by ANY address resolves to a single profile.
-- The 5-address cap is enforced in the application layer (repo), not as a DB
-- constraint, so the limit can evolve per plan without a migration.
--
-- rollback-strategy: additive. Hard rollback =
--   DROP TABLE subscriber_emails;
--   ALTER TABLE subscribers DROP COLUMN primary_email.

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;

-- 1. Canonical-address pointer on the subscriber row.
ALTER TABLE subscribers
    ADD COLUMN IF NOT EXISTS primary_email citext;

-- Backfill: the existing email is the canonical address for every row.
UPDATE subscribers
   SET primary_email = email
 WHERE primary_email IS NULL;

-- 2. Per-address junction table.
CREATE TABLE IF NOT EXISTS subscriber_emails (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id  uuid NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    email          citext NOT NULL,
    is_primary     boolean NOT NULL DEFAULT false,
    -- Independent consent per address. Vocabulary mirrors the coarse
    -- consent_source / status semantics used elsewhere; 'subscribed' is the
    -- deliverable default for a freshly added address.
    consent_status text NOT NULL DEFAULT 'subscribed'
                   CHECK (consent_status IN (
                       'subscribed', 'unsubscribed', 'pending', 'unknown'
                   )),
    -- Independent suppression per address — decoupled from the canonical
    -- subscriber row, the same isolation pattern email_suppressions uses.
    suppressed     boolean NOT NULL DEFAULT false,
    last_engaged_at timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

-- One profile per address per tenant (case-insensitive) — the multi-email
-- analogue of the canonical subscribers UNIQUE(tenant_id, email).
CREATE UNIQUE INDEX IF NOT EXISTS subscriber_emails_unique_email_idx
    ON subscriber_emails (tenant_id, lower(email::text));

-- "All addresses for subscriber X" — the dominant read shape.
CREATE INDEX IF NOT EXISTS subscriber_emails_subscriber_idx
    ON subscriber_emails (tenant_id, subscriber_id);

-- At most one primary address per subscriber.
CREATE UNIQUE INDEX IF NOT EXISTS subscriber_emails_one_primary_idx
    ON subscriber_emails (tenant_id, subscriber_id)
    WHERE is_primary;

CREATE TRIGGER subscriber_emails_set_updated_at
    BEFORE UPDATE ON subscriber_emails
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 3. Backfill one primary row per existing subscriber.
INSERT INTO subscriber_emails (tenant_id, subscriber_id, email, is_primary)
SELECT s.tenant_id, s.id, s.email, true
  FROM subscribers s
 WHERE NOT EXISTS (
       SELECT 1 FROM subscriber_emails se
        WHERE se.tenant_id = s.tenant_id
          AND lower(se.email::text) = lower(s.email::text)
 );

GRANT SELECT, INSERT, UPDATE, DELETE ON subscriber_emails TO postwave_app;

ALTER TABLE subscriber_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_emails FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON subscriber_emails
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON subscriber_emails
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
