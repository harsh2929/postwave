// SPDX-License-Identifier: AGPL-3.0-only
package routeauth

import (
	"encoding/json"
	"testing"
)

func TestGeneratedManifestRepresentativePolicies(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name       string
		method     string
		path       string
		exposure   string
		role       string
		scope      string
		authMethod string
	}{
		{name: "lists mutation", method: "POST", path: "/api/v1/lists", exposure: ExposureAuthenticated, role: "editor", scope: "write:subscribers"},
		{name: "list webhook mutation", method: "POST", path: "/api/v1/lists/list-1/webhooks", exposure: ExposureAuthenticated, role: "admin", scope: "admin"},
		{name: "tags mutation", method: "POST", path: "/api/v1/tags", exposure: ExposureAuthenticated, role: "editor", scope: "write:subscribers"},
		{name: "suppression mutation", method: "POST", path: "/api/v1/suppressions/bulk", exposure: ExposureAuthenticated, role: "editor", scope: "write:subscribers"},
		{name: "suppression file import", method: "POST", path: "/api/v1/suppressions/import", exposure: ExposureAuthenticated, role: "editor", scope: "write:subscribers"},
		{name: "suppression export", method: "GET", path: "/api/v1/suppressions/export", exposure: ExposureAuthenticated, role: "viewer", scope: "read:subscribers"},
		{name: "suppression trend", method: "GET", path: "/api/v1/suppressions/trend", exposure: ExposureAuthenticated, role: "viewer", scope: "read:subscribers"},
		{name: "suppression bulk import", method: "POST", path: "/api/v1/suppressions/bulk-import", exposure: ExposureAuthenticated, role: "admin", scope: "admin"},
		{name: "destructive suppression bulk action", method: "POST", path: "/api/v1/suppressions/bulk-delete", exposure: ExposureAuthenticated, role: "admin", scope: "admin"},
		{name: "webhook mutation", method: "POST", path: "/api/v1/webhooks", exposure: ExposureAuthenticated, role: "admin", scope: "admin"},
		{name: "inbound webhook mutation", method: "PATCH", path: "/api/v1/inbound-webhooks/wh-1", exposure: ExposureAuthenticated, role: "admin", scope: "admin"},
		{name: "inbound email rotation", method: "POST", path: "/api/v1/inbound-emails/endpoint/rotate", exposure: ExposureAuthenticated, role: "admin", scope: "admin"},
		{name: "SMS broadcast mutation", method: "POST", path: "/api/v1/sms/broadcasts", exposure: ExposureAuthenticated, role: "admin", scope: "admin"},
		{name: "SMS broadcast list is exact admin", method: "GET", path: "/api/v1/sms/broadcasts", exposure: ExposureAuthenticated, role: "admin", scope: "admin"},
		{name: "SMS broadcast detail is exact admin", method: "GET", path: "/api/v1/sms/broadcasts/11111111-1111-4111-8111-111111111111", exposure: ExposureAuthenticated, role: "admin", scope: "admin"},
		{name: "SMS broadcast progress is exact admin", method: "GET", path: "/api/v1/sms/broadcasts/11111111-1111-4111-8111-111111111111/progress", exposure: ExposureAuthenticated, role: "admin", scope: "admin"},
		{name: "SMS suppression list is exact admin", method: "GET", path: "/api/v1/sms/suppressions", exposure: ExposureAuthenticated, role: "admin", scope: "admin"},
		{name: "SMS suppression mutation is exact admin", method: "POST", path: "/api/v1/sms/suppressions", exposure: ExposureAuthenticated, role: "admin", scope: "admin"},
		{name: "SMS consent roster is exact admin", method: "GET", path: "/api/v1/sms/consent", exposure: ExposureAuthenticated, role: "admin", scope: "admin"},
		{name: "SMS consent mutation is exact admin", method: "POST", path: "/api/v1/sms/consent", exposure: ExposureAuthenticated, role: "admin", scope: "admin"},
		{name: "SMS list roster is exact admin", method: "GET", path: "/api/v1/sms/lists/11111111-1111-4111-8111-111111111111/members", exposure: ExposureAuthenticated, role: "admin", scope: "admin"},
		{name: "SMS campaign report is exact admin", method: "GET", path: "/api/v1/sms/campaigns/11111111-1111-4111-8111-111111111111/report", exposure: ExposureAuthenticated, role: "admin", scope: "admin"},
		{name: "SMS campaign report export is exact admin", method: "GET", path: "/api/v1/sms/campaigns/11111111-1111-4111-8111-111111111111/report/export", exposure: ExposureAuthenticated, role: "admin", scope: "admin"},
		{name: "SMS quick replies are exact admin", method: "GET", path: "/api/v1/sms/quick-replies", exposure: ExposureAuthenticated, role: "admin", scope: "admin"},
		{name: "SMS conversation reply is privileged", method: "POST", path: "/api/v1/sms/conversations/%2B15551234567/reply", exposure: ExposureAuthenticated, role: "admin", scope: "admin"},
		{name: "SMS conversation content is privileged", method: "GET", path: "/api/v1/sms/conversations/%2B15551234567/messages", exposure: ExposureAuthenticated, role: "admin", scope: "admin"},
		{name: "Helpdesk static catalog remains report-readable", method: "GET", path: "/api/v1/service-suite/catalog", exposure: ExposureAuthenticated, role: "viewer", scope: "read:reports"},
		{name: "Helpdesk content read is exact admin", method: "GET", path: "/api/v1/service-suite/conversations", exposure: ExposureAuthenticated, role: "admin", scope: "admin"},
		{name: "Helpdesk internal note is exact admin", method: "POST", path: "/api/v1/service-suite/conversations/11111111-1111-4111-8111-111111111111/internal-notes", exposure: ExposureAuthenticated, role: "admin", scope: "admin"},
		{name: "support integration projection is exact admin", method: "GET", path: "/api/v1/support-integrations", exposure: ExposureAuthenticated, role: "admin", scope: "admin"},
		{name: "support integration held effect remains exact admin", method: "POST", path: "/api/v1/support-integrations/11111111-1111-4111-8111-111111111111/sync", exposure: ExposureAuthenticated, role: "admin", scope: "admin"},
		{name: "SMS credit preview is read-shaped", method: "POST", path: "/api/v1/sms/credits/preview", exposure: ExposureAuthenticated, role: "viewer", scope: "read:reports"},
		{name: "SMS test send is campaign write", method: "POST", path: "/api/v1/sms/test-send", exposure: ExposureAuthenticated, role: "editor", scope: "write:campaigns"},
		{name: "Mailchimp schedule compatibility alias is campaign write", method: "POST", path: "/api/mailchimp/3.0/campaigns/campaign-1/actions/schedule", exposure: ExposureAuthenticated, role: "editor", scope: "write:campaigns"},
		{name: "Mailchimp schedule versioned alias is campaign write", method: "POST", path: "/api/v1/mailchimp/3.0/campaigns/campaign-1/actions/schedule", exposure: ExposureAuthenticated, role: "editor", scope: "write:campaigns"},
		{name: "automation recurrence trigger is admin", method: "POST", path: "/api/v1/admin/automation/recurrence/run", exposure: ExposureAuthenticated, role: "admin", scope: "admin"},
		{name: "public inbound email", method: "POST", path: "/api/public/inbound-email/demo", exposure: ExposurePublic, role: RoleNotApplicable},
		{name: "internal provider webhook", method: "POST", path: "/api/internal/webhooks/inbound/postmark", exposure: ExposureInternal, role: RoleNotApplicable},
		{name: "audit portal cookie", method: "GET", path: "/api/v1/audit/portal/branding", exposure: ExposureCredentialed, role: RoleNotApplicable, authMethod: "portal_cookie"},
		{name: "provider basic callback", method: "DELETE", path: "/api/v1/crm/pipedrive/oauth/callback", exposure: ExposureCredentialed, role: RoleNotApplicable, authMethod: "provider_basic"},
		{name: "Slack signature callback", method: "POST", path: "/api/v1/slack/interactions", exposure: ExposureCredentialed, role: RoleNotApplicable, authMethod: "provider_signature"},
		{name: "CLI PKCE exchange", method: "POST", path: "/api/v1/auth/cli/token", exposure: ExposureCredentialed, role: RoleNotApplicable, authMethod: "pkce_code_verifier"},
		{name: "CLI device grant creation", method: "POST", path: "/api/v1/auth/cli/device/start", exposure: ExposurePublic, role: RoleNotApplicable},
		{name: "CLI device token poll", method: "POST", path: "/api/v1/auth/cli/device/token", exposure: ExposureCredentialed, role: RoleNotApplicable, authMethod: "device_code"},
		{name: "mobile device is session only", method: "POST", path: "/api/v1/mobile/push/devices", exposure: ExposureAuthenticated, role: "viewer", authMethod: "session"},
		{name: "presence publish is session only", method: "POST", path: "/api/v1/events/publish", exposure: ExposureAuthenticated, role: "viewer", authMethod: "session"},
		{name: "PII finding inbox is DPO admin only", method: "GET", path: "/api/v1/pii-findings", exposure: ExposureAuthenticated, role: "admin", scope: "admin"},
		{name: "subscriber PII findings are DPO admin only", method: "GET", path: "/api/v1/subscribers/00000000-0000-4000-8000-000000000001/pii-findings", exposure: ExposureAuthenticated, role: "admin", scope: "admin"},
		{name: "PII review is DPO admin only", method: "PATCH", path: "/api/v1/pii-findings/00000000-0000-4000-8000-000000000001", exposure: ExposureAuthenticated, role: "admin", scope: "admin"},
		{name: "PII scanner config read is admin only", method: "GET", path: "/api/v1/pii-scan-config", exposure: ExposureAuthenticated, role: "admin", scope: "admin"},
		{name: "PII scanner config update is admin only", method: "POST", path: "/api/v1/pii-scan-config", exposure: ExposureAuthenticated, role: "admin", scope: "admin"},
		{name: "PII scanner repair is admin only", method: "POST", path: "/api/v1/pii-scan-operations", exposure: ExposureAuthenticated, role: "admin", scope: "admin"},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			policy, ok := PolicyFor(test.method, test.path)
			if !ok {
				t.Fatalf("policy not found")
			}
			if policy.Exposure != test.exposure || policy.SessionMinimumRole != test.role {
				t.Fatalf("policy = %+v", policy)
			}
			if test.scope != "" && (len(policy.APIKeyScopes) != 1 || policy.APIKeyScopes[0] != test.scope) {
				t.Fatalf("API-key scopes = %v, want [%s]", policy.APIKeyScopes, test.scope)
			}
			if test.authMethod != "" && (len(policy.AuthMethods) != 1 || policy.AuthMethods[0] != test.authMethod) {
				t.Fatalf("auth methods = %v, want [%s]", policy.AuthMethods, test.authMethod)
			}
		})
	}
}

