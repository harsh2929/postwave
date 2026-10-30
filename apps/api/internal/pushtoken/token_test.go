// SPDX-License-Identifier: AGPL-3.0-only

package pushtoken

import (
	"strings"
	"testing"
)

func TestValidateExact(t *testing.T) {
	valid := strings.Repeat("é", 10) // 10 runes, exactly 20 UTF-8 bytes.
	if err := ValidateExact(valid); err != nil {
		t.Fatalf("valid exact-byte token rejected: %v", err)
	}
	for name, token := range map[string]string{
		"short":              strings.Repeat("a", MinBytes-1),
		"long":               strings.Repeat("a", MaxBytes+1),
		"ascii whitespace":   strings.Repeat("a", MinBytes) + " ",
		"unicode whitespace": strings.Repeat("a", MinBytes) + "\u00a0",
		"control":            strings.Repeat("a", MinBytes) + "\x00",
		"invalid utf8":       strings.Repeat("a", MinBytes) + string([]byte{0xff}),
	} {
		t.Run(name, func(t *testing.T) {
			if err := ValidateExact(token); err == nil {
				t.Fatal("hostile token accepted")
			}
		})
	}
}
