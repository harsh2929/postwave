// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"strings"
	"testing"
)

// TestMainDelegatesCampaignSendingSurfaceToServer pins every migrated helper to
// the authenticated or idempotency-protected composition point it replaced.
func TestMainDelegatesCampaignSendingSurfaceToServer(t *testing.T) {
	t.Parallel()

	root := readAPICompositionRoot(t)
	source := root.main

	for _, forbidden := range []string{
		"campaigns.MountRead(r,",
		"ctplDeps.List)",
		"ctplDeps.Get)",
		"ctplDeps.Stats)",
		"ctplDeps.Goals)",
		"ctplDeps.Create)",
		"ctplDeps.Update)",
		"ctplDeps.Delete)",
		"ctplDeps.Clone)",
		"ctplDeps.RecordUse)",
		"ctplDeps.Favorite)",
		"ctplDeps.Unfavorite)",
		"ctplDeps.Regions)",
		"abDeps.MountRoutes(r)",
		"stoDeps.MountRoutes(r)",
		"stoDeps.MountPatternRoutes(r)",
		"campaigns.MountSendDomain(r,",
		"sending_identity.MountRoutes(r,",
		"send_window.MountRoutes(r,",
		"campaigns.MountWrite(r,",
		"campaigns.MountFolders(r,",
		"campaigns.MountFeedback(r,",
		"campaigns.MountChecklist(r,",
		"campaigns.MountPSTO(r,",
		"campaigns.MountPreviewAs(r,",
		"campaigns.MountGoalResults(r,",
		"campaigns.MountAudienceCount(r,",
		"campaigns.MountOrgTags(r,",
		"campaigns.MountAudienceFreeze(r,",
		"campaigns.MountSendPreview(r,",
		"campaigns.MountCompose(r,",
		"sending.MountDedicatedIPRoutes(r,",
		"Post(\"/api/v1/campaigns/ab-test\", campaignDeps.CreateABTest)",
		"campaigns.MountSend(r,",
		"campaigns.MountQueue(r,",
	} {
		if strings.Contains(root.all, forbidden) {
			t.Fatalf("composition root bypasses internal/server with %q", forbidden)
		}
	}

	assertMainMarkersInOrder(t, source, []string{
		"// Authenticated group 1/2:",
		"apiserver.MountSubscriberReadRoutes(apiserver.Deps{Router: r, Subscribers: subscriberDeps})",
		"apiserver.MountCampaignReadRoutes(apiserver.Deps{Router: r, Campaigns: campaignDeps})",
		"analyticsRealtime := apiserver.MountAnalyticsRealtimeAndLandingRoutes(",
	})
	assertMainMarkersInOrder(t, source, []string{
		"analyticsRepo := analyticsRealtime.Repo",
		"ctplDeps := &campaigntemplates.Deps{",
		"apiserver.MountCampaignTemplateRoutes(apiserver.Deps{Router: r, CampaignTemplates: ctplDeps})",
		"apiserver.MountConversionAdminRoutes(r, pool)",
	})
	assertMainMarkersInOrder(t, source, []string{
		"apiserver.MountCollaborationIntegrations(",
		// Prefix form, matching `ctplDeps := &campaigntemplates.Deps{` above.
		// This pins WHERE abDeps is constructed in the composition order, which
		// is what the test is for; it does not pin the field list, which the
		// compiler already checks and which legitimately grows (EditLease was
		// added so "who is asking" has one definition rather than one per
		// package). A marker that spells out every field fails on the next
		// honest field addition and says nothing about ordering.
		"abDeps := &abtests.Deps{",
		"apiserver.MountCampaignABTestRoutes(apiserver.Deps{Router: r, CampaignABTests: abDeps})",
		"compat.Mount(r, compatDeps)",
	})
	assertMainMarkersInOrder(t, source, []string{
		"apiserver.MountListRoutes(apiserver.Deps{Router: r, Lists: listsDeps})",
		"apiserver.MountCampaignSendDomainRoutes(apiserver.Deps{Router: r, Campaigns: campaignDeps})",
		"apiserver.MountSubscriberMergeRoutes(apiserver.Deps{Router: r, Subscribers: subscriberDeps})",
	})
	assertMainMarkersInOrder(t, source, []string{
		"stoDeps := &send_time_opt.Deps{",
		"apiserver.MountSendTimeOptimizationRoutes(apiserver.Deps{Router: r, SendTimeOptimization: stoDeps})",
		"stoWorker := send_time_opt.NewWorker(stoRepo)",
	})
	assertMainMarkersInOrder(t, source, []string{
		"apiworkers.StartSubscriptionIntegrationBackfills(outboxCtx, logger, customerLifecycleSurface)",
		"apiserver.MountSendingIdentityRoutes(apiserver.Deps{Router: r, Pool: pool})",
		"apiserver.MountImportAuditAlertRoutes(",
	})
	assertMainMarkersInOrder(t, source, []string{
		"apiserver.MountImportAuditAlertRoutes(",
		"editorQueue := apiserver.MountEditorQueueRoutes(",
		"apiserver.MountReportingComplianceTools(",
	})
	assertMainMarkersInOrder(t, source, []string{
		"apiworkers.StartDeliverabilityHub(outboxCtx, logger, deliverabilitySurface.Hub)",
		"apiserver.MountSubscriberCampaignInsightRoutes(",
		"tenantGovernance := &apiserver.TenantGovernanceDeps{",
	})
	assertMainMarkersInOrder(t, source, []string{
		"// Authenticated group 2/2:",
		"r.Use(idempotentRoutes)",
		"idempotency.MountInspectorRoutes(r,",
		"apiserver.MountCampaignMutationRoutes(apiserver.Deps{",
		"campaign_replies.MountRoutes(r,",
		"profile_summary.MountRoutes(r,",
		"apiserver.MountCampaignComposeRoutes(apiserver.Deps{Router: r, Campaigns: campaignDeps})",
		"r.Use(expensiveTenantLimit.Middleware)",
	})
	assertMainMarkersInOrder(t, source, []string{
		"apiserver.MountSCIMAdminRoutes(apiserver.Deps{",
		"apiserver.MountDedicatedIPRoutes(apiserver.Deps{Router: r, Pool: pool})",
		"apiserver.MountCampaignABCreateRoutes(apiserver.Deps{Router: r, Campaigns: campaignDeps})",
		"apiserver.MountCampaignSendRoutes(apiserver.Deps{",
		"txEmailDeps := &transactional.Deps{",
	})
	assertMainMarkersInOrder(t, source, []string{
		"safego.Go(logger, \"smtp-relay\"",
		"apiserver.MountCampaignQueueRoutes(apiserver.Deps{Router: r, Campaigns: campaignDeps})",
		"smsDeps.MountIdempotentRoutes(r, veryExpensiveTenantLimit.Middleware)",
	})

	for _, wiring := range []string{
		// The checklist and send review name list audiences only when the
		// campaigns repository carries the engine-backed namer; without it
		// every list reads "its name couldn't be loaded".
		"newCampaignListNamer(pool, listmonkClient),",
		"CampaignAudienceCount: &campaigns.AudienceCountDeps{",
		"CampaignSendPreview: &campaigns.SendPreviewDeps{",
		"Repo:         campaignDeps.Repo,",
		"Suppressions: suppressionsStore,",
		"CampaignSend: &campaigns.SendDeps{",
		"Sender:      listmonkClient,",
		"DefaultFrom: os.Getenv(\"POSTWAVE_DEFAULT_FROM_EMAIL\"),",
	} {
		if !strings.Contains(source, wiring) {
			t.Fatalf("campaign/sending server dependencies missing %q", wiring)
		}
	}
}
