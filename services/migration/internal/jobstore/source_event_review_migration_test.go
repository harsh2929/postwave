package jobstore

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSourceEventReviewIndexMigrationIsCrashRetrySafe(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "infra", "migrations", "1741_migration_source_event_reviews.sql"))
	if err != nil {
		t.Fatalf("read source-event review migration: %v", err)
	}
	sql := strings.ToUpper(string(raw))
	commitAt := strings.Index(sql, "COMMIT;")
	dropAt := strings.Index(sql, "DROP INDEX CONCURRENTLY IF EXISTS")
	createAt := strings.Index(sql, "CREATE INDEX CONCURRENTLY\n")
	if commitAt < 0 || dropAt < 0 || createAt < 0 {
		t.Fatalf("migration must commit schema changes, drop a possibly invalid index concurrently, then recreate it concurrently")
	}
	if !(commitAt < dropAt && dropAt < createAt) {
		t.Fatalf("migration phase order is unsafe: commit=%d drop=%d create=%d", commitAt, dropAt, createAt)
	}
	if strings.Contains(sql, "CREATE INDEX CONCURRENTLY IF NOT EXISTS") {
		t.Fatal("IF NOT EXISTS can preserve an invalid index after an interrupted concurrent build")
	}
}
