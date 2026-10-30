package pagination

import (
	"net/url"
	"strconv"
	"testing"
	"time"
)

// TestEncodeDecodeRoundtrip verifies a cursor survives a full
// serialize→parse cycle byte-for-byte.
func TestEncodeDecodeRoundtrip(t *testing.T) {
	now := time.Date(2026, 6, 8, 12, 34, 56, 789000000, time.UTC)
	c := Cursor{SortKey: now, ID: "abc-123"}
	got, err := Decode(Encode(c))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !got.SortKey.Equal(c.SortKey) {
		t.Errorf("SortKey: got %v want %v", got.SortKey, c.SortKey)
	}
	if got.ID != c.ID {
		t.Errorf("ID: got %q want %q", got.ID, c.ID)
	}
}

func TestEncodeEmptyCursorEmptyString(t *testing.T) {
	if got := Encode(Cursor{}); got != "" {
		t.Errorf("Encode(zero) = %q, want empty", got)
	}
}

func TestDecodeEmptyString(t *testing.T) {
	c, err := Decode("")
	if err != nil {
		t.Fatalf("Decode(empty): %v", err)
	}
	if c.ID != "" {
		t.Errorf("Decode(empty).ID = %q, want empty", c.ID)
	}
}

func TestDecodeInvalidInputs(t *testing.T) {
	for _, s := range []string{
		"not base64!",
		"YWFh",     // valid base64 of "aaa" but not JSON
		"e30",      // base64 of "{}" → empty envelope
		"e30=",     // padded form of same
		"!@#$%^&*", // garbage
	} {
		_, err := Decode(s)
		if err == nil {
			t.Errorf("Decode(%q) succeeded, want error", s)
		}
	}
}

func TestReadParamsDefaults(t *testing.T) {
	limit, c, err := ReadParams(url.Values{})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if limit != DefaultLimit {
		t.Errorf("limit: got %d want %d", limit, DefaultLimit)
	}
	if c.ID != "" {
		t.Errorf("cursor should be zero, got %+v", c)
	}
}

func TestReadParamsClampsLimit(t *testing.T) {
	q := url.Values{}
	q.Set("limit", "9999")
	limit, _, err := ReadParams(q)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if limit != MaxLimit {
		t.Errorf("limit: got %d want %d", limit, MaxLimit)
	}
}

func TestReadParamsRejectsBadCursor(t *testing.T) {
	q := url.Values{}
	q.Set("cursor", "not-a-real-cursor!!!")
	_, _, err := ReadParams(q)
	if err == nil {
		t.Fatal("expected ErrInvalidCursor")
	}
}

func TestHasMore(t *testing.T) {
	rows := []int{1, 2, 3, 4, 5}
	got, more := HasMore(rows, 4)
	if !more {
		t.Error("expected more=true when len>limit")
	}
	if len(got) != 4 {
		t.Errorf("len: got %d want 4", len(got))
	}

	got2, more2 := HasMore(rows, 5)
	if more2 {
		t.Error("expected more=false when len==limit")
	}
	if len(got2) != 5 {
		t.Errorf("len: got %d want 5", len(got2))
	}
}

// TestCursorStableAcrossInserts simulates the canonical "user
// scrolls page 1, new rows arrive, user scrolls to page 2" scenario.
//
// The cursor pins to (created_at, id) so inserting newer rows after
// page 1 must not cause page 2 to skip or duplicate any row from
// page 1.
func TestCursorStableAcrossInserts(t *testing.T) {
	// Build a list of synthetic rows newest-first.
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	mkRow := func(i int) row { return row{ID: strconv.Itoa(i), CreatedAt: base.Add(time.Duration(i) * time.Second)} }
	all := []row{}
	for i := 100; i >= 1; i-- {
		all = append(all, mkRow(i))
	}

	// First "fetch": newest 10 rows.
	limit := 10
	page1 := all[:limit]
	last := page1[len(page1)-1]
	cur := Cursor{SortKey: last.CreatedAt, ID: last.ID}
	enc := Encode(cur)

	// Server simulates inserting two MORE rows newer than anything
	// in page1. Because the cursor is keyset, these MUST NOT appear
	// on page2 (the user already past them).
	newest := []row{mkRow(102), mkRow(101)}
	all = append(newest, all...)

	// Decode cursor and apply the keyset predicate (everything OLDER
	// than the cursor by (created_at, id) DESC).
	got, err := Decode(enc)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	page2 := []row{}
	for _, r := range all {
		if r.CreatedAt.Before(got.SortKey) ||
			(r.CreatedAt.Equal(got.SortKey) && r.ID < got.ID) {
			page2 = append(page2, r)
			if len(page2) == limit {
				break
			}
		}
	}

	// Build the set of IDs from page1; page2 must be disjoint.
	seen := map[string]bool{}
	for _, r := range page1 {
		seen[r.ID] = true
	}
	for _, r := range page2 {
		if seen[r.ID] {
			t.Errorf("page2 duplicates page1 row id=%s", r.ID)
		}
	}

	// And page2's first row should be ID 90 (rows 91..100 were page1).
	if len(page2) == 0 || page2[0].ID != "90" {
		t.Errorf("page2[0]: got %+v want id=90", page2[0])
	}
}

type row struct {
	ID        string
	CreatedAt time.Time
}
