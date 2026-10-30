package jobstore

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSourceEventOverlapMigrationAddsFailClosedDurableEvidence(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "infra", "migrations", "1742_migration_source_event_overlap_evidence.sql"))
	if err != nil {
		t.Fatalf("read source-event overlap migration: %v", err)
	}
	sql := strings.ToUpper(string(raw))
	for _, marker := range []string{
		"ADD COLUMN IF NOT EXISTS ENABLED_SINCE TIMESTAMPTZ",
		"ADD COLUMN IF NOT EXISTS FIRST_SUCCESSFUL_SYNC_AT TIMESTAMPTZ",
		"ADD COLUMN IF NOT EXISTS SUCCESSFUL_SYNC_COUNT INTEGER NOT NULL DEFAULT 0",
		"ADD COLUMN IF NOT EXISTS MAX_SUCCESS_GAP_SECONDS INTEGER NOT NULL DEFAULT 0",
		"CHECK (SUCCESSFUL_SYNC_COUNT >= 0)",
		"CHECK (MAX_SUCCESS_GAP_SECONDS >= 0)",
	} {
		if !strings.Contains(sql, marker) {
			t.Fatalf("source-event overlap migration is missing %q", marker)
		}
	}
	if strings.Contains(sql, "UPDATE MIGRATION_SOURCE_EVENT_MONITORS") {
		t.Fatal("legacy one-shot monitors must not be backfilled into continuous-overlap evidence")
	}
}
