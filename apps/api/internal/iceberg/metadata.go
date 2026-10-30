// SPDX-License-Identifier: AGPL-3.0-only
//
// metadata.go — Iceberg v2 table-metadata JSON (the file a catalog
// points at — e.g. Hive Metastore/Glue's table property, or a REST
// catalog's load-table response — to resolve "what does this table look
// like right now"). Field names/nesting follow the table-spec's
// "Table Metadata" JSON encoding section exactly, so any conforming
// reader (Spark, Trino, PyIceberg, DuckDB) can load a file this package
// writes without special-casing it.
//
// time.Now()/crypto/rand aren't used here — last-updated-ms and every
// id (table-uuid, snapshot-id) are caller-supplied params, per the
// no-Date.now/no-random constraint on this package: a writer embedded
// in a deterministic pipeline (or a unit test) needs reproducible
// output, and the caller (streaming_export's ship loop, or whatever
// wires this in) already has a clock and an ID source.
package iceberg

import "encoding/json"

// PartitionSpec is an Iceberg partition spec. Only the empty
// (unpartitioned) spec is constructed by this package today; the type
// is exported so callers can pass a populated one through
// WriteTableOptions once partitioned writes are needed.
type PartitionSpec struct {
	SpecID int                  `json:"spec-id"`
	Fields []PartitionSpecField `json:"fields"`
}

// PartitionSpecField is one column of a PartitionSpec.
type PartitionSpecField struct {
	SourceID  int    `json:"source-id"`
	FieldID   int    `json:"field-id"`
	Name      string `json:"name"`
	Transform string `json:"transform"`
}

// SortOrder is an Iceberg sort order. Only the empty (unsorted) order
// is constructed today.
type SortOrder struct {
	OrderID int              `json:"order-id"`
	Fields  []SortOrderField `json:"fields"`
}

// SortOrderField is one column of a SortOrder.
type SortOrderField struct {
	SourceID  int    `json:"source-id"`
	Transform string `json:"transform"`
	Direction string `json:"direction"`
	NullOrder string `json:"null-order"`
}

// Snapshot is one entry in table-metadata's "snapshots" array.
type Snapshot struct {
	SnapshotID       int64             `json:"snapshot-id"`
	ParentSnapshotID *int64            `json:"parent-snapshot-id,omitempty"`
	SequenceNumber   int64             `json:"sequence-number"`
	TimestampMs      int64             `json:"timestamp-ms"`
	Summary          map[string]string `json:"summary"`
	ManifestList     string            `json:"manifest-list"`
	SchemaID         int               `json:"schema-id"`
}

// SnapshotLogEntry is one entry in table-metadata's "snapshot-log".
type SnapshotLogEntry struct {
	SnapshotID  int64 `json:"snapshot-id"`
	TimestampMs int64 `json:"timestamp-ms"`
}

// SnapshotRef is a named branch/tag pointer, e.g. table-metadata's
// refs["main"].
type SnapshotRef struct {
	SnapshotID int64  `json:"snapshot-id"`
	Type       string `json:"type"` // "branch" or "tag"
}

// TableMetadataV2 is the format-version-2 table-metadata JSON document.
type TableMetadataV2 struct {
	FormatVersion      int                    `json:"format-version"`
	TableUUID          string                 `json:"table-uuid"`
	Location           string                 `json:"location"`
	LastSequenceNumber int64                  `json:"last-sequence-number"`
	LastUpdatedMs      int64                  `json:"last-updated-ms"`
	LastColumnID       int                    `json:"last-column-id"`
	Schemas            []schemaJSON           `json:"schemas"`
	CurrentSchemaID    int                    `json:"current-schema-id"`
	PartitionSpecs     []PartitionSpec        `json:"partition-specs"`
	DefaultSpecID      int                    `json:"default-spec-id"`
	LastPartitionID    int                    `json:"last-partition-id"`
	Properties         map[string]string      `json:"properties"`
	CurrentSnapshotID  int64                  `json:"current-snapshot-id"`
	Snapshots          []Snapshot             `json:"snapshots"`
	SnapshotLog        []SnapshotLogEntry     `json:"snapshot-log"`
	SortOrders         []SortOrder            `json:"sort-orders"`
	DefaultSortOrderID int                    `json:"default-sort-order-id"`
	Refs               map[string]SnapshotRef `json:"refs"`
}

// EncodeTableMetadataJSON renders m with 2-space indentation — table
// metadata is meant to be read by humans debugging a catalog as much as
// by engines, and every reference implementation (Java, PyIceberg)
// writes it pretty-printed. (A json.Marshaler MarshalJSON method can't
// do this: encoding/json always re-compacts whatever a MarshalJSON
// implementation returns before embedding/emitting it, so pretty output
// has to come from an explicit MarshalIndent call like this one — which
// is exactly what WriteTable in table.go uses to build Metadata.Bytes.)
func EncodeTableMetadataJSON(m TableMetadataV2) ([]byte, error) {
	return json.MarshalIndent(m, "", "  ")
}
