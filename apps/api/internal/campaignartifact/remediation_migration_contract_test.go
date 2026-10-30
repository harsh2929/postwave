// SPDX-License-Identifier: AGPL-3.0-only

package campaignartifact

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestPatchApplicationMigrationContract(t *testing.T) {
	t.Parallel()
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source")
	}
	path := filepath.Clean(filepath.Join(filepath.Dir(sourceFile),
		"../../../../infra/migrations/1929_campaign_assurance_patch_applications.sql"))
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	sql := string(contents)
	for _, required := range []string{
		"CREATE TABLE campaign_assurance_patch_applications",
		"UNIQUE (tenant_id, request_id)",
		"UNIQUE (tenant_id, finding_id)",
		"base_content_revision_id <> created_content_revision_id",
		"campaign_updated_at         timestamptz NOT NULL",
		"findings.source_class = 'deterministic'",
		"findings.typed_patch_hash = NEW.typed_patch_hash",
		"runs.state = 'stale'",
		"campaign assurance patch applications are immutable",
		"ALTER TABLE campaign_assurance_patch_applications FORCE ROW LEVEL SECURITY",
		"AS RESTRICTIVE FOR ALL TO postwave_app",
		"actor_id = NULLIF(current_setting('app.user_id', true), '')::uuid",
		"users.role IN ('owner', 'admin', 'editor')",
		"GRANT SELECT, INSERT ON campaign_assurance_patch_applications TO postwave_app",
		"REVOKE UPDATE, DELETE, TRUNCATE ON campaign_assurance_patch_applications FROM postwave_app",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("migration missing %q", required)
		}
	}
	upper := strings.ToUpper(sql)
	for _, forbidden := range []string{
		"GRANT UPDATE ON CAMPAIGN_ASSURANCE_PATCH_APPLICATIONS",
		"GRANT DELETE ON CAMPAIGN_ASSURANCE_PATCH_APPLICATIONS",
	} {
		if strings.Contains(upper, forbidden) {
			t.Errorf("migration grants forbidden mutation: %s", forbidden)
		}
	}
}
