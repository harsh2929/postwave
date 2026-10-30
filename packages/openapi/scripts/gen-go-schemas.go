// gen-go-schemas.go — generate OpenAPI component schemas FROM Go response
// structs.
//
// The existing regenerate.go extracts route *stubs* from the gateway but
// deliberately punts request/response *schema* codegen ("needs handler
// annotations or struct-tag scanning"). This is that scanning: it parses an
// explicit allow-list of json-tagged Go structs with go/ast and emits their
// OpenAPI schemas to packages/openapi/generated/go-schemas.yaml.
//
// Scope + safety (deliberate):
//   - EXPLICIT allow-list, not whole-tree discovery — a struct joins the
//     generated surface by a conscious edit, and the blast radius is bounded.
//   - Writes a STANDALONE artifact; it does NOT mutate openapi.yaml or the
//     codegen source (surfaces/openapi.yaml), so it cannot break sync-json or
//     the TS codegen. Merging into the served spec is a separate, reviewed step.
//   - `-check` fails (exit 1) if the committed file is stale, so CI keeps the
//     generated schemas honest against the Go structs they mirror.
//
// Usage:
//
//	go run ./scripts/gen-go-schemas.go         # (re)write the generated file
//	go run ./scripts/gen-go-schemas.go -check  # exit 1 if out of date
package main

import (
	"bytes"
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
)

// structRef names one Go struct to generate a schema for.
type structRef struct {
	file   string // repo-relative path to the .go file
	name   string // Go struct type name
	schema string // OpenAPI schema name to emit
}

// allowList — the response structs whose schemas we generate. Add a struct
// here (a conscious decision) to bring it under generated coverage.
var allowList = []structRef{
	{"apps/api/internal/search/index.go", "Result", "SearchResult"},
	{"apps/api/internal/search/index.go", "Response", "SearchResponse"},
	{"apps/api/internal/limits/handlers.go", "UsageRow", "UsageRow"},
	{"apps/api/internal/limits/plan_summary.go", "SendsProjection", "SendsProjection"},
	{"apps/api/internal/limits/plan_summary.go", "PlanSummary", "PlanSummary"},
	// The transactional send ledger. Its shape is public contract — six SDKs
	// read `status` — and it just gained `attempt_state` / `external_effect`,
	// which is exactly the drift a generated schema exists to catch: a Go field
	// added without a spec change now fails `-check`.
	{"apps/api/internal/transactional/repo.go", "Record", "TransactionalEmailRecord"},
	// The two most-consumed gateway resources. Brought under generated coverage
	// so a Go field added without a spec change fails `-check`, instead of
	// reaching every SDK as an undocumented field nobody can see.
	{"apps/api/internal/subscribers/types.go", "Subscriber", "Subscriber"},
	{"apps/api/internal/campaigns/types.go", "Campaign", "Campaign"},
}

// knownSchemas maps a Go struct name → the emitted schema name, so a field
// whose type is another allow-listed struct becomes a $ref.
var knownSchemas = map[string]string{}

func main() {
	check := flag.Bool("check", false, "exit 1 if the generated file is stale")
	merge := flag.String("merge", "", "comma-separated schema names to splice into packages/openapi/openapi.yaml")
	flag.Parse()

	repoRoot, err := findRepoRoot()
	if err != nil {
		fatal(err)
	}
	for _, r := range allowList {
		knownSchemas[r.name] = r.schema
	}

	schemas := map[string]string{}
	for _, r := range allowList {
		body, err := renderStruct(filepath.Join(repoRoot, r.file), r.name)
		if err != nil {
			fatal(fmt.Errorf("%s.%s: %w", r.file, r.name, err))
		}
		schemas[r.schema] = body
	}

	out := assemble(schemas)
	outPath := filepath.Join(repoRoot, "packages/openapi/generated/go-schemas.yaml")

	if *check {
		existing, err := os.ReadFile(outPath)
		if err != nil || !bytes.Equal(bytes.TrimRight(existing, "\n"), bytes.TrimRight([]byte(out), "\n")) {
			fmt.Fprintln(os.Stderr,
				"✗ generated/go-schemas.yaml is out of date.\n"+
					"  Run `pnpm regen:go-schemas` AND `pnpm regen:go-schemas:merge`, then\n"+
					"  `pnpm --filter @postwave/openapi sync-json`. Regenerating alone leaves the\n"+
					"  SERVED spec publishing a closed schema that is missing the new field, so\n"+
					"  a real response would fail validation against the published contract.")
			os.Exit(1)
		}
		// -check and -merge compose: `-check -merge X` verifies BOTH that the
		// generated file is current AND that the spec carries the same bytes.
		// Returning here made that combination a silent no-op.
		if *merge == "" {
			fmt.Println("✓ go-schemas.yaml is up to date with the Go structs.")
			return
		}
		if err := verifyMerged(repoRoot, schemas, strings.Split(*merge, ",")); err != nil {
			fmt.Fprintf(os.Stderr, "✗ %v\n", err)
			os.Exit(1)
		}
		fmt.Println("✓ go-schemas.yaml is current AND the served spec matches it.")
		return
	}

	if err := os.MkdirAll(filepath.Dir(outPath), 0o755); err != nil {
		fatal(err)
	}
	if *merge != "" {
		if err := mergeIntoSpec(repoRoot, schemas, strings.Split(*merge, ",")); err != nil {
			fatal(err)
		}
	}
	if err := os.WriteFile(outPath, []byte(out), 0o644); err != nil {
		fatal(err)
	}
	fmt.Printf("✓ wrote %d schemas to packages/openapi/generated/go-schemas.yaml\n", len(schemas))
}

