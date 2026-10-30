// SPDX-License-Identifier: AGPL-3.0-only

package subscriber_import

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
)

// randHex returns 12 hex characters for the object-key suffix.
func randHex() (string, error) {
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("generate import object key: %w", err)
	}
	return hex.EncodeToString(b[:]), nil
}
