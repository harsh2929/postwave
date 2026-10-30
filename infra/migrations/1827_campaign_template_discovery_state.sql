-- 1827_campaign_template_discovery_state.sql
--
-- Durable, user-private discovery state for the campaign-template catalog:
-- recent views, named ordered collections, and saved searches. Favorites are
-- tightened from tenant-only RLS to tenant + acting-user RLS so every personal
-- catalog surface follows the same database-enforced isolation contract.
--
-- The application binds app.user_id transaction-locally before touching these
-- tables. Missing actor context therefore sees no rows and cannot write.
--
-- rollback-strategy: no-op
-- rollback-details: personal discovery state is user data. Rolling back the
-- application may leave these additive tables unused, but must not delete it.

-- Composite ownership FKs make it impossible to attach another tenant's user
-- to state even if a low-level caller tries to pair arbitrary UUIDs. Users is
-- an existing traffic-bearing table, so build its reference target without
-- holding writes for a full table scan.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
    users_tenant_id_id_campaign_template_uidx
    ON users (tenant_id, id);

BEGIN;

CREATE TABLE campaign_template_recent_views (
    tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id         uuid        NOT NULL,
    template_id     uuid        NOT NULL REFERENCES campaign_templates(id) ON DELETE CASCADE,
    view_count      integer     NOT NULL DEFAULT 1 CHECK (view_count > 0),
    first_viewed_at timestamptz NOT NULL DEFAULT now(),
    last_viewed_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, user_id, template_id),
    FOREIGN KEY (tenant_id, user_id)
        REFERENCES users(tenant_id, id) ON DELETE CASCADE,
    CHECK (last_viewed_at >= first_viewed_at)
);

CREATE INDEX campaign_template_recent_views_user_page_idx
    ON campaign_template_recent_views
       (tenant_id, user_id, last_viewed_at DESC, template_id ASC);

CREATE TABLE campaign_template_collections (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id     uuid        NOT NULL,
    name        text        NOT NULL,
    description text        NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, tenant_id, user_id),
    FOREIGN KEY (tenant_id, user_id)
        REFERENCES users(tenant_id, id) ON DELETE CASCADE,
    CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
    CHECK (name = btrim(name)),
    CHECK (char_length(description) <= 1000)
);

CREATE UNIQUE INDEX campaign_template_collections_user_name_uidx
    ON campaign_template_collections (tenant_id, user_id, lower(name));

CREATE INDEX campaign_template_collections_user_page_idx
    ON campaign_template_collections
       (tenant_id, user_id, updated_at DESC, id ASC);

CREATE TRIGGER campaign_template_collections_set_updated_at
    BEFORE UPDATE ON campaign_template_collections
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE campaign_template_collection_items (
    tenant_id    uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id      uuid        NOT NULL,
    collection_id uuid       NOT NULL,
    template_id  uuid        NOT NULL REFERENCES campaign_templates(id) ON DELETE CASCADE,
    position     smallint    NOT NULL CHECK (position BETWEEN 0 AND 99),
    added_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (collection_id, template_id),
    UNIQUE (collection_id, position),
    FOREIGN KEY (collection_id, tenant_id, user_id)
        REFERENCES campaign_template_collections(id, tenant_id, user_id)
        ON DELETE CASCADE
);

CREATE INDEX campaign_template_collection_items_user_idx
    ON campaign_template_collection_items
       (tenant_id, user_id, collection_id, position);

-- A plain template_id FK proves existence but not catalog visibility because
-- platform templates intentionally have tenant_id NULL. Keep the shared rows
-- usable while rejecting references to another tenant even for low-level SQL
-- callers that bypass the application repository.
CREATE FUNCTION campaign_template_discovery_assert_visible_template()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM campaign_templates
         WHERE id = NEW.template_id
           AND (tenant_id IS NULL OR tenant_id = NEW.tenant_id)
    ) THEN
        RAISE EXCEPTION
            'campaign template % is not visible to tenant %',
            NEW.template_id, NEW.tenant_id
            USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION campaign_template_discovery_assert_visible_template()
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION campaign_template_discovery_assert_visible_template()
    TO postwave_app;

