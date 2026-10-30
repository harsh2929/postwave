// SPDX-License-Identifier: AGPL-3.0-only

package routeauth

import "testing"

func TestVerificationControlPlaneRoutesUseExplicitAuthority(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		method, path, role, scope string
	}{
		{method: "GET", path: "/api/v1/verification/jobs", role: "viewer", scope: "read:subscribers"},
		{method: "GET", path: "/api/v1/verification/jobs/{id}", role: "viewer", scope: "read:subscribers"},
		{method: "POST", path: "/api/v1/verification/jobs/{id}/cancel", role: "editor", scope: "write:subscribers"},
		{method: "GET", path: "/api/v1/verification/providers", role: "admin", scope: "admin"},
		{method: "PUT", path: "/api/v1/verification/providers/{provider}", role: "admin", scope: "admin"},
		{method: "DELETE", path: "/api/v1/verification/providers/{provider}", role: "admin", scope: "admin"},
		{method: "GET", path: "/api/v1/verification/policy", role: "admin", scope: "admin"},
		{method: "PUT", path: "/api/v1/verification/policy", role: "admin", scope: "admin"},
		{method: "GET", path: "/api/v1/verification/credits", role: "viewer", scope: "read:subscribers"},
		{method: "GET", path: "/api/v1/verification/cache", role: "viewer", scope: "read:subscribers"},
		{method: "DELETE", path: "/api/v1/verification/cache", role: "editor", scope: "write:subscribers"},
	} {
		test := test
		t.Run(test.method+" "+test.path, func(t *testing.T) {
			t.Parallel()
			policy, ok := PolicyFor(test.method, test.path)
			if !ok {
				t.Fatal("policy not found")
			}
			if policy.Exposure != ExposureAuthenticated || policy.SessionMinimumRole != test.role {
				t.Fatalf("policy = %+v, want authenticated %s", policy, test.role)
			}
			if policy.APIKeyScopeMode != ScopeModeAny || len(policy.APIKeyScopes) != 1 || policy.APIKeyScopes[0] != test.scope {
				t.Fatalf("policy = %+v, want %s any", policy, test.scope)
			}
			if len(policy.AuthMethods) != 2 || policy.AuthMethods[0] != "session" || policy.AuthMethods[1] != "api_key" {
				t.Fatalf("auth methods = %v, want session + api_key", policy.AuthMethods)
			}
			if policy.ReviewStatus != "reviewed" {
				t.Fatalf("policy provenance = %+v", policy)
			}
		})
	}
}
