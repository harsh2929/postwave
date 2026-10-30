-- 0223_asset_tags.sql
--
-- Workstream 4 (Mailchimp parity polish) — asset tagging.
--
-- Operators tag assets ("hero", "logo", "spring-sale") and the library
-- toolbar exposes a chip-row that filters by tag. Tag values are free-text,
-- per-tenant, and case-folded by the handler. Composite PK prevents the
-- same (asset, tag) pair appearing twice — the handler is idempotent.

BEGIN;

CREATE TABLE asset_tags (
    tenant_id  uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    asset_id   uuid        NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    tag        text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, asset_id, tag),
    CHECK (length(tag) BETWEEN 1 AND 64)
);

-- Per-tenant tag chip row needs to enumerate distinct tags fast.
CREATE INDEX asset_tags_tenant_tag_idx ON asset_tags (tenant_id, tag);
-- Reverse lookup for the "show me everything with tag X" filter.
CREATE INDEX asset_tags_asset_idx ON asset_tags (asset_id);

COMMIT;
