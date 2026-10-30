package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadLocalFileRejectsOversizedFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "openapi.yaml")
	f, err := os.Create(path)
	if err != nil {
		t.Fatalf("create file: %v", err)
	}
	if err := f.Truncate(maxRegenerateInputBytes + 1); err != nil {
		_ = f.Close()
		t.Fatalf("truncate file: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close file: %v", err)
	}

	_, err = readLocalFile(path)
	if err == nil || !strings.Contains(err.Error(), "input file exceeds") {
		t.Fatalf("expected oversized input error, got %v", err)
	}
}

func TestDeriveOperationIDRetainsParametersAndSanitizesMixedSegments(t *testing.T) {
	tests := map[string]string{
		"/api/v1/widgets":                   "getWidgets",
		"/api/v1/widgets/{id}":              "getWidgetsById",
		"/api/public/feed/{token}.xml":      "getPublicFeedByTokenXml",
		"/api/v1/files/{file_key:.+}":       "getFilesByFileKey",
		"/api/v1/things/{subject_type}/run": "getThingsBySubjectTypeRun",
	}
	for path, want := range tests {
		if got := deriveOperationID("GET", path); got != want {
			t.Errorf("deriveOperationID(%q) = %q, want %q", path, got, want)
		}
	}
}

func TestCanonicalOpenAPIPathStripsChiParameterRegexes(t *testing.T) {
	got := canonicalOpenAPIPath("/api/internal/uploads/{key:.+}/parts/{part:[0-9]+}")
	want := "/api/internal/uploads/{key}/parts/{part}"
	if got != want {
		t.Fatalf("canonicalOpenAPIPath() = %q, want %q", got, want)
	}
}

func TestGeneratedYAMLStubIncludesDescription(t *testing.T) {
	stub := yamlMethodsStub(map[string]Route{
		"post": {
			Method:  "POST",
			Path:    "/api/v1/widgets/{id}/run",
			Handler: "deps.Run",
			Tag:     "Widgets",
			Source:  "apps/api/internal/widgets/handlers.go:10",
		},
	})
	if !strings.Contains(stub, "description: |\n        Executes the operation exposed by `POST /api/v1/widgets/{id}/run`.") {
		t.Fatalf("stub is missing generated operation description:\n%s", stub)
	}
}

func TestGeneratedYAMLStubNeverEmitsMethodAgnosticANY(t *testing.T) {
	stub := yamlMethodsStub(map[string]Route{
		"any": {
			Method:  "ANY",
			Path:    "/api/v1/proxy/{rest}",
			Handler: "proxy",
			Tag:     "Proxy",
			Source:  "apps/api/internal/proxy/handlers.go:10",
		},
		"get": {
			Method:  "GET",
			Path:    "/api/v1/proxy/{rest}",
			Handler: "read",
			Tag:     "Proxy",
			Source:  "apps/api/internal/proxy/handlers.go:11",
		},
	})
	if strings.Contains(stub, "\n    any:") || strings.HasPrefix(stub, "    any:") {
		t.Fatalf("OpenAPI has no method-agnostic any operation:\n%s", stub)
	}
	if !strings.Contains(stub, "    get:") {
		t.Fatalf("filtering ANY must retain valid HTTP operations:\n%s", stub)
	}
}

func TestScanFileUsesASTForMultilineRoutesAndRejectsLookalikes(t *testing.T) {
	repoRoot := t.TempDir()
	path := filepath.Join(repoRoot, "apps", "api", "internal", "fixture", "routes.go")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir fixture: %v", err)
	}
	source := `package fixture
func mount(r interface{ Get(string, any); Put(string, any); Post(string, any); Delete(string, any); With(...any) interface{} }, client any, request any) {
	r.With(middleware).Get(
		"/api/v1/multiline/{id}",
		handler,
	)
	r.With(middleware).
		Put("/api/v1/multiline/{id}", replace)
	r.Post(` + "`/api/v1/raw-literal`" + `, create)

	// These method names are not route registrations.
	_ = request.Header.Get(SignatureHeader)
	client.Get(dynamicURL, requestOptions)
	_ = "r.Delete(\"/api/v1/string-only\", handler)"
	// r.Patch("/api/v1/comment-only", handler)

	r.Delete(prefix+"/dynamic", handler)
}
`
	if err := os.WriteFile(path, []byte(source), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	seen := map[string]Route{}
	var warnings []string
	if err := scanFile(repoRoot, path, seen, &warnings); err != nil {
		t.Fatalf("scanFile: %v", err)
	}
	for _, key := range []string{
		"GET /api/v1/multiline/{id}",
		"PUT /api/v1/multiline/{id}",
		"POST /api/v1/raw-literal",
	} {
		if _, ok := seen[key]; !ok {
			t.Errorf("missing AST-extracted route %s; got %#v", key, seen)
		}
	}
	if len(seen) != 3 {
		t.Fatalf("lookalike call or comment leaked into routes: %#v", seen)
	}
	if len(warnings) != 1 || !strings.Contains(warnings[0], `r.Delete(prefix+"/dynamic", handler)`) {
		t.Fatalf("dynamic router path must produce one actionable warning, got %#v", warnings)
	}
}

func TestScanFileAllowsReviewedMailchimpBaseRoutes(t *testing.T) {
	repoRoot := t.TempDir()
	path := filepath.Join(repoRoot, "apps", "api", "internal", "mailchimpv3", "handlers.go")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir fixture: %v", err)
	}
	source := `package mailchimpv3
func mount(r interface{ Get(string, any); Post(string, any) }) {
	r.Get(base, handler)
	r.Post(base+"/campaigns", create)
}
`
	if err := os.WriteFile(path, []byte(source), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	seen := map[string]Route{}
	var warnings []string
	if err := scanFile(repoRoot, path, seen, &warnings); err != nil {
		t.Fatalf("scanFile: %v", err)
	}
	if len(seen) != 0 || len(warnings) != 0 {
		t.Fatalf("reviewed Mailchimp base routes should be expanded elsewhere, routes=%#v warnings=%#v", seen, warnings)
	}
}

func TestScanFileCoversChiHeadOptionsMethodAndHandleRegistrations(t *testing.T) {
	repoRoot := t.TempDir()
	path := filepath.Join(repoRoot, "apps", "api", "internal", "fixture", "routes.go")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir fixture: %v", err)
	}
	source := `package fixture
import "net/http"
const specPath = "/api/v1/scope"
const staticMethod = "post"
func mount(r interface {
	Head(string, any)
	Options(string, any)
	Method(string, string, any)
	MethodFunc(string, string, any)
	Handle(string, any)
}) {
	r.Head(specPath, head)
	r.Options(specPath, options)
	r.Method(http.MethodPatch, specPath, patch)
	r.MethodFunc(staticMethod, specPath, create)
	r.Handle(specPath+"/*", proxy)
}
`
	if err := os.WriteFile(path, []byte(source), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	seen := map[string]Route{}
	var warnings []string
	if err := scanFile(repoRoot, path, seen, &warnings); err != nil {
		t.Fatalf("scanFile: %v", err)
	}
	for _, key := range []string{
		"HEAD /api/v1/scope",
		"OPTIONS /api/v1/scope",
		"PATCH /api/v1/scope",
		"POST /api/v1/scope",
		"ANY /api/v1/scope/{rest}",
	} {
		if _, ok := seen[key]; !ok {
			t.Errorf("missing AST-extracted route %s; got %#v", key, seen)
		}
	}
	if len(seen) != 5 || len(warnings) != 0 {
		t.Fatalf("unexpected scope extraction result routes=%#v warnings=%#v", seen, warnings)
	}
}