// renderStruct parses `file`, finds `structName`, and returns its schema body
// (the `type/properties/required` lines, indented 6 spaces to sit under
// `components:\n  schemas:\n    <Name>:`).
func renderStruct(file, structName string) (string, error) {
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, file, nil, parser.SkipObjectResolution)
	if err != nil {
		return "", err
	}
	st := findStruct(f, structName)
	if st == nil {
		return "", fmt.Errorf("struct not found")
	}

	var props []string
	var required []string
	for _, field := range st.Fields.List {
		if len(field.Names) == 0 {
			// An EMBEDDED struct promotes its JSON fields into this object, so
			// skipping it silently emits a schema that is missing real
			// properties — and once these schemas are merged into the served
			// spec, that is a published contract that lies. Refuse instead.
			return "", fmt.Errorf(
				"struct %s embeds a type; the generator cannot flatten embedded fields, "+
					"so the emitted schema would be missing properties the API actually returns. "+
					"Either inline the fields or remove this struct from the allow-list",
				structName)
		}
		if field.Tag == nil {
			// EVERY name, not just Names[0]. `lo, Hi string` declares two
			// fields on one line; checking only the first skipped the exported
			// `Hi`, which encoding/json DOES marshal — dropped from a schema
			// that now declares additionalProperties: false.
			exported := ""
			for _, n := range field.Names {
				if n.IsExported() {
					exported = n.Name
					break
				}
			}
			if exported == "" {
				continue
			}
			return "", fmt.Errorf(
				"struct %s has an exported untagged field %s; it is serialised as %q, "+
					"so the emitted schema would omit a property the API returns "+
					"(and the schema is closed, so a real response would fail validation). "+
					"Add a json tag, unexport it, or remove the struct from the allow-list",
				structName, exported, exported)
		}
		name, opt, skip := jsonName(field.Tag.Value)
		if skip {
			continue
		}
		if name == "" {
			name = field.Names[0].Name
		}
		schema, ptr := mapType(field.Type)
		props = append(props, fmt.Sprintf("        %s:\n%s", name, indent(schema, "          ")))
		if !opt && !ptr {
			required = append(required, name)
		}
	}
	sort.Strings(required)

	var b strings.Builder
	b.WriteString("      type: object\n")
	if len(props) > 0 {
		// CLOSED. A permissive schema merged into the served spec makes the
		// contract weaker while the debt counter goes down — the worst of both.
		b.WriteString("      additionalProperties: false\n")
		b.WriteString("      properties:\n")
		for _, p := range props {
			b.WriteString(p)
			b.WriteString("\n")
		}
	}
	if len(required) > 0 {
		b.WriteString("      required:\n")
		for _, r := range required {
			b.WriteString("        - " + r + "\n")
		}
	}
	return strings.TrimRight(b.String(), "\n"), nil
}

// mapType renders a Go field type to an OpenAPI schema fragment (no indent),
// and reports whether it is a pointer (⇒ optional).
func mapType(expr ast.Expr) (schema string, ptr bool) {
	switch t := expr.(type) {
	case *ast.StarExpr:
		s, _ := mapType(t.X)
		return s, true
	case *ast.Ident:
		return scalarOrRef(t.Name), false
	case *ast.SelectorExpr:
		// e.g. time.Time
		if id, ok := t.X.(*ast.Ident); ok && id.Name == "time" && t.Sel.Name == "Time" {
			return "type: string\nformat: date-time", false
		}
		return "type: object", false
	case *ast.ArrayType:
		item, _ := mapType(t.Elt)
		return "type: array\nitems:\n" + indent(item, "  "), false
	case *ast.MapType:
		val, _ := mapType(t.Value)
		return "type: object\nadditionalProperties:\n" + indent(val, "  "), false
	case *ast.InterfaceType:
		return "{}", false // any
	default:
		return "type: object", false
	}
}

