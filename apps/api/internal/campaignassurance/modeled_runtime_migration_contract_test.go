// SPDX-License-Identifier: AGPL-3.0-only

package campaignassurance

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestModeledCacheAndCostMigrationContract(t *testing.T) {
	t.Parallel()
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve migration contract source")
	}
	path := filepath.Clean(filepath.Join(
		filepath.Dir(sourceFile),
		"../../../../infra/migrations/1931_campaign_assurance_modeled_cache_and_cost_budget.sql",
	))
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read modeled runtime migration: %v", err)
	}
	sql := string(contents)
	for _, required := range []string{
		"max_modeled_cost_microunits",
		"CREATE TABLE campaign_assurance_model_invocation_reservations",
		"CREATE TABLE campaign_assurance_model_invocation_results",
		"campaign assurance modeled run cost budget exhausted",
		"FOR UPDATE",
		"reserved_microunits > parent_budget",
		"NEW.cost_microunits > reservation.reserved_microunits",
		"status = 'charge_unknown'",
		"execution_kind = 'invoked'",
		"execution_kind = 'cache_reuse'",
		"source_run.state = 'complete'",
		"source.raw_output_expires_at > statement_timestamp()",
		"source.reused_from_extraction_id IS NULL",
		"source_run.tenant_id = source.tenant_id",
		"source_run.configuration_manifest_hash = current_run.configuration_manifest_hash",
		"source_run.normalization_version = current_run.normalization_version",
		"source_run.scoring_version = current_run.scoring_version",
		"source_run.prompt_suite_hash = current_run.prompt_suite_hash",
		"ALTER TABLE campaign_assurance_model_invocation_reservations FORCE ROW LEVEL SECURITY",
		"ALTER TABLE campaign_assurance_model_invocation_results FORCE ROW LEVEL SECURITY",
		"AS RESTRICTIVE FOR ALL TO postwave_app",
		"REVOKE UPDATE, DELETE, TRUNCATE ON campaign_assurance_model_invocation_reservations",
		"REVOKE UPDATE, DELETE, TRUNCATE ON campaign_assurance_model_invocation_results",
		"ambiguous calls are never refunded",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("migration missing modeled cache/cost fragment %q", required)
		}
	}
	upper := strings.ToUpper(sql)
	for _, forbidden := range []string{
		"ON DELETE SET NULL",
		"GRANT UPDATE ON CAMPAIGN_ASSURANCE_MODEL_INVOCATION",
		"GRANT DELETE ON CAMPAIGN_ASSURANCE_MODEL_INVOCATION",
		"SOURCE_RUN.STATE IN ('COMPLETE', 'STALE')",
		"EXECUTION_KIND IN ('INVOKED', 'CACHE_REUSE', 'PARTIAL')",
	} {
		if strings.Contains(upper, forbidden) {
			t.Errorf("migration contains forbidden modeled cache/cost fragment %q", forbidden)
		}
	}
}
