// SPDX-License-Identifier: MIT

package kms

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// --- Registry tests ---

func TestRegistry_RegisterAndGet(t *testing.T) {
	r := NewRegistry()
	p := NewTinkProvider()
	r.Register(p)
	got, err := r.Get("tink")
	require.NoError(t, err)
	require.Equal(t, p, got)
}

func TestRegistry_UnknownProviderReturnsError(t *testing.T) {
	r := NewRegistry()
	_, err := r.Get("does-not-exist")
	require.ErrorIs(t, err, ErrUnknownProvider)
}

func TestIsValidProvider(t *testing.T) {
	for _, p := range []string{"aws", "gcp", "vault", "tink", "AWS"} {
		require.True(t, IsValidProvider(p), p)
	}
	require.False(t, IsValidProvider("oracle"))
	require.False(t, IsValidProvider(""))
}

func TestGenerateDEK_Length(t *testing.T) {
	dek, err := GenerateDEK()
	require.NoError(t, err)
	require.Len(t, dek, DEKSize)
}

// --- Tink provider tests ---

func TestTink_RoundTrip(t *testing.T) {
	p := NewTinkProvider()
	ks, err := GenerateKeyset(123)
	require.NoError(t, err)
	require.NoError(t, p.LoadKeyset("k1", ks))

	dek := mustRandom(t, DEKSize)
	wrapped, err := p.WrapDEK(context.Background(), "k1", dek)
	require.NoError(t, err)
	require.NotEmpty(t, wrapped)

	got, err := p.UnwrapDEK(context.Background(), "k1", wrapped)
	require.NoError(t, err)
	require.True(t, bytes.Equal(dek, got))
}

func TestTink_RejectsBadDEKSize(t *testing.T) {
	p := NewTinkProvider()
	ks, _ := GenerateKeyset(1)
	_ = p.LoadKeyset("k", ks)
	_, err := p.WrapDEK(context.Background(), "k", []byte("too short"))
	require.ErrorIs(t, err, ErrInvalidKeyRef)
}

func TestTink_KeyIDPrefixEncoded(t *testing.T) {
	p := NewTinkProvider()
	ks, _ := GenerateKeyset(42)
	require.NoError(t, p.LoadKeyset("k", ks))

	dek := mustRandom(t, DEKSize)
	wrapped, err := p.WrapDEK(context.Background(), "k", dek)
	require.NoError(t, err)

	require.Equal(t, byte(0), wrapped[0])
	require.Equal(t, byte(0), wrapped[1])
	require.Equal(t, byte(0), wrapped[2])
	require.Equal(t, byte(42), wrapped[3])

	back, err := p.UnwrapDEK(context.Background(), "k", wrapped)
	require.NoError(t, err)
	require.True(t, bytes.Equal(dek, back))
}

func TestTink_HealthCheck(t *testing.T) {
	p := NewTinkProvider()
	ks, _ := GenerateKeyset(7)
	require.NoError(t, p.LoadKeyset("k", ks))
	require.NoError(t, p.HealthCheck(context.Background(), "k"))
}

func TestTink_RejectsUnknownKeyset(t *testing.T) {
	p := NewTinkProvider()
	_, err := p.WrapDEK(context.Background(), "missing", make([]byte, DEKSize))
	require.Error(t, err)
}

func TestTink_RejectsNonAesGcmType(t *testing.T) {
	bad := []byte(`{
		"primaryKeyId":1,
		"key":[{"keyId":1,"status":"ENABLED","outputPrefixType":"RAW",
		"keyData":{"typeUrl":"type.googleapis.com/google.crypto.tink.XChaChaKey","keyMaterialType":"SYMMETRIC","value":""}}]
	}`)
	err := NewTinkProvider().LoadKeyset("k", bad)
	require.Error(t, err)
	require.Contains(t, err.Error(), "unsupported key type")
}

func TestExtractAesGcmMaterial_RawAndProtoForms(t *testing.T) {
	raw := bytes.Repeat([]byte{0x5a}, 32)

	// 1) Bare 32-byte fast path (GenerateKeyset's shortcut).
	got, err := extractAesGcmMaterial(raw)
	require.NoError(t, err)
	require.Equal(t, raw, got)

	// 2) Shortcut proto form: field 2 only, no version field.
	//    0x12 = (field=2, wire=2); 0x20 = length 32; then 32 bytes.
	wrapped := append([]byte{0x12, 0x20}, raw...)
	got2, err := extractAesGcmMaterial(wrapped)
	require.NoError(t, err)
	require.Equal(t, raw, got2)

	// 3) Real `tinkey export-keyset` form: version (field 1) + key_value.
	//    0x08 = (field=1, wire=0); 0x00 = varint zero (version);
	//    0x12 0x20 = key_value tag + length; then 32 bytes.
	withVersion := append([]byte{0x08, 0x00, 0x12, 0x20}, raw...)
	got3, err := extractAesGcmMaterial(withVersion)
	require.NoError(t, err)
	require.Equal(t, raw, got3)

	// 4) Trailing bytes after key_value must be ignored (unknown
	//    field for forward-compat, NOT silently treated as key).
	trailing := append(append([]byte{0x12, 0x20}, raw...), 0x18, 0x01) // field 3, varint 1
	got4, err := extractAesGcmMaterial(trailing)
	require.NoError(t, err)
	require.Equal(t, raw, got4)

	// 5) Wrong key_value length must error (16-byte AES-128 not allowed).
	bad := append([]byte{0x12, 0x10}, bytes.Repeat([]byte{0x01}, 16)...)
	_, err = extractAesGcmMaterial(bad)
	require.Error(t, err)
	require.Contains(t, err.Error(), "32 bytes")
}

