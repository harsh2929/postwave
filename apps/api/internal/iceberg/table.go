// SPDX-License-Identifier: AGPL-3.0-only
//
// table.go — WriteTable orchestrates schema.go/datafile.go/manifest.go/
// manifest_list.go/metadata.go into the four files a caller needs to
// upload to object storage to make a brand-new single-snapshot Iceberg
// v2 table queryable: the Parquet data file, its manifest, the manifest
// list, and the table-metadata JSON a catalog should point at.
//
// It never touches the network or a filesystem itself — every return
// value is just (path, bytes), matching the streaming_export worker's
// existing "encode in memory, hand bytes to the S3 client" shape (see
// internal/streaming_export/worker.go) so wiring this in is an
// additive branch in that ship step, not a rewrite of it.
package iceberg

import (
	"fmt"
	"strings"
)

// FileOutput is one file this package produced: the (storage-relative
// or fully-qualified) path it should be uploaded to, and its bytes.
type FileOutput struct {
	Path  string
	Bytes []byte
}

// TableFiles is everything WriteTable produced for one new table
// (or one new single-manifest snapshot committed onto an existing one).
type TableFiles struct {
	Data         FileOutput
	Manifest     FileOutput
	ManifestList FileOutput
	Metadata     FileOutput

	// DataFileStats is the DataFile struct computed from the Parquet
	// footer (record count, size, column bounds) — exposed for callers
	// that want to log/assert on it without re-parsing Manifest.Bytes.
	DataFileStats DataFile
	// TableMetadata is the decoded form of Metadata.Bytes.
	TableMetadata TableMetadataV2
}

// WriteTableOptions parameterizes WriteTable. Every id/timestamp is
// caller-supplied (no time.Now()/crypto/rand for anything but the Avro
// OCF sync markers, which are cosmetic framing, not table state) so
// output is reproducible given the same inputs.
type WriteTableOptions struct {
	// TableUUID is table-metadata's permanent "table-uuid".
	TableUUID string
	// Location is the table's base storage location, no trailing slash
	// (e.g. "s3://bucket/warehouse/events"). Data/metadata file paths
	// are built underneath it following Iceberg's conventional
	// data/ and metadata/ subdirectories.
	Location string
	// LastUpdatedMs is table-metadata's "last-updated-ms" and the new
	// snapshot's "timestamp-ms".
	LastUpdatedMs int64
	// SnapshotID is the id of the single snapshot this call creates.
	SnapshotID int64
	// ParentSnapshotID, if non-nil, makes this an incremental commit
	// (parent-snapshot-id) rather than the table's first snapshot.
	ParentSnapshotID *int64
	// SequenceNumber is the snapshot's sequence number; defaults to 1
	// when zero (valid for a table's first-ever snapshot — sequence
	// numbers start at 1, 0 means "no data" in the spec).
	SequenceNumber int64

	// File names (not full paths) for the four outputs. Sensible
	// defaults are used for any left empty.
	DataFileName         string
	ManifestFileName     string
	ManifestListFileName string
	MetadataFileName     string

	// ManifestSync/ManifestListSync override the Avro OCF sync marker
	// for the manifest/manifest-list files. Leave nil for a random one
	// (crypto/rand, matching streaming_export's EncodeAvro); tests that
	// need byte-for-byte reproducible output can pin them.
	ManifestSync     *[16]byte
	ManifestListSync *[16]byte

	// Properties are extra table-metadata "properties" entries (e.g.
	// "write.format.default": "parquet"). May be nil.
	Properties map[string]string
}

