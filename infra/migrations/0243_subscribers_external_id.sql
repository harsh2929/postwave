-- 0243_subscribers_external_id.sql
--
-- SUB-001: cross-system identity column on subscribers.
--
-- Every leading 2026 vendor (Klaviyo, Customer.io, Iterable, Braze,
-- HubSpot) supports identify-by-external-id. Without it, Shopify /
-- Stripe / CRM syncs collapse to email-only joins, and any time the
-- upstream system changes a customer's email the Postwave side either
-- duplicates the profile or silently loses the link.
--
-- The column is nullable text — most legacy rows have no upstream
-- identity yet — and the uniqueness constraint is a PARTIAL index so a
-- tenant can have many `external_id IS NULL` rows. Once a row claims
-- an external_id the (tenant_id, external_id) tuple is exclusive.
--
-- We also add a trigram index on external_id so the search-by-id flow
-- (operator pastes a Shopify customer id into the search box) hits an
-- index rather than seq-scanning. The pg_trgm extension is already
-- enabled by 0242.
--
-- rollback-strategy: expand-contract — the column is additive; code
-- gates writes through identify.go and Repo.Upsert. Dropping the
-- column requires removing those writes first.

BEGIN;

ALTER TABLE subscribers
    ADD COLUMN IF NOT EXISTS external_id text;

-- Partial UNIQUE per spec: only enforced when external_id is set, so
-- the existing population (all NULL today) doesn't trip the index.
CREATE UNIQUE INDEX IF NOT EXISTS subscribers_tenant_external_id_uniq
    ON subscribers (tenant_id, external_id)
    WHERE external_id IS NOT NULL;

-- Trigram for substring lookups by external_id in operator search.
CREATE INDEX IF NOT EXISTS subscribers_external_id_trgm_idx
    ON subscribers USING GIN (lower(external_id) gin_trgm_ops)
    WHERE external_id IS NOT NULL;

COMMIT;