func TestScanFileTracksRouterIdentitiesLexicallyAndByOwningStructType(t *testing.T) {
	repoRoot := t.TempDir()
	path := filepath.Join(repoRoot, "apps", "api", "internal", "fixture", "routes.go")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir fixture: %v", err)
	}
	source := `package fixture
type routeOwner struct { Router interface{ Get(string, any) } }
type repository struct{}
func (repository) Get(any, any) {}
type repositoryOwner struct { Router repository }
func mount(r interface{ Get(string, any) }, routes routeOwner, repo repositoryOwner, narrowRepo interface{ Get(any, any) }) {
	r.Get("/api/v1/direct", handler)
	routes.Router.Get("/api/v1/owned-field", handler)
	repo.Router.Get(ctx, id)
	narrowRepo.Get("/api/v1/not-a-route", id)
	func(r repository) { r.Get(ctx, id) }(repository{})
	{
		r := repository{}
		r.Get(ctx, id)
	}
	r.Get("/api/v1/after-shadow", handler)
}
`
	if err := os.WriteFile(path, []byte(source), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	seen := map[string]Route{}
	var warnings []string
	if err := scanFile(repoRoot, path, seen, &warnings); err != nil {
		t.Fatalf("scanFile: %v", err)
	}
	for _, key := range []string{
		"GET /api/v1/direct",
		"GET /api/v1/owned-field",
		"GET /api/v1/after-shadow",
	} {
		if _, ok := seen[key]; !ok {
			t.Errorf("missing proven router route %s; got %#v", key, seen)
		}
	}
	if len(seen) != 3 || len(warnings) != 0 {
		t.Fatalf("repository receiver or lexical shadow leaked into routes: routes=%#v warnings=%#v", seen, warnings)
	}
}

func TestScanFileComposesNestedChiRoutePrefixesAndFailsClosed(t *testing.T) {
	repoRoot := t.TempDir()
	path := filepath.Join(repoRoot, "apps", "api", "internal", "fixture", "routes.go")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir fixture: %v", err)
	}
	source := `package fixture
import "github.com/go-chi/chi/v5"
func mount(r chi.Router, dynamicPrefix string) {
	r.Route("/api/v1", func(api chi.Router) {
		api.Get("/widgets/{id}", getWidget)
		api.Route("/history", func(history chi.Router) {
			history.Post("/{revision}.post", restoreRevision)
		})
	})
	r.Route(dynamicPrefix, func(dynamic chi.Router) {
		dynamic.Get("/unresolved", unresolved)
	})
}
`
	if err := os.WriteFile(path, []byte(source), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	seen := map[string]Route{}
	var warnings []string
	if err := scanFile(repoRoot, path, seen, &warnings); err != nil {
		t.Fatalf("scanFile: %v", err)
	}
	for _, key := range []string{
		"GET /api/v1/widgets/{id}",
		"POST /api/v1/history/{revision}.post",
	} {
		if _, ok := seen[key]; !ok {
			t.Errorf("missing nested chi route %s; got %#v", key, seen)
		}
	}
	if len(seen) != 2 {
		t.Fatalf("nested Route prefix was dropped or duplicated: %#v", seen)
	}
	if len(warnings) != 1 || !strings.Contains(warnings[0], "r.Route(dynamicPrefix") {
		t.Fatalf("dynamic chi Route prefix must fail closed with one actionable warning, got %#v", warnings)
	}
}

func TestScanFileResolvesAssignmentProvenanceBeforeAtomicRebinding(t *testing.T) {
	repoRoot := t.TempDir()
	path := filepath.Join(repoRoot, "apps", "api", "internal", "fixture", "routes.go")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir fixture: %v", err)
	}
	source := `package fixture
import "github.com/go-chi/chi/v5"
func mount(r chi.Router) {
	r = r.With(firstMiddleware)
	r.Get("/api/v1/self-rebound", selfRebound)
	r, child := r.With(secondMiddleware), r.With(thirdMiddleware)
	r.Get("/api/v1/parallel-self", parallelSelf)
	child.Get("/api/v1/parallel-child", parallelChild)
}
`
	if err := os.WriteFile(path, []byte(source), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	seen := map[string]Route{}
	var warnings []string
	if err := scanFile(repoRoot, path, seen, &warnings); err != nil {
		t.Fatalf("scanFile: %v", err)
	}
	for _, key := range []string{
		"GET /api/v1/self-rebound",
		"GET /api/v1/parallel-self",
		"GET /api/v1/parallel-child",
	} {
		if _, ok := seen[key]; !ok {
			t.Errorf("assignment lost router provenance for %s; got %#v", key, seen)
		}
	}
	if len(seen) != 3 || len(warnings) != 0 {
		t.Fatalf("unexpected assignment extraction routes=%#v warnings=%#v", seen, warnings)
	}
}

func TestScanFileScopesTypeSwitchAssignmentPerCase(t *testing.T) {
	repoRoot := t.TempDir()
	path := filepath.Join(repoRoot, "apps", "api", "internal", "fixture", "routes.go")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir fixture: %v", err)
	}
	source := `package fixture
import "github.com/go-chi/chi/v5"
type repository struct{}
func (repository) Get(any, any) {}
func mount(r chi.Router, candidate any) {
	switch r := candidate.(type) {
	case repository:
		r.Get(contextValue, recordID)
	}
	switch routed := candidate.(type) {
	case chi.Router:
		routed.Get("/api/v1/type-switched", typeSwitched)
	case repository:
		routed.Get(contextValue, recordID)
	}
	r.Get("/api/v1/after-type-switch", afterTypeSwitch)
}
`
	if err := os.WriteFile(path, []byte(source), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	seen := map[string]Route{}
	var warnings []string
	if err := scanFile(repoRoot, path, seen, &warnings); err != nil {
		t.Fatalf("scanFile: %v", err)
	}
	for _, key := range []string{
		"GET /api/v1/type-switched",
		"GET /api/v1/after-type-switch",
	} {
		if _, ok := seen[key]; !ok {
			t.Errorf("type-switch scope lost route %s; got %#v", key, seen)
		}
	}
	if len(seen) != 2 || len(warnings) != 0 {
		t.Fatalf("type-switch binding leaked outer router provenance: routes=%#v warnings=%#v", seen, warnings)
	}
}

