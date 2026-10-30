// SPDX-License-Identifier: AGPL-3.0-only
package inboxreality

import (
	"encoding/hex"
	"testing"
)

func TestMintToken_LengthAndEntropy(t *testing.T) {
	seen := map[string]struct{}{}
	for i := 0; i < 200; i++ {
		tok, err := MintToken()
		if err != nil {
			t.Fatalf("MintToken err on iter %d: %v", i, err)
		}
		if len(tok) != 32 {
			t.Errorf("token length = %d, want 32 hex chars", len(tok))
		}
		if _, err := hex.DecodeString(tok); err != nil {
			t.Errorf("token %q is not valid hex: %v", tok, err)
		}
		if _, dup := seen[tok]; dup {
			t.Errorf("duplicate token across 200 mints: %q", tok)
		}
		seen[tok] = struct{}{}
	}
}

func TestFormatHeaderValue_RoundTrip(t *testing.T) {
	tok := "abcdef0123456789abcdef0123456789"
	formatted := FormatHeaderValue(tok)
	if formatted != "irt_"+tok {
		t.Errorf("formatted = %q, want irt_<token>", formatted)
	}
	if back := ParseHeaderValue(formatted); back != tok {
		t.Errorf("ParseHeaderValue(formatted) = %q, want %q", back, tok)
	}
	// ParseHeaderValue should also accept the unprefixed form.
	if back := ParseHeaderValue(tok); back != tok {
		t.Errorf("ParseHeaderValue(bare token) = %q, want %q", back, tok)
	}
	// And reject a value too short to contain the prefix.
	if back := ParseHeaderValue("ab"); back != "ab" {
		t.Errorf("short value should pass through unchanged")
	}
}
