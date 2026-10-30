-- 1212_segment_templates.sql
--
-- SUB-034 — predictive segment templates.
--
-- Predictive models (CLV, RFM, Churn) are already operational: the
-- profile_predictions + profile_rfm_scores tables exist, the predictive
-- endpoints surface the data, and the segment compiler already routes
-- predictive.* and rfm.* field predicates to those tables
-- (apps/api/internal/segments/predicates/predictive.go). What was missing
-- was one-click "starter" audiences that pre-wire those predicates into
-- ready-to-use segments for operators.
--
-- This migration adds a single boolean marker to the existing `segments`
-- table so a materialized template (a segment created from one of the
-- hardcoded template definitions surfaced at GET /api/v1/segments/templates)
-- can be distinguished from a hand-built segment. No new table is needed —
-- templates reuse the entire segment infrastructure (CRUD, preview,
-- snapshots, P&L) once materialized; the marker is purely for UI grouping
-- ("these segments came from a starter template").
--
-- The catalog of template *definitions* (High-CLV, At-Risk, Likely-to-Churn)
-- lives in Go (apps/api/internal/segments/templates.go), not in the DB —
-- they are static, version-controlled ASTs built from the predictive.* /
-- rfm.* predicate registry, so there is no per-tenant seed step here.

BEGIN;

ALTER TABLE segments
    ADD COLUMN IF NOT EXISTS is_template boolean NOT NULL DEFAULT false;

-- Partial index so the "show only template-derived segments" filter on the
-- Segments page resolves without scanning the full tenant segment set. The
-- predicate keeps the index tiny (templates are a small minority of rows).
CREATE INDEX IF NOT EXISTS segments_tenant_is_template_idx
    ON segments (tenant_id)
    WHERE is_template;

COMMIT;