func TestScanFileRequiresExactAPIBoundaryAndPreservesLiteralMethodSuffixes(t *testing.T) {
	repoRoot := t.TempDir()
	path := filepath.Join(repoRoot, "apps", "api", "internal", "fixture", "routes.go")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir fixture: %v", err)
	}
	source := `package fixture
import "github.com/go-chi/chi/v5"
func mount(r chi.Router) {
	r.Get("/api", apiRoot)
	r.Get("/api/v1/export.get", exportGet)
	r.Post("/api/v1/hooks.post", hookPost)
	r.Get("/apix/v1/not-an-api-route", notAPI)
	r.Get("/apiary/not-an-api-route", alsoNotAPI)
}
`
	if err := os.WriteFile(path, []byte(source), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	seen := map[string]Route{}
	var warnings []string
	if err := scanFile(repoRoot, path, seen, &warnings); err != nil {
		t.Fatalf("scanFile: %v", err)
	}
	for _, key := range []string{
		"GET /api",
		"GET /api/v1/export.get",
		"POST /api/v1/hooks.post",
	} {
		if _, ok := seen[key]; !ok {
			t.Errorf("missing exact API-boundary route %s; got %#v", key, seen)
		}
	}
	if len(seen) != 3 || len(warnings) != 0 {
		t.Fatalf("near-prefix route leaked or literal suffix changed: routes=%#v warnings=%#v", seen, warnings)
	}
}

func TestUnresolvedRouterRegistrationFailsClosed(t *testing.T) {
	if err := unresolvedRouteWarningsError(nil); err != nil {
		t.Fatalf("empty warnings should pass: %v", err)
	}
	err := unresolvedRouteWarningsError([]string{"routes.go:10: r.Get(dynamicPath, handler)"})
	if err == nil || !strings.Contains(err.Error(), "1 unresolved router registration") {
		t.Fatalf("dynamic router registration must fail closed, got %v", err)
	}
}

