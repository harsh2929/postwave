// SPDX-License-Identifier: AGPL-3.0-only
package iceberg

import "testing"

func TestDecodeManifestList_RoundTrip(t *testing.T) {
	entries := []ManifestListEntry{
		{ManifestPath: "s3://b/m1.avro", ManifestLength: 10, SequenceNumber: 1, MinSequenceNumber: 1, AddedSnapshotID: 100, AddedFilesCount: 1, AddedRowsCount: 5},
		{ManifestPath: "s3://b/m2.avro", ManifestLength: 20, SequenceNumber: 2, MinSequenceNumber: 2, AddedSnapshotID: 101, AddedFilesCount: 1, AddedRowsCount: 7},
	}
	ocf, err := EncodeManifestList(entries, [16]byte{9})
	if err != nil {
		t.Fatalf("EncodeManifestList: %v", err)
	}
	got, err := DecodeManifestList(ocf)
	if err != nil {
		t.Fatalf("DecodeManifestList: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("decoded %d entries, want 2", len(got))
	}
	for i, want := range entries {
		g := got[i]
		if g.ManifestPath != want.ManifestPath || g.ManifestLength != want.ManifestLength ||
			g.SequenceNumber != want.SequenceNumber || g.AddedSnapshotID != want.AddedSnapshotID ||
			g.AddedFilesCount != want.AddedFilesCount || g.AddedRowsCount != want.AddedRowsCount {
			t.Errorf("entry %d = %+v, want %+v", i, g, want)
		}
	}

	if _, err := DecodeManifestList([]byte("not an ocf")); err == nil {
		t.Error("non-OCF bytes should error")
	}
}

// TestRecoverTableAppender_ResumesLineage simulates a restart: append two
// snapshots, throw away the in-memory appender, rebuild it from the persisted
// metadata + current manifest-list, and confirm the next append continues the
// same table (parent chain, sequence numbers, accumulating manifests + totals)
// rather than starting a fresh single-snapshot table.
func TestRecoverTableAppender_ResumesLineage(t *testing.T) {
	sync := [16]byte{7}
	app, err := NewTableAppender("uuid-1", "s3://bucket/warehouse/orders", testSchema())
	if err != nil {
		t.Fatalf("NewTableAppender: %v", err)
	}
	_, err = app.Append(encodeTestParquet(t, []testRow{{EventID: 1, TenantID: "a", AtUnixMs: 1}}),
		AppendOptions{SnapshotID: 101, TimestampMs: 1700, ManifestSync: &sync, ManifestListSync: &sync})
	if err != nil {
		t.Fatalf("append 1: %v", err)
	}
	tf2, err := app.Append(encodeTestParquet(t, []testRow{{EventID: 2, TenantID: "b", AtUnixMs: 2}}),
		AppendOptions{SnapshotID: 102, TimestampMs: 1800, ManifestSync: &sync, ManifestListSync: &sync})
	if err != nil {
		t.Fatalf("append 2: %v", err)
	}

	// --- restart: recover from the persisted bytes only ---
	rec, err := RecoverTableAppender(tf2.Metadata.Bytes, tf2.ManifestList.Bytes)
	if err != nil {
		t.Fatalf("RecoverTableAppender: %v", err)
	}
	if rec.SnapshotCount() != 2 {
		t.Fatalf("recovered SnapshotCount = %d, want 2", rec.SnapshotCount())
	}

	// --- the next append continues the SAME table ---
	tf3, err := rec.Append(encodeTestParquet(t, []testRow{{EventID: 3, TenantID: "c", AtUnixMs: 3}}),
		AppendOptions{SnapshotID: 103, TimestampMs: 1900, ManifestSync: &sync, ManifestListSync: &sync})
	if err != nil {
		t.Fatalf("append after recover: %v", err)
	}
	meta := tf3.TableMetadata
	if len(meta.Snapshots) != 3 {
		t.Fatalf("after resume+append: %d snapshots, want 3", len(meta.Snapshots))
	}
	s3 := meta.Snapshots[2]
	if s3.ParentSnapshotID == nil || *s3.ParentSnapshotID != 102 {
		t.Errorf("resumed snapshot parent = %v, want 102 (the pre-restart snapshot)", s3.ParentSnapshotID)
	}
	if s3.SequenceNumber != 3 || meta.LastSequenceNumber != 3 {
		t.Errorf("sequence should continue to 3, got %d", s3.SequenceNumber)
	}
	if meta.CurrentSnapshotID != 103 {
		t.Errorf("current-snapshot-id = %d, want 103", meta.CurrentSnapshotID)
	}
	if s3.Summary["total-records"] != "3" || s3.Summary["total-data-files"] != "3" {
		t.Errorf("totals should accumulate across the restart, got %v", s3.Summary)
	}
	// All three manifests must be live in the resumed snapshot's manifest list.
	_, count, _ := ocfBlock(t, tf3.ManifestList.Bytes)
	if count != 3 {
		t.Errorf("resumed manifest list has %d entries, want 3", count)
	}
}

func TestRecoverTableAppender_Guards(t *testing.T) {
	if _, err := RecoverTableAppender([]byte("{bad json"), nil); err == nil {
		t.Error("invalid metadata JSON should error")
	}
	if _, err := RecoverTableAppender([]byte(`{"format-version":1}`), nil); err == nil {
		t.Error("non-v2 metadata should error")
	}
}
