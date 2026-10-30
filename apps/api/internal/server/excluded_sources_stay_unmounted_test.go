package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// `packages/openapi/route-reachability.json` carries prohibitions in prose:
//
//	apps/api/internal/aeo — "Answer-engine clients and the public sensor
//	publisher are unfinished; no AEO route may be mounted or advertised until
//	the runtime is production-backed."
//
// Nothing enforced that. The exclusion governs the route-CAPABILITY generator —
// it keeps those routes out of the manifest — but it does not stop somebody
// wiring the mount. And with the route absent from the manifest, mounting it
// would NOT trip ValidateRouterExact's reverse check either; it would ship an
// unadvertised, unclassified endpoint, which is how `activitycursor` ended up
// answering 403 route_authorization_unclassified in production.
//
// So the two halves fail in opposite directions and neither covers this: the
// generator knows the route must not be advertised, the validator only checks
// what IS advertised. This test closes the gap by asserting the excluded
// packages' mount functions have no call site in the composition root.
//
// When a held surface becomes production-backed, the fix is to remove its entry
// from route-reachability.json — the same edit that lets the generator advertise
// it. The per-tenant AEO API took that step on 2026-09-12; the public sensor
// publisher (sensor_handlers.go) stays excluded as a file-scoped prohibition.
func TestExcludedSourcesAreNotMounted(t *testing.T) {
	repoRoot := filepath.Join("..", "..", "..", "..")
	raw, err := os.ReadFile(filepath.Join(repoRoot, "packages", "openapi", "route-reachability.json"))
	if err != nil {
		t.Fatalf("route-reachability.json unavailable: %v", err)
	}
	var doc struct {
		ExcludedSources []struct {
			Path   string `json:"path"`
			Reason string `json:"reason"`
		} `json:"excluded_sources"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse route-reachability.json: %v", err)
	}

	// Only packages whose reason FORBIDS mounting. Most exclusions are merely
	// "not reachable from the composition root", which is a different claim and
	// must not be read as a prohibition.
	forbids := regexp.MustCompile(`(?i)may (not|never) be mounted|must not be mounted|no \w+ route may be mounted`)
	var guarded []string
	for _, e := range doc.ExcludedSources {
		if forbids.MatchString(e.Reason) {
			guarded = append(guarded, e.Path)
		}
	}
	if len(guarded) == 0 {
		t.Fatal("no excluded source carries a mount prohibition; this guard would pass vacuously")
	}

	// The composition root: apps/api's root package.
	apiRoot := filepath.Join("..", "..")
	entries, err := os.ReadDir(apiRoot)
	if err != nil {
		t.Fatalf("read apps/api: %v", err)
	}
	var root strings.Builder
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".go") || strings.HasSuffix(e.Name(), "_test.go") {
			continue
		}
		b, readErr := os.ReadFile(filepath.Join(apiRoot, e.Name()))
		if readErr != nil {
			t.Fatalf("read %s: %v", e.Name(), readErr)
		}
		root.WriteString(string(b))
	}
	src := root.String()
	if len(src) == 0 {
		t.Fatal("read no source from the composition root")
	}

	for _, pkgPath := range guarded {
		var callRE *regexp.Regexp
		if strings.HasSuffix(pkgPath, ".go") {
			// A file-scoped exclusion inside a package that IS composed (the
			// per-tenant AEO API is mounted; the public sensor publisher in
			// sensor_handlers.go is not). Guard exactly the mount functions that
			// file declares, qualified by its package.
			pkg := filepath.Base(filepath.Dir(pkgPath))
			b, readErr := os.ReadFile(filepath.Join(repoRoot, pkgPath))
			if readErr != nil {
				t.Fatalf("read excluded source %s: %v", pkgPath, readErr)
			}
			names := regexp.MustCompile(`(?m)^func (Mount\w*)\(`).FindAllStringSubmatch(string(b), -1)
			if len(names) == 0 {
				t.Fatalf("%s is excluded with a mount prohibition but declares no Mount* function; the guard would pass vacuously", pkgPath)
			}
			alts := make([]string, 0, len(names))
			for _, n := range names {
				alts = append(alts, regexp.QuoteMeta(n[1]))
			}
			callRE = regexp.MustCompile(`\b` + regexp.QuoteMeta(pkg) + `\.(` + strings.Join(alts, "|") + `)\(`)
		} else {
			pkg := filepath.Base(pkgPath)
			// `aeo.MountAnything(` — a mount call qualified by the forbidden package.
			callRE = regexp.MustCompile(`\b` + regexp.QuoteMeta(pkg) + `\.Mount\w*\(`)
		}
		if m := callRE.FindString(src); m != "" {
			t.Errorf(
				"%s is excluded in route-reachability.json with a mount prohibition, but the\n"+
					"composition root calls %s — the route would be mounted while remaining\n"+
					"absent from the manifest, so it answers unclassified rather than failing loudly.\n"+
					"If the runtime is now production-backed, remove the exclusion first.",
				pkgPath, m,
			)
		}
	}
	t.Logf("checked %d excluded package(s) carrying a mount prohibition: %s",
		len(guarded), strings.Join(guarded, ", "))
}
