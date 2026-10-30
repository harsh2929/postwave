// SPDX-License-Identifier: AGPL-3.0-only

package pushsuppressions

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

func TestMigration1996MixedVersionAndPrivacyContract(t *testing.T) {
	body, err := os.ReadFile("../../../../infra/migrations/1996_push_suppression_authorities.sql")
	if err != nil {
		t.Fatalf("read migration 1996: %v", err)
	}
	source := string(body)
	for _, required := range []string{
		"LOCK TABLE public.tenants IN SHARE ROW EXCLUSIVE MODE",
		"LOCK TABLE public.push_token_suppressions IN SHARE ROW EXCLUSIVE MODE",
		"push_devices_suppressible_token_preflight",
		"ADD CONSTRAINT push_devices_suppressible_token_check",
		"CREATE TABLE push_suppression_registry_state",
		"PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE",
		"ALTER TABLE push_suppression_registry_state FORCE ROW LEVEL SECURITY",
		"registry_visible_revision bigint",
		"registry_hidden_revision  bigint",
		"registry_active_updated_at timestamptz",
		"registry_active_version bigint",
		"GRANT SELECT ON push_suppression_registry_state TO postwave_app",
		"CREATE ROLE postwave_push_suppression_revision_definer",
		"NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT",
		"GRANT SELECT, INSERT, UPDATE ON public.push_suppression_registry_state",
		"CREATE OR REPLACE FUNCTION public.push_suppression_registry_seed_tenant()",
		"CREATE OR REPLACE FUNCTION public.push_suppression_authority_visibility_lock()",
		"SECURITY DEFINER",
		"SET search_path TO 'pg_catalog', 'public', 'pg_temp'",
		"OWNER TO postwave_push_suppression_revision_definer",
		"REVOKE CREATE ON SCHEMA public FROM postwave_push_suppression_revision_definer",
		"CREATE TABLE push_suppression_authorities",
		"push_suppression_authorities_legacy_time_preflight",
		"push_suppression_authorities_projection_time_check",
		"created_at <  timestamptz '2100-01-01 00:00:00+00'",
		"authority IN ('manual', 'provider', 'user', 'complaint', 'legacy_unknown')",
		"ALTER TABLE push_suppression_authorities FORCE ROW LEVEL SECURITY",
		"GRANT SELECT, INSERT, UPDATE ON push_suppression_authorities TO postwave_app",
		"AFTER INSERT OR UPDATE ON push_token_suppressions",
		"CREATE TRIGGER push_suppression_authority_00_statement_lock_trg",
		"CREATE TRIGGER push_suppression_legacy_00_statement_lock_trg",
		"CREATE TRIGGER push_suppression_device_00_statement_lock_trg",
		"CREATE TRIGGER push_suppression_subscriber_delete_00_statement_lock_trg",
		"CREATE TRIGGER push_suppression_tenant_delete_00_statement_lock_trg",
		"CREATE OR REPLACE FUNCTION public.push_suppression_reject_truncate()",
		"CREATE TRIGGER push_suppression_authority_reject_truncate_trg",
		"CREATE TRIGGER push_suppression_legacy_reject_truncate_trg",
		"CREATE TRIGGER push_suppression_state_reject_truncate_trg",
		"CREATE TRIGGER push_suppression_device_reject_truncate_trg",
		"CREATE TRIGGER push_suppression_authority_immutable_guard_trg",
		"NEW.revoked_at := GREATEST(",
		"NEW.registry_hidden_at := GREATEST(",
		"pg_trigger_depth() > 1 AND NOT EXISTS",
		"WHEN source = 'dashboard' AND reason = 'manual'",
		"THEN 'manual' ELSE 'legacy_unknown' END",
		"-- rollback-strategy: expand-contract",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("migration 1996 lost contract fragment %q", required)
		}
	}
	tenantBarrierAt := strings.Index(source, "LOCK TABLE public.tenants IN SHARE ROW EXCLUSIVE MODE")
	legacyBarrierAt := strings.Index(source, "LOCK TABLE public.push_token_suppressions IN SHARE ROW EXCLUSIVE MODE")
	legacyPreflightAt := strings.Index(source, "FROM push_token_suppressions\n       WHERE created_at <")
	devicePreflightAt := strings.Index(source, "FROM push_devices\n       WHERE octet_length(token) NOT BETWEEN")
	deviceConstraintAt := strings.Index(source, "ADD CONSTRAINT push_devices_suppressible_token_check")
	registryBackfillAt := strings.Index(source, "INSERT INTO push_suppression_registry_state (tenant_id, revision)\nSELECT id, 0 FROM tenants")
	registrySeedTriggerAt := strings.Index(source, "CREATE TRIGGER push_suppression_registry_seed_tenant_trg")
	legacyBackfillAt := strings.Index(source, "INSERT INTO push_suppression_authorities (\n    tenant_id, device_token_hash")
	legacyStatementTriggerAt := strings.Index(source, "CREATE TRIGGER push_suppression_legacy_00_statement_lock_trg")
	legacyTriggerAt := strings.Index(source, "CREATE TRIGGER push_suppression_sync_legacy_authority_trg")
	if tenantBarrierAt < 0 || legacyBarrierAt < 0 || legacyPreflightAt < 0 || devicePreflightAt < 0 ||
		deviceConstraintAt < 0 || registryBackfillAt < 0 || registrySeedTriggerAt < 0 ||
		legacyBackfillAt < 0 || legacyStatementTriggerAt < 0 || legacyTriggerAt < 0 ||
		!(tenantBarrierAt < legacyBarrierAt &&
			legacyBarrierAt < legacyPreflightAt &&
			legacyPreflightAt < legacyBackfillAt &&
			legacyBackfillAt < legacyTriggerAt &&
			legacyBarrierAt < devicePreflightAt &&
			devicePreflightAt < deviceConstraintAt &&
			legacyBarrierAt < registryBackfillAt &&
			tenantBarrierAt < registryBackfillAt &&
			registryBackfillAt < registrySeedTriggerAt &&
			legacyBackfillAt < legacyStatementTriggerAt &&
			legacyStatementTriggerAt < legacyTriggerAt) {
		t.Fatalf("deployment barriers must lock tenants then legacy before preflight/backfill/trigger installation: tenants=%d legacy=%d legacy-preflight=%d device-preflight=%d device-constraint=%d registry-backfill=%d registry-seed-trigger=%d authority-backfill=%d statement-trigger=%d sync-trigger=%d",
			tenantBarrierAt, legacyBarrierAt, legacyPreflightAt, devicePreflightAt,
			deviceConstraintAt, registryBackfillAt, registrySeedTriggerAt,
			legacyBackfillAt, legacyStatementTriggerAt, legacyTriggerAt)
	}
	prefixThroughSyncTrigger := source[:legacyTriggerAt]
	if strings.Contains(prefixThroughSyncTrigger, "-- migration-execution: phased") ||
		regexp.MustCompile(`(?im)^\s*COMMIT\s*;`).MatchString(prefixThroughSyncTrigger) {
		t.Fatal("migration 1996 must remain one atomic transaction so deployment barriers survive through sync-trigger installation")
	}
	for _, forbidden := range []string{
		"GRANT DELETE ON push_suppression_authorities",
		"GRANT SELECT, INSERT, UPDATE, DELETE ON push_suppression_authorities",
		"SELECT tenant_id, device_token_hash, platform, metadata",
		"GRANT INSERT ON push_suppression_registry_state TO postwave_app",
		"GRANT UPDATE ON push_suppression_registry_state TO postwave_app",
		"GRANT DELETE ON push_suppression_registry_state TO postwave_app",
		"GRANT ALL ON push_suppression_registry_state TO postwave_app",
	} {
		if strings.Contains(source, forbidden) {
			t.Fatalf("migration 1996 contains unsafe fragment %q", forbidden)
		}
	}
	normalized := strings.Join(strings.Fields(source), " ")
	for _, forbiddenGrant := range []*regexp.Regexp{
		regexp.MustCompile(`(?i)GRANT\s+[^;]*(?:INSERT|UPDATE|DELETE|TRUNCATE)[^;]*\s+ON\s+(?:public\.)?push_suppression_registry_state\s+TO\s+postwave_app\s*;`),
		regexp.MustCompile(`(?i)GRANT\s+ALL(?:\s+PRIVILEGES)?\s+ON\s+(?:TABLE\s+)?(?:public\.)?push_suppression_registry_state\s+TO\s+postwave_app\s*;`),
	} {
		if forbiddenGrant.MatchString(normalized) {
			t.Fatalf("migration 1996 grants app registry-state mutation: %q", forbiddenGrant.FindString(normalized))
		}
	}
}