// WriteTable builds a full single-snapshot Iceberg v2 table around
// parquetBytes (an already-encoded Parquet file — e.g. the output of
// streaming_export.EncodeParquet, or WriteTableWithEncoder's callback).
// schema's field order must match parquetBytes's column order; fields
// with ID==0 are assigned permanent ids in place before anything is
// encoded, so callers can pass a schema built with bare Name/Type/
// Required and let WriteTable number it.
func WriteTable(schema Schema, parquetBytes []byte, opts WriteTableOptions) (*TableFiles, error) {
	schema.AssignFieldIDs()
	lastColumnID := 0
	for _, f := range schema.Fields {
		if f.ID > lastColumnID {
			lastColumnID = f.ID
		}
	}
	if err := schema.Validate(); err != nil {
		return nil, err
	}
	if opts.TableUUID == "" {
		return nil, fmt.Errorf("iceberg: WriteTableOptions.TableUUID is required")
	}
	if opts.Location == "" {
		return nil, fmt.Errorf("iceberg: WriteTableOptions.Location is required")
	}
	location := strings.TrimRight(opts.Location, "/")
	seq := opts.SequenceNumber
	if seq == 0 {
		seq = 1
	}

	dataName := opts.DataFileName
	if dataName == "" {
		dataName = fmt.Sprintf("00000-0-%d.parquet", opts.SnapshotID)
	}
	manifestName := opts.ManifestFileName
	if manifestName == "" {
		manifestName = fmt.Sprintf("snap-%d-1-manifest.avro", opts.SnapshotID)
	}
	manifestListName := opts.ManifestListFileName
	if manifestListName == "" {
		manifestListName = fmt.Sprintf("snap-%d-1.avro", opts.SnapshotID)
	}
	metadataName := opts.MetadataFileName
	if metadataName == "" {
		metadataName = fmt.Sprintf("%05d-%s.metadata.json", seq, opts.TableUUID)
	}

	dataPath := location + "/data/" + dataName
	manifestPath := location + "/metadata/" + manifestName
	manifestListPath := location + "/metadata/" + manifestListName
	metadataPath := location + "/metadata/" + metadataName

	df, err := WriteDataFile(schema, parquetBytes, dataPath)
	if err != nil {
		return nil, fmt.Errorf("iceberg: write data file: %w", err)
	}

	manifestSync, err := resolveSync(opts.ManifestSync)
	if err != nil {
		return nil, err
	}
	manifest, err := EncodeManifest(*df, manifestSync)
	if err != nil {
		return nil, fmt.Errorf("iceberg: encode manifest: %w", err)
	}

	manifestListSync, err := resolveSync(opts.ManifestListSync)
	if err != nil {
		return nil, err
	}
	manifestListBytes, err := EncodeManifestList([]ManifestListEntry{{
		ManifestPath:      manifestPath,
		ManifestLength:    manifest.Length,
		PartitionSpecID:   0,
		SequenceNumber:    seq,
		MinSequenceNumber: seq,
		AddedSnapshotID:   opts.SnapshotID,
		AddedFilesCount:   manifest.AddedFilesCount,
		AddedRowsCount:    manifest.AddedRowsCount,
	}}, manifestListSync)
	if err != nil {
		return nil, fmt.Errorf("iceberg: encode manifest list: %w", err)
	}

	props := opts.Properties
	if props == nil {
		props = map[string]string{}
	}

	meta := TableMetadataV2{
		FormatVersion:      2,
		TableUUID:          opts.TableUUID,
		Location:           location,
		LastSequenceNumber: seq,
		LastUpdatedMs:      opts.LastUpdatedMs,
		LastColumnID:       lastColumnID,
		Schemas:            []schemaJSON{schema.toJSON()},
		CurrentSchemaID:    schema.SchemaID,
		PartitionSpecs:     []PartitionSpec{{SpecID: 0, Fields: []PartitionSpecField{}}},
		DefaultSpecID:      0,
		LastPartitionID:    999,
		Properties:         props,
		CurrentSnapshotID:  opts.SnapshotID,
		Snapshots: []Snapshot{{
			SnapshotID:       opts.SnapshotID,
			ParentSnapshotID: opts.ParentSnapshotID,
			SequenceNumber:   seq,
			TimestampMs:      opts.LastUpdatedMs,
			Summary: map[string]string{
				"operation":        "append",
				"added-data-files": "1",
				"added-records":    fmt.Sprintf("%d", df.RecordCount),
				"added-files-size": fmt.Sprintf("%d", df.FileSizeInBytes),
			},
			ManifestList: manifestListPath,
			SchemaID:     schema.SchemaID,
		}},
		SnapshotLog: []SnapshotLogEntry{{
			SnapshotID:  opts.SnapshotID,
			TimestampMs: opts.LastUpdatedMs,
		}},
		SortOrders:         []SortOrder{{OrderID: 0, Fields: []SortOrderField{}}},
		DefaultSortOrderID: 0,
		Refs: map[string]SnapshotRef{
			"main": {SnapshotID: opts.SnapshotID, Type: "branch"},
		},
	}

	metaBytes, err := EncodeTableMetadataJSON(meta)
	if err != nil {
		return nil, fmt.Errorf("iceberg: marshal table metadata: %w", err)
	}

	return &TableFiles{
		Data:          FileOutput{Path: dataPath, Bytes: parquetBytes},
		Manifest:      FileOutput{Path: manifestPath, Bytes: manifest.Bytes},
		ManifestList:  FileOutput{Path: manifestListPath, Bytes: manifestListBytes},
		Metadata:      FileOutput{Path: metadataPath, Bytes: metaBytes},
		DataFileStats: *df,
		TableMetadata: meta,
	}, nil
}

// WriteTableWithEncoder is WriteTable for callers that haven't already
// encoded their rows to Parquet — encode is any row encoder with the
// same signature as streaming_export.EncodeParquet (which this package
// deliberately does not import, to stay decoupled from that package's
// EventRow type); a caller in internal/streaming_export can pass
// `func() ([]byte, error) { return streaming_export.EncodeParquet(rows) }`.
func WriteTableWithEncoder(schema Schema, encode func() ([]byte, error), opts WriteTableOptions) (*TableFiles, error) {
	parquetBytes, err := encode()
	if err != nil {
		return nil, fmt.Errorf("iceberg: encode rows: %w", err)
	}
	return WriteTable(schema, parquetBytes, opts)
}

func resolveSync(pinned *[16]byte) ([16]byte, error) {
	if pinned != nil {
		return *pinned, nil
	}
	return newAvroSync()
}
