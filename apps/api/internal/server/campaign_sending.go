// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/campaigns"
	"github.com/postwave/postwave/apps/api/internal/send_window"
	"github.com/postwave/postwave/apps/api/internal/sending"
	"github.com/postwave/postwave/apps/api/internal/sending_identity"
)

// MountCampaignReadRoutes registers the canonical campaign read surface.
func MountCampaignReadRoutes(deps Deps) {
	if deps.Router == nil || deps.Campaigns == nil {
		return
	}

	campaigns.MountRead(deps.Router, deps.Campaigns)
}

// MountCampaignTemplateRoutes registers the base template library and its
// stats, goals, clone, usage, and favorite extensions with their original
// per-route campaign scopes.
func MountCampaignTemplateRoutes(deps Deps) {
	if deps.Router == nil || deps.CampaignTemplates == nil {
		return
	}

	read := apikeys.RequireScope(apikeys.ScopeReadCampaigns)
	write := apikeys.RequireScope(apikeys.ScopeWriteCampaigns)
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	deps.Router.With(read).Get("/api/v1/campaign-templates", deps.CampaignTemplates.List)
	deps.Router.With(read).Get("/api/v1/campaign-templates/search", deps.CampaignTemplates.Search)
	deps.Router.With(read).Get("/api/v1/campaign-templates/compare", deps.CampaignTemplates.CompareTemplates)
	deps.Router.With(read).Get("/api/v1/campaign-templates/recent", deps.CampaignTemplates.ListRecentViews)
	deps.Router.With(read).Delete("/api/v1/campaign-templates/recent", deps.CampaignTemplates.ClearRecentViews)
	deps.Router.With(read).Delete("/api/v1/campaign-templates/recent/{id}", deps.CampaignTemplates.ClearRecentViews)
	deps.Router.With(read).Get("/api/v1/campaign-template-collections", deps.CampaignTemplates.ListCollections)
	deps.Router.With(read).Post("/api/v1/campaign-template-collections", deps.CampaignTemplates.CreateCollection)
	deps.Router.With(read).Get("/api/v1/campaign-template-collections/{id}", deps.CampaignTemplates.GetCollection)
	deps.Router.With(read).Patch("/api/v1/campaign-template-collections/{id}", deps.CampaignTemplates.UpdateCollection)
	deps.Router.With(read).Delete("/api/v1/campaign-template-collections/{id}", deps.CampaignTemplates.DeleteCollection)
	deps.Router.With(read).Put("/api/v1/campaign-template-collections/{id}/items", deps.CampaignTemplates.ReplaceCollectionItems)
	deps.Router.With(read).Get("/api/v1/campaign-template-saved-searches", deps.CampaignTemplates.ListSavedSearches)
	deps.Router.With(read).Post("/api/v1/campaign-template-saved-searches", deps.CampaignTemplates.CreateSavedSearch)
	deps.Router.With(read).Get("/api/v1/campaign-template-saved-searches/{id}", deps.CampaignTemplates.GetSavedSearch)
	deps.Router.With(read).Patch("/api/v1/campaign-template-saved-searches/{id}", deps.CampaignTemplates.UpdateSavedSearch)
	deps.Router.With(read).Delete("/api/v1/campaign-template-saved-searches/{id}", deps.CampaignTemplates.DeleteSavedSearch)
	deps.Router.With(read).Get("/api/v1/campaign-template-saved-searches/{id}/results", deps.CampaignTemplates.SavedSearchResults)
	deps.Router.With(read).Get("/api/v1/campaign-templates/{id}", deps.CampaignTemplates.Get)
	deps.Router.With(read).Get("/api/v1/campaign-templates/{id}/revisions", deps.CampaignTemplates.ListRevisions)
	deps.Router.With(read).Get("/api/v1/campaign-templates/{id}/revisions/{version}", deps.CampaignTemplates.GetRevision)
	deps.Router.With(read).Get("/api/v1/campaign-templates/{id}/review-events", deps.CampaignTemplates.ListReviewEvents)
	deps.Router.With(read).Get("/api/v1/campaign-templates/block-impact/{blockId}", deps.CampaignTemplates.BlockImpact)
	deps.Router.With(read).Get("/api/v1/campaign-templates/{id}/flow-usage", deps.CampaignTemplates.FlowUsage)
	deps.Router.With(read).Get("/api/v1/campaign-templates/stats", deps.CampaignTemplates.Stats)
	deps.Router.With(read).Get("/api/v1/campaign-templates/goals", deps.CampaignTemplates.Goals)
	deps.Router.With(read).Get("/api/v1/campaign-template-designs", deps.CampaignTemplates.ListDesignDrafts)
	deps.Router.With(read).Get("/api/v1/campaign-template-designs/{id}", deps.CampaignTemplates.GetDesignDraft)
	deps.Router.With(read).Get("/api/v1/campaign-template-designs/{id}/revisions", deps.CampaignTemplates.ListDesignDraftRevisions)
	deps.Router.With(write).Post("/api/v1/campaign-template-designs", deps.CampaignTemplates.CreateDesignDraft)
	deps.Router.With(write).Post("/api/v1/campaign-template-designs/{id}/refine", deps.CampaignTemplates.RefineDesignDraft)
	deps.Router.With(write).Post("/api/v1/campaign-template-designs/{id}/retry", deps.CampaignTemplates.RetryDesignDraft)
	deps.Router.With(write).Post("/api/v1/campaign-template-designs/{id}/save", deps.CampaignTemplates.SaveDesignDraft)
	deps.Router.With(write).Post("/api/v1/campaign-template-designs/{id}/create-campaign", deps.CampaignTemplates.CreateCampaignFromDesignDraft)
	deps.Router.With(write).Post("/api/v1/campaign-template-designs/{id}/archive", deps.CampaignTemplates.ArchiveDesignDraft)
	deps.Router.With(write).Post("/api/v1/campaign-templates/generate", deps.CampaignTemplates.Generate)
	deps.Router.With(write).Post("/api/v1/campaign-templates/from-generated-design", deps.CampaignTemplates.SaveGeneratedDesign)
	deps.Router.With(write).Post("/api/v1/campaign-templates/import", deps.CampaignTemplates.Import)
	deps.Router.With(write).Post("/api/v1/campaign-templates", deps.CampaignTemplates.Create)
	deps.Router.With(write).Patch("/api/v1/campaign-templates/{id}", deps.CampaignTemplates.Update)
	deps.Router.With(write).Post("/api/v1/campaign-templates/{id}/review-events", deps.CampaignTemplates.AddReviewEvent)
	deps.Router.With(write).Patch("/api/v1/campaign-templates/{id}/archive", deps.CampaignTemplates.Archive)
	deps.Router.With(write).Patch("/api/v1/campaign-templates/{id}/restore", deps.CampaignTemplates.Restore)
	deps.Router.With(write).Delete("/api/v1/campaign-templates/{id}", deps.CampaignTemplates.Delete)
	deps.Router.With(admin).Post("/api/v1/campaign-templates/{id}/review-decisions", deps.CampaignTemplates.ReviewReferenceDecision)
	deps.Router.With(write).Post("/api/v1/campaign-templates/{id}/revisions/{version}/restore", deps.CampaignTemplates.RestoreRevision)
	deps.Router.With(write).Post("/api/v1/campaign-templates/{id}/clone", deps.CampaignTemplates.Clone)
	deps.Router.With(write).Post("/api/v1/campaign-templates/{id}/adapt", deps.CampaignTemplates.Adapt)
	deps.Router.With(write).Post("/api/v1/campaign-templates/{id}/create-campaign", deps.CampaignTemplates.CreateCampaignFromTemplate)
	deps.Router.With(write).Post("/api/v1/campaigns/from-template", deps.CampaignTemplates.CreateCampaignFromTemplate)
	deps.Router.With(write).Post("/api/v1/campaign-templates/{id}/use", deps.CampaignTemplates.RecordUse)
	deps.Router.With(read).Post("/api/v1/campaign-templates/{id}/favorite", deps.CampaignTemplates.Favorite)
	deps.Router.With(read).Post("/api/v1/campaign-templates/{id}/unfavorite", deps.CampaignTemplates.Unfavorite)
	deps.Router.With(read).Post("/api/v1/campaign-templates/{id}/view", deps.CampaignTemplates.RecordRecentView)
}

