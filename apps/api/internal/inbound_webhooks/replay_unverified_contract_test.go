// SPDX-License-Identifier: AGPL-3.0-only
package inbound_webhooks

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func TestQueueReplayGuardsSignatureBeforeReceiptAndActionPlanning(t *testing.T) {
	t.Parallel()

	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(source), "action_outbox_repo.go"))
	if err != nil {
		t.Fatal(err)
	}
	implementation := string(raw)
	functionStart := strings.Index(implementation, "func (r *Repo) QueueReplayWithID(")
	if functionStart < 0 {
		t.Fatal("QueueReplayWithID implementation not found")
	}
	implementation = implementation[functionStart:]
	selectSignature := strings.Index(implementation, "SELECT endpoint_id::text, body_bytes, signature_valid")
	signatureGuard := strings.Index(implementation, "if !signatureValid {")
	receiptInsert := strings.Index(implementation, "INSERT INTO inbound_webhook_replay_receipts")
	actionPlanning := strings.Index(implementation, "r.planTriggerActionsTx(")
	if selectSignature < 0 ||
		signatureGuard < 0 ||
		receiptInsert < 0 ||
		actionPlanning < 0 {
		t.Fatalf(
			"unverified replay guard contract is incomplete: select=%d guard=%d receipt=%d planning=%d",
			selectSignature,
			signatureGuard,
			receiptInsert,
			actionPlanning,
		)
	}
	if !(selectSignature < signatureGuard &&
		signatureGuard < receiptInsert &&
		signatureGuard < actionPlanning) {
		t.Fatalf(
			"unverified replay guard is not fail-closed before durable effects: select=%d guard=%d receipt=%d planning=%d",
			selectSignature,
			signatureGuard,
			receiptInsert,
			actionPlanning,
		)
	}
}

func TestQueueReplayUnverifiedEventCreatesNoReceiptOrAction(t *testing.T) {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set; skipping unverified replay database test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := db.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)

	var migrationPresent bool
	if err := pool.QueryRow(ctx, `
SELECT to_regclass('public.inbound_webhook_action_intents') IS NOT NULL
   AND to_regclass('public.inbound_webhook_replay_receipts') IS NOT NULL`,
	).Scan(&migrationPresent); err != nil || !migrationPresent {
		t.Fatalf("inbound replay migrations are not applied")
	}

	tenantID := createInboundWebhookTestTenant(t, ctx, pool)
	repo := &Repo{Pool: pool}
	name := "unverified-replay-" + randHex4IW(t)
	created, err := repo.Create(ctx, tenantID, name)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupEndpoints(pool, tenantID, name) })

	key, err := inboundWebhookReplayKey(http.Header{
		"X-Postwave-Event-Id": []string{"unverified-" + randHex4IW(t)},
	})
	if err != nil {
		t.Fatal(err)
	}
	eventID, duplicate, err := repo.RecordEvent(
		ctx,
		tenantID,
		created.Endpoint.ID,
		[]byte(`{}`),
		[]byte(`{"email":"forged@example.test"}`),
		false,
		key,
	)
	if err != nil || duplicate {
		t.Fatalf("record unverified event = id:%d duplicate:%t err:%v", eventID, duplicate, err)
	}

	replayID := uuid.NewString()
	if _, _, err := repo.QueueReplayWithID(
		ctx,
		tenantID,
		created.Endpoint.ID,
		eventID,
		replayID,
	); !errors.Is(err, ErrUnverifiedEvent) {
		t.Fatalf("replay error = %v, want ErrUnverifiedEvent", err)
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var receiptCount, actionCount int
	if err := tx.QueryRow(ctx, `
SELECT count(*)
  FROM inbound_webhook_replay_receipts
 WHERE tenant_id = $1::uuid
   AND inbound_event_id = $2`, tenantID, eventID).Scan(&receiptCount); err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*)
  FROM inbound_webhook_action_intents
 WHERE tenant_id = $1::uuid
   AND inbound_event_id = $2
   AND replay_id = $3::uuid`, tenantID, eventID, replayID).Scan(&actionCount); err != nil {
		t.Fatal(err)
	}
	if receiptCount != 0 || actionCount != 0 {
		t.Fatalf("unverified replay created %d receipts / %d actions, want 0 / 0", receiptCount, actionCount)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}
