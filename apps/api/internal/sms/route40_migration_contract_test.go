// SPDX-License-Identifier: AGPL-3.0-only
package sms

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func readRoute40Migration(t *testing.T, name string) string {
	t.Helper()
	path := filepath.Join("..", "..", "..", "..", "infra", "migrations", name)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return string(raw)
}

func TestRoute40HistoricalPreflightsAreAtomicWithTheirWriteContracts(t *testing.T) {
	for _, tc := range []struct {
		name       string
		preflight  string
		validation string
	}{
		{
			name:       "1986_sms_message_write_contract.sql",
			preflight:  "sms_messages Route40 historical contract preflight failed",
			validation: "VALIDATE CONSTRAINT sms_messages_body_contract_check",
		},
		{
			name:       "1992_sms_private_projection_contract.sql",
			preflight:  "Route40 SMS private projection historical preflight failed",
			validation: "VALIDATE CONSTRAINT sms_campaigns_private_projection_check",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sql := readRoute40Migration(t, tc.name)
			if !strings.Contains(sql, tc.preflight) || !strings.Contains(sql, tc.validation) {
				t.Fatalf("%s must contain its count-only historical preflight and validation phase", tc.name)
			}
			if strings.Contains(strings.ToUpper(sql), "CONCURRENTLY") {
				t.Fatalf("%s must stay wholly transactional so a failed historical preflight rolls back the new write contract", tc.name)
			}
		})
	}

	for _, obsolete := range []string{
		"1988_sms_message_contract_preflight_validate.sql",
		"1993_sms_private_projection_preflight_validate.sql",
	} {
		path := filepath.Join("..", "..", "..", "..", "infra", "migrations", obsolete)
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("%s must not split historical preflight from the write-contract transaction", obsolete)
		}
	}
}

func TestRoute40ExistingTableIndexesUseConcurrentPhases(t *testing.T) {
	if sql := readRoute40Migration(t, "1980_sms_reply_dispatch_intents.sql"); strings.Contains(strings.ToUpper(sql), "CREATE INDEX") || strings.Contains(strings.ToUpper(sql), "CREATE UNIQUE INDEX") {
		t.Fatal("1980 must not build sms_messages indexes while holding its transactional table lock")
	}

	providerBinding := strings.ToUpper(readRoute40Migration(t, "1983_sms_provider_tenant_binding.sql"))
	if strings.Contains(providerBinding, "BEGIN;") || strings.Contains(providerBinding, "COMMIT;") {
		t.Fatal("1983 concurrent provider-receiver indexes must remain outside an explicit transaction")
	}
	if got := strings.Count(providerBinding, "CREATE UNIQUE INDEX CONCURRENTLY"); got != 2 {
		t.Fatalf("1983 concurrent unique-index count = %d, want 2", got)
	}

	replyIndexes := strings.ToUpper(readRoute40Migration(t, "1987_sms_unresolved_reply_uniqueness.sql"))
	if got := strings.Count(replyIndexes, "CREATE UNIQUE INDEX CONCURRENTLY"); got != 2 {
		t.Fatalf("1987 concurrent unique-index count = %d, want 2", got)
	}
	if got := strings.Count(replyIndexes, "CREATE INDEX CONCURRENTLY"); got != 1 {
		t.Fatalf("1987 concurrent non-unique-index count = %d, want 1", got)
	}
}
