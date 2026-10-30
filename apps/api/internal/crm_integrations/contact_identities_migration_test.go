// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestCRMContactProfileBindingMigrationIsTenantSafeAndOnline(t *testing.T) {
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	path := filepath.Clean(filepath.Join(
		filepath.Dir(sourceFile),
		"../../../../infra/migrations/1820_crm_contact_profile_bindings.sql",
	))
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	sql := string(raw)
	indexAt := strings.Index(sql, "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS crm_integrations_tenant_id_id_provider_uniq")
	ledgerIndexAt := strings.Index(sql, "CREATE INDEX CONCURRENTLY IF NOT EXISTS migration_imported_resources_hubspot_subscriber_source_idx")
	beginAt := strings.Index(sql, "BEGIN;")
	if indexAt < 0 || ledgerIndexAt < 0 || beginAt < 0 || indexAt > beginAt || ledgerIndexAt > beginAt {
		t.Fatalf("existing-table indexes must be built concurrently before BEGIN")
	}
	for _, fragment := range []string{
		"FOREIGN KEY (tenant_id, integration_id, provider)",
		"REFERENCES crm_integrations (tenant_id, id, provider)",
		"FOREIGN KEY (tenant_id, subscriber_id)",
		"REFERENCES subscribers (tenant_id, id)",
		"UNIQUE (tenant_id, integration_id, provider, provider_contact_id)",
		"source_revision_at",
		"ALTER TABLE crm_contact_profile_bindings ENABLE ROW LEVEL SECURITY",
		"ALTER TABLE crm_contact_profile_bindings FORCE ROW LEVEL SECURITY",
		"SET LOCAL lock_timeout = '5s'",
	} {
		if !strings.Contains(sql, fragment) {
			t.Fatalf("migration missing %q", fragment)
		}
	}
	if strings.Contains(sql, "subscriber_profile_id") {
		t.Fatal("binding must derive profile_id from the tenant-owned subscriber, not duplicate an unchecked UUID")
	}
}
