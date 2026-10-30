// SPDX-License-Identifier: AGPL-3.0-only
//
// manifest.go — Iceberg v2 manifest file: an Avro OCF of manifest_entry
// records, each wrapping a DataFile. This package writes exactly one
// entry per manifest (one data file per WriteTable call) with
// status=ADDED; snapshot_id/sequence_number/file_sequence_number are
// left null on the entry and inherited from the manifest-list's
// added_snapshot_id/sequence_number at read time, which is the
// optimization the spec's "Sequence Number Inheritance" section
// describes for newly-added manifests (every production Iceberg writer
// — Java, PyIceberg — does the same for freshly committed files).
//
// Field ids on every record below (e.g. field-id 134 for "content",
// 100 for "file_path") are copied verbatim from the table-spec's
// Appendix A Avro schemas so files this package writes are byte-level
// interoperable with any conforming Iceberg reader, not just its own
// decoder.
package iceberg

import "bytes"

const dataFileAvroSchema = `{"type":"record","name":"r2","fields":[` +
	`{"name":"content","type":"int","field-id":134},` +
	`{"name":"file_path","type":"string","field-id":100},` +
	`{"name":"file_format","type":"string","field-id":101},` +
	`{"name":"partition","type":{"type":"record","name":"r102","fields":[]},"field-id":102},` +
	`{"name":"record_count","type":"long","field-id":103},` +
	`{"name":"file_size_in_bytes","type":"long","field-id":104},` +
	`{"name":"column_sizes","type":["null",{"type":"array","items":{"type":"record","name":"k117_v118","fields":[` +
	`{"name":"key","type":"int","field-id":117},{"name":"value","type":"long","field-id":118}]},"element-id":112}],"default":null,"field-id":108},` +
	`{"name":"value_counts","type":["null",{"type":"array","items":{"type":"record","name":"k119_v120","fields":[` +
	`{"name":"key","type":"int","field-id":119},{"name":"value","type":"long","field-id":120}]},"element-id":113}],"default":null,"field-id":109},` +
	`{"name":"null_value_counts","type":["null",{"type":"array","items":{"type":"record","name":"k121_v122","fields":[` +
	`{"name":"key","type":"int","field-id":121},{"name":"value","type":"long","field-id":122}]},"element-id":114}],"default":null,"field-id":110},` +
	`{"name":"lower_bounds","type":["null",{"type":"array","items":{"type":"record","name":"k126_v127","fields":[` +
	`{"name":"key","type":"int","field-id":126},{"name":"value","type":"bytes","field-id":127}]},"element-id":124}],"default":null,"field-id":125},` +
	`{"name":"upper_bounds","type":["null",{"type":"array","items":{"type":"record","name":"k129_v130","fields":[` +
	`{"name":"key","type":"int","field-id":129},{"name":"value","type":"bytes","field-id":130}]},"element-id":128}],"default":null,"field-id":128},` +
	`{"name":"split_offsets","type":["null",{"type":"array","items":"long","element-id":133}],"default":null,"field-id":132}` +
	`]}`

// manifestEntrySchema is the Iceberg v2 manifest_entry Avro record.
// ManifestEntrySchema exposes it for tests/inspection.
const manifestEntrySchema = `{"type":"record","name":"manifest_entry","fields":[` +
	`{"name":"status","type":"int","field-id":0},` +
	`{"name":"snapshot_id","type":["null","long"],"default":null,"field-id":1},` +
	`{"name":"sequence_number","type":["null","long"],"default":null,"field-id":3},` +
	`{"name":"file_sequence_number","type":["null","long"],"default":null,"field-id":4},` +
	`{"name":"data_file","type":` + dataFileAvroSchema + `,"field-id":2}` +
	`]}`

// ManifestEntrySchema returns the Avro schema string embedded in every
// manifest OCF's header.
func ManifestEntrySchema() string { return manifestEntrySchema }

// manifestEntryStatusAdded is the manifest_entry.status value for a
// file newly added in this snapshot (0=EXISTING, 1=ADDED, 2=DELETED).
const manifestEntryStatusAdded = 1

// ManifestFile is what EncodeManifest reports about the manifest it
// wrote — everything manifest_list.go's ManifestFile Avro record (a
// different, list-level struct of the same name in the spec) needs to
// reference it from a snapshot.
type ManifestFile struct {
	Bytes           []byte
	Length          int64
	AddedFilesCount int32
	AddedRowsCount  int64
}

// EncodeManifest writes a single-entry Iceberg v2 manifest (Avro OCF)
// wrapping df. sync is the OCF sync marker to use; pass a fresh one from
// newAvroSync for production use, or a fixed one from a test for
// deterministic golden bytes.
func EncodeManifest(df DataFile, sync [16]byte) (*ManifestFile, error) {
	var rec bytes.Buffer
	encodeManifestEntry(&rec, df)

	body := encodeAvroOCF(manifestEntrySchema, sync, 1, rec.Bytes())
	return &ManifestFile{
		Bytes:           body,
		Length:          int64(len(body)),
		AddedFilesCount: 1,
		AddedRowsCount:  df.RecordCount,
	}, nil
}

func encodeManifestEntry(buf *bytes.Buffer, df DataFile) {
	writeAvroInt(buf, manifestEntryStatusAdded)
	writeAvroNullableLong(buf, nil) // snapshot_id: inherited
	writeAvroNullableLong(buf, nil) // sequence_number: inherited
	writeAvroNullableLong(buf, nil) // file_sequence_number: inherited
	encodeDataFile(buf, df)
}

// encodeDataFile writes df in the field order declared by
// dataFileAvroSchema — order is load-bearing.
func encodeDataFile(buf *bytes.Buffer, df DataFile) {
	writeAvroInt(buf, df.Content)
	writeAvroString(buf, df.FilePath)
	writeAvroString(buf, df.FileFormat)
	// partition: empty record (r102 has no fields — unpartitioned table)
	writeAvroLong(buf, df.RecordCount)
	writeAvroLong(buf, df.FileSizeInBytes)
	writeAvroIntLongMap(buf, df.ColumnSizes)
	writeAvroIntLongMap(buf, df.ValueCounts)
	writeAvroIntLongMap(buf, df.NullValueCounts)
	writeAvroIntBytesMap(buf, df.LowerBounds)
	writeAvroIntBytesMap(buf, df.UpperBounds)
	writeAvroNullableLongArray(buf, df.SplitOffsets)
}
