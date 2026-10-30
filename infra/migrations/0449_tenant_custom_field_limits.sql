-- 0449_tenant_custom_field_limits.sql
--
-- SUB-015 — Custom-field soft limits + searchable-field tracking.
--
-- The tenant_custom_fields registry (migration 0036, widened by 0415) lets a
-- workspace declare an unbounded number of custom attributes. Klaviyo and
-- Mailchimp both cap the number of profile attributes a workspace can define
-- (a governance + performance lever: every searchable attribute costs an
-- index, and an unbounded registry degrades the segment builder and the
-- subscriber index page). Postwave had no equivalent guardrail.
--
-- This migration adds the two soft-limit knobs directly to the tenants table
-- so the customfields repo can enforce them at write time without a join, and
-- adds a `searchable` flag to tenant_custom_fields so a tenant can opt a small
-- number of fields into the indexed/searchable set (capped separately).
--
--   * tenants.max_custom_fields     — cap on the total number of custom
--                                     fields a tenant may define. Default
--                                     1000 (matches the Klaviyo profile-
--                                     property ceiling; generous, soft).
--   * tenants.max_searchable_fields — cap on how many of those fields may be
--                                     marked searchable. Default 3.
--   * tenant_custom_fields.searchable — boolean, default false. When true the
--                                     field counts against max_searchable_fields.
--
-- All columns carry NOT NULL defaults so existing rows are valid immediately
-- and no backfill pass is required. RLS on both tables is inherited unchanged
-- (tenants from 0001, tenant_custom_fields from 0036).

BEGIN;

ALTER TABLE tenants
    ADD COLUMN IF NOT EXISTS max_custom_fields     integer NOT NULL DEFAULT 1000,
    ADD COLUMN IF NOT EXISTS max_searchable_fields integer NOT NULL DEFAULT 3;

-- Defensive sanity bounds: limits must be non-negative. Guarded so a re-run
-- on a fixture that already added them is a no-op.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'tenants_max_custom_fields_chk'
    ) THEN
        ALTER TABLE tenants
            ADD CONSTRAINT tenants_max_custom_fields_chk
            CHECK (max_custom_fields >= 0 AND max_searchable_fields >= 0);
    END IF;
END$$;

ALTER TABLE tenant_custom_fields
    ADD COLUMN IF NOT EXISTS searchable boolean NOT NULL DEFAULT false;

-- Partial index over the searchable subset so the "count searchable fields"
-- check (run at create time) and the segment-builder's searchable-field
-- lookup both plan against a narrow index rather than a full registry scan.
CREATE INDEX IF NOT EXISTS tenant_custom_fields_tenant_searchable_idx
    ON tenant_custom_fields (tenant_id)
    WHERE searchable;

COMMIT;