func TestOpenAPIExemptionsAreExactReviewedAndFailClosed(t *testing.T) {
	tests := []struct {
		name       string
		exemptions string
		contracts  string
		routes     []Route
		operations map[string]map[string]bool
		wantError  string
	}{
		{
			name:       "reviewed exact mounted route",
			exemptions: `{"version":1,"routes":["GET /api/v1/fixture"]}`,
			contracts:  `{"rules":[{"route":"GET /api/v1/fixture","exposure":"first-party-authenticated-read","reason":"fixture boundary"}]}`,
			routes:     []Route{{Method: "GET", Path: "/api/v1/fixture"}},
			operations: map[string]map[string]bool{},
		},
		{
			name:       "reviewed exact mounted ANY fallback",
			exemptions: `{"version":1,"routes":["ANY /api/v1/fixture"]}`,
			contracts:  `{"rules":[{"route":"ANY /api/v1/fixture","exposure":"gateway-proxy-dispatch","reason":"method-agnostic fixture fallback"}]}`,
			routes:     []Route{{Method: "ANY", Path: "/api/v1/fixture"}},
			operations: map[string]map[string]bool{"/api/v1/fixture": {"get": true}},
		},
		{
			name:       "unexempted ANY cannot become an OpenAPI operation",
			exemptions: `{"version":1,"routes":[]}`,
			contracts:  `{"rules":[]}`,
			routes:     []Route{{Method: "ANY", Path: "/api/v1/fixture"}},
			operations: map[string]map[string]bool{},
			wantError:  "requires an exact reviewed ANY exemption",
		},
		{
			name:       "stale unmounted ANY exemption",
			exemptions: `{"version":1,"routes":["ANY /api/v1/fixture"]}`,
			contracts:  `{"rules":[{"route":"ANY /api/v1/fixture","exposure":"gateway-proxy-dispatch","reason":"method-agnostic fixture fallback"}]}`,
			operations: map[string]map[string]bool{},
			wantError:  "no longer a reachable route",
		},
		{
			name:       "stale documented ANY exemption",
			exemptions: `{"version":1,"routes":["ANY /api/v1/fixture"]}`,
			contracts:  `{"rules":[{"route":"ANY /api/v1/fixture","exposure":"gateway-proxy-dispatch","reason":"method-agnostic fixture fallback"}]}`,
			routes:     []Route{{Method: "ANY", Path: "/api/v1/fixture"}},
			operations: operationsInSpec("paths:\n  /api/v1/fixture:\n    any:\n"),
			wantError:  "is now documented",
		},
		{
			name:       "stale unmounted exemption",
			exemptions: `{"version":1,"routes":["GET /api/v1/fixture"]}`,
			contracts:  `{"rules":[{"route":"GET /api/v1/fixture","exposure":"first-party-authenticated-read","reason":"fixture boundary"}]}`,
			operations: map[string]map[string]bool{},
			wantError:  "no longer a reachable route",
		},
		{
			name:       "stale documented exemption",
			exemptions: `{"version":1,"routes":["GET /api/v1/fixture"]}`,
			contracts:  `{"rules":[{"route":"GET /api/v1/fixture","exposure":"first-party-authenticated-read","reason":"fixture boundary"}]}`,
			routes:     []Route{{Method: "GET", Path: "/api/v1/fixture"}},
			operations: map[string]map[string]bool{"/api/v1/fixture": {"get": true}},
			wantError:  "is now documented",
		},
		{
			name:       "classification disappeared",
			exemptions: `{"version":1,"routes":["GET /api/v1/fixture"]}`,
			contracts:  `{"rules":[]}`,
			routes:     []Route{{Method: "GET", Path: "/api/v1/fixture"}},
			operations: map[string]map[string]bool{},
			wantError:  "has no reviewed route-contract",
		},
		{
			name:       "pattern classification is not an exact disposition",
			exemptions: `{"version":1,"routes":["GET /api/v1/fixture"]}`,
			contracts:  `{"rules":[{"pattern":"^GET /api/v1/.*$","exposure":"first-party-authenticated-read","reason":"broad fixture family"}]}`,
			routes:     []Route{{Method: "GET", Path: "/api/v1/fixture"}},
			operations: map[string]map[string]bool{},
			wantError:  "has no reviewed route-contract",
		},
		{
			name:       "reviewed pattern membership is an exact disposition",
			exemptions: `{"version":1,"routes":["GET /api/internal/fixture"]}`,
			contracts:  `{"rules":[{"pattern":"^[A-Z]+ /api/internal/","gateway_only_routes":["GET /api/internal/fixture"],"exposure":"internal-trust-boundary","reason":"enumerated internal fixture"}]}`,
			routes:     []Route{{Method: "GET", Path: "/api/internal/fixture"}},
			operations: map[string]map[string]bool{},
		},
		{
			name:       "pattern membership of a sibling route does not classify this one",
			exemptions: `{"version":1,"routes":["GET /api/internal/fixture"]}`,
			contracts:  `{"rules":[{"pattern":"^[A-Z]+ /api/internal/","gateway_only_routes":["GET /api/internal/other"],"exposure":"internal-trust-boundary","reason":"enumerated internal fixture"}]}`,
			routes:     []Route{{Method: "GET", Path: "/api/internal/fixture"}},
			operations: map[string]map[string]bool{},
			wantError:  "has no reviewed route-contract",
		},
		{
			name:       "pattern membership outside its reviewed family",
			exemptions: `{"version":1,"routes":["GET /api/v1/fixture"]}`,
			contracts:  `{"rules":[{"pattern":"^[A-Z]+ /api/internal/","gateway_only_routes":["GET /api/v1/fixture"],"exposure":"internal-trust-boundary","reason":"enumerated internal fixture"}]}`,
			routes:     []Route{{Method: "GET", Path: "/api/v1/fixture"}},
			operations: map[string]map[string]bool{},
			wantError:  "gateway_only_routes entry GET /api/v1/fixture does not match",
		},
		{
			name:       "duplicate pattern membership",
			exemptions: `{"version":1,"routes":["GET /api/internal/fixture"]}`,
			contracts:  `{"rules":[{"pattern":"^[A-Z]+ /api/internal/","gateway_only_routes":["GET /api/internal/fixture"],"exposure":"internal-trust-boundary","reason":"first family"},{"pattern":"^GET /api/","gateway_only_routes":["GET /api/internal/fixture"],"exposure":"operational-admin","reason":"second family"}]}`,
			routes:     []Route{{Method: "GET", Path: "/api/internal/fixture"}},
			operations: map[string]map[string]bool{},
			wantError:  "duplicates membership GET /api/internal/fixture",
		},
		{
			// HEAD refused this (no pattern ever classified an exemption), and
			// route-contracts.mjs refuses it (requireExactAny): a method-agnostic
			// route answers every verb, so only an exact rule may classify it.
			name:       "method-agnostic exemption is not classified by a pattern membership",
			exemptions: `{"version":1,"routes":["ANY /api/internal/fixture"]}`,
			contracts:  `{"rules":[{"pattern":"^[A-Z]+ /api/internal/","gateway_only_routes":["ANY /api/internal/fixture"],"exposure":"internal-trust-boundary","reason":"enumerated internal fixture"}]}`,
			routes:     []Route{{Method: "ANY", Path: "/api/internal/fixture"}},
			operations: map[string]map[string]bool{},
			wantError:  "OpenAPI exemption ANY /api/internal/fixture has no reviewed route-contract: a method-agnostic route requires an exact route rule",
		},
		{
			name:       "method-agnostic exemption with an exact rule beside a family membership",
			exemptions: `{"version":1,"routes":["ANY /api/internal/fixture","GET /api/internal/other"]}`,
			contracts:  `{"rules":[{"route":"ANY /api/internal/fixture","exposure":"gateway-proxy-dispatch","reason":"method-agnostic fixture fallback"},{"pattern":"^[A-Z]+ /api/internal/","gateway_only_routes":["GET /api/internal/other"],"exposure":"internal-trust-boundary","reason":"enumerated internal fixture"}]}`,
			routes:     []Route{{Method: "ANY", Path: "/api/internal/fixture"}, {Method: "GET", Path: "/api/internal/other"}},
			operations: map[string]map[string]bool{},
		},
		{
			name:       "pattern membership shadowed by an exact rule",
			exemptions: `{"version":1,"routes":["GET /api/internal/fixture"]}`,
			contracts:  `{"rules":[{"pattern":"^[A-Z]+ /api/internal/","gateway_only_routes":["GET /api/internal/fixture"],"exposure":"internal-trust-boundary","reason":"enumerated internal fixture"},{"route":"GET /api/internal/fixture","exposure":"operational-admin","reason":"fixture boundary"}]}`,
			routes:     []Route{{Method: "GET", Path: "/api/internal/fixture"}},
			operations: map[string]map[string]bool{},
			wantError:  "rule 0 gateway_only_routes entry GET /api/internal/fixture is shadowed by exact route rule 1",
		},
		{
			name:       "exact route rule cannot enumerate memberships",
			exemptions: `{"version":1,"routes":["GET /api/v1/fixture"]}`,
			contracts:  `{"rules":[{"route":"GET /api/v1/fixture","gateway_only_routes":["GET /api/v1/other"],"exposure":"first-party-authenticated-read","reason":"fixture boundary"}]}`,
			routes:     []Route{{Method: "GET", Path: "/api/v1/fixture"}},
			operations: map[string]map[string]bool{},
			wantError:  "exact route must not define gateway_only_routes",
		},
		{
			name:       "provisional classification",
			exemptions: `{"version":1,"routes":["GET /api/v1/fixture"]}`,
			contracts:  `{"rules":[{"route":"GET /api/v1/fixture","exposure":"triage-needed","reason":"fixture boundary"}]}`,
			routes:     []Route{{Method: "GET", Path: "/api/v1/fixture"}},
			operations: map[string]map[string]bool{},
			wantError:  "lacks a reviewed exposure",
		},
		{
			name:       "unknown classification category",
			exemptions: `{"version":1,"routes":["GET /api/v1/fixture"]}`,
			contracts:  `{"rules":[{"route":"GET /api/v1/fixture","exposure":"invented-boundary","reason":"fixture boundary"}]}`,
			routes:     []Route{{Method: "GET", Path: "/api/v1/fixture"}},
			operations: map[string]map[string]bool{},
			wantError:  "unknown exposure category",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			repoRoot := t.TempDir()
			writeFixtureFiles(t, repoRoot, map[string]string{
				openAPIExemptionsPolicyPath: tc.exemptions,
				routeContractsPolicyPath:    tc.contracts,
			})
			_, err := loadOpenAPIExemptions(repoRoot, tc.routes, tc.operations)
			if tc.wantError == "" {
				if err != nil {
					t.Fatalf("loadOpenAPIExemptions: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.wantError) {
				t.Fatalf("expected error containing %q, got %v", tc.wantError, err)
			}
		})
	}
}

func TestExtractRoutesExcludesUnmountedHandlerSourcesByDefault(t *testing.T) {
	repoRoot := routeReachabilityFixture(t, "mounted")
	routes, _, err := extractRoutes(repoRoot)
	if err != nil {
		t.Fatalf("extractRoutes: %v", err)
	}
	if len(routes) != 1 {
		t.Fatalf("expected exactly one reachable route, got %#v", routes)
	}
	if routes[0].Path != "/api/v1/mounted" {
		t.Fatalf("unmounted route leaked into extraction: %#v", routes)
	}
}

func TestReachabilityFailsWhenCompositionImportsExcludedSource(t *testing.T) {
	repoRoot := routeReachabilityFixture(t, "unmounted")
	_, err := reachableScanRoots(repoRoot)
	if err == nil || !strings.Contains(err.Error(), "API composition imports excluded route source apps/api/internal/unmounted") {
		t.Fatalf("expected excluded-source failure, got %v", err)
	}
}

func TestReachabilityFailsWhenForbiddenMountReturnsToCompositionRoot(t *testing.T) {
	repoRoot := routeReachabilityFixture(t, "mounted")
	mainPath := filepath.Join(repoRoot, "apps", "api", "main.go")
	mainSource := `package main
import _ "github.com/postwave/postwave/apps/api/internal/mounted"
func main() { affiliatesDeps.MountPublicRoutes(r) }
`
	if err := os.WriteFile(mainPath, []byte(mainSource), 0o644); err != nil {
		t.Fatalf("write main fixture: %v", err)
	}
	_, err := reachableScanRoots(repoRoot)
	if err == nil || !strings.Contains(err.Error(), "API composition calls forbidden route mount affiliatesDeps.MountPublicRoutes") {
		t.Fatalf("expected forbidden-mount failure, got %v", err)
	}
}

func TestReachabilityForbiddenMountCheckIgnoresCommentsAndStrings(t *testing.T) {
	repoRoot := routeReachabilityFixture(t, "mounted")
	mainPath := filepath.Join(repoRoot, "apps", "api", "main.go")
	mainSource := `package main
import _ "github.com/postwave/postwave/apps/api/internal/mounted"
func main() {
	_ = "affiliatesDeps.MountPublicRoutes(r)"
	// nbp.MountExtended(r)
}
`
	if err := os.WriteFile(mainPath, []byte(mainSource), 0o644); err != nil {
		t.Fatalf("write main fixture: %v", err)
	}
	if _, err := reachableScanRoots(repoRoot); err != nil {
		t.Fatalf("comments/string literals must not trigger forbidden mount: %v", err)
	}
}

func TestReachabilityFailsWhenExcludedNBPExtensionIsMounted(t *testing.T) {
	repoRoot := routeReachabilityFixture(t, "mounted")
	mainPath := filepath.Join(repoRoot, "apps", "api", "main.go")
	mainSource := `package main
import _ "github.com/postwave/postwave/apps/api/internal/mounted"
func main() { nbp.MountExtended(r) }
`
	if err := os.WriteFile(mainPath, []byte(mainSource), 0o644); err != nil {
		t.Fatalf("write main fixture: %v", err)
	}
	_, err := reachableScanRoots(repoRoot)
	if err == nil || !strings.Contains(err.Error(), "API composition calls forbidden route mount nbp.MountExtended") {
		t.Fatalf("expected forbidden NBP extension failure, got %v", err)
	}
}

// The composition root is package main, not main.go: commit e8d23a62d moved
// run()'s wiring into sibling files, and a forbidden mount there composes the
// binary exactly as one in main.go does.
func TestReachabilityFailsWhenForbiddenMountIsInSiblingCompositionFile(t *testing.T) {
	repoRoot := routeReachabilityFixture(t, "mounted")
	if _, err := reachableScanRoots(repoRoot); err != nil {
		t.Fatalf("baseline reachableScanRoots: %v", err)
	}
	writeFixtureFiles(t, repoRoot, map[string]string{
		"apps/api/wiring_extended.go": `package main

func mountExtended(r any) {
	nbp.MountExtended(r)
}
`,
	})
	const want = "API composition calls forbidden route mount nbp.MountExtended at apps/api/wiring_extended.go:4"
	if _, err := reachableScanRoots(repoRoot); err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("reachableScanRoots: expected %q, got %v", want, err)
	}
	// extractRoutes is what -check runs; it must enforce the same boundary.
	if _, _, err := extractRoutes(repoRoot); err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("extractRoutes: expected %q, got %v", want, err)
	}
}

