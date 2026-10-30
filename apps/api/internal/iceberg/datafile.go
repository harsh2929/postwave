// SPDX-License-Identifier: AGPL-3.0-only
//
// datafile.go — WriteDataFile turns an already-encoded Parquet file
// (streaming_export.EncodeParquet's output, or any parquet-go writer's
// output) into an Iceberg v2 DataFile struct: record_count, file_size,
// and per-column stats (sizes, value/null counts, lower/upper bounds).
//
// The stats are read out of the Parquet footer's real column-chunk
// Statistics — not recomputed from the rows — so WriteDataFile only
// needs the schema (to map parquet column position → Iceberg field id)
// and the encoded bytes. That also means the numbers are exactly what a
// Parquet-aware query engine already trusts for this file.
//
// Iceberg's "Binary single-value serialization" for the fixed-width
// primitive types this package supports (int/long: little-endian
// two's-complement; float/double: little-endian IEEE-754; string:
// UTF-8 bytes; binary: raw bytes) is byte-for-byte identical to
// Parquet's PLAIN encoding of the same physical types, so the raw
// min_value/max_value bytes out of the Parquet footer are reused
// directly as Iceberg's lower_bounds/upper_bounds — no reinterpretation
// needed, just type-aware comparison when merging across row groups.
package iceberg

import (
	"bytes"
	"fmt"
	"math"

	"github.com/parquet-go/parquet-go"
	"github.com/parquet-go/parquet-go/format"
)

// DataFile is the Iceberg v2 data_file struct (manifest-entry field 2),
// restricted to the fields a Parquet data file (content=0, unpartitioned)
// needs. See manifest.go for how it's serialized to Avro.
type DataFile struct {
	Content         int32 // 0 = data
	FilePath        string
	FileFormat      string // "PARQUET"
	RecordCount     int64
	FileSizeInBytes int64
	ColumnSizes     map[int]int64  // field id → total compressed column-chunk bytes
	ValueCounts     map[int]int64  // field id → total value count (incl. nulls)
	NullValueCounts map[int]int64  // field id → total null count
	LowerBounds     map[int][]byte // field id → serialized min
	UpperBounds     map[int][]byte // field id → serialized max
	SplitOffsets    []int64
}

// WriteDataFile inspects parquetBytes's footer and builds the Iceberg
// DataFile describing it at path. schema's field order must match the
// Parquet file's column order (true for both streaming_export.EventRow
// and any schema built the same way — see the package doc for the
// convention); WriteDataFile returns an error if the column counts
// disagree, since a silent field-id mismatch would corrupt every reader
// that trusts the stats.
func WriteDataFile(schema Schema, parquetBytes []byte, path string) (*DataFile, error) {
	if len(parquetBytes) == 0 {
		return nil, fmt.Errorf("iceberg: empty parquet bytes")
	}
	if err := schema.Validate(); err != nil {
		return nil, err
	}

	f, err := parquet.OpenFile(bytes.NewReader(parquetBytes), int64(len(parquetBytes)))
	if err != nil {
		return nil, fmt.Errorf("iceberg: open parquet footer: %w", err)
	}
	meta := f.Metadata()

	if len(meta.RowGroups) > 0 {
		gotCols := len(meta.RowGroups[0].Columns)
		if gotCols != len(schema.Fields) {
			return nil, fmt.Errorf("iceberg: parquet file has %d columns, schema has %d fields", gotCols, len(schema.Fields))
		}
	}

	df := &DataFile{
		Content:         0,
		FilePath:        path,
		FileFormat:      "PARQUET",
		RecordCount:     meta.NumRows,
		FileSizeInBytes: int64(len(parquetBytes)),
		ColumnSizes:     map[int]int64{},
		ValueCounts:     map[int]int64{},
		NullValueCounts: map[int]int64{},
		LowerBounds:     map[int][]byte{},
		UpperBounds:     map[int][]byte{},
	}

	for _, rg := range meta.RowGroups {
		if rg.FileOffset > 0 {
			df.SplitOffsets = append(df.SplitOffsets, rg.FileOffset)
		} else if len(rg.Columns) > 0 {
			df.SplitOffsets = append(df.SplitOffsets, rg.Columns[0].MetaData.DataPageOffset)
		}

		for colIdx, col := range rg.Columns {
			if colIdx >= len(schema.Fields) {
				break // already validated equal length when RowGroups[0]; defensive for later groups
			}
			fieldID := schema.Fields[colIdx].ID
			cm := col.MetaData

			df.ColumnSizes[fieldID] += cm.TotalCompressedSize
			df.ValueCounts[fieldID] += cm.NumValues
			df.NullValueCounts[fieldID] += cm.Statistics.NullCount

			minB, maxB := statBounds(cm)
			if minB != nil {
				df.LowerBounds[fieldID] = mergeBound(cm.Type, df.LowerBounds[fieldID], minB, true)
			}
			if maxB != nil {
				df.UpperBounds[fieldID] = mergeBound(cm.Type, df.UpperBounds[fieldID], maxB, false)
			}
		}
	}

	return df, nil
}

// statBounds prefers the modern min_value/max_value fields, falling
// back to the deprecated min/max fields old writers used.
func statBounds(cm format.ColumnMetaData) (min, max []byte) {
	min, max = cm.Statistics.MinValue, cm.Statistics.MaxValue
	if min == nil {
		min = cm.Statistics.Min
	}
	if max == nil {
		max = cm.Statistics.Max
	}
	return min, max
}

// mergeBound folds a new row group's min (keepMin=true) or max
// (keepMin=false) bound into the running one, comparing by the
// column's physical type. cur==nil means "no bound yet".
func mergeBound(t format.Type, cur, next []byte, keepMin bool) []byte {
	if cur == nil {
		return next
	}
	if lessBytes(t, next, cur) == keepMin {
		return next
	}
	return cur
}

// lessBytes reports whether a < b when interpreted as Parquet
// PLAIN-encoded values of physical type t. Falls back to a raw byte
// comparison for any type not explicitly handled (safe for the
// fixed-length/byte-array types used by string/binary columns).
func lessBytes(t format.Type, a, b []byte) bool {
	switch t {
	case format.Boolean:
		if len(a) == 0 || len(b) == 0 {
			return false
		}
		return a[0] == 0 && b[0] != 0
	case format.Int32:
		if len(a) < 4 || len(b) < 4 {
			return false
		}
		return int32(le32(a)) < int32(le32(b))
	case format.Int64:
		if len(a) < 8 || len(b) < 8 {
			return false
		}
		return int64(le64(a)) < int64(le64(b))
	case format.Float:
		if len(a) < 4 || len(b) < 4 {
			return false
		}
		return math.Float32frombits(le32(a)) < math.Float32frombits(le32(b))
	case format.Double:
		if len(a) < 8 || len(b) < 8 {
			return false
		}
		return math.Float64frombits(le64(a)) < math.Float64frombits(le64(b))
	default: // ByteArray, FixedLenByteArray, INT96 (unused here)
		return bytes.Compare(a, b) < 0
	}
}

func le32(b []byte) uint32 {
	return uint32(b[0]) | uint32(b[1])<<8 | uint32(b[2])<<16 | uint32(b[3])<<24
}

func le64(b []byte) uint64 {
	return uint64(b[0]) | uint64(b[1])<<8 | uint64(b[2])<<16 | uint64(b[3])<<24 |
		uint64(b[4])<<32 | uint64(b[5])<<40 | uint64(b[6])<<48 | uint64(b[7])<<56
}