func scalarOrRef(name string) string {
	switch name {
	case "string":
		return "type: string"
	case "bool":
		return "type: boolean"
	case "int", "int8", "int16", "int32", "int64",
		"uint", "uint8", "uint16", "uint32", "uint64":
		return "type: integer"
	case "float32", "float64":
		return "type: number"
	case "any":
		return "{}"
	}
	if schema, ok := knownSchemas[name]; ok {
		return "$ref: '#/components/schemas/" + schema + "'"
	}
	return "type: object"
}

// jsonName parses a struct tag literal → (json name, omitempty, skip).
func jsonName(rawTag string) (name string, omitempty, skip bool) {
	tag := reflect.StructTag(strings.Trim(rawTag, "`"))
	j := tag.Get("json")
	if j == "-" {
		return "", false, true
	}
	parts := strings.Split(j, ",")
	name = parts[0]
	for _, p := range parts[1:] {
		if p == "omitempty" {
			omitempty = true
		}
	}
	return name, omitempty, false
}

func assemble(schemas map[string]string) string {
	names := make([]string, 0, len(schemas))
	for n := range schemas {
		names = append(names, n)
	}
	sort.Strings(names)

	var b strings.Builder
	b.WriteString("# GENERATED by scripts/gen-go-schemas.go — do not edit by hand.\n")
	b.WriteString("# OpenAPI schemas generated from Go response structs (the allow-list in\n")
	b.WriteString("# gen-go-schemas.go). Run `pnpm regen:go-schemas` after changing a struct.\n")
	b.WriteString("components:\n  schemas:\n")
	for _, n := range names {
		b.WriteString("    " + n + ":\n")
		b.WriteString(schemas[n])
		b.WriteString("\n")
	}
	return b.String()
}

func findStruct(f *ast.File, name string) *ast.StructType {
	var found *ast.StructType
	ast.Inspect(f, func(n ast.Node) bool {
		ts, ok := n.(*ast.TypeSpec)
		if !ok || ts.Name.Name != name {
			return true
		}
		if st, ok := ts.Type.(*ast.StructType); ok {
			found = st
		}
		return false
	})
	return found
}

func indent(s, pad string) string {
	lines := strings.Split(s, "\n")
	for i, l := range lines {
		lines[i] = pad + l
	}
	return strings.Join(lines, "\n")
}

func findRepoRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "pnpm-workspace.yaml")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("repo root (pnpm-workspace.yaml) not found")
		}
		dir = parent
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "gen-go-schemas:", err)
	os.Exit(1)
}

// mergeIntoSpec splices generated schemas into packages/openapi/openapi.yaml.
//
// Until this existed, generated/go-schemas.yaml was written and read by nothing
// — a schema generator whose output never reached a client, which is the exact
// "scaffolding without wiring" shape this repo keeps finding. `-check` guarded
// a file no consumer had.
//
// A SURGICAL SPLICE rather than a YAML round-trip: openapi.yaml is ~65k lines
// and regenerate.go already string-splices it. Re-serialising the whole
// document to change one component would produce a diff nobody could review,
// and an unreviewable diff on the file that defines the public API is how a
// contract change slips through.
func mergeIntoSpec(repoRoot string, schemas map[string]string, names []string) error {
	specPath := filepath.Join(repoRoot, "packages/openapi/openapi.yaml")
	raw, err := os.ReadFile(specPath)
	if err != nil {
		return err
	}
	body := string(raw)

	// The REGION this tool is allowed to touch.
	//
	// A whole-file search hits the wrong section: `securitySchemes`,
	// `parameters`, `responses` and `headers` all precede `schemas` under
	// `components:` and all have 4-space children. Two names collide TODAY —
	// `ValidationError` (the target of 84 $refs, under components.responses)
	// and `SourcePlatform` (under components.parameters) — so merging either
	// would overwrite a response definition with a bare schema object.
	regionStart, regionEnd, err := schemasRegion(body)
	if err != nil {
		return err
	}

	for _, name := range names {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		gen, ok := schemas[name]
		if !ok {
			return fmt.Errorf("-merge names %q, which is not in the allow-list", name)
		}
		// The trailing blank line is load-bearing, not cosmetic. Without it the
		// spliced block fuses with the next schema's key — the first attempt
		// produced `- to    DeviceGrantKind:` and silently broke four $refs, on
		// the file that defines the public API.
		block := fmt.Sprintf("    %s:\n%s", name, gen)
		block = strings.TrimRight(block, "\n") + "\n\n"
		region := body[regionStart:regionEnd]
		rel := findSchemaBlock(region, name)
		start := -1
		if rel != -1 {
			// rel indexes ("\n"+region), so rel-1 is the offset in region of the
			// byte before the block; the +1 arithmetic below re-adds it.
			start = regionStart + rel - 1
		}
		if start == -1 {
			// New component: insert at the top of the region.
			body = body[:regionStart] + block + body[regionStart:]
			regionEnd += len(block)
			continue
		}
		// Replace the existing block, bounded by the region so a schema that
		// happens to be LAST cannot consume whatever follows it.
		rest := body[start+1 : regionEnd]
		endRel := findNextTopLevelSchema(rest)
		tail := body[start+1+endRel:]
		delta := len(block) - endRel
		body = body[:start+1] + block + tail
		regionEnd += delta
	}

	return os.WriteFile(specPath, []byte(body), 0o644)
}

