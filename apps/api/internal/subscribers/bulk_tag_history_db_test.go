// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"context"
	"fmt"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// TestBulkTagVerbs_AreVisibleInTagHistory closes a gap that was invisible from
// both ends: membership was always correct, so nothing looked broken, while the
// surface whose job is answering "who applied this tag and when" had no record
// of the operation at all.
func TestBulkTagVerbs_AreVisibleInTagHistory(t *testing.T) {
	pool := newBulkVerbsTestPool(t)
	tenantID := uuid.NewString()
	seedBulkVerbsTenant(t, pool, tenantID)
	id := seedBulkVerbsSubscriber(t, pool, tenantID,
		fmt.Sprintf("bulk-taghistory-%d@example.test", time.Now().UnixNano()), "enabled")

	d := &Deps{Repo: &Repo{Pool: pool}}

	w := httptest.NewRecorder()
	d.BulkTag(w, bulkVerbsRequest(tenantID, "/api/v1/subscribers/bulk/tag",
		fmt.Sprintf(`{"subscriber_ids":[%q],"tag":"vip"}`, id)))
	if res := decodeBulkResult(t, w); res.Affected != 1 {
		t.Fatalf("bulk tag affected = %d, want 1 (body=%s)", res.Affected, w.Body.String())
	}

	applied := tagHistoryRows(t, pool, tenantID, "bulk_applied")
	if len(applied) != 1 {
		t.Fatalf("bulk_applied history rows = %d, want 1 — the bulk tag verb is "+
			"invisible to tag history", len(applied))
	}
	// The id must be resolved, not left NULL: an event with no tag_id does not
	// appear in per-tag history, which is where anyone would actually look.
	if applied[0].tagID == "" {
		t.Fatalf("bulk_applied row has no tag_id; per-tag history will not show it")
	}
	if applied[0].tagName != "vip" || applied[0].source != "subscribers_bulk" {
		t.Fatalf("bulk_applied row = %+v, want tag 'vip' from source 'subscribers_bulk'", applied[0])
	}

	w = httptest.NewRecorder()
	d.BulkUntag(w, bulkVerbsRequest(tenantID, "/api/v1/subscribers/bulk/untag",
		fmt.Sprintf(`{"subscriber_ids":[%q],"tag":"vip"}`, id)))
	if res := decodeBulkResult(t, w); res.Affected != 1 {
		t.Fatalf("bulk untag affected = %d, want 1 (body=%s)", res.Affected, w.Body.String())
	}
	if unapplied := tagHistoryRows(t, pool, tenantID, "bulk_unapplied"); len(unapplied) != 1 {
		t.Fatalf("bulk_unapplied history rows = %d, want 1", len(unapplied))
	}
}

// TestBulkTagThatChangedNothingWritesNoHistory keeps the new row honest.
//
// Re-tagging people who already carry the tag changes nothing. A history row
// there would report a tag application that did not happen, in the one surface
// that must not have false positives.
func TestBulkTagThatChangedNothingWritesNoHistory(t *testing.T) {
	pool := newBulkVerbsTestPool(t)
	tenantID := uuid.NewString()
	seedBulkVerbsTenant(t, pool, tenantID)
	id := seedBulkVerbsSubscriber(t, pool, tenantID,
		fmt.Sprintf("bulk-taghistory-noop-%d@example.test", time.Now().UnixNano()), "enabled")

	d := &Deps{Repo: &Repo{Pool: pool}}
	body := fmt.Sprintf(`{"subscriber_ids":[%q],"tag":"vip"}`, id)

	w := httptest.NewRecorder()
	d.BulkTag(w, bulkVerbsRequest(tenantID, "/api/v1/subscribers/bulk/tag", body))
	if res := decodeBulkResult(t, w); res.Affected != 1 {
		t.Fatalf("first tag affected = %d, want 1", res.Affected)
	}

	w = httptest.NewRecorder()
	d.BulkTag(w, bulkVerbsRequest(tenantID, "/api/v1/subscribers/bulk/tag", body))
	if res := decodeBulkResult(t, w); res.Affected != 0 {
		t.Fatalf("second tag affected = %d, want 0 (already tagged)", res.Affected)
	}

	if rows := tagHistoryRows(t, pool, tenantID, "bulk_applied"); len(rows) != 1 {
		t.Fatalf("bulk_applied rows after a no-op re-tag = %d, want 1 — a call that "+
			"changed nothing recorded that it did", len(rows))
	}
}

type tagHistoryRow struct {
	tagID   string
	tagName string
	source  string
}

func tagHistoryRows(t *testing.T, pool *pgxpool.Pool, tenantID, action string) []tagHistoryRow {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open tag_history tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT COALESCE(tag_id::text, ''), COALESCE(tag_name, ''), source
  FROM tag_history
 WHERE tenant_id = $1::uuid AND action = $2
 ORDER BY occurred_at`, tenantID, action)
	if err != nil {
		t.Fatalf("read tag_history: %v", err)
	}
	defer rows.Close()
	out := []tagHistoryRow{}
	for rows.Next() {
		var r tagHistoryRow
		if err := rows.Scan(&r.tagID, &r.tagName, &r.source); err != nil {
			t.Fatalf("scan tag_history: %v", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate tag_history: %v", err)
	}
	return out
}
