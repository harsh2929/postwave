// SPDX-License-Identifier: AGPL-3.0-only

package inbound_webhooks

import (
	"bytes"
	"errors"
	"fmt"
	"go/ast"
	"go/build"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// The API composition root is package main in apps/api: run() in main.go and
// everything it reaches in the package's other files. Until e8d23a62d it was
// main.go alone, and the source contracts that read it were written against
// that one file. That commit moved sixty-nine blocks of run() into sibling
// files, each called from run() where the block used to be, and older siblings
// (composition_adapters.go, cdc_wiring.go, ops_console_wiring.go and others)
// already carried wiring of their own. A contract that reads main.go alone sees
// only part of what it polices: an absence assertion passes while the
// forbidden construction sits in a sibling, and an exact count misses a copy
// there.
//
// Contracts therefore read the composition root through readAPICompositionRoot:
//
//   - main is main.go, for presence, ordering and position assertions on
//     markers that never left it. Positions are offsets into main.
//   - run is the declaration of run() inside main.go. An exact count whose
//     marker lives in run() is asserted on run, and asserted again with the
//     same count on all: the marker can neither leave run() nor gain a copy
//     anywhere else in the package.
//   - all is every composition-root file, concatenated, for absence assertions
//     and for that second half of every exact count. Never index into it to
//     compare positions: concatenation order is not execution order.
//   - function returns one top-level function of the package other than run
//     and main, so a marker that moved into a helper is asserted in the helper
//     that now holds it.
//   - withCalledFunctions returns a region of run() plus every such function
//     the region calls, transitively, for region assertions whose statements
//     moved into a helper.
//
// Membership is derived from the package, never listed. Every file the go tool
// can compile into package main belongs: a .go file that is not a test and
// whose name does not start with "_" or ".". Build constraints are not
// evaluated, so a file compiled on any platform counts. This is the rule
// packages/openapi/scripts/regenerate.go (isCompositionSourceName) applies to
// the same package. apiCompositionRootExclusions may remove reviewed files, but
// never one that wires routes or starts workers. A wiring file added tomorrow,
// whatever its name, is inside every contract the moment it exists.
//
// This file is byte-identical, apart from its package clause, in every package
// that reads the composition root as source text: apps/api and
// apps/api/internal/{conversions,inbound_webhooks,server,workers}. A test helper
// cannot be shared across packages without a non-test package, so the copies
// are kept identical instead: TestAPICompositionRootHelperCopiesAreIdentical
// fails when one drifts. Change them together.

// apiCompositionRootExclusions maps a file of package main to the reviewed
// reason it is left out of the composition root. An excluded file must not
// register routes or start workers (see compositionWiring): an exclusion can
// keep a file's text out of the source contracts, never its wiring. Reviewed
// 2026-09-13: all 35 non-test files of the package are composition source (run()
// and the adapters, middleware stacks, configuration helpers and wiring
// functions it builds the process from), so none is excluded.
var apiCompositionRootExclusions = map[string]string{}

const (
	apiModulePath                = "github.com/postwave/postwave/apps/api"
	apiCompositionRootHelperFile = "composition_root_source_test.go"
)

// apiCompositionRootSource is the API composition root read as source text.
type apiCompositionRootSource struct {
	// names lists the composition-root files, sorted, relative to apps/api.
	names []string
	// main is apps/api/main.go.
	main string
	// run is the declaration of run() in main.go, a substring of main.
	run string
	// all is every composition-root file, concatenated in name order.
	all string
	// functions maps each top-level function of the composition root other
	// than run and main to its declaration source.
	functions map[string]string
}

var (
	apiCompositionRootOnce   sync.Once
	apiCompositionRootCached apiCompositionRootSource
	apiCompositionRootErr    error
)

// readAPICompositionRoot returns the composition root, read and validated once
// per test binary. Every caller fails when the root is misdefined: a file
// outside package main, a stale or wiring exclusion, or a compiled file the
// derivation missed.
func readAPICompositionRoot(t *testing.T) apiCompositionRootSource {
	t.Helper()
	apiCompositionRootOnce.Do(func() {
		apiCompositionRootCached, apiCompositionRootErr = loadAPICompositionRoot()
	})
	if apiCompositionRootErr != nil {
		t.Fatal(apiCompositionRootErr)
	}
	return apiCompositionRootCached
}

// isAPICompositionSourceName reports whether a directory entry name is compiled
// into its package: a .go file that is not a test and that the go tool does not
// ignore by name.
func isAPICompositionSourceName(name string) bool {
	return strings.HasSuffix(name, ".go") &&
		!strings.HasSuffix(name, "_test.go") &&
		!strings.HasPrefix(name, "_") &&
		!strings.HasPrefix(name, ".")
}

func loadAPICompositionRoot() (apiCompositionRootSource, error) {
	root := apiCompositionRootSource{functions: map[string]string{}}
	apiRoot, err := findAPIModuleRoot()
	if err != nil {
		return root, err
	}
	entries, err := os.ReadDir(apiRoot)
	if err != nil {
		return root, fmt.Errorf("read apps/api: %w", err)
	}
	fileSet := token.NewFileSet()
	var all strings.Builder
	excluded := map[string]bool{}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !isAPICompositionSourceName(name) {
			continue
		}
		raw, readErr := os.ReadFile(filepath.Join(apiRoot, name))
		if readErr != nil {
			return root, fmt.Errorf("read apps/api/%s: %w", name, readErr)
		}
		file, parseErr := parser.ParseFile(fileSet, name, raw, parser.SkipObjectResolution)
		if parseErr != nil {
			return root, fmt.Errorf("parse apps/api/%s: %w", name, parseErr)
		}
		if reason, ok := apiCompositionRootExclusions[name]; ok {
			excluded[name] = true
			if strings.TrimSpace(reason) == "" {
				return root, fmt.Errorf("apps/api/%s is excluded from the composition root without a reason", name)
			}
			if wiring := compositionWiring(fileSet, file); wiring != "" {
				return root, fmt.Errorf("apps/api/%s is excluded from the composition root but has %s; an "+
					"exclusion may keep a file's text out of the source contracts, never its wiring, so remove "+
					"it from apiCompositionRootExclusions", name, wiring)
			}
			continue
		}
		if file.Name.Name != "main" {
			return root, fmt.Errorf("apps/api/%s declares package %s; a non-test source file there is "+
				"either composition source of package main or excluded with a reviewed reason in "+
				"apiCompositionRootExclusions", name, file.Name.Name)
		}
		source := string(raw)
		root.names = append(root.names, name)
		all.WriteString(source)
		all.WriteString("\n")
		if name == "main.go" {
			root.main = source
		}
		for _, declaration := range file.Decls {
			function, isFunction := declaration.(*ast.FuncDecl)
			if !isFunction || function.Recv != nil {
				continue
			}
			start := fileSet.Position(function.Pos()).Offset
			end := fileSet.Position(function.End()).Offset
			switch function.Name.Name {
			case "run":
				if name != "main.go" {
					return root, fmt.Errorf("apps/api/%s declares run(); the composition root's run() is "+
						"main.go's", name)
				}
				root.run = source[start:end]
			case "main", "init", "_":
			default:
				root.functions[function.Name.Name] = source[start:end]
			}
		}
	}
	root.all = all.String()
	for name := range apiCompositionRootExclusions {
		if !excluded[name] {
			return root, fmt.Errorf("apiCompositionRootExclusions names apps/api/%s, which is not a "+
				"non-test source file of the package; remove the stale entry", name)
		}
	}
	if root.main == "" {
		return root, errors.New("apps/api/main.go is missing from the composition root")
	}
	if root.run == "" {
		return root, errors.New("apps/api/main.go no longer declares run(), the composition root's entry point")
	}
	// Cross-check the name rule against the go tool's own view of the package:
	// a file it compiles into package main that the loop above did not read
	// would sit outside every contract.
	compiled, err := build.ImportDir(apiRoot, 0)
	if err != nil {
		return root, fmt.Errorf("go/build apps/api: %w", err)
	}
	if compiled.Name != "main" {
		return root, fmt.Errorf("go/build reports apps/api as package %s, want main", compiled.Name)
	}
	read := make(map[string]bool, len(root.names))
	for _, name := range root.names {
		read[name] = true
	}
	for _, name := range append(append([]string(nil), compiled.GoFiles...), compiled.CgoFiles...) {
		if !read[name] && !excluded[name] {
			return root, fmt.Errorf("apps/api/%s is compiled into package main but is outside the "+
				"composition root", name)
		}
	}
	return root, nil
}

