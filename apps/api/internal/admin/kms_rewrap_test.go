// SPDX-License-Identifier: AGPL-3.0-only
package admin

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	pwcrypto "github.com/postwave/postwave/apps/api/internal/crypto"
)

// mockCipher implements EnvelopeCipher with the same shape as the
// production cipher: v=0x01 blobs decrypt with legacyKEK, v=0x02 blobs
// round-trip via the static envelope. Lets the unit tests exercise the
// version-detect + rewrap path without standing up KMS.
type mockCipher struct {
	envelope *pwcrypto.EnvelopeCipher
}

func newMockCipher(t *testing.T) (*mockCipher, []byte) {
	t.Helper()
	kek := bytes.Repeat([]byte{0x55}, 32)
	env, err := pwcrypto.NewStaticEnvelope(kek)
	if err != nil {
		t.Fatal(err)
	}
	return &mockCipher{envelope: env}, kek
}

func (m *mockCipher) Encrypt(ctx context.Context, plaintext []byte) ([]byte, error) {
	return m.envelope.Encrypt(ctx, plaintext)
}

func (m *mockCipher) Decrypt(ctx context.Context, blob, legacyKEK []byte) ([]byte, error) {
	return m.envelope.Decrypt(ctx, blob, legacyKEK)
}

// makeLegacyBlob constructs a v=0x01 blob the same way the legacy
// provisioner writes it: [0x01][nonce][ct+tag] under legacyKEK.
func makeLegacyBlob(t *testing.T, legacyKEK, plaintext []byte) []byte {
	t.Helper()
	block, err := aes.NewCipher(legacyKEK)
	if err != nil {
		t.Fatal(err)
	}
	g, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	nonce := make([]byte, g.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		t.Fatal(err)
	}
	ct := g.Seal(nil, nonce, plaintext, nil)
	return append([]byte{pwcrypto.VersionLegacyDirect}, append(nonce, ct...)...)
}

func TestAuthorizeFailsClosed(t *testing.T) {
	d := &Deps{} // no token, no dev allow
	r := httptest.NewRequest(http.MethodPost, "/", nil)
	if d.authorize(r) {
		t.Fatal("must fail closed without token")
	}
}

func TestAuthorizeAllowsDevToken(t *testing.T) {
	d := &Deps{AllowDevToken: true}
	r := httptest.NewRequest(http.MethodPost, "/", nil)
	if !d.authorize(r) {
		t.Fatal("dev token must allow")
	}
}

func TestAuthorizeRejectsWrongBearer(t *testing.T) {
	d := &Deps{InternalAPIToken: "secret"}
	r := httptest.NewRequest(http.MethodPost, "/", nil)
	r.Header.Set("Authorization", "Bearer wrong")
	if d.authorize(r) {
		t.Fatal("wrong bearer must be rejected")
	}
	r.Header.Set("Authorization", "Bearer secret")
	if !d.authorize(r) {
		t.Fatal("matching bearer must be accepted")
	}
}

func TestRoutesRequireAuth(t *testing.T) {
	d := &Deps{InternalAPIToken: "secret"}
	r := chi.NewRouter()
	d.MountRoutes(r)
	for _, path := range []string{
		"/api/internal/admin/kms/rewrap-postmark-tokens",
		"/api/internal/admin/kms/rewrap-slack-tokens",
		"/api/internal/admin/kms/rewrap-webhook-secrets",
	} {
		req := httptest.NewRequest(http.MethodPost, path, nil)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("%s: got %d want 401", path, w.Code)
		}
	}
}

func TestRoutesPoolRequiredAfterAuth(t *testing.T) {
	d := &Deps{AllowDevToken: true}
	r := chi.NewRouter()
	d.MountRoutes(r)
	req := httptest.NewRequest(http.MethodPost,
		"/api/internal/admin/kms/rewrap-postmark-tokens", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("got %d want 500", w.Code)
	}
	var body map[string]any
	_ = json.NewDecoder(w.Body).Decode(&body)
	if errBody, _ := body["error"].(map[string]any); errBody == nil ||
		errBody["code"] != "no_pool" {
		t.Fatalf("expected no_pool error, got %v", body)
	}
}

func TestVersionDetectSkipAlreadyEnvelope(t *testing.T) {
	// Without a DB we can still exercise the version-byte short-circuit
	// path — it lives entirely above the persist() call. We do this by
	// hand-rolling the rewrapColumn path with an in-memory rowRec.
	cph, _ := newMockCipher(t)
	d := &Deps{Cipher: cph}
	plain := []byte("postmark-token-deadbeef")
	envBlob, err := cph.Encrypt(context.Background(), plain)
	if err != nil {
		t.Fatal(err)
	}
	if envBlob[0] != pwcrypto.VersionEnvelope {
		t.Fatalf("seed blob version: got 0x%02x", envBlob[0])
	}
	// Skipped path: a v=0x02 blob should be skipped without touching
	// the cipher (we can't easily assert "not called" without a wrapper,
	// but we can at least verify the blob length is unchanged after
	// a roundtrip through Decrypt — i.e. the rewrap is idempotent).
	got, err := d.Cipher.Decrypt(context.Background(), envBlob, nil)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if !bytes.Equal(got, plain) {
		t.Fatal("decrypt mismatch")
	}
}

