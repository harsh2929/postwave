-- 0187_templates_v2.sql
--
-- Templates v2: turns the campaign template library from "3 hardcoded
-- platform rows + free-form tenant CRUD" into a real product surface.
--
-- Four schema concerns + one new table:
--
--   1. usage_count + last_used_at — incremented every time a tenant
--      hands a template off to a new campaign (the existing handoff
--      path was a pure-frontend copy with no analytics). Powers the
--      "Most used", "Recently used", and "Trending in your library"
--      sorts that the dashboard tiles + the "Popular" tab depend on.
--
--   2. is_featured (platform-only) — operator-curated boolean that
--      pins specific platform templates to the top of the
--      "Postwave Gallery" tab. Cheaper than a per-template position
--      column + still expressive enough for "show these 5 first".
--
--   3. goal — goal-first discovery (welcome / newsletter /
--      announcement / promotional / re_engagement / transactional /
--      automation). The audit identified goal as the most-requested
--      filter axis; category alone (newsletter/promotional/...) is
--      too coarse. CHECK constraint enforces the taxonomy so a typo
--      ('Welcome' vs 'welcome') doesn't fragment the index.
--
--   4. template_favorites table — per-user starring. Joining tenant
--      + user + template lets a single tenant member favorite a
--      template without polluting their teammates' view. Indexed on
--      (tenant_id, user_id) for the favorites-tab read pattern.
--
-- Backfill: the 3 existing platform templates from 0048 each get a
-- goal value derived from their slug. New goal-bucket coverage is
-- filled by 4 additional platform templates seeded at the bottom.

BEGIN;

-- 1. New columns on campaign_templates.
ALTER TABLE campaign_templates
    ADD COLUMN usage_count    INT          NOT NULL DEFAULT 0,
    ADD COLUMN last_used_at   TIMESTAMPTZ,
    ADD COLUMN is_featured    BOOLEAN      NOT NULL DEFAULT false,
    ADD COLUMN goal           TEXT;

-- Goal taxonomy — keep it tight; v2.1 can widen if real demand
-- surfaces. NULL is allowed for tenant-created templates that don't
-- want to commit to a bucket.
ALTER TABLE campaign_templates
    ADD CONSTRAINT campaign_templates_goal_chk
    CHECK (goal IS NULL OR goal IN (
      'welcome',
      'newsletter',
      'announcement',
      'promotional',
      're_engagement',
      'transactional',
      'automation'
    ));

-- Index supports "filter by goal" + the per-goal usage rollup.
CREATE INDEX campaign_templates_goal_usage_idx
    ON campaign_templates (goal, usage_count DESC)
    WHERE goal IS NOT NULL;

-- Partial index for the dashboard "Most used" sort path. Most-of-time
-- usage_count is 0, so a partial keeps the index small.
CREATE INDEX campaign_templates_used_recent_idx
    ON campaign_templates (tenant_id, last_used_at DESC NULLS LAST)
    WHERE usage_count > 0;

-- 2. Backfill goal on the three 0048 platform seeds. Idempotent —
-- the WHERE clauses are slug-anchored.
UPDATE campaign_templates SET goal = 'welcome'
 WHERE tenant_id IS NULL AND slug = 'welcome-launch';
UPDATE campaign_templates SET goal = 'newsletter'
 WHERE tenant_id IS NULL AND slug = 'newsletter-weekly';
UPDATE campaign_templates SET goal = 're_engagement'
 WHERE tenant_id IS NULL AND slug = 're-engagement-gentle';

-- Promote welcome + newsletter to "featured" so the Postwave Gallery
-- tab has hero items out of the box.
UPDATE campaign_templates SET is_featured = true
 WHERE tenant_id IS NULL
   AND slug IN ('welcome-launch', 'newsletter-weekly');

-- 3. template_favorites — per-user star table.
CREATE TABLE template_favorites (
    tenant_id   UUID        NOT NULL REFERENCES tenants(id)          ON DELETE CASCADE,
    user_id     UUID        NOT NULL REFERENCES users(id)            ON DELETE CASCADE,
    template_id UUID        NOT NULL REFERENCES campaign_templates(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, user_id, template_id)
);

CREATE INDEX template_favorites_user_idx
    ON template_favorites (tenant_id, user_id, created_at DESC);

