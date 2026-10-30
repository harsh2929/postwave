// SPDX-License-Identifier: AGPL-3.0-only
//
// export.go — the last data-level piece of the CDC→lakehouse path: turn
// decoded pgoutput change rows into a Parquet file + Iceberg table.
//
// pgoutput sends every value in its Postgres text representation (bool as
// "t"/"f", ints/floats as decimal text, timestamps as formatted strings,
// bytea as "\x…" hex). EncodeParquet parses each into the typed value its
// column's Iceberg type wants and writes a Parquet file whose column order is
// taken from parquet-go's canonical (name-sorted) field order — the same
// order the returned iceberg.Schema is built in, so iceberg.WriteDataFile's
// positional column→field-id mapping lines up. WriteChanges then wraps that
// into the four Iceberg table files.
package cdclake

import (
	"bytes"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/parquet-go/parquet-go"

	"github.com/postwave/postwave/apps/api/internal/iceberg"
	"github.com/postwave/postwave/apps/api/internal/pgcdc"
)

// pgEpochDays / pgUnixEpoch anchor date/timestamp text parsing.
var unixEpoch = time.Date(1970, 1, 1, 0, 0, 0, 0, time.UTC)

// parquetNodeForOID returns the parquet leaf node for a Postgres type OID,
// matching icebergTypeForOID's choice (int2/4→int32, int8→int64, numeric/
// json/uuid→string, etc.). Every column is optional so a CDC null (or a
// delete's non-key nulls) is representable.
func parquetNodeForOID(oid uint32) (parquet.Node, bool) {
	var leaf parquet.Node
	switch oid {
	case oidBool:
		leaf = parquet.Leaf(parquet.BooleanType)
	case oidInt2, oidInt4:
		leaf = parquet.Int(32)
	case oidInt8:
		leaf = parquet.Int(64)
	case oidFloat4:
		leaf = parquet.Leaf(parquet.FloatType)
	case oidFloat8:
		leaf = parquet.Leaf(parquet.DoubleType)
	case oidDate:
		leaf = parquet.Int(32) // days since the unix epoch (Iceberg date)
	case oidTimestamp, oidTimestampTZ:
		leaf = parquet.Int(64) // micros since the unix epoch (Iceberg timestamp)
	case oidBytea:
		leaf = parquet.Leaf(parquet.ByteArrayType)
	case oidChar, oidText, oidBpchar, oidVarchar, oidUUID, oidJSON, oidJSONB, oidNumeric:
		leaf = parquet.String()
	default:
		return nil, false
	}
	return parquet.Optional(leaf), true
}

// parseValue converts one pgoutput text value to the typed parquet.Value its
// column OID calls for. colIndex/def are applied by the caller.
func parseValue(oid uint32, text string) (parquet.Value, error) {
	switch oid {
	case oidBool:
		// pgoutput encodes booleans as "t"/"f".
		return parquet.BooleanValue(text == "t" || text == "true"), nil
	case oidInt2, oidInt4:
		n, err := strconv.ParseInt(text, 10, 32)
		if err != nil {
			return parquet.Value{}, err
		}
		return parquet.Int32Value(int32(n)), nil
	case oidInt8:
		n, err := strconv.ParseInt(text, 10, 64)
		if err != nil {
			return parquet.Value{}, err
		}
		return parquet.Int64Value(n), nil
	case oidFloat4:
		f, err := strconv.ParseFloat(text, 32)
		if err != nil {
			return parquet.Value{}, err
		}
		return parquet.FloatValue(float32(f)), nil
	case oidFloat8:
		f, err := strconv.ParseFloat(text, 64)
		if err != nil {
			return parquet.Value{}, err
		}
		return parquet.DoubleValue(f), nil
	case oidDate:
		d, err := time.Parse("2006-01-02", text)
		if err != nil {
			return parquet.Value{}, err
		}
		days := int32(d.Sub(unixEpoch).Hours() / 24)
		return parquet.Int32Value(days), nil
	case oidTimestamp, oidTimestampTZ:
		micros, err := parsePGTimestampMicros(text)
		if err != nil {
			return parquet.Value{}, err
		}
		return parquet.Int64Value(micros), nil
	case oidBytea:
		raw, err := parsePGBytea(text)
		if err != nil {
			return parquet.Value{}, err
		}
		return parquet.ByteArrayValue(raw), nil
	case oidChar, oidText, oidBpchar, oidVarchar, oidUUID, oidJSON, oidJSONB, oidNumeric:
		return parquet.ByteArrayValue([]byte(text)), nil
	default:
		return parquet.Value{}, fmt.Errorf("cdclake: no value parser for OID %d", oid)
	}
}

