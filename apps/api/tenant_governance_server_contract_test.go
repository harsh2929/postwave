// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"strings"
	"testing"
)

// TestMainDelegatesTenantGovernanceSurfaceToServer pins the three focused
// helpers around the pre-existing audit-sink registration boundary.
func TestMainDelegatesTenantGovernanceSurfaceToServer(t *testing.T) {
	t.Parallel()

	root := readAPICompositionRoot(t)
	source := root.main

	for _, forbidden := range []string{
		"securityHandlers.Get)",
		"securityHandlers.Update)",
		"sendSettingsHandlers.Get)",
		"sendSettingsHandlers.Update)",
		"paywallDeps.List)",
		"paywallDeps.Grant)",
		"paywallDeps.Revoke)",
		"paywallDeps.MountTierRoutes(r",
		"dlqDeps.List)",
		"dlqDeps.Replay)",
		"feedbackDeps.HandleHistory)",
		"regionsHandlers.Get)",
		"emailPreviewDeps.Render)",
		"privacyDeps.RequestExport)",
		"privacyDeps.ListRequests)",
		"privacyDeps.DownloadExport)",
		"privacyDeps.RequestDeletion)",
		"privacyDeps.CreateGenericRequest)",
		"privacyDeps.IssueVerification)",
		"privacyDeps.ConfirmVerification)",
		"privacyDeps.SetLegalHold)",
		"privacyDeps.ClearLegalHold)",
		"privacyDeps.DenyRequest)",
		"privacyDeps.CreateAppeal)",
		"privacyDeps.RecordSubprocessorAck)",
		"privacy.MountIncidentRoutes(ir,",
		"privacy.MountTabletopRoutes(ir,",
		"privacy.MountDPARoutes(r,",
		"compliance.Deps{Pool: pool",
		"agency.MountRoutes(r,",
		"costHandlers.Aggregate)",
		"costHandlers.Ledger)",
		"billingHandlers.State)",
		"billingHandlers.PlanSummary)",
		"billingHandlers.Checkout)",
		"billingHandlers.Portal)",
		"billingHandlers.Invoices)",
		"billingHandlers.Usage)",
	} {
		if strings.Contains(root.all, forbidden) {
			t.Fatalf("composition root bypasses internal/server with %q", forbidden)
		}
	}

	assertMainMarkersInOrder(t, source, []string{
		"apiserver.MountSubscriberCampaignInsightRoutes(",
		"tenantGovernance := &apiserver.TenantGovernanceDeps{",
		"tenantGovernanceServerDeps := apiserver.Deps{",
		"apiserver.MountTenantPolicyRoutes(tenantGovernanceServerDeps)",
		"apiserver.MountPrivacyComplianceRoutes(tenantGovernanceServerDeps)",
		"auditAdminDeps := apiserver.NewAuditSinkAdminDeps(pool, envCipher, envCipher, logger)",
		"apiserver.MountAuditSinkRoutes(apiserver.Deps{Router: r, AuditSinkAdmin: auditAdminDeps})",
		"apiserver.MountCommercialAdminRoutes(tenantGovernanceServerDeps)",
		"approvalsDeps.Mount(r)",
	})

	for _, wiring := range []string{
		"Security:                   securityHandlers,",
		"SendSettings:               sendSettingsHandlers,",
		"Paywall:                    paywallDeps,",
		"OutboxDLQ:                  dlqDeps,",
		"Feedback:                   feedbackDeps,",
		"Regions:                    regionsHandlers,",
		"EmailPreview:               emailPreviewDeps,",
		"Privacy:                    privacyDeps,",
		"PrivacyIncidents:           privacyIncidentsDeps,",
		"PrivacyIncidentIdempotency: privacyIncidentIdempotency,",
		"Cost:                       costHandlers,",
		"Billing:                    billingHandlers,",
		"TenantGovernance: tenantGovernance",
	} {
		if !strings.Contains(source, wiring) {
			t.Fatalf("tenant-governance server dependencies missing %q", wiring)
		}
	}
}