// findAPIModuleRoot returns the apps/api module directory: the nearest go.mod
// at or above the test's working directory, which must be the API module.
func findAPIModuleRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	modulePattern := regexp.MustCompile(`(?m)^module\s+(\S+)\s*$`)
	for {
		raw, readErr := os.ReadFile(filepath.Join(dir, "go.mod"))
		if readErr == nil {
			match := modulePattern.FindSubmatch(raw)
			if match == nil || string(match[1]) != apiModulePath {
				return "", fmt.Errorf("the nearest go.mod above the test, in %s, is not module %s", dir, apiModulePath)
			}
			return dir, nil
		}
		if !errors.Is(readErr, fs.ErrNotExist) {
			return "", readErr
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("no go.mod for %s above the test's working directory", apiModulePath)
		}
		dir = parent
	}
}

// compositionWiring describes the first route registration or worker start in
// file, or returns "" when it has none. It reads syntax only, so it is a screen
// behind review, not a proof: it cannot see a route whose path is computed at
// run time or named by a constant declared in another file, nor wiring reached
// through a method of some other name. Where the syntax is ambiguous it
// reports, since a false report only keeps a file inside the composition root,
// which is the safe direction. Wiring is any of:
//
//   - an import of the chi router;
//   - a go statement, or a function or method named Go (safego.Go, errgroup's
//     Go) or AfterFunc (time.AfterFunc), called or taken as a value;
//   - a function or method whose name starts with Start or start
//     (apiworkers.Start…, startOutboxDrainWorkers) or with Mount or mount (a
//     route mount), called or taken as a value;
//   - a function or method that serves HTTP, ListenAndServe…, Serve or
//     ServeTLS, called or taken as a value (run := srv.ListenAndServe);
//   - a method named Group, Use, With, Route, NotFound or MethodNotAllowed,
//     called or taken as a value;
//   - a call of a method named after a chi registration (Get, Post, Handle,
//     Method, …) with a "/"-prefixed path among its first two arguments: a
//     string literal, or a name the file binds to one (a const, a var, or :=).
func compositionWiring(fileSet *token.FileSet, file *ast.File) string {
	for _, spec := range file.Imports {
		if path, err := strconv.Unquote(spec.Path.Value); err == nil && strings.Contains(path, "/go-chi/chi") {
			return fmt.Sprintf("an import of %s (line %d)", path, fileSet.Position(spec.Pos()).Line)
		}
	}
	routerMethods := map[string]bool{
		"Group": true, "Use": true, "With": true, "Route": true, "NotFound": true, "MethodNotAllowed": true,
	}
	routeVerbs := map[string]bool{
		"Connect": true, "Delete": true, "Get": true, "Handle": true, "HandleFunc": true, "Head": true,
		"Method": true, "MethodFunc": true, "Options": true, "Patch": true, "Post": true, "Put": true,
		"Trace": true,
	}
	// Every name the file binds to a "/"-prefixed string literal, in any scope.
	// Scopes are not told apart: a name bound to a path anywhere counts
	// everywhere, which errs toward reporting.
	paths := map[string]string{}
	bindPath := func(name *ast.Ident, value ast.Expr) {
		literal, isLiteral := value.(*ast.BasicLit)
		if !isLiteral || literal.Kind != token.STRING {
			return
		}
		if text, err := strconv.Unquote(literal.Value); err == nil && strings.HasPrefix(text, "/") {
			paths[name.Name] = text
		}
	}
	ast.Inspect(file, func(node ast.Node) bool {
		switch binding := node.(type) {
		case *ast.ValueSpec:
			for index, name := range binding.Names {
				if index < len(binding.Values) {
					bindPath(name, binding.Values[index])
				}
			}
		case *ast.AssignStmt:
			if len(binding.Lhs) == len(binding.Rhs) {
				for index, target := range binding.Lhs {
					if name, isName := target.(*ast.Ident); isName {
						bindPath(name, binding.Rhs[index])
					}
				}
			}
		}
		return true
	})
	// wiringName describes a function or method name that wires whether it is
	// called or taken as a value, or returns "".
	wiringName := func(name string, isMethod bool) string {
		switch {
		case name == "Go" || name == "AfterFunc":
			return "a goroutine launch " + name
		case strings.HasPrefix(name, "Start") || strings.HasPrefix(name, "start"):
			return "a worker start " + name
		case strings.HasPrefix(name, "Mount") || strings.HasPrefix(name, "mount"):
			return "a route mount " + name
		case strings.HasPrefix(name, "ListenAndServe") || name == "Serve" || name == "ServeTLS":
			return "an HTTP server start " + name
		case isMethod && routerMethods[name]:
			return "router wiring " + name
		}
		return ""
	}
	// called holds each selector that is the function of a call. ast.Inspect
	// visits a call before its function, so the selector is recorded first.
	called := map[*ast.SelectorExpr]bool{}
	var found string
	ast.Inspect(file, func(node ast.Node) bool {
		if found != "" {
			return false
		}
		line := func() int { return fileSet.Position(node.Pos()).Line }
		if _, ok := node.(*ast.GoStmt); ok {
			found = fmt.Sprintf("a go statement (line %d)", line())
			return false
		}
		// A method or package function taken as a value, not called.
		if selector, ok := node.(*ast.SelectorExpr); ok {
			if !called[selector] {
				if what := wiringName(selector.Sel.Name, true); what != "" {
					found = fmt.Sprintf("%s taken as a value (line %d)", what, line())
				}
			}
			return found == ""
		}
		call, ok := node.(*ast.CallExpr)
		if !ok {
			return true
		}
		var name string
		isMethod := false
		switch function := call.Fun.(type) {
		case *ast.Ident:
			name = function.Name
		case *ast.SelectorExpr:
			name = function.Sel.Name
			isMethod = true
			called[function] = true
		default:
			return true
		}
		if what := wiringName(name, isMethod); what != "" {
			found = fmt.Sprintf("%s (line %d)", what, line())
			return false
		}
		if isMethod && routeVerbs[name] {
			for index, argument := range call.Args {
				if index == 2 {
					break
				}
				path := ""
				switch value := argument.(type) {
				case *ast.BasicLit:
					if text, err := strconv.Unquote(value.Value); err == nil && value.Kind == token.STRING &&
						strings.HasPrefix(text, "/") {
						path = text
					}
				case *ast.Ident:
					path = paths[value.Name]
				}
				if path != "" {
					found = fmt.Sprintf("a route registration %s %q (line %d)", name, path, line())
					break
				}
			}
		}
		return found == ""
	})
	return found
}

