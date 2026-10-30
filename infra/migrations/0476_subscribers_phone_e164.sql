-- 0476_subscribers_phone_e164.sql
--
-- SUB-022 — Richer dedupe heuristics: phone_e164 column on subscribers.
--
-- The duplicate detector (subscriber_dedupe) grows five new heuristic kinds:
-- domain_substitution, homoglyph, levenshtein, phone_collision, and
-- external_id_collision. Four of the five reuse existing columns (email,
-- external_id); phone_collision needs a phone identifier on the subscribers
-- table itself.
--
-- The sms_subscriptions table already carries phone_e164, but it is a separate
-- per-channel row, not a subscriber attribute, so a SQL self-join on the
-- subscriber row cannot reach it cheaply. This migration promotes a phone
-- identifier onto subscribers as a nullable E.164 text column so the
-- phone_collision heuristic can group subscribers by identical phone number
-- with a single tenant-scoped index.
--
-- The column is NULLABLE (most subscribers are email-only) and carries no
-- format CHECK — the SUB-018 identifier transforms coerce phones to E.164 at
-- ingest, but legacy / partially-formatted rows must still be storable; the
-- heuristic simply groups by the literal value, so only exact-equal non-null
-- phones collide.
--
-- Additive, idempotent (IF NOT EXISTS). No RLS change: subscribers already has
-- tenant_id + RLS; we only add a column and a tenant-scoped partial index.

BEGIN;

ALTER TABLE subscribers
    ADD COLUMN IF NOT EXISTS phone_e164 text;

-- Tenant-scoped partial index so the phone_collision GROUP BY (tenant_id,
-- phone_e164) plans use it directly. Partial on NOT NULL keeps it small —
-- most subscribers are email-only.
CREATE INDEX IF NOT EXISTS subscribers_tenant_phone_e164_idx
    ON subscribers (tenant_id, phone_e164)
    WHERE phone_e164 IS NOT NULL;

COMMIT;
