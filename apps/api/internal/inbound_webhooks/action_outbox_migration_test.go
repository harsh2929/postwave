// SPDX-License-Identifier: AGPL-3.0-only
package inbound_webhooks

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestInboundActionOutboxMigrationContract(t *testing.T) {
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	path := filepath.Clean(filepath.Join(
		filepath.Dir(source),
		"..", "..", "..", "..",
		"infra", "migrations", "1790_inbound_webhook_action_outbox.sql",
	))
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	sql := string(raw)
	for _, required := range []string{
		"CREATE TABLE IF NOT EXISTS inbound_webhook_replay_receipts",
		"CREATE TABLE IF NOT EXISTS inbound_webhook_action_intents",
		"REFERENCES inbound_events(id) ON DELETE CASCADE",
		"ALTER TABLE inbound_webhook_action_intents FORCE ROW LEVEL SECURITY",
		"app.outbox_worker",
		"FOR SELECT",
		"guard_inbound_webhook_action_intent_snapshot",
		"last_error_code",
		"octet_length(last_error_code) <= 64",
		"inbound_webhook_action_intents_original_uidx",
		"inbound_webhook_action_intents_replay_uidx",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("migration missing %q", required)
		}
	}
	if strings.Contains(strings.ToLower(sql), "last_error_message") ||
		strings.Contains(strings.ToLower(sql), "response_body") {
		t.Fatal("outbox migration must not retain raw error/response bodies")
	}
	workerRaw, err := os.ReadFile(filepath.Join(filepath.Dir(source), "action_worker.go"))
	if err != nil {
		t.Fatalf("read worker: %v", err)
	}
	if !strings.Contains(string(workerRaw), "FOR UPDATE SKIP LOCKED") {
		t.Fatal("action worker must claim with FOR UPDATE SKIP LOCKED")
	}
}

func TestInboundRetentionProtectsUnfinishedActionIntents(t *testing.T) {
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	path := filepath.Clean(filepath.Join(
		filepath.Dir(source),
		"..", "retention", "sweep_inbound_events.go",
	))
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read retention sweeper: %v", err)
	}
	sourceText := string(raw)
	for _, required := range []string{
		"NOT EXISTS",
		"inbound_webhook_action_intents",
		"action.state IN ('pending', 'leased')",
	} {
		if !strings.Contains(sourceText, required) {
			t.Errorf("retention guard missing %q", required)
		}
	}
}