func TestGeneratedManifestSupportProviderIngressIsReleaseHeld(t *testing.T) {
	t.Parallel()

	for _, path := range []string{
		"/api/public/support-integrations/{provider}/ingest/{token}",
		"/api/public/support-integrations/zendesk/{subdomain}/webhooks",
	} {
		policy, ok := PolicyFor("POST", path)
		if !ok {
			t.Fatalf("policy not found for %s", path)
		}
		if policy.Exposure != ExposureReleaseHeld || policy.ReleaseHoldCode != "support_provider_ingress_held" {
			t.Fatalf("%s policy = %+v, want support provider ingress release hold", path, policy)
		}
		if len(policy.AuthMethods) != 1 || policy.AuthMethods[0] != "pre_auth_release_hold" {
			t.Fatalf("%s auth methods = %v, want pre-auth release hold", path, policy.AuthMethods)
		}
		if policy.PolicySource != "openapi.x-postwave-release-hold" || policy.ReviewStatus != "release_held" {
			t.Fatalf("%s policy = %+v, want reviewed OpenAPI release hold", path, policy)
		}
	}
}

func TestGeneratedManifestGatewaySupportCatchAllIsReleaseHeld(t *testing.T) {
	t.Parallel()

	tests := []struct {
		method string
		path   string
	}{
		{method: "GET", path: "/api/public/support-integrations"},
		{method: "DELETE", path: "/api/public/support-integrations/provider/anything"},
	}
	for _, test := range tests {
		policy, ok := PolicyFor(test.method, test.path)
		if !ok {
			t.Fatalf("policy not found for %s %s", test.method, test.path)
		}
		if policy.Exposure != ExposureReleaseHeld || policy.ReleaseHoldCode != "support_provider_ingress_held" {
			t.Fatalf("%s %s policy = %+v, want support-provider release hold", test.method, test.path, policy)
		}
		if len(policy.AuthMethods) != 1 || policy.AuthMethods[0] != "pre_auth_release_hold" {
			t.Fatalf("%s %s auth methods = %v", test.method, test.path, policy.AuthMethods)
		}
	}
}

