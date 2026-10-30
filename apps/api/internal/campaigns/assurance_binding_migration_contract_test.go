// SPDX-License-Identifier: AGPL-3.0-only

package campaigns

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestRecipientAssuranceBindingMigrationContract(t *testing.T) {
	t.Parallel()
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve source path")
	}
	path := filepath.Clean(filepath.Join(filepath.Dir(source),
		"../../../../infra/migrations/1923_campaign_recipient_assurance_binding.sql"))
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	sql := string(contents)
	for _, required := range []string{
		"ADD COLUMN IF NOT EXISTS content_revision_id",
		"ADD COLUMN IF NOT EXISTS assurance_run_id",
		"assurance_artifact_set_hash",
		"assurance_override_ids uuid[]",
		"campaign_recipients_assurance_revision_fk",
		"campaign_recipients_assurance_plan_fk",
		"campaign_recipients_assurance_run_fk",
		"campaign recipient assurance binding is immutable",
		"campaign_recipients_assurance_pending_idx",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("migration missing assurance binding invariant %q", required)
		}
	}
	if strings.Contains(strings.ToUpper(sql), "RAW_MIME") ||
		strings.Contains(strings.ToUpper(sql), "RECIPIENT_EMAIL") {
		t.Error("queue authorization binding must not add MIME or duplicate recipient PII")
	}
}
