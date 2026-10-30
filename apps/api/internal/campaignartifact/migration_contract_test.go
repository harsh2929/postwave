// SPDX-License-Identifier: AGPL-3.0-only

package campaignartifact

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// TestArtifactFoundationMigrationContract keeps the immutable/tenant-safe
// artifact boundary visible in ordinary unit CI even when PostgreSQL-backed
// integration tests are not configured.
func TestArtifactFoundationMigrationContract(t *testing.T) {
	t.Parallel()
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve migration contract source")
	}
	migrationPath := filepath.Clean(filepath.Join(
		filepath.Dir(sourceFile),
		"../../../../infra/migrations/1920_campaign_assurance_artifact_foundation.sql",
	))
	contents, err := os.ReadFile(migrationPath)
	if err != nil {
		t.Fatalf("read campaign assurance artifact migration: %v", err)
	}
	sql := string(contents)
	required := []string{
		"ADD COLUMN IF NOT EXISTS source_mode text NOT NULL DEFAULT 'legacy_html'",
		"ADD COLUMN IF NOT EXISTS content_schema_version integer NOT NULL DEFAULT 1",
		"ADD COLUMN IF NOT EXISTS fact_contract jsonb NOT NULL DEFAULT '{}'::jsonb",
		"CREATE UNIQUE INDEX IF NOT EXISTS campaigns_tenant_id_id_uidx",
		"CREATE UNIQUE INDEX IF NOT EXISTS campaign_variants_tenant_id_id_uidx",
		"CREATE UNIQUE INDEX IF NOT EXISTS campaign_variants_tenant_campaign_id_uidx",
		"CREATE TABLE campaign_content_revisions",
		"UNIQUE (tenant_id, campaign_id, revision_no)",
		"UNIQUE (tenant_id, campaign_id, source_hash)",
		"CREATE TABLE campaign_send_plans",
		"request_hash           text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$')",
		"FOREIGN KEY (tenant_id, campaign_id, content_revision_id)",
		"CREATE TABLE campaign_render_artifacts",
		"FOREIGN KEY (tenant_id, campaign_id, send_plan_id)",
		"FOREIGN KEY (tenant_id, campaign_id, variant_id)",
		"UNIQUE (tenant_id, send_plan_id, scenario_id)",
		"mime_structure_hash",
		"outbound_mime_hash",
		"compiler_receipt",
		"representation_manifest",
		"campaign_content_revisions_append_only",
		"campaign_send_plans_delete_guard",
		"campaign_render_artifacts_append_only",
		"campaign_send_plans_lifecycle_guard",
		"campaign send plan inputs are immutable",
		"campaign send plan lifecycle is append-only",
		"ready_at may only be set by preparing -> ready",
		"invalid campaign send plan transition",
		"ALTER TABLE campaign_content_revisions FORCE ROW LEVEL SECURITY",
		"ALTER TABLE campaign_send_plans FORCE ROW LEVEL SECURITY",
		"ALTER TABLE campaign_render_artifacts FORCE ROW LEVEL SECURITY",
		"AS RESTRICTIVE FOR ALL TO postwave_app",
		"CREATE POLICY tenant_access",
		"GRANT SELECT, INSERT ON campaign_content_revisions TO postwave_app",
		"GRANT SELECT, INSERT, UPDATE ON campaign_send_plans TO postwave_app",
		"GRANT SELECT, INSERT ON campaign_render_artifacts TO postwave_app",
	}
	for _, fragment := range required {
		if !strings.Contains(sql, fragment) {
			t.Errorf("migration is missing artifact-foundation contract fragment %q", fragment)
		}
	}

	upper := strings.ToUpper(sql)
	for _, forbidden := range []string{
		"GRANT UPDATE ON CAMPAIGN_CONTENT_REVISIONS",
		"GRANT DELETE ON CAMPAIGN_CONTENT_REVISIONS",
		"GRANT UPDATE ON CAMPAIGN_RENDER_ARTIFACTS",
		"GRANT DELETE ON CAMPAIGN_RENDER_ARTIFACTS",
	} {
		if strings.Contains(upper, forbidden) {
			t.Errorf("append-only evidence has forbidden privilege %q", forbidden)
		}
	}

	revisionTable := strings.Index(sql, "CREATE TABLE campaign_content_revisions")
	planTable := strings.Index(sql, "CREATE TABLE campaign_send_plans")
	artifactTable := strings.Index(sql, "CREATE TABLE campaign_render_artifacts")
	if revisionTable < 0 || planTable < 0 || artifactTable < 0 ||
		!(revisionTable < planTable && planTable < artifactTable) {
		t.Error("revision, send-plan, and artifact tables must be declared in dependency order")
	}
	if strings.Contains(upper, "RECIPIENT_EMAIL") || strings.Contains(upper, "SUBSCRIBER_EMAIL") {
		t.Error("artifact foundation must not retain real-recipient identity/body data")
	}
}
