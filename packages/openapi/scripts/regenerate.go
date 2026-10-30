//
// regenerate.go — OpenAPI route extractor.
//
// Walks the Go API composition root and only the internal packages reachable
// from that root (plus reviewed additions in route-reachability.json), looking
// for statically resolvable registrations on receivers proven to be chi routers.
// The composition root is the whole Go package that contains the policy's
// composition_root file (every non-test .go file beside apps/api/main.go), not
// that one file: run()'s wiring lives in sibling files such as wiring_*.go and
// workers_*.go, and a mount or import there composes the binary exactly as one
// in main.go does.
// The supplementary AST inventory recognizes direct verb methods, Method/
// MethodFunc HTTP constants, inline Route callbacks with static prefixes, and
// Handle/HandleFunc proxy registrations, then emits stub OpenAPI path entries
// for any route that isn't already documented in packages/openapi/openapi.yaml.
// Existing operations are left ALONE so
// hand-curated request/response schemas don't get clobbered; newly shipped
// methods can still be appended to an existing path.
//
// Usage:
//
//	go run ./scripts/regenerate.go        # update openapi.yaml + .json
//	go run ./scripts/regenerate.go -dry   # print what would change, exit 0
//	go run ./scripts/regenerate.go -check # exit 1 if spec is out of date
//
// Limitations:
//   - This AST scan is a defense-in-depth check, not the authoritative gateway
//     inventory. It composes only statically bounded, inline Route callbacks;
//     scripts/lib/route-reachability.mjs also follows Mount/cross-function
//     composition and remains the exhaustive parity authority.
//   - Only same-file constant string propagation is evaluated. An otherwise
//     proven router registration with a dynamic method/path fails regeneration;
//     it is never silently ignored.
//   - The scan proves receiver identities from chi types, narrow router
//     interfaces, chi constructors, and router-derived expressions. It does not
//     infer a route from a convenient receiver name such as `r`.
//   - Generated entries are intentionally lightweight: { method: { summary,
//     tags, responses: { '200': { description } } } }. Full schema codegen
//     needs handler annotations or struct-tag scanning. Until an operation is
//     hand-curated, the generated response description explicitly marks it as
//     endpoint-specific instead of exposing a production-facing TODO.

package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"go/types"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const maxRegenerateInputBytes int64 = 32 << 20

const (
	routeReachabilityPolicyPath = "packages/openapi/route-reachability.json"
	openAPIExemptionsPolicyPath = "packages/openapi/openapi-exemptions.json"
	routeContractsPolicyPath    = "packages/openapi/route-contracts.json"
	apiInternalImportPrefix     = "github.com/postwave/postwave/apps/api/internal/"
	apiInternalSourcePrefix     = "apps/api/internal/"
)

// Route is one extracted (method, path, handler-symbol, tag) tuple.
type Route struct {
	Method  string // GET, HEAD, POST, PATCH, PUT, DELETE, OPTIONS, or ANY for Handle
	Path    string // /api/v1/whatever/{id}
	Handler string // raw second-arg expression, e.g. "campaigns.MountRoutes" or "deps.Send"
	Tag     string // package name derived from the Go file the call lives in
	Source  string // "apps/api/internal/foo/bar.go:123"
}

// missingEntry collects the methods we need to stub for one new path.
// Hoisted to file scope so updateJSONSpec can accept the typed map.
type missingEntry struct {
	Path    string
	Methods map[string]Route // method-name -> route
}

// Order matters for the path-bracket regex: chi uses `{name}` for path
// params; we don't need to rewrite — OpenAPI 3.x speaks `{name}` natively.
var (
	routeMethods = map[string]string{
		"Get": "GET", "Head": "HEAD", "Post": "POST", "Put": "PUT", "Patch": "PATCH",
		"Delete": "DELETE", "Options": "OPTIONS",
	}

	// pathParamRe matches `{name}` and chi-style `{name:regex}` placeholders.
	// The first capture group is the bare parameter name (sans regex tail).
	pathParamRe = regexp.MustCompile(`\{([A-Za-z_][A-Za-z0-9_]*)(?::[^{}]+)?\}`)

	// pathParamDescriptions maps common path-param names to a one-liner
	// description. Anything not listed falls through to a generic
	// "<Name> identifier." description in paramDescription.
	pathParamDescriptions = map[string]string{
		"id":            "Resource id.",
		"job_id":        "Job id.",
		"jobId":         "Job id.",
		"campaign_id":   "Campaign id.",
		"campaignId":    "Campaign id.",
		"subscriber_id": "Subscriber id.",
		"subscriberId":  "Subscriber id.",
		"tenant_slug":   "Tenant slug.",
		"tenantSlug":    "Tenant slug.",
		"campaign_slug": "Campaign slug.",
		"campaignSlug":  "Campaign slug.",
		"slug":          "URL slug.",
		"email":         "Email address.",
		"topicId":       "Topic id.",
		"topic_id":      "Topic id.",
		"request_id":    "Request id.",
		"requestId":     "Request id.",
		"delivery_id":   "Delivery id.",
		"deliveryId":    "Delivery id.",
		"tid":           "Trigger id.",
		"provider":      "Provider name.",
		"source":        "Source platform identifier.",
		"position":      "Position index.",
		"key":           "Object key.",
		"token":         "Opaque token.",
		"code":          "Short code.",
	}
)

type routeSourcePolicyEntry struct {
	Path          string                   `json:"path"`
	RequiredCalls []routeRequiredCallEntry `json:"required_calls,omitempty"`
	Reason        string                   `json:"reason"`
}

type routeRequiredCallEntry struct {
	Source   string `json:"source"`
	Function string `json:"function"`
	Symbol   string `json:"symbol"`
}

type routePolicyRouteEntry struct {
	Method string `json:"method"`
	Path   string `json:"path"`
	Reason string `json:"reason"`
}

type routePolicyCallEntry struct {
	Symbol string `json:"symbol"`
	Reason string `json:"reason"`
}

type routeReachabilityPolicy struct {
	Version                   int                      `json:"version"`
	CompositionRoot           string                   `json:"composition_root"`
	AdditionalSources         []routeSourcePolicyEntry `json:"additional_sources"`
	ForbiddenCompositionCalls []routePolicyCallEntry   `json:"forbidden_composition_calls"`
	ExcludedRoutes            []routePolicyRouteEntry  `json:"excluded_routes"`
	ExcludedSources           []routeSourcePolicyEntry `json:"excluded_sources"`
}

type openAPIExemptionsPolicy struct {
	Version int      `json:"version"`
	Routes  []string `json:"routes"`
}

type routeContractsDocument struct {
	Rules []routeContractRule `json:"rules"`
}

type routeContractRule struct {
	Route   string `json:"route"`
	Pattern string `json:"pattern"`
	// GatewayOnlyRoutes enumerates, by exact route key, the mounted routes a
	// pattern rule has been reviewed to classify (scripts/lib/route-contracts.mjs
	// resolves a route as exact rule ?? membership). Only exact routes are ever
	// read from it; the pattern itself never classifies an AST exemption, and a
	// method-agnostic ANY route is never classified by a membership at all.
	GatewayOnlyRoutes []string `json:"gateway_only_routes"`
	Exposure          string   `json:"exposure"`
	Reason            string   `json:"reason"`
	compiled          *regexp.Regexp
}

var reviewedRouteContractExposures = map[string]bool{
	"admin-web":                       true,
	"agent-api-preview":               true,
	"browser-telemetry":               true,
	"browser-stream-helper":           true,
	"compat-product":                  true,
	"deprecated-compat":               true,
	"first-party-api-key-self":        true,
	"first-party-authenticated-read":  true,
	"first-party-authenticated-write": true,
	"gateway-proxy-dispatch":          true,
	"health-probe":                    true,
	"internal-trust-boundary":         true,
	"operational-admin":               true,
	"ops-admin":                       true,
	"ops-admin-disabled-by-default":   true,
	"public-bootstrap":                true,
	"public-notice-and-action":        true,
	"public-status":                   true,
	"public-token-or-embed":           true,
	"release-held":                    true,
	"web-app-internal":                true,
	"web-app-oauth":                   true,
}

var provisionalExposureRe = regexp.MustCompile(`(?i)pending|uncodified|triage|provisional`)

func main() {
	dry := flag.Bool("dry", false, "print what would change but don't write files")
	check := flag.Bool("check", false, "exit 1 if openapi.yaml would change (for CI)")
	flag.Parse()

	repoRoot, err := findRepoRoot()
	if err != nil {
		fatal("locate repo root: %v", err)
	}
	specYAMLPath := filepath.Join(repoRoot, "packages", "openapi", "openapi.yaml")
	specJSONPath := filepath.Join(repoRoot, "packages", "openapi", "openapi.json")

	routes, warnings, err := extractRoutes(repoRoot)
	if err != nil {
		fatal("extract routes: %v", err)
	}
	if len(warnings) > 0 {
		fmt.Fprintf(os.Stderr, "regenerate: %d unparseable route line(s) — needs manual entry:\n",
			len(warnings))
		for _, w := range warnings {
			fmt.Fprintf(os.Stderr, "  %s\n", w)
		}
		fatal("%v", unresolvedRouteWarningsError(warnings))
	}

	yamlBytes, err := readLocalFile(specYAMLPath)
	if err != nil {
		fatal("read openapi.yaml: %v", err)
	}
	existingOperations := operationsInSpec(string(yamlBytes))
	existingPaths := make(map[string]bool, len(existingOperations))
	for path := range existingOperations {
		existingPaths[path] = true
	}
	exemptions, err := loadOpenAPIExemptions(repoRoot, routes, existingOperations)
	if err != nil {
		fatal("load OpenAPI exemptions: %v", err)
	}

	// Routes the spec is missing. Group by path so we emit one path
	// entry per chi route path with all its methods nested.
	missing := map[string]*missingEntry{}
	for _, rt := range routes {
		method := strings.ToLower(rt.Method)
		if existingOperations[rt.Path][method] {
			continue
		}
		if exemptions[rt.Method+" "+rt.Path] {
			continue
		}
		entry, ok := missing[rt.Path]
		if !ok {
			entry = &missingEntry{Path: rt.Path, Methods: map[string]Route{}}
			missing[rt.Path] = entry
		}
		// Conflict resolution: if two extractions hit the same (path,
		// method), keep the first — they're typically duplicate defs
		// inside `r.Group` blocks and resolve to the same handler.
		if _, exists := entry.Methods[method]; !exists {
			entry.Methods[method] = rt
		}
	}

	missingOperations := 0
	missingPaths := 0
	for path, entry := range missing {
		missingOperations += len(entry.Methods)
		if !existingPaths[path] {
			missingPaths++
		}
	}
	fmt.Printf("regenerate: extracted=%d  in-spec-paths=%d  missing-paths=%d  missing-operations=%d\n",
		len(routes), len(existingPaths), missingPaths, missingOperations)

	// Sort missing paths for deterministic output.
	pathsSorted := make([]string, 0, len(missing))
	for p := range missing {
		pathsSorted = append(pathsSorted, p)
	}
	sort.Strings(pathsSorted)

	// Pass A: add newly discovered methods to existing path entries, then
	// splice entirely new path entries into the generated stub region.
	newYAML := string(yamlBytes)
	if len(missing) > 0 {
		var err error
		newYAML, err = insertMethodsIntoExistingPaths(newYAML, missing, existingPaths)
		if err != nil {
			fatal("add methods to existing OpenAPI paths: %v", err)
		}

		var stubBuf strings.Builder
		var newPaths []string
		for _, p := range pathsSorted {
			if existingPaths[p] {
				continue
			}
			newPaths = append(newPaths, p)
		}
		if len(newPaths) > 0 {
			stubBuf.WriteString("\n  # ---------- BEGIN auto-generated route stubs ----------\n")
			stubBuf.WriteString("  # Added by packages/openapi/scripts/regenerate.go.\n")
			stubBuf.WriteString("  # Replace these stubs with hand-curated request/response schemas\n")
			stubBuf.WriteString("  # as endpoints stabilize. Existing operations are never overwritten.\n")
		}
		for _, p := range newPaths {
			entry := missing[p]
			stubBuf.WriteString(yamlPathStub(entry.Path, entry.Methods))
		}
		if len(newPaths) > 0 {
			stubBuf.WriteString("  # ---------- END auto-generated route stubs ----------\n")
		}

		if *dry || *check {
			fmt.Printf("regenerate: would add %d operation(s) across %d path entries:\n", missingOperations, len(pathsSorted))
			for _, p := range pathsSorted {
				fmt.Printf("  + %s  (%s)\n", p, strings.Join(sortedMethodNames(missing[p].Methods), ", "))
			}
			// Don't return yet — augmentation diagnostics matter too.
		}

		// Insert the stubs at the *end* of the `paths:` block — i.e. just
		// before whatever the next top-level key is (`webhooks:`, `security:`,
		// `components:`, …). Naive append-to-EOF would orphan the new entries
		// outside `paths:` and break the OpenAPI document.
		if len(newPaths) > 0 {
			spliced, err := insertIntoPathsBlock(newYAML, stubBuf.String())
			if err != nil {
				fatal("splice openapi.yaml: %v", err)
			}
			newYAML = spliced
		}
	}

	// Pass B: ensure every auto-gen stub with `{...}` placeholders has a
	// path-level `parameters:` block. This handles both the brand-new
	// stubs we just spliced AND any pre-existing stubs that predated the
	// param-emitting capability. Idempotent — a second pass is a no-op.
	augmentedYAML := augmentYAMLPathParams(newYAML)
	yamlChanged := augmentedYAML != string(yamlBytes)
	augmentationCount := paramAugmentationCount(newYAML, augmentedYAML)
	if augmentationCount > 0 {
		fmt.Printf("regenerate: added path-level parameters: blocks to %d existing stub(s).\n",
			augmentationCount)
	}

	if *dry || *check {
		if *check {
			if yamlChanged {
				os.Exit(1)
			}
			fmt.Println("regenerate: spec is up to date.")
		}
		return
	}

	if yamlChanged {
		if err := os.WriteFile(specYAMLPath, []byte(augmentedYAML), 0o644); err != nil {
			fatal("write openapi.yaml: %v", err)
		}
	}
	newYAML = augmentedYAML

	if len(missing) == 0 && augmentationCount == 0 {
		// Nothing changed in YAML — still let the JSON pass run, since
		// the JSON file may have lagged behind a prior YAML edit. The
		// JSON pass is cheap and idempotent.
		if err := updateJSONSpec(specJSONPath, missing, pathsSorted); err != nil {
			fatal("write openapi.json: %v", err)
		}
		return
	}

	// JSON regen: we don't pull in a YAML parser to keep the script
	// dependency-free. Instead, the existing openapi.json is updated
	// in-place — we add the same stubs as JSON path entries inside
	// `paths`. This keeps both files consistent without a YAML→JSON
	// roundtrip dependency on goccy/go-yaml or gopkg.in/yaml.v3.
	if err := updateJSONSpec(specJSONPath, missing, pathsSorted); err != nil {
		fatal("write openapi.json: %v", err)
	}

	fmt.Printf("regenerate: added %d operation(s) across %d path entries to openapi.yaml and openapi.json.\n",
		missingOperations, len(pathsSorted))
}

