// SPDX-License-Identifier: AGPL-3.0-only
package accounts

import (
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
)

// marshalMeta: nil → "{}", a real map → its JSON, deterministically
// round-trippable.
func TestMarshalMeta(t *testing.T) {
	got, err := marshalMeta(nil)
	if err != nil {
		t.Fatalf("nil meta err: %v", err)
	}
	if got != "{}" {
		t.Fatalf("nil meta = %q, want {}", got)
	}
	got, err = marshalMeta(map[string]any{"employees": float64(42)})
	if err != nil {
		t.Fatalf("meta err: %v", err)
	}
	if got != `{"employees":42}` {
		t.Fatalf("meta = %q", got)
	}
}

// isNotFound maps pgx.ErrNoRows to true; an unrelated error to false.
func TestIsNotFound(t *testing.T) {
	if !isNotFound(pgx.ErrNoRows) {
		t.Fatal("pgx.ErrNoRows should be not-found")
	}
	if isNotFound(errors.New("connection refused")) {
		t.Fatal("a generic error should NOT be not-found")
	}
}

// scanAccount decodes a row including the metadata jsonb blob.
type fakeRow struct {
	vals []any
	err  error
}

func (f fakeRow) Scan(dest ...any) error {
	if f.err != nil {
		return f.err
	}
	for i := range dest {
		switch d := dest[i].(type) {
		case *string:
			*d = f.vals[i].(string)
		case *[]byte:
			*d = f.vals[i].([]byte)
		default:
			// created_at / updated_at are time.Time; the fake leaves them
			// zero by not assigning, which is fine for these assertions.
		}
	}
	return nil
}

func TestScanAccount_DecodesMetadata(t *testing.T) {
	row := fakeRow{vals: []any{
		"id1", "t1", "Acme", "saas", "US",
		[]byte(`{"plan":"pro"}`),
		nil, nil, // created_at, updated_at (ignored by fake)
	}}
	a, err := scanAccount(row)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if a.Name != "Acme" || a.Industry != "saas" || a.Country != "US" {
		t.Fatalf("scalars wrong: %+v", a)
	}
	if a.Metadata["plan"] != "pro" {
		t.Fatalf("metadata = %v", a.Metadata)
	}
}

func TestScanAccount_NullMetadataYieldsEmptyMap(t *testing.T) {
	row := fakeRow{vals: []any{
		"id1", "t1", "Acme", "", "",
		[]byte(`null`),
		nil, nil,
	}}
	a, err := scanAccount(row)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if a.Metadata == nil || len(a.Metadata) != 0 {
		t.Fatalf("metadata should be empty non-nil map, got %v", a.Metadata)
	}
}
