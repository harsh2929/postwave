// SPDX-License-Identifier: AGPL-3.0-only
//
// manifest_list.go — Iceberg v2 manifest list: an Avro OCF of
// manifest_file records, one per manifest that belongs to a snapshot.
// WriteTable's snapshots always have exactly one manifest (the one
// EncodeManifest just produced), so EncodeManifestList only ever writes
// a single record — but the record itself is the real spec shape, so a
// caller doing incremental commits (appending more manifests to an
// existing table) can grow this into a multi-manifest list by
// concatenating more ManifestListEntry values.
//
// v2 promoted several manifest-list counts (content, sequence_number,
// added_files_count, …) from optional to required, so — unlike
// manifest_entry's optional per-column stat maps — none of these fields
// are wrapped in a ["null", …] union; every production v2 writer
// (Java/PyIceberg) always populates them for newly-written manifests.
package iceberg

import "bytes"

const manifestListAvroSchema = `{"type":"record","name":"manifest_file","fields":[` +
	`{"name":"manifest_path","type":"string","field-id":500},` +
	`{"name":"manifest_length","type":"long","field-id":501},` +
	`{"name":"partition_spec_id","type":"int","field-id":502},` +
	`{"name":"content","type":"int","field-id":517},` +
	`{"name":"sequence_number","type":"long","field-id":515},` +
	`{"name":"min_sequence_number","type":"long","field-id":516},` +
	`{"name":"added_snapshot_id","type":"long","field-id":503},` +
	`{"name":"added_files_count","type":"int","field-id":504},` +
	`{"name":"existing_files_count","type":"int","field-id":505},` +
	`{"name":"deleted_files_count","type":"int","field-id":506},` +
	`{"name":"added_rows_count","type":"long","field-id":512},` +
	`{"name":"existing_rows_count","type":"long","field-id":513},` +
	`{"name":"deleted_rows_count","type":"long","field-id":514},` +
	`{"name":"partitions","type":["null",{"type":"array","items":{"type":"record","name":"r508","fields":[` +
	`{"name":"contains_null","type":"boolean","field-id":509},` +
	`{"name":"contains_nan","type":["null","boolean"],"default":null,"field-id":518},` +
	`{"name":"lower_bound","type":["null","bytes"],"default":null,"field-id":510},` +
	`{"name":"upper_bound","type":["null","bytes"],"default":null,"field-id":511}` +
	`]}}],"default":null,"field-id":507},` +
	`{"name":"key_metadata","type":["null","bytes"],"default":null,"field-id":519}` +
	`]}`

// ManifestListSchema returns the Avro schema string embedded in every
// manifest-list OCF's header.
func ManifestListSchema() string { return manifestListAvroSchema }

// ManifestListEntry is one manifest_file record in the manifest list —
// a single manifest, summarized for the snapshot it belongs to.
type ManifestListEntry struct {
	ManifestPath       string
	ManifestLength     int64
	PartitionSpecID    int32
	SequenceNumber     int64
	MinSequenceNumber  int64
	AddedSnapshotID    int64
	AddedFilesCount    int32
	ExistingFilesCount int32
	DeletedFilesCount  int32
	AddedRowsCount     int64
	ExistingRowsCount  int64
	DeletedRowsCount   int64
}

// EncodeManifestList writes an Iceberg v2 manifest list (Avro OCF)
// containing entries, in order.
func EncodeManifestList(entries []ManifestListEntry, sync [16]byte) ([]byte, error) {
	var rec bytes.Buffer
	for _, e := range entries {
		encodeManifestListEntry(&rec, e)
	}
	return encodeAvroOCF(manifestListAvroSchema, sync, len(entries), rec.Bytes()), nil
}

// encodeManifestListEntry writes e in the field order declared by
// manifestListAvroSchema — order is load-bearing.
func encodeManifestListEntry(buf *bytes.Buffer, e ManifestListEntry) {
	writeAvroString(buf, e.ManifestPath)
	writeAvroLong(buf, e.ManifestLength)
	writeAvroInt(buf, e.PartitionSpecID)
	writeAvroInt(buf, 0) // content: 0 = data manifest
	writeAvroLong(buf, e.SequenceNumber)
	writeAvroLong(buf, e.MinSequenceNumber)
	writeAvroLong(buf, e.AddedSnapshotID)
	writeAvroInt(buf, e.AddedFilesCount)
	writeAvroInt(buf, e.ExistingFilesCount)
	writeAvroInt(buf, e.DeletedFilesCount)
	writeAvroLong(buf, e.AddedRowsCount)
	writeAvroLong(buf, e.ExistingRowsCount)
	writeAvroLong(buf, e.DeletedRowsCount)
	writeAvroLong(buf, 0) // partitions: null branch (unpartitioned table)
	writeAvroLong(buf, 0) // key_metadata: null branch (unencrypted)
}
