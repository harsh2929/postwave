// SPDX-License-Identifier: AGPL-3.0-only
//
// tokens.go — header_token minting. The token is what links a
// dispatched test message to the row in inbox_reality_tests; the
// seedlist poller reads the X-Postwave-Test-ID header and looks the
// token up to find the parent test.
//
// Requirements:
//   1. Unique with overwhelming probability across all tenants
//      (UNIQUE constraint catches the cosmic-ray collision; the
//      handler retries on 23505).
//   2. URL-safe (printed in JSON, copied into headers, sometimes shown
//      in dashboard URLs for the "share this test" button).
//   3. Indistinguishable from random — an attacker observing one token
//      must not be able to predict any other.
//   4. Compact — RFC 5322 doesn't limit header value length but
//      relays sometimes choke past ~78 chars. 32 hex chars (16 bytes
//      of entropy) is well within budget.
//
// Implementation: 16 bytes from crypto/rand, hex-encoded → 32 chars.
// The prefix "irt_" (Inbox Reality Test) is added at the API layer so
// logs can grep for it; the raw token in the DB column has no prefix
// (keeps the UNIQUE shorter).

package inboxreality

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
)

// TokenPrefix is the display-prefix used when surfacing the token in
// API responses + header values. The DB stores the unprefixed hex; the
// API layer concatenates the prefix on output and strips it on input.
const TokenPrefix = "irt_"

// MintToken returns 16 bytes of crypto/rand hex-encoded. Returns an
// error only when crypto/rand cannot read — under that condition the
// caller should propagate (NEVER fall back to math/rand; that creates
// a guessable token that breaks the security model).
func MintToken() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("inboxreality: mint token: %w", err)
	}
	return hex.EncodeToString(b[:]), nil
}

// FormatHeaderValue returns the customer-facing token (with prefix).
// The header_token column stores the unprefixed form; this function
// is what the handler sends back so the customer drops it into the
// X-Postwave-Test-ID header verbatim.
func FormatHeaderValue(token string) string {
	return TokenPrefix + token
}

// ParseHeaderValue is the inverse — strip the prefix if present, return
// the bare hex token suitable for a DB lookup. We accept either the
// prefixed or unprefixed form so the seedlist poller can send either.
func ParseHeaderValue(s string) string {
	if len(s) > len(TokenPrefix) && s[:len(TokenPrefix)] == TokenPrefix {
		return s[len(TokenPrefix):]
	}
	return s
}
