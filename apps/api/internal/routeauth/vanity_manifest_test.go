// SPDX-License-Identifier: AGPL-3.0-only

package routeauth

import "testing"

func TestVanityAdminRoutesUseReviewedLeastPrivilegePolicies(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		method      string
		path        string
		authMethods []string
		role        string
		scope       string
		source      string
	}{
		{
			name:   "list is campaign read",
			method: "GET", path: "/api/v1/campaigns/{campaign}/vanity-paths",
			authMethods: []string{"session", "api_key"}, role: "viewer",
			scope: "read:campaigns", source: "openapi.x-required-scopes",
		},
		{
			name:   "create is campaign authoring",
			method: "POST", path: "/api/v1/campaigns/{campaign}/vanity-paths",
			authMethods: []string{"session", "api_key"}, role: "editor",
			scope: "write:campaigns", source: "openapi.x-required-scopes",
		},
		{
			name:   "conversion report is API-key-only outcome ingest",
			method: "POST", path: "/api/v1/vanity-visits/{reference}/conversion",
			authMethods: []string{"api_key"}, role: RoleNotApplicable,
			scope: "admin", source: "openapi.x-required-auth-method+openapi.x-required-scopes",
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			policy, ok := defaultManifest.exactPolicy(test.method, test.path)
			if !ok {
				t.Fatal("policy not found")
			}
			if policy.Exposure != ExposureAuthenticated || policy.SessionMinimumRole != test.role {
				t.Fatalf("policy = %+v, want authenticated role %s", *policy, test.role)
			}
			if len(policy.AuthMethods) != len(test.authMethods) {
				t.Fatalf("auth methods = %v, want %v", policy.AuthMethods, test.authMethods)
			}
			for index := range test.authMethods {
				if policy.AuthMethods[index] != test.authMethods[index] {
					t.Fatalf("auth methods = %v, want %v", policy.AuthMethods, test.authMethods)
				}
			}
			if policy.APIKeyScopeMode != ScopeModeAny || len(policy.APIKeyScopes) != 1 || policy.APIKeyScopes[0] != test.scope {
				t.Fatalf("API-key policy = %v/%s, want [%s]/any", policy.APIKeyScopes, policy.APIKeyScopeMode, test.scope)
			}
			if policy.PolicySource != test.source || policy.ReviewStatus != "reviewed" {
				t.Fatalf("policy provenance = %+v", *policy)
			}
		})
	}
}