func unresolvedRouteWarningsError(warnings []string) error {
	if len(warnings) == 0 {
		return nil
	}
	return fmt.Errorf("refusing to continue with %d unresolved router registration(s)", len(warnings))
}

// findRepoRoot walks up from CWD looking for go.work — the repo's
// top-level marker. Lets the script be `go run`-ed from any cwd
// (`pnpm --filter @postwave/openapi regen` runs it from packages/openapi).
func findRepoRoot() (string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	dir := cwd
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.work")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("no go.work found in any parent of %s", cwd)
		}
		dir = parent
	}
}

// extractRoutes walks scanRoots and returns every (method, path) tuple
// it can statically extract. Returns warnings for lines that match the
// loose pattern but not the strict one — these are routes the operator
// should manually curate (variable paths, etc.).
func extractRoutes(repoRoot string) ([]Route, []string, error) {
	seen := map[string]Route{} // dedupe key: METHOD path
	var warnings []string

	policy, err := loadRouteReachabilityPolicy(repoRoot)
	if err != nil {
		return nil, nil, err
	}
	composition, err := loadCompositionPackage(repoRoot, policy.CompositionRoot)
	if err != nil {
		return nil, nil, err
	}
	scanRoots, err := reachableScanRootsForComposition(repoRoot, policy, composition)
	if err != nil {
		return nil, nil, err
	}
	for _, root := range scanRoots {
		full := filepath.Join(repoRoot, root)
		if composition.contains(root) {
			// Every file of the composition package is one API surface, whichever
			// sibling file a registration was extracted into.
			if err := scanFileWithTag(repoRoot, full, compositionRouteTag, seen, &warnings); err != nil {
				return nil, nil, err
			}
			continue
		}
		info, err := os.Stat(full)
		if err != nil {
			return nil, nil, fmt.Errorf("stat reachable route source %s: %w", root, err)
		}
		if info.IsDir() {
			err = filepath.WalkDir(full, func(path string, d fs.DirEntry, err error) error {
				if err != nil {
					return err
				}
				rel, relErr := filepath.Rel(repoRoot, path)
				if relErr != nil {
					return relErr
				}
				if routeSourceExcluded(filepath.ToSlash(rel), policy.ExcludedSources) {
					if d.IsDir() {
						return filepath.SkipDir
					}
					return nil
				}
				if d.IsDir() {
					return nil
				}
				if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
					return nil
				}
				return scanFile(repoRoot, path, seen, &warnings)
			})
			if err != nil {
				return nil, nil, err
			}
			continue
		}
		if err := scanFile(repoRoot, full, seen, &warnings); err != nil {
			return nil, nil, err
		}
	}
	for _, exclusion := range policy.ExcludedRoutes {
		key := exclusion.Method + " " + exclusion.Path
		route, ok := seen[key]
		if !ok {
			return nil, nil, fmt.Errorf("route-reachability exclusion %s no longer matches a reachable route declaration; remove or update the stale policy entry", key)
		}
		if composition.contains(routeSourceFile(route.Source)) {
			return nil, nil, fmt.Errorf("excluded route %s is declared directly in the API composition root at %s: %s", key, route.Source, exclusion.Reason)
		}
		delete(seen, key)
	}

	out := make([]Route, 0, len(seen))
	for _, rt := range seen {
		out = append(out, rt)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Path != out[j].Path {
			return out[i].Path < out[j].Path
		}
		return out[i].Method < out[j].Method
	})
	return out, warnings, nil
}

// reachableScanRoots resolves the only source trees allowed to contribute
// generated OpenAPI routes. The API composition root is the whole package that
// contains the policy's composition_root file (see loadCompositionPackage);
// internal packages are included only when a file of that package imports
// them directly or the reviewed policy names an explicit transitive source.
// Unknown internal packages are excluded by default, so an unmounted
// handlers.go file cannot become a public API contract merely by existing in
// the repository.
func reachableScanRoots(repoRoot string) ([]string, error) {
	policy, err := loadRouteReachabilityPolicy(repoRoot)
	if err != nil {
		return nil, err
	}
	composition, err := loadCompositionPackage(repoRoot, policy.CompositionRoot)
	if err != nil {
		return nil, err
	}
	return reachableScanRootsForComposition(repoRoot, policy, composition)
}

func reachableScanRootsForComposition(repoRoot string, policy routeReachabilityPolicy, composition *compositionPackage) ([]string, error) {
	if err := composition.checkForbiddenCalls(policy.ForbiddenCompositionCalls); err != nil {
		return nil, err
	}
	if err := validateAdditionalSourceCalls(repoRoot, policy.AdditionalSources); err != nil {
		return nil, err
	}

	imports, err := composition.internalImports()
	if err != nil {
		return nil, err
	}
	// Discovered and reviewed sources may never name an excluded scaffold. The
	// composition files themselves cannot: excluded_sources is confined to
	// apps/api/internal/ by loadRouteReachabilityPolicy.
	type candidateSource struct {
		path   string
		origin string
	}
	var candidates []candidateSource
	for _, imported := range imports {
		candidates = append(candidates, candidateSource{path: imported.source, origin: "imported by " + imported.importer})
	}
	for _, source := range policy.AdditionalSources {
		candidates = append(candidates, candidateSource{path: source.Path, origin: "named by additional_sources"})
	}
	for _, candidate := range candidates {
		for _, exclusion := range policy.ExcludedSources {
			if sourceMatchesRoot(candidate.path, exclusion.Path) {
				return nil, fmt.Errorf("API composition imports excluded route source %s (%s): %s", candidate.path, candidate.origin, exclusion.Reason)
			}
		}
	}
	if err := composition.checkExcludedFileMountReferences(repoRoot, policy.ExcludedSources, imports); err != nil {
		return nil, err
	}

	seen := make(map[string]bool, len(composition.files)+len(candidates))
	roots := make([]string, 0, len(composition.files)+len(candidates))
	for _, source := range composition.files {
		seen[source] = true
		roots = append(roots, source)
	}
	for _, candidate := range candidates {
		if seen[candidate.path] {
			continue
		}
		seen[candidate.path] = true
		roots = append(roots, candidate.path)
	}
	sort.Strings(roots)
	return roots, nil
}

// compositionRouteTag is the OpenAPI tag for a route registered directly in
// the composition package, whichever of its files declares it.
const compositionRouteTag = "Core"

// compositionPackage is the API composition root as Go compiles it. The
// policy's composition_root names one file (apps/api/main.go), but the binary
// is built from that file's whole package: commit e8d23a62d moved most of
// run() into sibling files (server_lifecycle.go, wiring_*.go, workers_*.go,
// ops_console_wiring.go), and older siblings such as composition_adapters.go
// and cdc_wiring.go already carried wiring of their own. A check scoped to the
// single named file let a forbidden mount in any sibling pass unseen and
// dropped every internal package only a sibling imports from the scan roots.
//
// Membership is the directory listing, never a list of known file names, so a
// wiring file added tomorrow is covered the moment it exists.
type compositionPackage struct {
	files  []string             // repository-relative, sorted; includes composition_root
	fset   *token.FileSet       // shared by every parsed file, for positions
	parsed map[string]*ast.File // keyed by repository-relative path
}

type compositionImport struct {
	source   string // apps/api/internal/<pkg>
	importer string // first composition file (sorted) that imports it
}

// isCompositionSourceName reports whether a directory entry is compiled into
// its package: a .go file that is not a test and that the go tool does not
// ignore by name (a leading "_" or ".", which also covers editor lock files
// such as .#main.go). Build constraints are deliberately not evaluated: a file
// compiled on any platform is composition source, so the result never depends
// on the machine running the check, and a constrained file errs toward
// reporting a forbidden mount or scanning an import rather than missing one.
func isCompositionSourceName(name string) bool {
	return strings.HasSuffix(name, ".go") &&
		!strings.HasSuffix(name, "_test.go") &&
		!strings.HasPrefix(name, "_") &&
		!strings.HasPrefix(name, ".")
}

// loadCompositionPackage parses every composition source file in the directory
// of compositionRoot. Subdirectories are separate packages (apps/api/cmd/...,
// apps/api/internal/...) and are not part of the composition root.
func loadCompositionPackage(repoRoot, compositionRoot string) (*compositionPackage, error) {
	if !isCompositionSourceName(filepath.Base(filepath.FromSlash(compositionRoot))) {
		return nil, fmt.Errorf("%s composition_root %s must name a non-test Go source file of the API composition package", routeReachabilityPolicyPath, compositionRoot)
	}
	dir := filepath.ToSlash(filepath.Dir(filepath.FromSlash(compositionRoot)))
	entries, err := os.ReadDir(filepath.Join(repoRoot, filepath.FromSlash(dir)))
	if err != nil {
		return nil, fmt.Errorf("read API composition package %s: %w", dir, err)
	}
	composition := &compositionPackage{
		fset:   token.NewFileSet(),
		parsed: map[string]*ast.File{},
	}
	for _, entry := range entries {
		if entry.IsDir() || !isCompositionSourceName(entry.Name()) {
			continue
		}
		rel := entry.Name()
		if dir != "." {
			rel = dir + "/" + entry.Name()
		}
		body, err := readLocalFile(filepath.Join(repoRoot, filepath.FromSlash(rel)))
		if err != nil {
			return nil, fmt.Errorf("read API composition source %s: %w", rel, err)
		}
		parsed, err := parser.ParseFile(composition.fset, rel, body, parser.SkipObjectResolution)
		if err != nil {
			return nil, fmt.Errorf("parse API composition source %s: %w", rel, err)
		}
		composition.files = append(composition.files, rel)
		composition.parsed[rel] = parsed
	}
	rootFile := composition.parsed[compositionRoot]
	if rootFile == nil {
		return nil, fmt.Errorf("%s composition_root %s is not a Go source file in %s", routeReachabilityPolicyPath, compositionRoot, dir)
	}
	sort.Strings(composition.files)
	// A file declaring another package would make "the composition package"
	// ambiguous; the go tool refuses to build such a directory, and so does this.
	for _, rel := range composition.files {
		if got, want := composition.parsed[rel].Name.Name, rootFile.Name.Name; got != want {
			return nil, fmt.Errorf("API composition package %s mixes package %s (%s) with package %s (%s)", dir, want, compositionRoot, got, rel)
		}
	}
	return composition, nil
}

// contains reports whether a repository-relative source path is one of the
// composition package's files.
func (c *compositionPackage) contains(source string) bool {
	return c.parsed[source] != nil
}

// checkForbiddenCalls fails on the first executable call, in file then source
// order, to a symbol the policy forbids the composition root from mounting.
// The AST walk ignores comments and string literals by construction.
func (c *compositionPackage) checkForbiddenCalls(entries []routePolicyCallEntry) error {
	forbidden := make(map[string]string, len(entries))
	for _, entry := range entries {
		forbidden[entry.Symbol] = entry.Reason
	}
	for _, rel := range c.files {
		var violation error
		ast.Inspect(c.parsed[rel], func(node ast.Node) bool {
			if violation != nil {
				return false
			}
			call, ok := node.(*ast.CallExpr)
			if !ok {
				return true
			}
			symbol := callSymbol(call.Fun)
			if reason, found := forbidden[symbol]; found {
				violation = fmt.Errorf("API composition calls forbidden route mount %s at %s:%d: %s", symbol, rel, c.fset.Position(call.Pos()).Line, reason)
				return false
			}
			return true
		})
		if violation != nil {
			return violation
		}
	}
	return nil
}

// internalImports returns every apps/api/internal package imported by any
// composition file, sorted by source path, each attributed to the first
// importing file so an exclusion failure names where to look.
func (c *compositionPackage) internalImports() ([]compositionImport, error) {
	importers := map[string]string{}
	for _, rel := range c.files {
		for _, spec := range c.parsed[rel].Imports {
			importPath, err := strconv.Unquote(spec.Path.Value)
			if err != nil {
				return nil, fmt.Errorf("parse import %s in %s: %w", spec.Path.Value, rel, err)
			}
			if !strings.HasPrefix(importPath, apiInternalImportPrefix) {
				continue
			}
			source := apiInternalSourcePrefix + strings.TrimPrefix(importPath, apiInternalImportPrefix)
			if _, known := importers[source]; !known {
				importers[source] = rel
			}
		}
	}
	imports := make([]compositionImport, 0, len(importers))
	for source, importer := range importers {
		imports = append(imports, compositionImport{source: source, importer: importer})
	}
	sort.Slice(imports, func(i, j int) bool { return imports[i].source < imports[j].source })
	return imports, nil
}

