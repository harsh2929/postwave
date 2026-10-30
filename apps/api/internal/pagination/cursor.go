// Package pagination provides shared keyset cursor pagination
// primitives for list endpoints (p1-server-pagination). Cursors are
// opaque, base64url-encoded JSON envelopes carrying the last row's
// sort keys. Callers compose a SQL WHERE clause using DecodeCursor()
// + EncodeCursor() on the boundary.
//
// Cursor encoding: base64url(no padding) of {"k":<created_at RFC3339Nano>,"i":<id>}.
//
// Stability: because the cursor pins to a tuple of (created_at, id),
// freshly inserted rows after the first page do not displace later
// pages. The base test (cursor_stable_test.go) asserts this for every
// cursor caller.
package pagination

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// DefaultLimit is the per-page default when the caller omits ?limit=.
// Picked to match the desktop UI's list-page slot count (50 rows /
// virtual scroll viewport) so a single page typically renders without
// a follow-up fetch.
const DefaultLimit = 50

// MaxLimit is the hard ceiling on ?limit=. The cursor envelope makes
// arbitrarily-deep pagination cheap on the server side, but per-page
// payload size still grows linearly with limit. 200 is generous for
// power users without blowing past the API gateway's response budget.
const MaxLimit = 200

// ErrInvalidCursor is returned by DecodeCursor when the input is
// malformed (bad base64, bad JSON, or missing required fields).
// Handlers should map this to HTTP 400 invalid_cursor.
var ErrInvalidCursor = errors.New("invalid cursor")

// Cursor is the decoded keyset position. Both fields are required;
// id breaks ties when two rows share the same SortKey (extremely
// rare in practice but possible under bulk insert).
//
// SortKey holds the row's sort-order timestamp — whatever column the
// endpoint's ORDER BY uses (created_at, updated_at, ordered_at, …), not
// necessarily created_at. The JSON wire key is the neutral "k". Callers
// must pin the cursor to the SAME column they ORDER BY, with id as the
// tiebreaker, or pages will overlap/skip.
type Cursor struct {
	SortKey time.Time `json:"k"`
	ID      string    `json:"i"`
}

// cursorEnvelope is the wire shape. Kept separate from Cursor so
// callers don't have to know the JSON field names (they manipulate
// the typed struct).
type cursorEnvelope struct {
	K string `json:"k"`
	I string `json:"i"`
}

// Encode serializes a cursor to a base64url string. Empty Cursor →
// empty string (callers use that to signal "no more pages").
func Encode(c Cursor) string {
	if c.ID == "" {
		return ""
	}
	env := cursorEnvelope{
		K: c.SortKey.UTC().Format(time.RFC3339Nano),
		I: c.ID,
	}
	raw, _ := json.Marshal(env)
	return base64.RawURLEncoding.EncodeToString(raw)
}

// Decode parses a cursor string. Empty input is allowed (returns the
// zero Cursor, no error) so handlers can call Decode unconditionally
// on every request.
func Decode(s string) (Cursor, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return Cursor{}, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		// Try standard padding as a fallback so URL-safe / standard
		// base64 callers both work.
		raw, err = base64.StdEncoding.DecodeString(s)
		if err != nil {
			return Cursor{}, ErrInvalidCursor
		}
	}
	var env cursorEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return Cursor{}, ErrInvalidCursor
	}
	if env.I == "" || env.K == "" {
		return Cursor{}, ErrInvalidCursor
	}
	t, err := time.Parse(time.RFC3339Nano, env.K)
	if err != nil {
		return Cursor{}, ErrInvalidCursor
	}
	return Cursor{SortKey: t, ID: env.I}, nil
}

// ReadParams extracts (limit, cursor) from a URL query and returns
// the decoded cursor. On invalid cursor it returns ErrInvalidCursor
// — the handler should respond 400 and stop. Limit is clamped to
// [1, MaxLimit] with DefaultLimit applied when missing/invalid.
//
// The function reads one extra row beyond limit to detect whether
// there's a next page. Callers should pass limit+1 to their SQL
// LIMIT clause; see HasMore() for the trim step.
func ReadParams(q url.Values) (limit int, cursor Cursor, err error) {
	return ReadParamsWithDefault(q, DefaultLimit, MaxLimit)
}

// ReadParamsWithDefault is ReadParams with a caller-supplied default and
// ceiling. It exists for endpoints adopting keyset pagination on top of a
// legacy hard cap: passing the legacy cap as defaultLimit preserves the
// pre-pagination page size when a client omits ?limit= (no row-count
// regression), while maxLimit can exceed the package MaxLimit for lists
// that historically returned 500/1000 rows in one shot. Both are clamped
// to sane lower bounds; defaultLimit is itself clamped to maxLimit.
func ReadParamsWithDefault(q url.Values, defaultLimit, maxLimit int) (limit int, cursor Cursor, err error) {
	if maxLimit < 1 {
		maxLimit = MaxLimit
	}
	if defaultLimit < 1 {
		defaultLimit = DefaultLimit
	}
	if defaultLimit > maxLimit {
		defaultLimit = maxLimit
	}
	limit = defaultLimit
	if raw := strings.TrimSpace(q.Get("limit")); raw != "" {
		if n, perr := strconv.Atoi(raw); perr == nil && n > 0 {
			limit = n
		}
	}
	if limit > maxLimit {
		limit = maxLimit
	}
	if limit < 1 {
		limit = defaultLimit
	}
	cursor, err = Decode(q.Get("cursor"))
	return limit, cursor, err
}

// HasMore inspects a row slice fetched with LIMIT=limit+1. When the
// fetch returned more than `limit` rows it means there's at least
// one more page; HasMore returns the trimmed slice (length=limit)
// plus true. Otherwise the input slice passes through with false.
//
// Generic so it works on any []T list-row type (campaigns, subscribers,
// templates, …).
func HasMore[T any](rows []T, limit int) ([]T, bool) {
	if limit < 1 {
		return rows, false
	}
	if len(rows) > limit {
		return rows[:limit], true
	}
	return rows, false
}

// Envelope is the JSON envelope every paginated list endpoint
// returns. nextCursor is omitted when the page is the last (no
// more rows). totalEstimate is optional — only callers that have a
// cheap count populate it; clients should not rely on it.
type Envelope[T any] struct {
	Items         []T    `json:"items"`
	NextCursor    string `json:"nextCursor,omitempty"`
	TotalEstimate *int   `json:"totalEstimate,omitempty"`
}
