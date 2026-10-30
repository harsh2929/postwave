// SPDX-License-Identifier: AGPL-3.0-only
package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/actionticket"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/flowbuilder"
	"github.com/postwave/postwave/apps/api/internal/operation"
	"github.com/postwave/postwave/apps/api/internal/routeauth"
)

// The failure this pins down, exactly as it happened.
//
// `internal/activitycursor` was mounted from main.go through this file's
// composition helper and served real traffic to web and desktop. It was missing
// from packages/openapi/route-reachability.json, so the generator — which reads
// the reachable set — never emitted a capability for its routes. At startup
// `routeauth.ValidateRouterExact` then reported "GET /api/v1/activity/last-viewed
// has no exact route capability" and the API refused to boot. That symptom was
// recorded in the 2026-07-18 mobile audit as generic "manifest drift" and worked
// around with POSTWAVE_SKIP_ROUTE_AUTHZ_VALIDATION=1 rather than traced back
// here — which is the whole reason it survived: with the flag set, the route
// went from unbootable to unclassified, and an unclassified route is denied by
// routeauth.Middleware before it ever reaches its handler.
//
// A drift guard existed the entire time and stayed green, because the route was
// invisible to the inventory it compares against.
//
// So this asserts the property directly on the router rather than on the
// generator's output: whatever this helper mounts must have a policy. It fails
// if someone adds a package to the mount and forgets the policy entry, which is
// a smaller and much more likely mistake than the original one.
func TestEveryContinuityRouteHasAnAuthorizationPolicy(t *testing.T) {
	router := chi.NewRouter()
	// main.go mounts this helper inside the group that already carries
	// routeauth.Middleware. Mirroring that here keeps the test about the property
	// it owns — is every route classified — rather than failing on a middleware
	// placement that belongs to the composition root.
	router.Use(routeauth.Middleware)
	// The pool is stored, never dialled, during mounting. A nil pool would make
	// the helper return early and the test would pass over an empty router —
	// which is the vacuous-green failure this file exists to prevent.
	surface := MountContinuityRoutes(router, &db.Pool{}, nil)
	if surface.Cursor == nil || surface.Checkpoint == nil {
		t.Fatal("continuity helper mounted nothing; the rest of this test would be vacuous")
	}

	var mounted []string
	if err := chi.Walk(router, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if strings.HasPrefix(route, "/api/") {
			mounted = append(mounted, method+" "+route)
		}
		return nil
	}); err != nil {
		t.Fatalf("walk: %v", err)
	}
	if len(mounted) == 0 {
		t.Fatal("no /api routes walked; the assertion below would prove nothing")
	}

	// ValidateRouter is the forward half of the production startup contract:
	// every mounted API route needs an exact generated policy. The reverse half
	// (every policy is mounted) belongs to main.go, which mounts everything.
	if err := routeauth.ValidateRouter(router); err != nil {
		t.Fatalf("continuity routes are mounted but not classified — this is the\n"+
			"exact shape that made the API refuse to boot:\n%v\n\nmounted: %v", err, mounted)
	}
}

// The cursor says WHICH entity; the checkpoint holds WHAT was typed into it.
// A resume offer without the draft behind it opens an empty form, and the person
// concludes their work is gone — worse than never offering the resume. They are
// mounted by one function so that cannot drift apart; this pins the pairing so a
// later edit cannot quietly drop one.
func TestContinuityMountsBothHalves(t *testing.T) {
	router := chi.NewRouter()
	MountContinuityRoutes(router, &db.Pool{}, nil)

	seen := map[string]bool{}
	_ = chi.Walk(router, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		seen[method+" "+route] = true
		return nil
	})

	for _, want := range []string{
		"GET /api/v1/activity/last-viewed",
		"PUT /api/v1/activity/last-viewed",
		"GET /api/v1/editor/checkpoints/{entity_key}/{entity_id}",
		"PUT /api/v1/editor/checkpoints/{entity_key}/{entity_id}",
		"DELETE /api/v1/editor/checkpoints/{entity_key}/{entity_id}",
	} {
		if !seen[want] {
			t.Errorf("continuity helper no longer mounts %s", want)
		}
	}
}

