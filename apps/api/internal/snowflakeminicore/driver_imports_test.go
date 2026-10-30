// SPDX-License-Identifier: AGPL-3.0-only

package snowflakeminicore

import (
	"bytes"
	"errors"
	"fmt"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/snowflakeminicore/snowflakeminicoretest"
)

// driverImportPath is the Snowflake driver. An import of any package below it
// counts as well, so a move to a /v2 path is still seen.
const driverImportPath = "github.com/snowflakedb/gosnowflake"

// importScan is what scanDriverImports found in one module. Paths are
// slash-separated and relative to the module root, and every list is sorted.
type importScan struct {
	// importers are the files that import the driver.
	importers []string
	// unguardedFiles are the non-test files that import the driver without
	// importing the guard.
	unguardedFiles []string
	// unguardedTestDirs are the directories whose test files import the driver
	// while their code does not, and where no file imports the guard.
	unguardedTestDirs []string
	// guardedTestDirs are the directories whose code imports the driver and
	// where a test file imports the guard too.
	guardedTestDirs []string
	// uncheckedDirs are the directories whose code imports the driver and
	// where no test file imports the order check.
	uncheckedDirs []string
}

var (
	// guardImportPath is this package's own import path.
	guardImportPath = reflect.TypeOf(importScan{}).PkgPath()
	// orderCheckImportPath is the import path of snowflakeminicoretest.
	orderCheckImportPath = reflect.TypeOf(snowflakeminicoretest.Connect(nil)).PkgPath()
)

// No binary built from this module links the driver without this package,
// and every package whose code imports the driver checks the order on its own
// test binary. The order checks cover the importers that exist. This test
// catches the next one, which is how internal/zerocopy_triggers ran with the
// loader on after internal/warehouse had been fixed.
func TestEveryDriverImportComesWithTheGuard(t *testing.T) {
	root, modulePath := enclosingModule(t)
	if !strings.HasPrefix(guardImportPath, modulePath+"/") {
		t.Fatalf("this package is %s, which is not in module %s at %s; the scan would read the wrong tree", guardImportPath, modulePath, root)
	}
	scan, err := scanDriverImports(root, guardImportPath, orderCheckImportPath)
	if err != nil {
		t.Fatalf("scan %s: %v", root, err)
	}
	if len(scan.importers) == 0 {
		t.Fatalf("no file in %s imports %s. Either the scan is broken, or the module no longer links the driver and this package can go.", root, driverImportPath)
	}
	for _, file := range scan.unguardedFiles {
		t.Errorf("%s imports %s without %s. Add the blank import next to the driver's; the package doc says why.", file, driverImportPath, guardImportPath)
	}
	for _, dir := range scan.unguardedTestDirs {
		t.Errorf("test files in %s import %s, and no file there imports %s. Add the blank import to one of those test files.", dir, driverImportPath, guardImportPath)
	}
	for _, dir := range scan.guardedTestDirs {
		t.Errorf("a test file in %s imports %s. The code there imports the driver, so the guard must reach the test binary only through the code: remove the import from the test file.", dir, guardImportPath)
	}
	for _, dir := range scan.uncheckedDirs {
		t.Errorf("the code in %s imports %s, and no test file there imports %s. Add a test that calls RequireLoaderOff; internal/warehouse has one.", dir, driverImportPath, orderCheckImportPath)
	}
	t.Logf("files that import the driver: %s", strings.Join(scan.importers, ", "))
}

