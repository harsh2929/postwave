// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/migrationrunner"
)

func TestMigration1789ReceiverAuthEnvelopeContract(t *testing.T) {
	t.Parallel()

	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	path := filepath.Clean(filepath.Join(
		filepath.Dir(source),
		"../../../../infra/migrations/1789_outbound_webhook_receiver_auth_envelopes.sql",
	))
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 1789: %v", err)
	}
	sql := string(raw)
	file := migrationrunner.MigrationFile{
		Version: "1789_outbound_webhook_receiver_auth_envelopes",
		Path:    path,
		SQL:     sql,
	}
	for _, finding := range migrationrunner.AssessSafety([]migrationrunner.MigrationFile{file}) {
		if finding.Severity == migrationrunner.SafetyBlocker {
			t.Errorf(
				"migration 1789 safety blocker %q at line %d: %s",
				finding.Rule,
				finding.Line,
				finding.Snippet,
			)
		}
	}
	for _, contract := range []string{
		"ADD COLUMN IF NOT EXISTS auth_config_envelope bytea",
		"ADD COLUMN IF NOT EXISTS auth_config_state text",
		"ADD COLUMN IF NOT EXISTS auth_config_restore_active boolean",
		"ADD COLUMN IF NOT EXISTS auth_config_paused_at timestamptz",
		"WHERE auth_config_state IS NULL",
		"'legacy_pending'",
		"'invalid'",
		"outbound_webhooks_auth_config_state_check",
		"outbound_webhooks_auth_config_metadata_safe_check",
		"octet_length(auth_config_envelope) BETWEEN 1 AND 262144",
		"COALESCE(auth_config->>'type', '') = 'encrypted'",
		"CREATE INDEX IF NOT EXISTS outbound_webhooks_auth_rewrap_pending_idx",
		"postwave_pause_delivery_for_receiver_auth",
		"outbound_webhook_delivery_receiver_auth_pause",
		"ALTER TABLE outbound_webhooks FORCE ROW LEVEL SECURITY",
		"Value-free receiver-auth metadata only",
	} {
		if !strings.Contains(sql, contract) {
			t.Errorf("migration 1789 missing contract %q", contract)
		}
	}
	if strings.Contains(strings.ToLower(sql), "pgp_sym_encrypt") ||
		strings.Contains(strings.ToLower(sql), "encode(auth_config") {
		t.Fatal("migration attempts credential transformation in SQL instead of the envelope worker")
	}
}
