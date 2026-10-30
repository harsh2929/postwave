// SPDX-License-Identifier: AGPL-3.0-only
package routeauth

import "testing"

func TestArchiveEmergencyUnpublishIsExactAdmin(t *testing.T) {
	t.Parallel()

	policy, ok := PolicyFor("POST", "/api/v1/campaigns/11111111-1111-4111-8111-111111111111/unpublish-archive")
	if !ok {
		t.Fatal("archive emergency-unpublish policy not found")
	}
	if policy.Exposure != ExposureAuthenticated || policy.SessionMinimumRole != "admin" {
		t.Fatalf("policy = %+v, want authenticated admin", policy)
	}
	if len(policy.APIKeyScopes) != 1 || policy.APIKeyScopes[0] != "admin" {
		t.Fatalf("API-key scopes = %v, want [admin]", policy.APIKeyScopes)
	}
	if policy.PolicySource != "openapi.x-required-scopes" || policy.ReviewStatus != "reviewed" {
		t.Fatalf("policy = %+v, want reviewed OpenAPI policy", policy)
	}
}
