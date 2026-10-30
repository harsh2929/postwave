// SPDX-License-Identifier: AGPL-3.0-only
package referrals

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/migrationrunner"
)

func TestMigration1772PinsExactReferralCodeBoundary(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "infra", "migrations", "1772_referral_public_code_boundary.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 1772: %v", err)
	}
	file := migrationrunner.MigrationFile{
		Version: "1772_referral_public_code_boundary",
		Path:    path,
		SQL:     string(raw),
	}
	findings := migrationrunner.AssessSafety([]migrationrunner.MigrationFile{file})
	for _, finding := range findings {
		if finding.Severity == migrationrunner.SafetyBlocker {
			t.Errorf("migration 1772 safety blocker %q at line %d: %s",
				finding.Rule, finding.Line, finding.Snippet)
		}
	}
	for _, finding := range migrationrunner.AssessRollbackContracts(
		migrationrunner.AssessRollbackPlans([]migrationrunner.MigrationFile{file}, findings),
	) {
		if finding.Severity == migrationrunner.SafetyBlocker ||
			finding.Severity == migrationrunner.SafetyWarning {
			t.Errorf("migration 1772 rollback contract %s: %s",
				finding.Severity, finding.Message)
		}
	}

	sql := string(raw)
	required := []string{
		"CREATE ROLE postwave_referral_code_definer",
		"NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT",
		"NOREPLICATION BYPASSRLS",
		"CREATE TABLE public.referral_code_tokens",
		"token             text PRIMARY KEY",
		"ALTER TABLE public.referral_code_tokens ENABLE ROW LEVEL SECURITY",
		"ALTER TABLE public.referral_code_tokens FORCE ROW LEVEL SECURITY",
		"CREATE FUNCTION public.referral_code_resolve(p_token text)",
		"CREATE FUNCTION public.referral_code_tokens_sync()",
		"SECURITY DEFINER",
		"SET search_path = pg_catalog",
		"pg_catalog.pg_advisory_xact_lock",
		"ORDER BY distinct_token.token COLLATE \"C\"",
		"AFTER INSERT OR UPDATE OF code, desired_code, tenant_id, subscriber_id",
		"DROP POLICY IF EXISTS referral_codes_public_lookup ON public.referral_codes",
		"CREATE POLICY referral_codes_tenant_visible",
		"AS PERMISSIVE FOR ALL TO postwave_app",
		"REVOKE ALL ON FUNCTION public.referral_code_resolve(text)",
		"FROM PUBLIC, postwave_app, postwave_public",
		"GRANT EXECUTE ON FUNCTION public.referral_code_resolve(text)",
		"TO postwave_app",
		"pg_catalog.octet_length(p_token) > 64",
		"referral definer owns an out-of-bound object",
		"rollback-strategy: expand-contract",
		"Preflight:",
	}
	for _, fragment := range required {
		if !strings.Contains(sql, fragment) {
			t.Errorf("migration 1772 lost required contract %q", fragment)
		}
	}

	for _, forbidden := range []string{
		"CREATE POLICY referral_codes_public_lookup",
		"GRANT SELECT ON public.referral_code_tokens TO postwave_app",
		"GRANT SELECT ON public.referral_codes TO postwave_referral_code_definer",
		"USING (true)",
	} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("migration 1772 retained unsafe contract %q", forbidden)
		}
	}

	resolverStart := strings.Index(sql, "CREATE FUNCTION public.referral_code_resolve")
	if resolverStart < 0 {
		t.Fatal("resolver function is missing")
	}
	resolver := sql[resolverStart:]
	resolverEnd := strings.Index(resolver, "$function$;")
	if resolverEnd < 0 {
		t.Fatal("resolver function body terminator is missing")
	}
	resolver = resolver[:resolverEnd]
	if !strings.Contains(resolver, "FROM public.referral_code_tokens") ||
		strings.Contains(resolver, "FROM public.referral_codes") ||
		strings.Contains(resolver, "EXECUTE ") {
		t.Fatal("resolver must be fixed SQL over only the private token registry")
	}
}
