// SPDX-License-Identifier: AGPL-3.0-only

package privatedb

import (
	"bytes"
	"fmt"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"testing"
)

// testSupportImportPath is the root of every test-support package. A package
// under it creates and drops databases with an administrative role, or does
// something else no shipped code may do.
const testSupportImportPath = "github.com/postwave/postwave/apps/api/internal/testsupport"

// minProductionFiles is a floor on how many files the scan must read, so the
// guard cannot pass by reading nothing after a moved directory or a wrong
// root. apps/api has well over two thousand production Go files.
const minProductionFiles = 1000

// TestProductionCodeDoesNotImportTestSupport enforces the rule in the package
// doc: only _test.go files may import a test-support package. Go has no
// visibility rule for "test files only", so without this test nothing would
// stop shipped code from creating databases through privatedb or linking
// package testing into the server.
//
// Every Go file in apps/api that the go tool would build is read, whatever its
// build constraints, except test files and the test-support packages
// themselves, which may import one another.
func TestProductionCodeDoesNotImportTestSupport(t *testing.T) {
	root := apiModuleRoot(t)
	importers, scanned, err := testSupportImporters(root)
	if err != nil {
		t.Fatalf("scan %s: %v", root, err)
	}
	if !slices.Contains(scanned, "main.go") || len(scanned) < minProductionFiles {
		t.Fatalf("scanned %d production Go files under %s (main.go included: %v), want at least %d including main.go",
			len(scanned), root, slices.Contains(scanned, "main.go"), minProductionFiles)
	}
	for _, importer := range importers {
		t.Errorf("%s: only _test.go files may import test-support packages", importer)
	}
}

// TestTestSupportImportersFindsEveryProductionImporter proves the scan the
// guard relies on against a tree whose answer is known: it must report each
// production file that imports test support, however it spells the import,
// and nothing else.
func TestTestSupportImportersFindsEveryProductionImporter(t *testing.T) {
	root := t.TempDir()
	files := map[string]string{
		// Reported: production files importing test support.
		"main.go":                      "package main\n\nimport \"" + testSupportImportPath + "/privatedb\"\n",
		"internal/a/renamed.go":        "package a\n\nimport (\n\t\"fmt\"\n\tpdb \"" + testSupportImportPath + "/privatedb\"\n)\n",
		"internal/b/blank.go":          "package b\n\nimport _ \"" + testSupportImportPath + "\"\n",
		"internal/c/tagged.go":         "//go:build ignore\n\npackage c\n\nimport \"" + testSupportImportPath + "/other\"\n",
		"internal/d/deeper/leaf.go":    "package leaf\n\nimport \"" + testSupportImportPath + "/privatedb/sub\"\n",
		"internal/testsupportish/x.go": "package testsupportish\n\nimport \"" + testSupportImportPath + "/privatedb\"\n",
		// Not reported.
		"internal/a/a_test.go":                "package a\n\nimport \"" + testSupportImportPath + "/privatedb\"\n",
		"internal/a/clean.go":                 "package a\n\nimport \"" + testSupportImportPath + "ish\"\n",
		"internal/testsupport/other/other.go": "package other\n\nimport \"" + testSupportImportPath + "/privatedb\"\n",
		"internal/testsupport/privatedb/p.go": "package privatedb\n",
		"internal/e/testdata/fixture.go":      "package fixture\n\nimport \"" + testSupportImportPath + "/privatedb\"\n",
		"internal/.hidden/h.go":               "package h\n\nimport \"" + testSupportImportPath + "/privatedb\"\n",
		"internal/_ignored/i.go":              "package i\n\nimport \"" + testSupportImportPath + "/privatedb\"\n",
		"internal/a/notes.txt":                "import \"" + testSupportImportPath + "/privatedb\"\n",
	}
	for name, source := range files {
		path := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(source), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	importers, scanned, err := testSupportImporters(root)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	wantImporters := []string{
		"internal/a/renamed.go: imports " + testSupportImportPath + "/privatedb",
		"internal/b/blank.go: imports " + testSupportImportPath,
		"internal/c/tagged.go: imports " + testSupportImportPath + "/other",
		"internal/d/deeper/leaf.go: imports " + testSupportImportPath + "/privatedb/sub",
		"internal/testsupportish/x.go: imports " + testSupportImportPath + "/privatedb",
		"main.go: imports " + testSupportImportPath + "/privatedb",
	}
	if !slices.Equal(importers, wantImporters) {
		t.Errorf("importers:\n  %s\nwant:\n  %s", strings.Join(importers, "\n  "), strings.Join(wantImporters, "\n  "))
	}
	wantScanned := []string{
		"internal/a/clean.go", "internal/a/renamed.go", "internal/b/blank.go", "internal/c/tagged.go",
		"internal/d/deeper/leaf.go", "internal/testsupportish/x.go", "main.go",
	}
	if !slices.Equal(scanned, wantScanned) {
		t.Errorf("scanned %q, want %q", scanned, wantScanned)
	}

	// A file the scan cannot parse fails it rather than being passed over.
	broken := filepath.Join(root, "internal", "f", "broken.go")
	if err := os.MkdirAll(filepath.Dir(broken), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(broken, []byte("package f\n\nimport (\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := testSupportImporters(root); err == nil || !strings.Contains(err.Error(), "broken.go") {
		t.Errorf("scan of a tree with an unparsable file = %v, want an error naming it", err)
	}
}

// apiModuleRoot returns apps/api, found from this file's path and confirmed
// by its go.mod, so the guard cannot scan the wrong tree and pass.
func apiModuleRoot(t *testing.T) string {
	t.Helper()
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve this file's source path to find apps/api")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(source), "..", "..", ".."))
	goMod, err := os.ReadFile(filepath.Join(root, "go.mod"))
	if err != nil {
		t.Fatalf("read apps/api go.mod: %v", err)
	}
	const module = "module github.com/postwave/postwave/apps/api"
	if first, _, _ := bytes.Cut(goMod, []byte("\n")); strings.TrimSpace(string(first)) != module {
		t.Fatalf("%s/go.mod starts %q, want %q", root, first, module)
	}
	return root
}

// testSupportImporters reads every production Go file under root: every .go
// file that is not a _test.go file, in a directory the go tool would build
// (not testdata, not named with a leading dot or underscore), outside
// internal/testsupport. It returns one line per import of a test-support
// package, and the slash-separated paths it read, both sorted.
func testSupportImporters(root string) (importers, scanned []string, err error) {
	fset := token.NewFileSet()
	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, relErr := filepath.Rel(root, path)
		if relErr != nil {
			return relErr
		}
		rel = filepath.ToSlash(rel)
		name := entry.Name()
		if entry.IsDir() {
			if rel != "." && (name == "testdata" || strings.HasPrefix(name, ".") || strings.HasPrefix(name, "_") ||
				rel == "internal/testsupport") {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			return nil
		}
		file, parseErr := parser.ParseFile(fset, path, nil, parser.ImportsOnly)
		if parseErr != nil {
			return parseErr
		}
		scanned = append(scanned, rel)
		for _, spec := range file.Imports {
			imported, unquoteErr := strconv.Unquote(spec.Path.Value)
			if unquoteErr != nil {
				return fmt.Errorf("%s: unreadable import %s: %w", rel, spec.Path.Value, unquoteErr)
			}
			if imported == testSupportImportPath || strings.HasPrefix(imported, testSupportImportPath+"/") {
				importers = append(importers, rel+": imports "+imported)
			}
		}
		return nil
	})
	slices.Sort(importers)
	slices.Sort(scanned)
	return importers, scanned, err
}