func TestGeneratedManifestLegalHoldsAreSessionAdminOnly(t *testing.T) {
	t.Parallel()

	tests := []struct {
		method string
		path   string
	}{
		{method: "GET", path: "/api/v1/assurance/legal-holds"},
		{method: "POST", path: "/api/v1/assurance/legal-holds"},
		{method: "POST", path: "/api/v1/assurance/legal-holds/11111111-1111-4111-8111-111111111111/release"},
	}
	for _, test := range tests {
		policy, ok := PolicyFor(test.method, test.path)
		if !ok {
			t.Fatalf("policy not found for %s %s", test.method, test.path)
		}
		if policy.Exposure != ExposureAuthenticated || policy.SessionMinimumRole != "admin" {
			t.Fatalf("%s %s policy = %+v, want session admin", test.method, test.path, policy)
		}
		if len(policy.AuthMethods) != 1 || policy.AuthMethods[0] != "session" {
			t.Fatalf("%s %s auth methods = %v, want [session]", test.method, test.path, policy.AuthMethods)
		}
		if len(policy.APIKeyScopes) != 0 || policy.APIKeyScopeMode != ScopeModeNotApplicable {
			t.Fatalf("%s %s API-key policy = %v/%q, want denied", test.method, test.path, policy.APIKeyScopes, policy.APIKeyScopeMode)
		}
	}
}

