// SPDX-License-Identifier: AGPL-3.0-only
package inbound_email

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/migrationrunner"
)

func TestMigration1715IsForwardOnlyAndConcurrent(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "infra", "migrations", "1715_inbound_email_replay_identity.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 1715: %v", err)
	}
	text := string(raw)
	findings := migrationrunner.AssessSafety([]migrationrunner.MigrationFile{{
		Version: "1715_inbound_email_replay_identity", Path: path, SQL: text,
	}})
	for _, finding := range findings {
		if finding.Severity == migrationrunner.SafetyBlocker {
			t.Errorf("migration 1715 safety blocker %q at line %d: %s", finding.Rule, finding.Line, finding.Snippet)
		}
	}
	if !strings.Contains(strings.ToUpper(text), "CREATE UNIQUE INDEX CONCURRENTLY") {
		t.Error("replay index must be built concurrently on the live inbound_emails table")
	}
	if strings.Contains(strings.ToUpper(text), "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS") {
		t.Error("a failed concurrent build can leave an invalid index; IF NOT EXISTS would fail open on retry")
	}
	if strings.Contains(strings.ToUpper(text), "BEGIN;") {
		t.Error("CREATE INDEX CONCURRENTLY cannot run inside an explicit transaction")
	}
}
