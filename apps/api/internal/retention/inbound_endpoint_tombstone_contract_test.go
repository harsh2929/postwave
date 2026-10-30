// SPDX-License-Identifier: AGPL-3.0-only
package retention

import (
	"os"
	"strings"
	"testing"
)

func TestInboundEndpointTombstonesJoinRetentionLifecycle(t *testing.T) {
	t.Parallel()

	sweepRaw, err := os.ReadFile("sweep_inbound_webhook_endpoints.go")
	if err != nil {
		t.Fatalf("read endpoint sweeper: %v", err)
	}
	sweep := string(sweepRaw)
	for _, contract := range []string{
		"db.WithTenant(ctx, s.Pool, tenantID)",
		"endpoint.deleted_at < now() - ($2::int * interval '1 day')",
		"FROM inbound_events AS event",
		"FROM inbound_webhook_action_intents AS action",
		"FOR UPDATE SKIP LOCKED",
		"purge_deleted_inbound_webhook_endpoint",
	} {
		if !strings.Contains(sweep, contract) {
			t.Errorf("endpoint tombstone sweeper missing %q", contract)
		}
	}

	rawPayloads, err := os.ReadFile("raw_payloads.go")
	if err != nil {
		t.Fatalf("read retention fanout: %v", err)
	}
	fanout := string(rawPayloads)
	for _, contract := range []string{
		`{"deleted_inbound_webhook_endpoints"`,
		"SELECT DISTINCT tenant_id::text FROM inbound_webhook_endpoints WHERE deleted_at IS NOT NULL",
	} {
		if !strings.Contains(fanout, contract) {
			t.Errorf("retention fanout missing %q", contract)
		}
	}
}
