// SPDX-License-Identifier: AGPL-3.0-only

package customobjects

import (
	"os"
	"strings"
	"testing"
)

func TestCustomObjectVersionMigrationAndStoreStayCoupled(t *testing.T) {
	migration, err := os.ReadFile("../../../../infra/migrations/1999_custom_object_versions.sql")
	if err != nil {
		t.Fatalf("read custom-object version migration: %v", err)
	}
	migrationSource := string(migration)
	for _, required := range []string{
		"ALTER TABLE custom_object_types",
		"ALTER TABLE custom_object_records",
		"version bigint NOT NULL DEFAULT 1",
		"CHECK (version > 0)",
	} {
		if !strings.Contains(migrationSource, required) {
			t.Errorf("migration missing %q", required)
		}
	}

	store, err := os.ReadFile("store.go")
	if err != nil {
		t.Fatal(err)
	}
	storeSource := string(store)
	for _, required := range []string{
		"version = version + 1",
		"AND version = $5",
		"ON CONFLICT (tenant_id, object_type_id, external_id) DO NOTHING",
		"db.Audit(ctx, tx, auditMeta, \"custom_object.type.create\"",
		"db.Audit(ctx, tx, auditMeta, action, \"custom_object_record\"",
	} {
		if !strings.Contains(storeSource, required) {
			t.Errorf("store lost concurrency/audit contract %q", required)
		}
	}
}
