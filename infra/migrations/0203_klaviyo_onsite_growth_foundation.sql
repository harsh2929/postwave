-- 0203_klaviyo_onsite_growth_foundation.sql
--
-- Klaviyo parity slice KLV-09: onsite form targeting, form experiments,
-- adaptive winner state, spin-to-win rewards, and event analytics.

BEGIN;

CREATE TABLE onsite_targeting_rules (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    form_id               uuid NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
    status                text NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft','published','paused','archived')),
    priority              integer NOT NULL DEFAULT 100
                          CHECK (priority >= 0 AND priority <= 1000),
    trigger               jsonb NOT NULL DEFAULT '{}',
    frequency             jsonb NOT NULL DEFAULT '{}',
    audience              jsonb NOT NULL DEFAULT '{}',
    url_rules             jsonb NOT NULL DEFAULT '{}',
    utm_rules             jsonb NOT NULL DEFAULT '{}',
    cart_rules            jsonb NOT NULL DEFAULT '{}',
    geo_rules             jsonb NOT NULL DEFAULT '{}',
    device_rules          jsonb NOT NULL DEFAULT '{}',
    visitor_state_rules   jsonb NOT NULL DEFAULT '{}',
    custom_trigger_rules  jsonb NOT NULL DEFAULT '{}',
    compiled              jsonb NOT NULL DEFAULT '{}',
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, form_id)
);

CREATE INDEX onsite_targeting_rules_tenant_status_idx
    ON onsite_targeting_rules (tenant_id, status, priority, updated_at DESC);

CREATE TRIGGER onsite_targeting_rules_set_updated_at
    BEFORE UPDATE ON onsite_targeting_rules
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON onsite_targeting_rules TO postwave_app;

ALTER TABLE onsite_targeting_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE onsite_targeting_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON onsite_targeting_rules
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON onsite_targeting_rules
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE onsite_form_experiments (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    form_id               uuid NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
    key                   text NOT NULL,
    name                  text NOT NULL,
    status                text NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft','running','paused','completed','archived')),
    allocation_mode       text NOT NULL DEFAULT 'manual'
                          CHECK (allocation_mode IN ('manual','adaptive')),
    winner_metric         text NOT NULL DEFAULT 'confirmed_submissions'
                          CHECK (winner_metric IN ('views','submissions','confirmed_submissions','conversion_rate','revenue')),
    adaptive_config       jsonb NOT NULL DEFAULT '{}',
    winner_variant_id     uuid,
    starts_at             timestamptz,
    ends_at               timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, form_id, key)
);

CREATE INDEX onsite_form_experiments_tenant_status_idx
    ON onsite_form_experiments (tenant_id, form_id, status, updated_at DESC);

CREATE TRIGGER onsite_form_experiments_set_updated_at
    BEFORE UPDATE ON onsite_form_experiments
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON onsite_form_experiments TO postwave_app;

ALTER TABLE onsite_form_experiments ENABLE ROW LEVEL SECURITY;
ALTER TABLE onsite_form_experiments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON onsite_form_experiments
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON onsite_form_experiments
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE onsite_form_variants (
    id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    form_id                      uuid NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
    experiment_id                uuid NOT NULL REFERENCES onsite_form_experiments(id) ON DELETE CASCADE,
    key                          text NOT NULL,
    name                         text NOT NULL,
    traffic_weight_basis_points  integer NOT NULL DEFAULT 0
                                 CHECK (traffic_weight_basis_points >= 0 AND traffic_weight_basis_points <= 10000),
    is_control                   boolean NOT NULL DEFAULT false,
    status                       text NOT NULL DEFAULT 'active'
                                 CHECK (status IN ('active','paused','archived')),
    form_snapshot                jsonb NOT NULL DEFAULT '{}',
    success_behavior             jsonb NOT NULL DEFAULT '{}',
    coupon_pool_id               uuid REFERENCES coupon_pools(id) ON DELETE SET NULL,
    metrics                      jsonb NOT NULL DEFAULT '{}',
    created_at                   timestamptz NOT NULL DEFAULT now(),
    updated_at                   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (experiment_id, key)
);