// findNextTopLevelSchema returns the offset at which the schema starting at
// offset 0 ends.
//
// It stops at any non-blank line indented LESS THAN six spaces — i.e. any
// dedent out of the schema body — not merely at a `    Name:` key.
//
// The earlier version stopped only on a 4-space key ending in `:`, which meant
// `  examples:` (two spaces) was not a stop condition. Merging the LAST schema
// in the block therefore swallowed the `components.examples:` key line and
// re-parented its entries as phantom schemas — and every gate stayed green:
// the YAML still parsed, spectral reported no new errors, sync-json faithfully
// mirrored the corruption, and the contract test passed. Silent destruction of
// the file that defines the public API.
func findNextTopLevelSchema(rest string) int {
	lines := strings.SplitAfter(rest, "\n")
	off := len(lines[0]) // skip the schema's own key line
	for _, line := range lines[1:] {
		trimmed := strings.TrimRight(line, "\n\r")
		if strings.TrimSpace(trimmed) == "" {
			off += len(line)
			continue
		}
		indent := len(trimmed) - len(strings.TrimLeft(trimmed, " "))
		if indent < 6 {
			return off
		}
		off += len(line)
	}
	return off
}

// schemasRegion returns the byte range of `components.schemas`' children.
//
// Bounded by the next key at two-space indent, so a merge can never reach
// `components.examples` or any sibling section.
func schemasRegion(body string) (start, end int, err error) {
	anchor := "\n  schemas:\n"
	at := strings.Index(body, anchor)
	if at == -1 {
		return 0, 0, fmt.Errorf("could not find components.schemas in openapi.yaml")
	}
	start = at + len(anchor)
	rest := body[start:]
	off := 0
	for _, line := range strings.SplitAfter(rest, "\n") {
		trimmed := strings.TrimRight(line, "\n\r")
		if strings.TrimSpace(trimmed) != "" {
			indent := len(trimmed) - len(strings.TrimLeft(trimmed, " "))
			if indent < 4 {
				return start, start + off, nil
			}
		}
		off += len(line)
	}
	return start, len(body), nil
}

// verifyMerged reports whether the spec's copy of each named schema is
// byte-identical to what the Go struct generates now.
//
// Without this, `-check` guarded only generated/go-schemas.yaml — a file no
// client reads. Adding a field to the Go struct failed -check, `pnpm
// regen:go-schemas` made it pass, and the SERVED spec still published a schema
// with `additionalProperties: false` and no such property. The API would then
// return a response its own published contract rejects, with every gate green.
func verifyMerged(repoRoot string, schemas map[string]string, names []string) error {
	specPath := filepath.Join(repoRoot, "packages/openapi/openapi.yaml")
	raw, err := os.ReadFile(specPath)
	if err != nil {
		return err
	}
	body := string(raw)
	start, end, err := schemasRegion(body)
	if err != nil {
		return err
	}
	region := body[start:end]

	for _, name := range names {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		gen, ok := schemas[name]
		if !ok {
			return fmt.Errorf("-merge names %q, which is not in the allow-list", name)
		}
		rel := findSchemaBlock(region, name)
		if rel == -1 {
			return fmt.Errorf(
				"%s is generated but not present in components.schemas of openapi.yaml. "+
					"Run `pnpm regen:go-schemas:merge` — a schema the served spec does not "+
					"carry reaches no client", name)
		}
		rest := region[rel:]
		inSpec := rest[:findNextTopLevelSchema(rest)]
		want := strings.TrimRight(fmt.Sprintf("    %s:\n%s", name, gen), "\n")
		if strings.TrimRight(inSpec, "\n ") != want {
			return fmt.Errorf(
				"%s in openapi.yaml does not match what the Go struct generates. "+
					"The served schema is closed (additionalProperties: false), so a response "+
					"carrying a field the spec omits fails its own published contract. "+
					"Run `pnpm regen:go-schemas:merge` and `sync-json`", name)
		}
	}
	return nil
}

// findSchemaBlock returns the offset within `"\n"+region` of `name`'s block, or
// -1. Searches a newline-prefixed copy because the FIRST schema in the region
// has no preceding newline — a plain `"\n    Name:\n"` search misses exactly
// the block this tool inserts, which made the merge-aware check report a
// present schema as absent.
func findSchemaBlock(region, name string) int {
	return strings.Index("\n"+region, "\n    "+name+":\n")
}