func TestExtractAesGcmMaterial_MalformedRejected(t *testing.T) {
	// Truncated varint at start.
	_, err := extractAesGcmMaterial([]byte{0xFF})
	require.Error(t, err)

	// Length-prefix overflow (says 100 bytes but buffer has 5).
	_, err = extractAesGcmMaterial([]byte{0x12, 0x64, 0x01, 0x02, 0x03})
	require.Error(t, err)

	// Empty buffer.
	_, err = extractAesGcmMaterial(nil)
	require.Error(t, err)
}

// --- AWS provider tests with fake AWSClient ---

type fakeAWS struct {
	encrypted map[string][]byte
	wantErr   error
}

func newFakeAWS() *fakeAWS { return &fakeAWS{encrypted: map[string][]byte{}} }

func (f *fakeAWS) GenerateDataKey(_ context.Context, _ string) ([]byte, []byte, error) {
	if f.wantErr != nil {
		return nil, nil, f.wantErr
	}
	dek := make([]byte, 32)
	_, _ = rand.Read(dek)
	id := make([]byte, 8)
	_, _ = rand.Read(id)
	f.encrypted[string(id)] = append([]byte(nil), dek...)
	return dek, id, nil
}

func (f *fakeAWS) Encrypt(_ context.Context, _ string, plaintext []byte) ([]byte, error) {
	if f.wantErr != nil {
		return nil, f.wantErr
	}
	id := make([]byte, 8)
	_, _ = rand.Read(id)
	f.encrypted[string(id)] = append([]byte(nil), plaintext...)
	return id, nil
}

func (f *fakeAWS) Decrypt(_ context.Context, _ string, wrapped []byte) ([]byte, error) {
	if f.wantErr != nil {
		return nil, f.wantErr
	}
	dek, ok := f.encrypted[string(wrapped)]
	if !ok {
		return nil, errors.New("unknown wrapped blob")
	}
	return append([]byte(nil), dek...), nil
}

func TestAWS_RoundTrip(t *testing.T) {
	p := NewAWSProvider(newFakeAWS())
	dek := mustRandom(t, DEKSize)
	wrapped, err := p.WrapDEK(context.Background(), "alias/test", dek)
	require.NoError(t, err)
	got, err := p.UnwrapDEK(context.Background(), "alias/test", wrapped)
	require.NoError(t, err)
	require.True(t, bytes.Equal(dek, got))
}

func TestAWS_HealthCheck(t *testing.T) {
	p := NewAWSProvider(newFakeAWS())
	require.NoError(t, p.HealthCheck(context.Background(), "alias/test"))
}

func TestAWS_RejectsBadDEKSize(t *testing.T) {
	p := NewAWSProvider(newFakeAWS())
	_, err := p.WrapDEK(context.Background(), "alias/x", []byte("short"))
	require.ErrorIs(t, err, ErrInvalidKeyRef)
}

func TestAWS_Unconfigured(t *testing.T) {
	var p *AWSProvider
	_, err := p.UnwrapDEK(context.Background(), "x", nil)
	require.ErrorIs(t, err, ErrProviderUnconfigured)
}

// --- GCP provider tests with fake REST server ---

