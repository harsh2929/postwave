package subscribers

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
)

// listCursor is the keyset position for the List endpoint's DEFAULT sort
// (updated_at DESC, id DESC tiebreak). It is the opaque payload returned
// as Page.NextCursor and consumed via ?cursor=. The id tiebreak makes the
// position total: when two rows share updated_at (common after a bulk
// import) the (updated_at, id) tuple still orders them deterministically.
//
// Only the default sort is keyset-paginated. Any other ?sort= falls back
// to OFFSET (documented on Repo.List) — so this cursor never needs to
// encode the sort column; it always means "(updated_at, id) < this".
type listCursor struct {
	UpdatedAt time.Time `json:"u"`
	ID        string    `json:"i"`
}

// cursorEnvelope is the wire shape. updated_at is RFC3339Nano so the
// sub-second precision survives the round-trip (Postgres timestamptz is
// microsecond-resolution; truncating to seconds would let a later row on
// the same second leak back onto the next page).
type listCursorEnvelope struct {
	U string `json:"u"`
	I string `json:"i"`
}

// errInvalidCursor is returned by decodeListCursor on malformed input.
// The handler maps it to 400 invalid_cursor.
var errInvalidCursor = errors.New("invalid cursor")

// encodeListCursor serializes a keyset position to a base64url (no
// padding) string. A zero ID yields the empty string, which callers use
// to signal "no more pages" (Page.NextCursor stays omitempty).
func encodeListCursor(c listCursor) string {
	if c.ID == "" {
		return ""
	}
	env := listCursorEnvelope{
		U: c.UpdatedAt.UTC().Format(time.RFC3339Nano),
		I: c.ID,
	}
	raw, _ := json.Marshal(env)
	return base64.RawURLEncoding.EncodeToString(raw)
}

// decodeListCursor parses a cursor string. Empty input returns the zero
// cursor and no error, so the handler can decode unconditionally and
// branch on whether the ID came back set. Bad base64/JSON/timestamp or a
// missing field returns errInvalidCursor.
func decodeListCursor(s string) (listCursor, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return listCursor{}, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		// Accept standard-padding base64 too, so a client that used the
		// non-URL-safe alphabet still round-trips.
		raw, err = base64.StdEncoding.DecodeString(s)
		if err != nil {
			return listCursor{}, errInvalidCursor
		}
	}
	var env listCursorEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return listCursor{}, errInvalidCursor
	}
	if env.I == "" || env.U == "" {
		return listCursor{}, errInvalidCursor
	}
	// The id is bound into the keyset query as ::uuid; a non-UUID would
	// pass JSON decode but make Postgres raise 22P02 at execution (an
	// internal 500). Validate here so a crafted cursor maps to the
	// documented 400 invalid_cursor instead, and never reaches the query.
	if _, err := uuid.Parse(env.I); err != nil {
		return listCursor{}, errInvalidCursor
	}
	t, err := time.Parse(time.RFC3339Nano, env.U)
	if err != nil {
		return listCursor{}, errInvalidCursor
	}
	return listCursor{UpdatedAt: t, ID: env.I}, nil
}
