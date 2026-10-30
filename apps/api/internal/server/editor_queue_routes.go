// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"log/slog"

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

type EditorQueueRouteDeps struct {
	Router            chi.Router
	Pool              *db.Pool
	Logger            *slog.Logger
	ProductResolver   email_blocks.ProductFeedResolver
	CouponResolver    email_blocks.CouponResolver
	CampaignTemplates *campaigntemplates.Deps
	Commerce          *commerce.Repo
}

type EditorQueueSurface struct {
	Queue             *outbox.QueueDeps
	Merge             *merge.Deps
	Blocks            *email_blocks.Deps
	SavedBlocks       *email_blocks.SavedDeps
	CampaignTemplates *campaigntemplates.Deps
	Commerce          *commerce.Repo
	NBPRepo           *nbp.Repo
	Recommender       *nbp.Recommender
}

// CouponResolver is DELIBERATELY ABSENT from the guard below. It is the one
// dependency here that is optional, and treating it as required cost the API
// its ability to boot.
//
// `main.go` builds the resolver only when `discounts.CouponAllocationAvailable`
// is true. That is a compile-time `const … = false` awaiting commercial and
// legal sign-off, so the resolver is ALWAYS nil. While the guard demanded a
// non-nil one it returned an empty surface on every build — dropping the outbox
// queue, merge, email blocks, saved blocks, campaign-template regions, commerce
// recommendations and NBP. None of those has anything to do with coupons.
//
// The consequence was not subtle: those routes are still in the generated
// routeauth manifest, so `ValidateRouterExact` found ~21 manifest routes
// unmounted and the API REFUSED TO BOOT. The only way past it was
// POSTWAVE_SKIP_ROUTE_AUTHZ_VALIDATION=1 — an escape hatch that has already
// masked one real defect here (the ledger records `activitycursor` unreachable
// for 17 days on main because the same flag got past the same symptom).
//
// An earlier revision of this comment said "THE FIX IS NOT TO LOOSEN THIS
// GUARD. Every dependency here is genuinely required by something it mounts."
// That was wrong, and checking rather than asserting is what settled it:
// `deps.CouponResolver` is used on exactly ONE line below, passed straight into
// `email_blocks.Deps`, and `email_blocks` already nil-guards it — with no
// resolver it skips coupon blocks and renders everything else. Skipping coupon
// blocks is precisely what a closed coupon gate should do.
//
// So the containment gate now contains coupons instead of six unrelated
// families. Every OTHER dependency in the guard is genuinely required: each is
// dereferenced unconditionally by something it mounts.
func MountEditorQueueRoutes(deps EditorQueueRouteDeps) EditorQueueSurface {
	if deps.Router == nil || deps.Pool == nil || deps.ProductResolver == nil ||
		deps.CampaignTemplates == nil || deps.Commerce == nil {
		return EditorQueueSurface{}
	}
	queue := &outbox.QueueDeps{Pool: deps.Pool}
	outbox.MountQueueRoutes(deps.Router, queue)
	mergeRoutes := &merge.Deps{Pool: deps.Pool, Logger: deps.Logger}
	merge.MountRoutes(deps.Router, mergeRoutes)
	blocks := &email_blocks.Deps{ProductResolver: deps.ProductResolver, CouponResolver: deps.CouponResolver}
	email_blocks.MountRoutes(deps.Router, blocks)
	savedBlocks := &email_blocks.SavedDeps{Repo: &email_blocks.SavedRepo{Pool: deps.Pool}, Logger: deps.Logger}
	email_blocks.MountSavedRoutes(deps.Router, savedBlocks)
	MountCampaignTemplateRegionRoutes(Deps{Router: deps.Router, CampaignTemplates: deps.CampaignTemplates})
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(
		"/api/v1/commerce/recommendations", commerce.RecommendationsHandler(deps.Commerce),
	)
	nbpRepo := &nbp.Repo{Pool: deps.Pool}
	recommender := nbp.NewRecommender(nbpRepo)
	nbp.Mount(deps.Router, nbpRepo, recommender, deps.Logger)
	return EditorQueueSurface{
		Queue: queue, Merge: mergeRoutes, Blocks: blocks, SavedBlocks: savedBlocks,
		CampaignTemplates: deps.CampaignTemplates, Commerce: deps.Commerce,
		NBPRepo: nbpRepo, Recommender: recommender,
	}
}
