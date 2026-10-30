package views

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestCampaignAssuranceOpsMigrationContract(t *testing.T) {
	t.Parallel()
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve migration contract source")
	}
	path := filepath.Clean(filepath.Join(
		filepath.Dir(sourceFile),
		"../../../../../infra/migrations/1938_campaign_assurance_ops_view.sql",
	))
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read Campaign Assurance ops migration: %v", err)
	}
	sql := string(raw)
	required := []string{
		"CREATE ROLE postwave_campaign_assurance_ops_definer",
		"NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT",
		"NOREPLICATION NOBYPASSRLS",
		"CREATE FUNCTION public.ops_campaign_assurance_runs(",
		"CREATE FUNCTION public.ops_campaign_assurance_run_detail(",
		"CREATE FUNCTION public.ops_campaign_assurance_run_timeline(",
		"SECURITY DEFINER\nSET search_path = pg_catalog",
		"OWNER TO postwave_campaign_assurance_ops_definer",
		"GRANT EXECUTE ON FUNCTION public.ops_campaign_assurance_runs(",
		"GRANT EXECUTE ON FUNCTION public.ops_campaign_assurance_run_detail(uuid)",
		"GRANT EXECUTE ON FUNCTION public.ops_campaign_assurance_run_timeline(",
		"FROM PUBLIC, postwave_ops",
		"p_limit must be between 1 and 500",
		"LIMIT p_limit + 1",
		"campaign_assurance_runs_ops_support_select",
		"campaign_assurance_progress_events_ops_support_select",
		"GRANT SELECT (tenant_id, run_id, invocation_id, reserved_microunits)",
		"polcmd = 'r'",
		"policy.polroles = ARRAY[definer_oid]::oid[]",
		"NOT p.prosecdef",
		"ARRAY['search_path=pg_catalog']::text[]",
		"postwave_ops must not have Campaign Assurance base-table access",
	}
	for _, fragment := range required {
		if !strings.Contains(sql, fragment) {
			t.Errorf("migration is missing %q", fragment)
		}
	}
	if strings.Contains(sql, "SELECT runs.*") {
		t.Fatal("column-level definer cannot execute SELECT runs.*")
	}
	if count := strings.Count(sql, "SET search_path = pg_catalog\nAS $$"); count != 3 {
		t.Fatalf("fixed pg_catalog search_path function count=%d, want 3", count)
	}

	// Exact SQL identifiers which could carry customer content or provider
	// payloads must never enter a function body. Expiry timestamps and hashes
	// remain permitted operational metadata.
	for _, identifier := range []string{
		".subject", ".body_html", ".body_text", ".normalized_extraction",
		".raw_output_object_ref", ".observed_summary_object_ref",
		".observed_environment", ".capability_snapshot", ".metadata",
		".mailbox_id", ".provider_message_id_sha256", ".error_message",
		".claim_token", ".lease_owner", ".created_by",
	} {
		if strings.Contains(sql, identifier) {
			t.Errorf("migration references forbidden content-bearing identifier %q", identifier)
		}
	}
}
