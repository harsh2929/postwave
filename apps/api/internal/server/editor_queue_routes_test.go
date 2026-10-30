// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"context"
	"io"
	"log/slog"
	"os"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/campaigntemplates"
	"github.com/postwave/postwave/apps/api/internal/commerce"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/email_blocks"
	"github.com/postwave/postwave/apps/api/internal/merge"
	"github.com/postwave/postwave/apps/api/internal/nbp"
	"github.com/postwave/postwave/apps/api/internal/outbox"
)

func TestEditorQueueRoutesMatchEveryLegacyRouteAndScope(t *testing.T) {
	actualRouter := chi.NewRouter()
	actualDeps := newEditorQueueRouteDeps(actualRouter)
	MountEditorQueueRoutes(actualDeps)

	referenceRouter := chi.NewRouter()
	referenceDeps := newEditorQueueRouteDeps(referenceRouter)
	mountLegacyEditorQueueRoutes(referenceDeps)

	assertRouteSetsAndScopesMatch(t, actualRouter, referenceRouter, 17, [][]apikeys.Scope{
		nil,
		{apikeys.ScopeReadReports},
		{apikeys.ScopeWriteSubscribers},
		{apikeys.ScopeReadCampaigns},
		{apikeys.ScopeWriteCampaigns},
		{apikeys.ScopeAdmin},
		{apikeys.ScopeReadReports, apikeys.ScopeWriteSubscribers, apikeys.ScopeReadCampaigns, apikeys.ScopeWriteCampaigns, apikeys.ScopeAdmin},
	})
}

func TestEditorQueueSurfacePreservesDependencyIdentity(t *testing.T) {
	t.Parallel()

	deps := newEditorQueueRouteDeps(chi.NewRouter())
	surface := MountEditorQueueRoutes(deps)
	if surface.Queue == nil || surface.Queue.Pool != deps.Pool ||
		surface.Merge == nil || surface.Merge.Pool != deps.Pool || surface.Merge.Logger != deps.Logger ||
		surface.Blocks == nil || surface.Blocks.ProductResolver != deps.ProductResolver ||
		surface.Blocks.CouponResolver != deps.CouponResolver || surface.Blocks.Logger != nil ||
		surface.SavedBlocks == nil || surface.SavedBlocks.Repo == nil || surface.SavedBlocks.Repo.Pool != deps.Pool ||
		surface.CampaignTemplates != deps.CampaignTemplates || surface.Commerce != deps.Commerce ||
		surface.NBPRepo == nil || surface.NBPRepo.Pool != deps.Pool ||
		surface.Recommender == nil || surface.Recommender.Repo != surface.NBPRepo {
		t.Fatal("editor/queue surface changed pool, logger, resolver, repository, or recommender identity")
	}
}

func TestEditorQueueRoutesRejectStructurallyIncompleteDependencies(t *testing.T) {
	t.Parallel()

	complete := newEditorQueueRouteDeps(chi.NewRouter())
	for _, incomplete := range []EditorQueueRouteDeps{
		{Pool: complete.Pool, ProductResolver: complete.ProductResolver, CouponResolver: complete.CouponResolver, CampaignTemplates: complete.CampaignTemplates, Commerce: complete.Commerce},
		{Router: chi.NewRouter(), ProductResolver: complete.ProductResolver, CouponResolver: complete.CouponResolver, CampaignTemplates: complete.CampaignTemplates, Commerce: complete.Commerce},
		{Router: chi.NewRouter(), Pool: complete.Pool, CouponResolver: complete.CouponResolver, CampaignTemplates: complete.CampaignTemplates, Commerce: complete.Commerce},
		{Router: chi.NewRouter(), Pool: complete.Pool, ProductResolver: complete.ProductResolver, CouponResolver: complete.CouponResolver, Commerce: complete.Commerce},
		{Router: chi.NewRouter(), Pool: complete.Pool, ProductResolver: complete.ProductResolver, CouponResolver: complete.CouponResolver, CampaignTemplates: complete.CampaignTemplates},
	} {
		surface := MountEditorQueueRoutes(incomplete)
		if surface.Queue != nil || surface.Merge != nil || surface.Blocks != nil || surface.SavedBlocks != nil ||
			surface.CampaignTemplates != nil || surface.Commerce != nil || surface.NBPRepo != nil || surface.Recommender != nil {
			t.Fatal("structurally incomplete dependencies returned a partial editor/queue surface")
		}
		if incomplete.Router != nil && routeCount(t, incomplete.Router) != 0 {
			t.Fatal("structurally incomplete dependencies registered partial routes")
		}
	}
}

