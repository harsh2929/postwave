// SPDX-License-Identifier: AGPL-3.0-only

package retention

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCampaignReplyRetentionMigrationIsNarrowAndReceiptBacked(t *testing.T) {
	t.Parallel()
	path := filepath.Join("..", "..", "..", "..", "infra", "migrations", "1965_campaign_reply_evidence_retention.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	sql := string(raw)
	for _, required := range []string{
		"body_evidence_sha256",
		"evidence_receipt_sha256",
		"campaign_replies_evidence_insert_guard",
		"campaign_replies_evidence_update_guard",
		"REVOKE UPDATE, DELETE ON campaign_replies FROM postwave_app",
		"GRANT UPDATE (subscriber_id, body_snippet, body_stripped, body_redacted_at)",
		"app.retention_worker",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("migration is missing %q", required)
		}
	}
	for _, forbidden := range []string{
		"GRANT UPDATE, DELETE ON campaign_replies",
		"GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_replies",
		"DROP TABLE campaign_replies",
	} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("migration contains unsafe authority/destruction %q", forbidden)
		}
	}
}
