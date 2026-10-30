// SPDX-License-Identifier: AGPL-3.0-only

package sms

import (
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/migrationrunner"
)

func TestRoute42SuppressionOverlayMigrationIsFailClosedAndMixedVersionSafe(t *testing.T) {
	const name = "1994_sms_suppression_manual_overlay.sql"
	sql := readRoute40Migration(t, name)
	for _, required := range []string{
		"ADD COLUMN manual_overlay_state text;",
		"WHEN reason = 'manual' AND source = 'manual' THEN 'none'",
		"ELSE 'legacy_unknown'",
		"ALTER COLUMN manual_overlay_state SET DEFAULT 'none'",
		"ALTER COLUMN manual_overlay_state SET NOT NULL",
		"IF TG_OP = 'INSERT' THEN",
		"OLD.reason = 'manual' AND OLD.source = 'manual'",
		"NEW.manual_overlay_state := 'preserved'",
		"OLD.reason <> NEW.reason OR OLD.source <> NEW.source",
		"NEW.manual_overlay_state := 'legacy_unknown'",
		"pg_trigger_depth() > 1",
		"SELECT 1 FROM public.tenants WHERE id = OLD.tenant_id",
		"BEFORE DELETE ON sms_suppressions",
		"CREATE OR REPLACE FUNCTION public.sms_policy_set_updated_at_monotonic()",
		"GREATEST(clock_timestamp(), OLD.updated_at + interval '1 microsecond')",
		"DROP TRIGGER IF EXISTS sms_quiet_hours_set_updated_at ON sms_quiet_hours",
		"DROP TRIGGER IF EXISTS sms_keyword_responses_set_updated_at ON sms_keyword_responses",
		"CREATE OR REPLACE FUNCTION public.sms_quiet_hours_country_scope_write_guard()",
		"IF NEW.country_code <> '' THEN",
		"OLD.country_code <> '' AND NEW.enabled",
		"CONSTRAINT = 'sms_quiet_hours_country_scope_write_guard'",
		"BEFORE INSERT OR UPDATE ON sms_quiet_hours",
		"Route42 SMS suppression overlay historical preflight failed",
		"VALIDATE CONSTRAINT sms_suppressions_manual_overlay_check",
		"rollback-strategy: expand-contract",
		"new binary against an old schema",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("%s missing mixed-version/safety contract %q", name, required)
		}
	}
	for _, forbidden := range []string{
		"prior_manual_metadata",
		"jsonb_build_object('prior_authority'",
		"public.sms_uuid_v4_valid(id) AND public.sms_uuid_v4_valid(tenant_id)",
		"current_setting('app.tenant_id', true)",
	} {
		if strings.Contains(sql, forbidden) {
			t.Fatalf("%s retained unsafe/over-narrow contract %q", name, forbidden)
		}
	}

	file := migrationrunner.MigrationFile{Version: "1994_sms_suppression_manual_overlay", SQL: sql}
	for _, finding := range migrationrunner.AssessSafety([]migrationrunner.MigrationFile{file}) {
		if finding.Severity == migrationrunner.SafetyBlocker {
			t.Fatalf("migration safety blocker %q line %d: %s", finding.Rule, finding.Line, finding.Snippet)
		}
	}
	plans := migrationrunner.AssessRollbackPlans([]migrationrunner.MigrationFile{file}, nil)
	if len(plans) != 1 || !plans[0].Explicit || plans[0].Strategy != migrationrunner.RollbackStrategyExpandContract || strings.TrimSpace(plans[0].Details) == "" {
		t.Fatalf("explicit expand/contract rollback plan missing: %#v", plans)
	}
}

func TestRoute42MigrationDoesNotDuplicateLegacyManualMetadata(t *testing.T) {
	sql := readRoute40Migration(t, "1994_sms_suppression_manual_overlay.sql")
	functionStart := strings.Index(sql, "CREATE OR REPLACE FUNCTION public.sms_suppression_preserve_manual_overlay")
	if functionStart < 0 {
		t.Fatal("overlay trigger function start missing")
	}
	functionEnd := strings.Index(sql[functionStart:], "REVOKE ALL ON FUNCTION public.sms_suppression_preserve_manual_overlay")
	if functionEnd < 0 {
		t.Fatal("overlay trigger function bounds missing")
	}
	function := sql[functionStart : functionStart+functionEnd]
	if strings.Contains(function, "OLD.metadata") || strings.Contains(function, "prior_manual_metadata") {
		t.Fatalf("overlay trigger copies arbitrary legacy metadata:\n%s", function)
	}
	if !strings.Contains(function, "NEW.metadata := '{}'::jsonb") {
		t.Fatal("manual restoration must minimize metadata to an empty object")
	}
}