// CouponResolver is the ONE optional dependency here, and it is nil on every
// build: main.go only constructs it when discounts.CouponAllocationAvailable is
// true, and that is a compile-time `const … = false`.
//
// While it sat in the structural guard, the whole surface silently failed to
// mount — outbox queue, merge, email blocks, saved blocks, campaign-template
// regions, commerce recommendations and NBP — which left ~21 manifest routes
// unmounted and made the API refuse to boot. The routes are all unrelated to
// coupons; email_blocks nil-guards the resolver and simply skips coupon blocks,
// which is exactly what a closed coupon gate should do.
//
// This is the assertion that keeps the commercial gate from taking six route
// families down with it.
func TestNilCouponResolverStillMountsEverything(t *testing.T) {
	t.Parallel()

	complete := newEditorQueueRouteDeps(chi.NewRouter())
	complete.CouponResolver = nil

	surface := MountEditorQueueRoutes(complete)
	if surface.Queue == nil || surface.Merge == nil || surface.Blocks == nil ||
		surface.SavedBlocks == nil || surface.CampaignTemplates == nil ||
		surface.Commerce == nil || surface.NBPRepo == nil || surface.Recommender == nil {
		t.Fatal("a nil CouponResolver must not unmount the editor/queue surface")
	}
	if got := routeCount(t, complete.Router); got == 0 {
		t.Fatal("a nil CouponResolver registered no routes at all")
	}
	// The resolver is passed through untouched, so email_blocks can make its own
	// nil decision rather than having one made for it here.
	if surface.Blocks.CouponResolver != nil {
		t.Fatal("a nil CouponResolver must reach email_blocks as nil")
	}
}

func TestEditorQueueRouteOrderAndMainOwnership(t *testing.T) {
	t.Parallel()

	sourceBytes, err := os.ReadFile("editor_queue_routes.go")
	if err != nil {
		t.Fatalf("read editor_queue_routes.go: %v", err)
	}
	assertOrderedOccurrences(t, string(sourceBytes), []string{
		"outbox.MountQueueRoutes(",
		"merge.MountRoutes(",
		"email_blocks.MountRoutes(",
		"email_blocks.MountSavedRoutes(",
		"MountCampaignTemplateRegionRoutes(",
		`"/api/v1/commerce/recommendations"`,
		"nbp.Mount(",
	})

	root := readAPICompositionRoot(t)
	mainSource := root.main
	assertOrderedOccurrences(t, mainSource, []string{
		"apiserver.MountImportAuditAlertRoutes(",
		"apiserver.MountEditorQueueRoutes(",
		`if os.Getenv("POSTWAVE_DISABLE_NBP_BUILDER") != "1"`,
		"nbp.NewBuilder(editorQueue.NBPRepo)",
		"partitionRotator =",
	})
	for _, forbidden := range []string{
		"outbox.MountQueueRoutes(r,",
		"merge.MountRoutes(r,",
		"email_blocks.MountRoutes(r,",
		"email_blocks.MountSavedRoutes(r,",
		"apiserver.MountCampaignTemplateRegionRoutes(",
		`Get("/api/v1/commerce/recommendations",`,
		"nbpRepo :=",
		"nbp.Mount(r,",
	} {
		if strings.Contains(root.all, forbidden) {
			t.Fatalf("composition root retained migrated editor/queue composition %q", forbidden)
		}
	}
}

type editorQueueProductResolver struct{}

func (*editorQueueProductResolver) ResolveProductFeed(context.Context, string, string, string, email_blocks.ProductFeedResolveOptions) ([]email_blocks.ResolvedProduct, error) {
	return nil, nil
}

type editorQueueCouponResolver struct{}

func (*editorQueueCouponResolver) AssignCoupon(context.Context, string, string, email_blocks.CouponResolveOptions) (*email_blocks.ResolvedCoupon, error) {
	return nil, nil
}

func newEditorQueueRouteDeps(router chi.Router) EditorQueueRouteDeps {
	pool := &db.Pool{}
	return EditorQueueRouteDeps{
		Router: router, Pool: pool, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		ProductResolver: &editorQueueProductResolver{}, CouponResolver: &editorQueueCouponResolver{},
		CampaignTemplates: &campaigntemplates.Deps{Repo: &campaigntemplates.Repo{Pool: pool}},
		Commerce:          &commerce.Repo{Pool: pool},
	}
}

func mountLegacyEditorQueueRoutes(deps EditorQueueRouteDeps) {
	queue := &outbox.QueueDeps{Pool: deps.Pool}
	outbox.MountQueueRoutes(deps.Router, queue)
	merge.MountRoutes(deps.Router, &merge.Deps{Pool: deps.Pool, Logger: deps.Logger})
	email_blocks.MountRoutes(deps.Router, &email_blocks.Deps{
		ProductResolver: deps.ProductResolver, CouponResolver: deps.CouponResolver,
	})
	email_blocks.MountSavedRoutes(deps.Router, &email_blocks.SavedDeps{
		Repo: &email_blocks.SavedRepo{Pool: deps.Pool}, Logger: deps.Logger,
	})
	MountCampaignTemplateRegionRoutes(Deps{Router: deps.Router, CampaignTemplates: deps.CampaignTemplates})
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(
		"/api/v1/commerce/recommendations", commerce.RecommendationsHandler(deps.Commerce),
	)
	nbpRepo := &nbp.Repo{Pool: deps.Pool}
	nbp.Mount(deps.Router, nbpRepo, nbp.NewRecommender(nbpRepo), deps.Logger)
}
