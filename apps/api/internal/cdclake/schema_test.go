// SPDX-License-Identifier: AGPL-3.0-only
package cdclake

import (
	"testing"

	"github.com/postwave/postwave/apps/api/internal/iceberg"
	"github.com/postwave/postwave/apps/api/internal/pgcdc"
)

func TestSchemaFor_MapsTypesAndKeys(t *testing.T) {
	rel := pgcdc.RelationMessage{
		RelationName: "orders",
		Columns: []pgcdc.RelationColumn{
			{Key: true, Name: "id", TypeOID: oidInt8},
			{Name: "total_cents", TypeOID: oidInt4},
			{Name: "amount", TypeOID: oidNumeric},
			{Name: "paid", TypeOID: oidBool},
			{Name: "ordered_at", TypeOID: oidTimestampTZ},
			{Name: "note", TypeOID: oidText},
			{Name: "ratio", TypeOID: oidFloat8},
		},
	}
	schema, err := SchemaFor(rel)
	if err != nil {
		t.Fatalf("SchemaFor: %v", err)
	}

	want := []struct {
		name string
		typ  iceberg.PrimitiveType
		req  bool
	}{
		{"id", iceberg.TypeLong, true}, // int8 + key → Long, Required
		{"total_cents", iceberg.TypeInt, false},
		{"amount", iceberg.TypeString, false}, // numeric → string (lossless)
		{"paid", iceberg.TypeBoolean, false},
		{"ordered_at", iceberg.TypeTimestamp, false},
		{"note", iceberg.TypeString, false},
		{"ratio", iceberg.TypeDouble, false},
	}
	if len(schema.Fields) != len(want) {
		t.Fatalf("got %d fields, want %d", len(schema.Fields), len(want))
	}
	for i, w := range want {
		f := schema.Fields[i]
		if f.Name != w.name || f.Type != w.typ || f.Required != w.req {
			t.Errorf("field %d = {%s %s req=%v}, want {%s %s req=%v}",
				i, f.Name, f.Type, f.Required, w.name, w.typ, w.req)
		}
		if f.ID != i+1 { // AssignFieldIDs numbers 1..n in column order
			t.Errorf("field %d (%s) id = %d, want %d", i, f.Name, f.ID, i+1)
		}
	}

	// The derived schema must itself be a valid Iceberg schema.
	if err := schema.Validate(); err != nil {
		t.Errorf("derived schema is invalid: %v", err)
	}
}

func TestSchemaFor_AllMappedOIDs(t *testing.T) {
	cases := map[uint32]iceberg.PrimitiveType{
		oidBool: iceberg.TypeBoolean, oidBytea: iceberg.TypeBinary,
		oidChar: iceberg.TypeString, oidInt8: iceberg.TypeLong,
		oidInt2: iceberg.TypeInt, oidInt4: iceberg.TypeInt,
		oidText: iceberg.TypeString, oidJSON: iceberg.TypeString,
		oidFloat4: iceberg.TypeFloat, oidFloat8: iceberg.TypeDouble,
		oidBpchar: iceberg.TypeString, oidVarchar: iceberg.TypeString,
		oidDate: iceberg.TypeDate, oidTimestamp: iceberg.TypeTimestamp,
		oidTimestampTZ: iceberg.TypeTimestamp, oidNumeric: iceberg.TypeString,
		oidUUID: iceberg.TypeString, oidJSONB: iceberg.TypeString,
	}
	for oid, want := range cases {
		rel := pgcdc.RelationMessage{
			RelationName: "t",
			Columns:      []pgcdc.RelationColumn{{Name: "c", TypeOID: oid}},
		}
		schema, err := SchemaFor(rel)
		if err != nil {
			t.Errorf("OID %d: unexpected error %v", oid, err)
			continue
		}
		if schema.Fields[0].Type != want {
			t.Errorf("OID %d mapped to %s, want %s", oid, schema.Fields[0].Type, want)
		}
	}
}

func TestSchemaFor_UnsupportedOIDErrors(t *testing.T) {
	// 1000 is _bool[] (an array type) — deliberately unmapped; must error, not
	// silently produce a misinterpreted column.
	rel := pgcdc.RelationMessage{
		RelationName: "t",
		Columns:      []pgcdc.RelationColumn{{Name: "tags", TypeOID: 1000}},
	}
	if _, err := SchemaFor(rel); err == nil {
		t.Fatal("an unsupported type OID must be a hard error")
	}
}

func TestSchemaFor_EmptyRelationErrors(t *testing.T) {
	if _, err := SchemaFor(pgcdc.RelationMessage{RelationName: "empty"}); err == nil {
		t.Fatal("a relation with no columns should error")
	}
}
