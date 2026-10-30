-- 0007_forms.sql
--
-- Embeddable signup forms (Phase 3, pulled from V2 per plan.md). Two tables:
--   * forms              — per-tenant form definitions (structure JSON,
--                          settings JSON, single|double opt-in mode).
--   * form_submissions   — every public submission, including opt-in
--                          confirmation tokens for double-opt-in flows.
--
-- Public hosted form pages (forms.postwave.app/<slug>) and embed.js need to
-- read the form by slug + insert/update submissions WITHOUT a tenant context
-- (no Clerk session, no X-Tenant-Slug). Public repository methods still open
-- a transaction and SET LOCAL narrow app.public_* values; the RLS policies
-- below require those values instead of broad anonymous table access.

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------------------
-- forms
-- ---------------------------------------------------------------------------
CREATE TABLE forms (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    slug          citext NOT NULL,
    name          text NOT NULL,
    opt_in_mode   text NOT NULL CHECK (opt_in_mode IN ('single', 'double')),
    structure     jsonb NOT NULL DEFAULT '{}'::jsonb,
    settings      jsonb NOT NULL DEFAULT '{}'::jsonb,
    status        text NOT NULL CHECK (status IN ('draft', 'published', 'archived')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, slug)
);

CREATE INDEX forms_tenant_status_idx ON forms (tenant_id, status);
CREATE INDEX forms_slug_published_idx ON forms (slug) WHERE status = 'published';

CREATE TRIGGER forms_set_updated_at
    BEFORE UPDATE ON forms
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON forms TO postwave_app;

ALTER TABLE forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE forms FORCE  ROW LEVEL SECURITY;

-- Tenant isolation for the admin surface.
CREATE POLICY tenant_isolation ON forms
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Public slug/id lookup (hosted pages + embed iframe + public submission).
-- The app must bind either app.public_form_slug or app.public_form_id inside
-- the transaction before querying.
CREATE POLICY public_slug_lookup ON forms
    FOR SELECT
    USING (
        status = 'published'
        AND (
            slug = NULLIF(current_setting('app.public_form_slug', true), '')::citext
            OR id = NULLIF(current_setting('app.public_form_id', true), '')::uuid
        )
    );

-- ---------------------------------------------------------------------------
-- form_submissions
-- ---------------------------------------------------------------------------
CREATE TABLE form_submissions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    form_id             uuid NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email               citext NOT NULL,
    custom_fields       jsonb NOT NULL DEFAULT '{}'::jsonb,
    confirmation_token  text,
    status              text NOT NULL CHECK (status IN ('pending', 'confirmed', 'unsubscribed')),
    ip                  inet,
    user_agent          text,
    submitted_at        timestamptz NOT NULL DEFAULT now(),
    confirmed_at        timestamptz
);

CREATE INDEX form_submissions_form_idx        ON form_submissions (form_id, submitted_at DESC);
CREATE INDEX form_submissions_tenant_idx      ON form_submissions (tenant_id, status);
CREATE UNIQUE INDEX form_submissions_token_idx ON form_submissions (confirmation_token)
    WHERE confirmation_token IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON form_submissions TO postwave_app;

ALTER TABLE form_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE form_submissions FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON form_submissions
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Public form submissions are only accepted for the exact published form that
-- the repository bound into the transaction after a public form lookup.
CREATE POLICY form_submissions_public_insert ON form_submissions
    FOR INSERT
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.public_form_tenant_id', true), '')::uuid
        AND form_id = NULLIF(current_setting('app.public_form_id', true), '')::uuid
        AND EXISTS (
            SELECT 1
              FROM forms f
             WHERE f.id = form_submissions.form_id
               AND f.tenant_id = form_submissions.tenant_id
               AND f.status = 'published'
        )
    );

-- Public confirmation may read/update only the row matching the token that
-- the repository bound into the transaction.
CREATE POLICY form_submissions_public_confirm_select ON form_submissions
    FOR SELECT
    USING (confirmation_token = NULLIF(current_setting('app.public_confirmation_token', true), ''));

CREATE POLICY form_submissions_public_confirm_update ON form_submissions
    FOR UPDATE
    USING (confirmation_token = NULLIF(current_setting('app.public_confirmation_token', true), ''))
    WITH CHECK (confirmation_token = NULLIF(current_setting('app.public_confirmation_token', true), ''));

COMMIT;
