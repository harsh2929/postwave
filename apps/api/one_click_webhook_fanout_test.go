// SPDX-License-Identifier: AGPL-3.0-only
package main

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/outbound_webhooks"
	"github.com/postwave/postwave/apps/api/internal/preferences"
)

func TestOneClickWebhookFanoutCompositionIsTransactional(t *testing.T) {
	t.Parallel()
	adapterBytes, err := os.ReadFile("composition_adapters.go")
	if err != nil {
		t.Fatalf("read composition adapters: %v", err)
	}
	source := string(adapterBytes)
	for _, contract := range []string{
		"db.WithTenant(ctx, a.pool, tenantID)",
		"ON CONFLICT (tenant_id, email, reason) DO UPDATE",
		"WHERE email_suppressions.expires_at IS NOT NULL",
		"preferences.AppendOneClickConsentRevocation(ctx, tx, tenantID, email, evidence)",
		"preferences.EnsureOneClickConsentRevocation(ctx, tx, tenantID, email, evidence)",
		"a.fanout.Fire(ctx, tx, outbound_webhooks.TransactionalEvent{",
		"EventSubscriberUnsubscribed",
		"return tx.Commit(ctx)",
	} {
		if !strings.Contains(source, contract) {
			t.Errorf("one-click transactional fanout missing %q", contract)
		}
	}
	if strings.Contains(source, "type unsubscribeFanoutAdapter struct") {
		t.Error("obsolete best-effort event-bus unsubscribe fanout remains")
	}

	// run() calls wiring and worker helpers that e8d23a62d extracted from
	// main.go. A bus dispatcher reintroduced in any of them is the same
	// regression, so this reads the whole composition root rather than
	// main.go alone.
	compositionRoot := readAPICompositionRoot(t).all
	if strings.Contains(compositionRoot, "UnsubscribeFanout: unsubscribeFanoutAdapter") {
		t.Error("production one-click wiring still uses the removed bus dispatcher")
	}
}

func TestOneClickWebhookFanoutPersistsExactlyOncePerSuppressionTransition(t *testing.T) {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set; skipping transactional one-click integration test")
	}
	adminDatabaseURL := os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL")
	if adminDatabaseURL == "" {
		t.Skip("POSTWAVE_TEST_ADMIN_DATABASE_URL not set; skipping tenant fixture setup")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	adminPool, err := pgxpool.New(ctx, adminDatabaseURL)
	if err != nil {
		t.Fatalf("connect admin fixture pool: %v", err)
	}
	t.Cleanup(adminPool.Close)

	tenantID := uuid.NewString()
	if _, err := adminPool.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'one-click-webhook-test', $2, 'studio')`,
		tenantID, "one-click-"+strings.ReplaceAll(tenantID, "-", ""),
	); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}

	t.Cleanup(func() {
		_, _ = adminPool.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	})

	tenantTx, err := db.WithTenant(ctx, (*db.Pool)(pool), tenantID)
	if err != nil {
		t.Fatalf("tenant transaction: %v", err)
	}
	if _, err := tenantTx.Exec(ctx, `
INSERT INTO outbound_webhooks (
    tenant_id, url, url_envelope, url_state, events, secret_envelope,
    active, auth_config, auth_config_state, created_at
)
VALUES (
    $1::uuid, 'https://receiver.example.test/…', '\x01'::bytea, 'ready',
    ARRAY['subscriber.unsubscribed']::text[], '\x01'::bytea,
    true, '{}'::jsonb, 'ready', now() - interval '1 minute'
)`, tenantID); err != nil {
		_ = tenantTx.Rollback(ctx)
		t.Fatalf("seed webhook: %v", err)
	}
	if err := tenantTx.Commit(ctx); err != nil {
		t.Fatalf("commit webhook: %v", err)
	}

	adapter := oneClickSuppressorAdapter{
		pool:   (*db.Pool)(pool),
		fanout: &outbound_webhooks.TransactionalFanout{},
	}
	email := "recipient@example.test"
	if err := adapter.Add(ctx, tenantID, email, "one_click", preferences.OneClickEvidence{}); err != nil {
		t.Fatalf("first one-click transition: %v", err)
	}
	if err := adapter.Add(ctx, tenantID, email, "one_click", preferences.OneClickEvidence{}); err != nil {
		t.Fatalf("idempotent one-click retry: %v", err)
	}

	assertCounts := func(want int) {
		t.Helper()
		tx, err := db.WithTenant(ctx, (*db.Pool)(pool), tenantID)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		var suppressions, receipts, deliveries, consentEvents int
		if err := tx.QueryRow(ctx, `
