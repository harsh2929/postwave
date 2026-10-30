// SPDX-License-Identifier: AGPL-3.0-only

package exports

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExportAttemptKeysAreFencedByLease(t *testing.T) {
	t.Parallel()
	tenantID := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	jobID := "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	first := exportObjectKey(tenantID, jobID, "cccccccc-cccc-4ccc-8ccc-cccccccccccc")
	second := exportObjectKey(tenantID, jobID, "dddddddd-dddd-4ddd-8ddd-dddddddddddd")
	if first == second || !strings.HasSuffix(first, "/cccccccc-cccc-4ccc-8ccc-cccccccccccc.zip") {
		t.Fatalf("attempt-scoped object keys = %q / %q", first, second)
	}
}

func TestExportPersistedSelectionFailsClosed(t *testing.T) {
	t.Parallel()
	if !validResourceSelection([]string{"subscribers", "campaigns"}) {
		t.Fatal("supported unique selection rejected")
	}
	for _, selection := range [][]string{
		nil,
		{},
		{"subscribers", "subscribers"},
		{"not-a-resource"},
	} {
		if validResourceSelection(selection) {
			t.Fatalf("invalid persisted selection accepted: %#v", selection)
		}
	}
}

func TestExportFailureMessagesNeverPersistInternalCause(t *testing.T) {
	t.Parallel()
	secret := "s3://private-bucket/tenant/key?credential=secret"
	for _, code := range []string{
		"invalid_selection",
		"temporary_file",
		"bundle_write",
		"bundle_too_large",
		"data_read",
		"retention_policy",
		"storage_write",
		"finalize",
		"unknown",
	} {
		message := exportFailureMessage(code)
		if message == "" || strings.Contains(message, secret) || strings.Contains(message, "s3://") {
			t.Fatalf("unsafe public failure for %q: %q", code, message)
		}
	}
}

func TestExportLeaseMigrationAndWorkerFencingStayComposed(t *testing.T) {
	t.Parallel()
	worker, err := os.ReadFile("worker.go")
	if err != nil {
		t.Fatalf("read worker.go: %v", err)
	}
	migrationPath := filepath.Join("..", "..", "..", "..", "infra", "migrations", "2026_tenant_export_worker_leases.sql")
	migration, err := os.ReadFile(migrationPath)
	if err != nil {
		t.Fatalf("read lease migration: %v", err)
	}
	stackPath := filepath.Join("..", "..", "..", "..", "infra", "aws", "cloudformation", "postwave-stack.yaml")
	stack, err := os.ReadFile(stackPath)
	if err != nil {
		t.Fatalf("read CloudFormation stack: %v", err)
	}
	for name, source := range map[string]string{
		"worker":    string(worker),
		"migration": string(migration),
		"stack":     string(stack),
	} {
		var fragments []string
		switch name {
		case "worker":
			fragments = []string{
				"lease_expires_at <= clock_timestamp()",
				"candidate.previous_lease_token::text",
				"AND lease_token = $3::uuid",
				"AND lease_token = $7::uuid",
				"exportFailureMessage(code)",
			}
		case "migration":
			fragments = []string{
				"ADD COLUMN IF NOT EXISTS lease_token uuid",
				"ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz",
				"ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz",
				"ADD COLUMN IF NOT EXISTS bundle_sha256 text",
				"tenant_exports_private_object_binding",
				"CREATE INDEX CONCURRENTLY IF NOT EXISTS tenant_exports_expired_lease_idx",
			}
		case "stack":
			fragments = []string{
				"Id: ExpireOrphanedExportAttempts",
				"Prefix: tenant-exports/",
				"ExpirationInDays: 2556",
			}
		}
		for _, fragment := range fragments {
			if !strings.Contains(source, fragment) {
				t.Fatalf("%s no longer contains %q", name, fragment)
			}
		}
	}
}
