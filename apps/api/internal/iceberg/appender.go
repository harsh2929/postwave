// SPDX-License-Identifier: AGPL-3.0-only
//
// appender.go — incremental commits. WriteTable produces a fresh, single-
// snapshot table; a CDC consumer landing successive micro-batches into the
// SAME table instead needs each batch to add a snapshot on top of the last,
// preserving history. TableAppender holds the accumulating state (all live
// manifests, the snapshot log, the last snapshot id + sequence number) and
// emits, per Append, the full set of table files for a table that now has one
// more snapshot than before.
//
// The model is append-only and spec-correct without manifest compaction: each
// snapshot's manifest list references every data manifest added so far (the
// prior ones plus this batch's), snapshots carry parent-snapshot-id back to
// their predecessor, and table-metadata keeps the whole snapshots array +
// snapshot-log so a reader can time-travel. It does not merge manifests (an
// optimization, not a correctness requirement) or handle deletes/schema
// evolution — those are separate mechanisms.
//
// Like the rest of the package it takes ids/timestamps as params (no
// time.Now/rand) so output stays reproducible; the caller supplies a unique
// snapshot id and a clock reading per Append.
package iceberg

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// TableAppender accumulates the state needed to commit successive snapshots to
// one Iceberg table. Construct it once per table with NewTableAppender and
// call Append per batch. It is not safe for concurrent use.
type TableAppender struct {
	tableUUID    string
	location     string
	schema       Schema
	lastColumnID int

	manifests    []ManifestListEntry // every live data manifest, in add order
	snapshots    []Snapshot
	snapshotLog  []SnapshotLogEntry
	lastSnapshot int64
	lastSeq      int64
	totalRecords int64
	appendCount  int
}

// AppendOptions parameterizes one Append.
type AppendOptions struct {
	// SnapshotID is the id of the snapshot this Append creates (required,
	// unique across the table's history).
	SnapshotID int64
	// TimestampMs is the snapshot's timestamp-ms and the table's
	// last-updated-ms.
	TimestampMs int64
	// ManifestSync/ManifestListSync pin the Avro OCF sync markers for
	// reproducible output; nil generates random ones.
	ManifestSync     *[16]byte
	ManifestListSync *[16]byte
	// Properties are merged into table-metadata "properties".
	Properties map[string]string
}

// NewTableAppender starts an appender for a table at location with the given
// schema (field ids are assigned in place if unset). The first Append writes
// the table's first snapshot.
func NewTableAppender(tableUUID, location string, schema Schema) (*TableAppender, error) {
	if tableUUID == "" {
		return nil, fmt.Errorf("iceberg: TableAppender requires a table UUID")
	}
	if location == "" {
		return nil, fmt.Errorf("iceberg: TableAppender requires a location")
	}
	schema.AssignFieldIDs()
	last := 0
	for _, f := range schema.Fields {
		if f.ID > last {
			last = f.ID
		}
	}
	if err := schema.Validate(); err != nil {
		return nil, err
	}
	return &TableAppender{
		tableUUID:    tableUUID,
		location:     strings.TrimRight(location, "/"),
		schema:       schema,
		lastColumnID: last,
	}, nil
}

// SnapshotCount is how many snapshots have been committed so far.
func (a *TableAppender) SnapshotCount() int { return len(a.snapshots) }

