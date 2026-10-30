// SPDX-License-Identifier: AGPL-3.0-only
package retention

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestPlaygroundRetentionExpiresPayloadWithoutRemovingReinsertionFence(t *testing.T) {
	t.Parallel()
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve source path")
	}
	sweeper, err := os.ReadFile(filepath.Join(filepath.Dir(source), "sweep_webhooks.go"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(sweeper)
	for _, contract := range []string{
		"SET state='ambiguous', outcome='transport_ambiguous'",
		"PlaygroundPendingAmbiguityAfter",
		"FOR UPDATE SKIP LOCKED",
		"SET state='receipt_expired', receipt_envelope=NULL",
		"receipt_sha256=NULL, subject_email_sha256s='{}'::text[]",
		"receipt_expired_at=now()",
	} {
		if !strings.Contains(text, contract) {
			t.Errorf("playground retention missing %q", contract)
		}
	}
	if strings.Contains(text, "DELETE FROM outbound_webhook_playground_fires") {
		t.Fatal("playground retention deletes the durable identity fence")
	}

	migration, err := os.ReadFile(filepath.Join(
		filepath.Dir(source), "..", "..", "..", "..", "infra", "migrations",
		"2007_webhook_playground_fire_receipts.sql",
	))
	if err != nil {
		t.Fatal(err)
	}
	migrationText := string(migration)
	if !strings.Contains(migrationText, "PRIMARY KEY (tenant_id,fire_id)") ||
		!strings.Contains(migrationText, "UNIQUE (tenant_id,idempotency_key_sha256)") ||
		!strings.Contains(migrationText, "state='receipt_expired'") {
		t.Fatal("receipt_expired does not retain both uniqueness fences")
	}
}
