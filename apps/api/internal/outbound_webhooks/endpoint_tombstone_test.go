// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/migrationrunner"
	"github.com/postwave/postwave/apps/api/internal/pagination"
)

func TestOutboundWebhookEndpointTombstoneMigrationContract(t *testing.T) {
	t.Parallel()
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	path := filepath.Clean(filepath.Join(
		filepath.Dir(source),
		"../../../../infra/migrations/1799_outbound_webhook_endpoint_tombstones.sql",
	))
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 1799: %v", err)
	}
	sql := string(raw)
	file := migrationrunner.MigrationFile{
		Version: "1799_outbound_webhook_endpoint_tombstones",
		Path:    path,
		SQL:     sql,
	}
	for _, finding := range migrationrunner.AssessSafety([]migrationrunner.MigrationFile{file}) {
		if finding.Severity == migrationrunner.SafetyBlocker {
			t.Errorf(
				"migration 1799 safety blocker %q at line %d: %s",
				finding.Rule,
				finding.Line,
				finding.Snippet,
			)
		}
	}
	for _, contract := range []string{
		"ADD COLUMN IF NOT EXISTS deleted_at timestamptz",
		"outbound_webhooks_tombstone_secret_shredding_check",
		"octet_length(secret_envelope) = 0",
		"auth_config_envelope IS NULL",
		"CREATE INDEX CONCURRENTLY IF NOT EXISTS outbound_webhooks_deleted_at_idx",
		"purged after dependent evidence retention",
	} {
		if !strings.Contains(sql, contract) {
			t.Errorf("migration 1799 missing contract %q", contract)
		}
	}
}

func TestOutboundWebhookTombstoneSourceContracts(t *testing.T) {
	t.Parallel()
	storeRaw, err := os.ReadFile("store.go")
	if err != nil {
		t.Fatal(err)
	}
	store := string(storeRaw)
	for _, contract := range []string{
		"deleted_at = now()",
		"secret_envelope = ''::bytea",
		"url_envelope = NULL",
		"auth_config_envelope = NULL",
		"AND deleted_at IS NULL",
		"finalizeDeletedDeliveries(ctx, tx, tenantID, id)",
		"finalizeOperatorNotifications(",
		"status = 'skipped'",
	} {
		if !strings.Contains(store, contract) {
			t.Errorf("outbound tombstone store missing %q", contract)
		}
	}
	for _, path := range []string{
		"transactional_fanout.go",
		"transactional_list_fanout.go",
	} {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(raw), "deleted_at IS NULL") {
			t.Errorf("%s can still fan out to tombstones", path)
		}
	}
	retentionRaw, err := os.ReadFile("../retention/sweep_webhooks.go")
	if err != nil {
		t.Fatal(err)
	}
	retention := string(retentionRaw)
	for _, contract := range []string{
		"sweepDeletedOutboundWebhookEndpoints",
		"candidate.deleted_at IS NOT NULL",
		"FROM outbound_webhook_deliveries AS delivery",
		"FROM outbound_webhook_operator_notifications AS notification",
	} {
		if !strings.Contains(retention, contract) {
			t.Errorf("outbound tombstone retention missing %q", contract)
		}
	}
}

