-- 0366_form_visits.sql
--
-- A23 (desktop audit 2026-06-10): hosted-form visit tracking.
--
-- The desktop FormsStatStrip shows an unweighted mean conversion rate
-- because the forms list payload has no denominator — submissions are
-- recorded but views never were. This adds a deliberately tiny daily
-- aggregate: one row per (tenant, form, day), bumped by a single upsert
-- from the public form render routes:
--
--   GET /api/public/forms/{slug}        (JSON fetch — script/react embeds
--                                        + hosted page)
--   GET /api/public/forms/{slug}/embed  (iframe HTML render)
--
-- A daily counter (not per-visit rows) keeps the hot public path to one
-- cheap upsert and makes the 30-day rollup a <=30-row index scan per
-- form. Day is computed in UTC by the writer so the bucket boundary is
-- deployment-timezone independent.
--
-- The read side is the subquery in forms.Repo.List (visits30d on the
-- list payload), served entirely by the primary-key index.

BEGIN;

CREATE TABLE form_visits (
    tenant_id uuid   NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    form_id   uuid   NOT NULL REFERENCES forms(id)   ON DELETE CASCADE,
    day       date   NOT NULL,
    count     bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, form_id, day)
);

-- The PK (tenant_id, form_id, day) is also the only index we need:
-- the upsert conflicts on it and the visits_30d rollup range-scans it.

GRANT SELECT, INSERT, UPDATE ON form_visits TO postwave_app;

ALTER TABLE form_visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE form_visits FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON form_visits
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
