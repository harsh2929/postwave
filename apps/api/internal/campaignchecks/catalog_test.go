// SPDX-License-Identifier: AGPL-3.0-only

package campaignchecks

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

var findingCodeLiteral = regexp.MustCompile(`^[A-Z][A-Z0-9]*_[A-Z0-9_]+$`)

func TestFindingCatalogCoversEveryEmittedCode(t *testing.T) {
	t.Parallel()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	directory := filepath.Dir(currentFile)
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	emitted := make(map[string]struct{})
	fileset := token.NewFileSet()
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") || name == "catalog.go" {
			continue
		}
		file, parseErr := parser.ParseFile(fileset, filepath.Join(directory, name), nil, 0)
		if parseErr != nil {
			t.Fatal(parseErr)
		}
		ast.Inspect(file, func(node ast.Node) bool {
			literal, literalOK := node.(*ast.BasicLit)
			if !literalOK || literal.Kind != token.STRING {
				return true
			}
			value, unquoteErr := strconv.Unquote(literal.Value)
			if unquoteErr == nil && findingCodeLiteral.MatchString(value) {
				emitted[value] = struct{}{}
			}
			return true
		})
	}
	for code := range emitted {
		definition, exists := findingCatalog[code]
		if !exists {
			t.Errorf("emitted code %s has no F07/F09/F10/F11 catalog entry", code)
			continue
		}
		if len(definition.Features) == 0 || definition.Dimension == "" {
			t.Errorf("catalog definition for %s is incomplete: %+v", code, definition)
		}
	}
	for code := range findingCatalog {
		if _, exists := emitted[code]; !exists {
			t.Errorf("catalog code %s is not emitted by the detector", code)
		}
	}
}

func TestFindingCatalogIsSortedAndDefensivelyCopied(t *testing.T) {
	t.Parallel()
	first := FindingDefinitions()
	second := FindingDefinitions()
	if len(first) == 0 || len(first) != len(second) {
		t.Fatalf("catalog lengths = %d and %d", len(first), len(second))
	}
	for index := range first {
		if first[index].Code != second[index].Code || (index > 0 && first[index-1].Code >= first[index].Code) {
			t.Fatalf("catalog is not stable and sorted at %d: %+v", index, first)
		}
	}
	first[0].Features[0] = "changed"
	if FindingDefinitions()[0].Features[0] == "changed" {
		t.Fatal("FindingDefinitions exposed mutable catalog storage")
	}
}

func TestReadmeMapsEveryFindingCode(t *testing.T) {
	t.Parallel()
	raw, err := os.ReadFile("README.md")
	if err != nil {
		t.Fatal(err)
	}
	for _, definition := range FindingDefinitions() {
		if !strings.Contains(string(raw), "`"+definition.Code+"`") {
			t.Errorf("README finding-code ownership table omits %s", definition.Code)
		}
	}
}
