// SPDX-License-Identifier: AGPL-3.0-only

package campaignassurance

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestDurableEvidenceMigrationContract(t *testing.T) {
	t.Parallel()
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve migration contract source")
	}
	path := filepath.Clean(filepath.Join(
		filepath.Dir(sourceFile),
		"../../../../infra/migrations/1921_campaign_assurance_durable_evidence.sql",
	))
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read assurance migration: %v", err)
	}
	sql := string(contents)
	required := []string{
		"CREATE TABLE campaign_assurance_runs",
		"CREATE TABLE campaign_assurance_run_artifacts",
		"CREATE TABLE campaign_assurance_run_configurations",
		"CREATE TABLE campaign_assurance_run_targets",
		"CREATE TABLE campaign_assurance_extractions",
		"CREATE TABLE campaign_assurance_findings",
		"CREATE TABLE campaign_assurance_overrides",
		"campaign_send_plans_assurance_identity_uidx",
		"campaign_render_artifacts_assurance_identity_uidx",
		"tenant_id, campaign_id, content_revision_id, send_plan_id, plan_hash",
		"tenant_id, campaign_id, send_plan_id, id, scenario_id",
		"target_manifest_hash",
		"required_extraction_count BETWEEN 1 AND 100000",
		"campaign_assurance_runs_one_active_artifact_profile_uidx",
		"campaign_render_artifacts_insert_frozen_plan_guard",
		"may only be added to a preparing plan",
		"new campaign assurance run must begin as an unfrozen queued input",
		"campaign assurance snapshot manifest is incomplete or non-contiguous",
		"public.digest",
		"campaign assurance lease renewal must advance monotonically",
		"campaign assurance claim requires worker scope",
		"campaign assurance terminal receipt requires worker scope",
		"Terminal aggregates are database facts",
		"blocking findings require a blocked gate decision",
		"blocked gate decision requires a persisted blocking finding",
		"parent_claim_token <> NEW.claim_token",
		"parent_lease_expires_at <= statement_timestamp()",
		"campaign_assurance_run_targets_immutable",
		"campaign_assurance_extractions_immutable",
		"campaign_assurance_findings_immutable",
		"campaign_assurance_overrides_immutable",
		"overridable",
		"finding_receipt_hash",
		"parent_state <> 'complete' OR parent_gate_decision <> 'block'",
		"actor_role IN ('owner', 'admin')",
		"campaign assurance override requires the bound acting user",
		"current_setting('app.user_id', true)",
		"UNIQUE (tenant_id, run_id, request_id, finding_id)",
		"raw_output_expires_at <= created_at + interval '30 days'",
		"postwave\\.tenant-object-ref\\.v1:campaign-assurance/raw-output/",
		"source_class = 'modeled'",
		"typed_patch_schema_version",
		"typed_patch_hash",
		"ALTER TABLE campaign_assurance_runs FORCE ROW LEVEL SECURITY",
		"ALTER TABLE campaign_assurance_run_artifacts FORCE ROW LEVEL SECURITY",
		"ALTER TABLE campaign_assurance_run_configurations FORCE ROW LEVEL SECURITY",
		"ALTER TABLE campaign_assurance_run_targets FORCE ROW LEVEL SECURITY",
		"ALTER TABLE campaign_assurance_extractions FORCE ROW LEVEL SECURITY",
		"ALTER TABLE campaign_assurance_findings FORCE ROW LEVEL SECURITY",
		"ALTER TABLE campaign_assurance_overrides FORCE ROW LEVEL SECURITY",
		"AS RESTRICTIVE FOR ALL TO postwave_app",
		"REVOKE UPDATE, DELETE, TRUNCATE ON campaign_assurance_extractions",
		"REVOKE UPDATE, DELETE, TRUNCATE ON campaign_assurance_findings",
		"REVOKE UPDATE, DELETE, TRUNCATE ON campaign_assurance_overrides",
	}
	for _, fragment := range required {
		if !strings.Contains(sql, fragment) {
			t.Errorf("migration missing durable assurance fragment %q", fragment)
		}
	}

	upper := strings.ToUpper(sql)
	for _, forbidden := range []string{
		"OR CURRENT_SETTING('APP.OUTBOX_WORKER'",
		"ACTOR_ROLE IN ('OWNER', 'ADMIN', 'SYSTEM')",
		"'LIVE_EVENT'",
		"GRANT UPDATE ON CAMPAIGN_ASSURANCE_EXTRACTIONS",
		"GRANT DELETE ON CAMPAIGN_ASSURANCE_EXTRACTIONS",
		"GRANT UPDATE ON CAMPAIGN_ASSURANCE_FINDINGS",
		"GRANT DELETE ON CAMPAIGN_ASSURANCE_FINDINGS",
		"GRANT UPDATE ON CAMPAIGN_ASSURANCE_OVERRIDES",
		"GRANT DELETE ON CAMPAIGN_ASSURANCE_OVERRIDES",
	} {
		if strings.Contains(upper, forbidden) {
			t.Errorf("migration contains forbidden assurance contract %q", forbidden)
		}
	}

	artifacts := strings.Index(sql, "CREATE TABLE campaign_assurance_run_artifacts")
	configurations := strings.Index(sql, "CREATE TABLE campaign_assurance_run_configurations")
	targets := strings.Index(sql, "CREATE TABLE campaign_assurance_run_targets")
	extractions := strings.Index(sql, "CREATE TABLE campaign_assurance_extractions")
	findings := strings.Index(sql, "CREATE TABLE campaign_assurance_findings")
	overrides := strings.Index(sql, "CREATE TABLE campaign_assurance_overrides")
	if artifacts < 0 || configurations < 0 || targets < 0 || extractions < 0 ||
		findings < 0 || overrides < 0 || !(artifacts < configurations && configurations < targets &&
		targets < extractions && extractions < findings && findings < overrides) {
		t.Error("assurance evidence tables are not declared in dependency order")
	}

	staleTransition := strings.Index(sql, "OLD.state IN ('complete', 'incomplete') AND NEW.state = 'stale'")
	if staleTransition < 0 {
		t.Fatal("complete/incomplete to stale transition missing")
	}
	staleWindow := sql[staleTransition:]
	if end := strings.Index(staleWindow, "ELSE\n"); end >= 0 {
		staleWindow = staleWindow[:end]
	}
	if strings.Contains(staleWindow, "'gate_decision'") {
		t.Error("staleness must preserve the historical evaluated gate decision")
	}

	for _, table := range []string{
		"campaign_assurance_run_artifacts",
		"campaign_assurance_run_configurations",
		"campaign_assurance_run_targets",
		"campaign_assurance_extractions",
		"campaign_assurance_findings",
		"campaign_assurance_overrides",
	} {
		start := strings.Index(sql, "CREATE TABLE "+table)
		if start < 0 {
			continue
		}
		end := strings.Index(sql[start:], ");")
		if end > 0 && strings.Contains(sql[start:start+end], "REFERENCES tenants(id)") {
			t.Errorf("child table %s has a redundant direct tenant cascade", table)
		}
	}
}