// MountCampaignABTestRoutes registers variant, settings, evaluation, and result
// routes on the shared A/B dependency graph captured by its scheduler.
func MountCampaignABTestRoutes(deps Deps) {
	if deps.Router == nil || deps.CampaignABTests == nil {
		return
	}

	deps.CampaignABTests.MountRoutes(deps.Router)
}

// MountSendTimeOptimizationRoutes registers best-time and heatmap routes using
// the same repository and warmup gate as the compute/materializer workers.
func MountSendTimeOptimizationRoutes(deps Deps) {
	if deps.Router == nil || deps.SendTimeOptimization == nil {
		return
	}

	deps.SendTimeOptimization.MountRoutes(deps.Router)
	deps.SendTimeOptimization.MountPatternRoutes(deps.Router)
	deps.SendTimeOptimization.MountSchedulePreviewRoute(deps.Router)
}

// MountCampaignSendDomainRoutes registers resend, lifecycle, recurrence, and
// related send-domain extensions before the subscriber merge surface.
func MountCampaignSendDomainRoutes(deps Deps) {
	if deps.Router == nil || deps.Campaigns == nil {
		return
	}

	campaigns.MountSendDomain(deps.Router, deps.Campaigns)
	// The lifecycle owner for scheduled_at. PATCH /campaigns/{id} has always
	// refused that field and pointed at "campaign lifecycle endpoints"; until
	// this route existed there was no such endpoint, so the desktop calendar's
	// drag-to-reschedule 422'd on every drop.
	campaigns.MountSchedule(deps.Router, deps.Campaigns)
}