CREATE TRIGGER campaign_template_recent_views_visible_template
    BEFORE INSERT OR UPDATE OF tenant_id, template_id
    ON campaign_template_recent_views
    FOR EACH ROW
    EXECUTE FUNCTION campaign_template_discovery_assert_visible_template();

CREATE TRIGGER campaign_template_collection_items_visible_template
    BEFORE INSERT OR UPDATE OF tenant_id, template_id
    ON campaign_template_collection_items
    FOR EACH ROW
    EXECUTE FUNCTION campaign_template_discovery_assert_visible_template();

CREATE TABLE campaign_template_saved_searches (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id     uuid        NOT NULL,
    name        text        NOT NULL,
    filters     jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (tenant_id, user_id)
        REFERENCES users(tenant_id, id) ON DELETE CASCADE,
    CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
    CHECK (name = btrim(name)),
    CHECK (jsonb_typeof(filters) = 'object'),
    CHECK (octet_length(filters::text) <= 16384)
);

CREATE UNIQUE INDEX campaign_template_saved_searches_user_name_uidx
    ON campaign_template_saved_searches (tenant_id, user_id, lower(name));

CREATE INDEX campaign_template_saved_searches_user_page_idx
    ON campaign_template_saved_searches
       (tenant_id, user_id, updated_at DESC, id ASC);

CREATE TRIGGER campaign_template_saved_searches_set_updated_at
    BEFORE UPDATE ON campaign_template_saved_searches
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE
    ON campaign_template_recent_views,
       campaign_template_collections,
       campaign_template_collection_items,
       campaign_template_saved_searches
    TO postwave_app;

ALTER TABLE campaign_template_recent_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_template_recent_views FORCE ROW LEVEL SECURITY;
ALTER TABLE campaign_template_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_template_collections FORCE ROW LEVEL SECURITY;
ALTER TABLE campaign_template_collection_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_template_collection_items FORCE ROW LEVEL SECURITY;
ALTER TABLE campaign_template_saved_searches ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_template_saved_searches FORCE ROW LEVEL SECURITY;

CREATE POLICY campaign_template_recent_views_private
    ON campaign_template_recent_views
    AS RESTRICTIVE FOR ALL
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    );
CREATE POLICY campaign_template_recent_views_app
    ON campaign_template_recent_views
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    );

CREATE POLICY campaign_template_collections_private
    ON campaign_template_collections
    AS RESTRICTIVE FOR ALL
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    );
CREATE POLICY campaign_template_collections_app
    ON campaign_template_collections
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    );

CREATE POLICY campaign_template_collection_items_private
    ON campaign_template_collection_items
    AS RESTRICTIVE FOR ALL
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    );
CREATE POLICY campaign_template_collection_items_app
    ON campaign_template_collection_items
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    );

CREATE POLICY campaign_template_saved_searches_private
    ON campaign_template_saved_searches
    AS RESTRICTIVE FOR ALL
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    );
CREATE POLICY campaign_template_saved_searches_app
    ON campaign_template_saved_searches
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    );

-- Favorites predate acting-user database context. Add a restrictive policy
-- so a compromised query cannot read or mutate a teammate's bookmarks.
CREATE POLICY template_favorites_user_isolation
    ON template_favorites
    AS RESTRICTIVE FOR ALL
    USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
    WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

COMMENT ON TABLE campaign_template_recent_views IS
    'Bounded, user-private recent campaign-template views; one upserted row per template.';
COMMENT ON TABLE campaign_template_collections IS
    'User-private named campaign-template collections.';
COMMENT ON TABLE campaign_template_collection_items IS
    'Ordered membership for user-private campaign-template collections (maximum 100 items).';
COMMENT ON TABLE campaign_template_saved_searches IS
    'User-private named catalog filters; cursor and pagination position are never persisted.';

COMMIT;
