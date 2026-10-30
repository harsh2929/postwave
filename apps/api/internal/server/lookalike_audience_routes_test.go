// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"os"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/audiences"
	"github.com/postwave/postwave/apps/api/internal/db"
)

func TestLookalikeAudienceRoutesMatchLegacyScopesAndIdentity(t *testing.T) {
	actualRouter := chi.NewRouter()
	pool := &db.Pool{}
	actual := MountLookalikeAudienceRoutes(Deps{Router: actualRouter, Pool: pool})

	referenceRouter := chi.NewRouter()
	audiences.MountRoutes(referenceRouter, &audiences.Deps{Repo: &audiences.Repo{Pool: pool}})

	assertRouteSetsAndScopesMatch(t, actualRouter, referenceRouter, 4, [][]apikeys.Scope{
		nil,
		{apikeys.ScopeReadSubscribers},
		{apikeys.ScopeWriteSubscribers},
		{apikeys.ScopeReadSubscribers, apikeys.ScopeWriteSubscribers},
	})
	if actual == nil || actual.Repo == nil || actual.Repo.Pool != pool || actual.Logger != nil {
		t.Fatal("lookalike-audience surface changed pool or nil-logger identity")
	}
}

func TestLookalikeAudienceRoutesRejectStructuralNilAndRemainInterleaved(t *testing.T) {
	t.Parallel()

	if got := MountLookalikeAudienceRoutes(Deps{Pool: &db.Pool{}}); got != nil {
		t.Fatal("routerless lookalike dependencies returned a surface")
	}
	router := chi.NewRouter()
	if got := MountLookalikeAudienceRoutes(Deps{Router: router}); got != nil || routeCount(t, router) != 0 {
		t.Fatal("poolless lookalike dependencies returned a surface or registered routes")
	}

	serverBytes, err := os.ReadFile("subscriber_lists_segments.go")
	if err != nil {
		t.Fatalf("read subscriber_lists_segments.go: %v", err)
	}
	if !strings.Contains(string(serverBytes), "audiences.MountRoutes(deps.Router, routes)") {
		t.Fatal("lookalike helper no longer owns the audience registration")
	}
	root := readAPICompositionRoot(t)
	mainSource := root.main
	assertOrderedOccurrences(t, mainSource, []string{
		"apiserver.MountSegmentRoutes(",
		"apiserver.MountLookalikeAudienceRoutes(",
		"apiserver.MountSegmentDecayRoutes(",
	})
	if strings.Contains(root.all, "audiences.MountRoutes(r,") {
		t.Fatal("composition root retained direct lookalike-audience composition")
	}
}