func TestScanDriverImports(t *testing.T) {
	const (
		guard = "example.test/m/internal/guard"
		check = "example.test/m/internal/guard/guardtest"
	)
	for _, tc := range []struct {
		name                string
		files               map[string]string
		wantImporters       []string
		wantUnguarded       []string
		wantUnguardedDirs   []string
		wantGuardedTestDirs []string
		wantUncheckedDirs   []string
	}{
		{
			name: "code that imports the driver with the guard beside it and an order check",
			files: map[string]string{
				"a/a.go":      goSource("a", guard, driverImportPath),
				"a/a_test.go": goSource("a", check),
			},
			wantImporters: []string{"a/a.go"},
		},
		{
			name: "an order check in an external test package counts",
			files: map[string]string{
				"a/a.go":        goSource("a", guard, driverImportPath),
				"a/a_x_test.go": goSource("a_test", check),
			},
			wantImporters: []string{"a/a.go"},
		},
		{
			name:              "code that imports the driver with the guard and no order check",
			files:             map[string]string{"a/a.go": goSource("a", guard, driverImportPath)},
			wantImporters:     []string{"a/a.go"},
			wantUncheckedDirs: []string{"a"},
		},
		{
			name: "an order check imported by code does not count",
			files: map[string]string{
				"a/a.go": goSource("a", guard, driverImportPath, check),
			},
			wantImporters:     []string{"a/a.go"},
			wantUncheckedDirs: []string{"a"},
		},
		{
			name: "code that imports the driver alone",
			files: map[string]string{
				"a/a.go":      goSource("a", driverImportPath),
				"a/a_test.go": goSource("a", check),
			},
			wantImporters: []string{"a/a.go"},
			wantUnguarded: []string{"a/a.go"},
		},
		{
			name: "the guard in a sibling file does not count",
			files: map[string]string{
				"a/a.go":      goSource("a", driverImportPath),
				"a/b.go":      goSource("a", guard),
				"a/a_test.go": goSource("a", check),
			},
			wantImporters: []string{"a/a.go"},
			wantUnguarded: []string{"a/a.go"},
		},
		{
			name: "the guard in a test file does not count for code, and is not allowed there",
			files: map[string]string{
				"a/a.go":      goSource("a", driverImportPath),
				"a/a_test.go": goSource("a", guard, check),
			},
			wantImporters:       []string{"a/a.go"},
			wantUnguarded:       []string{"a/a.go"},
			wantGuardedTestDirs: []string{"a"},
		},
		{
			name: "a test file of a guarded package must not import the guard",
			files: map[string]string{
				"a/a.go":        goSource("a", guard, driverImportPath),
				"a/a_test.go":   goSource("a", check),
				"a/a_x_test.go": goSource("a_test", guard),
			},
			wantImporters:       []string{"a/a.go"},
			wantGuardedTestDirs: []string{"a"},
		},
		{
			name: "the tests of a guarded package may import the driver",
			files: map[string]string{
				"a/a.go":      goSource("a", guard, driverImportPath),
				"a/a_test.go": goSource("a", driverImportPath, check),
			},
			wantImporters: []string{"a/a.go", "a/a_test.go"},
		},
		{
			name: "tests alone import the driver and nothing imports the guard",
			files: map[string]string{
				"a/a.go":      goSource("a"),
				"a/a_test.go": goSource("a", driverImportPath),
				"a/x_test.go": goSource("a_test", driverImportPath),
			},
			wantImporters:     []string{"a/a_test.go", "a/x_test.go"},
			wantUnguardedDirs: []string{"a"},
		},
		{
			name: "tests alone import the driver and one test imports the guard",
			files: map[string]string{
				"a/a_test.go": goSource("a", driverImportPath),
				"a/b_test.go": goSource("a", guard),
			},
			wantImporters: []string{"a/a_test.go"},
		},
		{
			name: "named imports and packages below the driver count, look-alikes do not",
			files: map[string]string{
				"a/a.go": "package a\n\nimport sf \"" + driverImportPath + "\"\n\nvar _ = sf.DSN\n",
				"b/b.go": goSource("b", driverImportPath+"/v2"),
				"c/c.go": goSource("c", driverImportPath+"x"),
			},
			wantImporters:     []string{"a/a.go", "b/b.go"},
			wantUnguarded:     []string{"a/a.go", "b/b.go"},
			wantUncheckedDirs: []string{"a", "b"},
		},
		{
			name: "a mention in a comment or a string is not an import",
			files: map[string]string{
				"a/a.go": "package a\n\n// Uses " + driverImportPath + ".\nconst driver = \"" + driverImportPath + "\"\n",
			},
		},
		{
			name: "directories and files the go tool ignores, and nested modules, are not read",
			files: map[string]string{
				"testdata/a.go":      goSource("a", driverImportPath),
				"a/testdata/a.go":    goSource("a", driverImportPath),
				"vendor/v/v.go":      goSource("v", driverImportPath),
				".hidden/h.go":       goSource("h", driverImportPath),
				"_old/o.go":          goSource("o", driverImportPath),
				"a/_draft.go":        goSource("a", driverImportPath),
				"nested/go.mod":      "module example.test/nested\n",
				"nested/n/n.go":      goSource("n", driverImportPath),
				"a/notes.txt":        "import \"" + driverImportPath + "\"\n",
				"a/unrelated.go":     goSource("a", "fmt"),
				"a/driverless.go":    goSource("a", guard),
				"a/a_unused_test.go": goSource("a", "testing"),
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			scan, err := scanDriverImports(writeModule(t, tc.files), guard, check)
			if err != nil {
				t.Fatalf("scanDriverImports: %v", err)
			}
			for _, list := range []struct {
				name      string
				got, want []string
			}{
				{"importers", scan.importers, tc.wantImporters},
				{"unguarded files", scan.unguardedFiles, tc.wantUnguarded},
				{"unguarded test directories", scan.unguardedTestDirs, tc.wantUnguardedDirs},
				{"directories whose tests import the guard", scan.guardedTestDirs, tc.wantGuardedTestDirs},
				{"directories without an order check", scan.uncheckedDirs, tc.wantUncheckedDirs},
			} {
				if !slices.Equal(list.got, list.want) {
					t.Errorf("%s = %q, want %q", list.name, list.got, list.want)
				}
			}
		})
	}
}