func TestReachabilityScansInternalImportsOfSiblingCompositionFiles(t *testing.T) {
	repoRoot := routeReachabilityFixture(t, "mounted")
	writeFixtureFiles(t, repoRoot, map[string]string{
		"apps/api/internal/extracted/routes.go": `package extracted

func MountRoutes(r interface{ Get(string, ...any) }) {
	r.Get("/api/v1/extracted", nil)
}
`,
	})
	// Control: the package is not reachable while nothing in package main
	// imports it, so the route below is attributable to the sibling's import.
	routes, _, err := extractRoutes(repoRoot)
	if err != nil {
		t.Fatalf("baseline extractRoutes: %v", err)
	}
	if routeByKey(routes, "GET /api/v1/extracted") != nil {
		t.Fatalf("unimported package leaked into extraction: %#v", routes)
	}

	writeFixtureFiles(t, repoRoot, map[string]string{
		"apps/api/wiring_core.go": `package main

import "github.com/postwave/postwave/apps/api/internal/extracted"

func mountExtracted(r any) { extracted.MountRoutes(r) }
`,
	})
	roots, err := reachableScanRoots(repoRoot)
	if err != nil {
		t.Fatalf("reachableScanRoots: %v", err)
	}
	want := []string{
		"apps/api/internal/extracted",
		"apps/api/internal/mounted",
		"apps/api/main.go",
		"apps/api/wiring_core.go",
	}
	if strings.Join(roots, "\n") != strings.Join(want, "\n") {
		t.Fatalf("scan roots = %q, want %q", roots, want)
	}
	routes, _, err = extractRoutes(repoRoot)
	if err != nil {
		t.Fatalf("extractRoutes: %v", err)
	}
	route := routeByKey(routes, "GET /api/v1/extracted")
	if route == nil {
		t.Fatalf("route imported only by a sibling composition file was not scanned: %#v", routes)
	}
	if route.Source != "apps/api/internal/extracted/routes.go:4" || route.Tag != "Extracted" {
		t.Fatalf("unexpected provenance for sibling-imported route: %#v", *route)
	}
}

func TestReachabilityRejectsExcludedSourceImportedBySiblingCompositionFile(t *testing.T) {
	repoRoot := routeReachabilityFixture(t, "mounted")
	writeFixtureFiles(t, repoRoot, map[string]string{
		"apps/api/workers_maintenance.go": `package main

import _ "github.com/postwave/postwave/apps/api/internal/unmounted"
`,
	})
	const want = "API composition imports excluded route source apps/api/internal/unmounted (imported by apps/api/workers_maintenance.go)"
	if _, err := reachableScanRoots(repoRoot); err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("expected %q, got %v", want, err)
	}
}

func TestExtractRoutesTreatsSiblingRegistrationsAsCompositionRoot(t *testing.T) {
	repoRoot := routeReachabilityFixture(t, "mounted")
	writeFixtureFiles(t, repoRoot, map[string]string{
		"apps/api/ops_console_wiring.go": `package main

import "github.com/go-chi/chi/v5"

func mountOps(router chi.Router) {
	router.Route("/api/internal/ops", func(r chi.Router) {
		r.Get("/board", board)
	})
}
`,
	})
	routes, warnings, err := extractRoutes(repoRoot)
	if err != nil {
		t.Fatalf("extractRoutes: %v", err)
	}
	if len(warnings) != 0 {
		t.Fatalf("unexpected warnings: %#v", warnings)
	}
	route := routeByKey(routes, "GET /api/internal/ops/board")
	if route == nil {
		t.Fatalf("route registered in a sibling composition file was not extracted: %#v", routes)
	}
	if route.Source != "apps/api/ops_console_wiring.go:7" || route.Tag != "Core" {
		t.Fatalf("sibling composition route must carry the composition root's provenance and tag: %#v", *route)
	}

	// An excluded_routes entry may only retire a declaration in an internal
	// package; one in any composition file is a live mount.
	policyPath := filepath.Join(repoRoot, filepath.FromSlash(routeReachabilityPolicyPath))
	body, err := os.ReadFile(policyPath)
	if err != nil {
		t.Fatalf("read policy: %v", err)
	}
	const closed = `"path": "/api/public/closed",
      "reason": "fixture route is intentionally unmounted"
    }`
	mutated := strings.Replace(string(body), closed, closed+`,
    {
      "method": "GET",
      "path": "/api/internal/ops/board",
      "reason": "fixture exclusion of a sibling composition route"
    }`, 1)
	if mutated == string(body) {
		t.Fatal("fixture policy does not contain the closed-route exclusion")
	}
	writeFixtureFiles(t, repoRoot, map[string]string{routeReachabilityPolicyPath: mutated})
	const want = "excluded route GET /api/internal/ops/board is declared directly in the API composition root at apps/api/ops_console_wiring.go:7"
	if _, _, err := extractRoutes(repoRoot); err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("expected %q, got %v", want, err)
	}
}

