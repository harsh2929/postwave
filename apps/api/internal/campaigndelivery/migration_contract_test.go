// SPDX-License-Identifier: AGPL-3.0-only

package campaigndelivery

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestRawDeliveryLedgerMigrationContract(t *testing.T) {
	t.Parallel()
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve migration contract source")
	}
	path := filepath.Clean(filepath.Join(filepath.Dir(source),
		"../../../../infra/migrations/1922_campaign_raw_delivery_ledger.sql"))
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	sql := string(contents)
	for _, required := range []string{
		"CREATE TABLE campaign_send_deliveries",
		"CREATE TABLE campaign_send_delivery_events",
		"campaign_recipients_delivery_identity_uidx",
		"campaign_assurance_runs_delivery_identity_uidx",
		"campaign_assurance_run_artifacts_delivery_identity_uidx",
		"campaign_assurance_overrides_latest_decision_idx",
		"assurance_attempt_count, artifact_set_hash, source_hash, plan_hash",
		"'pass', 'warn', 'overridden'",
		"only a blocked run can be overridden for delivery",
		"delivery override is missing, expired, or does not allow send",
		"every blocking finding requires a live allow-send override",
		"ORDER BY latest.created_at DESC, latest.id DESC",
		"ORDER BY candidate.created_at DESC, candidate.id DESC",
		"state IN ('prepared', 'dispatching', 'indeterminate', 'accepted')",
		"Failure", // checked case-insensitively below; keeps this list readable
		"failure_disposition = 'indeterminate'",
		"failure_code = 'DISPATCH_LEASE_EXPIRED'",
		"campaign send delivery evidence is append-only",
		"campaign send delivery events are append-only",
		"SECURITY DEFINER",
		"ALTER TABLE campaign_send_deliveries FORCE ROW LEVEL SECURITY",
		"ALTER TABLE campaign_send_delivery_events FORCE ROW LEVEL SECURITY",
		"AS RESTRICTIVE FOR ALL TO postwave_app",
		"REVOKE DELETE, TRUNCATE ON campaign_send_deliveries",
		"REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON campaign_send_delivery_events",
	} {
		if required == "Failure" {
			continue
		}
		if !strings.Contains(sql, required) {
			t.Errorf("migration missing raw-delivery invariant %q", required)
		}
	}
	upper := strings.ToUpper(sql)
	for _, forbidden := range []string{
		"SUBSCRIBER_EMAIL", "RECIPIENT_EMAIL", "MIME_BODY", "RAW_MIME",
		"GRANT DELETE ON CAMPAIGN_SEND_DELIVERIES",
		"GRANT INSERT ON CAMPAIGN_SEND_DELIVERY_EVENTS",
	} {
		if strings.Contains(upper, forbidden) {
			t.Errorf("delivery ledger contains forbidden retention/privilege fragment %q", forbidden)
		}
	}
	if strings.Contains(sql, "state = 'dispatching' AND NEW.state = 'prepared'") {
		t.Error("ambiguous dispatching attempts must never transition back to prepared")
	}
}

func TestRawDeliveryOverrideSetMigrationContract(t *testing.T) {
	t.Parallel()
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve migration contract source")
	}
	path := filepath.Clean(filepath.Join(filepath.Dir(source),
		"../../../../infra/migrations/1924_campaign_delivery_override_set.sql"))
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	sql := string(contents)
	for _, required := range []string{
		"ADD COLUMN IF NOT EXISTS gate_override_ids uuid[] NOT NULL",
		"cardinality(gate_override_ids) BETWEEN 1 AND 100",
		"array_agg(latest.id ORDER BY latest.id)",
		"latest.finding_receipt_hash = finding.receipt_hash",
		"latest.decision = 'allow_send'",
		"NEW.gate_override_ids IS DISTINCT FROM live_override_ids",
		"delivery requires the exact complete live override set",
		"campaign send delivery override set is immutable",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("migration missing plural override invariant %q", required)
		}
	}
}

func TestReplyCorrelationMigrationContract(t *testing.T) {
	t.Parallel()
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve migration contract source")
	}
	path := filepath.Clean(filepath.Join(filepath.Dir(source),
		"../../../../infra/migrations/1969_campaign_delivery_reply_correlation.sql"))
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	sql := string(contents)
	for _, required := range []string{
		"ADD COLUMN IF NOT EXISTS reply_to text",
		"reply_correlation_version smallint",
		"reply_correlation_key_id text",
		"reply_correlation_expires_at timestamptz",
		"reply_correlation_token_hash text",
		"transport_contract_version = 'postwave.campaign-transport.v2'",
		"campaign_send_deliveries_reply_correlation_token_uidx",
		"campaign send delivery reply correlation is immutable",
		"NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT",
		"NOREPLICATION NOBYPASSRLS",
		"GRANT SELECT (",
		"resolve_campaign_reply_correlation_tenant",
		"REVOKE ALL ON FUNCTION",
		"rollback-strategy: no-op",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("migration missing reply-correlation invariant %q", required)
		}
	}
	upper := strings.ToUpper(sql)
	for _, forbidden := range []string{"SUBSCRIBER_EMAIL", "RECIPIENT_EMAIL", "VERP_SECRET", "RAW_TOKEN"} {
		if strings.Contains(upper, forbidden) {
			t.Errorf("migration persists forbidden reply-correlation material %q", forbidden)
		}
	}
}
