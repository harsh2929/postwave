package main

import (
	"os"
	"strings"
	"testing"
)

func mainSource(t *testing.T) string {
	t.Helper()
	source, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	return string(source)
}

// indexAfter returns the index of `needle` at or after `from`, failing the test
// when it is absent. Composition-order assertions are only meaningful if every
// marker was actually found.
func indexAfter(t *testing.T, source, needle string, from int) int {
	t.Helper()
	rel := strings.Index(source[from:], needle)
	if rel < 0 {
		t.Fatalf("composition marker %q not found after offset %d", needle, from)
	}
	return from + rel
}

// The public archive READ routes are fetched server-side by the hosted web
// renderer, so every visitor of every tenant's archive reaches the API from the
// web tier's single egress IP. Charging them to the shared 10/min/IP public
// bucket let ~11 requests a minute from one anonymous client 429 the archive of
// every tenant on the platform.
//
// The fix is structural: the render routes are mounted OUTSIDE the legacy
// public group, on their own egress-shaped limiter, while the credential-
// bearing unlock POST stays inside it on the human-shaped budget. Re-mounting
// MountPublicRoutes (both halves) inside the group would silently restore the
// shared bucket, so pin the split.
func TestArchiveRenderRoutesAreOutsideTheSharedPublicBucket(t *testing.T) {
	t.Parallel()
	root := readAPICompositionRoot(t)
	source := root.main

	render := strings.Index(source, "archivePublicDeps.MountPublicRenderRoutes(")
	if render < 0 {
		t.Fatal("archive render routes are not mounted through MountPublicRenderRoutes")
	}
	if !strings.Contains(source, "archiveRenderRateLimit.Middleware") {
		t.Fatal("archive render routes carry no dedicated rate limiter")
	}
	if !strings.Contains(source, `archiveRenderRateLimitOptions.Namespace = "ip:archive-render"`) {
		t.Fatal("the archive render limiter shares a namespace with another bucket")
	}

	// The legacy 10/min group opens after the render mount; the render routes
	// must therefore not be inside it.
	group := strings.Index(source, "// Remaining public routes — no auth and no tenant context.")
	if group < 0 {
		t.Fatal("legacy public route-group marker not found")
	}
	if render > group {
		t.Fatal("archive render routes are mounted inside the shared 10/min public group")
	}

	// And the whole-surface mount must not reappear anywhere in the composition
	// root, including the archive wiring run() calls (buildPublicArchiveDeps).
	if strings.Contains(root.all, "archivePublicDeps.MountPublicRoutes(") {
		t.Fatal("MountPublicRoutes re-mounts the render routes on the shared bucket")
	}
	if !strings.Contains(source, "archivePublicDeps.MountPublicWriteRoutes(") {
		t.Fatal("the subscribe-wall unlock POST is no longer mounted")
	}
}

// `r` inside an authenticated group is a chi INLINE mux, and chi's With()
// copies the parent middleware list AT CALL TIME. A route mounted with
// r.With(...) before a later r.Use therefore misses that middleware silently:
// flowsteps was registered ahead of seven of them, including
// httpcache.WithPolicy(AuthRead()) — so GET /api/v1/flow-runs/{run_id}/steps
// answered 200 with no Cache-Control and no `Vary: Authorization, Cookie`,
// which is precisely the cross-tenant CDN leak that policy exists to prevent.
func TestFlowStepsMountsAfterEveryGroupMiddleware(t *testing.T) {
	t.Parallel()
	source := mainSource(t)

	stack := strings.Index(source, "// Authenticated group 1/2:")
	if stack < 0 {
		t.Fatal("first authenticated group marker not found")
	}
	// Every r.Use on the group, in composition order.
	last := stack
	for _, use := range []string{
		"r.Use(stepup.Middleware(",
		"r.Use(idempotency.ProcessWithReplayBypassAndHandlerOwnedReplayAndBodyLimit(",
		"r.Use(middleware.AuditMiddleware(pool))",
		"r.Use(middleware.CostHeaderMiddleware(",
		"r.Use(budgets.Middleware(budgetRepo))",
		"r.Use(httpcache.Conditional())",
		"r.Use(httpcache.WithPolicy(httpcache.AuthRead()))",
	} {
		last = indexAfter(t, source, use, last)
	}

	mount := strings.Index(source, "(&flowsteps.Deps{")
	if mount < 0 {
		t.Fatal("flowsteps mount not found")
	}
	if mount < last {
		t.Fatal("flowsteps is registered before the group finishes composing: chi's " +
			"inline With() freezes the middleware list at call time, so the route " +
			"silently misses every r.Use that follows it — including the AuthRead " +
			"cache policy that carries Vary: Authorization, Cookie")
	}
}

func TestSendingSettingsMutationBypassesTheGlobalReplayLedger(t *testing.T) {
	t.Parallel()
	source := mainSource(t)
	middlewareStart := strings.Index(source,
		"r.Use(idempotency.ProcessWithReplayBypassAndHandlerOwnedReplayAndBodyLimit(")
	if middlewareStart < 0 {
		t.Fatal("authenticated generalized idempotency middleware is not mounted")
	}
	bypass := strings.Index(source[middlewareStart:],
		"sendingsettings.MutationGlobalReplayBypass(req, body)")
	if bypass < 0 {
		t.Fatal("sending-settings mutation is not delegated to the global replay bypass")
	}
	mount := strings.Index(source[middlewareStart:], "(&sendingsettings.Deps{")
	if mount < 0 {
		t.Fatal("sending-settings routes are not mounted inside the authenticated group")
	}
	if bypass > mount {
		t.Fatal("sending-settings routes mount before their global replay bypass is composed")
	}
}
