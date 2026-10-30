// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"strings"
	"testing"
)

// TestMainDelegatesIdentityAPISurfaceToServer pins every focused helper to the
// public, authenticated, idempotent, or internal composition point it replaced.
func TestMainDelegatesIdentityAPISurfaceToServer(t *testing.T) {
	t.Parallel()

	root := readAPICompositionRoot(t)
	source := root.main

	for _, forbidden := range []string{
		"Post(\"/api/v1/auth/signup\", authDeps.Signup)",
		"Post(\"/api/v1/auth/login\", authDeps.Login)",
		"Post(\"/api/v1/auth/logout\", authDeps.Logout)",
		"Post(\"/api/v1/auth/verify-email\", authDeps.VerifyEmail)",
		"Post(\"/api/v1/auth/magic-link/start\", authDeps.MagicLinkStart)",
		"Post(\"/api/v1/auth/magic-link/consume\", authDeps.MagicLinkConsume)",
		"Post(\"/api/v1/auth/password-reset/start\", authDeps.PasswordResetStart)",
		"Post(\"/api/v1/auth/password-reset/confirm\", authDeps.PasswordResetConfirm)",
		"authDeps.MountCLITokenRoute(r)",
		"authDeps.MountCLIDeviceStartRoute(r",
		"authDeps.MountCLIDeviceTokenRoute(r)",
		"oauthDeps.Start)",
		"oauthDeps.Callback)",
		"Get(\"/api/v1/auth/me\", authDeps.Me)",
		"authDeps.MountViewerModeRoutes(r)",
		"Post(\"/api/v1/auth/send-verification\", authDeps.SendVerification)",
		"Post(\"/api/v1/auth/totp/enroll\", authDeps.TOTPEnroll)",
		"Post(\"/api/v1/auth/totp/verify\", authDeps.TOTPVerify)",
		"Post(\"/api/v1/auth/totp/challenge\", authDeps.TOTPChallenge)",
		"Delete(\"/api/v1/auth/totp\", authDeps.TOTPDisable)",
		"authDeps.MountSessionRoutes(r)",
		"authDeps.MountCLIAuthorizeRoute(r)",
		"authDeps.MountCLIDeviceApproveRoute(r",
		"admin_ip.MountRoutes(r,",
		"akDeps.List)",
		"akDeps.Get)",
		"akDeps.Create)",
		"akDeps.Rotate)",
		"akDeps.Delete)",
		"mcpDeps.ListExecutions)",
		"mcpDeps.StreamExecutions)",
		"mcpDeps.ExportExecutionsCSV)",
		"mcpDeps.GetStats)",
		"mcpDeps.GetTrend)",
		"mcpDeps.GetCatalog)",
		"mcpDeps.ListQuotasHandler)",
		"mcpDeps.UpsertQuotaHandler)",
		"mcpDeps.DeleteQuotaHandler)",
		"apiDocsDeps.GetSpec)",
		"scoring.MountRoutes(r,",
		"auditAdminDeps.MountAdminRoutes(r)",
		"auditAdminDeps.MountDLQRoutes(r)",
		"auditAdminDeps.MountTestRoutes(r)",
		"auditAdminDeps.MountSigningKeyRoutes(r)",
		"(&scim.Deps{Pool: pool}).MountAdminRoutes(r)",
		"scim.MountRoutes(r,",
		"adminKMS.MountRoutes(r)",
		"spamCorpusAdmin.MountRoutes(r)",
	} {
		if strings.Contains(root.all, forbidden) {
			t.Fatalf("composition root bypasses internal/server with %q", forbidden)
		}
	}

	assertMainMarkersInOrder(t, source, []string{
		"authDeps.OnLoginSuccess = authBruteforceLimiter.RecordSuccess",
		"apiserver.MountPublicAuthRoutes(apiserver.Deps{",
		"oauthCfg := auth.LoadOAuthConfig()",
	})
	assertMainMarkersInOrder(t, source, []string{
		"apiDocsSessionLimit := middleware.NewTenantRateLimitWithOptions(apidocs.SessionRateLimitPerMinute",
		"apiDocsAPIKeyLimit := middleware.NewKeyRateLimitWithOptions(",
		"return apidocs.APIKeyRateLimitPerMinute, 0, 0, nil",
		"Namespace: \"api-docs:key\"",
		"r.Use(apidocs.ProtectResponses)",
		"authenticatedRoutes.apply(r)",
		"apiDocsDeps := &apidocs.Deps{",
		"APIKeyRateLimit:  apiDocsAPIKeyLimit.Middleware,",
		"SessionRateLimit: apiDocsSessionLimit.Middleware,",
	})
	assertMainMarkersInOrder(t, source, []string{
		"oauthDeps := &auth.OAuthDeps{",
		"apiserver.MountOAuthRoutes(apiserver.Deps{Router: r, OAuth: oauthDeps})",
		"logger.Info(\"OAuth disabled:",
	})
	assertMainMarkersInOrder(t, source, []string{
		"r.Get(\"/api/v1/me\", h.Me)",
		"apiserver.MountAuthenticatedAuthMeRoute(apiserver.Deps{Router: r, Auth: authDeps})",
		"ar.Get(\"/api/v1/account/deletion\", accountDeletionDeps.Status)",
		"apiserver.MountAuthenticatedAuthRoutes(apiserver.Deps{",
		"apiserver.MountUserNotificationRoutes(",
	})
	assertMainMarkersInOrder(t, source, []string{
		"apiserver.MountUserNotificationRoutes(",
		"apiserver.MountAdminIPRoutes(apiserver.Deps{Router: r, Pool: pool})",
		"apiserver.MountSendingDiscoveryRoutes(",
	})
	assertMainMarkersInOrder(t, source, []string{
		"RateLimit: expensiveTenantLimit.Middleware",
		"akDeps := &apikeys.Deps{Repo: apiKeyResolver, Cache: apiKeyAuthCache}",
		"apiserver.MountAPIKeyRoutes(apiserver.Deps{Router: r, APIKeys: akDeps})",
		"auditOperations := &apiserver.AuditOperationsDeps{",
		"apiserver.MountAuditOperationsSurface(apiserver.Deps{",
	})
	assertMainMarkersInOrder(t, source, []string{
		"apiserver.MountAuditOperationsSurface(apiserver.Deps{",
		"mcpDeps := &apikeycalls.Deps{Repo: apiKeyCallsRepo}",
		"apiserver.MountAPIKeyCallRoutes(apiserver.Deps{Router: r, APIKeyCalls: mcpDeps})",
		"agentGovernor := agentgov.New(agentgov.Deps{",
	})
	assertMainMarkersInOrder(t, source, []string{
		"ai_agent.MountAgentRoutes(r, agentChat)",
		"apiDocsDeps := &apidocs.Deps{",
		"APIKeyRateLimit:  apiDocsAPIKeyLimit.Middleware,",
		"SessionRateLimit: apiDocsSessionLimit.Middleware,",
		"apiserver.MountAPIDocRoutes(apiserver.Deps{Router: r, APIDocs: apiDocsDeps})",
		"limitsHandlers.MountRoutes(r)",
	})
	assertMainMarkersInOrder(t, source, []string{
		"editorQueue := apiserver.MountEditorQueueRoutes(",
		"apiserver.MountReportingComplianceTools(apiserver.ReportingComplianceToolsDeps{",
		"listHealthHistoryWorker := &list_health.HistoryWorker{",
	})
	assertMainMarkersInOrder(t, source, []string{
		"apiserver.MountPrivacyComplianceRoutes(tenantGovernanceServerDeps)",
		"auditAdminDeps := apiserver.NewAuditSinkAdminDeps(pool, envCipher, envCipher, logger)",
		"apiserver.MountAuditSinkRoutes(apiserver.Deps{Router: r, AuditSinkAdmin: auditAdminDeps})",
		"apiserver.MountCommercialAdminRoutes(tenantGovernanceServerDeps)",
	})
	assertMainMarkersInOrder(t, source, []string{
		"r.Use(idempotentRoutes)",
		"blocklist.MountRoutes(r,",
		"apiserver.MountSCIMAdminRoutes(apiserver.Deps{",
		"apiserver.MountDedicatedIPRoutes(apiserver.Deps{Router: r, Pool: pool})",
	})
	assertMainMarkersInOrder(t, source, []string{
		"mountRegionRoutes(r, pool, cfg.InternalAPIToken)",
		"apiserver.MountSCIMPublicRoutes(apiserver.Deps{",
		"apiserver.MountCommercePublicRoutes(r, providerIntegrationsSurface)",
	})
	assertMainMarkersInOrder(t, source, []string{
		"adminKMS := &admin.Deps{",
		"apiserver.MountAdminKMSRoutes(apiserver.Deps{Router: r, AdminKMS: adminKMS})",
		"spamCorpusAdmin := &admin.SpamCorpusDeps{",
		"apiserver.MountSpamCorpusAdminRoutes(apiserver.Deps{Router: r, SpamCorpusAdmin: spamCorpusAdmin})",
		"sendomainLookupRepo := sending.SendDomainLookupRepo{Pool: pool}",
	})

	for _, wiring := range []string{
		"Auth:                     authDeps,",
		"AuthBruteforceMiddleware: authBruteforceLimiter.Middleware,",
		"OAuth: oauthDeps",
		"APIKeys: akDeps",
		"APIKeyCalls: mcpDeps",
		"APIDocs: apiDocsDeps",
		"AuditSinkAdmin: auditAdminDeps",
		"SCIMAdmin: &scim.Deps{Pool: pool}",
		"SCIMPublic: &scim.Deps{Pool: pool, RegionLookup: regionLookup}",
		"AdminKMS: adminKMS",
		"SpamCorpusAdmin: spamCorpusAdmin",
	} {
		if !strings.Contains(source, wiring) {
			t.Fatalf("identity/API server dependencies missing %q", wiring)
		}
	}
}