func TestGCP_RoundTrip(t *testing.T) {
	stored := map[string][]byte{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "Bearer test-token", r.Header.Get("Authorization"))
		body, _ := io.ReadAll(r.Body)
		switch {
		case strings.HasSuffix(r.URL.Path, ":encrypt"):
			var req struct{ Plaintext string }
			require.NoError(t, json.Unmarshal(body, &req))
			pt, err := base64.StdEncoding.DecodeString(req.Plaintext)
			require.NoError(t, err)
			id := mustRandom(t, 16)
			stored[string(id)] = pt
			_ = json.NewEncoder(w).Encode(map[string]string{
				"ciphertext": base64.StdEncoding.EncodeToString(id),
			})
		case strings.HasSuffix(r.URL.Path, ":decrypt"):
			var req struct{ Ciphertext string }
			require.NoError(t, json.Unmarshal(body, &req))
			id, _ := base64.StdEncoding.DecodeString(req.Ciphertext)
			pt, ok := stored[string(id)]
			require.True(t, ok)
			_ = json.NewEncoder(w).Encode(map[string]string{
				"plaintext": base64.StdEncoding.EncodeToString(pt),
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	p := NewGCPProvider(StaticToken("test-token"))
	p.BaseURL = srv.URL

	keyRef := "projects/p/locations/global/keyRings/r/cryptoKeys/k"
	dek := mustRandom(t, DEKSize)
	wrapped, err := p.WrapDEK(context.Background(), keyRef, dek)
	require.NoError(t, err)
	got, err := p.UnwrapDEK(context.Background(), keyRef, wrapped)
	require.NoError(t, err)
	require.True(t, bytes.Equal(dek, got))
}

func TestGCP_RejectsInvalidKeyRef(t *testing.T) {
	p := NewGCPProvider(StaticToken("x"))
	_, err := p.WrapDEK(context.Background(), "not-a-real-name", make([]byte, DEKSize))
	require.ErrorIs(t, err, ErrInvalidKeyRef)

	// Path-traversal + URL-significant-char attacks must be refused.
	bad := []string{
		"projects/../etc/passwd/cryptoKeys/k",
		"projects/p/locations/l/keyRings/r/cryptoKeys/k?alt=json",
		"projects/p/locations/l/keyRings/r/cryptoKeys/k#fragment",
		"projects/p/locations/l/keyRings/r/cryptoKeys/k%2Fevil",
		"projects/p/locations/l/keyRings/r/cryptoKeys/k\n",
		"https://evil.com/projects/p/locations/l/keyRings/r/cryptoKeys/k",
	}
	for _, ref := range bad {
		_, err := p.WrapDEK(context.Background(), ref, make([]byte, DEKSize))
		require.ErrorIs(t, err, ErrInvalidKeyRef, ref)
	}

	// Canonical form must be accepted (validate-only — we'd hit the
	// HTTP client otherwise; this just exercises the regex).
	require.True(t, gcpKeyRefRE.MatchString(
		"projects/postwave/locations/us-central1/keyRings/byok/cryptoKeys/tenant-abc"))
	require.True(t, gcpKeyRefRE.MatchString(
		"projects/postwave/locations/us-central1/keyRings/byok/cryptoKeys/tenant-abc/cryptoKeyVersions/3"))
}

func TestVault_RejectsInvalidKeyRef(t *testing.T) {
	p := NewVaultProvider("http://localhost:8200", "test-token")
	bad := []string{
		"key/with/slash",
		"key.with.dots",
		"key/../etc/passwd",
		"key%2Fwith-url-encoded",
		"key with space",
		"", // empty
	}
	for _, ref := range bad {
		_, err := p.WrapDEK(context.Background(), ref, make([]byte, DEKSize))
		require.ErrorIs(t, err, ErrInvalidKeyRef, ref)
	}
	require.True(t, vaultKeyRefRE.MatchString("tenant-abc-kek-1"))
}

func TestGCP_403MapsToPermissionDenied(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()
	p := NewGCPProvider(StaticToken("t"))
	p.BaseURL = srv.URL
	_, err := p.WrapDEK(context.Background(), "projects/p/locations/l/keyRings/r/cryptoKeys/k", make([]byte, DEKSize))
	require.ErrorIs(t, err, ErrPermissionDenied)
}

// --- Vault provider tests ---

func TestVault_RoundTrip(t *testing.T) {
	stored := map[string][]byte{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "test-token", r.Header.Get("X-Vault-Token"))
		body, _ := io.ReadAll(r.Body)
		switch {
		case strings.Contains(r.URL.Path, "/encrypt/"):
			var req struct{ Plaintext string }
			require.NoError(t, json.Unmarshal(body, &req))
			pt, _ := base64.StdEncoding.DecodeString(req.Plaintext)
			id := mustRandom(t, 16)
			ct := "vault:v1:" + base64.StdEncoding.EncodeToString(id)
			stored[ct] = pt
			_ = json.NewEncoder(w).Encode(map[string]map[string]string{
				"data": {"ciphertext": ct},
			})
		case strings.Contains(r.URL.Path, "/decrypt/"):
			var req struct{ Ciphertext string }
			require.NoError(t, json.Unmarshal(body, &req))
			pt, ok := stored[req.Ciphertext]
			require.True(t, ok)
			_ = json.NewEncoder(w).Encode(map[string]map[string]string{
				"data": {"plaintext": base64.StdEncoding.EncodeToString(pt)},
			})
		default:
			t.Fatalf("unexpected vault path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	p := NewVaultProvider(srv.URL, "test-token")
	dek := mustRandom(t, DEKSize)
	wrapped, err := p.WrapDEK(context.Background(), "tenant-abc", dek)
	require.NoError(t, err)
	require.True(t, strings.HasPrefix(string(wrapped), "vault:v"))
	got, err := p.UnwrapDEK(context.Background(), "tenant-abc", wrapped)
	require.NoError(t, err)
	require.True(t, bytes.Equal(dek, got))
}

func TestVault_NoTokenIsUnconfigured(t *testing.T) {
	p := NewVaultProvider("http://localhost:8200", "")
	_, err := p.WrapDEK(context.Background(), "k", make([]byte, DEKSize))
	require.ErrorIs(t, err, ErrProviderUnconfigured)
}

// --- Helpers ---

func mustRandom(t *testing.T, n int) []byte {
	t.Helper()
	b := make([]byte, n)
	_, err := io.ReadFull(rand.Reader, b)
	require.NoError(t, err)
	return b
}