// A file the scan cannot read as Go fails the scan instead of being skipped.
// Skipping it could hide an unguarded import.
func TestScanDriverImportsFailsOnAFileItCannotParse(t *testing.T) {
	root := writeModule(t, map[string]string{"a/a.go": "package a\n\nimport (\n\t\"" + driverImportPath + "\"\n"})
	if _, err := scanDriverImports(root, "example.test/m/internal/guard", "example.test/m/internal/guard/guardtest"); err == nil {
		t.Fatal("scanDriverImports accepted a file whose import list does not parse")
	}
}

// scanDriverImports reads every Go file of the module rooted at root, the way
// the go tool sees the module: it skips testdata and vendor directories,
// directories and files whose names start with "." or "_", and nested
// modules. Build constraints are ignored, so a file counts on every platform.
// guard and check are the import paths of the guard and of the order check.
func scanDriverImports(root, guard, check string) (importScan, error) {
	type packageDir struct {
		codeImportsDriver, testImportsDriver bool
		codeImportsGuard, testImportsGuard   bool
		testImportsCheck                     bool
	}
	var scan importScan
	dirs := map[string]*packageDir{}
	needles := [][]byte{[]byte(driverImportPath), []byte(guard), []byte(check)}

	walkErr := filepath.WalkDir(root, func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		base := entry.Name()
		if entry.IsDir() {
			if name == root {
				return nil
			}
			if base == "testdata" || base == "vendor" || strings.HasPrefix(base, ".") || strings.HasPrefix(base, "_") {
				return filepath.SkipDir
			}
			if _, statErr := os.Stat(filepath.Join(name, "go.mod")); statErr == nil {
				return filepath.SkipDir
			} else if !errors.Is(statErr, fs.ErrNotExist) {
				return statErr
			}
			return nil
		}
		if !entry.Type().IsRegular() || !strings.HasSuffix(base, ".go") || strings.HasPrefix(base, ".") || strings.HasPrefix(base, "_") {
			return nil
		}
		src, err := os.ReadFile(name)
		if err != nil {
			return err
		}
		// An import names its path in a string literal, so a file with none
		// of the paths in it imports none of them. That spares parsing it.
		if !slices.ContainsFunc(needles, func(needle []byte) bool { return bytes.Contains(src, needle) }) {
			return nil
		}
		file, err := parser.ParseFile(token.NewFileSet(), name, src, parser.ImportsOnly)
		if err != nil {
			return err
		}
		importsDriver, importsGuard, importsCheck := false, false, false
		for _, spec := range file.Imports {
			importPath, unquoteErr := strconv.Unquote(spec.Path.Value)
			if unquoteErr != nil {
				return fmt.Errorf("%s: import %s: %w", name, spec.Path.Value, unquoteErr)
			}
			switch {
			case importPath == driverImportPath || strings.HasPrefix(importPath, driverImportPath+"/"):
				importsDriver = true
			case importPath == guard:
				importsGuard = true
			case importPath == check:
				importsCheck = true
			}
		}
		rel, err := filepath.Rel(root, name)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		dir := dirs[path.Dir(rel)]
		if dir == nil {
			dir = &packageDir{}
			dirs[path.Dir(rel)] = dir
		}
		if importsDriver {
			scan.importers = append(scan.importers, rel)
		}
		if strings.HasSuffix(base, "_test.go") {
			dir.testImportsDriver = dir.testImportsDriver || importsDriver
			dir.testImportsGuard = dir.testImportsGuard || importsGuard
			dir.testImportsCheck = dir.testImportsCheck || importsCheck
			return nil
		}
		dir.codeImportsDriver = dir.codeImportsDriver || importsDriver
		dir.codeImportsGuard = dir.codeImportsGuard || importsGuard
		if importsDriver && !importsGuard {
			scan.unguardedFiles = append(scan.unguardedFiles, rel)
		}
		return nil
	})
	if walkErr != nil {
		return importScan{}, walkErr
	}
	for name, dir := range dirs {
		switch {
		case dir.codeImportsDriver:
			if dir.testImportsGuard {
				scan.guardedTestDirs = append(scan.guardedTestDirs, name)
			}
			if !dir.testImportsCheck {
				scan.uncheckedDirs = append(scan.uncheckedDirs, name)
			}
		case dir.testImportsDriver && !dir.codeImportsGuard && !dir.testImportsGuard:
			scan.unguardedTestDirs = append(scan.unguardedTestDirs, name)
		}
	}
	slices.Sort(scan.importers)
	slices.Sort(scan.unguardedFiles)
	slices.Sort(scan.unguardedTestDirs)
	slices.Sort(scan.guardedTestDirs)
	slices.Sort(scan.uncheckedDirs)
	return scan, nil
}

