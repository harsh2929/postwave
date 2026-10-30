// SPDX-License-Identifier: AGPL-3.0-only
package iceberg

import "testing"

func TestAssignFieldIDsSequentialFromOne(t *testing.T) {
	fields := []Field{
		{Name: "event_id", Type: TypeLong, Required: true},
		{Name: "tenant_id", Type: TypeString, Required: true},
		{Name: "at_unix_ms", Type: TypeLong, Required: true},
	}
	out, last := AssignFieldIDs(fields)
	if len(out) != 3 {
		t.Fatalf("len(out) = %d", len(out))
	}
	for i, f := range out {
		wantID := i + 1
		if f.ID != wantID {
			t.Fatalf("field %d (%s) id = %d want %d", i, f.Name, f.ID, wantID)
		}
	}
	if last != 3 {
		t.Fatalf("last-column-id = %d want 3", last)
	}
}

func TestAssignFieldIDsRespectsPreassigned(t *testing.T) {
	fields := []Field{
		{ID: 5, Name: "a", Type: TypeString},
		{Name: "b", Type: TypeString}, // should become 6
		{ID: 2, Name: "c", Type: TypeString},
		{Name: "d", Type: TypeString}, // should become 7 (max seen so far is 6)
	}
	out, last := AssignFieldIDs(fields)
	want := []int{5, 6, 2, 7}
	for i, f := range out {
		if f.ID != want[i] {
			t.Fatalf("field %d id = %d want %d", i, f.ID, want[i])
		}
	}
	if last != 7 {
		t.Fatalf("last-column-id = %d want 7", last)
	}
}

func TestSchemaValidateCatchesErrors(t *testing.T) {
	empty := Schema{}
	if err := empty.Validate(); err == nil {
		t.Fatal("expected error for empty schema")
	}

	noID := Schema{Fields: []Field{{Name: "x", Type: TypeString}}}
	if err := noID.Validate(); err == nil {
		t.Fatal("expected error for zero-id field")
	}

	dup := Schema{Fields: []Field{
		{ID: 1, Name: "x", Type: TypeString},
		{ID: 1, Name: "y", Type: TypeString},
	}}
	if err := dup.Validate(); err == nil {
		t.Fatal("expected error for duplicate id")
	}

	blankName := Schema{Fields: []Field{{ID: 1, Name: "", Type: TypeString}}}
	if err := blankName.Validate(); err == nil {
		t.Fatal("expected error for blank name")
	}

	ok := Schema{Fields: []Field{{ID: 1, Name: "x", Type: TypeString, Required: true}}}
	if err := ok.Validate(); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestSchemaToJSONFieldOrderAndTypes(t *testing.T) {
	s := Schema{SchemaID: 0, Fields: []Field{
		{Name: "event_id", Type: TypeLong, Required: true},
		{Name: "tags", Type: TypeString, Required: false},
	}}
	s.AssignFieldIDs()
	j := s.toJSON()
	if j.Type != "struct" || j.SchemaID != 0 {
		t.Fatalf("schemaJSON header wrong: %+v", j)
	}
	if len(j.Fields) != 2 {
		t.Fatalf("field count = %d", len(j.Fields))
	}
	if j.Fields[0].ID != 1 || j.Fields[0].Name != "event_id" || j.Fields[0].Type != "long" || !j.Fields[0].Required {
		t.Fatalf("field0 = %+v", j.Fields[0])
	}
	if j.Fields[1].ID != 2 || j.Fields[1].Name != "tags" || j.Fields[1].Type != "string" || j.Fields[1].Required {
		t.Fatalf("field1 = %+v", j.Fields[1])
	}
}

func TestFieldByName(t *testing.T) {
	s := Schema{Fields: []Field{{ID: 1, Name: "a", Type: TypeString}}}
	f, ok := s.FieldByName("a")
	if !ok || f.ID != 1 {
		t.Fatalf("FieldByName(a) = %+v, %v", f, ok)
	}
	if _, ok := s.FieldByName("missing"); ok {
		t.Fatal("expected FieldByName(missing) to be absent")
	}
}
