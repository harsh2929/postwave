package segments

import (
	"encoding/json"
	"strings"
	"testing"
)

// contact_rating maps to the direct subscribers.rating SMALLINT column
// (Mailchimp-parity 1..5 stars). Guards the new segment predicate that makes
// the Audience Intelligence contact-rating tiles segmentable.
func TestCompileASTContactRatingNumeric(t *testing.T) {
	raw := json.RawMessage(`{"op":"condition","field":"contact_rating","comparator":"gte","value":4}`)
	frag, args, err := CompileAST(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(frag, "subscribers.rating") || !strings.Contains(frag, ">=") {
		t.Fatalf("fragment did not target subscribers.rating >=: %s", frag)
	}
	if len(args) != 1 || args[0] != float64(4) {
		t.Fatalf("args = %#v", args)
	}
}

func TestCompileASTContactRatingIsNull(t *testing.T) {
	raw := json.RawMessage(`{"op":"condition","field":"contact_rating","comparator":"is_null"}`)
	frag, _, err := CompileAST(raw)
	if err != nil {
		t.Fatal(err)
	}
	if frag != "subscribers.rating IS NULL" {
		t.Fatalf("unrated fragment = %q", frag)
	}
}

func TestCompileASTContactRatingIn(t *testing.T) {
	raw := json.RawMessage(`{"op":"condition","field":"contact_rating","comparator":"in","value":[4,5]}`)
	frag, args, err := CompileAST(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(frag, "subscribers.rating") || !strings.Contains(frag, "IN (") {
		t.Fatalf("fragment did not target subscribers.rating IN: %s", frag)
	}
	if len(args) != 2 || args[0] != float64(4) || args[1] != float64(5) {
		t.Fatalf("args = %#v", args)
	}
}

// The predicate must be advertised in the base schema so the editor's field
// picker (and the predicate registry the web app reads) surfaces it.
func TestBaseFieldSchemasIncludesContactRating(t *testing.T) {
	var found *FieldSchema
	for i := range baseFieldSchemasForTest() {
		if baseFieldSchemasForTest()[i].Key == "contact_rating" {
			f := baseFieldSchemasForTest()[i]
			found = &f
			break
		}
	}
	if found == nil {
		t.Fatal("contact_rating missing from BaseFieldSchemas")
	}
	if found.Type != "number" {
		t.Fatalf("contact_rating type = %q, want number", found.Type)
	}
	hasIsNull := false
	for _, c := range found.Comparators {
		if c == "is_null" {
			hasIsNull = true
		}
	}
	if !hasIsNull {
		t.Fatal("contact_rating must offer is_null (unrated) comparator")
	}
}

func baseFieldSchemasForTest() []FieldSchema { return BaseFieldSchemas() }
