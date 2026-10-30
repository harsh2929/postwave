// SPDX-License-Identifier: AGPL-3.0-only
package subscribers

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/migrationrunner"
)

var migration1764LineComment = regexp.MustCompile(`(?m)--[^\n]*$`)

func TestMigration1764ContactPerformanceIndexContract(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "infra", "migrations", "1764_subscriber_contact_performance_indexes.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 1764: %v", err)
	}
	file := migrationrunner.MigrationFile{
		Version: "1764_subscriber_contact_performance_indexes",
		Path:    path,
		SQL:     string(raw),
	}
	findings := migrationrunner.AssessSafety([]migrationrunner.MigrationFile{file})
	for _, finding := range findings {
		if finding.Severity == migrationrunner.SafetyBlocker {
			t.Errorf("migration 1764 safety blocker %q at line %d: %s", finding.Rule, finding.Line, finding.Snippet)
		}
	}
	for _, finding := range migrationrunner.AssessRollbackContracts(
		migrationrunner.AssessRollbackPlans([]migrationrunner.MigrationFile{file}, findings),
	) {
		if finding.Severity == migrationrunner.SafetyBlocker || finding.Severity == migrationrunner.SafetyWarning {
			t.Errorf("migration 1764 rollback contract %s: %s", finding.Severity, finding.Message)
		}
	}

	upperRaw := strings.ToUpper(string(raw))
	if !strings.Contains(upperRaw, "-- ROLLBACK-STRATEGY: NO-OP") ||
		!strings.Contains(upperRaw, "-- ROLLBACK-DETAILS:") ||
		!strings.Contains(upperRaw, "-- PREFLIGHT:") {
		t.Error("migration 1764 must declare explicit preflight and rollback operator contracts")
	}

	statements := strings.ToUpper(migration1764LineComment.ReplaceAllString(string(raw), ""))
	statements = strings.Join(strings.Fields(statements), " ")
	for _, forbidden := range []string{"CREATE TABLE", "CREATE POLICY", "ALTER TABLE", "DROP INDEX"} {
		if strings.Contains(statements, forbidden) {
			t.Errorf("migration 1764 contains forbidden non-additive/transactional SQL %q", forbidden)
		}
	}
	if strings.Count(statements, "BEGIN;") != 1 || strings.Count(statements, "COMMIT;") != 1 {
		t.Fatal("migration 1764 must have one transaction for the role/function phase")
	}
	if strings.Index(statements, "BEGIN;") < strings.LastIndex(statements, "CREATE INDEX CONCURRENTLY") {
		t.Fatal("both concurrent indexes must complete before the transactional function phase")
	}
	if strings.Count(statements, "CREATE INDEX CONCURRENTLY IF NOT EXISTS") != 2 {
		t.Fatalf("migration 1764 must contain exactly two idempotent concurrent indexes: %s", statements)
	}
	if !strings.Contains(statements,
		"ON CAMPAIGN_RECIPIENTS (TENANT_ID, SUBSCRIBER_EMAIL, SENT_AT DESC) WHERE STATUS = 'SENT' AND SENT_AT IS NOT NULL") {
		t.Error("recipient index must exactly match the tenant/CITEXT/sent-at query and partial predicate")
	}
	if !strings.Contains(statements,
		"ON CONVERSIONS (TENANT_ID, SUBSCRIBER_EMAIL, OCCURRED_AT DESC) INCLUDE (AMOUNT_CENTS, CURRENCY) WHERE SUBSCRIBER_EMAIL IS NOT NULL AND AMOUNT_CENTS IS NOT NULL") {
		t.Error("conversion index must exactly match the monetary tenant/CITEXT/window query and cover amount/currency")
	}
	if strings.Contains(statements, "LOWER(SUBSCRIBER_EMAIL)") {
		t.Error("1764 must use the CITEXT column directly because the production predicates use CITEXT equality")
	}
	for _, required := range []string{
		"CREATE ROLE POSTWAVE_SUBSCRIBER_METRICS_DEFINER NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION BYPASSRLS",
		"GRANT SELECT (TENANT_ID, SUBSCRIBER_EMAIL, STATUS, SENT_AT) ON PUBLIC.CAMPAIGN_RECIPIENTS TO POSTWAVE_SUBSCRIBER_METRICS_DEFINER",
		"CREATE FUNCTION PUBLIC.SUBSCRIBER_CONTACT_SENT_COUNT(",
		"RETURNS BIGINT LANGUAGE PLPGSQL STABLE SECURITY DEFINER SET SEARCH_PATH = PG_CATALOG",
		"AUTHENTICATED_TENANT <> P_TENANT_ID::TEXT",
		"REVOKE ALL ON FUNCTION PUBLIC.SUBSCRIBER_CONTACT_SENT_COUNT(",
		"FROM PUBLIC; GRANT EXECUTE ON FUNCTION PUBLIC.SUBSCRIBER_CONTACT_SENT_COUNT(",
		"TO POSTWAVE_APP",
	} {
		if !strings.Contains(statements, required) {
			t.Errorf("migration 1764 is missing hardened sent-count contract %q", required)
		}
	}
}