func TestGeneratedManifestWebVitalsOverridesInternalPrefixExactly(t *testing.T) {
	t.Parallel()

	for _, method := range []string{"POST", "OPTIONS"} {
		policy, ok := PolicyFor(method, "/api/internal/web-vitals")
		if !ok {
			t.Fatalf("policy not found for %s", method)
		}
		if policy.Exposure != ExposurePublic || policy.PolicySource != "route-contract:browser-telemetry" {
			t.Fatalf("%s policy = %+v, want exact anonymous browser telemetry", method, policy)
		}
		if len(policy.AuthMethods) != 1 || policy.AuthMethods[0] != "anonymous_or_route_credential" {
			t.Fatalf("%s auth methods = %v", method, policy.AuthMethods)
		}
	}

	internal, ok := PolicyFor("POST", "/api/internal/listmonk/events")
	if !ok || internal.Exposure != ExposureInternal || internal.PolicySource != "route-prefix:internal" {
		t.Fatalf("unrelated internal route = %+v, want internal-prefix policy", internal)
	}
}

func TestGeneratedManifestPublicStatusUsesDedicatedClassification(t *testing.T) {
	t.Parallel()

	for _, method := range []string{"GET", "HEAD", "OPTIONS"} {
		policy, ok := PolicyFor(method, "/api/public/status")
		if !ok {
			t.Fatalf("policy not found for %s", method)
		}
		if policy.Exposure != ExposurePublic || policy.PolicySource != "route-contract:public-status" {
			t.Fatalf("%s policy = %+v, want dedicated public-status classification", method, policy)
		}
	}
}

func TestGeneratedManifestConjunctiveScopePolicies(t *testing.T) {
	t.Parallel()
	wantCampaignSendScopes := []string{"write:campaigns", "send:transactional"}
	tests := []struct {
		method string
		path   string
		scopes []string
	}{
		{method: "POST", path: "/api/v1/campaigns/test-send", scopes: wantCampaignSendScopes},
		{method: "POST", path: "/api/v1/campaigns/{id}/test-send", scopes: wantCampaignSendScopes},
		{method: "POST", path: "/api/v1/campaigns/{id}/queue", scopes: wantCampaignSendScopes},
		{method: "POST", path: "/api/v1/campaigns/{id}/send", scopes: wantCampaignSendScopes},
		{method: "POST", path: "/api/v1/campaigns/{id}/recurrence", scopes: wantCampaignSendScopes},
		{method: "POST", path: "/api/v1/campaigns/{id}/resend-to-non-openers", scopes: wantCampaignSendScopes},
		{method: "POST", path: "/api/v1/campaigns/{id}/resend-unopened", scopes: wantCampaignSendScopes},
		{method: "POST", path: "/api/v1/campaigns/{id}/resume", scopes: wantCampaignSendScopes},
		{method: "POST", path: "/api/v1/campaigns/{id}/schedule-by-best-time", scopes: wantCampaignSendScopes},
		{method: "POST", path: "/api/v1/campaigns/{id}/tz-schedule", scopes: wantCampaignSendScopes},
		{method: "POST", path: "/api/v1/safety/check", scopes: wantCampaignSendScopes},
		{method: "PUT", path: "/api/v1/audit/retention", scopes: []string{"audit:read", "audit:configure_retention"}},
	}
	for _, test := range tests {
		test := test
		t.Run(test.method+" "+test.path, func(t *testing.T) {
			t.Parallel()
			policy, ok := PolicyFor(test.method, test.path)
			if !ok {
				t.Fatal("policy not found")
			}
			if policy.APIKeyScopeMode != ScopeModeAll {
				t.Fatalf("scope mode = %q, want %q", policy.APIKeyScopeMode, ScopeModeAll)
			}
			if policy.SessionMinimumRole != "admin" {
				t.Fatalf("session role = %q, want admin", policy.SessionMinimumRole)
			}
			if len(policy.APIKeyScopes) != len(test.scopes) {
				t.Fatalf("scopes = %v, want %v", policy.APIKeyScopes, test.scopes)
			}
			for index := range test.scopes {
				if policy.APIKeyScopes[index] != test.scopes[index] {
					t.Fatalf("scopes = %v, want %v", policy.APIKeyScopes, test.scopes)
				}
			}
		})
	}
}