// Append commits one new snapshot carrying parquetBytes and returns the full
// table files (data + manifest + manifest-list + metadata) for the table as of
// this snapshot. The appender's state is only mutated on success.
func (a *TableAppender) Append(parquetBytes []byte, opts AppendOptions) (*TableFiles, error) {
	if opts.SnapshotID == 0 {
		return nil, fmt.Errorf("iceberg: AppendOptions.SnapshotID is required")
	}
	n := a.appendCount + 1
	seq := a.lastSeq + 1

	dataName := fmt.Sprintf("%05d-0-%d.parquet", n, opts.SnapshotID)
	manifestName := fmt.Sprintf("snap-%d-%d-manifest.avro", opts.SnapshotID, n)
	manifestListName := fmt.Sprintf("snap-%d-%d.avro", opts.SnapshotID, n)
	metadataName := fmt.Sprintf("%05d-%s.metadata.json", seq, a.tableUUID)

	dataPath := a.location + "/data/" + dataName
	manifestPath := a.location + "/metadata/" + manifestName
	manifestListPath := a.location + "/metadata/" + manifestListName
	metadataPath := a.location + "/metadata/" + metadataName

	df, err := WriteDataFile(a.schema, parquetBytes, dataPath)
	if err != nil {
		return nil, fmt.Errorf("iceberg: append data file: %w", err)
	}

	manifestSync, err := resolveSync(opts.ManifestSync)
	if err != nil {
		return nil, err
	}
	manifest, err := EncodeManifest(*df, manifestSync)
	if err != nil {
		return nil, fmt.Errorf("iceberg: encode manifest: %w", err)
	}
	newEntry := ManifestListEntry{
		ManifestPath:      manifestPath,
		ManifestLength:    manifest.Length,
		PartitionSpecID:   0,
		SequenceNumber:    seq,
		MinSequenceNumber: seq,
		AddedSnapshotID:   opts.SnapshotID,
		AddedFilesCount:   manifest.AddedFilesCount,
		AddedRowsCount:    manifest.AddedRowsCount,
	}
	// The new snapshot lists every live manifest: the prior ones plus this
	// batch's. Copy so a mid-flight failure can't leave the state mutated.
	entries := make([]ManifestListEntry, 0, len(a.manifests)+1)
	entries = append(entries, a.manifests...)
	entries = append(entries, newEntry)

	manifestListSync, err := resolveSync(opts.ManifestListSync)
	if err != nil {
		return nil, err
	}
	manifestListBytes, err := EncodeManifestList(entries, manifestListSync)
	if err != nil {
		return nil, fmt.Errorf("iceberg: encode manifest list: %w", err)
	}

	var parent *int64
	if a.lastSnapshot != 0 {
		p := a.lastSnapshot
		parent = &p
	}
	total := a.totalRecords + df.RecordCount

	props := opts.Properties
	if props == nil {
		props = map[string]string{}
	}

	snap := Snapshot{
		SnapshotID:       opts.SnapshotID,
		ParentSnapshotID: parent,
		SequenceNumber:   seq,
		TimestampMs:      opts.TimestampMs,
		Summary: map[string]string{
			"operation":        "append",
			"added-data-files": "1",
			"added-records":    fmt.Sprintf("%d", df.RecordCount),
			"added-files-size": fmt.Sprintf("%d", df.FileSizeInBytes),
			"total-records":    fmt.Sprintf("%d", total),
			"total-data-files": fmt.Sprintf("%d", len(entries)),
		},
		ManifestList: manifestListPath,
		SchemaID:     a.schema.SchemaID,
	}
	snapshots := make([]Snapshot, 0, len(a.snapshots)+1)
	snapshots = append(snapshots, a.snapshots...)
	snapshots = append(snapshots, snap)
	log := make([]SnapshotLogEntry, 0, len(a.snapshotLog)+1)
	log = append(log, a.snapshotLog...)
	log = append(log, SnapshotLogEntry{SnapshotID: opts.SnapshotID, TimestampMs: opts.TimestampMs})

	meta := TableMetadataV2{
		FormatVersion:      2,
		TableUUID:          a.tableUUID,
		Location:           a.location,
		LastSequenceNumber: seq,
		LastUpdatedMs:      opts.TimestampMs,
		LastColumnID:       a.lastColumnID,
		Schemas:            []schemaJSON{a.schema.toJSON()},
		CurrentSchemaID:    a.schema.SchemaID,
		PartitionSpecs:     []PartitionSpec{{SpecID: 0, Fields: []PartitionSpecField{}}},
		DefaultSpecID:      0,
		LastPartitionID:    999,
		Properties:         props,
		CurrentSnapshotID:  opts.SnapshotID,
		Snapshots:          snapshots,
		SnapshotLog:        log,
		SortOrders:         []SortOrder{{OrderID: 0, Fields: []SortOrderField{}}},
		DefaultSortOrderID: 0,
		Refs:               map[string]SnapshotRef{"main": {SnapshotID: opts.SnapshotID, Type: "branch"}},
	}
	metaBytes, err := EncodeTableMetadataJSON(meta)
	if err != nil {
		return nil, fmt.Errorf("iceberg: marshal table metadata: %w", err)
	}

	// Commit state now that every fallible step has succeeded.
	a.manifests = entries
	a.snapshots = snapshots
	a.snapshotLog = log
	a.lastSnapshot = opts.SnapshotID
	a.lastSeq = seq
	a.totalRecords = total
	a.appendCount = n

	return &TableFiles{
		Data:          FileOutput{Path: dataPath, Bytes: parquetBytes},
		Manifest:      FileOutput{Path: manifestPath, Bytes: manifest.Bytes},
		ManifestList:  FileOutput{Path: manifestListPath, Bytes: manifestListBytes},
		Metadata:      FileOutput{Path: metadataPath, Bytes: metaBytes},
		DataFileStats: *df,
		TableMetadata: meta,
	}, nil
}

