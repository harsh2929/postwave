// SPDX-License-Identifier: AGPL-3.0-only
package auth

import (
	"crypto/rand"
	"encoding/base64"
)

// randomToken returns a base64url-encoded random token of `bytes`
// bytes of entropy. Used for session verifiers (32B) and one-time
// tokens (32B, sha256d before storage).
func randomToken(bytes int) (string, error) {
	b := make([]byte, bytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