// routeSourceFile strips the ":line" suffix from a Route.Source.
func routeSourceFile(source string) string {
	if cut := strings.LastIndexByte(source, ':'); cut >= 0 {
		return source[:cut]
	}
	return source
}

// excludedFileMount is a function or method the composition package may not
// refer to, because the routes it registers live in a file the scan skips.
type excludedFileMount struct {
	symbol string // e.g. inboxreality.(*Deps).MountRoutes
	source string // the excluded file declaring the mount
	reason string // that excluded_sources entry's reviewed reason
	via    string // for a same-package wrapper, the excluded mount it reaches
}

// guardedPackage is an imported package holding at least one file-scoped
// excluded source, type-checked from source so references into it resolve.
type guardedPackage struct {
	importPath string
	dir        string                            // repository-relative
	files      []string                          // repository-relative, sorted
	parsed     map[string]*ast.File              // same package clause as the exclusions
	exclusions map[string]routeSourcePolicyEntry // excluded file -> policy entry
	info       *types.Info
	pkg        *types.Package
}

// checkExcludedFileMountReferences closes the file-scoped half of
// excluded_sources. A directory-scoped exclusion can never be imported (see
// reachableScanRootsForComposition), but a file-scoped one sits in a package
// the composition imports for something else — a type, a constructor, handler
// methods it registers itself — and the scan skips only that file. A function
// or method there whose signature carries a chi router (a router parameter, a
// router result, or a function-typed parameter or result that takes one)
// registers routes the inventory never sees, so no composition file may refer
// to it: not by call, method value, or method expression, and not through a
// function elsewhere in the same package that refers to it.
//
// References are resolved with go/types, never by spelling, so a renamed
// variable, an aliased import, a struct field, or a value returned by a
// composition helper is followed; forbidden_composition_calls, which matches
// the written call, cannot do that for methods. Only the composition package
// and the guarded packages are type-checked; every other import is an empty
// stand-in, which keeps the check hermetic and fast. A stand-in can only hide
// a reference, never invent one: a receiver whose type is known only through
// a third package, or a call made through an interface, is not followed.
func (c *compositionPackage) checkExcludedFileMountReferences(repoRoot string, exclusions []routeSourcePolicyEntry, imports []compositionImport) error {
	imported := make(map[string]bool, len(imports))
	for _, entry := range imports {
		imported[entry.source] = true
	}
	guarded := map[string]*guardedPackage{}
	for _, exclusion := range exclusions {
		dir := filepath.ToSlash(filepath.Dir(filepath.FromSlash(exclusion.Path)))
		if !strings.HasSuffix(exclusion.Path, ".go") || !imported[dir] {
			// A directory-scoped exclusion, or a file in a package nothing in
			// the composition imports: no composition file can name its mounts.
			continue
		}
		info, err := os.Stat(filepath.Join(repoRoot, filepath.FromSlash(exclusion.Path)))
		if err != nil {
			return fmt.Errorf("%s excluded source %s is in imported package %s but cannot be read; remove or update the stale policy entry: %w", routeReachabilityPolicyPath, exclusion.Path, dir, err)
		}
		if info.IsDir() {
			continue // a sub-package whose import the directory check governs
		}
		importPath := apiInternalImportPrefix + strings.TrimPrefix(dir, apiInternalSourcePrefix)
		if guarded[importPath] == nil {
			guarded[importPath] = &guardedPackage{importPath: importPath, dir: dir, exclusions: map[string]routeSourcePolicyEntry{}}
		}
		guarded[importPath].exclusions[exclusion.Path] = exclusion
	}
	if len(guarded) == 0 {
		return nil
	}
	// Parse every guarded package before type-checking anything: a syntax error
	// must fail the scan, whereas type errors against stand-ins are expected.
	importPaths := make([]string, 0, len(guarded))
	for importPath, pkg := range guarded {
		if err := pkg.parse(repoRoot, c.fset); err != nil {
			return err
		}
		if len(pkg.exclusions) == 0 {
			delete(guarded, importPath) // only test files were excluded
			continue
		}
		importPaths = append(importPaths, importPath)
	}
	if len(importPaths) == 0 {
		return nil
	}
	sort.Strings(importPaths)

	stubs := map[string]*types.Package{}
	checking := map[string]bool{}
	var importer importerFunc
	check := func(path string, files []*ast.File, info *types.Info) *types.Package {
		config := types.Config{Importer: importer, FakeImportC: true, Error: func(error) {}}
		pkg, _ := config.Check(path, c.fset, files, info) // errors are expected: see importer
		return pkg
	}
	importer = func(importPath string) (*types.Package, error) {
		if pkg := guarded[importPath]; pkg != nil && !checking[importPath] {
			if pkg.pkg == nil {
				checking[importPath] = true
				pkg.info = &types.Info{Defs: map[*ast.Ident]types.Object{}, Uses: map[*ast.Ident]types.Object{}}
				pkg.pkg = check(importPath, pkg.astFiles(), pkg.info)
				checking[importPath] = false
			}
			return pkg.pkg, nil
		}
		if stub := stubs[importPath]; stub != nil {
			return stub, nil
		}
		// Nothing is declared in a stand-in, so every reference through it is
		// unresolved; its name only has to be a plausible identifier.
		stub := types.NewPackage(importPath, stubPackageName(importPath))
		stub.MarkComplete()
		stubs[importPath] = stub
		return stub, nil
	}
	// Check the guarded packages first, in a fixed order; the composition's
	// imports of them then resolve to these same *types.Package values, which is
	// what makes a reference from the composition identical to a declaration.
	for _, importPath := range importPaths {
		if pkg, err := importer(importPath); err != nil || pkg != guarded[importPath].pkg {
			return fmt.Errorf("type-check guarded package %s: %v", guarded[importPath].dir, err)
		}
	}
	compositionInfo := &types.Info{Uses: map[*ast.Ident]types.Object{}}
	compositionFiles := make([]*ast.File, 0, len(c.files))
	for _, rel := range c.files {
		compositionFiles = append(compositionFiles, c.parsed[rel])
	}
	compositionDir := filepath.ToSlash(filepath.Dir(filepath.FromSlash(c.files[0])))
	check(strings.TrimSuffix(apiInternalImportPrefix, apiInternalSourcePrefix)+compositionDir, compositionFiles, compositionInfo)

	forbidden := map[*types.Func]excludedFileMount{}
	for _, importPath := range importPaths {
		guarded[importPath].collectMounts(forbidden)
	}
	if len(forbidden) == 0 {
		return nil
	}
	for _, rel := range c.files {
		var violation error
		ast.Inspect(c.parsed[rel], func(node ast.Node) bool {
			if violation != nil {
				return false
			}
			ident, ok := node.(*ast.Ident)
			if !ok {
				return true
			}
			function, ok := compositionInfo.Uses[ident].(*types.Func)
			if !ok {
				return true
			}
			if mount, found := forbidden[function.Origin()]; found {
				reference := mount.symbol
				if mount.via != "" {
					reference = fmt.Sprintf("%s, which reaches %s,", mount.symbol, mount.via)
				}
				violation = fmt.Errorf("API composition references %s at %s:%d; it registers routes from excluded source %s, which the inventory does not scan: %s", reference, rel, c.fset.Position(ident.Pos()).Line, mount.source, mount.reason)
			}
			return true
		})
		if violation != nil {
			return violation
		}
	}
	return nil
}

// parse reads every source file of the package that shares the excluded
// files' package clause (a generator file under //go:build ignore may declare
// another package and is not part of what the composition imports).
func (g *guardedPackage) parse(repoRoot string, fset *token.FileSet) error {
	entries, err := os.ReadDir(filepath.Join(repoRoot, filepath.FromSlash(g.dir)))
	if err != nil {
		return fmt.Errorf("read guarded package %s: %w", g.dir, err)
	}
	all := map[string]*ast.File{}
	for _, entry := range entries {
		if entry.IsDir() || !isCompositionSourceName(entry.Name()) {
			continue
		}
		rel := g.dir + "/" + entry.Name()
		body, err := readLocalFile(filepath.Join(repoRoot, filepath.FromSlash(rel)))
		if err != nil {
			return fmt.Errorf("read guarded package source %s: %w", rel, err)
		}
		parsed, err := parser.ParseFile(fset, rel, body, parser.SkipObjectResolution)
		if err != nil {
			return fmt.Errorf("parse guarded package source %s: %w", rel, err)
		}
		all[rel] = parsed
	}
	excludedFiles := make([]string, 0, len(g.exclusions))
	for excluded := range g.exclusions {
		excludedFiles = append(excludedFiles, excluded)
	}
	sort.Strings(excludedFiles)
	packageName, namedBy := "", ""
	for _, excluded := range excludedFiles {
		file := all[excluded]
		if file == nil {
			// A test file, say: never compiled into the imported package.
			delete(g.exclusions, excluded)
			continue
		}
		if packageName != "" && file.Name.Name != packageName {
			return fmt.Errorf("guarded package %s is ambiguous: excluded sources %s (package %s) and %s (package %s) cannot both be compiled into it", g.dir, namedBy, packageName, excluded, file.Name.Name)
		}
		packageName, namedBy = file.Name.Name, excluded
	}
	g.parsed = map[string]*ast.File{}
	for rel, file := range all {
		if file.Name.Name == packageName {
			g.parsed[rel] = file
			g.files = append(g.files, rel)
		}
	}
	sort.Strings(g.files)
	return nil
}

func (g *guardedPackage) astFiles() []*ast.File {
	files := make([]*ast.File, 0, len(g.files))
	for _, rel := range g.files {
		files = append(files, g.parsed[rel])
	}
	return files
}

// collectMounts adds the package's excluded-file mounts to forbidden, then
// every function of the package that refers to one of them (a wrapper would
// otherwise launder the mount), repeating until nothing new is found.
func (g *guardedPackage) collectMounts(forbidden map[*types.Func]excludedFileMount) {
	type declaration struct {
		function *types.Func
		body     *ast.BlockStmt
	}
	var declarations []declaration
	for _, rel := range g.files {
		exclusion, excluded := g.exclusions[rel]
		for _, decl := range g.parsed[rel].Decls {
			funcDecl, ok := decl.(*ast.FuncDecl)
			if !ok {
				continue
			}
			function, ok := g.info.Defs[funcDecl.Name].(*types.Func)
			if !ok {
				continue
			}
			if excluded && signatureCarriesRouter(funcDecl.Type) {
				forbidden[function] = excludedFileMount{symbol: funcSymbol(function), source: rel, reason: exclusion.Reason}
				continue
			}
			if funcDecl.Body != nil {
				declarations = append(declarations, declaration{function: function, body: funcDecl.Body})
			}
		}
	}
	for changed := true; changed; {
		changed = false
		for _, decl := range declarations {
			if _, done := forbidden[decl.function]; done {
				continue
			}
			var reached *excludedFileMount
			var reachedSymbol string
			ast.Inspect(decl.body, func(node ast.Node) bool {
				if reached != nil {
					return false
				}
				ident, ok := node.(*ast.Ident)
				if !ok {
					return true
				}
				if used, ok := g.info.Uses[ident].(*types.Func); ok {
					if mount, found := forbidden[used.Origin()]; found {
						reached = &mount
						reachedSymbol = funcSymbol(used.Origin())
					}
				}
				return true
			})
			if reached != nil {
				via := reachedSymbol
				if reached.via != "" {
					via = reached.via
				}
				forbidden[decl.function] = excludedFileMount{symbol: funcSymbol(decl.function), source: reached.source, reason: reached.reason, via: via}
				changed = true
			}
		}
	}
}

// signatureCarriesRouter reports whether a function can register routes the
// caller does not see written out: it takes a router, returns one, or takes or
// returns a function that does. Routers are recognised exactly as the scan
// recognises registration receivers (isRouterType).
func signatureCarriesRouter(function *ast.FuncType) bool {
	if function == nil {
		return false
	}
	for _, fields := range []*ast.FieldList{function.Params, function.Results} {
		if fields == nil {
			continue
		}
		for _, field := range fields.List {
			if isRouterType(field.Type) {
				return true
			}
			if nested, ok := field.Type.(*ast.FuncType); ok && signatureCarriesRouter(nested) {
				return true
			}
		}
	}
	return false
}

// funcSymbol renders a function as pkg.Name or a method as pkg.(*Type).Name.
func funcSymbol(function *types.Func) string {
	if function.Pkg() == nil {
		return function.Name()
	}
	if receiver := function.Signature().Recv(); receiver != nil {
		recv := types.TypeString(receiver.Type(), types.RelativeTo(function.Pkg()))
		if strings.HasPrefix(recv, "*") {
			recv = "(" + recv + ")"
		}
		return function.Pkg().Name() + "." + recv + "." + function.Name()
	}
	return function.Pkg().Name() + "." + function.Name()
}

// importerFunc adapts a function to types.Importer.
type importerFunc func(path string) (*types.Package, error)

func (f importerFunc) Import(path string) (*types.Package, error) { return f(path) }

var majorVersionElement = regexp.MustCompile(`^v[0-9]+$`)