func TestOutboundWebhookDeleteTombstonesAndPreservesDeliveryEvidence(t *testing.T) {
	pool := newStoreTestPool(t)
	ctx := context.Background()
	tenantID := "00000000-0000-4000-8000-000000001799"
	seedStoreTestTenant(
		t,
		pool,
		tenantID,
		"outbound-tombstone-test",
		"outbound-tombstone-test"+tenantID[len(tenantID)-12:],
	)
	t.Cleanup(func() {
		cleanupCtx := context.Background()
		tx, err := db.WithTenantWorker(cleanupCtx, (*db.Pool)(pool), tenantID)
		if err != nil {
			return
		}
		defer func() { _ = tx.Rollback(cleanupCtx) }()
		_, _ = tx.Exec(cleanupCtx,
			`DELETE FROM outbound_webhooks WHERE tenant_id = $1::uuid`,
			tenantID,
		)
		_, _ = tx.Exec(cleanupCtx,
			`DELETE FROM tenants WHERE id = $1::uuid`,
			tenantID,
		)
		_ = tx.Commit(cleanupCtx)
	})

	store := &Store{
		Pool: (*db.Pool)(pool), Cipher: xorAuthCipher{}, RequireHTTPS: true,
	}
	created, err := store.Create(ctx, tenantID, "", CreateInput{
		URL:    "https://receiver.example.test/capability?token=secret",
		Events: []string{"campaign.sent"},
	}, true)
	if err != nil {
		t.Fatalf("create (latest migrations may be absent): %v", err)
	}
	seedTx, err := db.WithTenant(ctx, (*db.Pool)(pool), tenantID)
	if err != nil {
		t.Fatal(err)
	}
	var deliveryID string
	if err := seedTx.QueryRow(ctx, `
INSERT INTO outbound_webhook_deliveries (
    tenant_id, webhook_id, event_type, payload, status, next_attempt_at
)
VALUES (
    $1::uuid, $2::uuid, 'campaign.sent', '{"event":{}}'::jsonb,
    'pending', now()
)
RETURNING id::text`,
		tenantID, created.Webhook.ID,
	).Scan(&deliveryID); err != nil {
		_ = seedTx.Rollback(ctx)
		t.Fatal(err)
	}
	var notificationID string
	if err := seedTx.QueryRow(ctx, `
INSERT INTO outbound_webhook_operator_notifications (
    tenant_id, webhook_id, kind, status, next_attempt_at
)
VALUES ($1::uuid, $2::uuid, 'auto_disabled', 'pending', now())
RETURNING id::text`,
		tenantID, created.Webhook.ID,
	).Scan(&notificationID); err != nil {
		_ = seedTx.Rollback(ctx)
		t.Fatalf("seed notification (migration 1798 may be absent): %v", err)
	}
	if err := seedTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	if err := store.Delete(ctx, tenantID, created.Webhook.ID); err != nil {
		t.Fatalf("tombstone (migration 1799 may be absent): %v", err)
	}
	if _, err := store.Get(ctx, tenantID, created.Webhook.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get tombstone error = %v, want ErrNotFound", err)
	}
	if _, _, err := store.ListDeliveriesPage(
		ctx,
		tenantID,
		created.Webhook.ID,
		50,
		pagination.Cursor{},
	); !errors.Is(err, ErrNotFound) {
		t.Fatalf("ListDeliveriesPage tombstone error = %v, want ErrNotFound", err)
	}
	if _, err := store.ReplayDelivery(
		ctx,
		tenantID,
		deliveryID,
		"tombstoned-parent-replay",
	); !errors.Is(err, ErrNotFound) {
		t.Fatalf("replay tombstone error = %v, want ErrNotFound", err)
	}
	enqueued, err := store.EnqueueDelivery(
		ctx,
		tenantID,
		created.Webhook.ID,
		"campaign.sent",
		"17990000-0000-4000-8000-000000000001",
		[]byte(`{"event":{}}`),
	)
	if err != nil {
		t.Fatalf("enqueue tombstone: %v", err)
	}
	if enqueued != "" {
		t.Fatalf("enqueue tombstone created delivery %q", enqueued)
	}
	listed, err := store.List(ctx, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	for _, webhook := range listed {
		if webhook.ID == created.Webhook.ID {
			t.Fatal("tombstoned webhook remained in normal list")
		}
	}

	checkTx, err := db.WithTenant(ctx, (*db.Pool)(pool), tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = checkTx.Rollback(ctx) }()
	var active bool
	var deleted bool
	var secretShredded, destinationShredded, authShredded bool
	if err := checkTx.QueryRow(ctx, `
SELECT active, deleted_at IS NOT NULL,
       octet_length(secret_envelope) = 0,
       url_envelope IS NULL,
       auth_config_envelope IS NULL
  FROM outbound_webhooks
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, created.Webhook.ID,
	).Scan(
		&active,
		&deleted,
		&secretShredded,
		&destinationShredded,
		&authShredded,
	); err != nil {
		t.Fatal(err)
	}
	if active || !deleted {
		t.Fatalf("tombstone active/deleted = %v/%v", active, deleted)
	}
	if !secretShredded || !destinationShredded || !authShredded {
		t.Fatalf(
			"tombstone secret shredding = signing:%v destination:%v auth:%v",
			secretShredded,
			destinationShredded,
			authShredded,
		)
	}
	var status string
	var nextAt any
	var paused bool
	if err := checkTx.QueryRow(ctx, `
SELECT status, next_attempt_at, disabled_paused_at IS NOT NULL
  FROM outbound_webhook_deliveries
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, deliveryID,
	).Scan(&status, &nextAt, &paused); err != nil {
		t.Fatal(err)
	}
	if status != "skipped" || nextAt != nil || !paused {
		t.Fatalf("preserved delivery state = %q next=%v paused=%v", status, nextAt, paused)
	}
	var notificationStatus string
	var notificationNextAt any
	var notificationExhausted bool
	if err := checkTx.QueryRow(ctx, `
SELECT status, next_attempt_at, exhausted_at IS NOT NULL
  FROM outbound_webhook_operator_notifications
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, notificationID,
	).Scan(&notificationStatus, &notificationNextAt, &notificationExhausted); err != nil {
		t.Fatal(err)
	}
	if notificationStatus != "exhausted" ||
		notificationNextAt != nil ||
		!notificationExhausted {
		t.Fatalf(
			"preserved notification state = %q next=%v exhausted=%v",
			notificationStatus,
			notificationNextAt,
			notificationExhausted,
		)
	}
}