// Package membership follows the go tool: _test.go files, subdirectories
// (separate packages such as apps/api/cmd/...), and names the go tool ignores
// are not composition source.
func TestCompositionPackageExcludesTestsSubpackagesAndIgnoredNames(t *testing.T) {
	repoRoot := routeReachabilityFixture(t, "mounted")
	writeFixtureFiles(t, repoRoot, map[string]string{
		"apps/api/main_test.go": `package main

import _ "github.com/postwave/postwave/apps/api/internal/unmounted"

func TestMount() { nbp.MountExtended(r) }
`,
		"apps/api/cmd/tool/main.go": `package main

import _ "github.com/postwave/postwave/apps/api/internal/unmounted"

func main() { nbp.MountExtended(r) }
`,
		"apps/api/_scratch.go": `package main

func scratch() { nbp.MountExtended(r) }
`,
		"apps/api/.#main.go": "not Go source: an editor lock file",
		// A directory is a package even when its name ends in .go.
		"apps/api/generated.go/doc.go": `package generated

func mount() { nbp.MountExtended(r) }
`,
	})
	composition, err := loadCompositionPackage(repoRoot, "apps/api/main.go")
	if err != nil {
		t.Fatalf("loadCompositionPackage: %v", err)
	}
	if strings.Join(composition.files, ",") != "apps/api/main.go" {
		t.Fatalf("composition files = %q, want only apps/api/main.go", composition.files)
	}
	roots, err := reachableScanRoots(repoRoot)
	if err != nil {
		t.Fatalf("non-composition files must not trigger forbidden mounts or exclusions: %v", err)
	}
	for _, root := range roots {
		if strings.Contains(root, "unmounted") || strings.Contains(root, "cmd/") {
			t.Fatalf("non-composition import or file became a scan root: %q", roots)
		}
	}
}

func TestCompositionPackageFailsClosedOnAmbiguousRoot(t *testing.T) {
	tests := []struct {
		name            string
		compositionRoot string
		files           map[string]string
		wantError       string
	}{
		{
			name:            "file declaring another package",
			compositionRoot: "apps/api/main.go",
			files:           map[string]string{"apps/api/stray.go": "package stray\n"},
			wantError:       "API composition package apps/api mixes package main (apps/api/main.go) with package stray (apps/api/stray.go)",
		},
		{
			name:            "unparseable composition source",
			compositionRoot: "apps/api/main.go",
			files:           map[string]string{"apps/api/wiring_broken.go": "package main\nfunc broken( {\n"},
			wantError:       "parse API composition source apps/api/wiring_broken.go",
		},
		{
			name:            "missing composition root file",
			compositionRoot: "apps/api/mian.go",
			wantError:       "composition_root apps/api/mian.go is not a Go source file in apps/api",
		},
		{
			name:            "test file as composition root",
			compositionRoot: "apps/api/main_test.go",
			files:           map[string]string{"apps/api/main_test.go": "package main\n"},
			wantError:       "composition_root apps/api/main_test.go must name a non-test Go source file",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			repoRoot := routeReachabilityFixture(t, "mounted")
			writeFixtureFiles(t, repoRoot, tc.files)
			if _, err := loadCompositionPackage(repoRoot, tc.compositionRoot); err == nil || !strings.Contains(err.Error(), tc.wantError) {
				t.Fatalf("expected %q, got %v", tc.wantError, err)
			}
		})
	}
}

// A file-scoped exclusion sits in a package the composition imports for
// something else, so nothing stops a composition file from calling one of its
// mounts except this guard. It resolves references by type: every case below
// reaches a mount through a name no forbidden_composition_calls entry could
// anticipate.
func TestReachabilityRejectsCompositionReferencesToExcludedFileMounts(t *testing.T) {
	const excluded = "; it registers routes from excluded source apps/api/internal/guarded/handlers.go, which the inventory does not scan: fixture handlers are registered literally by the composition"
	tests := []struct {
		name  string
		files map[string]string
		want  string
	}{
		{
			name: "method call through a struct field and a local variable",
			files: map[string]string{"apps/api/wiring_guarded.go": `package main

import "github.com/go-chi/chi/v5"

func mountGuarded(r chi.Router) {
	rt, _ := buildRuntime()
	deps := rt.Deps
	deps.MountRoutes(r)
}
`},
			want: "API composition references guarded.(*Deps).MountRoutes at apps/api/wiring_guarded.go:8" + excluded,
		},
		{
			name: "method value handed to the router",
			files: map[string]string{"apps/api/wiring_guarded.go": `package main

import "github.com/go-chi/chi/v5"

func mountGuarded(r chi.Router, rt runtime) { r.Group(rt.Deps.MountInternal) }
`},
			want: "API composition references guarded.(*Deps).MountInternal at apps/api/wiring_guarded.go:5" + excluded,
		},
		{
			name: "method expression",
			files: map[string]string{"apps/api/wiring_guarded.go": `package main

import (
	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/guarded"
)

func mountGuarded(r chi.Router) {
	(*guarded.Deps).MountRoutes(guarded.NewDeps(), r)
}
`},
			want: "API composition references guarded.(*Deps).MountRoutes at apps/api/wiring_guarded.go:10" + excluded,
		},
		{
			name: "package-level mount through an aliased import",
			files: map[string]string{"apps/api/wiring_guarded.go": `package main

import (
	"github.com/go-chi/chi/v5"

	g "github.com/postwave/postwave/apps/api/internal/guarded"
)

func mountGuarded(r chi.Router) { g.RegisterLegacy(r, g.NewDeps()) }
`},
			want: "API composition references guarded.RegisterLegacy at apps/api/wiring_guarded.go:9" + excluded,
		},
		{
			// go/types records an instantiated copy of a generic type's method;
			// the guard must map it back to the declaration.
			name: "method of an instantiated generic type",
			files: map[string]string{"apps/api/wiring_guarded.go": `package main

import (
	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/guarded"
)

func mountGuarded(r chi.Router) { (&guarded.Mounter[int]{}).MountRoutes(r) }
`},
			want: "API composition references guarded.(*Mounter[T]).MountRoutes at apps/api/wiring_guarded.go:9" + excluded,
		},
		{
			// The scan does not follow r.Mount, so a router handed back by the
			// excluded file would carry routes nobody inventories.
			name: "router returned by the excluded file",
			files: map[string]string{"apps/api/wiring_guarded.go": `package main

import "github.com/go-chi/chi/v5"

func mountGuarded(r chi.Router, rt runtime) { r.Mount("/api/v1/guarded/sub", rt.Deps.Router()) }
`},
			want: "API composition references guarded.(*Deps).Router at apps/api/wiring_guarded.go:5" + excluded,
		},
		{
			name: "same-package wrapper outside the excluded file",
			files: map[string]string{
				"apps/api/internal/guarded/wrapper.go": `package guarded

import "github.com/go-chi/chi/v5"

func (d *Deps) MountAll(r chi.Router) { d.MountRoutes(r) }
`,
				"apps/api/wiring_guarded.go": `package main

import "github.com/go-chi/chi/v5"

func mountGuarded(r chi.Router, rt runtime) { rt.Deps.MountAll(r) }
`,
			},
			want: "API composition references guarded.(*Deps).MountAll, which reaches guarded.(*Deps).MountRoutes, at apps/api/wiring_guarded.go:5" + excluded,
		},
		{
			// Install is declared before the wrapper it calls, so only a
			// fixed point (not a single pass) can find it.
			name: "wrapper of a wrapper, declared first",
			files: map[string]string{
				"apps/api/internal/guarded/wrapper.go": `package guarded

import "github.com/go-chi/chi/v5"

func Install(r chi.Router) { NewDeps().mountAll(r) }

func (d *Deps) mountAll(r chi.Router) { d.MountInternal(r) }
`,
				"apps/api/wiring_guarded.go": `package main

import (
	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/guarded"
)

func mountGuarded(r chi.Router) { guarded.Install(r) }
`,
			},
			want: "API composition references guarded.Install, which reaches guarded.(*Deps).MountInternal, at apps/api/wiring_guarded.go:9" + excluded,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			repoRoot := excludedFileMountFixture(t)
			if _, _, err := extractRoutes(repoRoot); err != nil {
				t.Fatalf("baseline extractRoutes: %v", err)
			}
			writeFixtureFiles(t, repoRoot, tc.files)
			if _, err := reachableScanRoots(repoRoot); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("reachableScanRoots: expected %q, got %v", tc.want, err)
			}
			// extractRoutes is what -check runs; it must enforce the same boundary.
			if _, _, err := extractRoutes(repoRoot); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("extractRoutes: expected %q, got %v", tc.want, err)
			}
		})
	}
}

