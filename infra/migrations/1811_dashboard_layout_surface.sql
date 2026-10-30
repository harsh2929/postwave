-- 1811_dashboard_layout_surface.sql
-- OVR-032: per-surface dashboard layouts. Today dashboard_layouts stores one
-- ordering per (user, tenant) — the analytics KPI row. Home widgets need their
-- own ordering, so add a `surface` discriminator and widen the PK to include it.
-- Existing rows are the analytics layout (default 'analytics'); RLS is unchanged.

BEGIN;

ALTER TABLE dashboard_layouts
    ADD COLUMN IF NOT EXISTS surface text NOT NULL DEFAULT 'analytics';

ALTER TABLE dashboard_layouts
    DROP CONSTRAINT IF EXISTS dashboard_layouts_pkey;

ALTER TABLE dashboard_layouts
    ADD CONSTRAINT dashboard_layouts_pkey PRIMARY KEY (user_id, tenant_id, surface);

COMMIT;
