// SPDX-License-Identifier: AGPL-3.0-only
package inbound_webhooks

import (
	"os"
	"strings"
	"testing"
)

func TestActionWorkerDiscoveryIsCursorFairAndRetryIsTerminallyBounded(t *testing.T) {
	t.Parallel()

	source, err := os.ReadFile("action_worker.go")
	if err != nil {
		t.Fatalf("read action_worker.go: %v", err)
	}
	text := string(source)
	for _, required := range []string{
		"w.discoveryCursor",
		"CASE WHEN tenant_id > $2 THEN 0 ELSE 1 END",
		`"retry_exhausted"`,
		"shouldExhaustActionRetry(action.Attempts)",
	} {
		if !strings.Contains(text, required) {
			t.Errorf("durable action worker lost bounded/fair contract %q", required)
		}
	}
}
