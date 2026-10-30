// SPDX-License-Identifier: AGPL-3.0-only

package views

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestCampaignAssuranceSLOHealthMigrationContract(t *testing.T) {
	t.Parallel()
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve Campaign Assurance SLO migration test source")
	}
	path := filepath.Clean(filepath.Join(
		filepath.Dir(sourceFile),
		"../../../../../infra/migrations/1957_campaign_assurance_slo_health.sql",
	))
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read Campaign Assurance SLO migration: %v", err)
	}
	sql := string(raw)
	for _, required := range []string{
		"CREATE INDEX CONCURRENTLY IF NOT EXISTS",
		"campaign_assurance_runs_slo_terminal_24h_idx",
		"CREATE FUNCTION public.ops_campaign_assurance_slo_health()",
		"SECURITY DEFINER\nSET search_path = pg_catalog",
		"OWNER TO postwave_campaign_assurance_ops_definer",
		"FROM PUBLIC, postwave_app, postwave_ops",
		"TO postwave_ops",
		"orphaned_queued_runs",
		"expired_running_leases",
		"oldest_ready_command_age_seconds",
		"completed_at >= statement_timestamp() - interval '24 hours'",
		"Campaign Assurance SLO function ACL is broader than reviewed",
		"postwave_ops must not gain Campaign Assurance base-table SELECT",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("Campaign Assurance SLO migration is missing %q", required)
		}
	}
	for _, forbidden := range []string{
		".subject", ".body_html", ".body_text", ".normalized_extraction",
		".raw_output_object_ref", ".observed_summary_object_ref",
		".observed_environment", ".capability_snapshot", ".metadata",
		".mailbox_id", ".provider_message_id", ".error_message",
		".claim_token", ".lease_owner", ".created_by",
	} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("Campaign Assurance SLO migration references forbidden identifier %q", forbidden)
		}
	}
}
