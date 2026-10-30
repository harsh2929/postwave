// SPDX-License-Identifier: AGPL-3.0-only

// Command checkrequestbodies prevents new unbounded or ambiguous request-body
// readers from bypassing internal/httpbody. It intentionally uses only the Go
// standard library so CI can run it before downloading tool dependencies.
package main

import (
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

type finding struct {
	file    string
	line    int
	message string
}

func main() {
	root := flag.String("root", "apps/api", "API source root to inspect")
	flag.Parse()
	findings, err := scan(*root)
	if err != nil {
		fmt.Fprintln(os.Stderr, "request-body gate:", err)
		os.Exit(2)
	}
	if len(findings) == 0 {
		fmt.Println("request-body gate passed: all production body readers are bounded and canonical")
		return
	}
	for _, item := range findings {
		fmt.Fprintf(os.Stderr, "%s:%d: %s\n", item.file, item.line, item.message)
	}
	fmt.Fprintf(os.Stderr, "request-body gate failed with %d finding(s)\n", len(findings))
	os.Exit(1)
}

func scan(root string) ([]finding, error) {
	var out []finding
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			if entry.Name() == "vendor" || entry.Name() == "generated" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		clean := filepath.ToSlash(path)
		if strings.HasSuffix(clean, "internal/httpbody/limit.go") || strings.Contains(clean, "cmd/checkrequestbodies/") {
			return nil
		}
		findings, err := scanFile(path)
		if err != nil {
			return err
		}
		out = append(out, findings...)
		return nil
	})
	sort.Slice(out, func(i, j int) bool {
		if out[i].file == out[j].file {
			if out[i].line == out[j].line {
				return out[i].message < out[j].message
			}
			return out[i].line < out[j].line
		}
		return out[i].file < out[j].file
	})
	return out, err
}

func scanFile(path string) ([]finding, error) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, path, nil, parser.ParseComments)
	if err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	imports := importPaths(file)
	var out []finding
	ast.Inspect(file, func(node ast.Node) bool {
		switch fn := node.(type) {
		case *ast.FuncDecl:
			if fn.Body != nil {
				out = append(out, inspectFunction(path, fset, imports, fn.Type, fn.Body)...)
			}
		case *ast.FuncLit:
			out = append(out, inspectFunction(path, fset, imports, fn.Type, fn.Body)...)
		}
		return true
	})
	return out, nil
}

func inspectFunction(path string, fset *token.FileSet, imports map[string]string, functionType *ast.FuncType, body *ast.BlockStmt) []finding {
	requests := requestParameterNames(functionType, imports)
	if len(requests) == 0 {
		return nil
	}
	aliases := map[string]bool{}
	ast.Inspect(body, func(node ast.Node) bool {
		if _, nested := node.(*ast.FuncLit); nested {
			return false
		}
		assign, ok := node.(*ast.AssignStmt)
		if !ok {
			return true
		}
		if len(assign.Lhs) == len(assign.Rhs) {
			for i, rhs := range assign.Rhs {
				if referencesRequestBody(rhs, requests, aliases) {
					if id, ok := assign.Lhs[i].(*ast.Ident); ok {
						aliases[id.Name] = true
					}
				}
			}
		} else if len(assign.Lhs) > 0 && len(assign.Rhs) == 1 && referencesRequestBody(assign.Rhs[0], requests, aliases) {
			// Multi-result request readers conventionally return the bytes or
			// stream as their first result and an error as the second.
			if id, ok := assign.Lhs[0].(*ast.Ident); ok {
				aliases[id.Name] = true
			}
		}
		return true
	})

	hasMultipartCap := false
	ast.Inspect(body, func(node ast.Node) bool {
		if _, nested := node.(*ast.FuncLit); nested {
			return false
		}
		assign, ok := node.(*ast.AssignStmt)
		if !ok {
			return true
		}
		for i, rhs := range assign.Rhs {
			if i >= len(assign.Lhs) || !isRequestBodySelector(assign.Lhs[i], requests) {
				continue
			}
			call, ok := rhs.(*ast.CallExpr)
			if ok && isSelector(call.Fun, imports, "net/http", "MaxBytesReader") && len(call.Args) == 3 && referencesRequestBody(call.Args[1], requests, aliases) {
				hasMultipartCap = true
			}
		}
		return true
	})

	var out []finding
	seen := map[token.Pos]bool{}
	add := func(node ast.Node, message string) {
		if node == nil || seen[node.Pos()] {
			return
		}
		seen[node.Pos()] = true
		position := fset.Position(node.Pos())
		out = append(out, finding{file: filepath.ToSlash(path), line: position.Line, message: message})
	}

	ast.Inspect(body, func(node ast.Node) bool {
		if _, nested := node.(*ast.FuncLit); nested {
			return false
		}
		call, ok := node.(*ast.CallExpr)
		if !ok {
			return true
		}

		switch {
		case isSelector(call.Fun, imports, "encoding/json", "NewDecoder") && len(call.Args) == 1 && referencesRequestBody(call.Args[0], requests, aliases):
			add(call, "request JSON must use httpbody.DecodeJSON/DecodeJSONWith")
		case (isSelector(call.Fun, imports, "io", "ReadAll") || isSelector(call.Fun, imports, "io/ioutil", "ReadAll")) && len(call.Args) == 1 && referencesRequestBody(call.Args[0], requests, aliases):
			add(call, "request bytes must use httpbody.ReadAtMost or a documented streaming/multipart reader")
		case (isSelector(call.Fun, imports, "io", "Copy") || isSelector(call.Fun, imports, "io", "CopyBuffer")) && copyReadsRequestBody(call, requests, aliases):
			add(call, "request body must not be drained/copied without an exact quota")
		case isSelector(call.Fun, imports, "io", "LimitReader") && len(call.Args) == 2 && referencesRequestBody(call.Args[0], requests, aliases):
			add(call, "io.LimitReader silently truncates request bodies; use httpbody.ReadAtMost")
		case selectorMethod(call.Fun, requests, "ParseMultipartForm") && !hasMultipartCap:
			add(call, "multipart parsing requires r.Body = http.MaxBytesReader(...) in the same handler")
		case selectorMethod(call.Fun, requests, "MultipartReader") && !hasMultipartCap:
			add(call, "multipart streaming requires r.Body = http.MaxBytesReader(...) in the same handler")
		}
		return true
	})
	return out
}

