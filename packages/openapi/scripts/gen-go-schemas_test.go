package main

import (
	"go/parser"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestScalarOrRef(t *testing.T) {
	knownSchemas = map[string]string{"Result": "SearchResult"}
	cases := map[string]string{
		"string":  "type: string",
		"bool":    "type: boolean",
		"int":     "type: integer",
		"int64":   "type: integer",
		"uint32":  "type: integer",
		"float64": "type: number",
		"float32": "type: number",
		"any":     "{}",
		"Result":  "$ref: '#/components/schemas/SearchResult'",
		"Widget":  "type: object", // unknown named type falls back to object
	}
	for in, want := range cases {
		if got := scalarOrRef(in); got != want {
			t.Errorf("scalarOrRef(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestMapType(t *testing.T) {
	knownSchemas = map[string]string{"Result": "SearchResult"}
	cases := []struct {
		expr    string
		want    string
		wantPtr bool
	}{
		{"string", "type: string", false},
		{"*string", "type: string", true}, // pointer ⇒ optional
		{"time.Time", "type: string\nformat: date-time", false},
		{"*time.Time", "type: string\nformat: date-time", true},
		{"[]string", "type: array\nitems:\n  type: string", false},
		{"[]Result", "type: array\nitems:\n  $ref: '#/components/schemas/SearchResult'", false},
		{"map[string]int", "type: object\nadditionalProperties:\n  type: integer", false},
	}
	for _, c := range cases {
		expr, err := parser.ParseExpr(c.expr)
		if err != nil {
			t.Fatalf("ParseExpr(%q): %v", c.expr, err)
		}
		got, ptr := mapType(expr)
		if got != c.want || ptr != c.wantPtr {
			t.Errorf("mapType(%q) = (%q, %v), want (%q, %v)", c.expr, got, ptr, c.want, c.wantPtr)
		}
	}
}

func TestJSONName(t *testing.T) {
	cases := []struct {
		tag  string
		name string
		omit bool
		skip bool
	}{
		{"`json:\"resource\"`", "resource", false, false},
		{"`json:\"detail,omitempty\"`", "detail", true, false},
		{"`json:\"-\"`", "", false, true},
		{"`json:\"\"`", "", false, false}, // empty ⇒ caller falls back to field name
	}
	for _, c := range cases {
		name, omit, skip := jsonName(c.tag)
		if name != c.name || omit != c.omit || skip != c.skip {
			t.Errorf("jsonName(%q) = (%q,%v,%v), want (%q,%v,%v)",
				c.tag, name, omit, skip, c.name, c.omit, c.skip)
		}
	}
}

// TestRenderStruct exercises the full parse→schema pipeline against a
// hermetic fixture so the test doesn't couple to the real API structs.
func TestRenderStruct(t *testing.T) {
	knownSchemas = map[string]string{"Inner": "Inner"}
	src := `package fixture

import "time"

type Sample struct {
	Name      string     ` + "`json:\"name\"`" + `
	Count     int        ` + "`json:\"count\"`" + `
	Ratio     float64    ` + "`json:\"ratio\"`" + `
	Active    bool       ` + "`json:\"active\"`" + `
	Optional  *string    ` + "`json:\"optional,omitempty\"`" + `
	CreatedAt time.Time  ` + "`json:\"created_at\"`" + `
	Nested    *Inner     ` + "`json:\"nested,omitempty\"`" + `
	Tags      []string   ` + "`json:\"tags\"`" + `
	Secret    string     ` + "`json:\"-\"`" + `
	untagged  string
}
`
	dir := t.TempDir()
	path := filepath.Join(dir, "sample.go")
	if err := os.WriteFile(path, []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}

	out, err := renderStruct(path, "Sample")
	if err != nil {
		t.Fatalf("renderStruct: %v", err)
	}

	// Untagged + json:"-" fields are omitted.
	if strings.Contains(out, "Untagged") || strings.Contains(out, "Secret") {
		t.Errorf("expected untagged/skipped fields to be dropped, got:\n%s", out)
	}
	// Pointer + omitempty fields are present but NOT required.
	for _, present := range []string{"name:", "optional:", "created_at:", "nested:", "tags:"} {
		if !strings.Contains(out, present) {
			t.Errorf("expected property %q in output:\n%s", present, out)
		}
	}
	// time.Time renders as date-time; *Inner resolves to $ref.
	if !strings.Contains(out, "format: date-time") {
		t.Errorf("expected date-time for time.Time:\n%s", out)
	}
	if !strings.Contains(out, "$ref: '#/components/schemas/Inner'") {
		t.Errorf("expected $ref for *Inner:\n%s", out)
	}

	// Required = non-pointer, non-omitempty, tagged fields — sorted.
	required := requiredBlock(out)
	want := []string{"active", "count", "created_at", "name", "ratio", "tags"}
	for _, w := range want {
		if !contains(required, w) {
			t.Errorf("expected %q in required %v", w, required)
		}
	}
	for _, notReq := range []string{"optional", "nested"} {
		if contains(required, notReq) {
			t.Errorf("%q must NOT be required (pointer/omitempty)", notReq)
		}
	}
}

// requiredBlock extracts the `- x` entries under the `required:` key.
func requiredBlock(yaml string) []string {
	var out []string
	inReq := false
	for _, line := range strings.Split(yaml, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "required:" {
			inReq = true
			continue
		}
		if inReq {
			if strings.HasPrefix(trimmed, "- ") {
				out = append(out, strings.TrimPrefix(trimmed, "- "))
			} else if trimmed != "" {
				break
			}
		}
	}
	return out
}

func contains(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

// --- the two hard errors, from an adversarial review -------------------------
//
// The change that added these branches also DELETED the only input that
// reached one of them (the fixture's `Untagged string` became `untagged`), so
// `go test` passed with both branches never executed. These assert them
// directly. They matter more than they look: emitted schemas now declare
// `additionalProperties: false`, so a property the generator drops is a
// property a real response gets rejected for.

func TestRenderStructRejectsAnEmbeddedType(t *testing.T) {
	// encoding/json PROMOTES an embedded type's fields into this object. The
	// generator cannot flatten them, so silently skipping emits a schema
	// missing real properties.
	src := `package p

type Base struct {
	ID string ` + "`json:\"id\"`" + `
}

type Sample struct {
	Base
	Name string ` + "`json:\"name\"`" + `
}
`
	if _, err := renderStructSource(t, src, "Sample"); err == nil {
		t.Fatal("an embedded type must be a hard error; the emitted schema would omit the promoted fields")
	}
}

func TestRenderStructRejectsAnExportedUntaggedField(t *testing.T) {
	// Marshalled under its Go name, so omitting it from a CLOSED schema makes a
	// valid response fail validation.
	src := `package p

type Sample struct {
	Name     string ` + "`json:\"name\"`" + `
	Untagged string
}
`
	if _, err := renderStructSource(t, src, "Sample"); err == nil {
		t.Fatal("an exported untagged field must be a hard error; it is serialised as \"Untagged\"")
	}
}

func TestRenderStructRejectsAnExportedNameSharingALine(t *testing.T) {
	// `lo, Hi string` declares two fields on one line. Checking only Names[0]
	// saw the unexported `lo`, skipped the field, and dropped exported `Hi`.
	src := `package p

type Sample struct {
	Name   string ` + "`json:\"name\"`" + `
	lo, Hi string
}
`
	if _, err := renderStructSource(t, src, "Sample"); err == nil {
		t.Fatal("an exported name sharing a line with an unexported one must still be a hard error")
	}
}

func TestRenderStructStillSkipsUnexportedFields(t *testing.T) {
	// The other side: unexported fields are NOT marshalled, so skipping them is
	// correct and must not become an error.
	src := `package p

type Sample struct {
	Name     string ` + "`json:\"name\"`" + `
	untagged string
}
`
	out, err := renderStructSource(t, src, "Sample")
	if err != nil {
		t.Fatalf("an unexported untagged field must be skipped, not rejected: %v", err)
	}
	if !strings.Contains(out, "name:") {
		t.Fatalf("schema lost its tagged field: %s", out)
	}
	if strings.Contains(out, "untagged") {
		t.Fatalf("unexported field leaked into the schema: %s", out)
	}
}

// renderStructSource writes src to a temp file and runs the real renderStruct.
func renderStructSource(t *testing.T, src, name string) (string, error) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "sample.go")
	if err := os.WriteFile(path, []byte(src), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	return renderStruct(path, name)
}
