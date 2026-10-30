// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

type firstRotationEncryptBarrier struct {
	delegate xorAuthCipher
	mu       sync.Mutex
	calls    int
	entered  chan struct{}
	release  chan struct{}
}

func (c *firstRotationEncryptBarrier) Encrypt(
	ctx context.Context,
	plaintext []byte,
) ([]byte, error) {
	c.mu.Lock()
	c.calls++
	first := c.calls == 1
	if first {
		close(c.entered)
	}
	c.mu.Unlock()
	if first {
		select {
		case <-c.release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return c.delegate.Encrypt(ctx, plaintext)
}

func (c *firstRotationEncryptBarrier) Decrypt(
	ctx context.Context,
	blob, legacyKEK []byte,
) ([]byte, error) {
	return c.delegate.Decrypt(ctx, blob, legacyKEK)
}

func TestRotateConcurrentRequestsDemoteExactPrecedingKey(t *testing.T) {
	pool := newStoreTestPool(t)
	database := (*db.Pool)(pool)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	tenantID := uuid.NewString()
	initial, err := GenerateSigningMaterial(AlgorithmECDSAP256)
	if err != nil {
		t.Fatal(err)
	}
	initialPrivate, err := StoreEncode(initial)
	if err != nil {
		t.Fatal(err)
	}
	initialEnvelope, err := (xorAuthCipher{}).Encrypt(ctx, initialPrivate)
	if err != nil {
		t.Fatal(err)
	}

	seed, err := db.WithTenant(ctx, database, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = seed.Rollback(context.Background()) }()
	if _, err := seed.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'rotation concurrency test',
        'rotation-concurrency-' || right($1::text, 12), 'studio')`, tenantID); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	var webhookID string
	if err := seed.QueryRow(ctx, `
INSERT INTO outbound_webhooks (
    tenant_id, url, url_envelope, url_state, events, secret_envelope,
    active, auth_config_state, signing_algorithm, signing_public_key
)
VALUES (
    $1::uuid, 'https://rotation.example.test/…', '\x01'::bytea, 'ready',
    ARRAY['campaign.sent']::text[], $2, true, 'ready', $3, $4
)
RETURNING id::text`,
		tenantID, initialEnvelope, AlgorithmECDSAP256, initial.PublicKeyPEM,
	).Scan(&webhookID); err != nil {
		t.Fatalf("seed webhook: %v", err)
	}
	if err := seed.Commit(ctx); err != nil {
		t.Fatalf("commit fixture: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		tx, cleanupErr := db.WithTenant(cleanupCtx, database, tenantID)
		if cleanupErr != nil {
			return
		}
		defer func() { _ = tx.Rollback(cleanupCtx) }()
		_, _ = tx.Exec(cleanupCtx, `DELETE FROM outbound_webhooks WHERE tenant_id=$1::uuid`, tenantID)
		_ = tx.Commit(cleanupCtx)
	})

	barrier := &firstRotationEncryptBarrier{
		entered: make(chan struct{}),
		release: make(chan struct{}),
	}
	store := &Store{Pool: database, Cipher: barrier}
	type rotateResult struct {
		response *CreateResponse
		err      error
	}
	firstResult := make(chan rotateResult, 1)
	go func() {
		response, rotateErr := store.Rotate(ctx, tenantID, webhookID, time.Hour)
		firstResult <- rotateResult{response: response, err: rotateErr}
	}()

	select {
	case <-barrier.entered:
	case <-ctx.Done():
		t.Fatalf("first rotation never reached encryption barrier: %v", ctx.Err())
	}
	secondResponse, secondErr := store.Rotate(ctx, tenantID, webhookID, time.Hour)
	close(barrier.release)
	first := <-firstResult
	if secondErr != nil {
		t.Fatalf("second rotation: %v", secondErr)
	}
	if first.err != nil {
		t.Fatalf("first rotation: %v", first.err)
	}
	if first.response == nil || secondResponse == nil {
		t.Fatal("rotation returned a nil response")
	}

	// The first call was deliberately paused before its UPDATE, so the second
	// call committed first. The final row must therefore demote the second key as
	// one coherent private/public pair, not combine its ciphertext with the
	// initial public key captured by the paused request.
	if got, want := first.response.Webhook.SigningPublicKey, first.response.PublicKeyPEM; got != want {
		t.Fatal("final primary public key does not match the final rotation")
	}
	if got, want := first.response.Webhook.SecondaryPublicKey, secondResponse.PublicKeyPEM; got != want {
		t.Fatal("final secondary public key does not match the immediately preceding rotation")
	}
	if got, want := first.response.Webhook.ConfigVersion, int64(3); got != want {
		t.Fatalf("final config_version = %d, want %d", got, want)
	}

	keys, err := store.LoadSigningKeys(ctx, tenantID, webhookID, time.Now().UTC())
	if err != nil {
		t.Fatalf("load final signing keys: %v", err)
	}
	if len(keys.Secondary) == 0 {
		t.Fatal("concurrent rotation lost the immediately preceding key's grace window")
	}
	body := []byte(`{"rotation":"concurrent"}`)
	now := time.Now().UTC()
	secondarySignature, err := SignBodyWithAlgorithm(keys.Algorithm, keys.Secondary, now, body)
	if err != nil {
		t.Fatalf("sign with final secondary: %v", err)
	}
	if err := VerifySignatureAlgo(
		secondarySignature,
		body,
		keys.Algorithm,
		[]byte(secondResponse.PublicKeyPEM),
		now,
		time.Minute,
	); err != nil {
		t.Fatalf("immediately preceding rotation cannot verify the grace signature: %v", err)
	}
}
