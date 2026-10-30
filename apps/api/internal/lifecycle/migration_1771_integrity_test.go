// SPDX-License-Identifier: AGPL-3.0-only

package lifecycle

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMigration1771PinsLifecycleAggregateIntegrity(t *testing.T) {
	path := filepath.Join(
		"..", "..", "..", "..", "infra", "migrations",
		"1771_lifecycle_aggregate_integrity.sql",
	)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 1771: %v", err)
	}
	sql := string(raw)
	required := []string{
		"CREATE OR REPLACE FUNCTION public.subscribers_set_updated_at_monotonic()",
		"SET search_path = pg_catalog, public",
		"old_user_custom_fields jsonb := COALESCE(OLD.custom_fields, '{}'::jsonb) - '_listmonk_id'",
		"new_user_custom_fields jsonb := COALESCE(NEW.custom_fields, '{}'::jsonb) - '_listmonk_id'",
		"old_visible_row jsonb := to_jsonb(OLD) - 'updated_at' - 'custom_fields' - 'search_tsv' - 'pii_scan_revision'",
		"new_visible_row jsonb := to_jsonb(NEW) - 'updated_at' - 'custom_fields' - 'search_tsv' - 'pii_scan_revision'",
		"(NEW.custom_fields -> '_listmonk_id')",
		"IS DISTINCT FROM (OLD.custom_fields -> '_listmonk_id')",
		"NEW.updated_at := OLD.updated_at",
		"GREATEST(",
		"pg_catalog.clock_timestamp()",
		"OLD.updated_at + interval '1 microsecond'",
		"REVOKE ALL ON FUNCTION public.subscribers_set_updated_at_monotonic()",
		"DROP TRIGGER IF EXISTS subscribers_set_updated_at ON public.subscribers",
		"FOREIGN KEY (tenant_id, subscriber_id)",
		"REFERENCES public.subscribers (tenant_id, id)",
		"subscriber_lifecycle_events_previous_stage_check",
		"subscriber_lifecycle_events_next_stage_check",
		"subscriber_lifecycle_events_actual_transition_check",
		"subscriber_lifecycle_events_source_check",
		"subscriber_lifecycle_events_reason_check",
		"pg_catalog.char_length(reason) <= 500",
		"pg_catalog.octet_length(reason) <= 2048",
		"VALIDATE CONSTRAINT subscriber_lifecycle_tenant_subscriber_fkey",
		"VALIDATE CONSTRAINT subscriber_lifecycle_events_tenant_subscriber_fkey",
	}
	for _, fragment := range required {
		if !strings.Contains(sql, fragment) {
			t.Errorf("migration 1771 is missing %q", fragment)
		}
	}
	if strings.Contains(sql, "SECURITY DEFINER") {
		t.Fatal("subscriber revision trigger unexpectedly gained definer privileges")
	}
}
