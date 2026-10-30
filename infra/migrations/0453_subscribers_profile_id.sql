-- 0453_subscribers_profile_id.sql
--
-- SUB-017 — Identifier precedence hierarchy:
--   profile_id > external_id > email > phone > anonymous.
--
-- Postwave currently treats email (UNIQUE(tenant_id, email::citext)) as the
-- sole canonical key; external_id has a partial-UNIQUE (migration 0243) and
-- the identify path splits lookups into external_id vs. email. There was no
-- top-of-hierarchy synthetic identifier — the auto-generated `id` doubles as
-- a row PK, but the precedence design wants a STABLE, caller-resolvable
-- profile identifier that survives merges and is distinct from the physical
-- row id.
--
-- This migration adds subscribers.profile_id: a synthetic, per-row UNIQUE
-- uuid with a gen_random_uuid() default so every existing row is
-- auto-assigned one on migrate (backward-compatible — no caller has to
-- supply it). It ranks ABOVE external_id in the identify/merge precedence:
-- an identify call that resolves a profile_id wins outright (exact match),
-- before external_id / email / phone are even consulted.
--
-- NOT NULL is safe because the DEFAULT fills every row at ADD COLUMN time;
-- the UNIQUE index is built afterward so the backfill cannot transiently
-- violate it.
--
-- rollback-strategy: additive. Hard rollback =
-- ALTER TABLE subscribers DROP COLUMN profile_id.

BEGIN;

ALTER TABLE subscribers
    ADD COLUMN IF NOT EXISTS profile_id uuid NOT NULL DEFAULT gen_random_uuid();

COMMENT ON COLUMN subscribers.profile_id IS
    'SUB-017 stable synthetic profile identifier, distinct from the physical row id. Top of the identifier precedence hierarchy (profile_id > external_id > email > phone > anonymous). Auto-assigned via gen_random_uuid() default.';

-- Per-tenant UNIQUE so a profile_id resolves to exactly one row. Built after
-- the NOT NULL DEFAULT backfill so it never sees a transient duplicate/NULL.
CREATE UNIQUE INDEX IF NOT EXISTS subscribers_tenant_profile_id_idx
    ON subscribers (tenant_id, profile_id);

COMMIT;
