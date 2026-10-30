// SPDX-License-Identifier: AGPL-3.0-only
package iceberg

import (
	"strings"
	"testing"
)

func TestEncodeManifestListRoundTrips(t *testing.T) {
	entries := []ManifestListEntry{{
		ManifestPath:      "s3://bucket/t/metadata/snap-1-1-manifest.avro",
		ManifestLength:    1234,
		PartitionSpecID:   0,
		SequenceNumber:    1,
		MinSequenceNumber: 1,
		AddedSnapshotID:   9001,
		AddedFilesCount:   1,
		AddedRowsCount:    2,
	}}
	var sync [16]byte
	copy(sync[:], "manifestlistsync")
	body, err := EncodeManifestList(entries, sync)
	if err != nil {
		t.Fatalf("EncodeManifestList: %v", err)
	}

	schema, objCount, records := ocfBlock(t, body)
	if !strings.Contains(schema, "manifest_file") || !strings.Contains(schema, `"field-id":500`) || !strings.Contains(schema, `"field-id":503`) {
		t.Fatalf("schema missing expected markers: %s", schema)
	}
	if objCount != 1 {
		t.Fatalf("objCount = %d want 1", objCount)
	}

	ar := &avroReader{b: records, t: t}
	path := ar.readString()
	if path != entries[0].ManifestPath {
		t.Fatalf("manifest_path = %q want %q", path, entries[0].ManifestPath)
	}
	length := ar.readLong()
	if length != 1234 {
		t.Fatalf("manifest_length = %d want 1234", length)
	}
	specID := ar.readInt()
	if specID != 0 {
		t.Fatalf("partition_spec_id = %d want 0", specID)
	}
	content := ar.readInt()
	if content != 0 {
		t.Fatalf("content = %d want 0", content)
	}
	seqNum := ar.readLong()
	if seqNum != 1 {
		t.Fatalf("sequence_number = %d want 1", seqNum)
	}
	minSeqNum := ar.readLong()
	if minSeqNum != 1 {
		t.Fatalf("min_sequence_number = %d want 1", minSeqNum)
	}
	addedSnapshotID := ar.readLong()
	if addedSnapshotID != 9001 {
		t.Fatalf("added_snapshot_id = %d want 9001", addedSnapshotID)
	}
	addedFiles := ar.readInt()
	if addedFiles != 1 {
		t.Fatalf("added_files_count = %d want 1", addedFiles)
	}
	existingFiles := ar.readInt()
	if existingFiles != 0 {
		t.Fatalf("existing_files_count = %d want 0", existingFiles)
	}
	deletedFiles := ar.readInt()
	if deletedFiles != 0 {
		t.Fatalf("deleted_files_count = %d want 0", deletedFiles)
	}
	addedRows := ar.readLong()
	if addedRows != 2 {
		t.Fatalf("added_rows_count = %d want 2", addedRows)
	}
	existingRows := ar.readLong()
	if existingRows != 0 {
		t.Fatalf("existing_rows_count = %d want 0", existingRows)
	}
	deletedRows := ar.readLong()
	if deletedRows != 0 {
		t.Fatalf("deleted_rows_count = %d want 0", deletedRows)
	}
	if idx := ar.readUnionIndex(); idx != 0 {
		t.Fatalf("partitions branch = %d want 0 (null)", idx)
	}
	if idx := ar.readUnionIndex(); idx != 0 {
		t.Fatalf("key_metadata branch = %d want 0 (null)", idx)
	}
}

func TestEncodeManifestListMultipleEntries(t *testing.T) {
	entries := []ManifestListEntry{
		{ManifestPath: "m1", ManifestLength: 1, AddedSnapshotID: 1, AddedFilesCount: 1, AddedRowsCount: 5},
		{ManifestPath: "m2", ManifestLength: 2, AddedSnapshotID: 2, AddedFilesCount: 1, AddedRowsCount: 7},
	}
	var sync [16]byte
	body, err := EncodeManifestList(entries, sync)
	if err != nil {
		t.Fatalf("EncodeManifestList: %v", err)
	}
	_, objCount, records := ocfBlock(t, body)
	if objCount != 2 {
		t.Fatalf("objCount = %d want 2", objCount)
	}
	ar := &avroReader{b: records, t: t}
	for _, want := range entries {
		path := ar.readString()
		if path != want.ManifestPath {
			t.Fatalf("manifest_path = %q want %q", path, want.ManifestPath)
		}
		ar.readLong() // manifest_length
		ar.readInt()  // partition_spec_id
		ar.readInt()  // content
		ar.readLong() // sequence_number
		ar.readLong() // min_sequence_number
		snapID := ar.readLong()
		if snapID != want.AddedSnapshotID {
			t.Fatalf("added_snapshot_id = %d want %d", snapID, want.AddedSnapshotID)
		}
		ar.readInt() // added_files_count
		ar.readInt() // existing_files_count
		ar.readInt() // deleted_files_count
		rows := ar.readLong()
		if rows != want.AddedRowsCount {
			t.Fatalf("added_rows_count = %d want %d", rows, want.AddedRowsCount)
		}
		ar.readLong()       // existing_rows_count
		ar.readLong()       // deleted_rows_count
		ar.readUnionIndex() // partitions
		ar.readUnionIndex() // key_metadata
	}
}