func TestGeneratedManifestSendTimeOptimizationUsesReportScope(t *testing.T) {
	t.Parallel()
	for _, path := range []string{"/api/v1/send-time-opt", "/api/v1/send-time-opt/heatmap"} {
		policy, ok := PolicyFor("GET", path)
		if !ok {
			t.Fatalf("policy not found for %s", path)
		}
		if policy.APIKeyScopeMode != ScopeModeAny || len(policy.APIKeyScopes) != 1 || policy.APIKeyScopes[0] != "read:reports" {
			t.Fatalf("%s policy = %+v, want read:reports any", path, policy)
		}
	}
}

func TestGeneratedManifestAIRegressionUsesReviewedLeastPrivilegePolicies(t *testing.T) {
	t.Parallel()
	tests := []struct {
		method string
		path   string
		role   string
		scope  string
	}{
		{method: "GET", path: "/api/v1/ai-regression/golden-examples", role: "viewer", scope: "read:reports"},
		{method: "GET", path: "/api/v1/ai-regression/runs", role: "viewer", scope: "read:reports"},
		{method: "GET", path: "/api/v1/ai-regression/runs/latest", role: "viewer", scope: "read:reports"},
		{method: "GET", path: "/api/v1/ai-regression/runs/00000000-0000-4000-8000-000000000001", role: "viewer", scope: "read:reports"},
		{method: "GET", path: "/api/v1/ai-regression/runs/00000000-0000-4000-8000-000000000001/results", role: "viewer", scope: "read:reports"},
		{method: "POST", path: "/api/v1/ai-regression/golden-examples", role: "admin", scope: "admin"},
		{method: "DELETE", path: "/api/v1/ai-regression/golden-examples/00000000-0000-4000-8000-000000000001", role: "admin", scope: "admin"},
		{method: "POST", path: "/api/v1/ai-regression/runs", role: "admin", scope: "admin"},
		{method: "GET", path: "/api/v1/ai-regression/settings", role: "admin", scope: "admin"},
		{method: "PUT", path: "/api/v1/ai-regression/settings", role: "admin", scope: "admin"},
	}
	for _, test := range tests {
		test := test
		t.Run(test.method+" "+test.path, func(t *testing.T) {
			t.Parallel()
			policy, ok := PolicyFor(test.method, test.path)
			if !ok {
				t.Fatal("policy not found")
			}
			if policy.Exposure != ExposureAuthenticated || policy.SessionMinimumRole != test.role {
				t.Fatalf("policy = %+v, want authenticated role %s", policy, test.role)
			}
			if policy.APIKeyScopeMode != ScopeModeAny || len(policy.APIKeyScopes) != 1 || policy.APIKeyScopes[0] != test.scope {
				t.Fatalf("policy = %+v, want scope %s with any mode", policy, test.scope)
			}
			if policy.PolicySource != "openapi.x-required-scopes" || policy.ReviewStatus != "reviewed" {
				t.Fatalf("policy = %+v, want reviewed OpenAPI policy", policy)
			}
		})
	}
}