// function returns the declaration source of a top-level function of the
// composition root other than run and main.
func (root apiCompositionRootSource) function(t *testing.T, name string) string {
	t.Helper()
	source, ok := root.functions[name]
	if !ok {
		t.Fatalf("the API composition root declares no function %s besides run and main", name)
	}
	return source
}

// withCalledFunctions returns block followed by the declaration of every
// top-level function other than run and main that block calls, transitively.
// A region of run() whose statements moved into a helper keeps its assertions
// only if the helper's body is read as part of the region.
func (root apiCompositionRootSource) withCalledFunctions(block string) string {
	names := make([]string, 0, len(root.functions))
	for name := range root.functions {
		names = append(names, name)
	}
	sort.Strings(names)
	var expanded strings.Builder
	expanded.WriteString(block)
	included := map[string]bool{}
	pending := []string{block}
	for len(pending) > 0 {
		text := pending[0]
		pending = pending[1:]
		for _, name := range names {
			if included[name] {
				continue
			}
			call := regexp.MustCompile(`(^|[^A-Za-z0-9_.])` + regexp.QuoteMeta(name) + `\(`)
			if !call.MatchString(text) {
				continue
			}
			included[name] = true
			expanded.WriteString("\n")
			expanded.WriteString(root.functions[name])
			pending = append(pending, root.functions[name])
		}
	}
	return expanded.String()
}

