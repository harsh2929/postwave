// SPDX-License-Identifier: AGPL-3.0-only
package campaigntemplates

import (
	"os"
	"strings"
	"testing"
)

func TestAuraPreviewProviderMigrationWidensCheckWithoutValidationGap(t *testing.T) {
	raw, err := os.ReadFile("../../../../infra/migrations/1853_campaign_template_aura_preview_provider.sql")
	if err != nil {
		t.Fatal(err)
	}
	migration := string(raw)
	for _, required := range []string{
		"ADD CONSTRAINT campaign_preview_assets_provider_chk_v2",
		"source_provider IN ('really_good_emails', 'aura_build')",
		"NOT VALID",
		"VALIDATE CONSTRAINT campaign_preview_assets_provider_chk_v2",
		"DROP CONSTRAINT campaign_preview_assets_provider_chk",
		"RENAME CONSTRAINT campaign_preview_assets_provider_chk_v2",
	} {
		if !strings.Contains(migration, required) {
			t.Fatalf("migration no longer contains %q", required)
		}
	}
	validated := strings.Index(migration, "VALIDATE CONSTRAINT campaign_preview_assets_provider_chk_v2")
	dropped := strings.Index(migration, "DROP CONSTRAINT campaign_preview_assets_provider_chk")
	if validated < 0 || dropped < 0 || validated > dropped {
		t.Fatal("replacement provider CHECK must be validated before the old CHECK is dropped")
	}
}
