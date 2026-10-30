// SPDX-License-Identifier: AGPL-3.0-only
package iceberg

import (
	"bytes"
	"encoding/binary"
	"testing"

	"github.com/parquet-go/parquet-go"
)

// testRow is a standalone Parquet row type for these tests (deliberately
// not streaming_export.EventRow — this package doesn't depend on it).
// Field/tag order defines the Parquet column order, which WriteDataFile
// must line up positionally with the Iceberg Schema passed alongside it.
type testRow struct {
	EventID  int64  `parquet:"event_id"`
	TenantID string `parquet:"tenant_id"`
	AtUnixMs int64  `parquet:"at_unix_ms"`
}

func testSchema() Schema {
	s := Schema{Fields: []Field{
		{Name: "event_id", Type: TypeLong, Required: true},
		{Name: "tenant_id", Type: TypeString, Required: true},
		{Name: "at_unix_ms", Type: TypeLong, Required: true},
	}}
	s.AssignFieldIDs()
	return s
}

func encodeTestParquet(t *testing.T, rows []testRow) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := parquet.NewGenericWriter[testRow](&buf)
	if len(rows) > 0 {
		if _, err := w.Write(rows); err != nil {
			t.Fatalf("write rows: %v", err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close writer: %v", err)
	}
	return buf.Bytes()
}

func TestWriteDataFileRecordCountAndSize(t *testing.T) {
	rows := []testRow{
		{EventID: 10, TenantID: "t1", AtUnixMs: 1000},
		{EventID: 30, TenantID: "t2", AtUnixMs: 3000},
		{EventID: 20, TenantID: "t3", AtUnixMs: 2000},
	}
	body := encodeTestParquet(t, rows)
	schema := testSchema()

	df, err := WriteDataFile(schema, body, "s3://bucket/t/data/f.parquet")
	if err != nil {
		t.Fatalf("WriteDataFile: %v", err)
	}
	if df.RecordCount != int64(len(rows)) {
		t.Fatalf("RecordCount = %d want %d", df.RecordCount, len(rows))
	}
	if df.FileSizeInBytes != int64(len(body)) {
		t.Fatalf("FileSizeInBytes = %d want %d", df.FileSizeInBytes, len(body))
	}
	if df.FilePath != "s3://bucket/t/data/f.parquet" || df.FileFormat != "PARQUET" || df.Content != 0 {
		t.Fatalf("df = %+v", df)
	}
}

func TestWriteDataFileColumnBounds(t *testing.T) {
	rows := []testRow{
		{EventID: 10, TenantID: "bravo", AtUnixMs: 1000},
		{EventID: 30, TenantID: "alpha", AtUnixMs: 3000},
		{EventID: 20, TenantID: "charlie", AtUnixMs: 2000},
	}
	body := encodeTestParquet(t, rows)
	schema := testSchema()
	eventIDField, _ := schema.FieldByName("event_id")
	tenantField, _ := schema.FieldByName("tenant_id")
	atField, _ := schema.FieldByName("at_unix_ms")

	df, err := WriteDataFile(schema, body, "f.parquet")
	if err != nil {
		t.Fatalf("WriteDataFile: %v", err)
	}

	// event_id (long): PLAIN-encoded min/max are little-endian int64,
	// which is also exactly Iceberg's single-value serialization for
	// "long" — decode with the same rule a real Iceberg reader would.
	lo := int64(binary.LittleEndian.Uint64(df.LowerBounds[eventIDField.ID]))
	hi := int64(binary.LittleEndian.Uint64(df.UpperBounds[eventIDField.ID]))
	if lo != 10 {
		t.Fatalf("event_id lower bound = %d want 10", lo)
	}
	if hi != 30 {
		t.Fatalf("event_id upper bound = %d want 30", hi)
	}

	// tenant_id (string/byte-array): raw UTF-8 bytes, lexicographically
	// compared.
	if got := string(df.LowerBounds[tenantField.ID]); got != "alpha" {
		t.Fatalf("tenant_id lower bound = %q want alpha", got)
	}
	if got := string(df.UpperBounds[tenantField.ID]); got != "charlie" {
		t.Fatalf("tenant_id upper bound = %q want charlie", got)
	}

	atLo := int64(binary.LittleEndian.Uint64(df.LowerBounds[atField.ID]))
	atHi := int64(binary.LittleEndian.Uint64(df.UpperBounds[atField.ID]))
	if atLo != 1000 || atHi != 3000 {
		t.Fatalf("at_unix_ms bounds = [%d,%d] want [1000,3000]", atLo, atHi)
	}

	// Every column should have a non-zero compressed size and a value
	// count matching the row count — both read straight from the real
	// Parquet footer, not recomputed.
	for _, f := range schema.Fields {
		if df.ValueCounts[f.ID] != int64(len(rows)) {
			t.Fatalf("field %s value_count = %d want %d", f.Name, df.ValueCounts[f.ID], len(rows))
		}
		if df.NullValueCounts[f.ID] != 0 {
			t.Fatalf("field %s null_value_count = %d want 0", f.Name, df.NullValueCounts[f.ID])
		}
		if df.ColumnSizes[f.ID] <= 0 {
			t.Fatalf("field %s column_size = %d want > 0", f.Name, df.ColumnSizes[f.ID])
		}
	}
}

func TestWriteDataFileColumnCountMismatch(t *testing.T) {
	rows := []testRow{{EventID: 1, TenantID: "t", AtUnixMs: 1}}
	body := encodeTestParquet(t, rows)
	badSchema := Schema{Fields: []Field{{Name: "only_one", Type: TypeLong, Required: true}}}
	badSchema.AssignFieldIDs()

	if _, err := WriteDataFile(badSchema, body, "f.parquet"); err == nil {
		t.Fatal("expected error for schema/column count mismatch")
	}
}

func TestWriteDataFileRejectsEmptyBytes(t *testing.T) {
	if _, err := WriteDataFile(testSchema(), nil, "f.parquet"); err == nil {
		t.Fatal("expected error for empty parquet bytes")
	}
}
