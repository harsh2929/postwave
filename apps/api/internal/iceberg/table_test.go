// SPDX-License-Identifier: AGPL-3.0-only
package iceberg

import (
	"encoding/binary"
	"encoding/json"
	"strings"
	"testing"
)

func writeTableOpts() WriteTableOptions {
	manifestSync := [16]byte{}
	copy(manifestSync[:], "manifest-sync-01")
	manifestListSync := [16]byte{}
	copy(manifestListSync[:], "manifest-list-02")
	return WriteTableOptions{
		TableUUID:        "b55d9dda-6561-423a-8bfc-787980ce421f",
		Location:         "s3://bucket/warehouse/events/",
		LastUpdatedMs:    1752000000000,
		SnapshotID:       9001,
		ManifestSync:     &manifestSync,
		ManifestListSync: &manifestListSync,
	}
}

func TestWriteTableProducesFourFilesAndValidMetadata(t *testing.T) {
	rows := []testRow{
		{EventID: 1, TenantID: "t1", AtUnixMs: 1700000000000},
		{EventID: 2, TenantID: "t1", AtUnixMs: 1700000005000},
	}
	body := encodeTestParquet(t, rows)
	schema := testSchema()

	tf, err := WriteTable(schema, body, writeTableOpts())
	if err != nil {
		t.Fatalf("WriteTable: %v", err)
	}

	// Location has its trailing slash trimmed and every path nests
	// under data/ or metadata/.
	if !strings.HasPrefix(tf.Data.Path, "s3://bucket/warehouse/events/data/") {
		t.Fatalf("Data.Path = %q", tf.Data.Path)
	}
	if !strings.HasPrefix(tf.Manifest.Path, "s3://bucket/warehouse/events/metadata/") {
		t.Fatalf("Manifest.Path = %q", tf.Manifest.Path)
	}
	if !strings.HasPrefix(tf.ManifestList.Path, "s3://bucket/warehouse/events/metadata/") {
		t.Fatalf("ManifestList.Path = %q", tf.ManifestList.Path)
	}
	if !strings.HasPrefix(tf.Metadata.Path, "s3://bucket/warehouse/events/metadata/") {
		t.Fatalf("Metadata.Path = %q", tf.Metadata.Path)
	}
	if len(tf.Data.Bytes) == 0 || len(tf.Manifest.Bytes) == 0 || len(tf.ManifestList.Bytes) == 0 || len(tf.Metadata.Bytes) == 0 {
		t.Fatal("every file must have non-empty bytes")
	}

	// DataFileStats reflects the real Parquet footer.
	if tf.DataFileStats.RecordCount != int64(len(rows)) {
		t.Fatalf("DataFileStats.RecordCount = %d want %d", tf.DataFileStats.RecordCount, len(rows))
	}

	// Schema field ids were assigned (not left 0).
	for _, f := range schema.Fields {
		if f.ID == 0 {
			t.Fatalf("field %s has unassigned id", f.Name)
		}
	}

	// --- table-metadata JSON ---
	var meta map[string]any
	if err := json.Unmarshal(tf.Metadata.Bytes, &meta); err != nil {
		t.Fatalf("unmarshal table metadata: %v", err)
	}
	if fv, _ := meta["format-version"].(float64); fv != 2 {
		t.Fatalf("format-version = %v want 2", meta["format-version"])
	}
	curSnap, _ := meta["current-snapshot-id"].(float64)
	if int64(curSnap) != 9001 {
		t.Fatalf("current-snapshot-id = %v want 9001", meta["current-snapshot-id"])
	}
	snapshots, _ := meta["snapshots"].([]any)
	if len(snapshots) != 1 {
		t.Fatalf("snapshots = %v", meta["snapshots"])
	}
	snap0 := snapshots[0].(map[string]any)
	if snap0["manifest-list"] != tf.ManifestList.Path {
		t.Fatalf("snapshot manifest-list = %v want %v", snap0["manifest-list"], tf.ManifestList.Path)
	}
	refs, _ := meta["refs"].(map[string]any)
	main, _ := refs["main"].(map[string]any)
	mainSnap, _ := main["snapshot-id"].(float64)
	if int64(mainSnap) != 9001 {
		t.Fatalf("refs.main.snapshot-id = %v want 9001", main["snapshot-id"])
	}

	// --- manifest Avro decodes back to the DataFile ---
	_, objCount, records := ocfBlock(t, tf.Manifest.Bytes)
	if objCount != 1 {
		t.Fatalf("manifest objCount = %d want 1", objCount)
	}
	ar := &avroReader{b: records, t: t}
	ar.readInt()        // status
	ar.readUnionIndex() // snapshot_id
	ar.readUnionIndex() // sequence_number
	ar.readUnionIndex() // file_sequence_number
	ar.readInt()        // content
	filePath := ar.readString()
	if filePath != tf.Data.Path {
		t.Fatalf("manifest data_file.file_path = %q want %q", filePath, tf.Data.Path)
	}
	ar.readString() // file_format
	recordCount := ar.readLong()
	if recordCount != int64(len(rows)) {
		t.Fatalf("manifest data_file.record_count = %d want %d", recordCount, len(rows))
	}
	fileSize := ar.readLong()
	if fileSize != int64(len(tf.Data.Bytes)) {
		t.Fatalf("manifest data_file.file_size_in_bytes = %d want %d", fileSize, len(tf.Data.Bytes))
	}

	// --- manifest-list Avro references the manifest ---
	_, mlObjCount, mlRecords := ocfBlock(t, tf.ManifestList.Bytes)
	if mlObjCount != 1 {
		t.Fatalf("manifest-list objCount = %d want 1", mlObjCount)
	}
	mlar := &avroReader{b: mlRecords, t: t}
	manifestPath := mlar.readString()
	if manifestPath != tf.Manifest.Path {
		t.Fatalf("manifest-list manifest_path = %q want %q", manifestPath, tf.Manifest.Path)
	}
	manifestLength := mlar.readLong()
	if manifestLength != int64(len(tf.Manifest.Bytes)) {
		t.Fatalf("manifest-list manifest_length = %d want %d", manifestLength, len(tf.Manifest.Bytes))
	}
}