GRANT SELECT, INSERT, DELETE ON template_favorites TO postwave_app;

ALTER TABLE template_favorites ENABLE ROW LEVEL SECURITY;
ALTER TABLE template_favorites FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON template_favorites
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON template_favorites
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 4. Four additional platform templates that round out goal coverage.
--    Kept lean (HTML inlined, no MJML) so the migration stays small;
--    the production library can be deepened post-launch via a follow-up
--    migration / admin tool.
INSERT INTO campaign_templates
    (tenant_id, slug, name, description, category, subject, preview_text,
     body_html, variables, tags, goal, is_featured)
VALUES
    (NULL, 'announcement-product-launch',
     'Announce: product launch',
     'Hero + benefits + CTA. Use when shipping a new product or major feature.',
     'marketing',
     'Introducing {{product_name}}',
     'The thing you have been asking for — and what it does for you.',
     '<table width="600" align="center" cellpadding="0" cellspacing="0" style="font-family:system-ui,sans-serif;color:#111;line-height:1.6">'
     || '<tr><td style="padding:32px 24px 8px"><h1 style="font-size:28px;margin:0">Introducing {{product_name}}</h1></td></tr>'
     || '<tr><td style="padding:0 24px 16px;color:#444">{{lede}}</td></tr>'
     || '<tr><td style="padding:8px 24px">'
     ||   '<ul style="padding-left:18px;margin:0">'
     ||     '<li>{{benefit_one}}</li>'
     ||     '<li>{{benefit_two}}</li>'
     ||     '<li>{{benefit_three}}</li>'
     ||   '</ul>'
     || '</td></tr>'
     || '<tr><td style="padding:24px;text-align:center">'
     ||   '<a href="{{cta_url}}" style="display:inline-block;padding:12px 24px;background:#0d9488;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">{{cta_label}}</a>'
     || '</td></tr>'
     || '<tr><td style="padding:24px;color:#888;font-size:12px;text-align:center"><a href="{{unsubscribe_url}}" style="color:#888">Unsubscribe</a></td></tr>'
     || '</table>',
     '[
        {"name":"product_name","label":"Product name","default":""},
        {"name":"lede","label":"Lede paragraph","default":""},
        {"name":"benefit_one","label":"Benefit one","default":""},
        {"name":"benefit_two","label":"Benefit two","default":""},
        {"name":"benefit_three","label":"Benefit three","default":""},
        {"name":"cta_label","label":"CTA button label","default":"Learn more"},
        {"name":"cta_url","label":"CTA URL","default":""},
        {"name":"unsubscribe_url","label":"Unsubscribe URL","default":""}
      ]'::jsonb,
     ARRAY['announcement','featured'],
     'announcement',
     true),

    (NULL, 'promotional-flash-sale',
     'Promote: limited-time offer',
     'Urgency-driven layout for a sale or short-window discount.',
     'marketing',
     '{{discount}}% off — ends {{ends_at}}',
     'Lock it in before the timer hits zero.',
     '<table width="600" align="center" cellpadding="0" cellspacing="0" style="font-family:system-ui,sans-serif;color:#111;line-height:1.5">'
     || '<tr><td style="padding:40px 24px;text-align:center;background:#0f172a;color:#fff">'
     ||   '<div style="font-size:14px;letter-spacing:.2em;text-transform:uppercase;opacity:.8;margin-bottom:8px">Limited time</div>'
     ||   '<h1 style="font-size:36px;margin:0">{{discount}}% off {{product_name}}</h1>'
     ||   '<div style="font-size:14px;margin-top:8px;opacity:.8">Ends {{ends_at}}</div>'
     || '</td></tr>'
     || '<tr><td style="padding:24px;text-align:center">'
     ||   '<p style="margin:0 0 16px">{{lede}}</p>'
     ||   '<a href="{{cta_url}}" style="display:inline-block;padding:12px 24px;background:#dc2626;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">Claim {{discount}}% off</a>'
     || '</td></tr>'
     || '<tr><td style="padding:24px;color:#888;font-size:12px;text-align:center"><a href="{{unsubscribe_url}}" style="color:#888">Unsubscribe</a></td></tr>'
     || '</table>',
     '[
        {"name":"discount","label":"Discount %","default":"20"},
        {"name":"product_name","label":"Product name","default":""},
        {"name":"ends_at","label":"Sale end date","default":""},
        {"name":"lede","label":"Body copy","default":""},
        {"name":"cta_url","label":"CTA URL","default":""},
        {"name":"unsubscribe_url","label":"Unsubscribe URL","default":""}
      ]'::jsonb,
     ARRAY['promotional','featured'],
     'promotional',
     true),

    (NULL, 'transactional-receipt',
     'Transactional: order receipt',
     'Order confirmation with itemized list. Keep this transactional only — do not include marketing CTAs.',
     'transactional',
     'Order #{{order_number}} confirmed',
     'Thanks for your order. Details inside.',
     '<table width="600" align="center" cellpadding="0" cellspacing="0" style="font-family:system-ui,sans-serif;color:#111;line-height:1.6">'
     || '<tr><td style="padding:24px"><h1 style="font-size:22px;margin:0">Order #{{order_number}} confirmed</h1><div style="color:#666;font-size:14px;margin-top:4px">Placed {{order_date}}</div></td></tr>'
     || '<tr><td style="padding:0 24px"><table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb">'
     ||   '<tr><td style="padding:12px 0">{{item_one}}</td><td style="padding:12px 0;text-align:right">{{item_one_price}}</td></tr>'
     ||   '<tr><td style="padding:12px 0">{{item_two}}</td><td style="padding:12px 0;text-align:right">{{item_two_price}}</td></tr>'
     || '</table></td></tr>'
     || '<tr><td style="padding:16px 24px"><table width="100%"><tr><td style="font-weight:600">Total</td><td style="text-align:right;font-weight:600">{{total}}</td></tr></table></td></tr>'
     || '<tr><td style="padding:24px;color:#666;font-size:13px">If you have any questions, just reply to this email and we will get back to you.</td></tr>'
     || '</table>',
     '[
        {"name":"order_number","label":"Order number","default":""},
        {"name":"order_date","label":"Order date","default":""},
        {"name":"item_one","label":"Line item 1","default":""},
        {"name":"item_one_price","label":"Line item 1 price","default":""},
        {"name":"item_two","label":"Line item 2","default":""},
        {"name":"item_two_price","label":"Line item 2 price","default":""},
        {"name":"total","label":"Order total","default":""}
      ]'::jsonb,
     ARRAY['transactional','receipt'],
     'transactional',
     false),

    (NULL, 'automation-day-three-tip',
     'Automation step: day-three tip',
     'Drip-series step. Sent on day 3 of an onboarding sequence; one tip, one CTA.',
     'marketing',
     'Day 3: {{tip_headline}}',
     'A small thing that compounds. Try it today.',
     '<table width="600" align="center" cellpadding="0" cellspacing="0" style="font-family:system-ui,sans-serif;color:#111;line-height:1.6">'
     || '<tr><td style="padding:24px"><div style="color:#666;font-size:12px;text-transform:uppercase;letter-spacing:.1em">Day 3 of {{series_length}}</div></td></tr>'
     || '<tr><td style="padding:0 24px"><h1 style="font-size:24px;margin:0 0 12px">{{tip_headline}}</h1></td></tr>'
     || '<tr><td style="padding:0 24px;color:#333">{{tip_body}}</td></tr>'
     || '<tr><td style="padding:24px"><a href="{{cta_url}}" style="display:inline-block;padding:10px 18px;background:#0d9488;color:#fff;border-radius:6px;text-decoration:none">{{cta_label}}</a></td></tr>'
     || '<tr><td style="padding:24px;color:#888;font-size:12px;text-align:center"><a href="{{unsubscribe_url}}" style="color:#888">Unsubscribe</a></td></tr>'
     || '</table>',
     '[
        {"name":"series_length","label":"Total series length","default":"7"},
        {"name":"tip_headline","label":"Tip headline","default":""},
        {"name":"tip_body","label":"Tip body","default":""},
        {"name":"cta_label","label":"CTA label","default":"Try it"},
        {"name":"cta_url","label":"CTA URL","default":""},
        {"name":"unsubscribe_url","label":"Unsubscribe URL","default":""}
      ]'::jsonb,
     ARRAY['automation','onboarding'],
     'automation',
     false)
ON CONFLICT (slug) WHERE tenant_id IS NULL DO NOTHING;

COMMIT;