// The billing read family is mounted as one cohort behind
// apikeys.RequireScope(apikeys.ScopeReadReports) in
// internal/server/tenant_governance.go. plan-summary drifted to an admin
// floor because it alone lacked an x-required-scopes declaration and fell
// through to the admin family fallback, so the central manifest — the
// stricter of the two gates — denied the viewers the mount site admitted.
// Pin the whole cohort together so a future omission cannot silently
// re-split it.
func TestGeneratedManifestBillingReadFamilyIsViewerReportScope(t *testing.T) {
	t.Parallel()
	for _, path := range []string{
		"/api/v1/billing/state",
		"/api/v1/billing/usage",
		"/api/v1/billing/invoices",
		"/api/v1/billing/plan-summary",
	} {
		path := path
		t.Run(path, func(t *testing.T) {
			t.Parallel()
			policy, ok := PolicyFor("GET", path)
			if !ok {
				t.Fatalf("policy not found for %s", path)
			}
			if policy.SessionMinimumRole != "viewer" {
				t.Fatalf("%s session role = %q, want viewer", path, policy.SessionMinimumRole)
			}
			if policy.APIKeyScopeMode != ScopeModeAny ||
				len(policy.APIKeyScopes) != 1 ||
				policy.APIKeyScopes[0] != "read:reports" {
				t.Fatalf("%s policy = %+v, want read:reports any", path, policy)
			}
		})
	}
}

// The billing mutations stay admin. Loosening the read family must not drag
// checkout, portal, or the overage preference down with it.
func TestGeneratedManifestBillingMutationsStayAdmin(t *testing.T) {
	t.Parallel()
	tests := []struct {
		method string
		path   string
	}{
		{method: "POST", path: "/api/v1/billing/checkout"},
		{method: "POST", path: "/api/v1/billing/portal"},
		{method: "PUT", path: "/api/v1/billing/overage"},
	}
	for _, test := range tests {
		test := test
		t.Run(test.method+" "+test.path, func(t *testing.T) {
			t.Parallel()
			policy, ok := PolicyFor(test.method, test.path)
			if !ok {
				t.Fatalf("policy not found")
			}
			if policy.SessionMinimumRole != "admin" {
				t.Fatalf("session role = %q, want admin", policy.SessionMinimumRole)
			}
			if len(policy.APIKeyScopes) != 1 || policy.APIKeyScopes[0] != "admin" {
				t.Fatalf("scopes = %v, want [admin]", policy.APIKeyScopes)
			}
		})
	}
}

func TestGeneratedManifestCampaignTemplatePoliciesMatchMountedScopes(t *testing.T) {
	t.Parallel()
	tests := []struct {
		method string
		path   string
		role   string
		scope  string
	}{
		{method: "GET", path: "/api/v1/campaign-templates", role: "viewer", scope: "read:campaigns"},
		{method: "GET", path: "/api/v1/campaign-templates/search", role: "viewer", scope: "read:campaigns"},
		{method: "GET", path: "/api/v1/campaign-templates/stats", role: "viewer", scope: "read:campaigns"},
		{method: "GET", path: "/api/v1/campaign-templates/goals", role: "viewer", scope: "read:campaigns"},
		{method: "GET", path: "/api/v1/campaign-templates/template-1", role: "viewer", scope: "read:campaigns"},
		{method: "GET", path: "/api/v1/campaign-templates/template-1/regions", role: "viewer", scope: "read:campaigns"},
		{method: "POST", path: "/api/v1/campaign-templates", role: "editor", scope: "write:campaigns"},
		{method: "POST", path: "/api/v1/campaign-templates/generate", role: "editor", scope: "write:campaigns"},
		{method: "POST", path: "/api/v1/campaign-templates/from-generated-design", role: "editor", scope: "write:campaigns"},
		{method: "POST", path: "/api/v1/campaign-templates/import", role: "editor", scope: "write:campaigns"},
		{method: "PATCH", path: "/api/v1/campaign-templates/template-1", role: "editor", scope: "write:campaigns"},
		{method: "DELETE", path: "/api/v1/campaign-templates/template-1", role: "editor", scope: "write:campaigns"},
		{method: "POST", path: "/api/v1/campaign-templates/template-1/clone", role: "editor", scope: "write:campaigns"},
		{method: "POST", path: "/api/v1/campaign-templates/template-1/adapt", role: "editor", scope: "write:campaigns"},
		{method: "POST", path: "/api/v1/campaign-templates/template-1/create-campaign", role: "editor", scope: "write:campaigns"},
		{method: "POST", path: "/api/v1/campaign-templates/template-1/use", role: "editor", scope: "write:campaigns"},
		{method: "POST", path: "/api/v1/campaign-templates/template-1/favorite", role: "viewer", scope: "read:campaigns"},
		{method: "POST", path: "/api/v1/campaign-templates/template-1/unfavorite", role: "viewer", scope: "read:campaigns"},
		{method: "GET", path: "/api/v1/analytics/template-leaderboard", role: "viewer", scope: "read:reports"},
	}
	for _, test := range tests {
		test := test
		t.Run(test.method+" "+test.path, func(t *testing.T) {
			t.Parallel()
			policy, ok := PolicyFor(test.method, test.path)
			if !ok {
				t.Fatal("policy not found")
			}
			if policy.Exposure != ExposureAuthenticated || policy.SessionMinimumRole != test.role {
				t.Fatalf("policy = %+v, want authenticated role %s", policy, test.role)
			}
			if policy.APIKeyScopeMode != ScopeModeAny || len(policy.APIKeyScopes) != 1 || policy.APIKeyScopes[0] != test.scope {
				t.Fatalf("policy scopes = %v/%s, want [%s]/any", policy.APIKeyScopes, policy.APIKeyScopeMode, test.scope)
			}
		})
	}
}

