-- 0212_klaviyo_reviews_foundation.sql
--
-- Klaviyo parity slice KLV-11: product/store reviews, requests,
-- moderation/authenticity state, media, Q&A, public replies, widgets,
-- and per-product aggregates.

BEGIN;

CREATE TABLE review_widgets (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    slug                 citext NOT NULL,
    name                 text NOT NULL,
    status               text NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft','active','paused','archived')),
    widget_type          text NOT NULL DEFAULT 'product_reviews'
                         CHECK (widget_type IN ('star_rating','summary','product_reviews','featured_carousel','all_reviews','qna')),
    product_filter       jsonb NOT NULL DEFAULT '{}',
    display_settings     jsonb NOT NULL DEFAULT '{}',
    moderation_settings  jsonb NOT NULL DEFAULT '{}',
    language             text NOT NULL DEFAULT 'en',
    styling              jsonb NOT NULL DEFAULT '{}',
    metadata             jsonb NOT NULL DEFAULT '{}',
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, slug)
);

CREATE INDEX review_widgets_tenant_status_idx
    ON review_widgets (tenant_id, status, updated_at DESC);
CREATE INDEX review_widgets_public_slug_idx
    ON review_widgets (slug) WHERE status = 'active';

CREATE TRIGGER review_widgets_set_updated_at
    BEFORE UPDATE ON review_widgets
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON review_widgets TO postwave_app;

