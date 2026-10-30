// SPDX-License-Identifier: AGPL-3.0-only

package polls

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestCampaignPollPaginationMigrationIndexesBothStableKeysets(t *testing.T) {
	t.Parallel()
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate pagination migration test")
	}
	path := filepath.Clean(filepath.Join(filepath.Dir(sourceFile),
		"../../../../infra/migrations/2028_campaign_poll_list_pagination.sql"))
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read campaign poll pagination migration: %v", err)
	}
	sql := string(body)
	for _, required := range []string{
		"CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_polls_campaign_created_id_idx",
		"ON campaign_polls (tenant_id, campaign_id, created_at, id)",
		"CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_polls_revision_created_id_idx",
		"tenant_id, campaign_id, content_revision_id, created_at, id",
		"WHERE content_revision_id IS NOT NULL",
		"RESET statement_timeout",
		"RESET lock_timeout",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("pagination migration omitted %q", required)
		}
	}
}