func requestParameterNames(functionType *ast.FuncType, imports map[string]string) map[string]bool {
	out := map[string]bool{}
	if functionType == nil || functionType.Params == nil {
		return out
	}
	for _, field := range functionType.Params.List {
		if !isHTTPRequestType(field.Type, imports) {
			continue
		}
		for _, name := range field.Names {
			out[name.Name] = true
		}
	}
	return out
}

func isHTTPRequestType(expr ast.Expr, imports map[string]string) bool {
	star, ok := expr.(*ast.StarExpr)
	if !ok {
		return false
	}
	sel, ok := star.X.(*ast.SelectorExpr)
	if !ok || sel.Sel.Name != "Request" {
		return false
	}
	id, ok := sel.X.(*ast.Ident)
	return ok && imports[id.Name] == "net/http"
}

func referencesRequestBody(expr ast.Expr, requests, aliases map[string]bool) bool {
	found := false
	ast.Inspect(expr, func(node ast.Node) bool {
		if found {
			return false
		}
		if isRequestBodySelector(node, requests) {
			found = true
			return false
		}
		if id, ok := node.(*ast.Ident); ok && aliases[id.Name] {
			found = true
			return false
		}
		return true
	})
	return found
}

func isRequestBodySelector(node ast.Node, requests map[string]bool) bool {
	sel, ok := node.(*ast.SelectorExpr)
	if !ok || sel.Sel.Name != "Body" {
		return false
	}
	id, ok := sel.X.(*ast.Ident)
	return ok && requests[id.Name]
}

func copyReadsRequestBody(call *ast.CallExpr, requests, aliases map[string]bool) bool {
	if len(call.Args) < 2 {
		return false
	}
	return referencesRequestBody(call.Args[1], requests, aliases)
}

func selectorMethod(expr ast.Expr, requests map[string]bool, method string) bool {
	sel, ok := expr.(*ast.SelectorExpr)
	if !ok || sel.Sel.Name != method {
		return false
	}
	id, ok := sel.X.(*ast.Ident)
	return ok && requests[id.Name]
}

func isSelector(expr ast.Expr, imports map[string]string, importPath, name string) bool {
	sel, ok := expr.(*ast.SelectorExpr)
	if !ok || sel.Sel.Name != name {
		return false
	}
	id, ok := sel.X.(*ast.Ident)
	return ok && imports[id.Name] == importPath
}

func importPaths(file *ast.File) map[string]string {
	out := map[string]string{}
	for _, spec := range file.Imports {
		path, err := strconv.Unquote(spec.Path.Value)
		if err != nil {
			continue
		}
		name := ""
		if spec.Name != nil {
			name = spec.Name.Name
		} else if slash := strings.LastIndexByte(path, '/'); slash >= 0 {
			name = path[slash+1:]
		} else {
			name = path
		}
		if name != "" && name != "_" && name != "." {
			out[name] = path
		}
	}
	return out
}