ALTER TABLE review_widgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_widgets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_or_public_review_widgets ON review_widgets
    AS RESTRICTIVE FOR ALL
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR (
            status = 'active'
            AND slug = NULLIF(current_setting('app.public_review_widget_slug', true), '')::citext
        )
    )
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible_review_widgets ON review_widgets
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR (
            status = 'active'
            AND slug = NULLIF(current_setting('app.public_review_widget_slug', true), '')::citext
        )
    )
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE review_requests (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    product_id        uuid REFERENCES commerce_products(id) ON DELETE SET NULL,
    variant_id        uuid REFERENCES commerce_product_variants(id) ON DELETE SET NULL,
    order_id          uuid,
    subscriber_id     uuid REFERENCES subscribers(id) ON DELETE SET NULL,
    email             citext,
    token_hash        text NOT NULL DEFAULT '',
    status            text NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued','sent','opened','submitted','expired','cancelled')),
    scheduled_at      timestamptz,
    sent_at           timestamptz,
    expires_at        timestamptz,
    channel           text NOT NULL DEFAULT 'email'
                      CHECK (channel IN ('email','sms','customer_hub','api')),
    metadata          jsonb NOT NULL DEFAULT '{}',
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX review_requests_tenant_status_idx
    ON review_requests (tenant_id, status, scheduled_at DESC NULLS LAST);
CREATE INDEX review_requests_email_idx
    ON review_requests (tenant_id, email, created_at DESC);

CREATE TRIGGER review_requests_set_updated_at
    BEFORE UPDATE ON review_requests
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON review_requests TO postwave_app;

ALTER TABLE review_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON review_requests
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON review_requests
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE product_reviews (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    product_id        uuid REFERENCES commerce_products(id) ON DELETE SET NULL,
    variant_id        uuid REFERENCES commerce_product_variants(id) ON DELETE SET NULL,
    request_id        uuid REFERENCES review_requests(id) ON DELETE SET NULL,
    order_id          uuid,
    source_platform   text NOT NULL DEFAULT 'postwave',
    source_ref        text NOT NULL DEFAULT '',
    review_type       text NOT NULL DEFAULT 'product'
                      CHECK (review_type IN ('product','store','question_answer')),
    reviewer_name     text NOT NULL DEFAULT '',
    reviewer_email    citext,
    rating            integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
    title             text NOT NULL DEFAULT '',
    body              text NOT NULL DEFAULT '',
    status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','rejected','spam','archived')),
    verified_buyer    boolean NOT NULL DEFAULT false,
    incentivized      boolean NOT NULL DEFAULT false,
    featured          boolean NOT NULL DEFAULT false,
    moderation_reason text NOT NULL DEFAULT '',
    submitted_at      timestamptz NOT NULL DEFAULT now(),
    published_at      timestamptz,
    moderated_at      timestamptz,
    metadata          jsonb NOT NULL DEFAULT '{}',
    raw_payload        jsonb NOT NULL DEFAULT '{}',
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX product_reviews_source_unique_idx
    ON product_reviews (tenant_id, source_platform, source_ref)
    WHERE source_ref <> '';
CREATE INDEX product_reviews_product_status_idx
    ON product_reviews (tenant_id, product_id, status, published_at DESC NULLS LAST);
CREATE INDEX product_reviews_moderation_idx
    ON product_reviews (tenant_id, status, submitted_at DESC);

CREATE TRIGGER product_reviews_set_updated_at
    BEFORE UPDATE ON product_reviews
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON product_reviews TO postwave_app;

ALTER TABLE product_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_or_public_product_reviews ON product_reviews
    AS RESTRICTIVE FOR ALL
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR (
            status = 'approved'
            AND tenant_id = NULLIF(current_setting('app.public_review_tenant_id', true), '')::uuid
        )
    )
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible_product_reviews ON product_reviews
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR (
            status = 'approved'
            AND tenant_id = NULLIF(current_setting('app.public_review_tenant_id', true), '')::uuid
        )
    )
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE product_review_media (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    review_id     uuid NOT NULL REFERENCES product_reviews(id) ON DELETE CASCADE,
    storage_key   text NOT NULL,
    public_url    text NOT NULL DEFAULT '',
    mime_type     text NOT NULL DEFAULT '',
    size_bytes    bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
    width         integer,
    height        integer,
    status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','uploaded','approved','rejected','deleted')),
    sort_order    integer NOT NULL DEFAULT 0,
    metadata      jsonb NOT NULL DEFAULT '{}',
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX product_review_media_review_idx
    ON product_review_media (tenant_id, review_id, status, sort_order);

CREATE TRIGGER product_review_media_set_updated_at
    BEFORE UPDATE ON product_review_media
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON product_review_media TO postwave_app;

ALTER TABLE product_review_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_review_media FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON product_review_media
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON product_review_media
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE product_review_questions (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    product_id     uuid REFERENCES commerce_products(id) ON DELETE SET NULL,
    reviewer_name  text NOT NULL DEFAULT '',
    reviewer_email citext,
    question       text NOT NULL,
    answer         text NOT NULL DEFAULT '',
    status         text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','answered','approved','rejected','archived')),
    answered_by    text NOT NULL DEFAULT '',
    asked_at       timestamptz NOT NULL DEFAULT now(),
    answered_at    timestamptz,
    metadata       jsonb NOT NULL DEFAULT '{}',
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX product_review_questions_product_idx
    ON product_review_questions (tenant_id, product_id, status, asked_at DESC);

CREATE TRIGGER product_review_questions_set_updated_at
    BEFORE UPDATE ON product_review_questions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON product_review_questions TO postwave_app;

ALTER TABLE product_review_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_review_questions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON product_review_questions
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON product_review_questions
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE review_public_replies (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    review_id    uuid NOT NULL REFERENCES product_reviews(id) ON DELETE CASCADE,
    author       text NOT NULL DEFAULT 'Store owner',
    body         text NOT NULL,
    status       text NOT NULL DEFAULT 'published'
                 CHECK (status IN ('draft','published','hidden')),
    metadata     jsonb NOT NULL DEFAULT '{}',
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX review_public_replies_review_idx
    ON review_public_replies (tenant_id, review_id, status, created_at ASC);

CREATE TRIGGER review_public_replies_set_updated_at
    BEFORE UPDATE ON review_public_replies
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON review_public_replies TO postwave_app;

ALTER TABLE review_public_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_public_replies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON review_public_replies
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON review_public_replies
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE product_review_aggregates (
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    product_id      uuid NOT NULL REFERENCES commerce_products(id) ON DELETE CASCADE,
    approved_count  integer NOT NULL DEFAULT 0 CHECK (approved_count >= 0),
    rating_sum      integer NOT NULL DEFAULT 0 CHECK (rating_sum >= 0),
    average_rating  numeric(3,2) NOT NULL DEFAULT 0,
    rating_counts   jsonb NOT NULL DEFAULT '{}',
    last_review_at  timestamptz,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, product_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON product_review_aggregates TO postwave_app;

ALTER TABLE product_review_aggregates ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_review_aggregates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON product_review_aggregates
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON product_review_aggregates
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
