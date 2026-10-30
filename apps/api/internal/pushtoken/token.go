// SPDX-License-Identifier: AGPL-3.0-only

// Package pushtoken defines the one exact-byte identity domain shared by
// device registration, suppression creation, and the provider send gate.
package pushtoken

import (
	"errors"
	"fmt"
	"unicode"
	"unicode/utf8"
)

const (
	MinBytes = 20
	MaxBytes = 4096
)

// ValidateExact rejects any token that cannot be represented and suppressed
// byte-for-byte. It deliberately performs no trimming, case folding, Unicode
// normalization, decoding, or other rewrite.
func ValidateExact(token string) error {
	if !utf8.ValidString(token) {
		return errors.New("device_token must be valid UTF-8")
	}
	if len(token) < MinBytes || len(token) > MaxBytes {
		return fmt.Errorf("device_token must be between %d and %d bytes", MinBytes, MaxBytes)
	}
	for _, r := range token {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			return errors.New("device_token must not contain whitespace or control characters")
		}
	}
	return nil
}