// stubPackageName guesses the name an import declares from its path alone
// (github.com/go-chi/chi/v5 declares chi, gopkg.in/yaml.v3 declares yaml).
func stubPackageName(importPath string) string {
	elements := strings.Split(importPath, "/")
	name := elements[len(elements)-1]
	if len(elements) > 1 && majorVersionElement.MatchString(name) {
		name = elements[len(elements)-2]
	}
	if cut := strings.IndexByte(name, '.'); cut > 0 {
		name = name[:cut]
	}
	return strings.ReplaceAll(name, "-", "_")
}

func loadRouteReachabilityPolicy(repoRoot string) (routeReachabilityPolicy, error) {
	var policy routeReachabilityPolicy
	path := filepath.Join(repoRoot, filepath.FromSlash(routeReachabilityPolicyPath))
	body, err := readLocalFile(path)
	if err != nil {
		return policy, fmt.Errorf("read %s: %w", routeReachabilityPolicyPath, err)
	}
	if err := json.Unmarshal(body, &policy); err != nil {
		return policy, fmt.Errorf("parse %s: %w", routeReachabilityPolicyPath, err)
	}
	if policy.Version != 1 {
		return policy, fmt.Errorf("%s must declare version 1", routeReachabilityPolicyPath)
	}
	compositionRoot, err := normalizePolicyPath(policy.CompositionRoot, "composition_root", false)
	if err != nil {
		return policy, err
	}
	policy.CompositionRoot = compositionRoot
	if policy.AdditionalSources == nil {
		return policy, fmt.Errorf("%s additional_sources must be an array", routeReachabilityPolicyPath)
	}
	if policy.ForbiddenCompositionCalls == nil {
		return policy, fmt.Errorf("%s forbidden_composition_calls must be an array", routeReachabilityPolicyPath)
	}
	if policy.ExcludedRoutes == nil {
		return policy, fmt.Errorf("%s excluded_routes must be an array", routeReachabilityPolicyPath)
	}
	if policy.ExcludedSources == nil {
		return policy, fmt.Errorf("%s excluded_sources must be an array", routeReachabilityPolicyPath)
	}
	symbolPattern := regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$`)
	requiredCallSymbolPattern := regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$`)
	identifierPattern := regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	for name, entries := range map[string][]routeSourcePolicyEntry{
		"additional_sources": policy.AdditionalSources,
		"excluded_sources":   policy.ExcludedSources,
	} {
		for i := range entries {
			normalized, err := normalizePolicyPath(entries[i].Path, fmt.Sprintf("%s[%d].path", name, i), true)
			if err != nil {
				return policy, err
			}
			if strings.TrimSpace(entries[i].Reason) == "" {
				return policy, fmt.Errorf("%s %s[%d].reason must be non-empty", routeReachabilityPolicyPath, name, i)
			}
			entries[i].Path = normalized
			entries[i].Reason = strings.TrimSpace(entries[i].Reason)
			if name == "additional_sources" {
				if len(entries[i].RequiredCalls) == 0 {
					return policy, fmt.Errorf("%s %s[%d].required_calls must be a non-empty array", routeReachabilityPolicyPath, name, i)
				}
				for callIndex := range entries[i].RequiredCalls {
					call := &entries[i].RequiredCalls[callIndex]
					callSource, err := normalizePolicyPath(call.Source, fmt.Sprintf("%s[%d].required_calls[%d].source", name, i, callIndex), false)
					if err != nil {
						return policy, err
					}
					if !strings.HasSuffix(callSource, ".go") {
						return policy, fmt.Errorf("%s %s[%d].required_calls[%d].source must name a Go file", routeReachabilityPolicyPath, name, i, callIndex)
					}
					call.Source = callSource
					call.Function = strings.TrimSpace(call.Function)
					if !identifierPattern.MatchString(call.Function) {
						return policy, fmt.Errorf("%s %s[%d].required_calls[%d].function is invalid", routeReachabilityPolicyPath, name, i, callIndex)
					}
					call.Symbol = strings.TrimSpace(call.Symbol)
					if !requiredCallSymbolPattern.MatchString(call.Symbol) {
						return policy, fmt.Errorf("%s %s[%d].required_calls[%d].symbol is invalid", routeReachabilityPolicyPath, name, i, callIndex)
					}
				}
			} else if len(entries[i].RequiredCalls) != 0 {
				return policy, fmt.Errorf("%s %s[%d].required_calls is only valid for additional_sources", routeReachabilityPolicyPath, name, i)
			}
		}
		if name == "additional_sources" {
			policy.AdditionalSources = entries
		} else {
			policy.ExcludedSources = entries
		}
	}
	allowedMethods := map[string]bool{
		"GET": true, "POST": true, "PUT": true, "PATCH": true,
		"DELETE": true, "HEAD": true, "OPTIONS": true,
	}
	for i := range policy.ExcludedRoutes {
		entry := &policy.ExcludedRoutes[i]
		entry.Method = strings.ToUpper(strings.TrimSpace(entry.Method))
		if !allowedMethods[entry.Method] {
			return policy, fmt.Errorf("%s excluded_routes[%d].method is invalid", routeReachabilityPolicyPath, i)
		}
		entry.Path = canonicalOpenAPIPath(strings.TrimSpace(entry.Path))
		if !isAPIPath(entry.Path) {
			return policy, fmt.Errorf("%s excluded_routes[%d].path must be /api or start with /api/", routeReachabilityPolicyPath, i)
		}
		entry.Reason = strings.TrimSpace(entry.Reason)
		if entry.Reason == "" {
			return policy, fmt.Errorf("%s excluded_routes[%d].reason must be non-empty", routeReachabilityPolicyPath, i)
		}
	}
	for i := range policy.ForbiddenCompositionCalls {
		entry := &policy.ForbiddenCompositionCalls[i]
		entry.Symbol = strings.TrimSpace(entry.Symbol)
		if !symbolPattern.MatchString(entry.Symbol) {
			return policy, fmt.Errorf("%s forbidden_composition_calls[%d].symbol is invalid", routeReachabilityPolicyPath, i)
		}
		entry.Reason = strings.TrimSpace(entry.Reason)
		if entry.Reason == "" {
			return policy, fmt.Errorf("%s forbidden_composition_calls[%d].reason must be non-empty", routeReachabilityPolicyPath, i)
		}
	}
	return policy, nil
}

// loadOpenAPIExemptions validates the exact method+path exceptions that remain
// intentionally gateway-only. Every exception must still be mounted, absent
// from OpenAPI, and covered by a reviewed route-contract category plus reason.
// This makes the exception file a fail-closed disposition list rather than an
// ignore glob: deleting a route, documenting it, or removing its review makes
// regeneration fail until the stale exception is removed.
func loadOpenAPIExemptions(
	repoRoot string,
	routes []Route,
	existingOperations map[string]map[string]bool,
) (map[string]bool, error) {
	path := filepath.Join(repoRoot, filepath.FromSlash(openAPIExemptionsPolicyPath))
	body, err := readLocalFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", openAPIExemptionsPolicyPath, err)
	}
	var policy openAPIExemptionsPolicy
	if err := json.Unmarshal(body, &policy); err != nil {
		return nil, fmt.Errorf("parse %s: %w", openAPIExemptionsPolicyPath, err)
	}
	if policy.Version != 1 || policy.Routes == nil {
		return nil, fmt.Errorf("%s must declare version 1 and routes[]", openAPIExemptionsPolicyPath)
	}

	contracts, err := loadReviewedRouteContracts(repoRoot)
	if err != nil {
		return nil, err
	}
	mounted := make(map[string]bool, len(routes))
	for _, route := range routes {
		mounted[route.Method+" "+route.Path] = true
	}
	exemptions := make(map[string]bool, len(policy.Routes))
	previous := ""
	for index, raw := range policy.Routes {
		route := strings.TrimSpace(raw)
		if route == "" || route != raw {
			return nil, fmt.Errorf("%s routes[%d] must be a non-empty trimmed method+path", openAPIExemptionsPolicyPath, index)
		}
		if previous != "" && route <= previous {
			return nil, fmt.Errorf("%s routes must be unique and lexicographically sorted", openAPIExemptionsPolicyPath)
		}
		previous = route
		space := strings.IndexByte(route, ' ')
		if space <= 0 || space == len(route)-1 || !isAPIPath(route[space+1:]) {
			return nil, fmt.Errorf("%s routes[%d] is not an exact METHOD /api or METHOD /api/... key", openAPIExemptionsPolicyPath, index)
		}
		method, routePath := route[:space], route[space+1:]
		switch method {
		case "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "ANY":
		default:
			return nil, fmt.Errorf("%s routes[%d] has unsupported method %s", openAPIExemptionsPolicyPath, index, method)
		}
		if canonicalOpenAPIPath(routePath) != routePath {
			return nil, fmt.Errorf("%s routes[%d] must use canonical OpenAPI path parameters", openAPIExemptionsPolicyPath, index)
		}
		if !mounted[route] {
			return nil, fmt.Errorf("stale OpenAPI exemption %s is no longer a reachable route", route)
		}
		if existingOperations[routePath][strings.ToLower(method)] {
			return nil, fmt.Errorf("stale OpenAPI exemption %s is now documented", route)
		}
		contract := exactReviewedContractFor(route, contracts)
		if contract == nil {
			if method == "ANY" {
				return nil, fmt.Errorf("OpenAPI exemption %s has no reviewed route-contract: a method-agnostic route requires an exact route rule, never a gateway_only_routes membership", route)
			}
			return nil, fmt.Errorf("OpenAPI exemption %s has no reviewed route-contract", route)
		}
		exemptions[route] = true
	}
	for _, route := range routes {
		if route.Method != "ANY" {
			continue
		}
		key := route.Method + " " + route.Path
		if !exemptions[key] {
			return nil, fmt.Errorf("method-agnostic route %s requires an exact reviewed ANY exemption; OpenAPI cannot represent Handle/HandleFunc as an any operation", key)
		}
	}
	return exemptions, nil
}

func loadReviewedRouteContracts(repoRoot string) ([]routeContractRule, error) {
	path := filepath.Join(repoRoot, filepath.FromSlash(routeContractsPolicyPath))
	body, err := readLocalFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", routeContractsPolicyPath, err)
	}
	var document routeContractsDocument
	if err := json.Unmarshal(body, &document); err != nil {
		return nil, fmt.Errorf("parse %s: %w", routeContractsPolicyPath, err)
	}
	if document.Rules == nil {
		return nil, fmt.Errorf("%s must contain rules[]", routeContractsPolicyPath)
	}
	memberships := map[string]int{}
	for index := range document.Rules {
		rule := &document.Rules[index]
		rule.Route = strings.TrimSpace(rule.Route)
		rule.Pattern = strings.TrimSpace(rule.Pattern)
		rule.Exposure = strings.TrimSpace(rule.Exposure)
		rule.Reason = strings.TrimSpace(rule.Reason)
		if (rule.Route == "") == (rule.Pattern == "") {
			return nil, fmt.Errorf("%s rule %d must contain exactly one route or pattern", routeContractsPolicyPath, index)
		}
		if rule.Exposure == "" || provisionalExposureRe.MatchString(rule.Exposure) || rule.Reason == "" {
			return nil, fmt.Errorf("%s rule %d lacks a reviewed exposure and reason", routeContractsPolicyPath, index)
		}
		if !reviewedRouteContractExposures[rule.Exposure] {
			return nil, fmt.Errorf("%s rule %d has unknown exposure category %q", routeContractsPolicyPath, index, rule.Exposure)
		}
		if rule.Route != "" && rule.GatewayOnlyRoutes != nil {
			return nil, fmt.Errorf("%s rule %d exact route must not define gateway_only_routes", routeContractsPolicyPath, index)
		}
		if rule.Pattern != "" {
			// JavaScript's non-capturing groups have identical matching semantics
			// to ordinary groups here; Go's RE2 syntax omits the `?:` spelling.
			pattern := strings.ReplaceAll(rule.Pattern, "(?:", "(")
			compiled, err := regexp.Compile(pattern)
			if err != nil {
				return nil, fmt.Errorf("compile %s rule %d: %w", routeContractsPolicyPath, index, err)
			}
			rule.compiled = compiled
		}
		// A membership borrows its rule's reviewed exposure and reason, so it is
		// honoured only inside the family the rule was reviewed for, and only
		// once — the same compile-time contract route-contracts.mjs enforces.
		for _, member := range rule.GatewayOnlyRoutes {
			if !rule.compiled.MatchString(member) {
				return nil, fmt.Errorf("%s rule %d gateway_only_routes entry %s does not match %s", routeContractsPolicyPath, index, member, rule.Pattern)
			}
			if previous, duplicate := memberships[member]; duplicate {
				return nil, fmt.Errorf("%s rule %d gateway_only_routes duplicates membership %s from rule %d", routeContractsPolicyPath, index, member, previous)
			}
			memberships[member] = index
		}
	}
	// An exact rule always wins the lookup, so a membership that names the same
	// route is dead policy that disagrees with it; route-contracts.mjs refuses
	// the document, and so does this.
	for index := range document.Rules {
		if route := document.Rules[index].Route; route != "" {
			if owner, shadowed := memberships[route]; shadowed {
				return nil, fmt.Errorf("%s rule %d gateway_only_routes entry %s is shadowed by exact route rule %d", routeContractsPolicyPath, owner, route, index)
			}
		}
	}
	return document.Rules, nil
}