// TestAPICompositionRootHelperCopiesAreIdentical keeps every copy of this file
// byte-identical apart from its package clause.
func TestAPICompositionRootHelperCopiesAreIdentical(t *testing.T) {
	t.Parallel()
	apiRoot, err := findAPIModuleRoot()
	if err != nil {
		t.Fatal(err)
	}
	ownPath, err := filepath.Abs(apiCompositionRootHelperFile)
	if err != nil {
		t.Fatal(err)
	}
	packageClause := regexp.MustCompile(`(?m)^package [A-Za-z_][A-Za-z0-9_]*$`)
	normalized := func(path string) []byte {
		raw, readErr := os.ReadFile(path)
		if readErr != nil {
			t.Fatalf("read %s: %v", path, readErr)
		}
		if clauses := packageClause.FindAllIndex(raw, -1); len(clauses) != 1 {
			t.Fatalf("%s has %d package clauses, want 1", path, len(clauses))
		}
		return packageClause.ReplaceAll(raw, []byte("package _"))
	}
	own := normalized(ownPath)
	var copies []string
	walkErr := filepath.WalkDir(apiRoot, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			if path != apiRoot && (strings.HasPrefix(entry.Name(), ".") || strings.HasPrefix(entry.Name(), "_") ||
				entry.Name() == "testdata" || entry.Name() == "node_modules") {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.Name() == apiCompositionRootHelperFile {
			copies = append(copies, path)
		}
		return nil
	})
	if walkErr != nil {
		t.Fatalf("walk apps/api: %v", walkErr)
	}
	foundOwn := false
	for _, path := range copies {
		if absolute, absErr := filepath.Abs(path); absErr == nil && absolute == ownPath {
			foundOwn = true
			continue
		}
		other := normalized(path)
		if bytes.Equal(own, other) {
			continue
		}
		ownLines, otherLines := strings.Split(string(own), "\n"), strings.Split(string(other), "\n")
		line := 0
		for line < len(ownLines) && line < len(otherLines) && ownLines[line] == otherLines[line] {
			line++
		}
		t.Errorf("%s differs from %s from line %d; every copy of %s must be byte-identical apart from "+
			"its package clause, so change them together", path, ownPath, line+1, apiCompositionRootHelperFile)
	}
	if !foundOwn {
		t.Fatalf("walking %s did not find this package's own %s; the drift check would be vacuous",
			apiRoot, apiCompositionRootHelperFile)
	}
	if len(copies) < 2 {
		t.Fatalf("found %d copies of %s under %s; the drift check would be vacuous", len(copies),
			apiCompositionRootHelperFile, apiRoot)
	}
}

