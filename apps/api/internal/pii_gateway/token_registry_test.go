package pii_gateway

import (
	"strings"
	"testing"
)

func TestTokenRegistry_TokenizeDetokenizeRoundTrip(t *testing.T) {
	reg := NewTokenRegistry("req-1")
	email := "alice@example.com"
	tok := reg.Tokenize("EMAIL", email)
	if tok == email {
		t.Fatalf("token must differ from cleartext, got %q", tok)
	}
	if !strings.HasPrefix(tok, "[[PII:EMAIL:") {
		t.Errorf("token shape = %q, want [[PII:EMAIL:...]]", tok)
	}
	prompt := "Write to " + tok + " right away."
	restored := reg.Detokenize(prompt)
	if !strings.Contains(restored, email) {
		t.Errorf("detokenize did not restore email; got %q", restored)
	}
	if strings.Contains(restored, tok) {
		t.Errorf("detokenize left the token behind; got %q", restored)
	}
}

func TestTokenRegistry_DeterministicWithinRegistry(t *testing.T) {
	reg := NewTokenRegistry("req-1")
	a := reg.Tokenize("EMAIL", "x@y.co")
	b := reg.Tokenize("EMAIL", "x@y.co")
	if a != b {
		t.Errorf("same value must map to same token: %q vs %q", a, b)
	}
	if reg.Len() != 1 {
		t.Errorf("repeated value must register once, Len=%d", reg.Len())
	}
}

func TestTokenRegistry_DifferentSaltsDifferentTokens(t *testing.T) {
	a := NewTokenRegistry("req-A").Tokenize("EMAIL", "x@y.co")
	b := NewTokenRegistry("req-B").Tokenize("EMAIL", "x@y.co")
	if a == b {
		t.Errorf("different salts must yield different tokens, both %q", a)
	}
}

func TestTokenRegistry_EmptyValuePassthrough(t *testing.T) {
	reg := NewTokenRegistry("s")
	if got := reg.Tokenize("EMAIL", ""); got != "" {
		t.Errorf("empty value must pass through, got %q", got)
	}
	if reg.Len() != 0 {
		t.Errorf("empty value must not register, Len=%d", reg.Len())
	}
}

func TestTokenRegistry_DetokenizeUnknownTokenUntouched(t *testing.T) {
	reg := NewTokenRegistry("s")
	in := "model mentioned [[PII:EMAIL:deadbeef]] which we never issued"
	if got := reg.Detokenize(in); got != in {
		t.Errorf("unknown token must be left intact, got %q", got)
	}
}

func TestTokenRegistry_MappingsCopy(t *testing.T) {
	reg := NewTokenRegistry("s")
	tok := reg.Tokenize("PHONE", "+15551234567")
	m := reg.Mappings()
	if m[tok] != "+15551234567" {
		t.Errorf("Mappings missing token reversal: %v", m)
	}
	// Mutating the copy must not affect the registry.
	delete(m, tok)
	if reg.Detokenize(tok) != "+15551234567" {
		t.Errorf("registry corrupted by mutating Mappings copy")
	}
}

func TestSanitizeKind(t *testing.T) {
	cases := map[string]string{
		"email":         "email",
		"":              "FIELD",
		"date of birth": "date_of_birth",
		"!!!":           "___",
	}
	for in, want := range cases {
		if got := sanitizeKind(in); got != want {
			t.Errorf("sanitizeKind(%q) = %q, want %q", in, got, want)
		}
	}
}
