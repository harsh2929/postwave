// SPDX-License-Identifier: AGPL-3.0-only
package mcp

import (
	"testing"
	"time"
)

func TestListCursorRoundTrip(t *testing.T) {
	c := listCursor{CreatedAt: time.Date(2026, 6, 19, 12, 0, 0, 0, time.UTC), ID: "abc-123"}
	tok := encodeCursor(c)
	if tok == "" {
		t.Fatal("encode produced empty token")
	}
	got, ok := decodeCursor(tok)
	if !ok {
		t.Fatal("decode of a valid token failed")
	}
	if !got.CreatedAt.Equal(c.CreatedAt) || got.ID != c.ID {
		t.Fatalf("round-trip mismatch: got %+v want %+v", got, c)
	}
}

func TestDecodeCursorRejectsGarbage(t *testing.T) {
	for _, s := range []string{"", "not-base64!!", "eyJ4IjoxfQ" /* {"x":1} no id */} {
		if _, ok := decodeCursor(s); ok {
			t.Fatalf("decodeCursor(%q) should fail-safe to ok=false", s)
		}
	}
}
