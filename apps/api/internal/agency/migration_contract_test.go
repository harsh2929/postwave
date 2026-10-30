// SPDX-License-Identifier: AGPL-3.0-only

package agency

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAgencyHardeningMigrationContainsNoAmbientCrossTenantPolicy(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "infra", "migrations",
		"2044_agency_security_hardening.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read hardening migration: %v", err)
	}
	source := string(raw)
	for _, required := range []string{
		"DROP POLICY IF EXISTS subscriber_events_agency_aggregator",
		"DROP POLICY IF EXISTS subscriber_events_agency_parent_select",
		"subscriber_events_agency_aggregator ON public.subscriber_events_legacy",
		"subscriber_events_agency_parent_select ON public.subscriber_events_legacy",
		"DROP POLICY IF EXISTS tenant_agency_children_select",
		"DROP VIEW IF EXISTS public.agency_child_usage_v",
		"CREATE POLICY tenant_billing_history_self",
		"CREATE ROLE postwave_agency_roster_definer",
		"NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT",
		"NOREPLICATION BYPASSRLS",
		"CREATE FUNCTION public.agency_list_children",
		"bound_tenant <> p_parent_id::text",
		"parent.is_agency_account = true",
		"p_limit > 201",
		"ORDER BY child.created_at, child.id",
		"SET search_path = pg_catalog, pg_temp",
		"SET row_security = off",
		"idx_tenants_agency_roster_page",
		"(parent_tenant_id, created_at, id)",
		"tenants_parent_billing_requires_parent",
		"agency_branding_updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP",
		"agency_branding_revision bigint NOT NULL DEFAULT 0",
	} {
		if !strings.Contains(source, required) {
			t.Errorf("2044 migration missing %q", required)
		}
	}
	for _, forbidden := range []string{
		"CREATE POLICY subscriber_events_agency_aggregator",
		"CREATE POLICY subscriber_events_agency_parent_select",
		"CREATE POLICY tenant_agency_children_select",
		"CREATE VIEW agency_child_usage_v",
		"CREATE VIEW public.agency_child_usage_v",
	} {
		if strings.Contains(source, forbidden) {
			t.Errorf("2044 migration recreates ambient surface %q", forbidden)
		}
	}
}
