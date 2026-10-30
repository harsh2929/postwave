// SPDX-License-Identifier: AGPL-3.0-only
package retention

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func TestPlaygroundReceiptSweepTransitionsAndPreservesFences(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping playground receipt retention test")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	var tableExists bool
	if err := pool.QueryRow(ctx, `
SELECT to_regclass('public.outbound_webhook_playground_fires') IS NOT NULL`,
	).Scan(&tableExists); err != nil || !tableExists {
		t.Fatalf("playground ledger migration is not applied: exists=%v err=%v", tableExists, err)
	}

	tenantID := uuid.New().String()
	staleFireID := uuid.New().String()
	expiredFireID := uuid.New().String()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id,name,slug,tier)
VALUES ($1::uuid,'playground-retention-contract',$2,'studio')`,
		tenantID, "playground-retention-"+strings.ReplaceAll(tenantID, "-", "")); err != nil {
		t.Fatal(err)
	}
	var webhookID string
	if err := tx.QueryRow(ctx, `
INSERT INTO outbound_webhooks (
    tenant_id,url,url_envelope,url_state,events,secret_envelope,
    active,auth_config_state
) VALUES (
    $1::uuid,'https://example.invalid/receipt','\x01'::bytea,'ready',
    ARRAY['campaign.sent']::text[],'\x01'::bytea,true,'ready'
)
RETURNING id::text`, tenantID).Scan(&webhookID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO outbound_webhook_playground_fires (
    tenant_id,fire_id,webhook_id,webhook_ref_id,config_version,
    idempotency_key_sha256,request_sha256,event_type,state,outcome,
    receiver_status_code,receipt_envelope,receipt_sha256,created_at,completed_at
) VALUES
    ($1::uuid,$2::uuid,$4::uuid,$4::uuid,1,$5,$7,'campaign.sent',
     'pending',NULL,NULL,'\x01'::bytea,$8,now()-interval '3 minutes',NULL),
    ($1::uuid,$3::uuid,$4::uuid,$4::uuid,1,$6,$7,'campaign.sent',
     'completed','filtered',204,'\x02'::bytea,$8,
     now()-interval '2 days',now()-interval '2 days')`,
		tenantID, staleFireID, expiredFireID, webhookID,
		strings.Repeat("1", 64), strings.Repeat("2", 64),
		strings.Repeat("a", 64), strings.Repeat("e", 64)); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() {
		cleanup, cleanupErr := db.WithTenant(context.Background(), pool, tenantID)
		if cleanupErr != nil {
			return
		}
		defer func() { _ = cleanup.Rollback(context.Background()) }()
		_, _ = cleanup.Exec(context.Background(), `DELETE FROM tenants WHERE id=$1::uuid`, tenantID)
		_ = cleanup.Commit(context.Background())
	})

	sweeper := &Sweeper{Pool: pool, BatchSize: 10, MaxBatchesPerTenant: 2}
	changed, err := sweeper.sweepOutboundWebhookPlaygroundFires(ctx, tenantID, 1)
	if err != nil || changed != 2 {
		t.Fatalf("sweep changed=%d err=%v, want 2", changed, err)
	}

	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var staleState, expiredState string
	var staleHasEnvelope, expiredHasEnvelope bool
	if err := tx.QueryRow(ctx, `
SELECT state,receipt_envelope IS NOT NULL
  FROM outbound_webhook_playground_fires
 WHERE tenant_id=$1::uuid AND fire_id=$2::uuid`, tenantID, staleFireID).Scan(
		&staleState, &staleHasEnvelope,
	); err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(ctx, `
SELECT state,receipt_envelope IS NOT NULL
  FROM outbound_webhook_playground_fires
 WHERE tenant_id=$1::uuid AND fire_id=$2::uuid`, tenantID, expiredFireID).Scan(
		&expiredState, &expiredHasEnvelope,
	); err != nil {
		t.Fatal(err)
	}
	if staleState != "ambiguous" || !staleHasEnvelope ||
		expiredState != "receipt_expired" || expiredHasEnvelope {
		t.Fatalf("states stale=%s/%v expired=%s/%v", staleState, staleHasEnvelope, expiredState, expiredHasEnvelope)
	}

	for _, attempt := range []struct {
		fireID  string
		keyHash string
	}{
		{fireID: expiredFireID, keyHash: strings.Repeat("3", 64)},
		{fireID: uuid.New().String(), keyHash: strings.Repeat("2", 64)},
	} {
		tag, err := tx.Exec(ctx, `
INSERT INTO outbound_webhook_playground_fires (
    tenant_id,fire_id,webhook_id,webhook_ref_id,config_version,
    idempotency_key_sha256,request_sha256,event_type,
    receipt_envelope,receipt_sha256
) VALUES (
    $1::uuid,$2::uuid,$3::uuid,$3::uuid,1,$4,$5,'campaign.sent','\x03'::bytea,$6
)
ON CONFLICT DO NOTHING`, tenantID, attempt.fireID, webhookID, attempt.keyHash,
			strings.Repeat("b", 64), strings.Repeat("f", 64))
		if err != nil || tag.RowsAffected() != 0 {
			t.Fatalf("expired fence insertion rows=%d err=%v", tag.RowsAffected(), err)
		}
	}
}
