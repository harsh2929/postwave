// SPDX-License-Identifier: AGPL-3.0-only

package routeauth

import "testing"

func TestEmailHealthRoutesUseExplicitSubscriberAuthority(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		method string
		path   string
		role   string
		scope  string
		source string
	}{
		{method: "GET", path: "/api/v1/verification/health", role: "viewer", scope: "read:subscribers", source: "openapi.x-required-scopes"},
		{method: "POST", path: "/api/v1/verification/health/batch", role: "viewer", scope: "read:subscribers", source: "openapi.x-required-scopes"},
		{method: "POST", path: "/api/v1/verification/verify", role: "editor", scope: "write:subscribers", source: "route-contract.api_key_scope_mode+openapi.x-required-scopes"},
		{method: "POST", path: "/api/v1/verification/verify-batch", role: "editor", scope: "write:subscribers", source: "route-contract.api_key_scope_mode+openapi.x-required-scopes"},
		{method: "GET", path: "/api/v1/verification/jobs/{id}/results", role: "viewer", scope: "read:subscribers", source: "route-contract.api_key_scope_mode+openapi.x-required-scopes"},
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
			if policy.APIKeyScopeMode != ScopeModeAny || len(policy.APIKeyScopes) != 1 ||
				policy.APIKeyScopes[0] != test.scope {
				t.Fatalf("policy = %+v, want %s any", policy, test.scope)
			}
			if len(policy.AuthMethods) != 2 || policy.AuthMethods[0] != "session" || policy.AuthMethods[1] != "api_key" {
				t.Fatalf("auth methods = %v, want session + api_key", policy.AuthMethods)
			}
			if policy.PolicySource != test.source || policy.ReviewStatus != "reviewed" {
				t.Fatalf("policy provenance = %+v", policy)
			}
		})
	}
}