// MountSendingIdentityRoutes registers the DNS identity wizard. Its resolver
// remains the package's production default and the repository uses the shared
// process pool, exactly as in the former composition-root registration.
func MountSendingIdentityRoutes(deps Deps) {
	if deps.Router == nil || deps.Pool == nil {
		return
	}

	sending_identity.MountRoutes(deps.Router, &sending_identity.Deps{
		Pool:     deps.Pool,
		Resolver: sending_identity.DefaultResolver(),
	})
}

// MountCampaignTemplateRegionRoutes remains separate so the email-block
// registrations retain their original position before this read endpoint.
func MountCampaignTemplateRegionRoutes(deps Deps) {
	if deps.Router == nil || deps.CampaignTemplates == nil {
		return
	}

	deps.Router.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).
		Get("/api/v1/campaign-templates/{id}/regions", deps.CampaignTemplates.Regions)
}

// MountSendWindowRoutes registers the tenant send-window policy against the
// shared pool. Logger intentionally remains nil to match the original wiring.
func MountSendWindowRoutes(deps Deps) {
	if deps.Router == nil || deps.Pool == nil {
		return
	}

	send_window.MountRoutes(deps.Router, &send_window.Deps{Pool: deps.Pool})
}

// MountCampaignMutationRoutes registers the complete pre-compose campaign
// mutation and preview block before adjacent reply/translation/summary routes.
func MountCampaignMutationRoutes(deps Deps) {
	if deps.Router == nil || deps.Campaigns == nil || deps.CampaignAudienceCount == nil ||
		deps.CampaignSendPreview == nil {
		return
	}

	campaigns.MountWrite(deps.Router, deps.Campaigns)
	campaigns.MountFolders(deps.Router, deps.Campaigns)
	campaigns.MountFeedback(deps.Router, deps.Campaigns)
	campaigns.MountChecklist(deps.Router, deps.Campaigns)
	campaigns.MountPSTO(deps.Router, deps.Campaigns)
	campaigns.MountPreviewAs(deps.Router, deps.Campaigns)
	campaigns.MountGoalResults(deps.Router, deps.Campaigns)
	campaigns.MountAudienceCount(deps.Router, deps.CampaignAudienceCount)
	campaigns.MountOrgTags(deps.Router, deps.Campaigns)
	campaigns.MountAudienceFreeze(deps.Router, deps.Campaigns)
	campaigns.MountSendPreview(deps.Router, deps.Campaigns, deps.CampaignSendPreview)
}