// The gate explanation is registered HERE, so it is asserted here.
//
// `flow_runs` is enqueued by a reachable path and drained by nothing while
// `flowbuilder`'s runtime is gated, so those rows sit at `queued` forever. The
// shared operations view uses that word for work that is about to happen, so
// without a reason a stalled flow run is indistinguishable from a busy queue.
//
// This is the wiring, not the mechanism: an earlier version registered the gate
// from a package `init()`, which fires only if something links the package — so
// it did nothing in the operations package's own tests and would have done
// nothing in any binary that did not import flowbuilder.
func TestTheOperationsViewExplainsTheGatedFlowRuntime(t *testing.T) {
	router := chi.NewRouter()
	router.Use(routeauth.Middleware)
	if MountOperationsRoutes(router, &db.Pool{}, nil) == nil {
		t.Fatal("the operations helper mounted nothing; the rest is vacuous")
	}

	descriptor := flowbuilder.RuntimeDescriptor()
	reason := operation.BlockedReasonFor("run.flow", operation.StateQueued)
	if descriptor.ExecutionEnabled {
		if reason != nil {
			t.Fatalf("the flow runtime is ENABLED but queued runs are still "+
				"labelled blocked: %+v. The view is telling people their working "+
				"flows are stalled.", reason)
		}
		return
	}
	if reason == nil {
		t.Fatal("the flow runtime is gated off, but a queued flow run carries no " +
			"explanation — it renders identically to work that is about to happen")
	}
	if reason.Code != descriptor.Code || reason.Message != descriptor.Message {
		t.Fatalf("the reason has drifted from flowbuilder's own descriptor:\n  got  %+v\n  want %s / %s",
			reason, descriptor.Code, descriptor.Message)
	}
}

// The action-link surface must be mounted WITH an executor.
//
// The whole ticket mechanism was complete and unused until something minted and
// something served. Mounting the routes with a nil executor spends a ticket and
// then reports failure — better than pretending it worked, and still a link
// that cannot do its job, so the composition root passes one and this pins that.
func TestTheActionLinkRoutesAreMountedWithAnExecutor(t *testing.T) {
	router := chi.NewRouter()
	router.Use(routeauth.Middleware)
	var performed bool
	deps := MountActionTicketRoutes(router, &db.Pool{}, nil,
		func(*http.Request, actionticket.Redeemed) error {
			performed = true
			return nil
		})
	if deps == nil {
		t.Fatal("the helper mounted nothing; the rest of this test is vacuous")
	}
	if deps.Perform == nil {
		t.Fatal("mounted with no executor: a redeemed ticket would be spent and " +
			"the person told their action could not be completed")
	}
	// Prove the executor is the one we passed, not a placeholder.
	if err := deps.Perform(httptest.NewRequest(http.MethodPost, "/x", nil),
		actionticket.Redeemed{Action: "approval.approve"}); err != nil || !performed {
		t.Fatalf("the mounted executor did not run (err=%v)", err)
	}

	var mounted []string
	_ = chi.Walk(router, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		mounted = append(mounted, method+" "+route)
		return nil
	})
	for _, want := range []string{
		"GET /api/v1/actions/preview",
		"POST /api/v1/actions/redeem",
	} {
		found := false
		for _, m := range mounted {
			if m == want {
				found = true
			}
		}
		if !found {
			t.Errorf("%s is not mounted; got %v", want, mounted)
		}
	}
	// And every mounted route is classified, the same property the continuity
	// routes are held to.
	if err := routeauth.ValidateRouter(router); err != nil {
		t.Fatalf("action-link routes are mounted but not classified:\n%v", err)
	}
}
