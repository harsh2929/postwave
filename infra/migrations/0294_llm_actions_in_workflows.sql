-- 0284_llm_actions_in_workflows.sql
--
-- STO-LLM-ACTIONS-IN-WORKFLOWS: persistence for the new `llm_action`
-- step type in flow-builder workflows (apps/api/internal/flowbuilder
-- catalogue + apps/desktop sequence canvas).
--
-- Customer.io's LLM Actions step prompts a model per recipient, parses
-- the output into a typed value (number / boolean / single_select /
-- list), and stores it as a journey attribute that subsequent
-- conditional split nodes can branch on. This migration lays the two
-- tables the runtime needs:
--
--   1. journey_attributes — per-(tenant, journey_run, subscriber)
--      typed scratchpad. The LLM action runner writes its typed output
--      here under output_attribute_name; downstream branch nodes read
--      it from the same row (cheap lookup, deterministic against the
--      run snapshot).
--
--   2. llm_action_invocations — audit trail. One row per (run, step,
--      subscriber) call. Lets ops debug "why did this branch fire" by
--      replaying the prompt, the parsed output, the model + latency,
--      and the retry count. Append-only.
--
-- Both tables follow the canonical Postwave RLS idiom:
--   USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
--          OR current_setting('app.outbox_worker', true) = 'true')
-- which lets the in-process worker scoped via `db.WithTenant` see only
-- the tenant's rows, and the cross-tenant automation worker (which
-- sets app.outbox_worker=true) see everything.
--
-- Schema is intentionally minimal — we don't index every column; the
-- access patterns are (tenant_id, run_id) for branch lookups and
-- (tenant_id, created_at DESC) for the inspector list view.

BEGIN;

-- ---------------------------------------------------------------------
-- 1) journey_attributes
-- ---------------------------------------------------------------------
-- The actual scratchpad. value is jsonb so the four output_type variants
-- (number / boolean / single_select / list) all share one column without
-- type-tagged duplication. output_type is stored alongside so the branch
-- evaluator knows how to compare (e.g. boolean true vs string "true").

CREATE TABLE IF NOT EXISTS journey_attributes (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    run_id          uuid NOT NULL,
    flow_id         uuid NOT NULL,
    subscriber_id   uuid NOT NULL,
    name            text NOT NULL,
    output_type     text NOT NULL,
    value           jsonb NOT NULL DEFAULT 'null'::jsonb,
    source_node_id  text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT journey_attributes_output_type_chk
        CHECK (output_type IN ('number','boolean','single_select','list','string'))
);

-- Branches look up by (tenant_id, run_id, name) — that's the hot path.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_journey_attributes_run_name
    ON journey_attributes (tenant_id, run_id, subscriber_id, name);

CREATE INDEX IF NOT EXISTS idx_journey_attributes_tenant_created
    ON journey_attributes (tenant_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON journey_attributes TO postwave_app;

ALTER TABLE journey_attributes ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_visible ON journey_attributes AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
                OR current_setting('app.outbox_worker', true) = 'true');

-- ---------------------------------------------------------------------
-- 2) llm_action_invocations
-- ---------------------------------------------------------------------
-- One row per `llm_action` step execution. Stores the resolved prompt
-- (after merge-field rendering), the parsed typed output, the raw model
-- response, plus latency / retry / error metadata.
--
-- Indexes are deliberately narrow — the inspector tooling pages this
-- by (tenant_id, created_at DESC) and the per-run drill-down filters
-- by (tenant_id, run_id, node_id).

CREATE TABLE IF NOT EXISTS llm_action_invocations (
    id                 bigserial PRIMARY KEY,
    tenant_id          uuid NOT NULL,
    run_id             uuid,
    flow_id            uuid,
    node_id            text NOT NULL,
    subscriber_id      uuid,
    model              text NOT NULL DEFAULT '',
    output_type        text NOT NULL,
    output_attribute   text NOT NULL,
    rendered_prompt    text NOT NULL DEFAULT '',
    raw_response       text NOT NULL DEFAULT '',
    parsed_value       jsonb,
    retry_count        int  NOT NULL DEFAULT 0,
    latency_ms         int  NOT NULL DEFAULT 0,
    status             text NOT NULL DEFAULT 'ok',
    error              text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT llm_action_invocations_output_type_chk
        CHECK (output_type IN ('number','boolean','single_select','list','string')),
    CONSTRAINT llm_action_invocations_status_chk
        CHECK (status IN ('ok','parse_failed','model_failed','skipped'))
);

CREATE INDEX IF NOT EXISTS idx_llm_action_invocations_run
    ON llm_action_invocations (tenant_id, run_id, node_id);

CREATE INDEX IF NOT EXISTS idx_llm_action_invocations_tenant_created
    ON llm_action_invocations (tenant_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON llm_action_invocations TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE llm_action_invocations_id_seq TO postwave_app;

ALTER TABLE llm_action_invocations ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_visible ON llm_action_invocations AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
                OR current_setting('app.outbox_worker', true) = 'true');

COMMIT;