func exactReviewedContractFor(route string, contracts []routeContractRule) *routeContractRule {
	// AST exemptions are per-operation dispositions: an exact route rule, or an
	// exact entry in a reviewed pattern rule's gateway_only_routes. A pattern
	// match alone is insufficient because changing or removing one route must
	// make its own exemption stale instead of silently inheriting an older
	// classification; an enumerated membership is itself per-route, and the
	// parity gate fails it as stale once the route is unmounted or documented.
	for index := range contracts {
		if contracts[index].Route == route {
			return &contracts[index]
		}
	}
	// A method-agnostic Handle/HandleFunc registration answers every verb with
	// one handler, so it never borrows a family's disposition: route-contracts.mjs
	// validateGatewayOnlyContracts (requireExactAny) demands an exact rule for
	// every ANY route, and so does this.
	if strings.HasPrefix(route, "ANY ") {
		return nil
	}
	for index := range contracts {
		for _, member := range contracts[index].GatewayOnlyRoutes {
			if member == route {
				return &contracts[index]
			}
		}
	}
	return nil
}

func validateAdditionalSourceCalls(repoRoot string, sources []routeSourcePolicyEntry) error {
	parsedFiles := make(map[string]*ast.File)
	for _, source := range sources {
		for _, required := range source.RequiredCalls {
			parsed := parsedFiles[required.Source]
			if parsed == nil {
				path := filepath.Join(repoRoot, filepath.FromSlash(required.Source))
				var err error
				parsed, err = parser.ParseFile(token.NewFileSet(), path, nil, parser.SkipObjectResolution)
				if err != nil {
					return fmt.Errorf("parse required mount source %s for %s: %w", required.Source, source.Path, err)
				}
				parsedFiles[required.Source] = parsed
			}

			var declarations []*ast.FuncDecl
			for _, declaration := range parsed.Decls {
				function, ok := declaration.(*ast.FuncDecl)
				if ok && function.Name.Name == required.Function {
					declarations = append(declarations, function)
				}
			}
			if len(declarations) != 1 {
				return fmt.Errorf("required mount function %s in %s for %s is missing or ambiguous", required.Function, required.Source, source.Path)
			}
			found := false
			ast.Inspect(declarations[0].Body, func(node ast.Node) bool {
				call, ok := node.(*ast.CallExpr)
				if ok && callSymbol(call.Fun) == required.Symbol {
					found = true
					return false
				}
				return !found
			})
			if !found {
				return fmt.Errorf("required mount call %s in %s#%s is absent; %s is not reachable", required.Symbol, required.Source, required.Function, source.Path)
			}
		}
	}
	return nil
}

func normalizePolicyPath(value, field string, requireInternal bool) (string, error) {
	normalized := strings.TrimSuffix(strings.TrimPrefix(filepath.ToSlash(strings.TrimSpace(value)), "./"), "/")
	if normalized == "" || filepath.IsAbs(normalized) || normalized == ".." || strings.HasPrefix(normalized, "../") || strings.Contains(normalized, "/../") {
		return "", fmt.Errorf("%s %s must be a repository-relative path", routeReachabilityPolicyPath, field)
	}
	if requireInternal && !strings.HasPrefix(normalized, apiInternalSourcePrefix) {
		return "", fmt.Errorf("%s %s must be under %s", routeReachabilityPolicyPath, field, apiInternalSourcePrefix)
	}
	return normalized, nil
}

func sourceMatchesRoot(source, root string) bool {
	return source == root || strings.HasPrefix(source, root+"/")
}

func callSymbol(expr ast.Expr) string {
	switch value := expr.(type) {
	case *ast.Ident:
		return value.Name
	case *ast.SelectorExpr:
		prefix := callSymbol(value.X)
		if prefix == "" {
			return value.Sel.Name
		}
		return prefix + "." + value.Sel.Name
	default:
		return ""
	}
}

func routeSourceExcluded(source string, exclusions []routeSourcePolicyEntry) bool {
	for _, exclusion := range exclusions {
		if sourceMatchesRoot(source, exclusion.Path) {
			return true
		}
	}
	return false
}

func scanFile(repoRoot, path string, seen map[string]Route, warnings *[]string) error {
	// Per-package tag — the directory name. A main.go outside the composition
	// package keeps the historical "Core" tag; extractRoutes tags every
	// composition-package file "Core" explicitly.
	tag := strings.Title(strings.ReplaceAll(filepath.Base(filepath.Dir(path)), "_", " "))
	if filepath.Base(path) == "main.go" {
		tag = compositionRouteTag
	}
	return scanFileWithTag(repoRoot, path, tag, seen, warnings)
}

func scanFileWithTag(repoRoot, path, tag string, seen map[string]Route, warnings *[]string) error {
	body, err := readLocalFile(path)
	if err != nil {
		return err
	}
	src := string(body)
	fset := token.NewFileSet()
	parsed, err := parser.ParseFile(fset, path, body, parser.SkipObjectResolution)
	if err != nil {
		return fmt.Errorf("parse reachable route source %s: %w", path, err)
	}
	rel, _ := filepath.Rel(repoRoot, path)
	rel = filepath.ToSlash(rel)
	routerFields := collectRouterFields(parsed)
	stringConstants := collectStringConstants(parsed)
	for _, declaration := range parsed.Decls {
		function, ok := declaration.(*ast.FuncDecl)
		if !ok || function.Body == nil {
			continue
		}
		routerNames := routerNamesFromFields(function.Type.Params)
		structNames := structNamesFromFields(function.Type.Params, routerFields)
		for name, typeName := range structNamesFromFields(function.Recv, routerFields) {
			structNames[name] = typeName
		}
		scanRouteBlock(src, rel, fset, function.Body, routerNames, structNames, routerFields, stringConstants, "", tag, seen, warnings)
	}
	return nil
}

// exprSource returns the exact source slice for an AST expression. Keeping the
// handler spelling makes generated summaries useful without relying on Go's
// printer or rewriting the source file.
func exprSource(src string, fset *token.FileSet, expr ast.Expr) string {
	start := fset.Position(expr.Pos()).Offset
	end := fset.Position(expr.End()).Offset
	if start < 0 || end < start || end > len(src) {
		return ""
	}
	return src[start:end]
}

func compactSource(src string) string { return strings.Join(strings.Fields(src), " ") }

type routerFieldIndex map[string]map[string]bool

func collectRouterFields(file *ast.File) routerFieldIndex {
	fields := routerFieldIndex{}
	for _, declaration := range file.Decls {
		general, ok := declaration.(*ast.GenDecl)
		if !ok || general.Tok != token.TYPE {
			continue
		}
		for _, rawSpec := range general.Specs {
			typeSpec, ok := rawSpec.(*ast.TypeSpec)
			if !ok {
				continue
			}
			structure, ok := typeSpec.Type.(*ast.StructType)
			if !ok {
				continue
			}
			owner := typeSpec.Name.Name
			for _, field := range structure.Fields.List {
				if !isRouterType(field.Type) {
					continue
				}
				if fields[owner] == nil {
					fields[owner] = map[string]bool{}
				}
				for _, name := range field.Names {
					fields[owner][name.Name] = true
				}
			}
		}
	}
	return fields
}

// collectStringConstants performs bounded same-file propagation for literal
// path constants. It intentionally does not evaluate variables, function
// calls, formatting, or cross-package symbols: those remain dynamic and are
// warned about instead of guessed.
func collectStringConstants(file *ast.File) map[string]string {
	constants := map[string]string{}
	changed := true
	for changed {
		changed = false
		for _, declaration := range file.Decls {
			general, ok := declaration.(*ast.GenDecl)
			if !ok || general.Tok != token.CONST {
				continue
			}
			for _, rawSpec := range general.Specs {
				spec, ok := rawSpec.(*ast.ValueSpec)
				if !ok {
					continue
				}
				for index, name := range spec.Names {
					if _, exists := constants[name.Name]; exists || index >= len(spec.Values) {
						continue
					}
					value, ok := resolveStaticString(spec.Values[index], constants)
					if ok {
						constants[name.Name] = value
						changed = true
					}
				}
			}
		}
	}
	return constants
}

func resolveStaticString(expr ast.Expr, constants map[string]string) (string, bool) {
	switch value := expr.(type) {
	case *ast.BasicLit:
		if value.Kind != token.STRING {
			return "", false
		}
		decoded, err := strconv.Unquote(value.Value)
		return decoded, err == nil
	case *ast.Ident:
		resolved, ok := constants[value.Name]
		return resolved, ok
	case *ast.BinaryExpr:
		if value.Op != token.ADD {
			return "", false
		}
		left, leftOK := resolveStaticString(value.X, constants)
		right, rightOK := resolveStaticString(value.Y, constants)
		return left + right, leftOK && rightOK
	case *ast.ParenExpr:
		return resolveStaticString(value.X, constants)
	}
	return "", false
}

func routerNamesFromFields(fields *ast.FieldList) map[string]bool {
	names := map[string]bool{}
	if fields == nil {
		return names
	}
	for _, field := range fields.List {
		if !isRouterType(field.Type) {
			continue
		}
		for _, name := range field.Names {
			names[name.Name] = true
		}
	}
	return names
}

func structNamesFromFields(fields *ast.FieldList, routerFields routerFieldIndex) map[string]string {
	names := map[string]string{}
	if fields == nil {
		return names
	}
	for _, field := range fields.List {
		typeName, ok := namedType(field.Type)
		if !ok || routerFields[typeName] == nil {
			continue
		}
		for _, name := range field.Names {
			names[name.Name] = typeName
		}
	}
	return names
}

func namedType(expr ast.Expr) (string, bool) {
	switch value := expr.(type) {
	case *ast.Ident:
		return value.Name, true
	case *ast.StarExpr:
		return namedType(value.X)
	case *ast.ParenExpr:
		return namedType(value.X)
	}
	return "", false
}

// isRouterType recognizes explicit chi routers and narrow router interfaces.
// It deliberately does not infer from a variable name: repository methods use
// receivers named r throughout the codebase, and treating the name as proof is
// what turns r.Get(ctx, ...) into a phantom HTTP route.
func isRouterType(expr ast.Expr) bool {
	switch value := expr.(type) {
	case *ast.SelectorExpr:
		pkg, ok := value.X.(*ast.Ident)
		return ok && pkg.Name == "chi" && (value.Sel.Name == "Router" || value.Sel.Name == "Mux")
	case *ast.StarExpr:
		return isRouterType(value.X)
	case *ast.InterfaceType:
		for _, method := range value.Methods.List {
			for _, name := range method.Names {
				function, ok := method.Type.(*ast.FuncType)
				if ok && isRouterMethodSignature(name.Name, function) {
					return true
				}
			}
		}
	}
	return false
}

func isRouterMethodSignature(name string, function *ast.FuncType) bool {
	if function == nil || function.Params == nil || len(function.Params.List) == 0 {
		return false
	}
	stringAt := func(index int) bool {
		position := 0
		for _, parameter := range function.Params.List {
			width := len(parameter.Names)
			if width == 0 {
				width = 1
			}
			if index >= position && index < position+width {
				identifier, ok := parameter.Type.(*ast.Ident)
				return ok && identifier.Name == "string"
			}
			position += width
		}
		return false
	}
	if _, ok := routeMethods[name]; ok {
		return stringAt(0)
	}
	switch name {
	case "Method", "MethodFunc":
		return stringAt(0) && stringAt(1)
	case "Handle", "HandleFunc":
		return stringAt(0)
	}
	return false
}

func copyNames(names map[string]bool) map[string]bool {
	copy := make(map[string]bool, len(names))
	for name := range names {
		copy[name] = true
	}
	return copy
}

func copyStructNames(names map[string]string) map[string]string {
	copy := make(map[string]string, len(names))
	for name, typeName := range names {
		copy[name] = typeName
	}
	return copy
}

func scanRouteBlock(
	src, rel string,
	fset *token.FileSet,
	body *ast.BlockStmt,
	inherited map[string]bool,
	inheritedStructs map[string]string,
	routerFields routerFieldIndex,
	stringConstants map[string]string,
	routePrefix string,
	tag string,
	seen map[string]Route,
	warnings *[]string,
) {
	routerNames := copyNames(inherited)
	structNames := copyStructNames(inheritedStructs)
	for _, statement := range body.List {
		scanRouteStatement(src, rel, fset, statement, routerNames, structNames, routerFields, stringConstants, routePrefix, tag, seen, warnings)
	}
}

