// SPDX-License-Identifier: AGPL-3.0-only
package iceberg

import (
	"encoding/binary"
	"strings"
	"testing"
)

func le64Bytes(v int64) []byte {
	b := make([]byte, 8)
	binary.LittleEndian.PutUint64(b, uint64(v))
	return b
}

func TestEncodeManifestRoundTripsDataFile(t *testing.T) {
	df := DataFile{
		Content:         0,
		FilePath:        "s3://bucket/warehouse/events/data/00000-0-1.parquet",
		FileFormat:      "PARQUET",
		RecordCount:     2,
		FileSizeInBytes: 4096,
		ColumnSizes:     map[int]int64{1: 100, 2: 200},
		ValueCounts:     map[int]int64{1: 2, 2: 2},
		NullValueCounts: map[int]int64{1: 0, 2: 0},
		LowerBounds:     map[int][]byte{1: le64Bytes(1)},
		UpperBounds:     map[int][]byte{1: le64Bytes(2)},
		SplitOffsets:    []int64{4},
	}

	var sync [16]byte
	copy(sync[:], "0123456789abcdef")
	mf, err := EncodeManifest(df, sync)
	if err != nil {
		t.Fatalf("EncodeManifest: %v", err)
	}
	if mf.AddedFilesCount != 1 {
		t.Fatalf("AddedFilesCount = %d want 1", mf.AddedFilesCount)
	}
	if mf.AddedRowsCount != df.RecordCount {
		t.Fatalf("AddedRowsCount = %d want %d", mf.AddedRowsCount, df.RecordCount)
	}
	if mf.Length != int64(len(mf.Bytes)) {
		t.Fatalf("Length = %d want %d", mf.Length, len(mf.Bytes))
	}

	schema, objCount, records := ocfBlock(t, mf.Bytes)
	if !strings.Contains(schema, "manifest_entry") || !strings.Contains(schema, `"field-id":134`) || !strings.Contains(schema, `"field-id":103`) {
		t.Fatalf("schema missing expected markers: %s", schema)
	}
	if objCount != 1 {
		t.Fatalf("objCount = %d want 1", objCount)
	}

	ar := &avroReader{b: records, t: t}

	// manifest_entry
	status := ar.readInt()
	if status != manifestEntryStatusAdded {
		t.Fatalf("status = %d want %d (ADDED)", status, manifestEntryStatusAdded)
	}
	if idx := ar.readUnionIndex(); idx != 0 {
		t.Fatalf("snapshot_id branch = %d want 0 (inherited/null)", idx)
	}
	if idx := ar.readUnionIndex(); idx != 0 {
		t.Fatalf("sequence_number branch = %d want 0 (inherited/null)", idx)
	}
	if idx := ar.readUnionIndex(); idx != 0 {
		t.Fatalf("file_sequence_number branch = %d want 0 (inherited/null)", idx)
	}

	// data_file (r2)
	content := ar.readInt()
	if content != 0 {
		t.Fatalf("content = %d want 0", content)
	}
	filePath := ar.readString()
	if filePath != df.FilePath {
		t.Fatalf("file_path = %q want %q", filePath, df.FilePath)
	}
	fileFormat := ar.readString()
	if fileFormat != "PARQUET" {
		t.Fatalf("file_format = %q want PARQUET", fileFormat)
	}
	// partition (r102): zero fields — nothing to read.
	recordCount := ar.readLong()
	if recordCount != df.RecordCount {
		t.Fatalf("record_count = %d want %d", recordCount, df.RecordCount)
	}
	fileSize := ar.readLong()
	if fileSize != df.FileSizeInBytes {
		t.Fatalf("file_size_in_bytes = %d want %d", fileSize, df.FileSizeInBytes)
	}
	columnSizes := ar.readIntLongMap()
	if columnSizes[1] != 100 || columnSizes[2] != 200 {
		t.Fatalf("column_sizes = %v want {1:100,2:200}", columnSizes)
	}
	valueCounts := ar.readIntLongMap()
	if valueCounts[1] != 2 || valueCounts[2] != 2 {
		t.Fatalf("value_counts = %v", valueCounts)
	}
	nullValueCounts := ar.readIntLongMap()
	if nullValueCounts[1] != 0 || nullValueCounts[2] != 0 {
		t.Fatalf("null_value_counts = %v", nullValueCounts)
	}
	lowerBounds := ar.readIntBytesMap()
	if int64(binary.LittleEndian.Uint64(lowerBounds[1])) != 1 {
		t.Fatalf("lower_bounds[1] decoded = %d want 1", int64(binary.LittleEndian.Uint64(lowerBounds[1])))
	}
	upperBounds := ar.readIntBytesMap()
	if int64(binary.LittleEndian.Uint64(upperBounds[1])) != 2 {
		t.Fatalf("upper_bounds[1] decoded = %d want 2", int64(binary.LittleEndian.Uint64(upperBounds[1])))
	}
	splitOffsets := ar.readNullableLongArray()
	if len(splitOffsets) != 1 || splitOffsets[0] != 4 {
		t.Fatalf("split_offsets = %v want [4]", splitOffsets)
	}
}

func TestEncodeManifestEmptyStatsAreNullBranch(t *testing.T) {
	df := DataFile{
		FilePath:        "s3://bucket/t/data/f.parquet",
		FileFormat:      "PARQUET",
		RecordCount:     0,
		FileSizeInBytes: 8,
	}
	var sync [16]byte
	mf, err := EncodeManifest(df, sync)
	if err != nil {
		t.Fatalf("EncodeManifest: %v", err)
	}
	_, _, records := ocfBlock(t, mf.Bytes)
	ar := &avroReader{b: records, t: t}
	ar.readInt()        // status
	ar.readUnionIndex() // snapshot_id
	ar.readUnionIndex() // sequence_number
	ar.readUnionIndex() // file_sequence_number
	ar.readInt()        // content
	ar.readString()     // file_path
	ar.readString()     // file_format
	ar.readLong()       // record_count
	ar.readLong()       // file_size_in_bytes
	if m := ar.readIntLongMap(); m != nil {
		t.Fatalf("column_sizes = %v want nil (null branch)", m)
	}
	if m := ar.readIntLongMap(); m != nil {
		t.Fatalf("value_counts = %v want nil", m)
	}
	if m := ar.readIntLongMap(); m != nil {
		t.Fatalf("null_value_counts = %v want nil", m)
	}
	if m := ar.readIntBytesMap(); m != nil {
		t.Fatalf("lower_bounds = %v want nil", m)
	}
	if m := ar.readIntBytesMap(); m != nil {
		t.Fatalf("upper_bounds = %v want nil", m)
	}
	if a := ar.readNullableLongArray(); a != nil {
		t.Fatalf("split_offsets = %v want nil", a)
	}
}
