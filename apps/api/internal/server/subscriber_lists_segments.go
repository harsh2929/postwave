// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"github.com/postwave/postwave/apps/api/internal/audiences"
	"github.com/postwave/postwave/apps/api/internal/merge_fields"
	"github.com/postwave/postwave/apps/api/internal/segments"
	"github.com/postwave/postwave/apps/api/internal/subscribers"
)

func MountLookalikeAudienceRoutes(deps Deps) *audiences.Deps {
	if deps.Router == nil || deps.Pool == nil {
		return nil
	}
	routes := &audiences.Deps{Repo: &audiences.Repo{Pool: deps.Pool}, Logger: deps.Logger}
	audiences.MountRoutes(deps.Router, routes)
	return routes
}

// MountSegmentRoutes registers the saved-segment, builder-schema, folder, and
// template routes. The caller retains ownership of the shared segment Deps so
// its repository and optional AI provider remain identical to adjacent workers.
func MountSegmentRoutes(deps Deps) {
	if deps.Router == nil || deps.Segments == nil {
		return
	}

	segments.Mount(deps.Router, deps.Segments)
	segments.MountSchemaRoute(deps.Router, deps.Segments)
	segments.MountSavedRoutes(deps.Router, deps.Segments)
	segments.MountFolderRoutes(deps.Router, deps.Segments)
	segments.MountExtended(deps.Router, deps.Segments)
	segments.MountTemplatesRoute(deps.Router, deps.Segments)
}

// MountSegmentDecayRoutes registers the decay radar on the same store and AI
// provider used by the background decay pipeline.
func MountSegmentDecayRoutes(deps Deps) {
	if deps.Router == nil || deps.Segments == nil || deps.SegmentDecayStore == nil {
		return
	}

	segments.MountDecayRoutes(deps.Router, &segments.DecayDeps{
		DecayStore: deps.SegmentDecayStore,
		AIProvider: deps.Segments.AIProvider,
		Logger:     deps.Logger,
	})
}

// MountMergeFieldRoutes registers the tenant merge-field schema and value
// surface against the process-wide database pool.
func MountMergeFieldRoutes(deps Deps) {
	if deps.Router == nil || deps.Pool == nil {
		return
	}

	mergeFieldsDeps := &merge_fields.Deps{
		Repo:   &merge_fields.Repo{Pool: deps.Pool},
		Logger: deps.Logger,
	}
	mergeFieldsDeps.MountRoutes(deps.Router)
}

// MountSubscriberReadRoutes registers the canonical subscriber read surface.
func MountSubscriberReadRoutes(deps Deps) {
	if deps.Router == nil || deps.Subscribers == nil {
		return
	}

	subscribers.MountRead(deps.Router, deps.Subscribers)
}

// MountListRoutes registers the complete non-create list surface in its
// original order. List creation remains in MountIdempotentListRoutes because it
// must inherit the composition root's idempotency middleware.
func MountListRoutes(deps Deps) {
	if deps.Router == nil || deps.Lists == nil {
		return
	}

	deps.Lists.MountRoutes(deps.Router)
	deps.Lists.MountAnalyticsRoutes(deps.Router)
	deps.Lists.MountGrowthRoutes(deps.Router)
	deps.Lists.MountVersionRoutes(deps.Router)
	deps.Lists.MountArchiveRoutes(deps.Router)
	deps.Lists.MountMergeFieldRoutes(deps.Router)
	deps.Lists.MountWebhookRoutes(deps.Router)
	deps.Lists.MountImportExportRoutes(deps.Router)
}

// MountSubscriberMergeRoutes registers merge, transform, engagement, and CSV
// export extensions before the adjacent subscriber-score surface.
func MountSubscriberMergeRoutes(deps Deps) {
	if deps.Router == nil || deps.Subscribers == nil {
		return
	}

	subscribers.MountMergeRoutes(deps.Router, deps.Subscribers)
	subscribers.MountBulkMergeRoutes(deps.Router, deps.Subscribers)
	subscribers.MountTransformRuleRoutes(deps.Router, deps.Subscribers)
	subscribers.MountEngagementRoutes(deps.Router, deps.Subscribers)
	subscribers.MountCSVExportRoutes(deps.Router, deps.Subscribers)
}