// RecoverTableAppender rebuilds an appender from an existing table's current
// table-metadata JSON and the manifest-list of its current snapshot, so a
// restarted process resumes that table's snapshot history (parent links,
// sequence numbers, the live manifest set) instead of starting a fresh table.
// metadataBytes is a table-metadata JSON this package wrote; manifestListBytes
// is the Avro OCF at the current snapshot's manifest-list path. The next
// Append continues from the recovered state.
func RecoverTableAppender(metadataBytes, manifestListBytes []byte) (*TableAppender, error) {
	var meta TableMetadataV2
	if err := json.Unmarshal(metadataBytes, &meta); err != nil {
		return nil, fmt.Errorf("iceberg: parse table metadata: %w", err)
	}
	if meta.FormatVersion != 2 {
		return nil, fmt.Errorf("iceberg: RecoverTableAppender wants format-version 2, got %d", meta.FormatVersion)
	}
	if meta.TableUUID == "" || meta.Location == "" {
		return nil, fmt.Errorf("iceberg: table metadata missing table-uuid/location")
	}
	if len(meta.Schemas) == 0 {
		return nil, fmt.Errorf("iceberg: table metadata has no schema")
	}
	schema := schemaFromJSON(pickSchema(meta))
	if err := schema.Validate(); err != nil {
		return nil, fmt.Errorf("iceberg: recovered schema invalid: %w", err)
	}
	manifests, err := DecodeManifestList(manifestListBytes)
	if err != nil {
		return nil, fmt.Errorf("iceberg: decode current manifest list: %w", err)
	}

	return &TableAppender{
		tableUUID:    meta.TableUUID,
		location:     strings.TrimRight(meta.Location, "/"),
		schema:       schema,
		lastColumnID: meta.LastColumnID,
		manifests:    manifests,
		snapshots:    meta.Snapshots,
		snapshotLog:  meta.SnapshotLog,
		lastSnapshot: meta.CurrentSnapshotID,
		lastSeq:      meta.LastSequenceNumber,
		totalRecords: currentTotalRecords(meta),
		appendCount:  len(meta.Snapshots),
	}, nil
}

// pickSchema returns the metadata's current schema (by current-schema-id),
// falling back to the first.
func pickSchema(meta TableMetadataV2) schemaJSON {
	for _, s := range meta.Schemas {
		if s.SchemaID == meta.CurrentSchemaID {
			return s
		}
	}
	return meta.Schemas[0]
}

// schemaFromJSON is the inverse of Schema.toJSON: field ids/names/types are
// already assigned in the persisted metadata, so they're taken as-is.
func schemaFromJSON(s schemaJSON) Schema {
	fields := make([]Field, len(s.Fields))
	for i, f := range s.Fields {
		fields[i] = Field{ID: f.ID, Name: f.Name, Type: PrimitiveType(f.Type), Required: f.Required}
	}
	return Schema{SchemaID: s.SchemaID, Fields: fields}
}

// currentTotalRecords reads total-records off the current snapshot's summary
// (0 if absent/unparseable) so the resumed appender keeps an accurate running
// total in later snapshots.
func currentTotalRecords(meta TableMetadataV2) int64 {
	for _, s := range meta.Snapshots {
		if s.SnapshotID == meta.CurrentSnapshotID {
			if v, err := strconv.ParseInt(s.Summary["total-records"], 10, 64); err == nil {
				return v
			}
		}
	}
	return 0
}