SELECT
    (SELECT count(*) FROM email_suppressions
      WHERE tenant_id = $1::uuid AND email = $2 AND expires_at IS NULL),
    (SELECT count(*) FROM outbound_webhook_event_receipts
      WHERE tenant_id = $1::uuid AND event_type = 'subscriber.unsubscribed'),
    (SELECT count(*) FROM outbound_webhook_deliveries
      WHERE tenant_id = $1::uuid AND event_type = 'subscriber.unsubscribed'),
    (SELECT count(*) FROM consent_events
      WHERE tenant_id = $1::uuid AND subject_email = $2 AND source = 'one_click')`,
			tenantID, email,
		).Scan(&suppressions, &receipts, &deliveries, &consentEvents); err != nil {
			t.Fatal(err)
		}
		if suppressions != 1 || receipts != want || deliveries != want || consentEvents != want {
			t.Fatalf(
				"counts suppression/receipt/delivery/consent = %d/%d/%d/%d, want 1/%d/%d/%d",
				suppressions, receipts, deliveries, consentEvents, want, want, want,
			)
		}
	}
	assertCounts(1)

	// An independently seeded active legacy suppression with missing consent
	// evidence is healed once; further mailbox retries remain idempotent.
	legacyEmail := "legacy-recipient@example.test"
	legacyTx, err := db.WithTenant(ctx, (*db.Pool)(pool), tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := legacyTx.Exec(ctx, `
INSERT INTO email_suppressions (tenant_id, email, reason, source, metadata)
VALUES ($1::uuid, $2, 'unsubscribe', 'one_click', '{"origin":"legacy"}'::jsonb)`, tenantID, legacyEmail); err != nil {
		_ = legacyTx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := legacyTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Add(ctx, tenantID, legacyEmail, "one_click", preferences.OneClickEvidence{}); err != nil {
		t.Fatalf("heal active legacy suppression: %v", err)
	}
	if err := adapter.Add(ctx, tenantID, legacyEmail, "one_click", preferences.OneClickEvidence{}); err != nil {
		t.Fatalf("idempotent retry after legacy heal: %v", err)
	}
	legacyVerify, err := db.WithTenant(ctx, (*db.Pool)(pool), tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = legacyVerify.Rollback(ctx) }()
	var legacySuppressions, legacyConsentEvents, legacyReceipts int
	if err := legacyVerify.QueryRow(ctx, `
SELECT
    (SELECT count(*) FROM email_suppressions
      WHERE tenant_id = $1::uuid AND email = $2 AND expires_at IS NULL),
    (SELECT count(*) FROM consent_events
      WHERE tenant_id = $1::uuid AND subject_email = $2 AND source = 'one_click'),
    (SELECT count(*) FROM outbound_webhook_event_receipts
	  WHERE tenant_id = $1::uuid AND event_type = 'subscriber.unsubscribed')`, tenantID, legacyEmail,
	).Scan(&legacySuppressions, &legacyConsentEvents, &legacyReceipts); err != nil {
		t.Fatal(err)
	}
	if legacySuppressions != 1 || legacyConsentEvents != 1 || legacyReceipts != 1 {
		t.Fatalf("legacy heal suppression/consent/total-webhooks=%d/%d/%d, want 1/1/1",
			legacySuppressions, legacyConsentEvents, legacyReceipts)
	}

	expireTx, err := db.WithTenant(ctx, (*db.Pool)(pool), tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := expireTx.Exec(ctx, `
UPDATE email_suppressions
   SET expires_at = $3
 WHERE tenant_id = $1::uuid AND email = $2`,
		tenantID, email, time.Now().UTC().Add(-time.Minute),
	); err != nil {
		_ = expireTx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := expireTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := adapter.Add(ctx, tenantID, email, "one_click", preferences.OneClickEvidence{}); err != nil {
		t.Fatalf("reactivated one-click transition: %v", err)
	}
	assertCounts(2)
}