// MountSubscriberProfileRoutes registers the complete subscriber drill-down,
// privacy, bulk-operation, import-template, and audience-refinement surface.
func MountSubscriberProfileRoutes(deps Deps) {
	if deps.Router == nil || deps.Subscribers == nil {
		return
	}

	subscribers.MountTimelineRoutes(deps.Router, deps.Subscribers)
	subscribers.MountAttributeHistoryRoutes(deps.Router, deps.Subscribers)
	subscribers.MountSoftDeleteRoutes(deps.Router, deps.Subscribers)
	subscribers.MountAccountLinkRoutes(deps.Router, deps.Subscribers)
	subscribers.MountFederationRoutes(deps.Router, deps.Subscribers)
	subscribers.MountCatalogAttributesRoutes(deps.Router, deps.Subscribers)
	subscribers.MountReplenishmentCadenceRoutes(deps.Router, deps.Subscribers)
	subscribers.MountDemographicsRoutes(deps.Router, deps.Subscribers)
	subscribers.MountPredictionMetadataRoutes(deps.Router, deps.Subscribers)
	subscribers.MountDataExportRoutes(deps.Router, deps.Subscribers)
	subscribers.MountConsentReceiptRoutes(deps.Router, deps.Subscribers)
	subscribers.MountErasureReceiptRoutes(deps.Router, deps.Subscribers)
	subscribers.MountJurisdictionRoutes(deps.Router, deps.Subscribers)
	subscribers.MountBulkRoutes(deps.Router, deps.Subscribers)
	subscribers.MountImportTemplateRoutes(deps.Router, deps.Subscribers)
	subscribers.MountIdentityGraphRoutes(deps.Router, deps.Subscribers)
	subscribers.MountMultiEmailRoutes(deps.Router, deps.Subscribers)
	subscribers.MountChannelConsentRoutes(deps.Router, deps.Subscribers)
	subscribers.MountSendTimesRoutes(deps.Router, deps.Subscribers)
	subscribers.MountGroupMembershipRoutes(deps.Router, deps.Subscribers)
	subscribers.MountSubscriberEventRoutes(deps.Router, deps.Subscribers)
	subscribers.MountAuditLogRoutes(deps.Router, deps.Subscribers)
	subscribers.MountIdentifierTransformRoutes(deps.Router, deps.Subscribers)
	subscribers.MountPIIConfigRoutes(deps.Router, deps.Subscribers)
	subscribers.MountGppRoutes(deps.Router, deps.Subscribers)
	subscribers.MountDecisionExplanationRoutes(deps.Router, deps.Subscribers)
	subscribers.MountLookalikeRoutes(deps.Router, deps.Subscribers)
	subscribers.MountPreSendRefineRoutes(deps.Router, deps.Subscribers)
}

// MountSubscriberGrowthRoutes remains a separate helper so main.go can retain
// lifecycle and PII-scanner mounts in their exact position ahead of it.
func MountSubscriberGrowthRoutes(deps Deps) {
	if deps.Router == nil || deps.Subscribers == nil {
		return
	}

	subscribers.MountGrowthRoutes(deps.Router, deps.Subscribers)
}

// MountIdempotentListRoutes registers list creation. The caller must pass the
// idempotency-protected authenticated router; this helper installs no middleware.
func MountIdempotentListRoutes(deps Deps) {
	if deps.Router == nil || deps.IdempotentLists == nil {
		return
	}

	deps.IdempotentLists.MountIdempotentRoutes(deps.Router)
}

// MountSubscriberWriteRoutes registers subscriber writes and external-ID
// identify/upsert inside the caller's idempotency-protected route group.
func MountSubscriberWriteRoutes(deps Deps) {
	if deps.Router == nil || deps.Subscribers == nil {
		return
	}

	subscribers.MountWrite(deps.Router, deps.Subscribers)
	subscribers.MountIdentifyRoutes(deps.Router, deps.Subscribers)
}

// MountSubscriberListSegmentSurface assembles the complete migrated surface
// for standalone server construction. main.go calls the same focused helpers at
// their original interleaving points so adjacent package order is unchanged.
func MountSubscriberListSegmentSurface(deps Deps) {
	if deps.Router == nil || deps.Pool == nil || deps.Subscribers == nil ||
		deps.Lists == nil || deps.IdempotentLists == nil || deps.Segments == nil ||
		deps.SegmentDecayStore == nil {
		return
	}

	MountSegmentRoutes(deps)
	MountSegmentDecayRoutes(deps)
	MountMergeFieldRoutes(deps)
	MountSubscriberReadRoutes(deps)
	MountListRoutes(deps)
	MountSubscriberMergeRoutes(deps)
	MountSubscriberProfileRoutes(deps)
	MountSubscriberGrowthRoutes(deps)
	MountIdempotentListRoutes(deps)
	MountSubscriberWriteRoutes(deps)
}
