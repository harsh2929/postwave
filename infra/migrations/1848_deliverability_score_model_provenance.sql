-- 1848_deliverability_score_model_provenance.sql
--
-- Score snapshots created under different cohorts/denominators must never be
-- joined into one trend. Existing rows predate explicit campaign-cohort and
-- sample-qualification semantics, so mark them legacy and require every new
-- writer to state its model version and evidence sample.
--
-- rollback-strategy: no-op - retain provenance columns during application rollback; older code ignores them.
-- rollback-details: restore from the preflight backup only if validation finds invalid snapshot provenance; dropping these columns would erase the model boundary.

BEGIN;

ALTER TABLE deliverability_hub_snapshots
    ADD COLUMN IF NOT EXISTS model_version text NOT NULL DEFAULT 'legacy-v1',
    ADD COLUMN IF NOT EXISTS sample_qualified boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS sample_size bigint NOT NULL DEFAULT 0
        CHECK (sample_size >= 0);

CREATE INDEX IF NOT EXISTS deliverability_hub_snapshots_tenant_model_sampled_idx
    ON deliverability_hub_snapshots (tenant_id, model_version, sampled_at DESC);

COMMIT;
