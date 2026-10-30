// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"bytes"
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func TestAuthConfigRewrapWorkerEncryptsAndRedactsLegacyRows(t *testing.T) {
	pool := newStoreTestPool(t)
	ctx := context.Background()
	tenantID := "00000000-0000-4000-8000-000000001789"

	seedStoreTestTenant(
		t,
		pool,
		tenantID,
		"receiver-auth-rewrap-test",
		"receiver-auth-rewrap-test"+tenantID[len(tenantID)-12:],
	)

	cleanup := func() {
		tx, err := db.WithTenant(context.Background(), (*db.Pool)(pool), tenantID)
		if err != nil {
			return
		}
		defer func() { _ = tx.Rollback(context.Background()) }()
		_, _ = tx.Exec(context.Background(), `DELETE FROM outbound_webhooks WHERE tenant_id = $1::uuid`, tenantID)
		_ = tx.Commit(context.Background())
	}
	cleanup()
	defer cleanup()

	seedTx, err := db.WithTenant(ctx, (*db.Pool)(pool), tenantID)
	if err != nil {
		t.Fatalf("open tenant seed transaction: %v", err)
	}
	defer func() { _ = seedTx.Rollback(ctx) }()
	var validID, invalidID string
	if err := seedTx.QueryRow(ctx, `
INSERT INTO outbound_webhooks (
    tenant_id, url, url_envelope, url_state, events, secret_envelope,
    active, auth_config_restore_active,
    auth_config, auth_config_envelope, auth_config_state, updated_at
) VALUES (
    $1::uuid, 'https://receiver-auth.test/…', '\x01'::bytea, 'ready',
    ARRAY['campaign.sent']::text[], '\x00'::bytea, false, true,
    '{"type":"combined","bearer_token":"legacy-bearer-secret","headers":{"X-Api-Key":"legacy-header-secret"}}'::jsonb,
    NULL, 'legacy_pending', now() - interval '2 hours'
)
RETURNING id::text`, tenantID).Scan(&validID); err != nil {
		t.Fatalf("seed valid legacy row (migration 1789 may be absent): %v", err)
	}
	if err := seedTx.QueryRow(ctx, `
INSERT INTO outbound_webhooks (
    tenant_id, url, url_envelope, url_state, events, secret_envelope,
    active, auth_config_restore_active,
    auth_config, auth_config_envelope, auth_config_state, updated_at
) VALUES (
    $1::uuid, 'https://receiver-auth.test/…', '\x01'::bytea, 'ready',
    ARRAY['campaign.sent']::text[], '\x00'::bytea, false, true,
    '{"type":"headers","headers":{"X-Postwave-Signature":"forged"}}'::jsonb,
    NULL, 'legacy_pending', now() - interval '1 hour'
)
RETURNING id::text`, tenantID).Scan(&invalidID); err != nil {
		t.Fatalf("seed invalid legacy row: %v", err)
	}
	var pausedDeliveryID string
	if err := seedTx.QueryRow(ctx, `
INSERT INTO outbound_webhook_deliveries (
    tenant_id, webhook_id, event_type, payload, status,
    next_attempt_at, auth_config_paused_at
) VALUES (
    $1::uuid, $2::uuid, 'campaign.sent', '{"event":{}}'::jsonb, 'pending',
    NULL, now()
)
RETURNING id::text`, tenantID, validID).Scan(&pausedDeliveryID); err != nil {
		t.Fatalf("seed receiver-auth-paused delivery: %v", err)
	}
	if err := seedTx.Commit(ctx); err != nil {
		t.Fatalf("commit legacy rows: %v", err)
	}

	store := &Store{Pool: (*db.Pool)(pool), Cipher: xorAuthCipher{}}
	result, err := store.RewrapLegacyAuthConfigs(ctx, maxAuthRewrapBatchSize)
	if err != nil {
		t.Fatalf("RewrapLegacyAuthConfigs: %v", err)
	}
	if result.Claimed < 2 || result.Rewrapped < 1 || result.Invalid < 1 {
		t.Fatalf("rewrap result = %#v", result)
	}

	readTx, err := db.WithTenant(ctx, (*db.Pool)(pool), tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = readTx.Rollback(ctx) }()
	var validMetadata []byte
	var validEnvelope []byte
	var validState string
	var validActive bool
	if err := readTx.QueryRow(ctx, `
SELECT auth_config, auth_config_envelope, auth_config_state, active
  FROM outbound_webhooks
 WHERE id = $1::uuid`, validID).Scan(
		&validMetadata, &validEnvelope, &validState, &validActive,
	); err != nil {
		t.Fatal(err)
	}
	if validState != authConfigStateReady || len(validEnvelope) == 0 || !validActive {
		t.Fatalf("valid row state=%q active=%v envelope_bytes=%d", validState, validActive, len(validEnvelope))
	}
	for _, secret := range []string{"legacy-bearer-secret", "legacy-header-secret"} {
		if strings.Contains(string(validMetadata), secret) || strings.Contains(string(validEnvelope), secret) {
			t.Errorf("valid migrated row retained plaintext secret %q", secret)
		}
	}
	var invalidMetadata []byte
	var invalidEnvelope []byte
	var invalidState string
	var invalidActive bool
	if err := readTx.QueryRow(ctx, `
SELECT auth_config, auth_config_envelope, auth_config_state, active
  FROM outbound_webhooks
 WHERE id = $1::uuid`, invalidID).Scan(
		&invalidMetadata, &invalidEnvelope, &invalidState, &invalidActive,
	); err != nil {
		t.Fatal(err)
	}
	if invalidState != authConfigStateInvalid || invalidActive || len(invalidEnvelope) != 0 {
		t.Fatalf("invalid row state=%q active=%v envelope_bytes=%d", invalidState, invalidActive, len(invalidEnvelope))
	}
	if strings.Contains(string(invalidMetadata), "forged") ||
		strings.Contains(string(invalidMetadata), "X-Postwave-Signature") {
		t.Fatalf("invalid row was not durably redacted: %s", invalidMetadata)
	}
	var resumedAt, pausedAt *time.Time
	if err := readTx.QueryRow(ctx, `
SELECT next_attempt_at, auth_config_paused_at
  FROM outbound_webhook_deliveries
 WHERE id = $1::uuid`, pausedDeliveryID).Scan(&resumedAt, &pausedAt); err != nil {
		t.Fatal(err)
	}
	if resumedAt == nil || pausedAt != nil {
		t.Fatalf("valid delivery did not resume after safe rewrap: next=%v paused=%v", resumedAt, pausedAt)
	}
	if err := readTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	cfg, err := store.LoadDeliveryConfig(ctx, tenantID, validID)
	if err != nil {
		t.Fatalf("LoadDeliveryConfig(valid): %v", err)
	}
	if cfg.AuthConfig == nil ||
		cfg.AuthConfig.BearerToken != "legacy-bearer-secret" ||
		cfg.AuthConfig.Headers["X-Api-Key"] != "legacy-header-secret" {
		t.Fatalf("decrypted delivery auth = %#v", cfg.AuthConfig)
	}
	if _, err := store.LoadDeliveryConfig(ctx, tenantID, invalidID); !errors.Is(err, ErrAuthConfigInvalid) {
		t.Fatalf("LoadDeliveryConfig(invalid) error = %v, want ErrAuthConfigInvalid", err)
	}
}

