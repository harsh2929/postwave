// SPDX-License-Identifier: AGPL-3.0-only

// check-go-package-imports prints actual Go import declarations under packages/
// that cross into the application or service layers. It deliberately uses the
// Go parser so policy strings and test fixtures are not mistaken for imports.
package main

import (
	"fmt"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

var forbiddenPrefixes = []string{
	"github.com/postwave/postwave/apps/",
	"github.com/postwave/postwave/services/",
}

func main() {
	root := "packages"
	if len(os.Args) > 1 {
		root = os.Args[1]
	}

	fset := token.NewFileSet()
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			if path != root && shouldSkipDirectory(entry.Name()) {
				return filepath.SkipDir
			}
			return nil
		}
		if filepath.Ext(path) != ".go" {
			return nil
		}

		file, parseErr := parser.ParseFile(fset, path, nil, parser.ImportsOnly)
		if parseErr != nil {
			return fmt.Errorf("parse %s: %w", path, parseErr)
		}
		for _, importSpec := range file.Imports {
			importPath, unquoteErr := strconv.Unquote(importSpec.Path.Value)
			if unquoteErr != nil {
				return fmt.Errorf("parse import in %s: %w", path, unquoteErr)
			}
			if !hasForbiddenPrefix(importPath) {
				continue
			}
			position := fset.Position(importSpec.Pos())
			fmt.Printf("%s:%d:\t%s\n", path, position.Line, importSpec.Path.Value)
		}
		return nil
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "Go import boundary scan failed: %v\n", err)
		os.Exit(2)
	}
}

func hasForbiddenPrefix(importPath string) bool {
	for _, prefix := range forbiddenPrefixes {
		if strings.HasPrefix(importPath, prefix) {
			return true
		}
	}
	return false
}

func shouldSkipDirectory(name string) bool {
	switch name {
	case ".git", "dist", "node_modules", "vendor":
		return true
	default:
		return false
	}
}
