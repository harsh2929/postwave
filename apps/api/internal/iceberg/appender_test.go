// SPDX-License-Identifier: AGPL-3.0-only
package iceberg

import "testing"

func TestTableAppender_AccumulatesSnapshots(t *testing.T) {
	app, err := NewTableAppender("uuid-1", "s3://bucket/warehouse/orders/", testSchema())
	if err != nil {
		t.Fatalf("NewTableAppender: %v", err)
	}
	sync := [16]byte{7}

	// --- Append 1: first snapshot, no parent. ---
	pq1 := encodeTestParquet(t, []testRow{{EventID: 1, TenantID: "a", AtUnixMs: 100}})
	tf1, err := app.Append(pq1, AppendOptions{SnapshotID: 101, TimestampMs: 1700, ManifestSync: &sync, ManifestListSync: &sync})
	if err != nil {
		t.Fatalf("append 1: %v", err)
	}
	if len(tf1.TableMetadata.Snapshots) != 1 {
		t.Fatalf("after append 1: %d snapshots, want 1", len(tf1.TableMetadata.Snapshots))
	}
	if tf1.TableMetadata.Snapshots[0].ParentSnapshotID != nil {
		t.Error("first snapshot must have no parent")
	}
	if tf1.TableMetadata.CurrentSnapshotID != 101 {
		t.Errorf("current-snapshot-id = %d, want 101", tf1.TableMetadata.CurrentSnapshotID)
	}

	// --- Append 2: second snapshot, parented to the first. ---
	pq2 := encodeTestParquet(t, []testRow{{EventID: 2, TenantID: "b", AtUnixMs: 200}, {EventID: 3, TenantID: "c", AtUnixMs: 300}})
	tf2, err := app.Append(pq2, AppendOptions{SnapshotID: 102, TimestampMs: 1800, ManifestSync: &sync, ManifestListSync: &sync})
	if err != nil {
		t.Fatalf("append 2: %v", err)
	}
	meta := tf2.TableMetadata
	if len(meta.Snapshots) != 2 {
		t.Fatalf("after append 2: %d snapshots, want 2", len(meta.Snapshots))
	}
	if meta.CurrentSnapshotID != 102 || meta.Refs["main"].SnapshotID != 102 {
		t.Errorf("current/main should point at 102, got current=%d main=%d", meta.CurrentSnapshotID, meta.Refs["main"].SnapshotID)
	}
	s2 := meta.Snapshots[1]
	if s2.ParentSnapshotID == nil || *s2.ParentSnapshotID != 101 {
		t.Errorf("second snapshot parent = %v, want 101", s2.ParentSnapshotID)
	}
	if s2.SequenceNumber != 2 || meta.LastSequenceNumber != 2 {
		t.Errorf("sequence numbers should be 2, got snap=%d last=%d", s2.SequenceNumber, meta.LastSequenceNumber)
	}
	if s2.Summary["total-records"] != "3" || s2.Summary["total-data-files"] != "2" {
		t.Errorf("snapshot 2 summary totals wrong: %v", s2.Summary)
	}
	if app.SnapshotCount() != 2 {
		t.Errorf("SnapshotCount = %d, want 2", app.SnapshotCount())
	}

	// --- The second snapshot's manifest list references BOTH data manifests. ---
	_, count, records := ocfBlock(t, tf2.ManifestList.Bytes)
	if count != 2 {
		t.Fatalf("second manifest list has %d entries, want 2 (both manifests live)", count)
	}
	r := &avroReader{b: records, t: t}
	var paths []string
	for i := int64(0); i < count; i++ {
		paths = append(paths, readManifestPath(r))
	}
	if paths[0] != tf1.Manifest.Path || paths[1] != tf2.Manifest.Path {
		t.Errorf("manifest list should reference both manifests in order, got %v", paths)
	}

	// The two snapshots must reference distinct manifest-list files.
	if meta.Snapshots[0].ManifestList == meta.Snapshots[1].ManifestList {
		t.Error("each snapshot must have its own manifest-list file")
	}
}

func TestTableAppender_Guards(t *testing.T) {
	if _, err := NewTableAppender("", "s3://b", testSchema()); err == nil {
		t.Error("missing UUID should error")
	}
	if _, err := NewTableAppender("u", "", testSchema()); err == nil {
		t.Error("missing location should error")
	}
	app, _ := NewTableAppender("u", "s3://b/w", testSchema())
	pq := encodeTestParquet(t, []testRow{{EventID: 1, TenantID: "x", AtUnixMs: 1}})
	if _, err := app.Append(pq, AppendOptions{SnapshotID: 0}); err == nil {
		t.Error("append with SnapshotID 0 should error")
	}
	// A failed append must not have mutated state.
	if app.SnapshotCount() != 0 {
		t.Errorf("failed append mutated state: SnapshotCount = %d", app.SnapshotCount())
	}
}

// readManifestPath reads one manifest_file record in manifest_list.go's field
// order and returns its manifest_path (advancing the reader past the entry).
func readManifestPath(r *avroReader) string {
	p := r.readString()
	r.readLong() // manifest_length
	r.readInt()  // partition_spec_id
	r.readInt()  // content
	r.readLong() // sequence_number
	r.readLong() // min_sequence_number
	r.readLong() // added_snapshot_id
	r.readInt()  // added_files_count
	r.readInt()  // existing_files_count
	r.readInt()  // deleted_files_count
	r.readLong() // added_rows_count
	r.readLong() // existing_rows_count
	r.readLong() // deleted_rows_count
	r.readLong() // partitions: null union
	r.readLong() // key_metadata: null union
	return p
}
