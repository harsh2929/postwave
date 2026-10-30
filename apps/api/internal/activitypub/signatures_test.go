package activitypub

import (
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TestComputeDigest_KnownVector pins the SHA-256 digest output to a
// known vector. The empty-body SHA-256 base64 is a well-known constant
// — Mastodon, ActivityPub Pleroma, and the HTTP Signatures RFC all
// agree on it. If this constant ever drifts we've broken Fediverse
// federation.
func TestComputeDigest_KnownVector(t *testing.T) {
	// SHA-256("") base64 → "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU="
	// with `+` not `-` (StdEncoding, not URLEncoding).
	const emptyHashB64 = "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU="
	got := computeDigest(nil)
	want := "SHA-256=" + emptyHashB64
	if got != want {
		t.Fatalf("empty body digest: got %q, want %q", got, want)
	}

	got = computeDigest([]byte(""))
	if got != want {
		t.Fatalf("empty []byte digest: got %q, want %q", got, want)
	}
}

// TestComputeDigest_RFCRoundTrip verifies the digest matches a hand-
// computed SHA-256 over a non-empty body. Pinning this catches base64
// alphabet drift (URLEncoding vs StdEncoding) — Mastodon parses
// StdEncoding only.
func TestComputeDigest_RFCRoundTrip(t *testing.T) {
	body := []byte(`{"type":"Create","actor":"https://example.com/users/alice"}`)
	h := sha256.Sum256(body)
	want := "SHA-256=" + base64.StdEncoding.EncodeToString(h[:])

	got := computeDigest(body)
	if got != want {
		t.Fatalf("digest mismatch: got %q, want %q", got, want)
	}
	if strings.Contains(got, "DEFERRED") {
		t.Fatalf("digest still returns DEFERRED placeholder: %q", got)
	}
}

// TestSetSigningHeaders_DigestPopulated ensures the SetSigningHeaders
// helper stamps a real digest derived from the body, not a placeholder.
func TestSetSigningHeaders_DigestPopulated(t *testing.T) {
	body := []byte(`{"id":"https://example.com/notes/1"}`)
	req := httptest.NewRequest(http.MethodPost, "https://remote.example/inbox", strings.NewReader(""))
	SetSigningHeaders(req, body, time.Unix(1700000000, 0))

	got := req.Header.Get("Digest")
	if got == "" {
		t.Fatal("Digest header not set")
	}
	if strings.Contains(got, "DEFERRED") {
		t.Fatalf("Digest header still placeholder: %q", got)
	}
	if !strings.HasPrefix(got, "SHA-256=") {
		t.Fatalf("Digest header missing SHA-256 prefix: %q", got)
	}

	h := sha256.Sum256(body)
	want := "SHA-256=" + base64.StdEncoding.EncodeToString(h[:])
	if got != want {
		t.Fatalf("Digest header mismatch: got %q, want %q", got, want)
	}
}