CREATE INDEX onsite_form_variants_experiment_idx
    ON onsite_form_variants (tenant_id, experiment_id, status, key);

CREATE TRIGGER onsite_form_variants_set_updated_at
    BEFORE UPDATE ON onsite_form_variants
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON onsite_form_variants TO postwave_app;

ALTER TABLE onsite_form_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE onsite_form_variants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON onsite_form_variants
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON onsite_form_variants
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE onsite_form_experiments
    ADD CONSTRAINT onsite_form_experiments_winner_variant_fk
    FOREIGN KEY (winner_variant_id) REFERENCES onsite_form_variants(id) ON DELETE SET NULL;

CREATE TABLE onsite_spin_to_win_rewards (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    form_id               uuid NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
    variant_id            uuid REFERENCES onsite_form_variants(id) ON DELETE CASCADE,
    key                   text NOT NULL,
    label                 text NOT NULL,
    reward_type           text NOT NULL DEFAULT 'none'
                          CHECK (reward_type IN ('none','static_coupon','coupon_pool','custom_content')),
    weight_basis_points   integer NOT NULL DEFAULT 0
                          CHECK (weight_basis_points >= 0 AND weight_basis_points <= 10000),
    static_code           text NOT NULL DEFAULT '',
    coupon_pool_id        uuid REFERENCES coupon_pools(id) ON DELETE SET NULL,
    success_step_key      text NOT NULL DEFAULT '',
    flow_branch_key       text NOT NULL DEFAULT '',
    display               jsonb NOT NULL DEFAULT '{}',
    status                text NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','paused','archived')),
    sort_order            integer NOT NULL DEFAULT 0,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, form_id, key)
);

CREATE INDEX onsite_spin_to_win_rewards_form_idx
    ON onsite_spin_to_win_rewards (tenant_id, form_id, status, sort_order, key);

CREATE TRIGGER onsite_spin_to_win_rewards_set_updated_at
    BEFORE UPDATE ON onsite_spin_to_win_rewards
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON onsite_spin_to_win_rewards TO postwave_app;

ALTER TABLE onsite_spin_to_win_rewards ENABLE ROW LEVEL SECURITY;
ALTER TABLE onsite_spin_to_win_rewards FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON onsite_spin_to_win_rewards
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON onsite_spin_to_win_rewards
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE onsite_experiment_events (
    id             bigserial PRIMARY KEY,
    tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    form_id        uuid NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
    experiment_id  uuid REFERENCES onsite_form_experiments(id) ON DELETE SET NULL,
    variant_id     uuid REFERENCES onsite_form_variants(id) ON DELETE SET NULL,
    reward_id      uuid REFERENCES onsite_spin_to_win_rewards(id) ON DELETE SET NULL,
    event_type     text NOT NULL
                   CHECK (event_type IN ('view','impression','submit','confirmed','conversion','winner_selected','reward_assigned','reward_redeemed')),
    subscriber_id  uuid,
    email          citext,
    revenue_cents  integer NOT NULL DEFAULT 0,
    metadata       jsonb NOT NULL DEFAULT '{}',
    at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX onsite_experiment_events_rollup_idx
    ON onsite_experiment_events (tenant_id, form_id, experiment_id, variant_id, event_type, at DESC);

GRANT SELECT, INSERT ON onsite_experiment_events TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE onsite_experiment_events_id_seq TO postwave_app;

ALTER TABLE onsite_experiment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE onsite_experiment_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON onsite_experiment_events
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_visible ON onsite_experiment_events
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Existing growth-surface events now need to label form renders/submissions
-- alongside landing pages, popups, and surveys.
ALTER TABLE growth_surface_events
    DROP CONSTRAINT IF EXISTS growth_surface_events_surface_type_check;

ALTER TABLE growth_surface_events
    ADD CONSTRAINT growth_surface_events_surface_type_check
    CHECK (surface_type IN ('landing_page', 'popup', 'survey', 'form'));

COMMIT;
