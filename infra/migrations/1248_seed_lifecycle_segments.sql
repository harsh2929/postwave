-- 1248_seed_lifecycle_segments.sql
--
-- SUB-035 — pre-built lifecycle segments seeded per tenant.
--
-- Klaviyo / Mailchimp ship every account with a set of "day one"
-- lifecycle audiences (Engaged 30/60/90, VIPs, Unengaged, Cleaned) so
-- an operator never stares at an empty Segments page. Postwave already
-- has the saved-segments infrastructure (table `segments`, query_ast
-- jsonb compiled by segments.CompileAST), the transient preset counts at
-- GET /api/v1/preset-segments, and the predictive starter templates at
-- GET /api/v1/segments/templates — but nothing MATERIALIZES default
-- lifecycle audiences into the `segments` table. This migration closes
-- that gap.
--
-- Each seeded row carries a canonical SegmentNode AST in the exact JSON
-- shape segments.CompileAST() consumes (op/field/comparator/value with
-- and/condition nodes). Every AST below was verified to compile cleanly
-- through the live compiler (apps/api/internal/segments/compile.go) while
-- authoring this migration:
--
--   * status        -> subscribers.status   (generic scalar / IN path)
--   * metric.*       -> product_events aggregate via metricCondition,
--                       comparators in_last_days / more_than_days_ago
--                       (compile.go metricCondition + predicates/aggregate.go)
--   * rfm.segment_key-> profile_rfm_scores via rfmField (compile.go)
--
-- Engagement-recency is expressed through the metric.* aggregate path
-- (the ONLY relative-date predicate the compiler supports — the
-- last_event_at/last_opened_at engagement-date fields advertise
-- in_last_days in the schema but the generic compiler does not yet
-- implement that comparator for them, so using them would NOT compile).
-- "opened"/"clicked" are the conventional engagement event names; on
-- tenants that emit those track events into product_events the Engaged /
-- Unengaged audiences populate immediately, and the segments are fully
-- editable like any hand-built segment.
--
-- The seed targets the column set actually present on `segments`
-- (0014_segments.sql + 1212_segment_templates.sql adds is_template):
--   tenant_id, name, description, query_ast, is_template
-- (id / timestamps / last_count default). Idempotency rides the natural
-- key UNIQUE (tenant_id, name) via ON CONFLICT DO NOTHING, so re-running
-- the migration or a double-firing trigger never duplicates. RLS on
-- `segments` is satisfied because every inserted row carries the correct
-- tenant_id (the function runs as the migration role / trigger owner and
-- writes tenant_id = the owning tenant).

BEGIN;

-- seed_lifecycle_segments_for_tenant inserts the default lifecycle
-- audiences for a single tenant. Idempotent via ON CONFLICT on the
-- natural key (tenant_id, name); safe to call repeatedly.
CREATE OR REPLACE FUNCTION seed_lifecycle_segments_for_tenant(p_tenant uuid)
RETURNS void AS $$
BEGIN
    INSERT INTO segments (tenant_id, name, description, query_ast, is_template)
    VALUES
        -- Engaged 30 — enabled subscribers who opened in the last 30 days.
        (p_tenant, 'Engaged 30',
         'Subscribers who engaged (opened) in the last 30 days.',
         '{"op":"and","children":[{"op":"condition","field":"status","comparator":"equals","value":"enabled"},{"op":"condition","field":"metric.email.opened.count","comparator":"in_last_days","value":{"event_name":"opened","days":30}}]}'::jsonb,
         false),

        -- Engaged 60 — enabled subscribers who opened in the last 60 days.
        (p_tenant, 'Engaged 60',
         'Subscribers who engaged (opened) in the last 60 days.',
         '{"op":"and","children":[{"op":"condition","field":"status","comparator":"equals","value":"enabled"},{"op":"condition","field":"metric.email.opened.count","comparator":"in_last_days","value":{"event_name":"opened","days":60}}]}'::jsonb,
         false),

        -- Engaged 90 — enabled subscribers who opened in the last 90 days.
        (p_tenant, 'Engaged 90',
         'Subscribers who engaged (opened) in the last 90 days.',
         '{"op":"and","children":[{"op":"condition","field":"status","comparator":"equals","value":"enabled"},{"op":"condition","field":"metric.email.opened.count","comparator":"in_last_days","value":{"event_name":"opened","days":90}}]}'::jsonb,
         false),

        -- VIPs — enabled RFM champions / loyal customers.
        (p_tenant, 'VIPs',
         'High-value subscribers — RFM champions and loyal customers.',
         '{"op":"and","children":[{"op":"condition","field":"status","comparator":"equals","value":"enabled"},{"op":"condition","field":"rfm.segment_key","comparator":"in","value":["champions","loyal_customers"]}]}'::jsonb,
         false),

        -- Unengaged — enabled subscribers with no open AND no click in 90 days.
        (p_tenant, 'Unengaged',
         'Enabled subscribers with no open or click in the last 90 days — sunset candidates.',
         '{"op":"and","children":[{"op":"condition","field":"status","comparator":"equals","value":"enabled"},{"op":"condition","field":"metric.email.opened.count","comparator":"more_than_days_ago","value":{"event_name":"opened","days":90}},{"op":"condition","field":"metric.email.clicked.count","comparator":"more_than_days_ago","value":{"event_name":"clicked","days":90}}]}'::jsonb,
         false),

        -- Cleaned — disabled / blocklisted subscribers (hard-cleaned list).
        (p_tenant, 'Cleaned',
         'Cleaned subscribers — disabled or blocklisted (hard bounces / removed).',
         '{"op":"condition","field":"status","comparator":"in","value":["disabled","blocklisted"]}'::jsonb,
         false)
    ON CONFLICT (tenant_id, name) DO NOTHING;
END;
$$ LANGUAGE plpgsql;

-- Forward-fire trigger: every newly-created tenant gets the default
-- lifecycle audiences so the Segments page is never empty on day one.
-- Mirrors the seed_subscription_types_on_tenant_create pattern in
-- 0247_subscription_types.sql.
CREATE OR REPLACE FUNCTION seed_lifecycle_segments_on_tenant_create()
RETURNS trigger AS $$
BEGIN
    PERFORM seed_lifecycle_segments_for_tenant(NEW.id);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS seed_lifecycle_segments_on_tenant_create ON tenants;
CREATE TRIGGER seed_lifecycle_segments_on_tenant_create
    AFTER INSERT ON tenants
    FOR EACH ROW EXECUTE FUNCTION seed_lifecycle_segments_on_tenant_create();

-- Backfill: seed the lifecycle audiences for every existing tenant.
-- Idempotent (ON CONFLICT inside the function), so re-applying is a
-- no-op for tenants already seeded.
DO $$
DECLARE
    t_id uuid;
BEGIN
    FOR t_id IN SELECT id FROM tenants LOOP
        PERFORM seed_lifecycle_segments_for_tenant(t_id);
    END LOOP;
END;
$$;

COMMIT;