func scanRouteStatement(
	src, rel string,
	fset *token.FileSet,
	statement ast.Stmt,
	routerNames map[string]bool,
	structNames map[string]string,
	routerFields routerFieldIndex,
	stringConstants map[string]string,
	routePrefix string,
	tag string,
	seen map[string]Route,
	warnings *[]string,
) {
	scanExpr := func(expr ast.Expr) {
		scanRouteExpression(src, rel, fset, expr, routerNames, structNames, routerFields, stringConstants, routePrefix, tag, seen, warnings)
	}
	scanNested := func(block *ast.BlockStmt, routers map[string]bool, structs map[string]string) {
		scanRouteBlock(src, rel, fset, block, routers, structs, routerFields, stringConstants, routePrefix, tag, seen, warnings)
	}

	switch value := statement.(type) {
	case *ast.BlockStmt:
		scanNested(value, copyNames(routerNames), copyStructNames(structNames))
	case *ast.ExprStmt:
		scanExpr(value.X)
	case *ast.AssignStmt:
		for _, expr := range value.Rhs {
			scanExpr(expr)
		}
		// Every RHS in a Go assignment is evaluated before any LHS is rebound.
		// Resolve provenance against one immutable snapshot so self-rebinding
		// (`r = r.With(...)`) and parallel short declarations cannot erase or
		// leak router identity based on LHS order.
		preAssignmentRouters := copyNames(routerNames)
		preAssignmentStructs := copyStructNames(structNames)
		rhsRouters := make([]bool, len(value.Rhs))
		rhsStructs := make([]string, len(value.Rhs))
		for index, expr := range value.Rhs {
			rhsRouters[index] = isRouterExpression(expr, preAssignmentRouters, preAssignmentStructs, routerFields)
			if typeName, ok := structTypeOfExpression(expr, preAssignmentStructs, routerFields); ok {
				rhsStructs[index] = typeName
			}
		}
		for index, lhs := range value.Lhs {
			name, ok := lhs.(*ast.Ident)
			if !ok || name.Name == "_" {
				continue
			}
			delete(routerNames, name.Name)
			delete(structNames, name.Name)
			if index >= len(value.Rhs) {
				continue
			}
			if rhsRouters[index] {
				routerNames[name.Name] = true
				continue
			}
			if rhsStructs[index] != "" {
				structNames[name.Name] = rhsStructs[index]
			}
		}
	case *ast.DeclStmt:
		general, ok := value.Decl.(*ast.GenDecl)
		if !ok {
			return
		}
		for _, rawSpec := range general.Specs {
			spec, ok := rawSpec.(*ast.ValueSpec)
			if !ok {
				continue
			}
			for _, expr := range spec.Values {
				scanExpr(expr)
			}
			for index, name := range spec.Names {
				delete(routerNames, name.Name)
				delete(structNames, name.Name)
				if isRouterType(spec.Type) {
					routerNames[name.Name] = true
					continue
				}
				if typeName, ok := namedType(spec.Type); ok && routerFields[typeName] != nil {
					structNames[name.Name] = typeName
					continue
				}
				if index >= len(spec.Values) {
					continue
				}
				if isRouterExpression(spec.Values[index], routerNames, structNames, routerFields) {
					routerNames[name.Name] = true
				} else if typeName, ok := structTypeOfExpression(spec.Values[index], structNames, routerFields); ok {
					structNames[name.Name] = typeName
				}
			}
		}
	case *ast.ReturnStmt:
		for _, expr := range value.Results {
			scanExpr(expr)
		}
	case *ast.DeferStmt:
		scanExpr(value.Call)
	case *ast.GoStmt:
		scanExpr(value.Call)
	case *ast.SendStmt:
		scanExpr(value.Chan)
		scanExpr(value.Value)
	case *ast.IncDecStmt:
		scanExpr(value.X)
	case *ast.IfStmt:
		branchRouters, branchStructs := copyNames(routerNames), copyStructNames(structNames)
		if value.Init != nil {
			scanRouteStatement(src, rel, fset, value.Init, branchRouters, branchStructs, routerFields, stringConstants, routePrefix, tag, seen, warnings)
		}
		scanRouteExpression(src, rel, fset, value.Cond, branchRouters, branchStructs, routerFields, stringConstants, routePrefix, tag, seen, warnings)
		scanNested(value.Body, branchRouters, branchStructs)
		if value.Else != nil {
			scanRouteStatement(src, rel, fset, value.Else, copyNames(branchRouters), copyStructNames(branchStructs), routerFields, stringConstants, routePrefix, tag, seen, warnings)
		}
	case *ast.ForStmt:
		loopRouters, loopStructs := copyNames(routerNames), copyStructNames(structNames)
		if value.Init != nil {
			scanRouteStatement(src, rel, fset, value.Init, loopRouters, loopStructs, routerFields, stringConstants, routePrefix, tag, seen, warnings)
		}
		if value.Cond != nil {
			scanRouteExpression(src, rel, fset, value.Cond, loopRouters, loopStructs, routerFields, stringConstants, routePrefix, tag, seen, warnings)
		}
		scanNested(value.Body, loopRouters, loopStructs)
		if value.Post != nil {
			scanRouteStatement(src, rel, fset, value.Post, loopRouters, loopStructs, routerFields, stringConstants, routePrefix, tag, seen, warnings)
		}
	case *ast.RangeStmt:
		scanExpr(value.X)
		loopRouters, loopStructs := copyNames(routerNames), copyStructNames(structNames)
		for _, expr := range []ast.Expr{value.Key, value.Value} {
			if name, ok := expr.(*ast.Ident); ok && name.Name != "_" {
				delete(loopRouters, name.Name)
				delete(loopStructs, name.Name)
			}
		}
		scanNested(value.Body, loopRouters, loopStructs)
	case *ast.SwitchStmt:
		scanSwitchBody(src, rel, fset, value.Init, value.Tag, value.Body, routerNames, structNames, routerFields, stringConstants, routePrefix, tag, seen, warnings)
	case *ast.TypeSwitchStmt:
		scanTypeSwitchBody(src, rel, fset, value, routerNames, structNames, routerFields, stringConstants, routePrefix, tag, seen, warnings)
	case *ast.SelectStmt:
		for _, rawClause := range value.Body.List {
			clause := rawClause.(*ast.CommClause)
			clauseRouters, clauseStructs := copyNames(routerNames), copyStructNames(structNames)
			if clause.Comm != nil {
				scanRouteStatement(src, rel, fset, clause.Comm, clauseRouters, clauseStructs, routerFields, stringConstants, routePrefix, tag, seen, warnings)
			}
			for _, child := range clause.Body {
				scanRouteStatement(src, rel, fset, child, clauseRouters, clauseStructs, routerFields, stringConstants, routePrefix, tag, seen, warnings)
			}
		}
	case *ast.LabeledStmt:
		scanRouteStatement(src, rel, fset, value.Stmt, routerNames, structNames, routerFields, stringConstants, routePrefix, tag, seen, warnings)
	}
}

func scanSwitchBody(
	src, rel string,
	fset *token.FileSet,
	init ast.Stmt,
	tagExpr ast.Expr,
	body *ast.BlockStmt,
	routerNames map[string]bool,
	structNames map[string]string,
	routerFields routerFieldIndex,
	stringConstants map[string]string,
	routePrefix string,
	operationTag string,
	seen map[string]Route,
	warnings *[]string,
) {
	switchRouters, switchStructs := copyNames(routerNames), copyStructNames(structNames)
	if init != nil {
		scanRouteStatement(src, rel, fset, init, switchRouters, switchStructs, routerFields, stringConstants, routePrefix, operationTag, seen, warnings)
	}
	if tagExpr != nil {
		scanRouteExpression(src, rel, fset, tagExpr, switchRouters, switchStructs, routerFields, stringConstants, routePrefix, operationTag, seen, warnings)
	}
	for _, rawClause := range body.List {
		clause := rawClause.(*ast.CaseClause)
		clauseRouters, clauseStructs := copyNames(switchRouters), copyStructNames(switchStructs)
		for _, expr := range clause.List {
			scanRouteExpression(src, rel, fset, expr, clauseRouters, clauseStructs, routerFields, stringConstants, routePrefix, operationTag, seen, warnings)
		}
		for _, statement := range clause.Body {
			scanRouteStatement(src, rel, fset, statement, clauseRouters, clauseStructs, routerFields, stringConstants, routePrefix, operationTag, seen, warnings)
		}
	}
}

// scanTypeSwitchBody gives the variable introduced by `switch value :=
// candidate.(type)` its clause-local identity. The binding shadows an outer
// router with the same name in every clause, becomes a proven router only for a
// single router case, and never escapes the switch.
func scanTypeSwitchBody(
	src, rel string,
	fset *token.FileSet,
	statement *ast.TypeSwitchStmt,
	routerNames map[string]bool,
	structNames map[string]string,
	routerFields routerFieldIndex,
	stringConstants map[string]string,
	routePrefix string,
	operationTag string,
	seen map[string]Route,
	warnings *[]string,
) {
	switchRouters, switchStructs := copyNames(routerNames), copyStructNames(structNames)
	if statement.Init != nil {
		scanRouteStatement(src, rel, fset, statement.Init, switchRouters, switchStructs, routerFields, stringConstants, routePrefix, operationTag, seen, warnings)
	}
	binding, asserted := typeSwitchBinding(statement.Assign)
	if asserted != nil {
		scanRouteExpression(src, rel, fset, asserted, switchRouters, switchStructs, routerFields, stringConstants, routePrefix, operationTag, seen, warnings)
	}
	for _, rawClause := range statement.Body.List {
		clause := rawClause.(*ast.CaseClause)
		clauseRouters, clauseStructs := copyNames(switchRouters), copyStructNames(switchStructs)
		if binding != "" {
			delete(clauseRouters, binding)
			delete(clauseStructs, binding)
			// With multiple case types, Go keeps the asserted interface type for
			// the binding. A single case type is the only bounded proof available
			// without type-checking the package.
			if len(clause.List) == 1 {
				caseType := clause.List[0]
				if isRouterType(caseType) {
					clauseRouters[binding] = true
				} else if typeName, ok := namedType(caseType); ok && routerFields[typeName] != nil {
					clauseStructs[binding] = typeName
				}
			}
		}
		for _, expr := range clause.List {
			scanRouteExpression(src, rel, fset, expr, clauseRouters, clauseStructs, routerFields, stringConstants, routePrefix, operationTag, seen, warnings)
		}
		for _, child := range clause.Body {
			scanRouteStatement(src, rel, fset, child, clauseRouters, clauseStructs, routerFields, stringConstants, routePrefix, operationTag, seen, warnings)
		}
	}
}

func typeSwitchBinding(statement ast.Stmt) (string, ast.Expr) {
	var lhs ast.Expr
	var rhs ast.Expr
	switch value := statement.(type) {
	case *ast.AssignStmt:
		if len(value.Lhs) != 1 || len(value.Rhs) != 1 {
			return "", nil
		}
		lhs, rhs = value.Lhs[0], value.Rhs[0]
	case *ast.ExprStmt:
		rhs = value.X
	default:
		return "", nil
	}
	assertion, ok := rhs.(*ast.TypeAssertExpr)
	if !ok || assertion.Type != nil {
		return "", nil
	}
	if identifier, ok := lhs.(*ast.Ident); ok && identifier.Name != "_" {
		return identifier.Name, assertion.X
	}
	return "", assertion.X
}

func scanRouteExpression(
	src, rel string,
	fset *token.FileSet,
	expr ast.Expr,
	routerNames map[string]bool,
	structNames map[string]string,
	routerFields routerFieldIndex,
	stringConstants map[string]string,
	routePrefix string,
	tag string,
	seen map[string]Route,
	warnings *[]string,
) {
	if expr == nil {
		return
	}
	ast.Inspect(expr, func(node ast.Node) bool {
		if literal, nested := node.(*ast.FuncLit); nested {
			nestedNames, nestedStructs := copyNames(routerNames), copyStructNames(structNames)
			for _, fields := range []*ast.FieldList{literal.Type.Params, literal.Type.Results} {
				if fields == nil {
					continue
				}
				for _, field := range fields.List {
					for _, name := range field.Names {
						delete(nestedNames, name.Name)
						delete(nestedStructs, name.Name)
					}
				}
			}
			for name := range routerNamesFromFields(literal.Type.Params) {
				nestedNames[name] = true
			}
			for name, typeName := range structNamesFromFields(literal.Type.Params, routerFields) {
				nestedStructs[name] = typeName
			}
			scanRouteBlock(src, rel, fset, literal.Body, nestedNames, nestedStructs, routerFields, stringConstants, routePrefix, tag, seen, warnings)
			return false
		}
		call, ok := node.(*ast.CallExpr)
		if !ok {
			return true
		}
		selector, ok := call.Fun.(*ast.SelectorExpr)
		if !ok || !isRouterExpression(selector.X, routerNames, structNames, routerFields) {
			return true
		}
		if selector.Sel.Name == "Route" {
			scanInlineChiRouteCall(src, rel, fset, call, routerNames, structNames, routerFields, stringConstants, routePrefix, tag, seen, warnings)
			// The callback was scanned with its composed prefix. Descending through
			// it again would emit unprefixed duplicates.
			return false
		}
		method, pathArg, handlerArg, routeCall := resolveRouteCall(selector.Sel.Name, call, stringConstants)
		if !routeCall {
			return true
		}
		if method == "" {
			line := fset.Position(call.Pos()).Line
			*warnings = append(*warnings, fmt.Sprintf("%s:%d: %s", rel, line, compactSource(exprSource(src, fset, call))))
			return true
		}
		routePath, static := resolveStaticString(pathArg, stringConstants)
		if !static {
			if !(rel == "apps/api/internal/mailchimpv3/handlers.go" && isMailchimpBaseRoute(pathArg)) {
				line := fset.Position(call.Pos()).Line
				*warnings = append(*warnings, fmt.Sprintf("%s:%d: %s", rel, line, compactSource(exprSource(src, fset, call))))
			}
			return true
		}
		routePath = composeRoutePath(routePrefix, routePath)
		if !isAPIPath(routePath) {
			return true
		}
		routePath = canonicalOpenAPIPath(routePath)
		line := fset.Position(call.Pos()).Line
		seen[method+" "+routePath] = Route{
			Method: method, Path: routePath,
			Handler: strings.TrimSpace(exprSource(src, fset, handlerArg)),
			Tag:     tag, Source: fmt.Sprintf("%s:%d", rel, line),
		}
		return true
	})
}

