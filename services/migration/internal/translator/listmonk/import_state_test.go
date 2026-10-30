package listmonk

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/postwave/migrate/canonical"
)

func TestImportedResourceTypeConstraintCoversTrackedResourceConstants(t *testing.T) {
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime caller unavailable")
	}
	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(filename), "..", "..", "..", "..", ".."))
	var sql string
	for _, name := range []string{
		"1695_migration_imported_resource_type_parity.sql",
		"1736_migration_tenant_safe_subscriber_lists.sql",
	} {
		raw, err := os.ReadFile(filepath.Join(repoRoot, "infra", "migrations", name))
		if err != nil {
			t.Fatalf("read resource-type parity migration %s: %v", name, err)
		}
		sql += string(raw)
	}
	for _, resourceType := range []string{
		ResourceSubscriber,
		ResourceList,
		ResourceSegment,
		ResourceAutomation,
		ResourceCampaignArchive,
		ResourceCampaign,
		ResourceCampaignEvent,
		ResourceTemplate,
		ResourcePaidSubscription,
		ResourceSourceArchive,
		ResourceAutomationJourney,
		ResourcePopupForm,
		ResourceLandingPage,
		ResourceCommerceIntegration,
	} {
		if !strings.Contains(sql, "'"+resourceType+"'") {
			t.Fatalf("migration_imported_resources resource_type check is missing %q", resourceType)
		}
	}
}

func TestTrackedPostgresDestinationSnapshotCoverage(t *testing.T) {
	tracked := []string{
		ResourceSegment,
		ResourceAutomation,
		ResourceCampaignArchive,
		ResourceCampaign,
		ResourceCampaignEvent,
		ResourcePaidSubscription,
		ResourceSourceArchive,
		ResourceAutomationJourney,
		ResourcePopupForm,
		ResourceLandingPage,
		ResourceCommerceIntegration,
	}
	for _, resourceType := range tracked {
		resourceType := resourceType
		t.Run(resourceType, func(t *testing.T) {
			query, ok := trackedPostgresDestinationSnapshotQuery(ImportedResource{
				ResourceType:   resourceType,
				SourcePlatform: canonical.SourceMailchimp,
			})
			if !ok || !strings.Contains(query, "to_jsonb(destination_row)") {
				t.Fatalf("snapshot query for %q = %q, tracked=%v", resourceType, query, ok)
			}
			if resourceType == ResourceCampaignEvent {
				if strings.Contains(query, "FOR UPDATE") {
					t.Fatalf("campaign report snapshot must leave locking to governed rollback: %q", query)
				}
			} else if !strings.Contains(query, "FOR UPDATE") {
				t.Fatalf("snapshot query for %q is missing FOR UPDATE: %q", resourceType, query)
			}
		})
	}
	for _, resourceType := range []string{ResourceSubscriber, ResourceList, ResourceTemplate} {
		if query, ok := trackedPostgresDestinationSnapshotQuery(ImportedResource{ResourceType: resourceType}); ok {
			t.Fatalf("external/custom rollback resource %q unexpectedly uses generic Postgres snapshot query %q", resourceType, query)
		}
	}
}