// TestAPICompositionRootIsTheWholePackage checks the derivation against the go
// tool's independent view of the package: every non-test file it lists for
// package main, on this platform or any other, minus the reviewed exclusions.
func TestAPICompositionRootIsTheWholePackage(t *testing.T) {
	t.Parallel()
	root := readAPICompositionRoot(t)
	apiRoot, err := findAPIModuleRoot()
	if err != nil {
		t.Fatal(err)
	}
	compiled, err := build.ImportDir(apiRoot, 0)
	if err != nil {
		t.Fatal(err)
	}
	var want []string
	for _, name := range append(append(append([]string(nil), compiled.GoFiles...), compiled.CgoFiles...),
		compiled.IgnoredGoFiles...) {
		if _, isExcluded := apiCompositionRootExclusions[name]; !isExcluded && !strings.HasSuffix(name, "_test.go") {
			want = append(want, name)
		}
	}
	sort.Strings(want)
	if strings.Join(root.names, "\n") != strings.Join(want, "\n") {
		t.Fatalf("composition root files = %v, want every non-test file go/build lists for apps/api: %v",
			root.names, want)
	}
	if len(root.names) < 2 {
		t.Fatalf("composition root files = %v; main.go alone is the reading this helper replaced", root.names)
	}
	if !strings.HasPrefix(root.run, "func run() error {") || !strings.HasSuffix(root.run, "}") ||
		!strings.Contains(root.main, root.run) {
		t.Fatalf("run is not main.go's declaration of run(): %.80q", root.run)
	}
}

