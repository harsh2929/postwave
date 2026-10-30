// SPDX-License-Identifier: AGPL-3.0-only

package campaignassurance

import (
	"os"
	"strings"
	"testing"
)

func TestProgressEventMigrationContract(t *testing.T) {
	t.Parallel()

	raw, err := os.ReadFile("../../../../infra/migrations/1932_campaign_assurance_progress_events.sql")
	if err != nil {
		t.Fatalf("read progress migration: %v", err)
	}
	sql := string(raw)
	required := []string{
		"CREATE TABLE campaign_assurance_progress_events",
		"PRIMARY KEY (tenant_id, run_id, event_no)",
		"campaign_assurance_append_progress_event",
		"FOR UPDATE",
		"AFTER INSERT OR UPDATE ON campaign_assurance_runs",
		"AFTER INSERT ON campaign_assurance_extractions",
		"AFTER INSERT ON campaign_assurance_findings",
		"AFTER INSERT ON campaign_assurance_overrides",
		"AFTER INSERT ON campaign_assurance_model_invocation_reservations",
		"AFTER INSERT ON campaign_assurance_model_invocation_results",
		"ALTER TABLE campaign_assurance_progress_events FORCE ROW LEVEL SECURITY",
		"REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON campaign_assurance_progress_events FROM postwave_app",
		"contains no body, model output, recipient, seed credential, or lease secret",
	}
	for _, fragment := range required {
		if !strings.Contains(sql, fragment) {
			t.Errorf("progress migration is missing %q", fragment)
		}
	}

	forbidden := []string{
		"raw_output_object_ref",
		"claim_token'",
		"lease_owner'",
		"error_message'",
	}
	for _, fragment := range forbidden {
		if strings.Contains(sql, fragment) {
			t.Errorf("progress migration persists forbidden operational/content field %q", fragment)
		}
	}
}
