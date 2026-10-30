// SPDX-License-Identifier: AGPL-3.0-only
package cdclake

import (
	"bytes"
	"testing"

	"github.com/parquet-go/parquet-go"

	"github.com/postwave/postwave/apps/api/internal/iceberg"
	"github.com/postwave/postwave/apps/api/internal/pgcdc"
)

// ordersRel is a fixed relation whose columns exercise long/string/int/bool.
// Alphabetical column order (parquet-go's canonical Group order) is:
// email, id, paid, total_cents.
func ordersRel() pgcdc.RelationMessage {
	return pgcdc.RelationMessage{
		RelationName: "orders",
		Columns: []pgcdc.RelationColumn{
			{Key: true, Name: "id", TypeOID: oidInt8},
			{Name: "email", TypeOID: oidText},
			{Name: "total_cents", TypeOID: oidInt4},
			{Name: "paid", TypeOID: oidBool},
		},
	}
}

func col(name, val string) pgcdc.NamedColumn {
	v := val
	return pgcdc.NamedColumn{Name: name, Value: &v}
}
func nullCol(name string) pgcdc.NamedColumn { return pgcdc.NamedColumn{Name: name, Null: true} }

// readRow reads the encoded Parquet back. Optional columns map to pointer
// fields (nil == the value was NULL); matching is by the parquet tag name, so
// field order here is independent of the file's column order.
type readRow struct {
	ID         *int64  `parquet:"id"`
	Email      *string `parquet:"email"`
	TotalCents *int32  `parquet:"total_cents"`
	Paid       *bool   `parquet:"paid"`
}

func TestEncodeParquet_ValuesAndNulls(t *testing.T) {
	rows := [][]pgcdc.NamedColumn{
		{col("id", "100"), col("email", "a@b.com"), col("total_cents", "4200"), col("paid", "t")},
		{col("id", "101"), nullCol("email"), col("total_cents", "0"), col("paid", "f")},
	}
	parquetBytes, schema, err := EncodeParquet(ordersRel(), rows)
	if err != nil {
		t.Fatalf("EncodeParquet: %v", err)
	}

	// --- Iceberg schema: built in parquet's canonical (name-sorted) order,
	//     with the key column Required. ---
	wantOrder := []string{"email", "id", "paid", "total_cents"}
	if len(schema.Fields) != 4 {
		t.Fatalf("schema has %d fields, want 4", len(schema.Fields))
	}
	for i, name := range wantOrder {
		if schema.Fields[i].Name != name {
			t.Fatalf("field %d = %q, want %q (must match parquet column order)", i, schema.Fields[i].Name, name)
		}
	}
	for _, f := range schema.Fields {
		if f.Name == "id" && !f.Required {
			t.Error("key column id should be Required")
		}
	}

	// --- The Parquet must be readable and carry the exact values, with the
	//     null landing on email of row 2 (proves column alignment + nulls). ---
	r := parquet.NewGenericReader[readRow](bytes.NewReader(parquetBytes))
	defer func() { _ = r.Close() }()
	out := make([]readRow, 2)
	n, err := r.Read(out)
	if err != nil && n == 0 {
		t.Fatalf("read parquet: %v", err)
	}
	if n != 2 {
		t.Fatalf("read %d rows, want 2", n)
	}
	if out[0].ID == nil || *out[0].ID != 100 || out[0].Email == nil || *out[0].Email != "a@b.com" ||
		out[0].TotalCents == nil || *out[0].TotalCents != 4200 || out[0].Paid == nil || *out[0].Paid != true {
		t.Errorf("row0 = %+v, want id=100 email=a@b.com total_cents=4200 paid=true", out[0])
	}
	if out[1].Email != nil {
		t.Errorf("row1 email should be NULL, got %v", *out[1].Email)
	}
	if out[1].ID == nil || *out[1].ID != 101 || out[1].Paid == nil || *out[1].Paid != false {
		t.Errorf("row1 = %+v, want id=101 paid=false email=nil", out[1])
	}

	// --- iceberg.WriteDataFile accepts the file: column count matches the
	//     schema (misalignment would error) and record_count is right. ---
	df, err := iceberg.WriteDataFile(schema, parquetBytes, "s3://b/data/x.parquet")
	if err != nil {
		t.Fatalf("iceberg.WriteDataFile on the encoded parquet: %v", err)
	}
	if df.RecordCount != 2 {
		t.Errorf("iceberg record_count = %d, want 2", df.RecordCount)
	}
}

func TestWriteChanges_ProducesValidIcebergTable(t *testing.T) {
	rows := [][]pgcdc.NamedColumn{
		{col("id", "7"), col("email", "x@y.com"), col("total_cents", "999"), col("paid", "t")},
	}
	sync := [16]byte{1}
	tf, err := WriteChanges(ordersRel(), rows, iceberg.WriteTableOptions{
		TableUUID: "u", Location: "s3://b/w", LastUpdatedMs: 1700, SnapshotID: 5,
		SequenceNumber: 1, ManifestSync: &sync, ManifestListSync: &sync,
	})
	if err != nil {
		t.Fatalf("WriteChanges: %v", err)
	}
	if tf.DataFileStats.RecordCount != 1 {
		t.Errorf("record_count = %d, want 1", tf.DataFileStats.RecordCount)
	}
	if tf.TableMetadata.FormatVersion != 2 || len(tf.TableMetadata.Snapshots) != 1 {
		t.Errorf("expected a v2 single-snapshot table, got fmt=%d snaps=%d",
			tf.TableMetadata.FormatVersion, len(tf.TableMetadata.Snapshots))
	}
	if len(tf.Data.Bytes) == 0 || len(tf.Manifest.Bytes) == 0 || len(tf.ManifestList.Bytes) == 0 || len(tf.Metadata.Bytes) == 0 {
		t.Error("WriteChanges should produce all four non-empty table files")
	}
}

func TestEncodeParquet_UnsupportedOIDErrors(t *testing.T) {
	rel := pgcdc.RelationMessage{
		RelationName: "t",
		Columns:      []pgcdc.RelationColumn{{Name: "tags", TypeOID: 1000}}, // _bool[] array
	}
	if _, _, err := EncodeParquet(rel, nil); err == nil {
		t.Fatal("unsupported OID should error")
	}
}