func TestStoreCreateUpdateAndClearReceiverAuthUseSplitStorage(t *testing.T) {
	pool := newStoreTestPool(t)
	ctx := context.Background()
	tenantID := "00000000-0000-4000-8000-000000011789"

	seedStoreTestTenant(
		t,
		pool,
		tenantID,
		"receiver-auth-split-storage-test",
		"receiver-auth-split-storage-test"+tenantID[len(tenantID)-12:],
	)

	cleanup := func() {
		tx, err := db.WithTenant(context.Background(), (*db.Pool)(pool), tenantID)
		if err != nil {
			return
		}
		defer func() { _ = tx.Rollback(context.Background()) }()
		_, _ = tx.Exec(context.Background(), `DELETE FROM outbound_webhooks WHERE tenant_id = $1::uuid`, tenantID)
		_ = tx.Commit(context.Background())
	}
	cleanup()
	defer cleanup()

	store := &Store{Pool: (*db.Pool)(pool), Cipher: xorAuthCipher{}}
	created, err := store.Create(ctx, tenantID, "", CreateInput{
		URL:    "https://receiver-auth.test/create",
		Events: []string{"campaign.sent"},
		AuthConfig: &AuthConfig{
			Type:        "bearer",
			BearerToken: "created-bearer-secret",
		},
	}, true)
	if err != nil {
		t.Fatalf("Store.Create (migration 1789 may be absent): %v", err)
	}
	if created.Webhook.AuthConfig == nil ||
		!created.Webhook.AuthConfig.BearerConfigured ||
		created.Webhook.AuthConfig.BearerToken != "" ||
		created.Webhook.AuthConfigStatus != authConfigStateReady {
		t.Fatalf("create response exposed or lost auth metadata: %#v", created.Webhook)
	}
	webhookID := created.Webhook.ID

	assertStored := func(t *testing.T, forbidden string, wantEnvelope bool) []byte {
		t.Helper()
		tx, err := db.WithTenant(ctx, (*db.Pool)(pool), tenantID)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		var metadata, envelope []byte
		if err := tx.QueryRow(ctx, `
SELECT auth_config, auth_config_envelope
  FROM outbound_webhooks
 WHERE id = $1::uuid`, webhookID).Scan(&metadata, &envelope); err != nil {
			t.Fatal(err)
		}
		if forbidden != "" &&
			(strings.Contains(string(metadata), forbidden) || strings.Contains(string(envelope), forbidden)) {
			t.Fatalf("storage retained plaintext %q", forbidden)
		}
		if got := len(envelope) > 0; got != wantEnvelope {
			t.Fatalf("ciphertext present = %v, want %v", got, wantEnvelope)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		return envelope
	}

	originalEnvelope := assertStored(t, "created-bearer-secret", true)
	description := "metadata-only update"
	if _, err := store.Update(ctx, tenantID, webhookID, UpdateInput{Description: &description}, true); err != nil {
		t.Fatalf("metadata-only Update: %v", err)
	}
	if got := assertStored(t, "created-bearer-secret", true); !bytes.Equal(got, originalEnvelope) {
		t.Fatal("omitted auth_config replaced existing ciphertext")
	}

	updated, err := store.Update(ctx, tenantID, webhookID, UpdateInput{
		AuthConfig: &AuthConfig{
			Type:    "headers",
			Headers: map[string]string{"X-Api-Key": "replacement-header-secret"},
		},
	}, true)
	if err != nil {
		t.Fatalf("credential Update: %v", err)
	}
	if updated.AuthConfig == nil ||
		!reflect.DeepEqual(updated.AuthConfig.HeaderNames, []string{"X-Api-Key"}) ||
		len(updated.AuthConfig.Headers) != 0 {
		t.Fatalf("update response exposed or lost auth metadata: %#v", updated.AuthConfig)
	}
	assertStored(t, "replacement-header-secret", true)

	cleared, err := store.Update(ctx, tenantID, webhookID, UpdateInput{
		AuthConfig: &AuthConfig{Type: "none"},
	}, true)
	if err != nil {
		t.Fatalf("clear Update: %v", err)
	}
	assertStored(t, "", false)

	// Repeating an already-complete clear is a semantic no-op. It must not
	// invent a capability revision: migration 2007 deliberately rejects a
	// config_version bump when no delivery-affecting column changed.
	clearedAgain, err := store.Update(ctx, tenantID, webhookID, UpdateInput{
		authConfigPresent: true,
	}, true)
	if err != nil {
		t.Fatalf("repeated clear Update: %v", err)
	}
	if clearedAgain.ConfigVersion != cleared.ConfigVersion {
		t.Fatalf(
			"repeated clear config version = %d, want unchanged %d",
			clearedAgain.ConfigVersion,
			cleared.ConfigVersion,
		)
	}
	assertStored(t, "", false)
}
