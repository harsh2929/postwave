package subscribers

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http/httptest"
	"strings"
	"testing"
)

// SUB-046: the proof token is the hex SHA-256 of the lowercased, trimmed
// address — deterministic and case/whitespace-insensitive so a downstream tool
// recomputing from the (erased) address matches regardless of how it cased the
// input.
func TestHashEmailForReceipt(t *testing.T) {
	want := func(s string) string {
		sum := sha256.Sum256([]byte(s))
		return hex.EncodeToString(sum[:])
	}
	cases := []struct {
		in   string
		want string
	}{
		{"alice@example.com", want("alice@example.com")},
		{"  Alice@Example.COM ", want("alice@example.com")}, // normalised
		{"", ""}, // empty -> empty
	}
	for _, c := range cases {
		if got := hashEmailForReceipt(c.in); got != c.want {
			t.Errorf("hashEmailForReceipt(%q) = %q, want %q", c.in, got, c.want)
		}
	}
	// Output is a full 64-char hex digest for a non-empty address.
	if h := hashEmailForReceipt("bob@example.com"); len(h) != 64 {
		t.Errorf("hash length = %d, want 64 hex chars", len(h))
	}
}

// SUB-046 PII invariant: the receipt's redacted label must NOT contain the
// cleartext local-part, and the hash must NOT be the raw address.
func TestErasureReceiptStoresNoCleartext(t *testing.T) {
	const email = "secret.person@example.com"
	hash := hashEmailForReceipt(email)
	if strings.Contains(hash, "secret.person") {
		t.Error("email_hash leaks the cleartext local-part")
	}
	if hash == email {
		t.Error("email_hash must not equal the cleartext address")
	}
}

// Handler requires tenant context → 401 without touching the DB.
func TestGetErasureReceiptHandler_RequiresTenant(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	rec := httptest.NewRecorder()
	d.GetErasureReceipt(rec, httptest.NewRequest("GET", "/api/v1/subscribers/abc/erasure-receipt", nil))
	if rec.Code != 401 {
		t.Fatalf("status = %d, want 401 without tenant", rec.Code)
	}
}