// enclosingModule finds the go.mod at or above the working directory, which
// go test sets to this package's directory, and returns its directory and
// module path.
func enclosingModule(t *testing.T) (root, modulePath string) {
	t.Helper()
	start, err := os.Getwd()
	if err != nil {
		t.Fatalf("working directory: %v", err)
	}
	for dir := start; ; dir = filepath.Dir(dir) {
		goMod := filepath.Join(dir, "go.mod")
		data, readErr := os.ReadFile(goMod)
		if readErr == nil {
			for _, line := range strings.Split(string(data), "\n") {
				fields := strings.Fields(line)
				if len(fields) == 2 && fields[0] == "module" {
					if unquoted, unquoteErr := strconv.Unquote(fields[1]); unquoteErr == nil {
						return dir, unquoted
					}
					return dir, fields[1]
				}
			}
			t.Fatalf("%s has no module line", goMod)
		}
		if !errors.Is(readErr, fs.ErrNotExist) {
			t.Fatalf("read %s: %v", goMod, readErr)
		}
		if filepath.Dir(dir) == dir {
			t.Fatalf("no go.mod at or above %s", start)
		}
	}
}

// writeModule writes files, keyed by slash-separated path, into a new module
// and returns its root.
func writeModule(t *testing.T, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "go.mod"), []byte("module example.test/m\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for name, content := range files {
		file := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

// goSource is a Go file in package pkg with a blank import of each path.
func goSource(pkg string, imports ...string) string {
	var b strings.Builder
	b.WriteString("package " + pkg + "\n")
	if len(imports) > 0 {
		b.WriteString("\nimport (\n")
		for _, importPath := range imports {
			b.WriteString("\t_ " + strconv.Quote(importPath) + "\n")
		}
		b.WriteString(")\n")
	}
	return b.String()
}
