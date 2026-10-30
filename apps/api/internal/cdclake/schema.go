// SPDX-License-Identifier: AGPL-3.0-only
//
// Package cdclake bridges the two verified halves of G-18's warehouse-native
// path: it turns a decoded Postgres logical-replication relation
// (internal/pgcdc) into an Apache Iceberg table schema (internal/iceberg), so
// change events streamed off a replication slot can be written into an
// Iceberg table whose columns line up with the source table.
//
// Keeping this mapping in its own package keeps pgcdc (a pure wire decoder)
// and iceberg (a pure table writer) decoupled — neither imports the other;
// only this bridge imports both.
//
// The Postgres type OID → Iceberg primitive-type mapping is the correctness-
// sensitive part: an OID mapped to the wrong Iceberg type silently
// misinterprets every value in that column for every downstream reader, so an
// unrecognized OID is a hard error here rather than a lossy default.
package cdclake

import (
	"fmt"

	"github.com/postwave/postwave/apps/api/internal/iceberg"
	"github.com/postwave/postwave/apps/api/internal/pgcdc"
)

// Well-known, stable Postgres base-type OIDs (from the catalog's pg_type.h;
// these values are fixed across versions for built-in types).
const (
	oidBool        = 16
	oidBytea       = 17
	oidChar        = 18
	oidInt8        = 20
	oidInt2        = 21
	oidInt4        = 23
	oidText        = 25
	oidJSON        = 114
	oidFloat4      = 700
	oidFloat8      = 701
	oidBpchar      = 1042
	oidVarchar     = 1043
	oidDate        = 1082
	oidTimestamp   = 1114
	oidTimestampTZ = 1184
	oidNumeric     = 1700
	oidUUID        = 2950
	oidJSONB       = 3802
)

// icebergTypeForOID maps a Postgres base-type OID to the Iceberg primitive
// type its values serialize to.
//
//   - numeric/decimal maps to string (not Iceberg decimal): pgoutput sends
//     values in their text form and does not carry precision/scale, so a
//     lossless string is safer than guessing a decimal(p,s).
//   - json/jsonb/uuid map to string (their canonical text form).
//   - int2/int4 map to Iceberg int (32-bit); int8 to long (64-bit).
func icebergTypeForOID(oid uint32) (iceberg.PrimitiveType, bool) {
	switch oid {
	case oidBool:
		return iceberg.TypeBoolean, true
	case oidInt2, oidInt4:
		return iceberg.TypeInt, true
	case oidInt8:
		return iceberg.TypeLong, true
	case oidFloat4:
		return iceberg.TypeFloat, true
	case oidFloat8:
		return iceberg.TypeDouble, true
	case oidDate:
		return iceberg.TypeDate, true
	case oidTimestamp, oidTimestampTZ:
		return iceberg.TypeTimestamp, true
	case oidBytea:
		return iceberg.TypeBinary, true
	case oidChar, oidText, oidBpchar, oidVarchar, oidUUID, oidJSON, oidJSONB, oidNumeric:
		return iceberg.TypeString, true
	default:
		return "", false
	}
}

// SchemaFor derives an Iceberg schema from a pgoutput relation, assigning
// field ids in column order (via iceberg.AssignFieldIDs). A replica-identity
// key column is marked Required (key columns are NOT NULL by definition);
// other columns are left optional, since pgoutput's relation message does not
// carry per-column nullability. It errors on an unknown column type OID
// rather than emit a column a reader would misinterpret.
func SchemaFor(rel pgcdc.RelationMessage) (iceberg.Schema, error) {
	if len(rel.Columns) == 0 {
		return iceberg.Schema{}, fmt.Errorf("cdclake: relation %s has no columns", rel.RelationName)
	}
	fields := make([]iceberg.Field, 0, len(rel.Columns))
	for _, col := range rel.Columns {
		t, ok := icebergTypeForOID(col.TypeOID)
		if !ok {
			return iceberg.Schema{}, fmt.Errorf(
				"cdclake: column %q has unsupported Postgres type OID %d (relation %s)",
				col.Name, col.TypeOID, rel.RelationName)
		}
		fields = append(fields, iceberg.Field{
			Name:     col.Name,
			Type:     t,
			Required: col.Key,
		})
	}
	schema := iceberg.Schema{Fields: fields}
	schema.AssignFieldIDs()
	if err := schema.Validate(); err != nil {
		return iceberg.Schema{}, err
	}
	return schema, nil
}