func TestGeneratedManifestAssetPoliciesMatchMountedScopes(t *testing.T) {
	t.Parallel()
	tests := []struct {
		method string
		path   string
		role   string
		scope  string
	}{
		{method: "GET", path: "/api/v1/assets", role: "viewer", scope: "read:campaigns"},
		{method: "GET", path: "/api/v1/assets/00000000-0000-4000-8000-000000000001", role: "viewer", scope: "read:campaigns"},
		{method: "GET", path: "/api/v1/assets/00000000-0000-4000-8000-000000000001/usage", role: "viewer", scope: "read:campaigns"},
		{method: "GET", path: "/api/v1/assets/00000000-0000-4000-8000-000000000001/blob", role: "viewer", scope: "read:campaigns"},
		{method: "GET", path: "/api/v1/assets/folders", role: "viewer", scope: "read:campaigns"},
		{method: "GET", path: "/api/v1/assets/tags", role: "viewer", scope: "read:campaigns"},
		{method: "GET", path: "/api/v1/assets/00000000-0000-4000-8000-000000000001/tags", role: "viewer", scope: "read:campaigns"},
		{method: "POST", path: "/api/v1/assets", role: "editor", scope: "write:campaigns"},
		{method: "PATCH", path: "/api/v1/assets/00000000-0000-4000-8000-000000000001", role: "editor", scope: "write:campaigns"},
		{method: "DELETE", path: "/api/v1/assets/00000000-0000-4000-8000-000000000001", role: "editor", scope: "write:campaigns"},
		{method: "POST", path: "/api/v1/assets/bulk-delete", role: "editor", scope: "write:campaigns"},
		{method: "POST", path: "/api/v1/assets/folders", role: "editor", scope: "write:campaigns"},
		{method: "PATCH", path: "/api/v1/assets/folders/00000000-0000-4000-8000-000000000001", role: "editor", scope: "write:campaigns"},
		{method: "DELETE", path: "/api/v1/assets/folders/00000000-0000-4000-8000-000000000001", role: "editor", scope: "write:campaigns"},
		{method: "PATCH", path: "/api/v1/assets/00000000-0000-4000-8000-000000000001/folder", role: "editor", scope: "write:campaigns"},
		{method: "POST", path: "/api/v1/assets/00000000-0000-4000-8000-000000000001/tags", role: "editor", scope: "write:campaigns"},
		{method: "DELETE", path: "/api/v1/assets/00000000-0000-4000-8000-000000000001/tags/newsletter", role: "editor", scope: "write:campaigns"},
	}
	for _, test := range tests {
		test := test
		t.Run(test.method+" "+test.path, func(t *testing.T) {
			t.Parallel()
			policy, ok := PolicyFor(test.method, test.path)
			if !ok {
				t.Fatal("policy not found")
			}
			if policy.Exposure != ExposureAuthenticated || policy.SessionMinimumRole != test.role {
				t.Fatalf("policy = %+v, want authenticated role %s", policy, test.role)
			}
			if policy.APIKeyScopeMode != ScopeModeAny || len(policy.APIKeyScopes) != 1 || policy.APIKeyScopes[0] != test.scope {
				t.Fatalf("policy scopes = %v/%s, want [%s]/any", policy.APIKeyScopes, policy.APIKeyScopeMode, test.scope)
			}
			if policy.ReviewStatus != "reviewed" {
				t.Fatalf("policy remains unreviewed: %+v", policy)
			}
		})
	}
}

