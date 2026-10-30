-- 0016_topics.sql
--
-- Preference center / topics. Three tables:
--   * topics                — per-tenant topic catalog.
--   * subscriber_topics     — per-subscriber opt-in state, keyed by email.
--   * preference_tokens     — short-lived bearer tokens that grant a single
--                             subscriber access to the hosted preference page
--                             without a tenant context (anonymous public).
--
-- The hosted preference page (apps/web /preferences/[token]) needs to read
-- topics + subscriber_topics + the token row WITHOUT a tenant context. Public
-- repository methods still open a transaction and SET LOCAL narrow
-- app.preference_* values; the RLS policies below require those values.

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------------------
-- topics
-- ---------------------------------------------------------------------------
CREATE TABLE topics (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    slug            citext NOT NULL,
    name            text NOT NULL,
    description     text,
    default_opt_in  bool NOT NULL DEFAULT true,
    display_order   int NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, slug)
);

CREATE INDEX topics_tenant_order_idx ON topics (tenant_id, display_order);

CREATE TRIGGER topics_set_updated_at
    BEFORE UPDATE ON topics
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON topics TO postwave_app;

ALTER TABLE topics ENABLE ROW LEVEL SECURITY;
ALTER TABLE topics FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON topics
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Public read for the hosted preference page after token validation. The
-- repository binds the token-derived tenant id into app.preference_tenant_id.
CREATE POLICY topics_public_read ON topics
    FOR SELECT
    USING (tenant_id = NULLIF(current_setting('app.preference_tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- subscriber_topics
-- ---------------------------------------------------------------------------
CREATE TABLE subscriber_topics (
    tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_email   citext NOT NULL,
    topic_id           uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    opted_in           bool NOT NULL DEFAULT true,
    at                 timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, subscriber_email, topic_id)
);

CREATE INDEX subscriber_topics_email_idx ON subscriber_topics (tenant_id, subscriber_email);

GRANT SELECT, INSERT, UPDATE, DELETE ON subscriber_topics TO postwave_app;

ALTER TABLE subscriber_topics ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_topics FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON subscriber_topics
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Public policy keyed on the token-derived tenant/email that the repository
-- binds after validating the preference token.
CREATE POLICY subscriber_topics_public_token ON subscriber_topics
    FOR ALL
    USING (
        tenant_id = NULLIF(current_setting('app.preference_tenant_id', true), '')::uuid
        AND subscriber_email = NULLIF(current_setting('app.preference_email', true), '')::citext
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.preference_tenant_id', true), '')::uuid
        AND subscriber_email = NULLIF(current_setting('app.preference_email', true), '')::citext
        AND EXISTS (
            SELECT 1 FROM topics t
             WHERE t.id = subscriber_topics.topic_id
               AND t.tenant_id = subscriber_topics.tenant_id
        )
    );

-- ---------------------------------------------------------------------------
-- preference_tokens
-- ---------------------------------------------------------------------------
CREATE TABLE preference_tokens (
    token              text PRIMARY KEY,
    tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_email   citext NOT NULL,
    expires_at         timestamptz NOT NULL,
    created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX preference_tokens_email_idx ON preference_tokens (tenant_id, subscriber_email);
CREATE INDEX preference_tokens_expires_idx ON preference_tokens (expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON preference_tokens TO postwave_app;

ALTER TABLE preference_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE preference_tokens FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON preference_tokens
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Public read keyed on the exact token bound by the repository. Expiry is
-- checked in application code so expired links can return 410 instead of 404.
CREATE POLICY preference_tokens_public_read ON preference_tokens
    FOR SELECT
    USING (token = NULLIF(current_setting('app.preference_token', true), ''));

COMMIT;
