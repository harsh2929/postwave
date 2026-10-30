// SPDX-License-Identifier: AGPL-3.0-only

package privacy

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Runs without a database so CI catches an authority regression even where the
// restricted-role proofs are skipped. The DB tests prove the guard behaves; this
// proves nobody widened the grant to get around it.
func TestCampaignReplyIdentityErasureMigrationIsNarrow(t *testing.T) {
	t.Parallel()
	path := filepath.Join("..", "..", "..", "..", "infra", "migrations",
		"1974_campaign_reply_identity_erasure.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	sql := string(raw)
	for _, required := range []string{
		"identity_redacted_at",
		"campaign_replies_identity_redaction_shape_check",
		"campaign_replies_evidence_update_guard",
		"GRANT UPDATE (recipient_email, subject, identity_redacted_at)",
		"campaign reply identity mutation must be one-way erasure",
		// The receipt must remain immutable: erasure proves what arrived, so a
		// recomputed digest would be indistinguishable from a forged one.
		"NEW.evidence_receipt_sha256 IS DISTINCT FROM OLD.evidence_receipt_sha256",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("migration is missing %q", required)
		}
	}
	for _, forbidden := range []string{
		"GRANT UPDATE ON campaign_replies",
		"GRANT UPDATE, DELETE ON campaign_replies",
		"GRANT ALL ON campaign_replies",
		"DELETE FROM campaign_replies",
		"DROP TABLE campaign_replies",
		// Restoring the pre-1965 blanket authority would defeat every guard.
		"GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_replies",
	} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("migration contains unsafe authority/destruction %q", forbidden)
		}
	}
	// The erasure transition must keep the body columns out of its grant: body
	// redaction is a separate, retention-worker-scoped transition.
	if strings.Contains(sql, "GRANT UPDATE (recipient_email, subject, identity_redacted_at, body_snippet") {
		t.Error("identity erasure grant must not also carry body columns")
	}
}