func TestGeneratedManifestDoesNotExposeUnmountedTemplateThumbnailProxies(t *testing.T) {
	t.Parallel()
	for _, path := range []string{
		"/api/v1/campaign-templates/template-1/thumbnail.png",
		"/api/v1/templates/template-1/thumbnail.png",
	} {
		if policy, ok := PolicyFor("GET", path); ok {
			t.Fatalf("unmounted template thumbnail proxy %s unexpectedly has a reachable policy: %+v", path, policy)
		}
	}
}

func TestMatcherSupportsEmbeddedParametersAndAnyFallback(t *testing.T) {
	t.Parallel()
	public, ok := PolicyFor("GET", "/api/public/podcast/acme/feed/secret-token.xml")
	if !ok || public.Exposure != ExposurePublic {
		t.Fatalf("embedded-parameter policy = %+v, found=%v", public, ok)
	}
	proxy, ok := PolicyFor("PATCH", "/api/v1/automations/future-proxy-operation")
	if !ok || proxy.Method != "ANY" || proxy.SessionMinimumRole != "admin" {
		t.Fatalf("ANY proxy policy = %+v, found=%v", proxy, ok)
	}
}

func TestParseManifestRejectsIncompleteAuthenticatedPolicy(t *testing.T) {
	t.Parallel()
	raw, err := json.Marshal(manifestDocument{SchemaVersion: 1, Routes: []Policy{{
		Method:             "POST",
		Path:               "/api/v1/example",
		Exposure:           ExposureAuthenticated,
		AuthMethods:        []string{"api_key"},
		SessionMinimumRole: RoleNotApplicable,
		APIKeyScopeMode:    ScopeModeAny,
		PolicySource:       "test",
		ReviewStatus:       "test",
	}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ParseManifest(raw); err == nil {
		t.Fatal("ParseManifest accepted an any-scope API-key policy with no scope")
	}
}

func TestParseManifestRejectsReleaseHoldWithoutStableCode(t *testing.T) {
	t.Parallel()
	raw, err := json.Marshal(manifestDocument{SchemaVersion: 1, Routes: []Policy{{
		Method:             "POST",
		Path:               "/api/v1/held",
		Exposure:           ExposureReleaseHeld,
		AuthMethods:        []string{"pre_auth_release_hold"},
		SessionMinimumRole: RoleNotApplicable,
		APIKeyScopeMode:    ScopeModeNotApplicable,
		PolicySource:       "test",
		ReviewStatus:       "release_held",
	}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ParseManifest(raw); err == nil {
		t.Fatal("ParseManifest accepted a release hold without a stable code")
	}
}

func TestParseManifestRejectsAllScopeModeWithFewerThanTwoScopes(t *testing.T) {
	t.Parallel()
	raw, err := json.Marshal(manifestDocument{SchemaVersion: 1, Routes: []Policy{{
		Method:             "POST",
		Path:               "/api/v1/example",
		Exposure:           ExposureAuthenticated,
		AuthMethods:        []string{"api_key"},
		SessionMinimumRole: RoleNotApplicable,
		APIKeyScopes:       []string{"write:campaigns"},
		APIKeyScopeMode:    ScopeModeAll,
		PolicySource:       "test",
		ReviewStatus:       "test",
	}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ParseManifest(raw); err == nil {
		t.Fatal("ParseManifest accepted all-scope mode with fewer than two scopes")
	}
}

func TestPolicyReadersDoNotExposeMutableManifestSlices(t *testing.T) {
	t.Parallel()

	policy, ok := PolicyFor("GET", "/api/v1/lists")
	if !ok || len(policy.AuthMethods) == 0 || len(policy.APIKeyScopes) == 0 {
		t.Fatalf("list policy = %+v, found=%v", policy, ok)
	}
	policy.AuthMethods[0] = "mutated"
	policy.APIKeyScopes[0] = "mutated"

	policies := Policies()
	for index := range policies {
		if policies[index].Method == "GET" && policies[index].Path == "/api/v1/lists" {
			policies[index].AuthMethods[0] = "mutated-again"
			policies[index].APIKeyScopes[0] = "mutated-again"
			break
		}
	}

	unchanged, ok := PolicyFor("GET", "/api/v1/lists")
	if !ok {
		t.Fatal("list policy disappeared")
	}
	if unchanged.AuthMethods[0] != "session" || unchanged.APIKeyScopes[0] != "read:subscribers" {
		t.Fatalf("exported policy mutation changed live manifest: %+v", unchanged)
	}
}
