// SPDX-License-Identifier: AGPL-3.0-only

package campaignassurancequeue

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestCommandQueueMigrationContract(t *testing.T) {
	t.Parallel()
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve migration contract source")
	}
	path := filepath.Clean(filepath.Join(filepath.Dir(source),
		"../../../../infra/migrations/1925_campaign_assurance_command_queue.sql"))
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	sql := string(contents)
	for _, required := range []string{
		"-- migration-execution: phased",
		"CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS campaign_assurance_runs_command_identity_uidx",
		"SET LOCAL lock_timeout = '5s'",
		"CREATE TABLE campaign_assurance_commands",
		"tenant_id, campaign_id, id, request_id",
		"tenant_id               uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE",
		"campaign_assurance_commands_run_identity_fk",
		"UNIQUE (tenant_id, run_id)",
		"UNIQUE (tenant_id, campaign_id, request_id)",
		"campaign_assurance_command_identity_immutable",
		"OLD.completed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD",
		"ALTER TABLE campaign_assurance_commands FORCE ROW LEVEL SECURITY",
		"campaign_assurance_commands_tenant_insert",
		"campaign_assurance_commands_worker_select",
		"campaign_assurance_commands_worker_update",
		"current_setting('app.campaign_assurance_worker', true) = 'true'",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("migration missing command queue invariant %q", required)
		}
	}
	upper := strings.ToUpper(sql)
	for _, forbidden := range []string{
		"MIME_BODY", "RAW_MIME", "RECIPIENT_EMAIL", "SUBSCRIBER_EMAIL",
		"GRANT DELETE ON CAMPAIGN_ASSURANCE_COMMANDS",
		"CREATE POLICY CAMPAIGN_ASSURANCE_COMMANDS_TENANT_UPDATE",
	} {
		if strings.Contains(upper, forbidden) {
			t.Errorf("migration contains forbidden command queue fragment %q", forbidden)
		}
	}
	queueSource, err := os.ReadFile(filepath.Join(filepath.Dir(source), "queue.go"))
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{
		"FOR UPDATE SKIP LOCKED",
		"lease_expires_at <= clock_timestamp()",
		"lease_owner = $4::uuid",
		"lease_expires_at > clock_timestamp()",
		"has_table_privilege(",
		"relation.relrowsecurity AND relation.relforcerowsecurity",
		"pg_catalog.pg_policies",
	} {
		if !strings.Contains(string(queueSource), required) {
			t.Errorf("queue adapter missing lease invariant %q", required)
		}
	}
}
