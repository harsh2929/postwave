// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"os"
	"strings"
	"testing"
)

func TestResponseRedactionUsesWorkerRLSAndGlobalOldestBatch(t *testing.T) {
	t.Parallel()

	source, err := os.ReadFile("redact.go")
	if err != nil {
		t.Fatalf("read redact.go: %v", err)
	}
	text := string(source)
	for _, required := range []string{
		"db.WithWorkerScope(ctx, w.Pool)",
		"ORDER BY created_at, id",
		"FOR UPDATE SKIP LOCKED",
		"LIMIT $2",
		"tenant_id = $3::uuid",
	} {
		if !strings.Contains(text, required) {
			t.Errorf("response redaction lost worker-scope contract %q", required)
		}
	}
	if strings.Contains(text, "w.Pool.Query(ctx") {
		t.Error("response redaction regressed to an unscoped FORCE-RLS query")
	}
}