// MountCampaignComposeRoutes remains separate so the adjacent campaign reply,
// translation, campaign-summary, and profile-summary mounts stay ahead of it.
func MountCampaignComposeRoutes(deps Deps) {
	if deps.Router == nil || deps.Campaigns == nil {
		return
	}

	campaigns.MountCompose(deps.Router, deps.Campaigns)
}

// MountDedicatedIPRoutes registers dedicated-IP assignment and reputation
// reads using a fresh route-side repository, matching the original wiring.
func MountDedicatedIPRoutes(deps Deps) {
	if deps.Router == nil || deps.Pool == nil {
		return
	}

	sending.MountDedicatedIPRoutes(deps.Router, &sending.DedicatedIPHandlersDeps{
		Repo: &sending.DedicatedIPRepo{Pool: deps.Pool},
	})
}

// MountCampaignABCreateRoutes registers the idempotent multi-variant campaign
// creation endpoint with its original write-campaign scope.
func MountCampaignABCreateRoutes(deps Deps) {
	if deps.Router == nil || deps.Campaigns == nil {
		return
	}

	deps.Router.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
		Post("/api/v1/campaigns/ab-test", deps.Campaigns.CreateABTest)
}

// MountCampaignSendRoutes installs the directly inseparable two-scope gate
// around live dispatch. The caller still supplies the idempotency-protected
// authenticated router, preserving the complete outer security stack.
func MountCampaignSendRoutes(deps Deps) {
	if deps.Router == nil || deps.Campaigns == nil || deps.CampaignSend == nil {
		return
	}

	deps.Router.With(apikeys.RequireAllScopes(
		apikeys.ScopeWriteCampaigns,
		apikeys.ScopeSendTransactional,
	)).Group(func(scopedRouter chi.Router) {
		campaigns.MountSend(scopedRouter, deps.Campaigns, deps.CampaignSend)
	})
}

// MountCampaignQueueRoutes registers recipient materialization at its original
// point after transactional-email and SMTP-relay assembly.
func MountCampaignQueueRoutes(deps Deps) {
	if deps.Router == nil || deps.Campaigns == nil {
		return
	}

	campaigns.MountQueue(deps.Router, deps.Campaigns)
}

// MountCampaignSendingSurface assembles the complete migrated route group for
// standalone server construction. main.go invokes the focused helpers at their
// original interleaving points to retain adjacent package ordering.
func MountCampaignSendingSurface(deps Deps) {
	if deps.Router == nil || deps.Pool == nil || deps.Campaigns == nil ||
		deps.CampaignTemplates == nil || deps.CampaignABTests == nil ||
		deps.SendTimeOptimization == nil || deps.CampaignAudienceCount == nil ||
		deps.CampaignSendPreview == nil || deps.CampaignSend == nil {
		return
	}

	MountCampaignReadRoutes(deps)
	MountCampaignTemplateRoutes(deps)
	MountCampaignABTestRoutes(deps)
	MountCampaignSendDomainRoutes(deps)
	MountSendTimeOptimizationRoutes(deps)
	MountSendingIdentityRoutes(deps)
	MountCampaignTemplateRegionRoutes(deps)
	MountSendWindowRoutes(deps)
	MountCampaignMutationRoutes(deps)
	MountCampaignComposeRoutes(deps)
	MountDedicatedIPRoutes(deps)
	MountCampaignABCreateRoutes(deps)
	MountCampaignSendRoutes(deps)
	MountCampaignQueueRoutes(deps)
}