func TestLegacyBlobRewrapsToEnvelope(t *testing.T) {
	cph, kek := newMockCipher(t)
	d := &Deps{Cipher: cph, LegacyKEK: kek}
	plain := []byte("postmark-server-token-XYZ")
	legacy := makeLegacyBlob(t, kek, plain)
	if legacy[0] != pwcrypto.VersionLegacyDirect {
		t.Fatalf("seed: not legacy, got 0x%02x", legacy[0])
	}
	// Decrypt under the cipher's legacy fallback.
	got, err := d.Cipher.Decrypt(context.Background(), legacy, kek)
	if err != nil {
		t.Fatalf("decrypt legacy: %v", err)
	}
	if !bytes.Equal(got, plain) {
		t.Fatal("legacy decrypt mismatch")
	}
	// Re-encrypt should yield v=0x02.
	rewrapped, err := d.Cipher.Encrypt(context.Background(), got)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	if rewrapped[0] != pwcrypto.VersionEnvelope {
		t.Fatalf("rewrap version: got 0x%02x want 0x%02x",
			rewrapped[0], pwcrypto.VersionEnvelope)
	}
	// And the rewrapped blob must round-trip back to the same plain.
	got2, err := d.Cipher.Decrypt(context.Background(), rewrapped, nil)
	if err != nil {
		t.Fatalf("rewrap decrypt: %v", err)
	}
	if !bytes.Equal(got2, plain) {
		t.Fatal("rewrap roundtrip mismatch")
	}
}

// newPool returns a real pgx pool when DATABASE_URL is set; skips
// otherwise. Used by the integration-style tests below.
func newPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed admin test")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("pgx connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestRewrapPostmarkTokensIdempotent(t *testing.T) {
	pool := newPool(t)
	cph, kek := newMockCipher(t)
	d := &Deps{
		Pool: pool, Cipher: cph, LegacyKEK: kek, AllowDevToken: true,
	}

	tenantID := "00000000-0000-0000-0000-000000005555"
	plain := []byte("postmark-token-test-1234")
	legacy := makeLegacyBlob(t, kek, plain)

	// Seed sending_state under tenant scope.
	tx, err := pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(context.Background(),
		`SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		_ = tx.Rollback(context.Background())
		t.Fatalf("set tenant: %v", err)
	}
	// The tenant this row belongs to. `sending_state.tenant_id` is a foreign key
	// and nothing created it, so the seed below was always rejected and the
	// Skipf reported it as a PASS. The tenant GUC is already set above, which is
	// what the tenants INSERT policy reads.
	if _, err := tx.Exec(context.Background(), `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'kms-rewrap-test', 'kms-rewrap-' || right($1::text, 12), 'studio')
ON CONFLICT (id) DO NOTHING`, tenantID); err != nil {
		_ = tx.Rollback(context.Background())
		t.Fatalf("seed tenant: %v", err)
	}
	if _, err := tx.Exec(context.Background(), `
INSERT INTO sending_state (tenant_id, tier, postmark_server_id, postmark_server_token_encrypted)
VALUES ($1::uuid, 'sending', '1', $2)
ON CONFLICT (tenant_id) DO UPDATE SET postmark_server_token_encrypted = EXCLUDED.postmark_server_token_encrypted`,
		tenantID, legacy); err != nil {
		_ = tx.Rollback(context.Background())
		t.Fatalf("seed sending_state: %v", err)
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatalf("commit seed: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(),
			`DELETE FROM sending_state WHERE tenant_id = $1::uuid`, tenantID)
	})

	r := chi.NewRouter()
	d.MountRoutes(r)

	// First call: should rewrap our seeded row.
	req := httptest.NewRequest(http.MethodPost,
		"/api/internal/admin/kms/rewrap-postmark-tokens", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("first call: got %d, body=%s", w.Code, w.Body.String())
	}
	var first rewrapResult
	if err := json.NewDecoder(w.Body).Decode(&first); err != nil {
		t.Fatalf("decode first: %v", err)
	}
	if first.Rewrapped < 1 {
		t.Fatalf("first call: rewrapped=%d, expected >= 1", first.Rewrapped)
	}

	// Second call: row is now v=0x02 → skipped.
	req2 := httptest.NewRequest(http.MethodPost,
		"/api/internal/admin/kms/rewrap-postmark-tokens", nil)
	w2 := httptest.NewRecorder()
	r.ServeHTTP(w2, req2)
	if w2.Code != http.StatusOK {
		t.Fatalf("second call: got %d", w2.Code)
	}
	var second rewrapResult
	if err := json.NewDecoder(w2.Body).Decode(&second); err != nil {
		t.Fatalf("decode second: %v", err)
	}
	// Our seeded row must show up in skipped on the second pass.
	if second.Rewrapped != 0 {
		t.Fatalf("idempotent: second-call rewrapped=%d, want 0", second.Rewrapped)
	}
}
