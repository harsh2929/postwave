// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/migrationrunner"
)

func TestDestinationDisplayNeverRetainsCapabilities(t *testing.T) {
	t.Parallel()
	cases := map[string]string{
		"https://hooks.example.test":                               "https://hooks.example.test",
		"https://hooks.example.test/":                              "https://hooks.example.test/",
		"https://hooks.example.test/services/T000/B000/secret":     "https://hooks.example.test/…",
		"https://hooks.example.test/callback?token=secret&x=value": "https://hooks.example.test/…?…",
	}
	for raw, want := range cases {
		if got := destinationDisplay(raw); got != want {
			t.Errorf("destinationDisplay(%q) = %q, want %q", raw, got, want)
		}
		if strings.Contains(destinationDisplay(raw), "secret") ||
			strings.Contains(destinationDisplay(raw), "token=") {
			t.Errorf("destination display leaked a capability: %q", destinationDisplay(raw))
		}
	}
}

func TestEncodeDestinationStoresOnlyCiphertextAndDisplay(t *testing.T) {
	t.Parallel()
	store := &Store{Cipher: xorAuthCipher{}}
	raw := "https://hooks.example.test/path/secret?token=value"
	display, envelope, err := store.encodeDestination(context.Background(), raw, true)
	if err != nil {
		t.Fatalf("encode destination: %v", err)
	}
	if strings.Contains(display, "secret") || strings.Contains(display, "value") {
		t.Fatalf("display leaked destination capability: %q", display)
	}
	if bytes.Equal(envelope, []byte(raw)) || bytes.Contains(envelope, []byte("secret")) {
		t.Fatal("destination envelope is plaintext")
	}
	opened, err := store.Cipher.Decrypt(context.Background(), envelope, nil)
	if err != nil || string(opened) != raw {
		t.Fatalf("destination roundtrip = %q, %v", opened, err)
	}
}

func TestEncodeDestinationCanonicalizesSchemeAndHostOnly(t *testing.T) {
	t.Parallel()
	store := &Store{Cipher: xorAuthCipher{}}
	display, envelope, err := store.encodeDestination(
		context.Background(),
		"HTTPS://HOOKS.EXAMPLE.TEST/CaseSensitive?Token=KeepCase",
		true,
	)
	if err != nil {
		t.Fatalf("encode destination: %v", err)
	}
	if display != "https://hooks.example.test/…?…" {
		t.Fatalf("display = %q", display)
	}
	opened, err := store.Cipher.Decrypt(context.Background(), envelope, nil)
	if err != nil {
		t.Fatal(err)
	}
	if string(opened) != "https://hooks.example.test/CaseSensitive?Token=KeepCase" {
		t.Fatalf("canonical destination = %q", opened)
	}
}

func TestOutboundDestinationEnvelopeMigrationContract(t *testing.T) {
	t.Parallel()
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	path := filepath.Clean(filepath.Join(
		filepath.Dir(source),
		"../../../../infra/migrations/1796_outbound_webhook_destination_envelopes.sql",
	))
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 1796: %v", err)
	}
	sql := string(raw)
	file := migrationrunner.MigrationFile{
		Version: "1796_outbound_webhook_destination_envelopes",
		Path:    path,
		SQL:     sql,
	}
	for _, finding := range migrationrunner.AssessSafety([]migrationrunner.MigrationFile{file}) {
		if finding.Severity == migrationrunner.SafetyBlocker {
			t.Errorf(
				"migration 1796 safety blocker %q at line %d: %s",
				finding.Rule,
				finding.Line,
				finding.Snippet,
			)
		}
	}
	for _, contract := range []string{
		"ADD COLUMN IF NOT EXISTS url_envelope bytea",
		"ADD COLUMN IF NOT EXISTS url_state text",
		"ADD COLUMN IF NOT EXISTS url_paused_at timestamptz",
		"outbound_webhooks_url_rewrap_pending_idx",
		"classify_outbound_webhook_destination_storage",
		"postwave_pause_delivery_for_destination_state",
		"Value-free destination display projection only",
	} {
		if !strings.Contains(sql, contract) {
			t.Errorf("migration 1796 missing contract %q", contract)
		}
	}
	sourceRaw, err := os.ReadFile(filepath.Join(filepath.Dir(source), "destination.go"))
	if err != nil {
		t.Fatalf("read destination worker: %v", err)
	}
	worker := string(sourceRaw)
	for _, contract := range []string{
		"db.WithWorkerScope(ctx, s.Pool)",
		"FOR UPDATE SKIP LOCKED",
		"maxDestinationRewrapBatchSize",
		"destinationDisplay(raw)",
		"resumePausedDeliveries",
	} {
		if !strings.Contains(worker, contract) {
			t.Errorf("destination worker missing contract %q", contract)
		}
	}
}