// The guard follows declarations, not names: the excluded file's handler
// methods, and MountRoutes methods declared anywhere else, stay usable.
func TestExcludedFileMountGuardAllowsHandlersAndSameNamedMountsElsewhere(t *testing.T) {
	repoRoot := excludedFileMountFixture(t)
	writeFixtureFiles(t, repoRoot, map[string]string{"apps/api/wiring_guarded.go": `package main

import "github.com/go-chi/chi/v5"

// deps.MountRoutes(r) in a comment is not a reference.
func describeGuarded(r chi.Router) string { return "deps.MountRoutes(r)" }
`})
	routes, warnings, err := extractRoutes(repoRoot)
	if err != nil {
		t.Fatalf("extractRoutes: %v", err)
	}
	if len(warnings) != 0 {
		t.Fatalf("unexpected warnings: %#v", warnings)
	}
	var keys []string
	for _, route := range routes {
		keys = append(keys, route.Method+" "+route.Path+" @ "+route.Source)
	}
	want := []string{
		"GET /api/v1/guarded @ apps/api/main.go:17",
		"GET /api/v1/guarded/service @ apps/api/internal/guarded/service.go:9",
		"GET /api/v1/other @ apps/api/internal/other/routes.go:7",
	}
	if strings.Join(keys, "\n") != strings.Join(want, "\n") {
		t.Fatalf("routes =\n%s\nwant\n%s", strings.Join(keys, "\n"), strings.Join(want, "\n"))
	}
}

func TestExcludedFileMountGuardFailsClosedOnStaleOrBrokenSources(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(t *testing.T, repoRoot string)
		want   string
	}{
		{
			name: "excluded file no longer exists",
			mutate: func(t *testing.T, repoRoot string) {
				if err := os.Remove(filepath.Join(repoRoot, "apps", "api", "internal", "guarded", "handlers.go")); err != nil {
					t.Fatal(err)
				}
			},
			want: "excluded source apps/api/internal/guarded/handlers.go is in imported package apps/api/internal/guarded but cannot be read; remove or update the stale policy entry",
		},
		{
			name: "excluded file does not parse",
			mutate: func(t *testing.T, repoRoot string) {
				writeFixtureFiles(t, repoRoot, map[string]string{"apps/api/internal/guarded/handlers.go": "package guarded\nfunc broken( {\n"})
			},
			want: "parse guarded package source apps/api/internal/guarded/handlers.go",
		},
		{
			name: "sibling of the excluded file does not parse",
			mutate: func(t *testing.T, repoRoot string) {
				writeFixtureFiles(t, repoRoot, map[string]string{"apps/api/internal/guarded/service.go": "package guarded\nfunc broken( {\n"})
			},
			want: "parse guarded package source apps/api/internal/guarded/service.go",
		},
		{
			// Only one package clause is what the composition imports; the scan
			// refuses to guess which excluded file belongs to it.
			name: "excluded sources disagree on the package",
			mutate: func(t *testing.T, repoRoot string) {
				policyPath := filepath.Join(repoRoot, filepath.FromSlash(routeReachabilityPolicyPath))
				body, err := os.ReadFile(policyPath)
				if err != nil {
					t.Fatal(err)
				}
				const entry = `"path": "apps/api/internal/guarded/handlers.go",`
				mutated := strings.Replace(string(body), entry, `"path": "apps/api/internal/guarded/gen.go",
      "reason": "fixture generator"
    },
    {
      `+entry, 1)
				if mutated == string(body) {
					t.Fatal("fixture policy does not exclude handlers.go")
				}
				writeFixtureFiles(t, repoRoot, map[string]string{
					routeReachabilityPolicyPath:        mutated,
					"apps/api/internal/guarded/gen.go": "//go:build ignore\n\npackage main\n\nfunc main() {}\n",
				})
			},
			want: "guarded package apps/api/internal/guarded is ambiguous: excluded sources apps/api/internal/guarded/gen.go (package main) and apps/api/internal/guarded/handlers.go (package guarded) cannot both be compiled into it",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			repoRoot := excludedFileMountFixture(t)
			tc.mutate(t, repoRoot)
			if _, err := reachableScanRoots(repoRoot); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("expected %q, got %v", tc.want, err)
			}
		})
	}
}

// excludedFileMountFixture mirrors internal/inboxreality: the composition
// builds the package's Deps and registers its handlers itself, while the
// excluded handlers.go also declares mounts (one with a path the scan cannot
// resolve, so the exclusion is load-bearing) that the composition must never
// reach. MountRoutes is also declared on unrelated types, as it is on dozens
// of real packages.
func excludedFileMountFixture(t *testing.T) string {
	t.Helper()
	repoRoot := t.TempDir()
	writeFixtureFiles(t, repoRoot, map[string]string{
		"apps/api/main.go": `package main

import (
	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/guarded"
	"github.com/postwave/postwave/apps/api/internal/other"
)

type runtime struct{ Deps *guarded.Deps }

func buildRuntime() (runtime, error) { return runtime{Deps: guarded.NewDeps()}, nil }

func mountRoutes(r chi.Router) {
	rt, _ := buildRuntime()
	deps := rt.Deps
	r.Get("/api/v1/guarded", deps.List)
	(&other.Deps{}).MountRoutes(r)
	(&guarded.Service{}).MountRoutes(r)
}
`,
		"apps/api/internal/guarded/handlers.go": `package guarded

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

type Deps struct{ store any }

func (d *Deps) MountRoutes(r chi.Router) { r.Get("/api/v1/guarded", d.List) }

func (d *Deps) MountInternal(r chi.Router) { r.Post(internalPath(), d.List) }

func (d *Deps) Router() chi.Router {
	r := chi.NewRouter()
	r.Get("/api/v1/guarded/sub", d.List)
	return r
}

func RegisterLegacy(r chi.Router, d *Deps) { r.Get("/api/v1/guarded/legacy", d.List) }

type Mounter[T any] struct{ value T }

func (m *Mounter[T]) MountRoutes(r chi.Router) { r.Get("/api/v1/guarded/generic", nil) }

func (d *Deps) List(w http.ResponseWriter, r *http.Request) {}

func internalPath() string { return "/api/internal/guarded" }
`,
		"apps/api/internal/guarded/service.go": `package guarded

import "github.com/go-chi/chi/v5"

func NewDeps() *Deps { return &Deps{} }

type Service struct{}

func (s *Service) MountRoutes(r chi.Router) { r.Get("/api/v1/guarded/service", nil) }
`,
		"apps/api/internal/other/routes.go": `package other

import "github.com/go-chi/chi/v5"

type Deps struct{}

func (d *Deps) MountRoutes(r chi.Router) { r.Get("/api/v1/other", nil) }
`,
		"packages/openapi/route-reachability.json": `{
  "version": 1,
  "composition_root": "apps/api/main.go",
  "additional_sources": [],
  "forbidden_composition_calls": [],
  "excluded_routes": [],
  "excluded_sources": [
    {
      "path": "apps/api/internal/guarded/handlers.go",
      "reason": "fixture handlers are registered literally by the composition"
    }
  ]
}
`,
	})
	return repoRoot
}

