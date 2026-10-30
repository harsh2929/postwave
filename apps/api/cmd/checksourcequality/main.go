// Command checksourcequality enforces maintainability budgets for production
// Go code in apps/api. It deliberately parses every non-test, non-generated Go
// source file so adding a new package cannot bypass the gate.
package main

import (
	"bytes"
	"errors"
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"go/types"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

const (
	defaultFileLineLimit      = 2000
	defaultFunctionComplexity = 50
)

// legacyFileLineBudgets are ratchets, not ignores. Every production file is
// still parsed and measured. A listed file must stay at its exact recorded
// size: growth fails, while shrinkage fails with an instruction to lower the
// budget so deleted code cannot silently grow back later.
var legacyFileLineBudgets = map[string]int{
	"internal/commerce/handlers.go":              3697,
	"internal/commerce/wix_stores.go":            2088,
	"internal/crm_integrations/pipedrive.go":     2076,
	"internal/integrations/provider_metadata.go": 2303,
	"internal/lead_integrations/handlers.go":     3880,
	"internal/mailchimpv3/p2.go":                 2429,
	"main.go":                                    5146,
}

// legacyFunctionComplexityBudgets is populated only for functions already
// above the default. Entries are exact ratchets and are rejected if stale.
var legacyFunctionComplexityBudgets = map[string]int{
	"internal/commerce/integration_sync_state.go::integrationSyncState":                    111,
	"internal/crm_integrations/handlers.go::(*Deps).DisconnectIntegration":                 53,
	"internal/integrations/contracts.go::publicClaim":                                      110,
	"internal/integrations/contracts.go::rateLimitPolicyFor":                               119,
	"internal/integrations/handlers.go::healthChecks":                                      204,
	"internal/integrations/handlers.go::healthSummary":                                     81,
	"internal/integrations/provider_metadata.go::decorateManagedProviderLifecycleResponse": 221,
	"internal/lead_integrations/handlers.go::(*Deps).DisconnectIntegration":                99,
	"internal/lead_integrations/handlers.go::leadProviderEffectiveCursor":                  70,
	"internal/lead_integrations/handlers.go::leadProviderRetryBaseCursor":                  70,
	"internal/support_integrations/handlers.go::(*Deps).providerPull":                      80,
	"internal/support_integrations/support_backfill.go::supportRetryDelay":                 82,
	"internal/warehouse/providers.go::providerAddressConfigError":                          53,
	"main.go::run": 165,
}

type finding struct {
	path    string
	message string
}

func main() {
	root := flag.String("root", "apps/api", "apps/api source root")
	flag.Parse()

	findings, err := check(*root)
	if err != nil {
		fmt.Fprintf(os.Stderr, "source-quality guard failed: %v\n", err)
		os.Exit(1)
	}
	if len(findings) != 0 {
		for _, item := range findings {
			fmt.Fprintf(os.Stderr, "%s: %s\n", item.path, item.message)
		}
		os.Exit(1)
	}
	fmt.Println("apps/api source-quality budgets passed")
}

func check(root string) ([]finding, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("resolve root: %w", err)
	}
	info, err := os.Stat(root)
	if err != nil {
		return nil, fmt.Errorf("stat root: %w", err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("root is not a directory: %s", root)
	}

	seenFiles := make(map[string]bool)
	seenFunctions := make(map[string]bool)
	var findings []finding
	productionFiles := 0

	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		if entry.Type()&fs.ModeSymlink != 0 {
			return fmt.Errorf("refusing symlink in source tree: %s", path)
		}
		if !strings.HasSuffix(entry.Name(), ".go") || strings.HasSuffix(entry.Name(), "_test.go") {
			return nil
		}

		source, readErr := os.ReadFile(path)
		if readErr != nil {
			return fmt.Errorf("read %s: %w", path, readErr)
		}
		fileSet := token.NewFileSet()
		parsed, parseErr := parser.ParseFile(fileSet, path, source, parser.ParseComments|parser.AllErrors)
		if parseErr != nil {
			return fmt.Errorf("parse %s: %w", path, parseErr)
		}
		if ast.IsGenerated(parsed) {
			return nil
		}

		rel, relErr := filepath.Rel(root, path)
		if relErr != nil {
			return fmt.Errorf("relative path for %s: %w", path, relErr)
		}
		rel = filepath.ToSlash(rel)
		productionFiles++
		seenFiles[rel] = true
		lineCount := sourceLineCount(source)
		if budget, ok := legacyFileLineBudgets[rel]; ok {
			switch {
			case lineCount > budget:
				findings = append(findings, finding{rel, fmt.Sprintf("%d lines exceeds legacy budget %d", lineCount, budget)})
			case lineCount < budget:
				findings = append(findings, finding{rel, fmt.Sprintf("%d lines is below legacy budget %d; lower the ratchet to %d", lineCount, budget, lineCount)})
			}
		} else if lineCount > defaultFileLineLimit {
			findings = append(findings, finding{rel, fmt.Sprintf("%d lines exceeds default budget %d; split the file", lineCount, defaultFileLineLimit)})
		}
		findings = append(findings, errorBoundaryFindings(rel, fileSet, parsed)...)

		for _, declaration := range parsed.Decls {
			function, ok := declaration.(*ast.FuncDecl)
			if !ok || function.Body == nil {
				continue
			}
			key := functionKey(rel, function)
			seenFunctions[key] = true
			complexity := cyclomaticComplexity(function.Body)
			if budget, ok := legacyFunctionComplexityBudgets[key]; ok {
				switch {
				case complexity > budget:
					findings = append(findings, finding{key, fmt.Sprintf("complexity %d exceeds legacy budget %d", complexity, budget)})
				case complexity < budget:
					findings = append(findings, finding{key, fmt.Sprintf("complexity %d is below legacy budget %d; lower the ratchet to %d", complexity, budget, complexity)})
				}
			} else if complexity > defaultFunctionComplexity {
				findings = append(findings, finding{key, fmt.Sprintf("complexity %d exceeds default budget %d; split the function", complexity, defaultFunctionComplexity)})
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if productionFiles == 0 {
		return nil, errors.New("no production Go files found")
	}

	for path := range legacyFileLineBudgets {
		if !seenFiles[path] {
			findings = append(findings, finding{path, "legacy file budget has no matching production file; remove the stale entry"})
		}
	}
	for key := range legacyFunctionComplexityBudgets {
		if !seenFunctions[key] {
			findings = append(findings, finding{key, "legacy function budget has no matching function; remove the stale entry"})
		}
	}
	sort.Slice(findings, func(i, j int) bool {
		if findings[i].path == findings[j].path {
			return findings[i].message < findings[j].message
		}
		return findings[i].path < findings[j].path
	})
	return findings, nil
}

var explicitServerStatusNames = map[string]struct{}{
	"StatusInternalServerError":           {},
	"StatusNot" + "Implemented":           {},
	"StatusBadGateway":                    {},
	"StatusServiceUnavailable":            {},
	"StatusGatewayTimeout":                {},
	"StatusHTTPVersionNotSupported":       {},
	"StatusVariantAlsoNegotiates":         {},
	"StatusInsufficientStorage":           {},
	"StatusLoopDetected":                  {},
	"StatusNotExtended":                   {},
	"StatusNetworkAuthenticationRequired": {},
}

var explicitAuthenticationStatusNames = map[string]struct{}{
	"StatusUnauthorized": {},
	"StatusForbidden":    {},
}

// These codes have historically wrapped parser, webhook authentication,
// provider/configuration, renderer, or persistence errors. Their raw strings
// are never an API contract even when the chosen status is 4xx.
var unsafeRawErrorCodes = map[string]struct{}{
	"bad_ast":                       {},
	"bad_body":                      {},
	"bad_inner_json":                {},
	"bad_json":                      {},
	"bad_payload":                   {},
	"bad_predicate":                 {},
	"bad_segment_ast":               {},
	"bad_signature":                 {},
	"cannot_delete":                 {},
	"commerce_backfill_unavailable": {},
	"decode_failed":                 {},
	"export_unavailable":            {},
	"invalid_auth_config":           {},
	"invalid_basic_auth":            {},
	"invalid_config":                {},
	"invalid_env":                   {},
	"invalid_event_types":           {},
	"invalid_hmac":                  {},
	"invalid_oauth_uninstall_auth":  {},
	"invalid_payload":               {},
	"invalid_signature":             {},
	"invalid_state":                 {},
	"invalid_token":                 {},
	"invalid_validation_rule":       {},
	"invalid_webhook_auth":          {},
	"invalid_webhook_id":            {},
	"invalid_webhook_secret":        {},
	"invalid_webhook_signature":     {},
	"invalid_webhook_token":         {},
	"missing_signature_secret":      {},
	"missing_webhook_secret":        {},
	"missing_webhook_token":         {},
	"mjml_not_rendered":             {},
	"parse_form":                    {},
	"provider_unconfigured":         {},
	"read_body":                     {},
	"read_failed":                   {},
	"save_failed":                   {},
	"shopify_backfill_unavailable":  {},
	"turn_failed":                   {},
	"webhook_body_mismatch":         {},
}

// errorBoundaryFindings enforces two fail-closed response rules:
//
//   - an explicit 5xx response call must never receive error.Error(); and
//   - an httpbody decoder's error branch must use httpbody.PublicMessage (or
//     another fixed message), never the raw decoder string.
//
// httperror also redacts every 5xx at runtime. This source gate covers custom
// package-local response writers and prevents a future refactor from relying
// on the runtime backstop alone.
func errorBoundaryFindings(path string, fileSet *token.FileSet, file *ast.File) []finding {
	var findings []finding
	ast.Inspect(file, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok || len(call.Args) == 0 {
			return true
		}
		if _, ok := call.Args[0].(*ast.Ident); !ok {
			return true
		}
		rawError := containsRawErrorCall(call, "")
		if containsExplicitServerStatus(call) && rawError {
			line := fileSet.Position(call.Pos()).Line
			findings = append(findings, finding{
				path,
				fmt.Sprintf("line %d passes raw error text to an explicit 5xx response; use a fixed public message", line),
			})
		}
		if containsExplicitAuthenticationStatus(call) && rawError {
			line := fileSet.Position(call.Pos()).Line
			findings = append(findings, finding{
				path,
				fmt.Sprintf("line %d passes raw error text to an authentication response; use fixed public text", line),
			})
		}
		if code := firstUnsafeRawErrorCode(call); code != "" && rawError {
			line := fileSet.Position(call.Pos()).Line
			findings = append(findings, finding{
				path,
				fmt.Sprintf("line %d exposes raw error text for unsafe code %q; use fixed public text", line, code),
			})
		}
		return true
	})

	// Scan each immediate block so a decoder assignment immediately before its
	// `if err != nil` branch is handled as well as the common if-initializer.
	ast.Inspect(file, func(node ast.Node) bool {
		block, ok := node.(*ast.BlockStmt)
		if !ok {
			return true
		}
		for index, statement := range block.List {
			branch, ok := statement.(*ast.IfStmt)
			if !ok {
				continue
			}
			name := decoderErrorVariable(branch.Init)
			if name == "" && index > 0 {
				name = decoderErrorVariable(block.List[index-1])
			}
			if name == "" || !containsIdentifier(branch.Cond, name) {
				continue
			}
			if raw := firstRawErrorCall(branch.Body, name); raw != nil {
				line := fileSet.Position(raw.Pos()).Line
				findings = append(findings, finding{
					path,
					fmt.Sprintf("line %d exposes a raw httpbody decoder error; use httpbody.PublicMessage", line),
				})
			}
		}
		return true
	})
	return findings
}

func containsExplicitAuthenticationStatus(node ast.Node) bool {
	found := false
	ast.Inspect(node, func(candidate ast.Node) bool {
		if skipNestedFuncLit(node, candidate) {
			return false
		}
		if found {
			return false
		}
		switch value := candidate.(type) {
		case *ast.SelectorExpr:
			pkg, ok := value.X.(*ast.Ident)
			if ok && pkg.Name == "http" {
				_, found = explicitAuthenticationStatusNames[value.Sel.Name]
			}
		case *ast.BasicLit:
			if value.Kind == token.INT {
				status, err := strconv.Atoi(value.Value)
				found = err == nil && (status == 401 || status == 403)
			}
		}
		return !found
	})
	return found
}

func firstUnsafeRawErrorCode(node ast.Node) string {
	found := ""
	ast.Inspect(node, func(candidate ast.Node) bool {
		if skipNestedFuncLit(node, candidate) {
			return false
		}
		if found != "" {
			return false
		}
		literal, ok := candidate.(*ast.BasicLit)
		if !ok || literal.Kind != token.STRING {
			return true
		}
		value, err := strconv.Unquote(literal.Value)
		if err == nil {
			if _, unsafe := unsafeRawErrorCodes[value]; unsafe {
				found = value
			}
		}
		return found == ""
	})
	return found
}

func containsExplicitServerStatus(node ast.Node) bool {
	found := false
	ast.Inspect(node, func(candidate ast.Node) bool {
		if skipNestedFuncLit(node, candidate) {
			return false
		}
		if found {
			return false
		}
		switch value := candidate.(type) {
		case *ast.SelectorExpr:
			pkg, ok := value.X.(*ast.Ident)
			if ok && pkg.Name == "http" {
				_, found = explicitServerStatusNames[value.Sel.Name]
			}
		case *ast.BasicLit:
			if value.Kind == token.INT {
				status, err := strconv.Atoi(value.Value)
				found = err == nil && status >= 500 && status <= 599
			}
		}
		return !found
	})
	return found
}

// skipNestedFuncLit reports whether candidate is a function literal nested
// inside the node being scanned. A closure passed as an argument (a route
// group, a worker body) is code, not response text: its own calls are
// inspected on their own by the file walk, so scanning into it here would
// attribute every 5xx and every err.Error() in a 4,000-line route-mounting
// closure to the one call that receives the closure.
func skipNestedFuncLit(root, candidate ast.Node) bool {
	if candidate == root {
		return false
	}
	_, ok := candidate.(*ast.FuncLit)
	return ok
}

func containsRawErrorCall(node ast.Node, variable string) bool {
	return firstRawErrorCall(node, variable) != nil
}

func firstRawErrorCall(node ast.Node, variable string) *ast.CallExpr {
	var found *ast.CallExpr
	ast.Inspect(node, func(candidate ast.Node) bool {
		if skipNestedFuncLit(node, candidate) {
			return false
		}
		if found != nil {
			return false
		}
		call, ok := candidate.(*ast.CallExpr)
		if !ok || len(call.Args) != 0 {
			return true
		}
		selector, ok := call.Fun.(*ast.SelectorExpr)
		if !ok || selector.Sel.Name != "Error" {
			return true
		}
		receiver, ok := selector.X.(*ast.Ident)
		if ok && (variable == "" || receiver.Name == variable) {
			found = call
			return false
		}
		return true
	})
	return found
}

func decoderErrorVariable(statement ast.Stmt) string {
	assignment, ok := statement.(*ast.AssignStmt)
	if !ok || len(assignment.Rhs) == 0 || len(assignment.Lhs) == 0 {
		return ""
	}
	for rhsIndex, expression := range assignment.Rhs {
		call, ok := expression.(*ast.CallExpr)
		if !ok || !isHTTPBodyDecoder(call) {
			continue
		}
		lhsIndex := rhsIndex
		if len(assignment.Rhs) == 1 {
			lhsIndex = len(assignment.Lhs) - 1
		}
		if lhsIndex >= 0 && lhsIndex < len(assignment.Lhs) {
			if identifier, ok := assignment.Lhs[lhsIndex].(*ast.Ident); ok {
				return identifier.Name
			}
		}
	}
	return ""
}

func isHTTPBodyDecoder(call *ast.CallExpr) bool {
	selector, ok := call.Fun.(*ast.SelectorExpr)
	if !ok {
		return false
	}
	pkg, ok := selector.X.(*ast.Ident)
	if !ok || pkg.Name != "httpbody" {
		return false
	}
	return strings.HasPrefix(selector.Sel.Name, "DecodeJSON") || selector.Sel.Name == "ReadJSONAtMost"
}

func containsIdentifier(node ast.Node, name string) bool {
	found := false
	ast.Inspect(node, func(candidate ast.Node) bool {
		if found {
			return false
		}
		if identifier, ok := candidate.(*ast.Ident); ok && identifier.Name == name {
			found = true
		}
		return !found
	})
	return found
}

func sourceLineCount(source []byte) int {
	if len(source) == 0 {
		return 0
	}
	lines := bytes.Count(source, []byte{'\n'})
	if source[len(source)-1] != '\n' {
		lines++
	}
	return lines
}

func functionKey(path string, function *ast.FuncDecl) string {
	name := function.Name.Name
	if function.Recv != nil && len(function.Recv.List) != 0 {
		name = "(" + types.ExprString(function.Recv.List[0].Type) + ")." + name
	}
	return path + "::" + name
}

func cyclomaticComplexity(body *ast.BlockStmt) int {
	complexity := 1
	ast.Inspect(body, func(node ast.Node) bool {
		switch value := node.(type) {
		case *ast.IfStmt, *ast.ForStmt, *ast.RangeStmt:
			complexity++
		case *ast.CaseClause:
			if value.List != nil {
				complexity++
			}
		case *ast.CommClause:
			if value.Comm != nil {
				complexity++
			}
		case *ast.BinaryExpr:
			if value.Op == token.LAND || value.Op == token.LOR {
				complexity++
			}
		}
		return true
	})
	return complexity
}