func TestWriteTableRequiresLocationAndUUID(t *testing.T) {
	schema := testSchema()
	body := encodeTestParquet(t, []testRow{{EventID: 1, TenantID: "t", AtUnixMs: 1}})

	opts := writeTableOpts()
	opts.TableUUID = ""
	if _, err := WriteTable(schema, body, opts); err == nil {
		t.Fatal("expected error for missing TableUUID")
	}

	opts2 := writeTableOpts()
	opts2.Location = ""
	if _, err := WriteTable(schema, body, opts2); err == nil {
		t.Fatal("expected error for missing Location")
	}
}

func TestWriteTableWithEncoder(t *testing.T) {
	schema := testSchema()
	rows := []testRow{{EventID: 5, TenantID: "t9", AtUnixMs: 42}}
	called := false
	encode := func() ([]byte, error) {
		called = true
		return encodeTestParquet(t, rows), nil
	}
	tf, err := WriteTableWithEncoder(schema, encode, writeTableOpts())
	if err != nil {
		t.Fatalf("WriteTableWithEncoder: %v", err)
	}
	if !called {
		t.Fatal("encoder was not invoked")
	}
	if tf.DataFileStats.RecordCount != 1 {
		t.Fatalf("RecordCount = %d want 1", tf.DataFileStats.RecordCount)
	}
}

func TestWriteTableDeterministicWithPinnedSync(t *testing.T) {
	schema := testSchema()
	body := encodeTestParquet(t, []testRow{{EventID: 1, TenantID: "t", AtUnixMs: 1}})

	tf1, err := WriteTable(schema, body, writeTableOpts())
	if err != nil {
		t.Fatalf("WriteTable #1: %v", err)
	}
	// Re-assign ids on a fresh schema copy — WriteTable mutates its
	// input's backing array, so build it again for the second call.
	schema2 := testSchema()
	tf2, err := WriteTable(schema2, body, writeTableOpts())
	if err != nil {
		t.Fatalf("WriteTable #2: %v", err)
	}
	if string(tf1.Manifest.Bytes) != string(tf2.Manifest.Bytes) {
		t.Fatal("manifest bytes should be identical given pinned sync + identical inputs")
	}
	if string(tf1.ManifestList.Bytes) != string(tf2.ManifestList.Bytes) {
		t.Fatal("manifest-list bytes should be identical given pinned sync + identical inputs")
	}
}

// le64 mirrors the helper in datafile_test.go for a quick sanity check
// that WriteTable's DataFileStats bounds are usable by a caller the way
// datafile_test.go documents.
func TestWriteTableDataFileStatsBoundsUsable(t *testing.T) {
	schema := testSchema()
	rows := []testRow{
		{EventID: 100, TenantID: "z", AtUnixMs: 1},
		{EventID: 1, TenantID: "a", AtUnixMs: 2},
	}
	body := encodeTestParquet(t, rows)
	tf, err := WriteTable(schema, body, writeTableOpts())
	if err != nil {
		t.Fatalf("WriteTable: %v", err)
	}
	f, _ := schema.FieldByName("event_id")
	lo := int64(binary.LittleEndian.Uint64(tf.DataFileStats.LowerBounds[f.ID]))
	hi := int64(binary.LittleEndian.Uint64(tf.DataFileStats.UpperBounds[f.ID]))
	if lo != 1 || hi != 100 {
		t.Fatalf("event_id bounds = [%d,%d] want [1,100]", lo, hi)
	}
}
