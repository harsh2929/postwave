// SPDX-License-Identifier: AGPL-3.0-only

package intelligent_retry

import (
	"os"
	"strings"
	"testing"
)

func TestIntelligentRetryWorkerScopeMigrationContract(t *testing.T) {
	source, err := os.ReadFile("../../../../infra/migrations/1939_intelligent_retry_worker_scope.sql")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	for _, required := range []string{
		"CREATE POLICY intelligent_retry_worker_select ON intelligent_retry_events",
		"AS PERMISSIVE FOR SELECT TO postwave_app",
		"CREATE POLICY intelligent_retry_worker_update ON intelligent_retry_events",
		"AS PERMISSIVE FOR UPDATE TO postwave_app",
		"current_setting('app.outbox_worker', true) = 'true'",
		"current_setting('app.intelligent_retry_worker', true) = 'true'",
	} {
		if !strings.Contains(text, required) {
			t.Errorf("intelligent-retry worker migration lost contract %q", required)
		}
	}
	for _, forbidden := range []string{"FOR INSERT TO postwave_app", "FOR DELETE TO postwave_app"} {
		if strings.Contains(text, forbidden) {
			t.Errorf("intelligent-retry worker migration expanded capability with %q", forbidden)
		}
	}
}
