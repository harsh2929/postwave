// SPDX-License-Identifier: AGPL-3.0-only
//
// DB-backed tests for the batch write tools (4.5): partial-success via
// per-item savepoints, and source_event_id dedup. Skips without
// DATABASE_URL (the established pg-backed pattern); fixtures live under a
// throwaway tenant and cascade-delete on tenant cleanup.
package mcp

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func btDB(t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed batch-tool tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func btUUID(t *testing.T) string {
	t.Helper()
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("rand: %v", err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

func btTenant(t *testing.T, pool *db.Pool, ctx context.Context) string {
	t.Helper()
	tenantID := btUUID(t)
	slug := "bt-" + tenantID[:8]
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatalf("begin tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		t.Fatalf("bind tenant guc: %v", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, $2, 'studio')`, tenantID, slug); err != nil {
		t.Fatalf("insert tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant: %v", err)
	}
	t.Cleanup(func() {
		ctx2, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		tx2, err := db.WithTenant(ctx2, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = tx2.Rollback(ctx2) }()
		_, _ = tx2.Exec(ctx2, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = tx2.Commit(ctx2)
	})
	return tenantID
}

func btSubscriber(t *testing.T, pool *db.Pool, ctx context.Context, tenantID, email string) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, 'enabled', 'api')`, tenantID, email); err != nil {
		t.Fatalf("seed subscriber %s: %v", email, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit subscriber: %v", err)
	}
}

type btBatchOut struct {
	Requested int `json:"requested"`
	Succeeded int `json:"succeeded"`
	Failed    int `json:"failed"`
	Results   []struct {
		Index   int    `json:"index"`
		OK      bool   `json:"ok"`
		Error   string `json:"error"`
		Deduped bool   `json:"deduped"`
	} `json:"results"`
}

func runBatchEvents(t *testing.T, pool *db.Pool, tenantID string, events []map[string]any) btBatchOut {
	t.Helper()
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: tenantID})
	args, _ := json.Marshal(map[string]any{"events": events})
	res, err := handleBatchRecordSubscriberEvents(ctx, &Deps{Pool: pool}, args)
	if err != nil {
		t.Fatalf("batch handler error: %v", err)
	}
	raw, _ := json.Marshal(res)
	var out btBatchOut
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("decode batch result: %v", err)
	}
	return out
}

// A bad row (unknown subscriber) must not abort the batch: the two valid
// rows commit and the bad one is reported as failed.
func TestBatchRecordSubscriberEvents_partialSuccess(t *testing.T) {
	pool := btDB(t)
	ctx := context.Background()
	tenantID := btTenant(t, pool, ctx)
	btSubscriber(t, pool, ctx, tenantID, "a@batch.test")
	btSubscriber(t, pool, ctx, tenantID, "b@batch.test")

	out := runBatchEvents(t, pool, tenantID, []map[string]any{
		{"subscriber_id": "a@batch.test", "event_name": "viewed"},
		{"subscriber_id": "ghost@batch.test", "event_name": "viewed"}, // unknown → fails
		{"subscriber_id": "b@batch.test", "event_name": "viewed"},
	})
	if out.Requested != 3 || out.Succeeded != 2 || out.Failed != 1 {
		t.Fatalf("want 3/2/1, got %d/%d/%d", out.Requested, out.Succeeded, out.Failed)
	}
	if out.Results[1].OK || out.Results[1].Error == "" {
		t.Fatalf("the unknown-subscriber row should fail with an error: %+v", out.Results[1])
	}
	// Both valid rows must be committed (the failed item didn't poison the tx).
	tx, _ := db.WithTenant(ctx, pool, tenantID)
	defer func() { _ = tx.Rollback(ctx) }()
	var n int
	_ = tx.QueryRow(ctx, `SELECT count(*)::int FROM subscriber_events WHERE tenant_id=$1::uuid AND source='mcp'`, tenantID).Scan(&n)
	if n != 2 {
		t.Fatalf("want 2 committed events, got %d", n)
	}
}

// The same source_event_id within a batch dedups: both items succeed, the
// second is flagged deduped, and only one row lands.
func TestBatchRecordSubscriberEvents_dedup(t *testing.T) {
	pool := btDB(t)
	ctx := context.Background()
	tenantID := btTenant(t, pool, ctx)
	btSubscriber(t, pool, ctx, tenantID, "a@batch.test")

	out := runBatchEvents(t, pool, tenantID, []map[string]any{
		{"subscriber_id": "a@batch.test", "event_name": "viewed", "source_event_id": "evt-1"},
		{"subscriber_id": "a@batch.test", "event_name": "viewed", "source_event_id": "evt-1"},
	})
	if out.Succeeded != 2 {
		t.Fatalf("both items should succeed (one deduped), got succeeded=%d results=%+v", out.Succeeded, out.Results)
	}
	if !out.Results[1].Deduped {
		t.Fatalf("the second item with the same source_event_id should be deduped: %+v", out.Results[1])
	}
	tx, _ := db.WithTenant(ctx, pool, tenantID)
	defer func() { _ = tx.Rollback(ctx) }()
	var n int
	_ = tx.QueryRow(ctx, `SELECT count(*)::int FROM subscriber_events WHERE tenant_id=$1::uuid AND source_event_id='evt-1'`, tenantID).Scan(&n)
	if n != 1 {
		t.Fatalf("dedup should leave exactly 1 row, got %d", n)
	}
}