func scanInlineChiRouteCall(
	src, rel string,
	fset *token.FileSet,
	call *ast.CallExpr,
	routerNames map[string]bool,
	structNames map[string]string,
	routerFields routerFieldIndex,
	stringConstants map[string]string,
	routePrefix string,
	tag string,
	seen map[string]Route,
	warnings *[]string,
) {
	warn := func() {
		line := fset.Position(call.Pos()).Line
		*warnings = append(*warnings, fmt.Sprintf("%s:%d: %s", rel, line, compactSource(exprSource(src, fset, call))))
	}
	if len(call.Args) < 2 {
		warn()
		return
	}
	prefix, static := resolveStaticString(call.Args[0], stringConstants)
	if !static {
		warn()
		return
	}
	callback, ok := functionLiteral(call.Args[1])
	if !ok {
		// Following a callback declared elsewhere requires package type/call-graph
		// analysis and remains the authoritative reachability scanner's job. Do
		// not silently pretend the bounded AST scan resolved it.
		warn()
		return
	}

	nestedNames, nestedStructs := copyNames(routerNames), copyStructNames(structNames)
	for _, fields := range []*ast.FieldList{callback.Type.Params, callback.Type.Results} {
		if fields == nil {
			continue
		}
		for _, field := range fields.List {
			for _, name := range field.Names {
				delete(nestedNames, name.Name)
				delete(nestedStructs, name.Name)
			}
		}
	}
	for name := range routerNamesFromFields(callback.Type.Params) {
		nestedNames[name] = true
	}
	for name, typeName := range structNamesFromFields(callback.Type.Params, routerFields) {
		nestedStructs[name] = typeName
	}
	scanRouteBlock(src, rel, fset, callback.Body, nestedNames, nestedStructs, routerFields, stringConstants, composeRoutePath(routePrefix, prefix), tag, seen, warnings)
}

func functionLiteral(expr ast.Expr) (*ast.FuncLit, bool) {
	for {
		switch value := expr.(type) {
		case *ast.FuncLit:
			return value, true
		case *ast.ParenExpr:
			expr = value.X
		default:
			return nil, false
		}
	}
}

func structTypeOfExpression(expr ast.Expr, structs map[string]string, routerFields routerFieldIndex) (string, bool) {
	switch value := expr.(type) {
	case *ast.Ident:
		typeName, ok := structs[value.Name]
		return typeName, ok
	case *ast.CompositeLit:
		typeName, ok := namedType(value.Type)
		return typeName, ok && routerFields[typeName] != nil
	case *ast.UnaryExpr:
		if value.Op == token.AND {
			return structTypeOfExpression(value.X, structs, routerFields)
		}
	case *ast.ParenExpr:
		return structTypeOfExpression(value.X, structs, routerFields)
	}
	return "", false
}

func resolveRouteCall(methodName string, call *ast.CallExpr, constants map[string]string) (string, ast.Expr, ast.Expr, bool) {
	if method, ok := routeMethods[methodName]; ok {
		if len(call.Args) < 2 {
			return "", nil, nil, false
		}
		return method, call.Args[0], call.Args[1], true
	}
	switch methodName {
	case "Method", "MethodFunc":
		if len(call.Args) < 3 {
			return "", nil, nil, false
		}
		method, ok := resolveHTTPMethod(call.Args[0], constants)
		if !ok {
			return "", call.Args[1], call.Args[2], true
		}
		return method, call.Args[1], call.Args[2], true
	case "Handle", "HandleFunc":
		if len(call.Args) < 2 {
			return "", nil, nil, false
		}
		return "ANY", call.Args[0], call.Args[1], true
	}
	return "", nil, nil, false
}

func resolveHTTPMethod(expr ast.Expr, constants map[string]string) (string, bool) {
	if selector, ok := expr.(*ast.SelectorExpr); ok {
		pkg, pkgOK := selector.X.(*ast.Ident)
		if pkgOK && pkg.Name == "http" && strings.HasPrefix(selector.Sel.Name, "Method") {
			method := strings.ToUpper(strings.TrimPrefix(selector.Sel.Name, "Method"))
			switch method {
			case "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS":
				return method, true
			}
		}
	}
	method, ok := resolveStaticString(expr, constants)
	if !ok {
		return "", false
	}
	method = strings.ToUpper(strings.TrimSpace(method))
	switch method {
	case "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS":
		return method, true
	}
	return "", false
}

func isRouterExpression(expr ast.Expr, routerNames map[string]bool, structNames map[string]string, routerFields routerFieldIndex) bool {
	switch value := expr.(type) {
	case *ast.Ident:
		return routerNames[value.Name]
	case *ast.SelectorExpr:
		owner, ok := value.X.(*ast.Ident)
		if !ok {
			return false
		}
		return routerFields[structNames[owner.Name]][value.Sel.Name]
	case *ast.CallExpr:
		selector, ok := value.Fun.(*ast.SelectorExpr)
		if !ok {
			return false
		}
		if pkg, ok := selector.X.(*ast.Ident); ok && pkg.Name == "chi" &&
			(selector.Sel.Name == "NewRouter" || selector.Sel.Name == "NewMux") {
			return true
		}
		switch selector.Sel.Name {
		case "With", "Group", "Route":
			return isRouterExpression(selector.X, routerNames, structNames, routerFields)
		}
	case *ast.ParenExpr:
		return isRouterExpression(value.X, routerNames, structNames, routerFields)
	}
	return false
}

// The Mailchimp compatibility mount deliberately builds paths from its
// reviewed base prefix. The reachability inventory expands that mount chain,
// so these are not unknown dynamic paths.
func isMailchimpBaseRoute(expr ast.Expr) bool {
	switch value := expr.(type) {
	case *ast.Ident:
		return value.Name == "base"
	case *ast.BinaryExpr:
		return value.Op == token.ADD && isMailchimpBaseRoute(value.X)
	case *ast.ParenExpr:
		return isMailchimpBaseRoute(value.X)
	}
	return false
}

func composeRoutePath(prefix, path string) string {
	if prefix == "" {
		return path
	}
	if path == "" {
		return prefix
	}
	if strings.HasSuffix(prefix, "/") && strings.HasPrefix(path, "/") {
		return prefix + strings.TrimPrefix(path, "/")
	}
	if !strings.HasSuffix(prefix, "/") && !strings.HasPrefix(path, "/") {
		return prefix + "/" + path
	}
	return prefix + path
}

func isAPIPath(path string) bool {
	return path == "/api" || strings.HasPrefix(path, "/api/")
}

func canonicalOpenAPIPath(path string) string {
	path = pathParamRe.ReplaceAllString(path, `{$1}`)
	if strings.HasSuffix(path, "/*") {
		path = strings.TrimSuffix(path, "/*") + "/{rest}"
	}
	return path
}

// insertIntoPathsBlock splices `stubs` into `yaml` at the end of the
// `paths:` top-level mapping — i.e. just before the next top-level key
// (a non-indented `key:` line). YAML keys at column 0 like `webhooks:`,
// `security:`, `components:` end the `paths:` block; we anchor the
// insertion immediately above the first such line that appears AFTER
// `paths:`.
//
// We do this with a string splice rather than a YAML round-trip so the
// hand-curated formatting of the existing spec (indent style, comment
// blocks, $ref sugar) is preserved verbatim.
func insertIntoPathsBlock(yaml, stubs string) (string, error) {
	pathsIdx := strings.Index(yaml, "\npaths:")
	if pathsIdx < 0 {
		// Try the file-start case where `paths:` is the first line.
		if strings.HasPrefix(yaml, "paths:") {
			pathsIdx = 0
		} else {
			return "", fmt.Errorf("no `paths:` top-level key found")
		}
	}
	// Find the next top-level key after `paths:`. A top-level key line
	// matches the regex below — it starts at column 0 and contains a
	// colon. We skip the `paths:` line itself by searching from the
	// character after the newline that begins the `paths:` line.
	scanStart := pathsIdx + 1 // skip the leading "\n"
	if pathsIdx == 0 {
		scanStart = 0
	}
	// Move past the `paths:` line entirely.
	endOfPathsLine := strings.Index(yaml[scanStart:], "\n")
	if endOfPathsLine < 0 {
		// `paths:` is the only line — append the stubs.
		return yaml + "\n" + stubs, nil
	}
	cursor := scanStart + endOfPathsLine + 1

	topLevelKeyRe := regexp.MustCompile(`(?m)^[A-Za-z_][\w-]*:\s*(?:#.*)?$`)
	loc := topLevelKeyRe.FindStringIndex(yaml[cursor:])
	var insertAt int
	if loc == nil {
		// No subsequent top-level key — insertion at EOF is correct.
		insertAt = len(yaml)
	} else {
		insertAt = cursor + loc[0]
	}
	// Trim trailing whitespace/newlines from the prefix so the stub
	// block's leading newline doesn't pile up extra blank lines.
	prefix := strings.TrimRight(yaml[:insertAt], " \t\n")
	suffix := yaml[insertAt:]
	return prefix + "\n" + stubs + "\n" + suffix, nil
}

// operationsInSpec returns the HTTP methods declared for every `/api/...`
// path in the YAML. Tracking methods, rather than path names alone, prevents
// an existing GET from masking a newly shipped POST/PATCH/DELETE at the same
// path.
func operationsInSpec(yaml string) map[string]map[string]bool {
	out := map[string]map[string]bool{}
	pathLineRe := regexp.MustCompile(`^  (/\S+?):\s*$`)
	// `any` is not an OpenAPI operation. We still recognize it here as a
	// poison/sentinel key so a legacy generated `any:` cannot make an ANY
	// exemption look current and valid.
	methodLineRe := regexp.MustCompile(`^    (get|post|put|patch|delete|options|head|trace|any):\s*$`)
	currentPath := ""
	for _, line := range strings.Split(yaml, "\n") {
		if match := pathLineRe.FindStringSubmatch(line); match != nil {
			currentPath = match[1]
			if out[currentPath] == nil {
				out[currentPath] = map[string]bool{}
			}
			continue
		}
		if currentPath == "" {
			continue
		}
		if match := methodLineRe.FindStringSubmatch(line); match != nil {
			out[currentPath][match[1]] = true
			continue
		}
		if len(line) > 0 && line[0] != ' ' {
			currentPath = ""
		}
	}
	return out
}

// insertMethodsIntoExistingPaths adds only missing operation objects to paths
// that are already present. It inserts at the end of each path object and
// never rewrites a curated operation.
func insertMethodsIntoExistingPaths(yaml string, missing map[string]*missingEntry, existingPaths map[string]bool) (string, error) {
	paths := make([]string, 0, len(missing))
	for path := range missing {
		if existingPaths[path] {
			paths = append(paths, path)
		}
	}
	sort.Strings(paths)
	for _, path := range paths {
		needle := "  " + path + ":"
		pathStart := 0
		if !strings.HasPrefix(yaml, needle+"\n") {
			start := strings.Index(yaml, "\n"+needle+"\n")
			if start < 0 {
				return "", fmt.Errorf("existing path %q was not found in YAML", path)
			}
			pathStart = start + 1
		}
		bodyStart := pathStart + len(needle) + 1
		if bodyStart > len(yaml) {
			return "", fmt.Errorf("existing path %q has no body", path)
		}
		entryEnd := len(yaml)
		nextEntryRe := regexp.MustCompile(`(?m)^(?:  /\S+?:\s*|[A-Za-z_][\w-]*:\s*)$`)
		if loc := nextEntryRe.FindStringIndex(yaml[bodyStart:]); loc != nil {
			entryEnd = bodyStart + loc[0]
		}
		stub := yamlMethodsStub(missing[path].Methods)
		prefix := strings.TrimRight(yaml[:entryEnd], " \t\n")
		suffix := yaml[entryEnd:]
		yaml = prefix + "\n" + stub + "\n" + suffix
	}
	return yaml, nil
}

// yamlPathStub renders a minimal OpenAPI path entry for one path with
// all of its methods. Format matches the indentation style of the
// hand-written entries in openapi.yaml (2-space indent under `paths:`).
//
// Path-level `parameters:` are emitted once per path for every `{name}`
// placeholder we find — OpenAPI 3.x lets a path-level parameters block
// apply to every operation underneath, so we declare each path param
// exactly once even when multiple HTTP verbs share the path. Spectral's
// `path-params` rule fails any operation that references `{name}` in
// the path key without a matching declaration; emitting at path-scope
// kills the diagnostic at the root.
func yamlPathStub(path string, methods map[string]Route) string {
	var b strings.Builder
	fmt.Fprintf(&b, "  %s:\n", path)
	for _, line := range renderPathParametersYAML(extractPathParams(path), "    ") {
		b.WriteString(line)
	}
	b.WriteString(yamlMethodsStub(methods))
	return b.String()
}

func sortedMethodNames(methods map[string]Route) []string {
	keys := make([]string, 0, len(methods))
	for method := range methods {
		if !isOpenAPIOperationMethod(method) {
			continue
		}
		keys = append(keys, method)
	}
	sort.Strings(keys)
	return keys
}

func isOpenAPIOperationMethod(method string) bool {
	switch strings.ToLower(method) {
	case "get", "put", "post", "delete", "options", "head", "patch", "trace":
		return true
	default:
		return false
	}
}

func yamlMethodsStub(methods map[string]Route) string {
	var b strings.Builder
	for _, m := range sortedMethodNames(methods) {
		rt := methods[m]
		fmt.Fprintf(&b, "    %s:\n", m)
		fmt.Fprintf(&b, "      operationId: %s\n", deriveOperationID(m, rt.Path))
		fmt.Fprintf(&b, "      summary: %s\n", deriveSummary(rt))
		b.WriteString("      description: |\n")
		fmt.Fprintf(&b, "        %s\n", generatedOperationDescription(rt))
		fmt.Fprintf(&b, "      tags: [%s]\n", rt.Tag)
		// x-postwave-source: the Go source line we extracted from. Lets
		// reviewers cross-check the stub against the handler at a glance.
		fmt.Fprintf(&b, "      x-postwave-source: %s\n", rt.Source)
		b.WriteString("      responses:\n")
		b.WriteString("        '200':\n")
		fmt.Fprintf(&b, "          description: %s\n", generatedResponseDescription(rt))
	}
	return b.String()
}

func generatedResponseDescription(rt Route) string {
	switch strings.ToUpper(rt.Method) {
	case "DELETE":
		return "Operation completed. Endpoint may return 204 No Content or an endpoint-specific JSON payload."
	case "POST":
		return "Operation accepted or completed. Endpoint-specific JSON payload; see x-postwave-source and SDK resource docs."
	default:
		return "Endpoint-specific JSON payload; see x-postwave-source and SDK resource docs."
	}
}