// parsePGTimestampMicros parses the text form pgoutput emits for timestamp /
// timestamptz into microseconds since the unix epoch.
func parsePGTimestampMicros(text string) (int64, error) {
	layouts := []string{
		"2006-01-02 15:04:05.999999-07",
		"2006-01-02 15:04:05.999999",
		"2006-01-02 15:04:05-07",
		"2006-01-02 15:04:05",
	}
	for _, l := range layouts {
		if ts, err := time.Parse(l, text); err == nil {
			return ts.Sub(unixEpoch).Microseconds(), nil
		}
	}
	return 0, fmt.Errorf("cdclake: unrecognized timestamp %q", text)
}

// parsePGBytea decodes the "\x<hex>" text form of a bytea value.
func parsePGBytea(text string) ([]byte, error) {
	if strings.HasPrefix(text, `\x`) {
		return hex.DecodeString(text[2:])
	}
	return []byte(text), nil // already raw (rare)
}

// EncodeParquet builds a Parquet file for rows (each a decoded change tuple's
// named columns) conforming to a schema derived from rel, and returns the
// bytes plus the iceberg.Schema whose column order matches the file's. Every
// row must carry exactly the relation's columns (NamedColumns guarantees
// this). Null / unchanged-TOAST columns are written as Parquet nulls.
func EncodeParquet(rel pgcdc.RelationMessage, rows [][]pgcdc.NamedColumn) ([]byte, iceberg.Schema, error) {
	if len(rel.Columns) == 0 {
		return nil, iceberg.Schema{}, fmt.Errorf("cdclake: relation %s has no columns", rel.RelationName)
	}
	// Build the parquet group; parquet-go orders group fields by name, so we
	// read that canonical order back and build everything else against it.
	group := parquet.Group{}
	oidByName := map[string]uint32{}
	keyByName := map[string]bool{}
	for _, c := range rel.Columns {
		node, ok := parquetNodeForOID(c.TypeOID)
		if !ok {
			return nil, iceberg.Schema{}, fmt.Errorf(
				"cdclake: column %q unsupported Postgres type OID %d", c.Name, c.TypeOID)
		}
		group[c.Name] = node
		oidByName[c.Name] = c.TypeOID
		keyByName[c.Name] = c.Key
	}
	pqSchema := parquet.NewSchema(rel.RelationName, group)

	// Canonical column order + the iceberg schema built in the same order.
	order := pqSchema.Fields()
	colIndex := make(map[string]int, len(order))
	iceFields := make([]iceberg.Field, len(order))
	for i, f := range order {
		colIndex[f.Name()] = i
		t, _ := icebergTypeForOID(oidByName[f.Name()]) // ok: validated above
		iceFields[i] = iceberg.Field{Name: f.Name(), Type: t, Required: keyByName[f.Name()]}
	}
	iceSchema := iceberg.Schema{Fields: iceFields}
	iceSchema.AssignFieldIDs()
	if err := iceSchema.Validate(); err != nil {
		return nil, iceberg.Schema{}, err
	}

	var buf bytes.Buffer
	w := parquet.NewGenericWriter[any](&buf, pqSchema)
	pqRows := make([]parquet.Row, 0, len(rows))
	for _, row := range rows {
		pqRow := make(parquet.Row, len(order))
		// Prefill nulls so a missing column is a null, not a panic.
		for name, idx := range colIndex {
			pqRow[idx] = parquet.NullValue().Level(0, 0, idx)
			_ = name
		}
		for _, col := range row {
			idx, ok := colIndex[col.Name]
			if !ok {
				return nil, iceberg.Schema{}, fmt.Errorf("cdclake: row has unknown column %q", col.Name)
			}
			if col.Null || col.Unchanged || col.Value == nil {
				pqRow[idx] = parquet.NullValue().Level(0, 0, idx)
				continue
			}
			v, err := parseValue(oidByName[col.Name], *col.Value)
			if err != nil {
				return nil, iceberg.Schema{}, fmt.Errorf("cdclake: column %q: %w", col.Name, err)
			}
			pqRow[idx] = v.Level(0, 1, idx) // optional column, present -> def 1
		}
		pqRows = append(pqRows, pqRow)
	}
	if _, err := w.WriteRows(pqRows); err != nil {
		return nil, iceberg.Schema{}, fmt.Errorf("cdclake: write parquet rows: %w", err)
	}
	if err := w.Close(); err != nil {
		return nil, iceberg.Schema{}, fmt.Errorf("cdclake: close parquet writer: %w", err)
	}
	return buf.Bytes(), iceSchema, nil
}

// WriteChanges is the end-to-end data path: encode the change rows to Parquet
// and wrap them into a single-snapshot Iceberg table via iceberg.WriteTable.
// opts carries the table identity/location/snapshot (see iceberg).
func WriteChanges(rel pgcdc.RelationMessage, rows [][]pgcdc.NamedColumn, opts iceberg.WriteTableOptions) (*iceberg.TableFiles, error) {
	parquetBytes, schema, err := EncodeParquet(rel, rows)
	if err != nil {
		return nil, err
	}
	return iceberg.WriteTable(schema, parquetBytes, opts)
}
