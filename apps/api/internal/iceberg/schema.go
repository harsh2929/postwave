// SPDX-License-Identifier: AGPL-3.0-only
//
// schema.go — Iceberg table schema (a flat struct of primitive columns)
// and field-id assignment.
//
// Every column in an Iceberg schema carries a permanent, small integer
// "field id" that is independent of column name/position — it's what
// lets Iceberg rename/reorder columns without rewriting data files.
// Field ids are assigned once, in schema-declaration order, starting
// at 1 (id 0 is reserved by the spec's row-status/internal fields used
// in manifests, never in a table's own schema). This package assigns
// ids for callers that don't already have stable ones; callers that do
// (e.g. migrating from another catalog) can set Field.ID explicitly and
// AssignFieldIDs leaves those untouched.
package iceberg

import "fmt"

// PrimitiveType is an Iceberg primitive type name, per the table-spec
// "Primitive Types" table. Only the subset needed for event-export rows
// is enumerated; extending it is additive.
type PrimitiveType string

const (
	TypeBoolean   PrimitiveType = "boolean"
	TypeInt       PrimitiveType = "int"
	TypeLong      PrimitiveType = "long"
	TypeFloat     PrimitiveType = "float"
	TypeDouble    PrimitiveType = "double"
	TypeDate      PrimitiveType = "date"
	TypeTimestamp PrimitiveType = "timestamp"
	TypeString    PrimitiveType = "string"
	TypeBinary    PrimitiveType = "binary"
)

// Field is one column of an Iceberg schema.
type Field struct {
	// ID is the field's permanent id. Leave 0 to have AssignFieldIDs
	// (or Schema.AssignFieldIDs) allocate the next free id.
	ID       int
	Name     string
	Type     PrimitiveType
	Required bool
}

// Schema is an Iceberg table schema: an ordered list of top-level
// columns plus the schema-id it's registered under in table metadata.
// Nested (struct/list/map) columns are out of scope — event-export rows
// are flat, and the manifest/metadata encoders below only need to walk
// primitive columns to compute per-column stats.
type Schema struct {
	SchemaID int
	Fields   []Field
}

// AssignFieldIDs allocates a permanent id to every field whose ID is
// still 0, in slice order, starting one past the current maximum
// existing id (so partially-assigned schemas — e.g. hand-picked ids for
// fields that must match an existing catalog — are respected). It
// mutates and returns the same slice, plus the resulting last-column-id
// (the "last-column-id" table-metadata property, which must be >= every
// assigned field id so a future ALTER TABLE ADD COLUMN can't collide).
func AssignFieldIDs(fields []Field) ([]Field, int) {
	last := 0
	for _, f := range fields {
		if f.ID > last {
			last = f.ID
		}
	}
	for i := range fields {
		if fields[i].ID == 0 {
			last++
			fields[i].ID = last
		}
	}
	return fields, last
}

// AssignFieldIDs assigns ids to s.Fields in place (see the package-level
// function) and returns the last-column-id.
func (s *Schema) AssignFieldIDs() int {
	fields, last := AssignFieldIDs(s.Fields)
	s.Fields = fields
	return last
}

// FieldByName returns the field with the given name, or false if absent.
func (s *Schema) FieldByName(name string) (Field, bool) {
	for _, f := range s.Fields {
		if f.Name == name {
			return f, true
		}
	}
	return Field{}, false
}

// Validate checks that every field has a positive, unique id and a
// non-empty name — the minimum an Iceberg reader needs to trust the
// schema. Call after AssignFieldIDs.
func (s *Schema) Validate() error {
	if len(s.Fields) == 0 {
		return fmt.Errorf("iceberg: schema has no fields")
	}
	seen := make(map[int]bool, len(s.Fields))
	for _, f := range s.Fields {
		if f.Name == "" {
			return fmt.Errorf("iceberg: field with empty name (id=%d)", f.ID)
		}
		if f.ID <= 0 {
			return fmt.Errorf("iceberg: field %q has non-positive id %d (call AssignFieldIDs first)", f.Name, f.ID)
		}
		if seen[f.ID] {
			return fmt.Errorf("iceberg: duplicate field id %d (field %q)", f.ID, f.Name)
		}
		seen[f.ID] = true
	}
	return nil
}

// schemaJSON / fieldJSON mirror the table-metadata JSON encoding of a
// schema (see metadata.go), factored out here since manifest.go's
// data-file struct construction also needs to walk field ids+types.
type fieldJSON struct {
	ID       int    `json:"id"`
	Name     string `json:"name"`
	Required bool   `json:"required"`
	Type     string `json:"type"`
}

type schemaJSON struct {
	Type               string      `json:"type"`
	SchemaID           int         `json:"schema-id"`
	Fields             []fieldJSON `json:"fields"`
	IdentifierFieldIDs []int       `json:"identifier-field-ids,omitempty"`
}

func (s Schema) toJSON() schemaJSON {
	out := schemaJSON{Type: "struct", SchemaID: s.SchemaID, Fields: make([]fieldJSON, len(s.Fields))}
	for i, f := range s.Fields {
		out.Fields[i] = fieldJSON{ID: f.ID, Name: f.Name, Required: f.Required, Type: string(f.Type)}
	}
	return out
}