func generatedOperationDescription(rt Route) string {
	route := fmt.Sprintf("`%s %s`", strings.ToUpper(rt.Method), rt.Path)
	switch strings.ToUpper(rt.Method) {
	case "GET", "HEAD":
		return fmt.Sprintf("Retrieves the current representation exposed by %s.", route)
	case "POST":
		return fmt.Sprintf("Executes the operation exposed by %s.", route)
	case "PUT":
		return fmt.Sprintf("Creates or replaces the representation addressed by %s.", route)
	case "PATCH":
		return fmt.Sprintf("Applies a partial update through %s.", route)
	case "DELETE":
		return fmt.Sprintf("Deletes or deactivates the resource addressed by %s.", route)
	default:
		return fmt.Sprintf("Implements the %s API operation.", route)
	}
}

// extractPathParams pulls the ordered, deduped list of `{name}` (or
// chi-style `{name:regex}`) placeholders out of an OpenAPI path. The
// chi-regex tail is stripped — OpenAPI 3.x doesn't accept it inside the
// path key itself, but the existing spec already carries entries like
// `/api/internal/uploads/{key:.+}` for parity with chi. We keep the
// path string verbatim and emit the bare param name in the parameters
// block.
func extractPathParams(path string) []string {
	var out []string
	seen := map[string]bool{}
	for _, m := range pathParamRe.FindAllStringSubmatch(path, -1) {
		name := m[1]
		if seen[name] {
			continue
		}
		seen[name] = true
		out = append(out, name)
	}
	return out
}

// renderPathParametersYAML returns the YAML lines for a path-level
// `parameters:` block — one entry per path param, all declared
// `in: path`, required, with `type: string` as the default schema.
// `indent` is the leading whitespace for the `parameters:` keyword
// itself (4 spaces for path-scope under a `  /api/...:` entry).
//
// Returns nil when `params` is empty so callers don't end up with a
// stray empty `parameters: []` block.
func renderPathParametersYAML(params []string, indent string) []string {
	if len(params) == 0 {
		return nil
	}
	out := []string{indent + "parameters:\n"}
	for _, p := range params {
		out = append(out,
			fmt.Sprintf("%s  - name: %s\n", indent, p),
			fmt.Sprintf("%s    in: path\n", indent),
			fmt.Sprintf("%s    required: true\n", indent),
			fmt.Sprintf("%s    schema: { type: string }\n", indent),
			fmt.Sprintf("%s    description: %s\n", indent, paramDescription(p)),
		)
	}
	return out
}

// paramDescription returns the description string for a path-param
// name, falling back to a generic "<Name> identifier." when the name
// isn't in the curated lookup table.
func paramDescription(name string) string {
	if d, ok := pathParamDescriptions[name]; ok {
		return d
	}
	// Title-case the snake_case name for the fallback.
	words := strings.Split(name, "_")
	for i, w := range words {
		if w == "" {
			continue
		}
		words[i] = strings.ToUpper(w[:1]) + w[1:]
	}
	return strings.Join(words, " ") + " identifier."
}

func deriveOperationID(method, path string) string {
	// Deterministic camelCase that retains path-parameter names. Dropping
	// placeholders made collection/detail pairs collide (getFoo for both
	// /foo and /foo/{id}), while leaving placeholders inside mixed segments
	// produced invalid ids such as getFeed{Token}.Xml.
	parts := strings.Split(strings.Trim(path, "/"), "/")
	var b strings.Builder
	b.WriteString(strings.ToLower(method))
	for _, p := range parts {
		if p == "api" || p == "v1" || p == "v2" || p == "" {
			continue
		}
		p = pathParamRe.ReplaceAllStringFunc(p, func(value string) string {
			match := pathParamRe.FindStringSubmatch(value)
			if len(match) < 2 {
				return ""
			}
			return "-by-" + match[1] + "-"
		})
		words := strings.FieldsFunc(p, func(r rune) bool {
			return !(r >= 'a' && r <= 'z') && !(r >= 'A' && r <= 'Z') && !(r >= '0' && r <= '9')
		})
		for _, word := range words {
			if word == "" {
				continue
			}
			b.WriteString(strings.ToUpper(word[:1]))
			b.WriteString(word[1:])
		}
	}
	return b.String()
}

func deriveSummary(rt Route) string {
	// Strip method-call shape: "campaigns.MountRoutes" or
	// "(&deps).Send" or "deps.Send" -> the last word, then split on
	// CamelCase boundaries -> "Send" -> "Send".
	h := rt.Handler
	if i := strings.LastIndex(h, "."); i != -1 {
		h = h[i+1:]
	}
	h = strings.TrimSuffix(strings.TrimSpace(h), ")")
	if h == "" {
		return fmt.Sprintf("%s %s", rt.Method, rt.Path)
	}
	return h
}

// updateJSONSpec adds the same missing path entries and methods to openapi.json.
// Done as targeted JSON edit (not full regenerate-from-yaml) to keep
// the script free of YAML deps. We parse the JSON, splice in the new
// `paths` entries, and re-marshal preserving key order via the
// json.Encoder + indent settings the original file uses.
func updateJSONSpec(jsonPath string, missing map[string]*missingEntry, sortedPaths []string) error {
	// We can't accept the typed argument from main directly because the
	// anonymous struct types differ; re-walk the data via map[string]any.
	// Simpler: read JSON, decode into map[string]any, splice paths,
	// write.
	body, err := readLocalFile(jsonPath)
	if err != nil {
		return err
	}
	var spec map[string]any
	if err := json.Unmarshal(body, &spec); err != nil {
		return fmt.Errorf("openapi.json is not valid JSON: %w", err)
	}
	paths, _ := spec["paths"].(map[string]any)
	if paths == nil {
		paths = map[string]any{}
		spec["paths"] = paths
	}
	for _, p := range sortedPaths {
		entry := missing[p]
		methods, _ := paths[p].(map[string]any)
		isNewPath := methods == nil
		if isNewPath {
			methods = map[string]any{}
		}
		for m, rt := range entry.Methods {
			if !isOpenAPIOperationMethod(m) {
				continue
			}
			if _, exists := methods[m]; exists {
				continue // Never clobber a curated operation.
			}
			methods[m] = map[string]any{
				"operationId":       deriveOperationID(m, rt.Path),
				"summary":           deriveSummary(rt),
				"description":       generatedOperationDescription(rt),
				"tags":              []any{rt.Tag},
				"x-postwave-source": rt.Source,
				"responses": map[string]any{
					"200": map[string]any{
						"description": generatedResponseDescription(rt),
					},
				},
			}
		}
		// Mirror the path-level `parameters:` block emitted in the YAML
		// so the JSON snapshot stays semantically equivalent. The
		// yaml-to-json.py reconciler will fully sync later, but keeping
		// the in-place edit accurate avoids a confusing intermediate
		// state where the two files disagree.
		params := extractPathParams(p)
		if isNewPath && len(params) > 0 {
			paramList := make([]any, 0, len(params))
			for _, name := range params {
				paramList = append(paramList, map[string]any{
					"name":        name,
					"in":          "path",
					"required":    true,
					"schema":      map[string]any{"type": "string"},
					"description": paramDescription(name),
				})
			}
			methods["parameters"] = paramList
		}
		paths[p] = methods
	}
	// Augment any existing path entries that have `{...}` placeholders
	// but lack a `parameters` array — this is the cleanup path for the
	// 57 spectral `path-params` errors flagged on auto-generated stubs
	// that predated this fix. Hand-curated entries that already declare
	// their own parameters are left alone.
	augmentJSONPathParams(paths)
	out, err := json.MarshalIndent(spec, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(jsonPath, append(out, '\n'), 0o644)
}

// paramAugmentationCount returns the number of path entries that gained
// a path-level `parameters:` block between `before` and `after`. Used
// only for a status log line — counts the new occurrences of the
// `parameters:` keyword at the path-scope indent (4 spaces).
func paramAugmentationCount(before, after string) int {
	const needle = "\n    parameters:\n"
	return strings.Count(after, needle) - strings.Count(before, needle)
}

// augmentJSONPathParams walks every entry in the parsed openapi.json
// `paths` map and, for each path that contains `{...}` placeholders,
// ensures the path object carries a `parameters` array declaring each
// placeholder as `in: path`, required, type: string.
//
// Three rules keep this safe:
//   - We never modify a path that already has a `parameters` field — if
//     it's hand-curated (with $refs, custom schemas, additional query
//     params), the curated array wins as-is. The contract from the
//     file header still holds: "existing path entries are left ALONE".
//   - We never touch method-level parameter arrays. Those override the
//     path-level array per the OAS spec, and we have no business
//     guessing what an operation needs at that scope.
//   - We only add parameters that aren't already declared somewhere on
//     the path (either at path scope or on any operation underneath),
//     so re-runs after a hand-edit don't introduce duplicates.
//
// Idempotent: calling this twice yields the same map.
func augmentJSONPathParams(paths map[string]any) {
	for path, raw := range paths {
		params := extractPathParams(path)
		if len(params) == 0 {
			continue
		}
		obj, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		// If the path already has a path-level `parameters` array, we
		// trust the curator. Even if it's missing one of our params,
		// don't second-guess — re-running shouldn't fight with manual
		// edits the next contributor made.
		if _, exists := obj["parameters"]; exists {
			continue
		}
		// Don't add a param that an operation already declares — avoids
		// emitting duplicate path entries when an operation lifted the
		// declaration up itself.
		declared := map[string]bool{}
		for _, opRaw := range obj {
			opMap, ok := opRaw.(map[string]any)
			if !ok {
				continue
			}
			opParamsRaw, ok := opMap["parameters"].([]any)
			if !ok {
				continue
			}
			for _, pRaw := range opParamsRaw {
				pMap, ok := pRaw.(map[string]any)
				if !ok {
					continue
				}
				if pMap["in"] == "path" {
					if name, ok := pMap["name"].(string); ok {
						declared[name] = true
					}
				}
			}
		}
		paramList := make([]any, 0, len(params))
		for _, name := range params {
			if declared[name] {
				continue
			}
			paramList = append(paramList, map[string]any{
				"name":        name,
				"in":          "path",
				"required":    true,
				"schema":      map[string]any{"type": "string"},
				"description": paramDescription(name),
			})
		}
		if len(paramList) == 0 {
			continue
		}
		obj["parameters"] = paramList
	}
}

// augmentYAMLPathParams scans `yaml` for path entries with `{...}`
// placeholders that lack a path-level `parameters:` block, and splices
// one in immediately after the path-key line. Operates on the auto-
// generated stub region only — bracketed by the BEGIN/END markers
// emitted by yamlPathStub — to avoid touching any hand-curated entry.
//
// The fix targets the 57 spectral `path-params` errors flagged on
// stubs that predate the generator's parameter-emitting capability.
// Hand-edited descriptions and summaries inside the stubs are
// preserved verbatim — we only inject the missing parameters block.
//
// Idempotent: a second pass finds nothing to add and returns the
// input unchanged.
func augmentYAMLPathParams(yaml string) string {
	const beginMarker = "# ---------- BEGIN auto-generated route stubs ----------"
	const endMarker = "# ---------- END auto-generated route stubs ----------"
	beginIdx := strings.Index(yaml, beginMarker)
	endIdx := strings.Index(yaml, endMarker)
	if beginIdx < 0 || endIdx < 0 || endIdx < beginIdx {
		// No auto-gen region — nothing to augment. Augmenting outside
		// the markers risks clobbering hand-curated paths, so we punt.
		return yaml
	}
	before := yaml[:beginIdx]
	region := yaml[beginIdx:endIdx]
	after := yaml[endIdx:]

	// `^  (/\S+?):\s*$` — same shape as pathsInSpec. We iterate line by
	// line so we can splice between path entries cleanly.
	lines := strings.Split(region, "\n")
	var out strings.Builder
	pathLineRe := regexp.MustCompile(`^  (/\S+?):\s*$`)
	for i := 0; i < len(lines); i++ {
		line := lines[i]
		out.WriteString(line)
		if i < len(lines)-1 {
			out.WriteByte('\n')
		}
		match := pathLineRe.FindStringSubmatch(line)
		if match == nil {
			continue
		}
		params := extractPathParams(match[1])
		if len(params) == 0 {
			continue
		}
		// Look ahead at the next non-blank line. If it's already a
		// `parameters:` declaration at the right indent, skip — the
		// path is already curated correctly.
		hasParams := false
		for j := i + 1; j < len(lines); j++ {
			next := lines[j]
			if strings.TrimSpace(next) == "" {
				continue
			}
			// New path entry (no extra indent) — stop scanning.
			if strings.HasPrefix(next, "  /") || strings.HasPrefix(next, "  #") {
				break
			}
			if next == "    parameters:" || strings.HasPrefix(next, "    parameters:") {
				hasParams = true
			}
			break
		}
		if hasParams {
			continue
		}
		for _, pl := range renderPathParametersYAML(params, "    ") {
			// pl already ends with '\n'; strip it so we can use
			// WriteString + a manual newline that matches the join logic.
			out.WriteString(strings.TrimRight(pl, "\n"))
			out.WriteByte('\n')
		}
	}
	return before + out.String() + after
}

func readLocalFile(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	b, err := io.ReadAll(io.LimitReader(f, maxRegenerateInputBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > maxRegenerateInputBytes {
		return nil, fmt.Errorf("input file exceeds %d bytes", maxRegenerateInputBytes)
	}
	return b, nil
}

func fatal(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "regenerate: "+format+"\n", args...)
	os.Exit(1)
}
