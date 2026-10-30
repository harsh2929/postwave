// SPDX-License-Identifier: AGPL-3.0-only
package preferences

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"
)

// NewToken returns a fresh hex-encoded 32-byte (64 hex char) token. Callers
// persist it in preference_tokens with the supplied (tenantID, email, ttl).
func NewToken() (string, error) {
	var buf [32]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", fmt.Errorf("preferences: rand: %w", err)
	}
	return hex.EncodeToString(buf[:]), nil
}

// DefaultTokenTTL is the recommended lifetime for a preference token. Long
// enough that an emailed link still works on a casual click-through, short
// enough that a leaked link expires before it can be widely abused.
const DefaultTokenTTL = 30 * 24 * time.Hour
