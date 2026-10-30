-- Structural revenue-graph edges on conversions.
--
-- Until now a conversion could answer exactly one question about where the
-- money came from: which CAMPAIGN. Every other path a person can take to a
-- purchase — a flow that nudged them, a form they filled, a discount they
-- redeemed, a referral that sent them, an experiment arm they were in — was
-- recorded somewhere in the schema and connected to revenue nowhere. The facts
-- existed per-subscriber and the edge did not exist at all, so "revenue by
-- flow" was not a slow query, it was an unanswerable one.
--
-- These are FIVE INDEPENDENT EDGES, not one source column, and that is the
-- whole design. A conversion can genuinely have come through a form AND used a
-- discount AND sat in an experiment arm; collapsing that into a single
-- "attributed_source" would force a precedence rule to be invented, and a
-- precedence rule is a claim about how revenue is credited that this schema has
-- no business making on the operator's behalf. Separate nullable columns let
-- every edge be true at once and let each report choose its own denominator.
--
-- NULL means "no edge found", never "no edge existed". A lookup that misses is
-- indistinguishable here from one that was never run, which is why the
-- population path stamps attributed_via alongside these.
--
-- ON DELETE SET NULL on all four object references, matching
-- conversions_campaign_id_fkey: deleting a flow must not delete the revenue it
-- earned, and must not leave a dangling id that later reads as a live edge.
--
-- rollback-strategy: no-op

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

ALTER TABLE conversions
    ADD COLUMN IF NOT EXISTS flow_id uuid,
    ADD COLUMN IF NOT EXISTS form_id uuid,
    ADD COLUMN IF NOT EXISTS discount_id uuid,
    -- Referral's edge is the REFERRER, not a program id: referral_codes has no
    -- program_id, so there is no honest path from a conversion to a program
    -- today. The referrer is the fact that exists, and it is also the one the
    -- money follows — a referral reward is owed to a person.
    ADD COLUMN IF NOT EXISTS referrer_subscriber_id text,
    -- The ARM, not the experiment: revenue per arm is the only measurement an
    -- experiment edge exists to support. flow_ab_test_assignments.variant_id is
    -- text, so this is too.
    ADD COLUMN IF NOT EXISTS experiment_variant_id text;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'conversions'::regclass
           AND conname = 'conversions_flow_id_fkey'
    ) THEN
        ALTER TABLE conversions
            ADD CONSTRAINT conversions_flow_id_fkey
            FOREIGN KEY (flow_id) REFERENCES automation_journeys(id)
            ON DELETE SET NULL NOT VALID;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'conversions'::regclass
           AND conname = 'conversions_form_id_fkey'
    ) THEN
        ALTER TABLE conversions
            ADD CONSTRAINT conversions_form_id_fkey
            FOREIGN KEY (form_id) REFERENCES forms(id)
            ON DELETE SET NULL NOT VALID;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'conversions'::regclass
           AND conname = 'conversions_discount_id_fkey'
    ) THEN
        ALTER TABLE conversions
            ADD CONSTRAINT conversions_discount_id_fkey
            FOREIGN KEY (discount_id) REFERENCES discounts(id)
            ON DELETE SET NULL NOT VALID;
    END IF;
END
$$;

ALTER TABLE conversions VALIDATE CONSTRAINT conversions_flow_id_fkey;
ALTER TABLE conversions VALIDATE CONSTRAINT conversions_form_id_fkey;
ALTER TABLE conversions VALIDATE CONSTRAINT conversions_discount_id_fkey;

-- Read indexes: partial, because the overwhelming majority of rows carry no
-- edge and indexing their NULLs would cost write throughput to answer nothing.
CREATE INDEX IF NOT EXISTS conversions_flow_edge_idx
    ON conversions (tenant_id, flow_id, occurred_at DESC)
    WHERE flow_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS conversions_form_edge_idx
    ON conversions (tenant_id, form_id, occurred_at DESC)
    WHERE form_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS conversions_discount_edge_idx
    ON conversions (tenant_id, discount_id, occurred_at DESC)
    WHERE discount_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS conversions_referrer_edge_idx
    ON conversions (tenant_id, referrer_subscriber_id, occurred_at DESC)
    WHERE referrer_subscriber_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS conversions_experiment_edge_idx
    ON conversions (tenant_id, experiment_variant_id, occurred_at DESC)
    WHERE experiment_variant_id IS NOT NULL;

-- Lookup indexes on the SOURCE tables.
--
-- Without these the five last-touch probes turn one conversion INSERT into five
-- sequential scans, on the hot ingest path. campaign_report_events got exactly
-- this treatment in migration 0397 for exactly this reason; these are its
-- counterparts, and each is shaped (tenant, join key, time DESC) to match the
-- "most recent strictly before occurred_at" probe the lookups issue.
CREATE INDEX IF NOT EXISTS flow_runs_subscriber_recent_idx
    ON flow_runs (tenant_id, subscriber_id, created_at DESC);
CREATE INDEX IF NOT EXISTS form_submissions_email_recent_idx
    ON form_submissions (tenant_id, email, submitted_at DESC);
CREATE INDEX IF NOT EXISTS discount_redemptions_subscriber_recent_idx
    ON discount_redemptions (tenant_id, subscriber_id, redeemed_at DESC);
CREATE INDEX IF NOT EXISTS referral_conversions_referee_recent_idx
    ON referral_conversions (tenant_id, referee_subscriber_id, created_at DESC);
CREATE INDEX IF NOT EXISTS flow_ab_assignments_email_recent_idx
    ON flow_ab_test_assignments (tenant_id, subscriber_email, assigned_at DESC);