func routeByKey(routes []Route, key string) *Route {
	for index := range routes {
		if routes[index].Method+" "+routes[index].Path == key {
			return &routes[index]
		}
	}
	return nil
}

func TestReachabilityRequiresEveryReviewedTransitiveMountCall(t *testing.T) {
	tests := []struct {
		name        string
		path        string
		oldCall     string
		missingCall string
	}{
		{
			name:        "composition root call",
			path:        "apps/api/main.go",
			oldCall:     "server.MountSurface(r)",
			missingCall: "server.MountSurface",
		},
		{
			name:        "composition helper call",
			path:        "apps/api/internal/server/surface.go",
			oldCall:     "transitive.MountRoutes(r)",
			missingCall: "transitive.MountRoutes",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			repoRoot := routeReachabilityTransitiveFixture(t)
			if _, err := reachableScanRoots(repoRoot); err != nil {
				t.Fatalf("baseline reachableScanRoots: %v", err)
			}
			path := filepath.Join(repoRoot, filepath.FromSlash(tc.path))
			body, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("read %s: %v", tc.path, err)
			}
			mutated := strings.Replace(string(body), tc.oldCall, "", 1)
			if mutated == string(body) {
				t.Fatalf("fixture does not contain %q", tc.oldCall)
			}
			if err := os.WriteFile(path, []byte(mutated), 0o644); err != nil {
				t.Fatalf("mutate %s: %v", tc.path, err)
			}
			_, err = reachableScanRoots(repoRoot)
			if err == nil || !strings.Contains(err.Error(), tc.missingCall) || !strings.Contains(err.Error(), "apps/api/internal/transitive") {
				t.Fatalf("expected missing transitive mount failure, got %v", err)
			}
		})
	}
}

func routeReachabilityTransitiveFixture(t *testing.T) string {
	t.Helper()
	repoRoot := t.TempDir()
	files := map[string]string{
		"apps/api/main.go": `package main
import (
	_ "github.com/postwave/postwave/apps/api/internal/mounted"
	"github.com/postwave/postwave/apps/api/internal/server"
)
func run() { server.MountSurface(r) }
`,
		"apps/api/internal/mounted/routes.go": `package mounted
func MountRoutes(r interface{ Get(string, ...any) }) { r.Get("/api/v1/mounted", nil) }
`,
		"apps/api/internal/server/surface.go": `package server
import "github.com/postwave/postwave/apps/api/internal/transitive"
func MountSurface(r any) { transitive.MountRoutes(r) }
`,
		"apps/api/internal/transitive/routes.go": `package transitive
func MountRoutes(r interface{ Get(string, ...any) }) { r.Get("/api/v1/transitive", nil) }
`,
		"packages/openapi/route-reachability.json": `{
  "version": 1,
  "composition_root": "apps/api/main.go",
  "additional_sources": [
    {
      "path": "apps/api/internal/transitive",
      "required_calls": [
        {"source":"apps/api/main.go","function":"run","symbol":"server.MountSurface"},
        {"source":"apps/api/internal/server/surface.go","function":"MountSurface","symbol":"transitive.MountRoutes"}
      ],
      "reason": "fixture transitive mount"
    }
  ],
  "forbidden_composition_calls": [],
  "excluded_routes": [],
  "excluded_sources": []
}
`,
	}
	writeFixtureFiles(t, repoRoot, files)
	return repoRoot
}

// writeFixtureFiles writes repository-relative fixture files under repoRoot.
func writeFixtureFiles(t *testing.T, repoRoot string, files map[string]string) {
	t.Helper()
	for path, contents := range files {
		absolute := filepath.Join(repoRoot, filepath.FromSlash(path))
		if err := os.MkdirAll(filepath.Dir(absolute), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", path, err)
		}
		if err := os.WriteFile(absolute, []byte(contents), 0o644); err != nil {
			t.Fatalf("write %s: %v", path, err)
		}
	}
}

func routeReachabilityFixture(t *testing.T, importedPackage string) string {
	t.Helper()
	repoRoot := t.TempDir()
	files := map[string]string{
		"apps/api/main.go": `package main
import _ "github.com/postwave/postwave/apps/api/internal/` + importedPackage + `"
func main() {}
`,
		"apps/api/internal/mounted/routes.go": `package mounted
func MountRoutes(r interface{ Get(string, ...any); Post(string, ...any) }) {
	r.Get("/api/v1/mounted", nil)
	r.Post("/api/public/closed", nil)
}
`,
		"apps/api/internal/mounted/unmounted_routes.go": `package mounted
func UnmountedRoutes(r interface{ Get(string, ...any) }) {
	r.Get("/api/v1/unmounted-in-mounted-package", nil)
}
`,
		"apps/api/internal/unmounted/routes.go": `package unmounted
func MountRoutes(r interface{ Get(string, ...any) }) {
	r.Get("/api/v1/unmounted", nil)
}
`,
		"packages/openapi/route-reachability.json": `{
  "version": 1,
  "composition_root": "apps/api/main.go",
  "additional_sources": [],
  "forbidden_composition_calls": [
    {
      "symbol": "affiliatesDeps.MountPublicRoutes",
      "reason": "fixture mount is release-blocked"
    },
    {
      "symbol": "nbp.MountExtended",
      "reason": "fixture extension is deliberately unmounted"
    }
  ],
  "excluded_routes": [
    {
      "method": "POST",
      "path": "/api/public/closed",
      "reason": "fixture route is intentionally unmounted"
    }
  ],
  "excluded_sources": [
    {
      "path": "apps/api/internal/unmounted",
      "reason": "fixture scaffold is not mounted"
    },
    {
      "path": "apps/api/internal/mounted/unmounted_routes.go",
      "reason": "fixture route file is not mounted"
    }
  ]
}
`,
	}
	writeFixtureFiles(t, repoRoot, files)
	return repoRoot
}
