// SPDX-License-Identifier: AGPL-3.0-only

package routeauth

import "testing"

func TestHumanEngagedReachEvidenceExportUsesReviewedReportReadPolicy(t *testing.T) {
	t.Parallel()

	policy, ok := defaultManifest.exactPolicy(
		"GET", "/api/v1/analytics/human-engaged-reach/export",
	)
	if !ok {
		t.Fatal("evidence-export policy not found")
	}
	if policy.Exposure != ExposureAuthenticated || policy.SessionMinimumRole != "viewer" {
		t.Fatalf("policy = %+v, want authenticated viewer", *policy)
	}
	if len(policy.AuthMethods) != 2 || policy.AuthMethods[0] != "session" || policy.AuthMethods[1] != "api_key" {
		t.Fatalf("auth methods = %v, want session + api_key", policy.AuthMethods)
	}
	if policy.APIKeyScopeMode != ScopeModeAny || len(policy.APIKeyScopes) != 1 || policy.APIKeyScopes[0] != "read:reports" {
		t.Fatalf("API-key policy = %v/%s, want [read:reports]/any", policy.APIKeyScopes, policy.APIKeyScopeMode)
	}
	if policy.PolicySource != "openapi.x-required-scopes" || policy.ReviewStatus != "reviewed" {
		t.Fatalf("policy provenance = %+v", *policy)
	}
}
