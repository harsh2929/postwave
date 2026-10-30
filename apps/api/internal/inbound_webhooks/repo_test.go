// SPDX-License-Identifier: AGPL-3.0-only
package inbound_webhooks

import (
	"bytes"
	"context"
	"crypto/hmac"
	cryptorand "crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

type recordingInboundEnvelopeCipher struct {
	encrypted []byte
	err       error
}

func (c *recordingInboundEnvelopeCipher) Encrypt(_ context.Context, plaintext []byte) ([]byte, error) {
	c.encrypted = append([]byte(nil), plaintext...)
	if c.err != nil {
		return nil, c.err
	}
	return append([]byte("wrapped:"), plaintext...), nil
}

func (c *recordingInboundEnvelopeCipher) Decrypt(_ context.Context, blob, _ []byte) ([]byte, error) {
	return bytes.TrimPrefix(blob, []byte("wrapped:")), nil
}

func TestSignatureValid_AcceptsCorrect(t *testing.T) {
	secret := "iwh_test_secret"
	body := []byte(`{"event":"hello"}`)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	sig := hex.EncodeToString(mac.Sum(nil))
	if !SignatureValid(secret, body, sig) {
		t.Fatal("valid signature rejected")
	}
}

func TestSignatureValid_RejectsTamper(t *testing.T) {
	secret := "iwh_test_secret"
	body := []byte(`{"event":"hello"}`)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	sig := hex.EncodeToString(mac.Sum(nil))
	if SignatureValid(secret, []byte(`{"event":"goodbye"}`), sig) {
		t.Fatal("tampered body accepted")
	}
	if SignatureValid("wrong_secret", body, sig) {
		t.Fatal("wrong secret accepted")
	}
}

func TestSignatureValid_RejectsBadHex(t *testing.T) {
	if SignatureValid("s", []byte("body"), "not-hex") {
		t.Fatal("bad hex accepted")
	}
}

func TestSignatureValidRejectsEmptySecret(t *testing.T) {
	mac := hmac.New(sha256.New, nil)
	_, _ = mac.Write([]byte("body"))
	if SignatureValid("", []byte("body"), hex.EncodeToString(mac.Sum(nil))) {
		t.Fatal("empty endpoint secret must fail closed")
	}
}

func TestInboundTimestampAndReplayKey(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	if err := validateInboundTimestamp("1800000000", now); err != nil {
		t.Fatalf("fresh timestamp rejected: %v", err)
	}
	if !errors.Is(validateInboundTimestamp("", now), errMissingTimestamp) {
		t.Fatal("missing timestamp was not rejected")
	}
	if !errors.Is(validateInboundTimestamp("1799999000", now), errStaleTimestamp) {
		t.Fatal("stale timestamp was not rejected")
	}
	h := http.Header{"X-Postwave-Event-Id": []string{"provider-event-1"}}
	a, err := inboundWebhookReplayKey(h)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := inboundWebhookReplayKey(http.Header{"X-Event-Id": []string{"provider-event-1"}})
	if a != b || !strings.HasPrefix(a, "event:v1:") || strings.Contains(a, "provider-event-1") {
		t.Fatalf("unexpected replay keys: %q %q", a, b)
	}
	if _, err := inboundWebhookReplayKey(http.Header{}); !errors.Is(err, errMissingEventID) {
		t.Fatalf("missing event id error = %v", err)
	}
	if _, err := inboundWebhookReplayKey(http.Header{"X-Postwave-Event-Id": []string{strings.Repeat("x", 513)}}); !errors.Is(err, errEventIDTooLong) {
		t.Fatalf("oversized event id error = %v", err)
	}
}

func TestRecordEventRejectsMalformedReplayKeyBeforeDatabaseUse(t *testing.T) {
	repo := &Repo{}
	if _, _, err := repo.RecordEvent(t.Context(), "tenant", "endpoint", nil, nil, true, ""); err == nil {
		t.Fatal("missing replay key accepted")
	}
}

func TestEncodeSecretForStorageNeverReturnsPlaintextWhenCipherConfigured(t *testing.T) {
	cipher := &recordingInboundEnvelopeCipher{}
	repo := &Repo{Cipher: cipher}
	legacy, envelope, err := repo.encodeSecretForStorage(t.Context(), "iwh_super_secret")
	if err != nil {
		t.Fatalf("encode secret: %v", err)
	}
	if legacy != "envelope:do-not-use" {
		t.Fatalf("legacy column = %q, want envelope sentinel", legacy)
	}
	if bytes.Equal(envelope, []byte("iwh_super_secret")) || !bytes.Equal(cipher.encrypted, []byte("iwh_super_secret")) {
		t.Fatalf("secret was not passed through the envelope cipher: envelope=%q encrypted=%q", envelope, cipher.encrypted)
	}
}

func TestEncodeSecretForStorageFailsClosedOnCipherError(t *testing.T) {
	want := errors.New("kms unavailable")
	repo := &Repo{Cipher: &recordingInboundEnvelopeCipher{err: want}}
	legacy, envelope, err := repo.encodeSecretForStorage(t.Context(), "iwh_super_secret")
	if !errors.Is(err, want) {
		t.Fatalf("error = %v, want wrapped cipher error", err)
	}
	if legacy != "" || envelope != nil {
		t.Fatalf("failed wrap returned storage material: legacy=%q envelope=%q", legacy, envelope)
	}
}

// TestRepoList_QFilter inserts 5 endpoints with mixed names and asserts
// that List(q) filters by name OR slug substring (case-insensitive).
// Skips silently when DATABASE_URL is unset.
func TestRepoList_QFilter(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	pool, poolErr := db.New(ctx, url)
	if poolErr != nil {
		t.Fatalf("db.New: %v", poolErr)
	}
	// t.Cleanup, not defer. The tenant and endpoint cleanups registered below
	// use this pool, and Go runs a test's deferred calls before its t.Cleanup
	// callbacks. With `defer pool.Close()` every cleanup ran on a closed pool and
	// failed silently, so the tenant and its five endpoints stayed in the shared
	// database. Cleanups run last-registered-first, so registering Close first
	// keeps the pool open until all of them have run.
	t.Cleanup(pool.Close)

	tenantID := createInboundWebhookTestTenant(t, ctx, pool)
	tag := randHex4IW(t)
	prefix := "qf-" + tag + "-"
	repo := &Repo{Pool: pool}
	t.Cleanup(func() { cleanupEndpoints(pool, tenantID, prefix) })

	for _, name := range []string{
		prefix + "Alpha hook",
		prefix + "ALPHAbet hook",
		prefix + "Beta hook",
		prefix + "Gamma hook",
		prefix + "Delta hook",
	} {
		if _, err := repo.Create(ctx, tenantID, name); err != nil {
			t.Fatalf("seed %q: %v", name, err)
		}
	}

	got, poolErr := repo.List(ctx, tenantID, "alpha")
	if poolErr != nil {
		t.Fatalf("List q=alpha: %v", poolErr)
	}
	matched := 0
	for _, ep := range got {
		if strings.HasPrefix(ep.Name, prefix) {
			matched++
		}
	}
	if matched != 2 {
		t.Fatalf("q=alpha: matched %d, want 2 (got=%v)", matched, got)
	}
}

func randHex4IW(t *testing.T) string {
	t.Helper()
	var b [4]byte
	if _, err := cryptorand.Read(b[:]); err != nil {
		t.Fatalf("rand: %v", err)
	}
	return hex.EncodeToString(b[:])
}

func createInboundWebhookTestTenant(t *testing.T, ctx context.Context, pool *db.Pool) string {
	t.Helper()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	var tenantID string
	if err := conn.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&tenantID); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `SELECT set_config('app.tenant_id', $1, false)`, tenantID); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, 'Inbound webhook test', 'pro')`, tenantID, "iwh-test-"+randHex4IW(t)); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		cleanupConn, err := pool.Acquire(cleanupCtx)
		if err != nil {
			// This is reported, not ignored. Without a connection nothing below
			// runs, and the tenant stays in the shared database together with
			// every endpoint, event and action intent written under it. Four
			// tests leaked their tenants this way because they closed the pool
			// with defer, which runs before this cleanup. Callers must register
			// t.Cleanup(pool.Close) before they call this helper.
			t.Errorf("cleanup of tenant %s could not get a connection (was the pool closed before t.Cleanup ran?): %v",
				tenantID, err)
			return
		}
		defer cleanupConn.Release()
		// Deleting the tenant is the only cleanup that removes the endpoints.
		// postwave_app has no DELETE on inbound_webhook_endpoints (migration
		// 1793 replaced deletes with tombstones), so the rows go through the
		// ON DELETE CASCADE from tenants.
		_, _ = cleanupConn.Exec(cleanupCtx, `SELECT set_config('app.tenant_id', $1, false)`, tenantID)
		if _, err := cleanupConn.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID); err != nil {
			// Best effort, like the repo's other tenant cleanups. The cascade
			// takes thousands of locks, and under concurrent load it can
			// exhaust the server's shared lock table (SQLSTATE 53200) through
			// no fault of this test.
			t.Logf("cleanup of tenant %s: %v", tenantID, err)
		}
	})
	return tenantID
}

func cleanupEndpoints(pool *db.Pool, tenantID, prefix string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, _ = tx.Exec(ctx, `DELETE FROM inbound_webhook_endpoints WHERE tenant_id = $1::uuid AND name LIKE $2`, tenantID, prefix+"%")
	_ = tx.Commit(ctx)
}
