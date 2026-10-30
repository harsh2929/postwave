-- 0048_campaign_templates.sql
--
-- Per-tenant + platform-shared campaign template library.
--
-- Two flavours:
--   * Platform templates (tenant_id NULL) — seeded on gateway boot,
--     shared read-only across every workspace. The starter library
--     ("Welcome", "Re-engagement", "Newsletter blank", etc.) lives
--     here so a fresh tenant has working templates without having
--     to author from scratch.
--   * Tenant templates (tenant_id NOT NULL) — saved by the tenant.
--     "Save this campaign as a template" → row gets dropped here.
--
-- Distinct from voice_templates (services/voice/internal/templates):
-- voice templates are AI-sequence definitions (subject + body
-- prompts + variable schema for Claude generation). Campaign
-- templates are concrete HTML/MJML snippets a tenant copies into
-- a fresh campaign.

BEGIN;

CREATE TABLE campaign_templates (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- NULL = platform template; non-NULL = tenant-owned. The CHECK
    -- on slug uniqueness uses (COALESCE(tenant_id, '00000000-...'))
    -- so platform templates share one slug namespace and tenant
    -- templates share per-tenant namespaces.
    tenant_id     uuid REFERENCES tenants(id) ON DELETE CASCADE,
    slug          text NOT NULL,
    name          text NOT NULL,
    description   text,
    category      text,                                -- 'newsletter' | 'transactional' | 'marketing' | 'announcement' | ...
    subject       text NOT NULL DEFAULT '',
    preview_text  text NOT NULL DEFAULT '',
    body_html     text NOT NULL DEFAULT '',
    body_mjml     text NOT NULL DEFAULT '',
    -- variables documents the {{merge_field}} placeholders the
    -- template uses. Same shape as voice_templates.variables: an
    -- array of {name, label, default}. Lets the editor render a
    -- "fill in" form when a tenant picks the template.
    variables     jsonb NOT NULL DEFAULT '[]'::jsonb,
    tags          text[] NOT NULL DEFAULT '{}',
    -- For tenant templates: who saved it. NULL on platform rows.
    created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Slug uniqueness: per (tenant_id, slug). NULLs in PostgreSQL aren't
-- equal to each other in a normal unique constraint, so we use a
-- partial index for platform templates and one for tenant templates.
CREATE UNIQUE INDEX campaign_templates_platform_slug_idx
    ON campaign_templates (slug)
    WHERE tenant_id IS NULL;

CREATE UNIQUE INDEX campaign_templates_tenant_slug_idx
    ON campaign_templates (tenant_id, slug)
    WHERE tenant_id IS NOT NULL;

CREATE INDEX campaign_templates_category_idx
    ON campaign_templates (category)
    WHERE tenant_id IS NULL;

CREATE TRIGGER campaign_templates_set_updated_at
    BEFORE UPDATE ON campaign_templates
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_templates TO postwave_app;

ALTER TABLE campaign_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_templates FORCE  ROW LEVEL SECURITY;

-- RLS: tenant rows are tenant-scoped; platform rows are visible to
-- any tenant for SELECT but only mutable by an admin role at the
-- application layer (we gate writes via apikeys.ScopeAdmin in main.go).
CREATE POLICY tenant_isolation ON campaign_templates
    FOR ALL
    USING (
      tenant_id IS NULL
      OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
    WITH CHECK (
      tenant_id IS NULL
      OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

-- Seed three starter platform templates so a tenant has something
-- to drop into a fresh campaign on day one. The bodies are MJML
-- (Postwave's preferred authoring language); the editor compiles
-- to body_html on save.

INSERT INTO campaign_templates (tenant_id, slug, name, description, category, subject, preview_text, body_mjml, variables) VALUES
(NULL, 'welcome-launch', 'Welcome to {{product_name}}', 'A simple welcome email with a single CTA.', 'marketing',
 'Welcome to {{product_name}}, {{first_name}}',
 'Glad to have you. Here is where to start.',
 '<mjml><mj-body><mj-section><mj-column>
   <mj-text font-size="24px" font-weight="bold">Welcome, {{first_name}}.</mj-text>
   <mj-text>Thanks for joining {{product_name}}. We send one short note a week — no spam.</mj-text>
   <mj-button href="{{cta_url}}">Get started</mj-button>
   <mj-text font-size="12px" color="#666">You are receiving this because you subscribed at {{signup_url}}.</mj-text>
 </mj-column></mj-section></mj-body></mjml>',
 '[{"name":"product_name","label":"Product name","default":""},{"name":"first_name","label":"First name","default":"there"},{"name":"cta_url","label":"Primary CTA URL","default":""},{"name":"signup_url","label":"Signup page URL","default":""}]'::jsonb),

(NULL, 'newsletter-weekly', 'Weekly newsletter — {{week_of}}', 'Three-section newsletter layout.', 'newsletter',
 '{{newsletter_name}} — week of {{week_of}}',
 'This week: {{topic_one}}, {{topic_two}}, and more.',
 '<mjml><mj-body><mj-section><mj-column>
   <mj-text font-size="22px" font-weight="bold">{{newsletter_name}}</mj-text>
   <mj-text font-size="14px" color="#666">Week of {{week_of}}</mj-text>
   <mj-divider border-color="#eee"/>
   <mj-text font-size="18px" font-weight="bold">1. {{topic_one}}</mj-text>
   <mj-text>{{topic_one_body}}</mj-text>
   <mj-text font-size="18px" font-weight="bold">2. {{topic_two}}</mj-text>
   <mj-text>{{topic_two_body}}</mj-text>
   <mj-text font-size="18px" font-weight="bold">3. {{topic_three}}</mj-text>
   <mj-text>{{topic_three_body}}</mj-text>
 </mj-column></mj-section></mj-body></mjml>',
 '[{"name":"newsletter_name","label":"Newsletter name","default":""},{"name":"week_of","label":"Week of","default":""},{"name":"topic_one","label":"Topic 1 title","default":""},{"name":"topic_one_body","label":"Topic 1 body","default":""},{"name":"topic_two","label":"Topic 2 title","default":""},{"name":"topic_two_body","label":"Topic 2 body","default":""},{"name":"topic_three","label":"Topic 3 title","default":""},{"name":"topic_three_body","label":"Topic 3 body","default":""}]'::jsonb),

(NULL, 're-engagement-gentle', 'We miss you, {{first_name}}', 'A gentle re-engagement nudge for stale subscribers.', 'marketing',
 'Still want emails from {{product_name}}?',
 'It has been a while. Are we still useful?',
 '<mjml><mj-body><mj-section><mj-column>
   <mj-text font-size="22px" font-weight="bold">Hey {{first_name}},</mj-text>
   <mj-text>It has been a while since we last heard from you. If our emails are useful, no action needed — we will keep showing up. If they are not, no hard feelings; you can unsubscribe with one click.</mj-text>
   <mj-button href="{{unsubscribe_url}}" background-color="#999">Unsubscribe</mj-button>
   <mj-text font-size="14px" color="#666">Want fewer emails? Reply with "less" and we will halve the cadence.</mj-text>
 </mj-column></mj-section></mj-body></mjml>',
 '[{"name":"first_name","label":"First name","default":"there"},{"name":"product_name","label":"Product name","default":""},{"name":"unsubscribe_url","label":"Unsubscribe URL","default":""}]'::jsonb);

COMMIT;