func TestRoute42PrerequisiteCreatesUserTenantKeyBeforeSMSForeignKeys(t *testing.T) {
	migration1827 := readRoute40Migration(t, "1827_campaign_template_discovery_state.sql")
	if !strings.Contains(migration1827, "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS\n    users_tenant_id_id_campaign_template_uidx") ||
		!strings.Contains(migration1827, "ON users (tenant_id, id)") {
		t.Fatal("migration 1827 must provide the online users(tenant_id,id) reference target")
	}

	migration1989 := readRoute40Migration(t, "1989_sms_tenant_reference_integrity.sql")
	adoptionAt := strings.Index(migration1989, "ADD CONSTRAINT users_tenant_id_id_unique UNIQUE USING INDEX users_tenant_id_id_campaign_template_uidx")
	foreignKeyAt := strings.Index(migration1989, "sms_conversation_state_assignee_tenant_fk")
	if adoptionAt < 0 || foreignKeyAt <= adoptionAt {
		t.Fatalf("migration 1989 must adopt the migration-1827 users key before defining user tenant FKs: adoption=%d fk=%d", adoptionAt, foreignKeyAt)
	}
	if strings.Contains(migration1989, "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS users_tenant_id_id_uidx") {
		t.Fatal("migration 1989 must not duplicate the existing users(tenant_id,id) index")
	}

	migration1993 := readRoute40Migration(t, "1993_helpdesk_tenant_integrity.sql")
	for _, required := range []string{"requires users_tenant_id_id_unique from migration 1989", "users_tenant_id_id_unique"} {
		if !strings.Contains(migration1993, required) {
			t.Fatalf("migration 1993 must reuse the ordered prerequisite %q", required)
		}
	}
	for _, obsolete := range []string{
		"CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS users_tenant_id_id_uidx",
		"USING INDEX users_tenant_id_id_uidx",
		"users_tenant_id_id_helpdesk_uidx",
		"users_tenant_id_id_helpdesk_unique",
	} {
		if strings.Contains(migration1993, obsolete) {
			t.Fatalf("migration 1993 retained a late duplicate user tenant key %q", obsolete)
		}
	}
}

func TestRoute42ReadIndexesAreOnlineAndQueryShaped(t *testing.T) {
	const name = "1995_sms_route42_read_indexes.sql"
	sql := readRoute40Migration(t, name)
	for _, required := range []string{
		"migration-execution: phased",
		"rollback-strategy: no-op",
		"CREATE INDEX CONCURRENTLY IF NOT EXISTS sms_suppressions_tenant_created_id_idx",
		"ON sms_suppressions (tenant_id, created_at DESC, id DESC)",
		"CREATE INDEX CONCURRENTLY IF NOT EXISTS sms_suppressions_tenant_reason_created_id_idx",
		"ON sms_suppressions (tenant_id, reason, created_at DESC, id DESC)",
		"CREATE INDEX CONCURRENTLY IF NOT EXISTS sms_consent_events_tenant_granted_keyword_idx",
		"ON sms_consent_events (tenant_id, (metadata->>'keyword'))",
		"WHERE action = 'granted' AND metadata ? 'keyword'",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("%s missing online/query-shape contract %q", name, required)
		}
	}
	if strings.Contains(sql, "sms_suppressions (tenant_id, phone_e164)") {
		t.Fatal("1995 duplicates the existing exact-phone unique index")
	}
	file := migrationrunner.MigrationFile{Version: "1995_sms_route42_read_indexes", SQL: sql}
	for _, finding := range migrationrunner.AssessSafety([]migrationrunner.MigrationFile{file}) {
		if finding.Severity == migrationrunner.SafetyBlocker {
			t.Fatalf("migration safety blocker %q line %d: %s", finding.Rule, finding.Line, finding.Snippet)
		}
	}
	plans := migrationrunner.AssessRollbackPlans([]migrationrunner.MigrationFile{file}, nil)
	if len(plans) != 1 || !plans[0].Explicit || plans[0].Strategy != migrationrunner.RollbackStrategyNoOp || strings.TrimSpace(plans[0].Details) == "" {
		t.Fatalf("explicit no-op rollback plan missing: %#v", plans)
	}
}
