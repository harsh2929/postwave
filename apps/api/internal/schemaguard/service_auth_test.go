package schemaguard_test

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

var (
	topLevelRouteRE  = regexp.MustCompile(`(?m)^\tr\.(Get|Post|Put|Patch|Delete|Handle|Mount)\(\s*"([^"]+)"`)
	groupRE          = regexp.MustCompile(`r\.Group\(func\((\w+) chi\.Router\)`)
	authUseRE        = regexp.MustCompile(`(\w+)\.Use\(internalauth\.Middleware\(`)
	protectMetricsRE = regexp.MustCompile(`runtimeobs\.ProtectMetrics\(`)
)

// services is every internal HTTP service in the repo. Adding one here is
// cheaper than discovering later that it shipped an open route.
var services = []string{"automation", "deliverability", "migration", "voice"}

// TestServiceRoutesRequireInternalAuth is the perimeter for the four internal
// services.
//
// Each runs behind the API gateway on a private network, and each protects
// itself with exactly one thing: a chi Group wrapping internalauth.Middleware
// around every route except /health and /metrics. That structure is repeated
// by hand in four separate main.go files with no shared helper, so nothing
// stops the next route from being registered a few lines too early — on the
// bare router, outside the group, reachable by anything that can open a socket
// to the pod.
//
// services/automation is the sharpest example: /admin/recurrence/run triggers
// scheduled campaign execution. It is inside the group today. One line higher
// and it would not be.
//
// /health must stay open for liveness probes; /metrics is protected separately
// by ProtectMetrics with its own token, which is why it is exempt here rather
// than expected inside the group.
func TestServiceRoutesRequireInternalAuth(t *testing.T) {
	const (
		health  = "/health"
		metrics = "/metrics"
	)

	for _, svc := range services {
		path := filepath.Join("..", "..", "..", "..", "services", svc, "main.go")
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Errorf("%s: cannot read main.go: %v", svc, err)
			continue
		}
		src := string(raw)

		// The service must actually establish a protected group, and that
		// group's router must be the one internalauth is installed on. A
		// group that exists but wraps the wrong variable protects nothing.
		group := groupRE.FindStringSubmatch(src)
		if group == nil {
			t.Errorf("%s: no r.Group(func(protected chi.Router)) — every route is unauthenticated", svc)
			continue
		}
		guarded := false
		for _, m := range authUseRE.FindAllStringSubmatch(src, -1) {
			if m[1] == group[1] {
				guarded = true
				break
			}
		}
		if !guarded {
			t.Errorf(
				"%s: the route group binds %q but internalauth.Middleware is not installed on it",
				svc, group[1],
			)
		}

		// Guard the guard: if the route regex stops matching, every service
		// looks perfectly locked down.
		top := topLevelRouteRE.FindAllStringSubmatch(src, -1)
		if len(top) == 0 {
			t.Errorf("%s: found no top-level routes at all; the route scan is broken", svc)
			continue
		}

		var exposed []string
		var sawHealth, sawMetrics bool
		for _, m := range top {
			switch m[2] {
			case health:
				sawHealth = true
			case metrics:
				sawMetrics = true
			default:
				exposed = append(exposed, m[1]+" "+m[2])
			}
		}
		sort.Strings(exposed)
		for _, e := range exposed {
			t.Errorf(
				"%s: %s is registered on the bare router, outside the internalauth group",
				svc, e,
			)
		}
		if !sawHealth {
			t.Errorf("%s: no open /health route; liveness probes will fail closed", svc)
		}
		if sawMetrics && !protectMetricsRE.MatchString(src) {
			t.Errorf("%s: /metrics is exposed without runtimeobs.ProtectMetrics", svc)
		}
	}
}

// TestEveryServiceIsCovered stops this file from silently going stale. A new
// service directory with a main.go is a new perimeter, and it should be added
// to `services` above rather than being audited by nobody.
func TestEveryServiceIsCovered(t *testing.T) {
	root := filepath.Join("..", "..", "..", "..", "services")
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatalf("read services dir: %v", err)
	}
	known := map[string]bool{}
	for _, s := range services {
		known[s] = true
	}
	var missing []string
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		if _, err := os.Stat(filepath.Join(root, entry.Name(), "main.go")); err != nil {
			continue
		}
		if !known[entry.Name()] {
			missing = append(missing, entry.Name())
		}
	}
	sort.Strings(missing)
	for _, m := range missing {
		t.Errorf("services/%s has a main.go but no auth-perimeter coverage; add it to `services`", m)
	}
}