func TestDestinationRewrapReplacesStaleEnvelopeAndResumesDelivery(t *testing.T) {
	pool := newStoreTestPool(t)
	ctx := context.Background()
	tenantID := "00000000-0000-4000-8000-000000001796"
	seedStoreTestTenant(
		t,
		pool,
		tenantID,
		"destination-envelope-test",
		"destination-envelope-test",
	)

	cipher := xorAuthCipher{}
	staleEnvelope, err := cipher.Encrypt(ctx, []byte("https://old.example.test/stale"))
	if err != nil {
		t.Fatal(err)
	}
	rawDestination := "https://hooks.example.test/path/new-secret?token=new-value"
	seedTx, err := db.WithTenant(ctx, (*db.Pool)(pool), tenantID)
	if err != nil {
		t.Fatalf("tenant seed tx: %v", err)
	}
	defer func() { _ = seedTx.Rollback(ctx) }()
	var webhookID, deliveryID string
	if err := seedTx.QueryRow(ctx, `
INSERT INTO outbound_webhooks (
    tenant_id, url, url_envelope, url_state, events, secret_envelope,
    active, auth_config, auth_config_state
) VALUES (
    $1::uuid, $2, $3, 'legacy_pending', ARRAY['campaign.sent']::text[],
    '\x00'::bytea, true, '{}'::jsonb, 'ready'
)
RETURNING id::text`, tenantID, rawDestination, staleEnvelope).Scan(&webhookID); err != nil {
		t.Fatalf("seed legacy destination (migration 1796 may be absent): %v", err)
	}
	if err := seedTx.QueryRow(ctx, `
INSERT INTO outbound_webhook_deliveries (
    tenant_id, webhook_id, event_type, payload, status,
    next_attempt_at, url_paused_at
) VALUES (
    $1::uuid, $2::uuid, 'campaign.sent', '{"event":{}}'::jsonb, 'pending',
    NULL, now()
)
RETURNING id::text`, tenantID, webhookID).Scan(&deliveryID); err != nil {
		t.Fatalf("seed URL-paused delivery: %v", err)
	}
	if err := seedTx.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}
	t.Cleanup(func() {
		cleanupTx, cleanupErr := db.WithTenant(context.Background(), (*db.Pool)(pool), tenantID)
		if cleanupErr != nil {
			return
		}
		defer func() { _ = cleanupTx.Rollback(context.Background()) }()
		_, _ = cleanupTx.Exec(context.Background(), `DELETE FROM outbound_webhook_deliveries WHERE id = $1::uuid`, deliveryID)
		_, _ = cleanupTx.Exec(context.Background(), `DELETE FROM outbound_webhooks WHERE id = $1::uuid`, webhookID)
		_ = cleanupTx.Commit(context.Background())
	})

	store := &Store{
		Pool:         (*db.Pool)(pool),
		Cipher:       cipher,
		RequireHTTPS: true,
	}
	result, err := store.RewrapLegacyDestinations(ctx, maxDestinationRewrapBatchSize)
	if err != nil {
		t.Fatalf("RewrapLegacyDestinations: %v", err)
	}
	if result.Rewrapped < 1 {
		t.Fatalf("destination rewrap result = %#v", result)
	}
	verifyTx, err := db.WithTenant(ctx, (*db.Pool)(pool), tenantID)
	if err != nil {
		t.Fatalf("tenant verify tx: %v", err)
	}
	defer func() { _ = verifyTx.Rollback(ctx) }()
	var display, state string
	var envelope []byte
	var nextAttempt, pausedAt *time.Time
	if err := verifyTx.QueryRow(ctx, `
SELECT webhook.url, webhook.url_envelope, webhook.url_state,
       delivery.next_attempt_at, delivery.url_paused_at
  FROM outbound_webhooks AS webhook
  JOIN outbound_webhook_deliveries AS delivery
    ON delivery.webhook_id = webhook.id
 WHERE webhook.id = $1::uuid
   AND delivery.id = $2::uuid`, webhookID, deliveryID).Scan(
		&display,
		&envelope,
		&state,
		&nextAttempt,
		&pausedAt,
	); err != nil {
		t.Fatalf("verify destination rewrap: %v", err)
	}
	if state != destinationStateReady ||
		strings.Contains(display, "new-secret") ||
		strings.Contains(display, "new-value") {
		t.Fatalf("destination storage not redacted: display=%q state=%q", display, state)
	}
	opened, err := cipher.Decrypt(ctx, envelope, nil)
	if err != nil || string(opened) != rawDestination {
		t.Fatalf("rewrap retained stale destination: opened=%q err=%v", opened, err)
	}
	if nextAttempt == nil || pausedAt != nil {
		t.Fatalf("delivery did not resume: next=%v paused=%v", nextAttempt, pausedAt)
	}
}
