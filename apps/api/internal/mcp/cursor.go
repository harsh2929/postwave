// SPDX-License-Identifier: AGPL-3.0-only
package mcp

import (
	"encoding/base64"
	"encoding/json"
	"time"
)

// listCursor is an opaque keyset cursor for the native list tools. Keyset
// (not OFFSET) so deep pages stay O(log n) and never skip/duplicate rows
// when the underlying set shifts. The pair (created_at, id) is the stable,
// unique sort key for both campaigns and subscribers.
type listCursor struct {
	CreatedAt time.Time `json:"c"`
	ID        string    `json:"i"`
}

// encodeCursor renders a cursor as a URL-safe opaque token.
func encodeCursor(c listCursor) string {
	b, _ := json.Marshal(c)
	return base64.RawURLEncoding.EncodeToString(b)
}

// decodeCursor parses a token. ok=false on any malformed input (a caller
// passing garbage simply starts from the first page rather than erroring).
func decodeCursor(s string) (listCursor, bool) {
	if s == "" {
		return listCursor{}, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return listCursor{}, false
	}
	var c listCursor
	if err := json.Unmarshal(raw, &c); err != nil || c.ID == "" {
		return listCursor{}, false
	}
	return c, true
}
