// SPDX-License-Identifier: AGPL-3.0-only
package inbound_email

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/migrationrunner"
)

func TestMigration1734DestroysPlaintextAndHardensDefinerLookup(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "infra", "migrations", "1734_inbound_email_secret_envelopes.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 1734: %v", err)
	}
	sql := string(raw)
	upper := strings.ToUpper(sql)
	for _, required := range []string{
		"ADD COLUMN IF NOT EXISTS SECRET_ENVELOPE BYTEA",
		"SET SECRET = 'ROTATION-REQUIRED'",
		"SECRET_ENVELOPE = NULL",
		"CHECK (SECRET = 'ROTATION-REQUIRED') NOT VALID",
		"VALIDATE CONSTRAINT INBOUND_EMAIL_ENDPOINTS_NO_PLAINTEXT_SECRET_CHK",
		"VALIDATE CONSTRAINT INBOUND_EMAIL_ENDPOINTS_ENVELOPE_STATE_CHK",
		"RETURNS TABLE (ID UUID, TENANT_ID UUID, SECRET_ENVELOPE BYTEA)",
		"SECURITY DEFINER",
		"SET SEARCH_PATH = PG_CATALOG",
		"REVOKE ALL ON FUNCTION PUBLIC.INBOUND_EMAIL_ENDPOINT_LOOKUP(TEXT) FROM PUBLIC",
	} {
		if !strings.Contains(upper, required) {
			t.Errorf("migration missing %q", required)
		}
	}
	if strings.Contains(upper, "RETURNS TABLE (ID UUID, TENANT_ID UUID, SECRET TEXT)") {
		t.Fatal("SECURITY DEFINER helper still returns plaintext")
	}

	findings := migrationrunner.AssessSafety([]migrationrunner.MigrationFile{{
		Version: "1734_inbound_email_secret_envelopes", Path: path, SQL: sql,
	}})
	for _, finding := range findings {
		if finding.Severity == migrationrunner.SafetyBlocker {
			t.Errorf("migration 1734 safety blocker %q at line %d: %s", finding.Rule, finding.Line, finding.Snippet)
		}
	}
}
