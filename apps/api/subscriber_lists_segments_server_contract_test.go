// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestMainDelegatesSubscriberListSegmentSurfaceToServer prevents the migrated
// registrations from drifting back into the composition root or crossing the
// authenticated and idempotency boundaries that protect them.
func TestMainDelegatesSubscriberListSegmentSurfaceToServer(t *testing.T) {
	t.Parallel()

	root := readAPICompositionRoot(t)
	source := root.main

	for _, forbidden := range []string{
		"audiences.MountRoutes(r,",
		"segments.Mount(r,",
		"segments.MountSchemaRoute(r,",
		"segments.MountSavedRoutes(r,",
		"segments.MountFolderRoutes(r,",
		"segments.MountExtended(r,",
		"segments.MountTemplatesRoute(r,",
		"segments.MountDecayRoutes(r,",
		"mergeFieldsDeps.MountRoutes(r)",
		"subscribers.MountRead(r,",
		"listsDeps.MountRoutes(r)",
		"listsDeps.MountAnalyticsRoutes(r)",
		"listsDeps.MountGrowthRoutes(r)",
		"listsDeps.MountVersionRoutes(r)",
		"listsDeps.MountArchiveRoutes(r)",
		"listsDeps.MountMergeFieldRoutes(r)",
		"listsDeps.MountWebhookRoutes(r)",
		"listsDeps.MountImportExportRoutes(r)",
		"subscribers.MountMergeRoutes(r,",
		"subscribers.MountBulkMergeRoutes(r,",
		"subscribers.MountTransformRuleRoutes(r,",
		"subscribers.MountEngagementRoutes(r,",
		"subscribers.MountCSVExportRoutes(r,",
		"subscribers.MountTimelineRoutes(r,",
		"subscribers.MountAttributeHistoryRoutes(r,",
		"subscribers.MountSoftDeleteRoutes(r,",
		"subscribers.MountAccountLinkRoutes(r,",
		"subscribers.MountFederationRoutes(r,",
		"subscribers.MountCatalogAttributesRoutes(r,",
		"subscribers.MountReplenishmentCadenceRoutes(r,",
		"subscribers.MountDemographicsRoutes(r,",
		"subscribers.MountPredictionMetadataRoutes(r,",
		"subscribers.MountDataExportRoutes(r,",
		"subscribers.MountConsentReceiptRoutes(r,",
		"subscribers.MountErasureReceiptRoutes(r,",
		"subscribers.MountJurisdictionRoutes(r,",
		"subscribers.MountBulkRoutes(r,",
		"subscribers.MountImportTemplateRoutes(r,",
		"subscribers.MountIdentityGraphRoutes(r,",
		"subscribers.MountMultiEmailRoutes(r,",
		"subscribers.MountChannelConsentRoutes(r,",
		"subscribers.MountSendTimesRoutes(r,",
		"subscribers.MountGroupMembershipRoutes(r,",
		"subscribers.MountSubscriberEventRoutes(r,",
		"subscribers.MountAuditLogRoutes(r,",
		"subscribers.MountIdentifierTransformRoutes(r,",
		"subscribers.MountPIIConfigRoutes(r,",
		"subscribers.MountGppRoutes(r,",
		"subscribers.MountDecisionExplanationRoutes(r,",
		"subscribers.MountLookalikeRoutes(r,",
		"subscribers.MountPreSendRefineRoutes(r,",
		"subscribers.MountGrowthRoutes(r,",
		"idemListsDeps.MountIdempotentRoutes(r)",
		"subscribers.MountWrite(r,",
		"subscribers.MountIdentifyRoutes(r,",
	} {
		if strings.Contains(root.all, forbidden) {
			t.Fatalf("composition root bypasses internal/server with %q", forbidden)
		}
	}

	assertMainMarkersInOrder(t, source, []string{
		"// Authenticated group 1/2:",
		"apiserver.MountFormAdminRoutes(",
		"apiserver.MountSegmentRoutes(apiserver.Deps{Router: r, Segments: segmentsDeps})",
		"apiserver.MountLookalikeAudienceRoutes(",
		"apiserver.MountSegmentDecayRoutes(apiserver.Deps{",
		"segmentSnapshotWorker := &segments.SnapshotWorker{",
	})
	assertMainMarkersInOrder(t, source, []string{
		"safego.Go(logger, \"segment-decay-worker\"",
		"apiserver.MountMergeFieldRoutes(apiserver.Deps{Router: r, Pool: pool})",
		"apiserver.MountSubscriberPersonalizationRoutes(",
	})
	assertMainMarkersInOrder(t, source, []string{
		"onsite_growth.MountRoutes(r,",
		"apiserver.MountSubscriberReadRoutes(apiserver.Deps{Router: r, Subscribers: subscriberDeps})",
		"// Canonical campaign read surface.",
	})
	assertMainMarkersInOrder(t, source, []string{
		"listsDeps.RequireWebhookHTTPS = requireOutboundWebhookHTTPS",
		"apiserver.MountListRoutes(apiserver.Deps{Router: r, Lists: listsDeps})",
		"tagsHistory := flowTagsHistory",
	})
	assertMainMarkersInOrder(t, source, []string{
		"apiserver.MountCampaignSendDomainRoutes(apiserver.Deps{Router: r, Campaigns: campaignDeps})",
		"apiserver.MountSubscriberMergeRoutes(apiserver.Deps{Router: r, Subscribers: subscriberDeps})",
		"subscriberscore.MountRoutes(r,",
		"apiserver.MountSubscriberProfileRoutes(apiserver.Deps{Router: r, Subscribers: subscriberDeps})",
		"lifecycle.MountRoutes(r,",
		"pii_scanner.MountRoutes(r, piiScannerDeps)",
		"apiserver.MountSubscriberGrowthRoutes(apiserver.Deps{Router: r, Subscribers: subscriberDeps})",
	})
	assertMainMarkersInOrder(t, source, []string{
		"// Authenticated group 2/2:",
		"r.Use(idempotentRoutes)",
		"idemListsDeps := lists.New(",
		"apiserver.MountIdempotentListRoutes(apiserver.Deps{Router: r, IdempotentLists: idemListsDeps})",
		"idempotency.MountInspectorRoutes(r,",
	})
	assertMainMarkersInOrder(t, source, []string{
		"apiserver.MountCampaignQueueRoutes(apiserver.Deps{Router: r, Campaigns: campaignDeps})",
		"smsDeps.MountIdempotentRoutes(r, veryExpensiveTenantLimit.Middleware)",
		"apiserver.MountSubscriberWriteRoutes(apiserver.Deps{Router: r, Subscribers: subscriberDeps})",
		"onboardingDeps := &onboarding.Deps{",
	})
}

