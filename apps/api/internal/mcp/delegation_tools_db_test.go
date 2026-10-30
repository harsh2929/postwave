// SPDX-License-Identifier: AGPL-3.0-only
//
// DB-backed test for apply_subscriber_tag (1.3b): the full delegation
// path — resolve subscriber by email, auto-create the tag by name, attach
// it idempotently. Skips without DATABASE_URL; reuses the bt* fixtures
// from batch_tools_db_test.go.
package mcp

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/tags"
)

func TestApplySubscriberTag_dbHappyPathAndIdempotent(t *testing.T) {
	pool := btDB(t)
	ctx := context.Background()
	tenantID := btTenant(t, pool, ctx)
	btSubscriber(t, pool, ctx, tenantID, "vip@batch.test")

	d := &Deps{Pool: pool, SubTagApply: &tags.SubscriberTagsRepo{Pool: pool}}
	reqCtx := middleware.WithTenant(ctx, &middleware.Tenant{ID: tenantID})
	args := json.RawMessage(`{"subscriber_id":"vip@batch.test","tag":"VIP"}`)

	out, err := handleApplySubscriberTag(reqCtx, d, args)
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	m := out.(map[string]any)
	if m["applied"] != true || m["tag_id"] == "" {
		t.Fatalf("expected applied=true with a tag_id, got %+v", m)
	}
	tagID, _ := m["tag_id"].(string)

	// The tag was auto-created by name, and the join row exists.
	tx, _ := db.WithTenant(ctx, pool, tenantID)
	var tagCount, joinCount int
	_ = tx.QueryRow(ctx, `SELECT count(*)::int FROM tags WHERE tenant_id=$1::uuid AND name='VIP'`, tenantID).Scan(&tagCount)
	_ = tx.QueryRow(ctx, `SELECT count(*)::int FROM subscriber_tags WHERE tenant_id=$1::uuid AND tag_id=$2::uuid`, tenantID, tagID).Scan(&joinCount)
	_ = tx.Rollback(ctx)
	if tagCount != 1 || joinCount != 1 {
		t.Fatalf("want tag=1 join=1, got tag=%d join=%d", tagCount, joinCount)
	}

	// Re-applying the same tag is a no-op (idempotent ON CONFLICT DO NOTHING):
	// still exactly one join row, same tag id.
	out2, err := handleApplySubscriberTag(reqCtx, d, args)
	if err != nil {
		t.Fatalf("re-apply: %v", err)
	}
	if out2.(map[string]any)["tag_id"] != tagID {
		t.Fatalf("re-apply should resolve the same tag id")
	}
	tx2, _ := db.WithTenant(ctx, pool, tenantID)
	var joinAfter int
	_ = tx2.QueryRow(ctx, `SELECT count(*)::int FROM subscriber_tags WHERE tenant_id=$1::uuid AND tag_id=$2::uuid`, tenantID, tagID).Scan(&joinAfter)
	_ = tx2.Rollback(ctx)
	if joinAfter != 1 {
		t.Fatalf("idempotent re-apply should leave 1 join row, got %d", joinAfter)
	}
}

// A non-existent subscriber surfaces a clean error (not a panic / not a
// silent success).
func TestApplySubscriberTag_dbUnknownSubscriber(t *testing.T) {
	pool := btDB(t)
	ctx := context.Background()
	tenantID := btTenant(t, pool, ctx)

	d := &Deps{Pool: pool, SubTagApply: &tags.SubscriberTagsRepo{Pool: pool}}
	reqCtx := middleware.WithTenant(ctx, &middleware.Tenant{ID: tenantID})
	_, err := handleApplySubscriberTag(reqCtx, d, json.RawMessage(`{"subscriber_id":"ghost@batch.test","tag":"VIP"}`))
	if err == nil {
		t.Fatal("expected an error for an unknown subscriber")
	}
}
