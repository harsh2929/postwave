// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"strings"
	"testing"
)

// TestMainDelegatesAuditOperationsSurfaceToServer keeps the complete audit
// route block between API-key administration and MCP composition.
func TestMainDelegatesAuditOperationsSurfaceToServer(t *testing.T) {
	t.Parallel()

	root := readAPICompositionRoot(t)
	source := root.main
	for _, forbidden := range []string{
		"auditReadGate := apikeys.RequireScope",
		"auditMetaWrap := func",
		"Get(\"/api/v1/audit\", auditHandlers.List)",
		"auditHandlers.Export)",
		"auditHandlers.ListExportManifests)",
		"auditHandlers.Stats)",
		"auditHandlers.Stream)",
		"auditHandlers.ListSavedViews)",
		"auditHandlers.CreateSavedView)",
		"auditHandlers.UpdateSavedView)",
		"auditHandlers.DeleteSavedView)",
		"auditHandlers.GetRetention)",
		"auditHandlers.SetRetention)",
		"auditHandlers.QueryNaturalLanguage)",
		"auditHandlers.NLQCostStatus)",
		"handlers.AuditRBACHandlers{",
		"handlers.NewProofHandlers(",
		"auditHandlers.SessionReplay)",
		"auditHandlers.AnomalyScore)",
		"auditHandlers.RecentAnomalies)",
		"handlers.AuditInvestigationHandlers{",
		"agent.NewInvestigator(",
		// The portal-session AIVS route intentionally remains on the public
		// router. Only the authenticated audit route belongs to this server
		// surface, so pin that exact legacy registration instead of rejecting
		// the shared handler identity everywhere in main.go.
		"Get(\"/api/v1/audit/ai-session/{session_id}/aivs-bundle\", auditHandlers.AIVSBundle)",
		"auditHandlers.GetRedactionPolicy)",
		"auditHandlers.PutRedactionPolicy)",
		"auditHandlers.UnmaskPII)",
		"auditHandlers.ListRetentionActivity)",
		"auditHandlers.SetRetentionOverride)",
		"auditHandlers.Count)",
		"auditHandlers.ExportAsync)",
		"auditHandlers.ListExportJobs)",
		"auditHandlers.GetExportJob)",
		"auditHandlers.DownloadExportJob)",
		"auditHandlers.ListExportSchedules)",
		"auditHandlers.CreateExportSchedule)",
		"auditHandlers.DeleteExportSchedule)",
		"auditHandlers.EventsByIDs)",
		"auditHandlers.CreateAccessRequest)",
		"auditHandlers.ListAccessRequests)",
		"auditPortalDeps.CreateSession)",
		"auditPortalDeps.ListSessions)",
		"auditPortalDeps.RevokeSession)",
	} {
		if strings.Contains(root.all, forbidden) {
			t.Fatalf("composition root bypasses internal/server with %q", forbidden)
		}
	}

	assertMainMarkersInOrder(t, source, []string{
		"apiserver.MountAPIKeyRoutes(apiserver.Deps{Router: r, APIKeys: akDeps})",
		"auditOperations := &apiserver.AuditOperationsDeps{",
		"Handlers: auditHandlers,",
		"Portal:   auditPortalDeps,",
		"apiserver.MountAuditOperationsSurface(apiserver.Deps{",
		"AuditOperations: auditOperations",
		"mcpDeps := &apikeycalls.Deps{Repo: apiKeyCallsRepo}",
		"apiserver.MountAPIKeyCallRoutes(apiserver.Deps{Router: r, APIKeyCalls: mcpDeps})",
	})
}
