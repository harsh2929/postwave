// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"context"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func TestReplayLineageSurvivesParentRetentionWithMultipleChildren(t *testing.T) {
	pool := newStoreTestPool(t)
	tenantID := "00000000-0000-0000-0000-000000ab0007"
	parentID, cleanup := seedLeaseRow(
		t,
		pool,
		tenantID,
		time.Now().UTC().Add(-time.Second),
	)
	defer cleanup()

	ctx := context.Background()
	workerTx, err := db.WithTenantWorker(ctx, (*db.Pool)(pool), tenantID)
	if err != nil {
		t.Fatalf("open tenant worker transaction: %v", err)
	}
	defer func() { _ = workerTx.Rollback(ctx) }()
	if _, err := workerTx.Exec(ctx, `
UPDATE outbound_webhook_deliveries
   SET status = 'exhausted',
       next_attempt_at = NULL,
       source_event_id = '55555555-5555-4555-8555-555555555555'::uuid
 WHERE id::text = $1`, parentID); err != nil {
		t.Fatalf("finalize parent: %v", err)
	}
	if err := workerTx.Commit(ctx); err != nil {
		t.Fatalf("commit parent finalization: %v", err)
	}

	store := &Store{Pool: (*db.Pool)(pool)}
	firstReplay, err := store.ReplayDelivery(ctx, tenantID, parentID, "lineage-child-1")
	if err != nil {
		t.Fatalf("create first replay: %v", err)
	}
	secondReplay, err := store.ReplayDelivery(ctx, tenantID, parentID, "lineage-child-2")
	if err != nil {
		t.Fatalf("create second replay: %v", err)
	}
	firstChild := firstReplay.DeliveryID
	secondChild := secondReplay.DeliveryID
	if firstChild == secondChild {
		t.Fatalf("replay children share delivery id %q", firstChild)
	}

	deleteTx, err := db.WithTenant(ctx, (*db.Pool)(pool), tenantID)
	if err != nil {
		t.Fatalf("open retention transaction: %v", err)
	}
	defer func() { _ = deleteTx.Rollback(ctx) }()
	if _, err := deleteTx.Exec(ctx, `
DELETE FROM outbound_webhook_deliveries
 WHERE tenant_id = $1::uuid
   AND id::text = $2`, tenantID, parentID); err != nil {
		t.Fatalf("delete retained parent: %v", err)
	}
	if err := deleteTx.Commit(ctx); err != nil {
		t.Fatalf("commit retained parent deletion: %v", err)
	}

	readTx, err := db.WithTenant(ctx, (*db.Pool)(pool), tenantID)
	if err != nil {
		t.Fatalf("open lineage read transaction: %v", err)
	}
	defer func() { _ = readTx.Rollback(ctx) }()
	for _, childID := range []string{firstChild, secondChild} {
		var gotParent string
		if err := readTx.QueryRow(ctx, `
SELECT parent_delivery_id::text
  FROM outbound_webhook_deliveries
 WHERE tenant_id = $1::uuid
   AND id::text = $2`, tenantID, childID).Scan(&gotParent); err != nil {
			t.Fatalf("load replay child %s: %v", childID, err)
		}
		if gotParent != parentID {
			t.Errorf("child %s parent = %q; want retained lineage %q", childID, gotParent, parentID)
		}
	}
	if err := readTx.Commit(ctx); err != nil {
		t.Fatalf("commit lineage read: %v", err)
	}
}
