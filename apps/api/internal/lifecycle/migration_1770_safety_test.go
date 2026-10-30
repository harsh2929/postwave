package lifecycle

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/migrationrunner"
)

func TestMigration1770HasNoSafetyBlockersAndPinsOrderedInboxBoundary(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "infra", "migrations", "1770_automation_lifecycle_event_inbox.sql")
	sqlBytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 1770: %v", err)
	}
	findings := migrationrunner.AssessSafety([]migrationrunner.MigrationFile{{
		Version: "1770_automation_lifecycle_event_inbox",
		Path:    path,
		SQL:     string(sqlBytes),
	}})
	for _, finding := range findings {
		if finding.Severity == migrationrunner.SafetyBlocker {
			t.Errorf("migration 1770 must deploy without AllowUnsafe; blocker %q at line %d: %s",
				finding.Rule, finding.Line, finding.Snippet)
		}
	}

	sql := string(sqlBytes)
	required := []string{
		"subscriber_lifecycle_events_sequence_unique",
		"subscriber_lifecycle_event_assign_sequence",
		"automation_lifecycle_event_inbox",
		"automation_lifecycle_event_dispatches",
		"automation_lifecycle_subscriber_cursors",
		"UNIQUE (tenant_id, subscriber_key, transition_sequence)",
		"FOREIGN KEY (tenant_id, subscriber_id)",
		"REFERENCES public.subscribers (tenant_id, id)",
		"ON DELETE SET NULL (subscriber_id)",
		"automation_lifecycle_terminalize_on_subscriber_delete",
		"migration-baseline:1770",
		"FORCE ROW LEVEL SECURITY",
		"GRANT UPDATE (",
		"NULLIF(current_setting('app.tenant_id', true), '')::uuid",
	}
	for _, contract := range required {
		if !strings.Contains(sql, contract) {
			t.Errorf("migration 1770 lost required contract %q", contract)
		}
	}

	// The inbox schema deliberately carries no mutable address or arbitrary
	// payload column. Email remains resolved just-in-time by the runtime.
	createInbox := sql[strings.Index(sql, "CREATE TABLE IF NOT EXISTS public.automation_lifecycle_event_inbox"):]
	createInbox = createInbox[:strings.Index(createInbox, ");")+2]
	for _, forbidden := range []string{"subscriber_email", " email ", " payload "} {
		if strings.Contains(strings.ToLower(createInbox), forbidden) {
			t.Errorf("PII-minimised inbox unexpectedly contains %q", forbidden)
		}
	}
}
