// SPDX-License-Identifier: AGPL-3.0-only
package inbound_webhooks

import (
	"context"
	"errors"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func TestRecordEventClaimsReplayIdentity(t *testing.T) {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set; skipping inbound webhook replay integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool, poolErr := db.New(ctx, databaseURL)
	if poolErr != nil {
		t.Fatalf("db.New: %v", poolErr)
	}
	t.Cleanup(pool.Close)

	conn, poolErr := pool.Acquire(ctx)
	if poolErr != nil {
		t.Fatal(poolErr)
	}
	var tenantID string
	if err := conn.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&tenantID); err != nil {
		conn.Release()
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `SELECT set_config('app.tenant_id', $1, false)`, tenantID); err != nil {
		conn.Release()
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, 'Inbound replay test', 'pro')`, tenantID, "iwh-replay-"+randHex4IW(t)); err != nil {
		conn.Release()
		t.Fatalf("seed tenant: %v", err)
	}
	conn.Release()
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		cleanupConn, err := pool.Acquire(cleanupCtx)
		if err != nil {
			return
		}
		defer cleanupConn.Release()
		_, _ = cleanupConn.Exec(cleanupCtx, `SELECT set_config('app.tenant_id', $1, false)`, tenantID)
		_, _ = cleanupConn.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	})

	repo := &Repo{Pool: pool}
	created, poolErr := repo.Create(ctx, tenantID, "Replay test")
	if poolErr != nil {
		t.Fatal(poolErr)
	}
	key, poolErr := inboundWebhookReplayKey(http.Header{
		"X-Postwave-Event-Id": []string{"replay-test-" + randHex4IW(t)},
	})
	if poolErr != nil {
		t.Fatal(poolErr)
	}
	firstID, duplicate, poolErr := repo.RecordEvent(ctx, tenantID, created.Endpoint.ID, []byte(`{}`), []byte(`{"a":1}`), true, key)
	if poolErr != nil || duplicate || firstID == 0 {
		t.Fatalf("first record = id %d duplicate %v err %v", firstID, duplicate, poolErr)
	}
	secondID, duplicate, poolErr := repo.RecordEvent(ctx, tenantID, created.Endpoint.ID, []byte(`{}`), []byte(`{"a":1}`), true, key)
	if poolErr != nil || !duplicate || secondID != firstID {
		t.Fatalf("exact retry = id %d duplicate %v err %v; want id %d", secondID, duplicate, poolErr, firstID)
	}
	if _, _, err := repo.RecordEvent(ctx, tenantID, created.Endpoint.ID, []byte(`{}`), []byte(`{"a":2}`), true, key); !errors.Is(err, ErrReplayConflict) {
		t.Fatalf("identity reuse error = %v, want ErrReplayConflict", err)
	}
}
