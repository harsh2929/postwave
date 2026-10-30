package server

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Three route families were in the routeauth manifest with NOTHING mounting
// them, because their mount functions had no caller:
//
//	POST /api/v1/inbound-routes/bulk-archive   inbound_email.MountBulkRouteAdminRoutes
//	POST /api/v1/inbound-routes/bulk-snooze    (same function)
//	GET  /api/v1/offers/{offer}                offers.MountAdminRoutes
//
// ValidateRouterExact catches this at boot — "manifest route X is not mounted"
// — but only on a fully-migrated database, and that message reads like manifest
// drift. It was written off as exactly that once before: `activitycursor` sat
// unreachable on main for 17 days while the symptom was worked around with
// POSTWAVE_SKIP_ROUTE_AUTHZ_VALIDATION=1.
//
// WHY THIS TEST IS NARROW. A general "every exported Mount* function has a
// caller" scan was written first and thrown away. Regex call-graph analysis
// could not be made honest: matching by name alone let a call to ANY package's
// `MountAdminRoutes` mark every other package's as wired (proven by mutation —
// un-wiring offers.MountAdminRoutes left it green), and resolving receivers to
// their packages flipped it to dozens of false positives on construction
// patterns it could not parse. A guard that is either blind or noisy is worse
// than none, because both teach people to ignore it.
//
// So this pins the three call sites that were actually missing. The general
// property is already enforced, authoritatively, by ValidateRouterExact.
func TestPreviouslyUnwiredMountsStayWired(t *testing.T) {
	apiRoot := filepath.Join("..", "..")
	entries, err := os.ReadDir(apiRoot)
	if err != nil {
		t.Fatalf("read apps/api: %v", err)
	}
	var rootSrc strings.Builder
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".go") {
			continue
		}
		b, readErr := os.ReadFile(filepath.Join(apiRoot, e.Name()))
		if readErr != nil {
			t.Fatalf("read %s: %v", e.Name(), readErr)
		}
		rootSrc.WriteString(string(b))
	}
	src := rootSrc.String()
	if len(src) == 0 {
		t.Fatal("read no source from the apps/api root package")
	}

	for _, want := range []struct{ call, why string }{
		{
			call: "MountBulkRouteAdminRoutes(",
			why:  "POST /api/v1/inbound-routes/bulk-archive and bulk-snooze are in the manifest; without this call nothing mounts them and the API refuses to boot",
		},
		{
			call: "offers.MountAdminRoutes(",
			why:  "GET /api/v1/offers/{offer} is in the manifest; offers.MountPublicRoutes only mounts the PUBLIC sibling",
		},
	} {
		if !strings.Contains(src, want.call) {
			t.Errorf("apps/api root package no longer calls %s\n  %s", want.call, want.why)
		}
	}
}