func assertMainMarkersInOrder(t *testing.T, source string, ordered []string) {
	t.Helper()
	last := -1
	for _, marker := range ordered {
		index := strings.Index(source, marker)
		if index < 0 {
			t.Fatalf("main.go is missing composition marker %q", marker)
		}
		if index <= last {
			t.Fatalf("composition marker %q is out of order", marker)
		}
		last = index
	}
}

func TestMigrationMountRoutesInventoryIsExact(t *testing.T) {
	t.Parallel()

	// 39 + four mounts, each added deliberately:
	//   flowsteps.Deps.MountRoutes    — GET /api/v1/flow-runs/{run_id}/steps
	//   experiments.IdentityDeps      — the experiment identity the nine variant
	//                                   systems register into
	//   coderedemption.MountRoutes    — POST /api/v1/codes/redeem (PRD F04)
	//   aeo.MountRoutes               — /api/v1/aeo/* (AEO Sensor; 13 routes that
	//                                   existed in internal/aeo but were never
	//                                   mounted, 2026-09-12 web↔desktop parity)
	//
	// polls.MountPublicRoutes and offers.MountPublicRoutes are NOT counted here:
	// this check matches the literal `MountRoutes(` name, and those two are public
	// surfaces with their own names. That is a limitation worth stating rather than
	// papering over — the count guards a naming convention, not the full route
	// table, and `pnpm audit:routes` is what guards the latter.
	//
	// The literal count is the point of this test: a route mounted without being
	// counted here is a route nobody reviewed, so the number moves deliberately.
	mainCount := countMountRoutesCalls(t, "main.go")
	if mainCount != 43 {
		t.Fatalf("main.go literal MountRoutes call sites = %d, want 43", mainCount)
	}
	// main.go was the whole composition root when this inventory was written,
	// and it still holds every literal MountRoutes call. The package's other
	// files do register routes — ops_console_wiring.go's 18 console routes,
	// startup_configuration.go's region and migration routes, the Campaign
	// Assurance mounts — but none through a literal MountRoutes call, and that
	// must stay true in every file of the composition root, including one added
	// later: a MountRoutes call there would be a route this inventory never
	// counted.
	for _, path := range readAPICompositionRoot(t).names {
		if path == "main.go" {
			continue
		}
		if got := countMountRoutesCalls(t, path); got != 0 {
			t.Fatalf("%s literal MountRoutes call sites = %d, want 0: this inventory counts "+
				"MountRoutes calls in main.go only", path, got)
		}
	}

	serverFiles, err := filepath.Glob("internal/server/*.go")
	if err != nil {
		t.Fatalf("glob internal/server: %v", err)
	}
	serverCount := 0
	for _, path := range serverFiles {
		if strings.HasSuffix(path, "_test.go") {
			continue
		}
		serverCount += countMountRoutesCalls(t, path)
	}
	// 121, not the 116 in the Phase 1 migration ratio. Every one of the five
	// extras is a net-new surface authored directly in internal/server rather
	// than a call site moved out of main.go, so none of them changes the
	// migration ratio this test exists to police — main.go still holds exactly
	// 39, which the assertion above pins:
	//
	//   +1 MountVerificationSurface
	//   +2 MountContinuityRoutes, which mounts BOTH activitycursor and
	//      editorcheckpoint so a resume offer cannot ship without the draft
	//      behind it. Previously counted here as +1: the helper is one function
	//      but two call sites, and the pair was undercounted.
	//   +1 operation, the cross-family GET /api/v1/operations view
	//   +1 action tickets
	//   +1 the engagement-classification read surface (PRD F01):
	//      GET /api/v1/analytics/engagement-classification/summary and
	//      /human-engaged-reach. Net-new rather than moved — before this there
	//      was no HTTP path to the human/machine split at all, so the numbers
	//      existed only inside the classifier.
	//
	// (116 + 6 = 122; the count is asserted rather than derived because the
	// point is to notice when a mount appears, not to accept whatever is there.
	// MountAgentMandateRoutes is deliberately absent from this list — it mounts
	// its surface without a literal .MountRoutes call, so it is not part of this
	// inventory.)
	if serverCount != 122 {
		t.Fatalf("internal/server literal MountRoutes call sites = %d, want 122", serverCount)
	}

	migrationBytes, err := os.ReadFile("MIGRATION.md")
	if err != nil {
		t.Fatalf("read MIGRATION.md: %v", err)
	}
	migration := string(migrationBytes)
	for _, marker := range []string{
		"116 / 155 literal `MountRoutes` call sites moved",
		"39 remain in `main.go` and 121 now live in",
		"445 registration calls and 1361 routes",
		"54 registrations / 191 routes",
		"35 registrations / 75 routes",
		"48 registrations / 87 routes",
		"39 registrations / 60 routes",
		"48 registrations / 48 routes",
		"5 registrations / 30 routes",
		"3 registrations / 77 routes",
		"7 registrations / 65 routes",
		"8 registrations / 117 routes",
		"17 registrations / 74 routes",
		"12 registrations / 35 routes",
		"2 registrations / 18 routes",
		"12 registrations / 37 routes",
		"30 registrations / 30 routes",
		"16 registrations / 16 routes",
		"29 registrations / 31 routes",
		"15 registrations / 29 routes",
		"9 registrations / 15 routes",
		"7 registrations / 16 routes",
		"3 registrations / 52 routes",
		"6 registrations / 18 routes",
		"3 registrations / 11 routes",
		"3 registrations / 6 routes",
		"5 registrations / 18 routes",
		"2 registrations / 10 routes",
		"1 registration / 2 routes",
		"1 registration / 4 routes",
		"6 registrations / 93 routes",
		"4 registrations / 11 routes",
		"3 registrations / 42 routes",
	} {
		if !strings.Contains(migration, marker) {
			t.Fatalf("MIGRATION.md is missing exact inventory marker %q", marker)
		}
	}
}

func countMountRoutesCalls(t *testing.T, path string) int {
	t.Helper()
	file, err := parser.ParseFile(token.NewFileSet(), path, nil, 0)
	if err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	count := 0
	ast.Inspect(file, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok {
			return true
		}
		selector, ok := call.Fun.(*ast.SelectorExpr)
		if ok && selector.Sel.Name == "MountRoutes" {
			count++
		}
		return true
	})
	return count
}
