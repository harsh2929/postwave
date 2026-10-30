// SPDX-License-Identifier: AGPL-3.0-only

package chatdelivery

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// TestChatDeliveryLogRoundTrip proves INTG-033 Slice B: Log appends success +
// failure rows and List returns them newest-first, scoped to the integration.
func TestChatDeliveryLogRoundTrip(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)

	// A real tenant: chat_delivery_log.tenant_id references tenants(id) (migration 2045).
	// Its teardown removes every row this test logs, for both integrations, and
	// fails the test if it cannot. The test used to register a second cleanup
	// of its own that discarded every error.
	tenantID, integrationID := seedChatTenant(t, pool)
	otherIntegration := "00000000-0000-0000-0000-00000cd100b2"

	if err = Log(ctx, pool, tenantID, "slack", integrationID, "campaign.sent", nil); err != nil {
		t.Fatalf("Log success: %v", err)
	}
	if err = Log(ctx, pool, tenantID, "slack", integrationID, "test", errors.New("status 500: boom")); err != nil {
		t.Fatalf("Log failure: %v", err)
	}
	// A row for a different integration must not leak into the list.
	if err = Log(ctx, pool, tenantID, "slack", otherIntegration, "test", nil); err != nil {
		t.Fatalf("Log other: %v", err)
	}

	items, err := List(ctx, pool, tenantID, integrationID, 50)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("expected 2 rows for the integration, got %d", len(items))
	}
	// Newest-first: the failed "test" row was logged last.
	if items[0].Status != "failed" || items[0].EventType != "test" {
		t.Fatalf("newest row mismatch: %+v", items[0])
	}
	if items[0].Error == "" {
		t.Fatalf("failed row should carry an error message")
	}
	if items[1].Status != "success" || items[1].EventType != "campaign.sent" {
		t.Fatalf("older row mismatch: %+v", items[1])
	}
}
