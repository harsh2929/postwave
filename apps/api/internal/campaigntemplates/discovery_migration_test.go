// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"os"
	"strings"
	"testing"
)

func TestCampaignTemplateDiscoveryMigrationContract(t *testing.T) {
	raw, err := os.ReadFile("../../../../infra/migrations/1827_campaign_template_discovery_state.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	sql := string(raw)
	for _, marker := range []string{
		"campaign_template_recent_views",
		"campaign_template_collections",
		"campaign_template_collection_items",
		"campaign_template_saved_searches",
		"users_tenant_id_id_campaign_template_uidx",
		"template_favorites_user_isolation",
		"current_setting('app.user_id', true)",
		"UNIQUE (collection_id, position)",
		"CHECK (position BETWEEN 0 AND 99)",
		"octet_length(filters::text) <= 16384",
		"campaign_template_discovery_assert_visible_template",
		"tenant_id IS NULL OR tenant_id = NEW.tenant_id",
		"campaign_template_recent_views_visible_template",
		"campaign_template_collection_items_visible_template",
		"ENABLE ROW LEVEL SECURITY",
		"FORCE ROW LEVEL SECURITY",
	} {
		if !strings.Contains(sql, marker) {
			t.Fatalf("migration missing %q", marker)
		}
	}
	if strings.Contains(sql, "DISABLE ROW LEVEL SECURITY") {
		t.Fatal("migration weakens RLS")
	}
}

func TestCampaignTemplateDiscoveryConcurrencyMigrationContract(t *testing.T) {
	raw, err := os.ReadFile("../../../../infra/migrations/1829_campaign_template_discovery_concurrency.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	sql := string(raw)
	for _, marker := range []string{
		"campaign_template_collections_create_key_uidx",
		"campaign_template_saved_searches_create_key_uidx",
		"create_idempotency_key",
		"create_request_hash",
		"campaign_template_discovery_bump_version",
		"NEW.version := OLD.version + 1",
		"campaign_template_collections_bump_version",
		"campaign_template_saved_searches_bump_version",
		"CHECK (version > 0)",
		"octet_length(create_idempotency_key) BETWEEN 1 AND 255",
		"create_request_hash ~ '^[0-9a-f]{64}$'",
	} {
		if !strings.Contains(sql, marker) {
			t.Fatalf("concurrency migration missing %q", marker)
		}
	}
	if strings.Contains(sql, "DISABLE ROW LEVEL SECURITY") {
		t.Fatal("concurrency migration weakens RLS")
	}
}

func TestCampaignTemplateCatalogGoalProjectionMigrationContract(t *testing.T) {
	raw, err := os.ReadFile("../../../../infra/migrations/1830_campaign_template_catalog_goal_projection.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	sql := string(raw)
	for _, marker := range []string{
		"campaign_template_project_catalog_goal",
		"published_from_tenant_template_id",
		"source.goal",
		"source.source_provider = NEW.source_provider",
		"source.source_external_id = NEW.source_external_id",
		"campaign_templates_project_catalog_goal",
		"BEFORE INSERT OR UPDATE OF",
		"platform.goal IS DISTINCT FROM source.goal",
		"REVOKE ALL ON FUNCTION",
	} {
		if !strings.Contains(sql, marker) {
			t.Fatalf("catalog goal projection migration missing %q", marker)
		}
	}
	if strings.Contains(sql, "DISABLE ROW LEVEL SECURITY") {
		t.Fatal("catalog goal projection migration weakens RLS")
	}
}