// TestCompositionWiringRecognisesRoutesAndWorkers pins what an exclusion may
// not contain.
func TestCompositionWiringRecognisesRoutesAndWorkers(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name, body string
		wiring     bool
	}{
		{name: "go statement", body: "func f() { go g() }", wiring: true},
		{name: "safego launch", body: `func f() { safego.Go(logger, "worker", g) }`, wiring: true},
		{name: "worker start", body: "func f() { apiworkers.StartOutboundWebhookWorkers(ctx) }", wiring: true},
		{name: "local worker start", body: "func f() { startOutboxDrainWorkers(logger) }", wiring: true},
		{name: "route mount", body: "func f() { deps.MountRoutes(r) }", wiring: true},
		{name: "route registration", body: `func f() { r.Get("/api/v1/x", h) }`, wiring: true},
		{name: "method registration", body: `func f() { r.Method("GET", "/api/v1/x", h) }`, wiring: true},
		{name: "middleware", body: "func f() { r.Use(mw) }", wiring: true},
		{name: "server start", body: "func f() { _ = srv.ListenAndServe() }", wiring: true},
		{name: "router import", body: "import \"github.com/go-chi/chi/v5\"\nvar _ chi.Router", wiring: true},
		// Wiring that a call-only, literal-only reading missed: a path named by
		// a constant, through a router interface with no chi import; a worker
		// started by a timer; a server start taken as a method value.
		{name: "route path constant", body: "const inboundPath = \"/api/public/x\"\n" +
			"type router interface{ Get(string, any) }\nfunc f(r router) { r.Get(inboundPath, nil) }", wiring: true},
		{name: "route path variable", body: `func f() { path := "/api/v1/x"; r.Post(path, h) }`, wiring: true},
		{name: "timer worker start", body: "func f() { time.AfterFunc(0, worker) }", wiring: true},
		{name: "server start method value", body: "func f() error { run := srv.ListenAndServe; return run() }",
			wiring: true},
		{name: "middleware method value", body: "func f() { use := r.Use; use(mw) }", wiring: true},
		{name: "environment read", body: `func f() string { return os.Getenv("X") }`},
		{name: "client call", body: `func f() { client.Get("https://example.com/x") }`},
		{name: "cache read", body: "func f() { cache.Get(key) }"},
		{name: "cache key constant", body: "const key = \"user:1\"\nfunc f() { cache.Get(key) }"},
		{name: "field read", body: "func f() int { return cfg.Port }"},
		{name: "handler call", body: "func f() { next.ServeHTTP(w, r) }"},
		{name: "adapter", body: "func f(x int) int { return x + 1 }"},
	} {
		fileSet := token.NewFileSet()
		file, err := parser.ParseFile(fileSet, "fixture.go", "package main\n"+test.body+"\n", parser.SkipObjectResolution)
		if err != nil {
			t.Fatalf("%s: parse fixture: %v", test.name, err)
		}
		if got := compositionWiring(fileSet, file); (got != "") != test.wiring {
			t.Errorf("%s: compositionWiring = %q, want wiring=%v", test.name, got, test.wiring)
		}
	}
}

// TestAPICompositionRootExpandsCalledFunctions pins the helper's expansion:
// transitive, by call rather than by mention, and never through a selector.
func TestAPICompositionRootExpandsCalledFunctions(t *testing.T) {
	t.Parallel()
	root := apiCompositionRootSource{functions: map[string]string{
		"outer":    "func outer() { inner() }",
		"inner":    "func inner() { leaf(1) }",
		"leaf":     "func leaf(int) {}",
		"selected": "func selected() {}",
		"unused":   "func unused() {}",
	}}
	got := root.withCalledFunctions("outer()\nvalue.selected()\n// unused")
	for _, name := range []string{"outer", "inner", "leaf"} {
		if !strings.Contains(got, root.function(t, name)) {
			t.Errorf("expansion is missing %s:\n%s", name, got)
		}
	}
	for _, name := range []string{"selected", "unused"} {
		if strings.Contains(got, root.function(t, name)) {
			t.Errorf("expansion includes %s, which the block does not call:\n%s", name, got)
		}
	}
}
